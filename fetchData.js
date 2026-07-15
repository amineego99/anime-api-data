const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(API_DIR)) {
    fs.mkdirSync(API_DIR, { recursive: true });
}

const AOD_LATEST_URL = 'https://raw.githubusercontent.com/manami-project/anime-offline-database/refs/heads/master/anime-offline-database-minified.json';
const ANILIST_URL = 'https://graphql.anilist.co';

const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function fetchAniListTop(sortType, totalItems = 1000) {
    let results = {};
    const perPage = 25; 
    const pages = Math.ceil(totalItems / perPage);

    for (let page = 1; page <= pages; page++) {
        const query = `
        query {
            Page(page: ${page}, perPage: ${perPage}) {
                media(type: ANIME, sort: ${sortType}) {
                    id
                    averageScore
                    popularity
                }
            }
        }`;

        try {
            const response = await fetch(ANILIST_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query })
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const json = await response.json();
            if (json.data && json.data.Page && json.data.Page.media) {
                json.data.Page.media.forEach(anime => {
                    results[anime.id] = {
                        score: anime.averageScore || 0,
                        popularity: anime.popularity || 0
                    };
                });
            }
            await delay(1500); 
        } catch (error) {
            console.error(`❌ خطأ في جلب الصفحة ${page} من AniList:`, error.message);
        }
    }
    return results;
}

async function generateStaticAPIs() {
    try {
        console.log("🚀 جاري تحميل قاعدة بيانات AOD...");
        const aodRes = await fetch(AOD_LATEST_URL);
        
        // تعديل جوهري: قراءة الاستجابة كنص وتنظيفها قبل التحويل لـ JSON
        const rawText = await aodRes.text();
        if (!rawText || rawText.trim().length === 0) throw new Error("الملف المحمل من AOD فارغ");
        
        const aodData = JSON.parse(rawText.trim());
        
        console.log("🌟 جاري جلب أرقام الشهرة الحقيقية من AniList...");
        const popularAniList = await fetchAniListTop('POPULARITY_DESC', 1000); 
        
        console.log("⭐ جاري جلب التقييمات الحقيقية من AniList...");
        const topRatedAniList = await fetchAniListTop('SCORE_DESC', 1000); 
        
        const combinedAniList = { ...popularAniList, ...topRatedAniList };

        console.log("✅ جاري دمج البيانات وتنقيتها...");
        const allAnime = aodData.data.map(anime => {
            const anilistSource = anime.sources?.find(s => s.includes('anilist.co/anime/'));
            const anilistId = anilistSource ? parseInt(anilistSource.split('/').pop()) : null;
            
            let popularity = (anime.sources?.length || 0) * 100; 
            let score = anime.score?.arithmeticMean ? Math.round(anime.score.arithmeticMean * 10) : 0;

            if (anilistId && combinedAniList[anilistId]) {
                popularity = combinedAniList[anilistId].popularity;
                score = combinedAniList[anilistId].score;
            }

            return {
                title: anime.title,
                type: anime.type,
                status: anime.status,
                episodes: anime.episodes,
                season: anime.animeSeason,
                image: anime.picture,
                tags: anime.tags,
                sources: anime.sources,
                score: score,
                popularity: popularity
            };
        });

        fs.writeFileSync(path.join(API_DIR, 'database.json'), JSON.stringify(allAnime));
        
        // إنشاء ملفات موسمية وقادمة بنفس التنسيق المحدث
        const seasonal = allAnime.filter(a => a.status === 'ONGOING');
        const upcoming = allAnime.filter(a => a.status === 'UPCOMING');
        fs.writeFileSync(path.join(API_DIR, 'seasonal.json'), JSON.stringify(seasonal));
        fs.writeFileSync(path.join(API_DIR, 'upcoming.json'), JSON.stringify(upcoming));

        console.log("🎉 تم إنشاء قاعدة البيانات بنجاح مع الترتيب الحقيقي!");
    } catch (error) {
        console.error("❌ حدث خطأ أثناء المعالجة:", error);
        process.exit(1);
    }
}

generateStaticAPIs();
