const fs = require('fs');
const path = require('path');

const ANILIST_API_URL = 'https://graphql.anilist.co';
const DB_DIR = path.join(__dirname, 'api');
const ALL_ANIME_FILE = path.join(DB_DIR, 'database.json');
const RELATIONS_FILE = path.join(DB_DIR, 'relations.json');

// استعلام AniList المخصص لجلب الصلات فقط دفعة واحدة (50 أنمي في كل طلب)
const query = `
query ($idIn: [Int]) {
  Page(page: 1, perPage: 50) {
    media(id_in: $idIn, type: ANIME) {
      id
      relations {
        edges {
          relationType(version: 2)
          node { id }
        }
      }
      recommendations(sort: [RATING_DESC], page: 1, perPage: 15) {
        nodes {
          mediaRecommendation { id }
        }
      }
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
}

async function delay(ms) { 
    return new Promise(resolve => setTimeout(resolve, ms)); 
}

// دالة الاتصال بـ AniList مع نظام الحماية من الحظر (Retry)
async function fetchRelationsChunk(idsChunk, retries = 3) {
    try {
        const response = await fetch(ANILIST_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { idIn: idsChunk } })
        });
        
        const json = await response.json();
        
        if (response.status === 429) throw new Error('Rate Limit'); 
        if (json.errors) throw new Error(json.errors[0].message);
        
        return json.data.Page.media;
    } catch (error) {
        if (retries > 0) {
            console.warn(`⏳ حظر مؤقت من AniList. ننتظر 60 ثانية...`);
            await delay(60000); 
            return fetchRelationsChunk(idsChunk, retries - 1);
        }
        console.error(`❌ فشل جلب البيانات لهذه الدفعة بعد عدة محاولات.`);
        return [];
    }
}

async function main() {
    console.log('🌟 جاري تشغيل سكربت استخراج الصلات والتوصيات المستقل...');

    if (!fs.existsSync(ALL_ANIME_FILE)) {
        console.error('❌ ملف database.json غير موجود! يرجى التأكد من المسار.');
        return;
    }

    let allAnime = loadJSON(ALL_ANIME_FILE);
    let existingRelations = loadJSON(RELATIONS_FILE);
    
    // تحويل الملف الحالي إلى خريطة لتجنب جلب بيانات أنمي تم جلبه مسبقاً (ميزة الاستكمال)
    let relationsMap = new Map(existingRelations.map(r => [r.id, r]));

    // استخراج الكائنات (Objects) الكاملة للأنميات التي لم نجلب صلاتها بعد بدلاً من مجرد الـ IDs
    let missingAnimes = allAnime.filter(a => !relationsMap.has(a.id));

    if (missingAnimes.length === 0) {
        console.log('✅ جميع الأنميات تمتلك بيانات صلات مسبقاً في relations.json. لا حاجة للتحديث.');
        return;
    }

    console.log(`🔍 تم العثور على ${missingAnimes.length} أنمي يحتاج إلى جلب بيانات الصلات...`);

    // تقسيم الأنميات إلى دفعات (Chunks) كل دفعة تحتوي على 50 أنمي
    const CHUNK_SIZE = 50;
    let processedCount = 0;

    for (let i = 0; i < missingAnimes.length; i += CHUNK_SIZE) {
        const chunkAnimes = missingAnimes.slice(i, i + CHUNK_SIZE);
        const chunkIds = chunkAnimes.map(a => a.id); // استخراج IDs فقط لإرسالها لـ API
        
        console.log(`🔄 جاري جلب الدفعة ${Math.floor(i / CHUNK_SIZE) + 1} من ${Math.ceil(missingAnimes.length / CHUNK_SIZE)}...`);
        
        const mediaData = await fetchRelationsChunk(chunkIds);

        for (const anime of mediaData) {
            // 🌟 البحث عن الأنمي الأصلي في قاعدة البيانات لجلب جميع معرفاته الأخرى
            const originalAnime = chunkAnimes.find(a => a.id === anime.id);

            // استخراج معرفات الأنميات المرتبطة ونوع الصلة فقط
            let animeRelations = [];
            if (anime.relations && anime.relations.edges) {
                anime.relations.edges.forEach(edge => {
                    if (edge.node && edge.node.id) {
                        animeRelations.push({
                            id: edge.node.id,
                            type: edge.relationType
                        });
                    }
                });
            }

            // استخراج معرفات الأنميات المشابهة فقط كأرقام (Array of IDs)
            let animeSimilar = [];
            if (anime.recommendations && anime.recommendations.nodes) {
                anime.recommendations.nodes.forEach(node => {
                    if (node.mediaRecommendation && node.mediaRecommendation.id) {
                        animeSimilar.push(node.mediaRecommendation.id);
                    }
                });
            }

            // 🌟 حفظ البيانات في الخريطة مع جميع المعرفات (IDs) الاحتياطية
            relationsMap.set(anime.id, {
                id: anime.id,
                mal_id: originalAnime ? originalAnime.mal_id : null,
                kitsu_id: originalAnime ? originalAnime.kitsu_id : null,
                tmdb_id: originalAnime ? originalAnime.tmdb_id : null,
                tmdb_type: originalAnime ? originalAnime.tmdb_type : null,
                relations: animeRelations,
                similar: animeSimilar
            });
            
            processedCount++;
        }

        // حفظ تلقائي بعد كل دفعة لحماية البيانات
        saveJSON(RELATIONS_FILE, Array.from(relationsMap.values()));
        
        // تأخير بسيط جداً لتجنب حظر AniList السريع
        await delay(1000); 
    }

    console.log(`\n🎉 اكتمل العمل! تم جلب وحفظ صلات ${processedCount} أنمي في ملف relations.json بنجاح.`);
}

main();
