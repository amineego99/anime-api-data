const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, 'api');

if (!fs.existsSync(API_DIR)) {
  fs.mkdirSync(API_DIR, { recursive: true });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[URL] ${url}`);
      console.log(`[جاري الجلب] المحاولة ${i + 1}...`);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`[فشل] المحاولة ${i + 1}: ${error.message}`);

      if (i === retries - 1) {
        throw error;
      }

      await delay(2000);
    }
  }
}

async function generateStaticAPIs() {
  try {
    console.log('🚀 بدء جلب البيانات من Anime Offline Database (AOD) فقط...');

    const aodData = await fetchWithRetry(
      'https://github.com/manami-project/anime-offline-database/raw/master/anime-offline-database.json'
    );

    if (!aodData || !Array.isArray(aodData.data)) {
      throw new Error('بنية ملف AOD غير متوقعة: الخاصية data غير موجودة أو ليست array');
    }

    const allAnime = aodData.data.map(anime => ({
      title: anime.title || null,
      type: anime.type || null,
      status: anime.status || null,
      episodes: anime.episodes || null,
      season: anime.animeSeason || null,
      image: anime.picture || null,
      tags: anime.tags || [],
      sources: anime.sources || []
    }));

    const seasonalAnime = allAnime.filter(
      anime => anime.status === 'ONGOING' && anime.type === 'TV'
    );

    const upcomingAnime = allAnime.filter(
      anime => anime.status === 'UPCOMING' && anime.type === 'TV'
    );

    fs.writeFileSync(
      path.join(API_DIR, 'database.json'),
      JSON.stringify(allAnime, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(API_DIR, 'seasonal.json'),
      JSON.stringify(seasonalAnime, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(API_DIR, 'upcoming.json'),
      JSON.stringify(upcomingAnime, null, 2),
      'utf8'
    );

    console.log(`✅ تم حفظ database.json (إجمالي الأنميات: ${allAnime.length})`);
    console.log(`✅ تم حفظ seasonal.json (الأنميات المستمرة: ${seasonalAnime.length})`);
    console.log(`✅ تم حفظ upcoming.json (الأنميات القادمة: ${upcomingAnime.length})`);
    console.log('🎉 تمت العملية بنجاح!');
  } catch (error) {
    console.error('❌ حدث خطأ أثناء المعالجة:', error);
    process.exit(1);
  }
}

generateStaticAPIs();
