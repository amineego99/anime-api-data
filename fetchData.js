const fs = require('fs');
const path = require('path');

const ANILIST_API_URL = 'https://graphql.anilist.co';
const AOD_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const IMGBB_API_KEY = 'b319ae56c851eecbb26149310233535b';

const DB_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// مسارات الملفات
const ALL_ANIME_FILE = path.join(DB_DIR, 'database.json');
const ONGOING_FILE = path.join(DB_DIR, 'seasonal.json');
const UPCOMING_FILE = path.join(DB_DIR, 'upcoming.json');
const SCHEDULE_FILE = path.join(DB_DIR, 'schedule.json');
const SYNC_FILE = path.join(DB_DIR, 'sync.json');

// المحافظة على الدفعة 25 عنصراً فقط لتخفيف الضغط على السيرفر ولإعطاء وقت للرفع
const PER_PAGE = 25; 

const query = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: [UPDATED_AT_DESC]) {
      id idMal updatedAt
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

async function fetchAnilistAnimePage(page, retries = 3) {
    try {
        const response = await fetch(ANILIST_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { page, perPage: PER_PAGE } })
        });
        const json = await response.json();
        
        // التقاط رسائل الحظر الصريحة من AniList
        if (response.status === 429) throw new Error('Rate Limit'); 
        if (json.errors) throw new Error(json.errors[0].message);
        
        return json.data.Page.media;
    } catch (error) {
        if (retries > 0) {
            console.warn(`⏳ حظر مؤقت أو ضغط من AniList في الصفحة ${page}. ننتظر 60 ثانية للتعافي...`);
            await delay(60000); 
            return fetchAnilistAnimePage(page, retries - 1);
        }
        return [];
    }
}

// 🌟 استخراج الصور المؤقتة ومعرفات MAL و Kitsu من AOD 🌟
async function buildAodMapper() {
    console.log("🚀 جاري جلب AOD لاستخراج المعرفات والصور المؤقتة...");
    try {
        const res = await fetch(AOD_URL, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const text = await res.text();
        const aodData = JSON.parse(text.trim());
        const mapper = {};
        
        aodData.data.forEach(anime => {
            let aniId = null, malId = null, kitsuId = null; 
            anime.sources.forEach(s => {
                if (s.includes('anilist.co/anime/')) aniId = parseInt(s.split('/').pop());
                if (s.includes('myanimelist.net/anime/')) malId = parseInt(s.split('/').pop());
                if (s.includes('kitsu.app/anime/')) kitsuId = parseInt(s.split('/').pop()); 
            });
            if (aniId) {
                mapper[aniId] = { mal_id: malId, kitsu_id: kitsuId, picture: anime.picture }; 
            }
        });
        console.log(`✅ تم بناء خريطة AOD بنجاح.`);
        return mapper;
    } catch (e) {
        console.error("⚠️ فشل جلب AOD:", e.message);
        return {};
    }
}

// 🌟 دالة الرفع لـ ImgBB (متروكة كما طلبت كإجراء احتياطي) 🌟
async function uploadToImgBB(imageUrl) {
    if (!imageUrl) return '';
    try {
        const formData = new FormData();
        formData.append('image', imageUrl); 
        
        const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (data.success) {
            return data.data.url;
        } else {
            console.error(`❌ فشل الرفع لـ ImgBB للصورة ${imageUrl}:`, data.error?.message);
            if (data.error && data.error.message && data.error.message.includes('Rate limit')) {
                return 'RATE_LIMIT_REACHED';
            }
            return imageUrl; 
        }
    } catch (error) {
        console.error(`❌ خطأ في الاتصال بـ ImgBB للصورة ${imageUrl}:`, error.message);
        return imageUrl;
    }
}

// 🌟 تطبيق روابط Kitsu أو الاحتفاظ بـ MAL للأنميات الجديدة 🌟
async function formatAnimeData(anime, aodMap, existingAnime) {
    const aodInfo = aodMap[anime.id] || {};
    
    let kitsuId = aodInfo.kitsu_id || (existingAnime ? existingAnime.kitsu_id : null);
    let anilistCover = anime.coverImage?.extraLarge || anime.coverImage?.large || '';
    let anilistBanner = anime.bannerImage || '';
    
    let defaultMalPicture = aodInfo.picture || anilistCover;

    // تحديد الروابط: Kitsu إن وجد، وإلا MAL/AniList
    let finalLargeImage = (existingAnime && existingAnime.coverImage?.large?.includes('ibb.co')) 
        ? existingAnime.coverImage.large 
        : (kitsuId ? `https://media.kitsu.app/anime/poster_images/${kitsuId}/large.jpg` : defaultMalPicture);

    let finalMediumImage = (existingAnime && existingAnime.coverImage?.medium?.includes('ibb.co')) 
        ? existingAnime.coverImage.medium 
        : (kitsuId ? `https://media.kitsu.app/anime/poster_images/${kitsuId}/medium.jpg` : defaultMalPicture);

    let finalBannerImage = (existingAnime && existingAnime.bannerImage?.includes('ibb.co')) 
        ? existingAnime.bannerImage 
        : (kitsuId ? `https://media.kitsu.app/anime/cover_images/${kitsuId}/large.jpg` : anilistBanner);

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
        tags: (anime.tags || []).filter(t => !t.isAdult).map(t => t.name).slice(0, 15),
        studios: anime.studios || { nodes: [] },
        trailer: anime.trailer?.site === 'youtube' ? { youtube_id: anime.trailer.id, url: `https://youtu.be/${anime.trailer.id}` } : null,
        updatedAt: anime.updatedAt || 0,
        nextAiringEpisode: anime.nextAiringEpisode || null
    };
}

async function main() {
    console.log('🌟 جاري تشغيل السكربت...');

    const aodMap = await buildAodMapper();
    
    let allAnime = loadJSON(ALL_ANIME_FILE);
    let animeMap = new Map(allAnime.map((a, i) => [a.id, i]));

    const IS_INCOMPLETE = allAnime.length < 10000; 
    const CURRENT_TOTAL_PAGES = IS_INCOMPLETE ? 600 : 10; 
    
    if (IS_INCOMPLETE) {
        console.log(`⚠️ قاعدة البيانات غير مكتملة (${allAnime.length} أنمي فقط). سيتم تفعيل الوضع الشامل...`);
    } else {
        console.log(`✅ قاعدة البيانات مكتملة (${allAnime.length} أنمي). سيتم تفعيل التحديث السريع (10 صفحات فقط)...`);
    }
    
    console.log('🛠️ جاري التحضير الأساسي للقاعدة...');
    for (let anime of allAnime) {
        let aodInfo = aodMap[anime.id];
        
        if (!anime.kitsu_id && aodInfo && aodInfo.kitsu_id) {
            anime.kitsu_id = aodInfo.kitsu_id;
        }

        if (anime.coverImage && anime.coverImage.large && !anime.coverImage.large.includes('ibb.co')) {
            if (!anime._originalCover) anime._originalCover = anime.coverImage.large;
            if (aodInfo && aodInfo.picture && !anime.kitsu_id) {
                anime.coverImage.large = aodInfo.picture;
                anime.coverImage.medium = aodInfo.picture;
            }
        }
        if (anime.bannerImage && !anime.bannerImage.includes('ibb.co')) {
            if (!anime._originalBanner) anime._originalBanner = anime.bannerImage;
        }
    }

    let syncData = loadJSON(SYNC_FILE);
    let lastSyncTime = syncData.last_updated_at || 0;
    let newHighestSyncTime = lastSyncTime;

    let stopFetching = false;
    let updatesThisSession = 0;

    // ─── المرحلة 1: مراجعة الصور وتطبيق روابط Kitsu أولاً قبل الجلب الجديد ───────────
    console.log('🖼️ المرحلة 1: مراجعة الصور الموجودة وتطبيق روابط Kitsu للروابط التي ليست imgbb أولاً...');
    for (let i = 0; i < allAnime.length; i++) {
        let anime = allAnime[i];
        let isUpdated = false;

        let needsCoverCheck = anime.coverImage && anime.coverImage.large && !anime.coverImage.large.includes('ibb.co');

        if (needsCoverCheck) {
            if (anime.kitsu_id) {
                const targetKitsuLarge = `https://media.kitsu.app/anime/poster_images/${anime.kitsu_id}/large.jpg`;
                const targetKitsuMedium = `https://media.kitsu.app/anime/poster_images/${anime.kitsu_id}/medium.jpg`;
                
                if (anime.coverImage.large !== targetKitsuLarge) {
                    anime.coverImage.large = targetKitsuLarge;
                    anime.coverImage.medium = targetKitsuMedium;
                    isUpdated = true;
                }
            } else {
                // إذا لم يوجد Kitsu، نتركه برابط MAL أو AniList الأصلي
                const targetMal = anime._originalCover || anime.coverImage.large;
                if (anime.coverImage.large !== targetMal) {
                    anime.coverImage.large = targetMal;
                    anime.coverImage.medium = targetMal;
                    isUpdated = true;
                }
            }
        }

        let needsBannerCheck = anime.bannerImage && !anime.bannerImage.includes('ibb.co') && anime.bannerImage !== anime.coverImage.large;

        if (needsBannerCheck) {
            if (anime.kitsu_id) {
                const targetKitsuBanner = `https://media.kitsu.app/anime/cover_images/${anime.kitsu_id}/large.jpg`;
                if (anime.bannerImage !== targetKitsuBanner) {
                    anime.bannerImage = targetKitsuBanner;
                    isUpdated = true;
                }
            } else {
                const targetMalBanner = anime._originalBanner || anime.bannerImage;
                if (anime.bannerImage !== targetMalBanner) {
                    anime.bannerImage = targetMalBanner;
                    isUpdated = true;
                }
            }
        }

        if (isUpdated) {
            updatesThisSession++;
        }
    }
    
    // حفظ التحديثات الخاصة بالصور قبل الانتقال للخطوة التالية
    if (updatesThisSession > 0) {
        console.log(`✅ تم تحديث ${updatesThisSession} رابط صورة في قاعدة البيانات الحالية. جاري الحفظ...`);
        saveJSON(ALL_ANIME_FILE, allAnime);
    } else {
        console.log('✅ جميع الصور في القاعدة الحالية محدثة بالفعل.');
    }

    // ─── المرحلة 2: تحديث البيانات الجديدة من AniList ──────────────────────────
    console.log('🔄 المرحلة 2: جلب الأنميات والتحديثات الجديدة...');
    for (let page = 1; page <= CURRENT_TOTAL_PAGES; page++) {
        if (stopFetching) break;
        console.log(`جلب الصفحة ${page} من AniList...`);
        
        const animes = await fetchAnilistAnimePage(page);
        
        if (animes.length === 0) {
            console.log(`انتهت الأنميات المتاحة في AniList عند الصفحة ${page}.`);
            break;
        }

        for (const anime of animes) {
            if (anime.updatedAt > newHighestSyncTime) newHighestSyncTime = anime.updatedAt;

            if (!IS_INCOMPLETE && anime.updatedAt <= lastSyncTime) {
                console.log(`🛑 تم الوصول لبيانات محدثة مسبقاً (ID: ${anime.id}). إيقاف الجلب!`);
                stopFetching = true;
                break;
            }

            const existingAnime = animeMap.has(anime.id) ? allAnime[animeMap.get(anime.id)] : null;
            // أثناء معالجة الأنمي الجديد، الدالة formatAnimeData ستقوم تلقائياً بتطبيق روابط Kitsu
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

    // ─── المرحلة 3: الترتيب والحفظ النهائي ────────────────────────────────────
    console.log('💾 المرحلة 3: ترتيب وحفظ البيانات المجمعة...');
    allAnime.sort((a, b) => b.popularity - a.popularity);

    saveJSON(ALL_ANIME_FILE, allAnime);
    saveJSON(SYNC_FILE, { last_updated_at: newHighestSyncTime });
    
    saveJSON(ONGOING_FILE, allAnime.filter(a => a.status === 'RELEASING'));
    saveJSON(UPCOMING_FILE, allAnime.filter(a => a.status === 'NOT_YET_RELEASED'));
    
    const schedule = allAnime
        .filter(a => a.nextAiringEpisode)
        .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt);
    saveJSON(SCHEDULE_FILE, schedule);

    console.log(`🚀 تم التحديث بنجاح! السكربت أنهى جميع عملياته.`);
}

main();
