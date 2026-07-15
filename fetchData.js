const fs = require('fs');
const path = require('path');

// إنشاء مجلد الحفظ إذا لم يكن موجوداً
const API_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(API_DIR)) {
    fs.mkdirSync(API_DIR, { recursive: true });
}

// 🌟 الرابط الصحيح والمباشر لأحدث إصدار من الملف المصغر بناءً على التوثيق
const AOD_LATEST_URL = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';

async function fetchAOD() {
    console.log("🚀 جاري تحميل قاعدة البيانات من قسم الإصدارات (Releases)...");
    const response = await fetch(AOD_LATEST_URL);
    if (!response.ok) throw new Error(`فشل التحميل: HTTP status ${response.status}`);
    return await response.json();
}

async function generateStaticAPIs() {
    try {
        const aodData = await fetchAOD();
        
        if (aodData && aodData.data) {
            console.log("✅ تم تحميل البيانات بنجاح، جاري المعالجة...");
            
            // تنقية البيانات الأساسية لتقليل حجمها
            const allAnime = aodData.data.map(anime => ({
                        title: anime.title,
                        type: anime.type,
                        status: anime.status,
                        episodes: anime.episodes,
                        season: anime.animeSeason,
                        image: anime.picture,
                        tags: anime.tags,
                        sources: anime.sources,
                        // 🌟 السطر الجديد لجلب تقييم الأنمي الحقيقي
                        score: anime.score?.arithmeticMean || 0 
                    }));

            // تقسيم البيانات إلى ملفات JSON منفصلة
            fs.writeFileSync(path.join(API_DIR, 'database.json'), JSON.stringify(allAnime));
            fs.writeFileSync(path.join(API_DIR, 'seasonal.json'), JSON.stringify(allAnime.filter(a => a.status === 'ONGOING'), null, 2));
            fs.writeFileSync(path.join(API_DIR, 'upcoming.json'), JSON.stringify(allAnime.filter(a => a.status === 'UPCOMING'), null, 2));

            console.log("🎉 تم حفظ جميع الملفات (database, seasonal, upcoming) بنجاح!");
        }
    } catch (error) {
        console.error("❌ حدث خطأ أثناء المعالجة:", error);
        process.exit(1); // إرسال رمز خطأ للسيرفر لإيقاف العملية
    }
}

// تشغيل السكربت
generateStaticAPIs();
