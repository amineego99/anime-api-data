const fs = require('fs');
const path = require('path');

const ANILIST_API_URL = 'https://graphql.anilist.co';
const AOD_URL = 'https://raw.githubusercontent.com/manami-project/anime-offline-database/refs/heads/master/anime-offline-database-minified.json';

const DB_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// مسارات الملفات
const ALL_ANIME_FILE = path.join(DB_DIR, 'database.json');
const ONGOING_FILE = path.join(DB_DIR, 'seasonal.json');
const UPCOMING_FILE = path.join(DB_DIR, 'upcoming.json');
const SCHEDULE_FILE = path.join(DB_DIR, 'schedule.json'); // للحلقات الجديدة
const SYNC_FILE = path.join(DB_DIR, 'sync.json');

const PER_PAGE = 50;
const IS_FIRST_RUN = !fs.existsSync(ALL_ANIME_FILE);
// 400 صفحة تجلب كل أنميات العالم (حوالي 20 ألف) في التشغيل الأول، و 5 صفحات للتحديث اليومي
const TOTAL_PAGES = IS_FIRST_RUN ? 400 : 5; 

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

// 1. جلب AOD لبناء قاموس المعرفات
async function buildAodMapper() {
    console.log("🚀 جاري جلب AOD لبناء خريطة المعرفات...");
    try {
        const res = await fetch(AOD_URL);
        const text = await res.text();
        const aodData = JSON.parse(text.trim());
        const mapper = {};
        
        aodData.data.forEach(anime => {
            let aniId = null, malId = null;
            anime.sources.forEach(s => {
                if (s.includes('anilist.co/anime/')) aniId = parseInt(s.split('/').pop());
                if (s.includes('myanimelist.net/anime/')) malId = parseInt(s.split('/').pop());
            });
            if (aniId) mapper[aniId] = { mal_id: malId };
        });
        return mapper;
    } catch (e) {
        console.warn("⚠️ فشل جلب AOD، سنستمر بدونه.");
        return {};
    }
}

// 2. تنسيق البيانات لتتطابق 100% مع تطبيق React الخاص بك
function formatAnimeData(anime, aodMap) {
    const extraIds = aodMap[anime.id] || {};
    
    return {
        id: anime.id,
        mal_id: anime.idMal || extraIds.mal_id || null,
        title: {
            romaji: anime.title.romaji || '',
            english: anime.title.english || anime.title.romaji || '',
            native: anime.title.native || ''
        },
        description: anime.description || 'الوصف غير متوفر.',
        coverImage: anime.coverImage,
        bannerImage: anime.bannerImage || anime.coverImage.extraLarge || anime.coverImage.large,
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
    if (IS_FIRST_RUN) console.log('🌟 التشغيل الأول! سيتم جلب قاعدة البيانات بالكامل...');

    const aodMap = await buildAodMapper();
    
    let allAnime = loadJSON(ALL_ANIME_FILE);
    let animeMap = new Map(allAnime.map((a, i) => [a.id, i]));
    
    let syncData = loadJSON(SYNC_FILE);
    let lastSyncTime = syncData.last_updated_at || 0;
    let newHighestSyncTime = lastSyncTime;

    let stopFetching = false;

    for (let page = 1; page <= TOTAL_PAGES; page++) {
        if (stopFetching) break;
        console.log(`جلب الصفحة ${page} من AniList...`);
        
        const animes = await fetchAnilistAnimePage(page);
        if (animes.length === 0) break;

        for (const anime of animes) {
            if (anime.updatedAt > newHighestSyncTime) newHighestSyncTime = anime.updatedAt;

            // المزامنة الذكية: إيقاف الجلب إذا وصلنا لبيانات قديمة تم جلبها سابقاً
            if (!IS_FIRST_RUN && anime.updatedAt <= lastSyncTime) {
                console.log(`🛑 تم الوصول لبيانات محدثة مسبقاً (ID: ${anime.id}). إيقاف الجلب لتوفير الموارد!`);
                stopFetching = true;
                break;
            }

            const formatted = formatAnimeData(anime, aodMap);
            if (animeMap.has(formatted.id)) {
                allAnime[animeMap.get(formatted.id)] = formatted;
            } else {
                allAnime.push(formatted);
                animeMap.set(formatted.id, allAnime.length - 1);
            }
        }
        if (page < TOTAL_PAGES && !stopFetching) await delay(1500);
    }

    // ترتيب الأنميات حسب الشهرة كوضع افتراضي قوي
    allAnime.sort((a, b) => b.popularity - a.popularity);

    // حفظ الملفات
    saveJSON(ALL_ANIME_FILE, allAnime);
    saveJSON(SYNC_FILE, { last_updated_at: newHighestSyncTime });
    
    // فلترة الملفات المصغرة لتطبيقك
    saveJSON(ONGOING_FILE, allAnime.filter(a => a.status === 'RELEASING'));
    saveJSON(UPCOMING_FILE, allAnime.filter(a => a.status === 'NOT_YET_RELEASED'));
    
    // ملف خاص بجدول الحلقات القادمة مرتب زمنياً
    const schedule = allAnime
        .filter(a => a.nextAiringEpisode)
        .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt);
    saveJSON(SCHEDULE_FILE, schedule);

    console.log('🚀 تم تحديث الـ API بنجاح!');
}

main();
