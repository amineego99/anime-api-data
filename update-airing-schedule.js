const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'public', 'api');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// 🌟 ملف جديد كلياً مخصص لصفحة Schedule فقط، ولن يمس schedule.json القديم
const AIRING_SCHEDULE_FILE = path.join(DB_DIR, 'airing-schedule.json');

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
          averageScore
        }
      }
    }
  }
`;

async function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

async function generateAiringSchedule() {
  console.log('🌟 جاري جلب جدول البث الشامل لملف airing-schedule.json الجديد...');
  
  const now = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5).getTime() / 1000);
  const end = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5).getTime() / 1000);

  let page = 1;
  let hasNextPage = true;
  let allSchedules = [];

  while (hasNextPage) {
    try {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { page, start, end } })
      });

      if (res.status === 429) {
        await delay(60000);
        continue;
      }

      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0].message);

      const data = json.data.Page;
      hasNextPage = data.pageInfo.hasNextPage;
      
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
          averageScore: item.media.averageScore,
          isAdult: item.media.isAdult,
          genres: item.media.genres
        }));

      allSchedules.push(...formatted);
      page++;
      await delay(1500); 
    } catch (error) {
      console.error(`❌ خطأ في الصفحة ${page}:`, error.message);
      break;
    }
  }

  fs.writeFileSync(AIRING_SCHEDULE_FILE, JSON.stringify(allSchedules), 'utf8');
  console.log(`✅ تم إنشاء وحفظ ${allSchedules.length} عنصر في api/airing-schedule.json بنجاح.`);
}

generateAiringSchedule();
