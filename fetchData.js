const fs = require('fs');
const path = require('path');

// 🌟 تحديد المجلد الذي سيتم حفظ ملفات الـ JSON فيه
const API_DIR = path.join(__dirname, 'api');

if (!fs.existsSync(API_DIR)) {
    fs.mkdirSync(API_DIR, { recursive: true });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`[جاري الجلب] المحاولة ${i + 1}...`);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error(`[فشل] المحاولة ${i + 1}: ${error.message}`);
            if (i === retries - 1) throw error;
            await delay(2000);
        }
    }
}

async function generateStaticAPIs() {
    try {
        console.log("🚀 بدء جلب البيانات من Anime Offline Database (AOD) فقط...");

        // جلب قاعدة البيانات الشاملة من AOD
        const aodData = await fetchWithRetry('https://raw.githubusercontent.com/manami-project/anime-offline-database/master/anime-offline-database-minified.json');
        
        if (aodData && aodData.data) {
            
            // 1. تنظيف البيانات الأساسية
            const allAnime = aodData.data.map(anime => ({
                title: anime.title,
                type: anime.type,
                status: anime.status, // الحالات في AOD هي: ONGOING, FINISHED, UPCOMING, UNKNOWN
                episodes: anime.episodes,
                season: anime.animeSeason,
                image: anime.picture,
                tags: anime.tags,
                sources: anime.sources 
            }));

            // 2. فلترة الأنميات التي تُعرض حالياً (الموسمية) من داخل AOD نفسها
            const seasonalAnime = allAnime.filter(a => a.status === 'ONGOING' && a.type === 'TV');

            // 3. فلترة الأنميات القادمة (الموسم القادم)
            const upcomingAnime = allAnime.filter(a => a.status === 'UPCOMING' && a.type === 'TV');

            // 4. حفظ الملفات مقسمة وخفيفة لتطبيقك
            fs.writeFileSync(path.join(API_DIR, 'database.json'), JSON.stringify(allAnime));
            fs.writeFileSync(path.join(API_DIR, 'seasonal.json'), JSON.stringify(seasonalAnime, null, 2));
            fs.writeFileSync(path.join(API_DIR, 'upcoming.json'), JSON.stringify(upcomingAnime, null, 2));

            console.log(`✅ تم حفظ database.json (إجمالي الأنميات: ${allAnime.length})`);
            console.log(`✅ تم حفظ seasonal.json (الأنميات المستمرة: ${seasonalAnime.length})`);
            console.log(`✅ تم حفظ upcoming.json (الأنميات القادمة: ${upcomingAnime.length})`);
            console.log("🎉 تمت العملية بنجاح! أنت الآن مستقل تماماً عن Jikan و AniList.");
        }
    } catch (error) {
        console.error("❌ حدث خطأ أثناء المعالجة:", error);
        process.exit(1);
    }
}

generateStaticAPIs();
