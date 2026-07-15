const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(API_DIR)) {
    fs.mkdirSync(API_DIR, { recursive: true });
}

const AOD_LATEST_URL = 'https://raw.githubusercontent.com/manami-project/anime-offline-database/refs/heads/master/anime-offline-database-minified.json';
const ANILIST_URL = 'https://graphql.anilist.co';

// دالة تأخير لتجنب حظر السيرفر
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// دالة جلب البيانات من AniList على دفعات آمنة (25 أنمي في كل دفعة)
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
            // انتظار ثانية ونصف بين كل طلب لضمان عدم حظر GitHub Actions
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
        const aodData = await aodRes.json();
        
        console.log("🌟 جاري جلب أرقام الشهرة الحقيقية من AniList...");
        const popularAniList = await fetchAniListTop('POPULARITY_DESC', 1000); 
        
        console.log("⭐ جاري جلب التقييمات الحقيقية من AniList...");
        const topRatedAniList = await fetchAniListTop('SCORE_DESC', 1000); 
        
        // دمج أرقام AniList في كائن واحد للبحث السريع
        const combinedAniList = { ...popularAniList, ...topRatedAniList };

        console.log("✅ جاري دمج البيانات وتنقيتها...");
        const allAnime = aodData.data.map(anime => {
            // استخراج معرف AniList من روابط AOD
            const anilistSource = anime.sources?.find(s => s.includes('anilist.co/anime/'));
            const anilistId = anilistSource ? parseInt(anilistSource.split('/').pop()) : null;
            
            // قيم افتراضية تعتمد على عدد المصادر للأنميات غير الموجودة في التوب 1000
            let popularity = (anime.sources?.length || 0) * 100; 
            let score = anime.score?.arithmeticMean ? Math.round(anime.score.arithmeticMean * 10) : 0;

            // إذا كان الأنمي ضمن الأنميات الشهيرة، نأخذ أرقامه الدقيقة من AniList
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

        // حفظ القاعدة الشاملة
        fs.writeFileSync(path.join(API_DIR, 'database.json'), JSON.stringify(allAnime));

        console.log("🎉 تم إنشاء قاعدة البيانات بنجاح مع الترتيب الحقيقي!");
    } catch (error) {
        console.error("❌ حدث خطأ أثناء المعالجة:", error);
        process.exit(1);
    }
}

generateStaticAPIs();
