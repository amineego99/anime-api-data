const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'api');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const SCHEDULE_FILE = path.join(DB_DIR, 'schedule.json');

const query = `
  query($page: Int, $start: Int, $end: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
        id
        episode
        airingAt
        media {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
          format
          seasonYear
          isAdult
          genres
        }
      }
    }
  }
`;

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function fetchSchedule() {
  console.log('🌟 جاري جلب جدول الحلقات الشامل من AniList...');
  
  const now = new Date();
  // تحديد النطاق الزمني: من 5 أيام سابقة إلى 5 أيام قادمة
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5).getTime() / 1000);
  const end = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5).getTime() / 1000);

  let page = 1;
  let hasNextPage = true;
  let allSchedules = [];

  while (hasNextPage) {
    console.log(`جلب الصفحة ${page}...`);
    try {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { page, start, end } })
      });

      if (res.status === 429) {
        console.log('⏳ تم الوصول لحد الطلبات (Rate Limit)، ننتظر 60 ثانية...');
        await delay(60000);
        continue;
      }

      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0].message);

      const data = json.data.Page;
      hasNextPage = data.pageInfo.hasNextPage;
      
      // تصفية وتنسيق البيانات لتتطابق تماماً مع ما تتوقعه Schedule.jsx
      const formatted = data.airingSchedules
        .filter(item => {
          const media = item.media;
          if (!media) return false;
          const isAdult = media.isAdult === true;
          const hasHentai = media.genres?.some(g => g.toLowerCase() === 'hentai' || g.toLowerCase() === 'ecchi');
          return !isAdult && !hasHentai;
        })
        .map(item => ({
          id: item.media.id, 
          episode: item.episode,
          lastAiredAt: item.airingAt, 
          title: item.media.title,
          coverImage: item.media.coverImage,
          format: item.media.format,
          seasonYear: item.media.seasonYear,
          isAdult: item.media.isAdult,
          genres: item.media.genres
        }));

      allSchedules.push(...formatted);
      page++;
      
      // تأخير بسيط لتفادي الحظر من سيرفرات AniList
      await delay(1500); 
    } catch (error) {
      console.error(`❌ خطأ في جلب الصفحة ${page}:`, error.message);
      break;
    }
  }

  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(allSchedules), 'utf8');
  console.log(`✅ تم حفظ ${allSchedules.length} حلقة بنجاح في schedule.json`);
}

fetchSchedule();
