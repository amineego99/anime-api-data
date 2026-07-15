const fs = require('fs');
const path = require('path');

const ANILIST_API_URL = 'https://graphql.anilist.co';
const AOD_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
// تم وضع الـ API الخاص بك هنا
const IMGBB_API_KEY = '26b4fdf643aa51e8a1b09f02fa8a7a98';

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
const IS_FIRST_RUN = !fs.existsSync(ALL_ANIME_FILE);
const TOTAL_PAGES = IS_FIRST_RUN ? 800 : 10; 

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
        if (json.errors) throw new Error(json.errors[0].message);
        return json.data.Page.media;
    } catch (error) {
        if (retries > 0) {
            console.warn(`⏳ ضغط على السيرفر في الصفحة ${page}. ننتظر 5 ثوانٍ...`);
            await delay(5000);
            return fetchAnilistAnimePage(page, retries - 1);
        }
        return [];
    }
}

// تم تجريد هذه الدالة لتقوم فقط بجلب المعرفات (IDs) بدون الصور
async function buildAodMapper() {
    console.log("🚀 جاري جلب AOD لاستخراج المعرفات فقط...");
    try {
        const res = await fetch(AOD_URL, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
        
        const text = await res.text();
        const aodData = JSON.parse(text.trim());
        const mapper = {};
        
        aodData.data.forEach(anime => {
            let aniId = null, malId = null;
            anime.sources.forEach(s => {
                if (s.includes('anilist.co/anime/')) aniId = parseInt(s.split('/').pop());
                if (s.includes('myanimelist.net/anime/')) malId = parseInt(s.split('/').pop());
            });
            if (aniId) {
                mapper[aniId] = { mal_id: malId }; 
            }
        });
        console.log(`✅ تم بناء خريطة AOD بنجاح.`);
        return mapper;
    } catch (e) {
        console.error("⚠️ فشل جلب AOD:", e.message);
        return {};
    }
}

// دالة الرفع إلى ImgBB
async function uploadToImgBB(imageUrl) {
    if (!imageUrl) return '';
    try {
        const formData = new FormData();
        formData.append('image', imageUrl); // ImgBB يقبل الروابط مباشرة
        
        const response = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (data.success) {
            return data.data.url;
        } else {
            console.error(`❌ فشل الرفع لـ ImgBB للصورة ${imageUrl}:`, data.error.message);
            return imageUrl; 
        }
    } catch (error) {
        console.error(`❌ خطأ في الاتصال بـ ImgBB للصورة ${imageUrl}:`, error.message);
        return imageUrl;
    }
}

// دالة تنسيق البيانات أصبحت غير متزامنة لانتظار رفع الصور
async function formatAnimeData(anime, aodMap, existingAnime) {
    const aodInfo = aodMap[anime.id] || {};
    
    // سحب الصورة عالية الدقة من AniList كهدف للرفع
    let coverUrl = anime.coverImage?.extraLarge || anime.coverImage?.large || '';
    let bannerUrl = anime.bannerImage || '';

    // التحقق مما إذا تم رفع الغلاف مسبقاً
    if (existingAnime && existingAnime.coverImage?.large?.includes('ibb.co')) {
        coverUrl = existingAnime.coverImage.large;
    } else if (coverUrl) {
        console.log(`جاري استضافة الغلاف: ${anime.title.romaji}...`);
        const uploadedCover = await uploadToImgBB(coverUrl);
        coverUrl = uploadedCover || coverUrl;
    }

    // التحقق مما إذا تم رفع البانر مسبقاً
    if (existingAnime && existingAnime.bannerImage?.includes('ibb.co')) {
        bannerUrl = existingAnime.bannerImage;
    } else if (bannerUrl) {
        console.log(`جاري استضافة البانر: ${anime.title.romaji}...`);
        const uploadedBanner = await uploadToImgBB(bannerUrl);
        bannerUrl = uploadedBanner || bannerUrl;
    } else {
        bannerUrl = coverUrl; // استخدام الغلاف كبانر إذا لم يتوفر
    }

    return {
        id: anime.id,
        mal_id: anime.idMal || aodInfo.mal_id || null,
        title: {
            romaji: anime.title.romaji || '',
            english: anime.title.english || anime.title.romaji || '',
            native: anime.title.native || ''
        },
        description: anime.description || 'الوصف غير متوفر.',
        coverImage: {
            large: coverUrl,
            medium: coverUrl // توحيد الرابط لتوفير الطلبات الإضافية
        },
        bannerImage: bannerUrl,
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
    
    let syncData = loadJSON(SYNC_FILE);
    let lastSyncTime = syncData.last_updated_at || 0;
    let newHighestSyncTime = lastSyncTime;

    let stopFetching = false;
    let uploadsThisSession = 0;
    // تحديد سقف للرفع في الجلسة الواحدة لتفادي حظر ImgBB (سيقوم برفعها تدريجياً مع كل تحديث)
    const MAX_UPLOADS_PER_SESSION = 100; 

    // ─── المرحلة 1: تحديث البيانات الجديدة من AniList ──────────────────────────
    console.log('🔄 المرحلة 1: جلب الأنميات والتحديثات الجديدة...');
    for (let page = 1; page <= TOTAL_PAGES; page++) {
        if (stopFetching) break;
        console.log(`جلب الصفحة ${page} من AniList...`);
        
        const animes = await fetchAnilistAnimePage(page);
        if (animes.length === 0) break;

        for (const anime of animes) {
            if (anime.updatedAt > newHighestSyncTime) newHighestSyncTime = anime.updatedAt;

            // نظام توفير الموارد الذكي
            if (!IS_FIRST_RUN && anime.updatedAt <= lastSyncTime) {
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
        if (page < TOTAL_PAGES && !stopFetching) await delay(1500);
    }

    // ─── المرحلة 2: رفع الصور المتبقية ببطء وأمان (الاستئناف الذكي) ─────────────
    console.log('🖼️ المرحلة 2: معالجة الصور التي لم ترفع بعد...');
    for (let i = 0; i < allAnime.length; i++) {
        if (uploadsThisSession >= MAX_UPLOADS_PER_SESSION) {
            console.log(`⚠️ تم الوصول للحد الآمن للرفع (${MAX_UPLOADS_PER_SESSION}). سيتم إكمال الباقي في التحديث القادم.`);
            break; 
        }

        let anime = allAnime[i];
        let isUpdated = false;

        if (anime.coverImage.large && !anime.coverImage.large.includes('ibb.co')) {
            console.log(`رفع غلاف: ${anime.title.romaji}`);
            const newCover = await uploadToImgBB(anime.coverImage.large);
            if (newCover && newCover !== anime.coverImage.large) {
                anime.coverImage.large = newCover;
                anime.coverImage.medium = newCover;
                isUpdated = true;
                uploadsThisSession++;
            }
            await delay(1500); // استراحة لتخفيف الضغط
        }

        if (uploadsThisSession < MAX_UPLOADS_PER_SESSION && anime.bannerImage && !anime.bannerImage.includes('ibb.co') && anime.bannerImage !== anime.coverImage.large) {
            console.log(`رفع بانر: ${anime.title.romaji}`);
            const newBanner = await uploadToImgBB(anime.bannerImage);
            if (newBanner && newBanner !== anime.bannerImage) {
                anime.bannerImage = newBanner;
                isUpdated = true;
                uploadsThisSession++;
            }
            await delay(1500);
        }

        // حفظ التقدم لتفادي ضياع الصور المرفوعة
        if (isUpdated && uploadsThisSession % 10 === 0) {
            saveJSON(ALL_ANIME_FILE, allAnime);
        }
    }

    // ─── المرحلة 3: الترتيب والحفظ النهائي ────────────────────────────────────
    console.log('💾 المرحلة 3: ترتيب وحفظ البيانات...');
    allAnime.sort((a, b) => b.popularity - a.popularity);

    saveJSON(ALL_ANIME_FILE, allAnime);
    saveJSON(SYNC_FILE, { last_updated_at: newHighestSyncTime });
    
    saveJSON(ONGOING_FILE, allAnime.filter(a => a.status === 'RELEASING'));
    saveJSON(UPCOMING_FILE, allAnime.filter(a => a.status === 'NOT_YET_RELEASED'));
    
    const schedule = allAnime
        .filter(a => a.nextAiringEpisode)
        .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt);
    saveJSON(SCHEDULE_FILE, schedule);

    console.log(`🚀 تم تحديث الـ API بنجاح! وتم رفع ${uploadsThisSession} صورة في هذه الجلسة.`);
}
main();
