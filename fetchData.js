const fs = require('fs');
const path = require('path');

const ANILIST_API_URL = 'https://graphql.anilist.co';
const AOD_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
const IMGBB_API_KEY = '4d5e9c032af82adb668dc2882b100798';

const ENABLE_IMAGE_VALIDATION = true; 

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

async function isImageValid(url) {
    if (!ENABLE_IMAGE_VALIDATION) return true; 
    if (!url) return false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000); 
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.body && res.body.cancel) await res.body.cancel();
        return res.ok || res.status === 304; 
    } catch (e) {
        return false;
    }
}

async function checkImageStrict(url) {
    if (!url) return { valid: false, status: 0 };
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); 
        const res = await fetch(url, { 
            method: 'GET', 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
            },
            signal: controller.signal 
        });
        clearTimeout(timeoutId);
        const isValid = res.ok || res.status === 304;
        if (res.body && res.body.cancel) await res.body.cancel();
        return { valid: isValid, status: res.status };
    } catch (e) {
        return { valid: false, status: 'TIMEOUT_OR_ERROR' };
    }
}

// 🌟 دالة جديدة: جلب الروابط الرسمية المضمونة من Kitsu API بدلاً من تخمينها
async function fetchKitsuImages(kitsuId) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
            headers: { 'Accept': 'application/vnd.api+json' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;
        const json = await res.json();
        const attrs = json.data.attributes;
        return {
            cover: attrs.posterImage ? (attrs.posterImage.large || attrs.posterImage.original) : null,
            coverMedium: attrs.posterImage ? (attrs.posterImage.medium || attrs.posterImage.large) : null,
            banner: attrs.coverImage ? (attrs.coverImage.large || attrs.coverImage.original) : null
        };
    } catch (e) {
        return null;
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
            console.warn(`⏳ حظر مؤقت أو ضغط من AniList في الصفحة ${page}. ننتظر 60 ثانية للتعافي...`);
            await delay(60000); 
            return fetchAnilistAnimePage(page, retries - 1);
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
        const mapper = {};
        
        aodData.data.forEach(anime => {
            let aniId = null, malId = null, kitsuId = null; 
            anime.sources.forEach(s => {
                if (s.includes('anilist.co/anime/')) aniId = parseInt(s.split('/').pop());
                if (s.includes('myanimelist.net/anime/')) malId = parseInt(s.split('/').pop());
                if (s.includes('kitsu.app/anime/') || s.includes('kitsu.io/anime/')) {
                    let k = parseInt(s.split('/').pop());
                    if (!isNaN(k)) kitsuId = k;
                }
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

async function formatAnimeData(anime, aodMap, existingAnime) {
    const aodInfo = aodMap[anime.id] || {};
    
    let kitsuId = aodInfo.kitsu_id || (existingAnime ? existingAnime.kitsu_id : null);
    let anilistCover = anime.coverImage?.extraLarge || anime.coverImage?.large || '';
    let anilistBanner = anime.bannerImage || '';
    
    let defaultMalPicture = aodInfo.picture || anilistCover;

    let finalLargeImage = defaultMalPicture;
    let finalMediumImage = defaultMalPicture;
    let finalBannerImage = anilistBanner;

    if (existingAnime && existingAnime.coverImage?.large?.includes('ibb.co')) {
        finalLargeImage = existingAnime.coverImage.large;
        finalMediumImage = existingAnime.coverImage.medium;
    } else if (kitsuId) {
        const targetKitsu = `https://media.kitsu.app/anime/poster_images/${kitsuId}/large.jpg`;
        const isValid = await isImageValid(targetKitsu); 
        if (isValid) {
            finalLargeImage = targetKitsu;
            finalMediumImage = `https://media.kitsu.app/anime/poster_images/${kitsuId}/medium.jpg`;
        } else {
            finalLargeImage = defaultMalPicture;
            finalMediumImage = defaultMalPicture;
        }
    }

    if (existingAnime && existingAnime.bannerImage?.includes('ibb.co')) {
        finalBannerImage = existingAnime.bannerImage;
    } else if (kitsuId) {
        const targetKitsuBanner = `https://media.kitsu.app/anime/cover_images/${kitsuId}/large.jpg`;
        const isValidBanner = await isImageValid(targetKitsuBanner); 
        if (isValidBanner) {
            finalBannerImage = targetKitsuBanner;
        } else {
            finalBannerImage = anilistBanner;
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

    // ══════════════════════════════════════════════════════════════
    // 🟠 صفر: مراجعة ذكية عبر Kitsu API (تتجاهل Kitsu/ImgBB وتعدل الباقي)
    // ══════════════════════════════════════════════════════════════
    console.log('🔍 صفر: فحص الروابط (AniList/MAL) وتحديثها باستخدام Kitsu API...');
    let initialUpdates = 0;
    let failedUpdates = 0;

    for (let i = 0; i < allAnime.length; i++) {
        let anime = allAnime[i];
        let isUpdated = false;
        
        if (aodMap[anime.id] && aodMap[anime.id].kitsu_id) {
            anime.kitsu_id = aodMap[anime.id].kitsu_id;
        }
        let kitsuId = anime.kitsu_id;
        let animeName = anime.title.romaji || anime.id;
        let needsKitsuFetch = false;

        // هل الغلاف يحتاج تحديث؟
        if (anime.coverImage && anime.coverImage.large) {
            let coverUrl = anime.coverImage.large;
            if (!coverUrl.includes('ibb.co') && !coverUrl.includes('kitsu.app') && !coverUrl.includes('kitsu.io')) {
                needsKitsuFetch = true;
            }
        }
        // هل البانر يحتاج تحديث؟
        if (anime.bannerImage) {
            let bannerUrl = anime.bannerImage;
            if (!bannerUrl.includes('ibb.co') && !bannerUrl.includes('kitsu.app') && !bannerUrl.includes('kitsu.io')) {
                needsKitsuFetch = true;
            }
        }

        // إذا كان هناك حاجة للتحديث ويوجد Kitsu ID، نسأل الـ API مباشرة
        if (needsKitsuFetch && kitsuId) {
            console.log(`🔄 [جلب من Kitsu API] ${animeName} (ID: ${kitsuId})...`);
            let kitsuData = await fetchKitsuImages(kitsuId);
            
            if (kitsuData) {
                // تحديث الغلاف إذا لزم الأمر
                let coverUrl = anime.coverImage?.large || '';
                if (!coverUrl.includes('ibb.co') && !coverUrl.includes('kitsu.app') && !coverUrl.includes('kitsu.io')) {
                    if (kitsuData.cover) {
                        anime.coverImage.large = kitsuData.cover;
                        anime.coverImage.medium = kitsuData.coverMedium || kitsuData.cover;
                        isUpdated = true;
                        console.log(`  ✅ تم تحديث الغلاف للرابط الرسمي.`);
                    } else {
                        failedUpdates++;
                        console.log(`  ❌ Kitsu لا يملك غلافاً لهذا الأنمي.`);
                    }
                }

                // تحديث البانر إذا لزم الأمر
                let bannerUrl = anime.bannerImage || '';
                if (bannerUrl && !bannerUrl.includes('ibb.co') && !bannerUrl.includes('kitsu.app') && !bannerUrl.includes('kitsu.io')) {
                    if (kitsuData.banner) {
                        anime.bannerImage = kitsuData.banner;
                        isUpdated = true;
                        console.log(`  ✅ تم تحديث البانر للرابط الرسمي.`);
                    } else {
                        failedUpdates++;
                        console.log(`  ❌ Kitsu لا يملك بانر (Cover) لهذا الأنمي.`);
                    }
                }
            } else {
                failedUpdates++;
                console.log(`❌ [فشل الاتصال] الأنمي غير موجود في Kitsu API.`);
            }
            // 🌟 تأخير 600 ملي ثانية لعدم التسبب بحظر من Kitsu API
            await delay(600); 
        }

        if (isUpdated) initialUpdates++;
    }

    console.log(`\n📊 [إحصائيات الفحص الأولي الذكي]`);
    console.log(`- الأنميات التي تم تحويلها بنجاح إلى Kitsu: ${initialUpdates}`);
    console.log(`- الأنميات التي تم الإبقاء على روابطها القديمة (لعدم توفرها في Kitsu): ${failedUpdates}`);

    if (initialUpdates > 0) {
        console.log(`جاري حفظ البيانات المبدئية...`);
        saveJSON(ALL_ANIME_FILE, allAnime);
    } else {
        console.log('الفحص الأولي مكتمل: جميع الروابط الحالية صالحة أو لا تملك بديلاً في Kitsu.');
    }

    const IS_INCOMPLETE = allAnime.length < 10000; 
    const CURRENT_TOTAL_PAGES = IS_INCOMPLETE ? 600 : 10; 
    
    if (IS_INCOMPLETE) {
        console.log(`⚠️ قاعدة البيانات غير مكتملة (${allAnime.length} أنمي). الوضع الشامل مُفعل...`);
    } else {
        console.log(`✅ قاعدة البيانات مكتملة (${allAnime.length} أنمي). التحديث السريع مُفعل...`);
    }

    let syncData = loadJSON(SYNC_FILE);
    let lastSyncTime = syncData.last_updated_at || 0;
    let newHighestSyncTime = lastSyncTime;
    let stopFetching = false;
    
    // ══════════════════════════════════════════════════════════════
    // 🟠 أولاً: جلب التحديثات والأنميات الجديدة من AniList
    // ══════════════════════════════════════════════════════════════
    console.log('🔄 أولاً: جلب التحديثات والأنميات الجديدة من AniList...');
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

   // 🌟 🌟 🌟 بناء سجل الحلقات التراكمي (Timeline) 🌟 🌟 🌟
    console.log('⚡ جاري بناء سجل الحلقات التراكمي...');
    
    // 1. جلب السجل القديم من الملف (إن وجد)
    let existingSchedule = loadJSON(SCHEDULE_FILE);
    if (!Array.isArray(existingSchedule)) existingSchedule = [];

    // 2. تجميع الحلقات الجديدة التي صدرت للتو
    const newEpisodes = [];
    allAnime.filter(a => a.status === 'RELEASING' && a.nextAiringEpisode).forEach(a => {
        // استنتاج رقم الحلقة
        const releasedEpisode = a.nextAiringEpisode.episode > 1 
            ? a.nextAiringEpisode.episode - 1 
            : 1;
        
        // استنتاج وقت الصدور
        const lastEpisodeTime = a.nextAiringEpisode.airingAt - 604800;

        // التحقق مما إذا كانت هذه الحلقة المحددة (لنفس الأنمي) موجودة بالفعل في السجل القديم
        const isAlreadyInSchedule = existingSchedule.some(item => 
            item.id === a.id && item.episode === releasedEpisode
        );

        // إذا لم تكن موجودة، نضيفها كبطاقة جديدة
        if (!isAlreadyInSchedule) {
            newEpisodes.push({
                ...a,
                episode: releasedEpisode,
                lastAiredAt: lastEpisodeTime
            });
        }
    });

    // 3. دمج الحلقات الجديدة في بداية السجل القديم
    let updatedSchedule = [...newEpisodes, ...existingSchedule];

    // 4. ترتيب السجل بالكامل من الأحدث إلى الأقدم بناءً على وقت الصدور
    updatedSchedule.sort((a, b) => b.lastAiredAt - a.lastAiredAt);

    // 5. الاحتفاظ بآخر 200 حلقة فقط (لمنع تضخم الملف)
    updatedSchedule = updatedSchedule.slice(0, 200);
        
    saveJSON(SCHEDULE_FILE, updatedSchedule);
    saveJSON(SYNC_FILE, { last_updated_at: newHighestSyncTime });
    saveJSON(ALL_ANIME_FILE, allAnime); 
    
    console.log(`✅ تم التحديث! تمت إضافة ${newEpisodes.length} حلقات جديدة للسجل التراكمي.`);
    // 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟 🌟

    // ══════════════════════════════════════════════════════════════
    // 🟠 ثانياً: مراجعة الـ Database وتعديل الصور المعطوبة
    // ══════════════════════════════════════════════════════════════
    console.log('🔍 ثانياً: فحص وإصلاح الصور في قاعدة البيانات الحالية...');
    let prepUpdates = 0;
    
    for (let i = 0; i < allAnime.length; i++) {
        let anime = allAnime[i];
        let aodInfo = aodMap[anime.id];
        
        if (i > 0 && i % 500 === 0) console.log(`⏳ تم فحص ${i} أنمي...`);
        
        if (!anime.kitsu_id && aodInfo && aodInfo.kitsu_id) {
            anime.kitsu_id = aodInfo.kitsu_id;
        }

        if (anime.coverImage && anime.coverImage.large && !anime.coverImage.large.includes('ibb.co')) {
            if (!anime._originalCover) anime._originalCover = anime.coverImage.large; 
            
            let targetKitsu = anime.kitsu_id ? `https://media.kitsu.app/anime/poster_images/${anime.kitsu_id}/large.jpg` : null;
            let isValidKitsu = false;

            if (targetKitsu) isValidKitsu = await isImageValid(targetKitsu);

            if (isValidKitsu) {
                if (anime.coverImage.large !== targetKitsu) {
                    anime.coverImage.large = targetKitsu;
                    anime.coverImage.medium = `https://media.kitsu.app/anime/poster_images/${anime.kitsu_id}/medium.jpg`;
                    prepUpdates++;
                }
            } else {
                let fallbackImage = (aodInfo && aodInfo.picture) ? aodInfo.picture : anime._originalCover;
                if (anime.coverImage.large !== fallbackImage) {
                    anime.coverImage.large = fallbackImage;
                    anime.coverImage.medium = fallbackImage;
                    prepUpdates++;
                }
            }
        }
        
        if (anime.bannerImage && !anime.bannerImage.includes('ibb.co')) {
            if (!anime._originalBanner) anime._originalBanner = anime.bannerImage;
            
            let targetKitsuBanner = anime.kitsu_id ? `https://media.kitsu.app/anime/cover_images/${anime.kitsu_id}/large.jpg` : null;
            let isValidKitsuBanner = false;

            if (targetKitsuBanner) isValidKitsuBanner = await isImageValid(targetKitsuBanner);

            if (isValidKitsuBanner) {
                if (anime.bannerImage !== targetKitsuBanner) {
                    anime.bannerImage = targetKitsuBanner;
                    prepUpdates++;
                }
            } else {
                let fallbackBanner = anime._originalBanner;
                if (anime.bannerImage !== fallbackBanner) {
                    anime.bannerImage = fallbackBanner;
                    prepUpdates++;
                }
            }
        }
    }
    
    if (prepUpdates > 0) {
        console.log(`✅ تم إيجاد وإصلاح ${prepUpdates} رابط صورة معطوب. جاري الحفظ...`);
        saveJSON(ALL_ANIME_FILE, allAnime);
    } else {
        console.log('✅ جميع الصور في القاعدة الحالية تم فحصها وتعمل بنجاح.');
    }


    // ══════════════════════════════════════════════════════════════
    // 🟠 ثالثاً: تحديث الصور برفع النسخ الأصلية إلى ImgBB
    // ══════════════════════════════════════════════════════════════
    console.log('☁️ ثالثاً: تحديث الصور برفع النسخ الأصلية (عالية الجودة) إلى حساب ImgBB...');
    let uploadsThisSession = 0;
    
    for (let i = 0; i < allAnime.length; i++) {
        let anime = allAnime[i];
        
        const isHentai = anime.genres && anime.genres.some(g => g.toLowerCase() === 'hentai');
        if (!isHentai) continue;

        let isUpdated = false;

        let freshDB = loadJSON(ALL_ANIME_FILE);
        let animeInDB = freshDB.find(a => a.id === anime.id);

        let needsCoverUpload = anime.coverImage.large && !anime.coverImage.large.includes('ibb.co');
        
        if (needsCoverUpload && animeInDB && animeInDB.coverImage?.large?.includes('ibb.co')) {
            anime.coverImage.large = animeInDB.coverImage.large;
            anime.coverImage.medium = animeInDB.coverImage.medium || animeInDB.coverImage.large;
            needsCoverUpload = false; 
        }

        if (needsCoverUpload) {
            console.log(`رفع غلاف: ${anime.title.romaji}`);
            const targetCover = anime._originalCover || anime.coverImage.large; 
            const newCover = await uploadToImgBB(targetCover);
            
            if (newCover === 'RATE_LIMIT_REACHED') {
                console.log('⚠️ تم الوصول للحد الأقصى لرفع ImgBB. سيتم إيقاف الرفع مؤقتاً.');
                break; 
            }

            if (newCover && newCover !== targetCover && newCover.includes('ibb.co')) {
                anime.coverImage.large = newCover;
                anime.coverImage.medium = newCover;
                isUpdated = true;
                uploadsThisSession++;
            }
            await delay(1500); 
        }

        let needsBannerUpload = anime.bannerImage && !anime.bannerImage.includes('ibb.co') && anime.bannerImage !== anime.coverImage.large;

        if (needsBannerUpload && animeInDB && animeInDB.bannerImage?.includes('ibb.co')) {
            anime.bannerImage = animeInDB.bannerImage;
            needsBannerUpload = false;
        }

        if (needsBannerUpload) {
            console.log(`رفع بانر: ${anime.title.romaji}`);
            const targetBanner = anime._originalBanner || anime.bannerImage;
            const newBanner = await uploadToImgBB(targetBanner);
            
            if (newBanner === 'RATE_LIMIT_REACHED') {
                console.log('⚠️ تم الوصول للحد الأقصى لرفع ImgBB. سيتم إيقاف الرفع مؤقتاً.');
                break; 
            }

            if (newBanner && newBanner !== targetBanner && newBanner.includes('ibb.co')) {
                anime.bannerImage = newBanner;
                isUpdated = true;
                uploadsThisSession++;
            }
            await delay(1500);
        }

        if (isUpdated && uploadsThisSession % 10 === 0) saveJSON(ALL_ANIME_FILE, allAnime);
    }


    // ══════════════════════════════════════════════════════════════
    // 🟠 رابعاً: الترتيب والحفظ النهائي لباقي الملفات
    // ══════════════════════════════════════════════════════════════
    console.log('💾 رابعاً: ترتيب وحفظ البيانات النهائية في جميع الملفات...');
    allAnime.sort((a, b) => b.popularity - a.popularity);

    saveJSON(ALL_ANIME_FILE, allAnime);
    saveJSON(ONGOING_FILE, allAnime.filter(a => a.status === 'RELEASING'));
    saveJSON(UPCOMING_FILE, allAnime.filter(a => a.status === 'NOT_YET_RELEASED'));

    console.log(`🚀 تم التحديث بنجاح! السكربت قام برفع ${uploadsThisSession} صورة لـ ImgBB.`);
}

main();
