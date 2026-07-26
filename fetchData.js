const fs = require('fs');
const path = require('path');

// 🌟 إجبار السيرفر على طباعة السجلات لحظة بلحظة
const originalLog = console.log;
console.log = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    process.stderr.write(msg + '\n');
};

const ANILIST_API_URL = 'https://graphql.anilist.co';
const AOD_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const IMGBB_API_KEY = 'b319ae56c851eecbb26149310233535b';

const ENABLE_IMAGE_PROCESSING = false; 

const DB_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const ALL_ANIME_FILE = path.join(DB_DIR, 'database.json');
const ONGOING_FILE = path.join(DB_DIR, 'seasonal.json');
const UPCOMING_FILE = path.join(DB_DIR, 'upcoming.json');
const SCHEDULE_FILE = path.join(DB_DIR, 'schedule.json');
const SYNC_FILE = path.join(DB_DIR, 'sync.json');

const PER_PAGE = 25; 

const query = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: [UPDATED_AT_DESC]) {
      id idMal updatedAt isAdult
      title { english romaji native }
      description(asHtml: false)
      coverImage { extraLarge large medium }
      bannerImage
      seasonYear season format episodes duration status averageScore popularity
      genres tags { name isAdult }
      studios(isMain: true) { nodes { id name } }
      nextAiringEpisode { airingAt timeUntilAiring episode }
      trailer { id site }
    }
  }
}
`;

const SCHEDULE_QUERY = `
query {
  Page(page: 1, perPage: 50) {
    airingSchedules(notYetAired: false, sort: TIME_DESC) {
      episode
      airingAt
      media { id }
    }
  }
}
`;

function loadJSON(filePath) {
    if (fs.existsSync(filePath)) {
        try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } 
        catch (e) { return []; }
    }
    return [];
}

function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    console.log(`✅ تم حفظ ${data.length || Object.keys(data).length} عنصر في ${path.basename(filePath)}`);
}

async function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function isImageValid(url) {
    if (!url) return false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        return res.ok || res.status === 304; 
    } catch (e) {
        return false;
    }
}

async function fetchAnilistAnimePage(page, retries = 3) {
    try {
        const response = await fetch(ANILIST_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { page, perPage: PER_PAGE } })
        });
        const json = await response.json();
        
        if (response.status === 429) throw new Error('Rate Limit'); 
        if (json.errors) throw new Error(json.errors[0].message);
        
        return json.data.Page.media;
    } catch (error) {
        if (retries > 0) {
            console.warn(`⏳ حظر مؤقت من AniList في الصفحة ${page}. ننتظر 60 ثانية للتعافي...`);
            await delay(60000); 
            return fetchAnilistAnimePage(page, retries - 1);
        }
        return [];
    }
}

async function fetchLiveSchedule(retries = 3) {
    try {
        const response = await fetch(ANILIST_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: SCHEDULE_QUERY })
        });
        const json = await response.json();
        return json.data.Page.airingSchedules || [];
    } catch (error) {
        if (retries > 0) {
            await delay(5000);
            return fetchLiveSchedule(retries - 1);
        }
        return [];
    }
}

async function buildAodMapper() {
    console.log("🚀 جاري جلب AOD لاستخراج المعرفات وصور (MAL)...");
    try {
        const res = await fetch(AOD_URL, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const text = await res.text();
        const aodData = JSON.parse(text.trim());
        
        const mapper = { byAni: {}, byMal: {} };
        
        aodData.data.forEach(anime => {
            let aniId = null, malId = null, kitsuId = null; 
            anime.sources.forEach(s => {
                if (s.includes('anilist.co/anime/')) aniId = parseInt(s.split('/').pop());
                if (s.includes('myanimelist.net/anime/')) malId = parseInt(s.split('/').pop());
                if (s.includes('kitsu.app/anime/')) kitsuId = parseInt(s.split('/').pop()); 
            });
            if (aniId) mapper.byAni[aniId] = { mal_id: malId, kitsu_id: kitsuId, picture: anime.picture }; 
            if (malId) mapper.byMal[malId] = { ani_id: aniId, kitsu_id: kitsuId, picture: anime.picture }; 
        });
        console.log(`✅ تم بناء خريطة AOD بنجاح.`);
        return mapper;
    } catch (e) {
        console.error("⚠️ فشل جلب AOD:", e.message);
        return { byAni: {}, byMal: {} };
    }
}

async function formatAnimeData(anime, aodMap, existingAnime) {
    const aodInfo = aodMap.byAni[anime.id] || aodMap.byMal[anime.idMal] || {};
    
    let kitsuId = aodInfo.kitsu_id || (existingAnime ? existingAnime.kitsu_id : null);
    let anilistCover = anime.coverImage?.extraLarge || anime.coverImage?.large || '';
    let anilistBanner = anime.bannerImage || '';
    
    let defaultMalPicture = aodInfo.picture || anilistCover;

    let finalLargeImage = defaultMalPicture;
    let finalMediumImage = defaultMalPicture;
    let finalBannerImage = (anime.isAdult && anilistBanner) ? (aodInfo.picture || '') : anilistBanner;

    if (existingAnime) {
        if (existingAnime.coverImage?.large?.includes('ibb.co') || existingAnime.coverImage?.large?.includes('kitsu.app') || existingAnime.coverImage?.large?.includes('myanimelist.net')) {
            finalLargeImage = existingAnime.coverImage.large;
            finalMediumImage = existingAnime.coverImage.medium || finalLargeImage;
        }
        if (existingAnime.bannerImage?.includes('ibb.co') || existingAnime.bannerImage?.includes('kitsu.app') || existingAnime.bannerImage?.includes('myanimelist.net')) {
            finalBannerImage = existingAnime.bannerImage;
        }
    }

    if (ENABLE_IMAGE_PROCESSING) {
        if (!finalLargeImage.includes('ibb.co') && kitsuId) {
            const targetKitsu = `https://media.kitsu.app/anime/poster_images/${kitsuId}/large.jpg`;
            const isValid = await isImageValid(targetKitsu); 
            if (isValid) {
                finalLargeImage = targetKitsu;
                finalMediumImage = `https://media.kitsu.app/anime/poster_images/${kitsuId}/medium.jpg`;
            }
        }
        if (!finalBannerImage.includes('ibb.co') && kitsuId) {
            const targetKitsuBanner = `https://media.kitsu.app/anime/cover_images/${kitsuId}/large.jpg`;
            const isValidBanner = await isImageValid(targetKitsuBanner); 
            if (isValidBanner) {
                finalBannerImage = targetKitsuBanner;
            }
        }
    }

    let origCover = (existingAnime && existingAnime._originalCover) ? existingAnime._originalCover : anilistCover;
    let origBanner = (existingAnime && existingAnime._originalBanner) ? existingAnime._originalBanner : anilistBanner;

    return {
        id: anime.id,
        mal_id: anime.idMal || aodInfo.mal_id || (existingAnime ? existingAnime.mal_id : null),
        kitsu_id: kitsuId, 
        title: {
            romaji: anime.title.romaji || '',
            english: anime.title.english || anime.title.romaji || '',
            native: anime.title.native || ''
        },
        description: anime.description || 'الوصف غير متوفر.',
        coverImage: {
            large: finalLargeImage,
            medium: finalMediumImage 
        },
        bannerImage: finalBannerImage,
        _originalCover: origCover,
        _originalBanner: origBanner,
        season: anime.season || null,
        seasonYear: anime.seasonYear || null,
        format: anime.format || 'UNKNOWN',
        episodes: anime.episodes || null,
        duration: anime.duration ? `${anime.duration} دقيقة` : null,
        status: anime.status || 'UNKNOWN',
        averageScore: anime.averageScore || null,
        popularity: anime.popularity || 0,
        genres: anime.genres || [],
        tags: (anime.tags || []).map(t => t.name).slice(0, 15),
        studios: anime.studios || { nodes: [] },
        trailer: anime.trailer?.site === 'youtube' ? { youtube_id: anime.trailer.id, url: `https://youtu.be/${anime.trailer.id}` } : null,
        updatedAt: anime.updatedAt || 0,
        nextAiringEpisode: anime.nextAiringEpisode || null,
        isAdult: anime.isAdult || false
    };
}

async function main() {
    console.log('🌟 جاري تشغيل السكربت...');

    const aodMap = await buildAodMapper();
    
    let allAnime = loadJSON(ALL_ANIME_FILE);
    let animeMap = new Map(allAnime.map((a, i) => [a.id, i]));

    const CURRENT_TOTAL_PAGES = 1500; 
    const IS_INCOMPLETE = allAnime.length < 12000;
    
    if (IS_INCOMPLETE) {
        console.log(`⚠️ قاعدة البيانات غير مكتملة (${allAnime.length} أنمي). سيتم جلب جميع الصفحات...`);
    } else {
        console.log(`✅ قاعدة البيانات تبدو مكتملة (${allAnime.length} أنمي). سيتم تطبيق التحديث السريع...`);
    }

    let syncData = loadJSON(SYNC_FILE);
    let lastSyncTime = syncData.last_updated_at || 0;
    let newHighestSyncTime = lastSyncTime;
    let stopFetching = false;
    
    console.log('🔄 أولاً: جلب التحديثات والأنميات الجديدة...');
    for (let page = 1; page <= CURRENT_TOTAL_PAGES; page++) {
        if (stopFetching) break;
        console.log(`جلب الصفحة ${page}...`);
        
        const animes = await fetchAnilistAnimePage(page);
        
        if (animes.length === 0) break;

        for (const anime of animes) {
            if (anime.updatedAt > newHighestSyncTime) newHighestSyncTime = anime.updatedAt;

            if (!IS_INCOMPLETE && anime.updatedAt <= lastSyncTime) {
                console.log(`🛑 تم الوصول لبيانات محدثة مسبقاً. إيقاف الجلب عند الصفحة ${page}!`);
                stopFetching = true;
                break;
            }

            const existingAnime = animeMap.has(anime.id) ? allAnime[animeMap.get(anime.id)] : null;
            const formatted = await formatAnimeData(anime, aodMap, existingAnime);
            
            if (animeMap.has(formatted.id)) {
                allAnime[animeMap.get(formatted.id)] = formatted;
            } else {
                allAnime.push(formatted);
                animeMap.set(formatted.id, allAnime.length - 1);
            }
        }
        if (page < CURRENT_TOTAL_PAGES && !stopFetching) await delay(1500);
    }

    // ══════════════════════════════════════════════════════════════
    // 🌟 ثانياً: الفحص العميق والتخلص الإجباري من أي رابط عالق بـ AniList (The Sweeper)
    // ══════════════════════════════════════════════════════════════
    console.log('🔍 ثانياً: مسح قاعدة البيانات واستبدال روابط AniList المعطوبة بصور MyAnimeList...');
    let anilistFixCount = 0;
    
    for (let i = 0; i < allAnime.length; i++) {
        let anime = allAnime[i];
        
        // اكتشاف إذا كان الغلاف لا يزال يحمل رابط anilist
        if (anime.coverImage && anime.coverImage.large && anime.coverImage.large.includes('anilist.co')) {
            let fixed = false;
            
            // 1. المحاولة عبر MyAnimeList مباشرة (بواسطة Jikan API)
            if (anime.mal_id) {
                try {
                    const jikanRes = await fetch(`https://api.jikan.moe/v4/anime/${anime.mal_id}`);
                    if (jikanRes.status === 200) {
                        const jikanData = await jikanRes.json();
                        const malImage = jikanData.data?.images?.jpg?.large_image_url;
                        if (malImage) {
                            anime.coverImage.large = malImage;
                            anime.coverImage.medium = malImage;
                            fixed = true;
                            anilistFixCount++;
                            console.log(`تم استبدال صورة ${anime.title.romaji || anime.id} بـ MAL`);
                        }
                    }
                } catch (e) {}
                await delay(1100); // ⏱️ تأخير 1.1 ثانية لحماية حسابك من الحظر (مهم جداً)
            }
            
            // 2. إذا فشل MAL (أو لم يوجد)، نعوضه إجبارياً برابط Kitsu 
            if (!fixed && anime.kitsu_id) {
                anime.coverImage.large = `https://media.kitsu.app/anime/poster_images/${anime.kitsu_id}/large.jpg`;
                anime.coverImage.medium = `https://media.kitsu.app/anime/poster_images/${anime.kitsu_id}/medium.jpg`;
                fixed = true;
                anilistFixCount++;
                console.log(`تم استبدال صورة ${anime.title.romaji || anime.id} بـ Kitsu`);
            }
        }

        // استبدال البانر المعطوب بالغلاف مباشرة
        if (anime.bannerImage && anime.bannerImage.includes('anilist.co')) {
            anime.bannerImage = anime.coverImage.large; 
        }
    }

    if (anilistFixCount > 0) {
        console.log(`✅ تم تنظيف وإصلاح ${anilistFixCount} رابط معطوب بنجاح.`);
        saveJSON(ALL_ANIME_FILE, allAnime); // حفظ سريع لضمان عدم ضياع الجهد
    } else {
        console.log('✅ قاعدة البيانات نظيفة تماماً ولا تحتوي على صور معطوبة من AniList.');
    }

    // ══════════════════════════════════════════════════════════════
    
    console.log('⚡ ثالثاً: جاري بناء السجل التراكمي المباشر...');
    let existingSchedule = loadJSON(SCHEDULE_FILE);
    if (!Array.isArray(existingSchedule)) existingSchedule = [];

    const liveEpisodes = await fetchLiveSchedule();
    const newEpisodes = [];

    liveEpisodes.forEach(liveItem => {
        const animeData = allAnime.find(a => a.id === liveItem.media.id);
        
        if (animeData) {
            const releasedEpisode = liveItem.episode;
            const airedTime = liveItem.airingAt;

            const isAlreadyInSchedule = existingSchedule.some(item => 
                item.id === animeData.id && item.episode === releasedEpisode
            );

            if (!isAlreadyInSchedule) {
                newEpisodes.push({
                    ...animeData,
                    episode: releasedEpisode,
                    lastAiredAt: airedTime
                });
            }
        }
    });

    let updatedSchedule = [...newEpisodes, ...existingSchedule];
    updatedSchedule.sort((a, b) => b.lastAiredAt - a.lastAiredAt);
    updatedSchedule = updatedSchedule.slice(0, 200); 
        
    saveJSON(SCHEDULE_FILE, updatedSchedule);
    saveJSON(SYNC_FILE, { last_updated_at: newHighestSyncTime });
    
    console.log(`✅ تمت إضافة ${newEpisodes.length} حلقات جديدة للسجل التراكمي.`);

    console.log('💾 رابعاً: ترتيب وحفظ البيانات النهائية في جميع الملفات...');
    allAnime.sort((a, b) => b.popularity - a.popularity);

    saveJSON(ALL_ANIME_FILE, allAnime);
    saveJSON(ONGOING_FILE, allAnime.filter(a => a.status === 'RELEASING'));
    saveJSON(UPCOMING_FILE, allAnime.filter(a => a.status === 'NOT_YET_RELEASED'));

    console.log(`🚀 تمت عملية التحديث بنجاح تام وبأمان مطلق!`);
}

main();
