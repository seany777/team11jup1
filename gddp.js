const axios = require('axios');
const express = require("express");
const cors = require("cors");

const https = require('https'); 
const httpsAgent = new https.Agent({ rejectUnauthorized: false }); 

const app = express();
app.use(cors());

// =================================================================================
// [API 설정 상수]
// =================================================================================
const GDDP_API_KEY = "daa3ef5f056699d48fe9f3df7791e5c013945dd620983c2b8e2542d2e6e87b78";
const AREDL_BASE = 'https://api.aredl.net/v2/api/aredl';

const DIFFICULTIES = {
    beginner: 1,
    bronze:   2,
    silver:   3,
    gold:     4
};

const CACHE_TIME = 60 * 60 * 1000; // 1시간 캐시

// =================================================================================
// ⚙️ GDDP 크롤링 로직
// =================================================================================
let cache = null;
let lastFetch = 0;

async function fetchLevels(difficulty, maxCount = 250) {
    let levels = [];
    let page = 0;
    
    while (levels.length < maxCount) {
        const url = `https://gdladder.com/api/level/search?limit=25&page=${page}&difficulty=${difficulty}&excludeUnrated=true&sort=rating&sortDirection=asc`;
        try {
            const res = await axios.get(url, { 
                headers: { "Authorization": `Bearer ${GDDP_API_KEY}` },
                httpsAgent: httpsAgent
            });
            const data = res.data;
            
            if (!data.levels || data.levels.length === 0) break;

            for (const level of data.levels) {
                if (levels.length >= maxCount) break;
                levels.push({
                    name:   level.Meta?.Name ?? null,
                    author: level.Meta?.Publisher?.name ?? null,
                });
            }
            
            if (data.levels.length < 25) break;
            page++;
        } catch (e) {
            console.error(`[CRASH] Difficulty ${difficulty} - Page ${page}:`, e.message);
            break; 
        }
    }
    return levels;
}

// =================================================================================
// 🌐 API 라우트 1: GDDP
// =================================================================================
app.get("/api/gddp", async (req, res) => {
    try {
        if (cache && Date.now() - lastFetch < CACHE_TIME) {
            console.log("✅ 캐시 사용: GDDP");
            return res.json(cache);
        }

        console.log("⚙️ GDDP 데이터 페치 시작...");
        const result = {};

        for (const [key, difficulty] of Object.entries(DIFFICULTIES)) {
            console.log(`🔄 페치 중: ${key} 티어...`);
            result[key] = await fetchLevels(difficulty);
            console.log(`✔️ ${key} 완료: ${result[key].length}개`);
        }

        cache = result;
        lastFetch = Date.now();
        console.log("✅ GDDP 완료.");
        res.json(result);

    } catch (err) {
        console.error("🚨 GDDP 오류:", err);
        res.status(500).json({ error: err.message });
    }
});


// =================================================================================
// 🚀 API 라우트 2: AREDL (공식 API v2 사용)
// =================================================================================
let aredlCache = null;
let aredlLastFetch = 0;

// 전체 레벨 목록 가져오기 (페이지네이션)
async function fetchAllAredlLevels() {
    const levels = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
        console.log(`📄 AREDL 레벨 목록 페이지 ${page} 페치 중...`);
        const res = await axios.get(`${AREDL_BASE}/levels`, {
            params: { page, page_size: pageSize }
        });

        const data = res.data;
        if (!Array.isArray(data) || data.length === 0) break;

        for (const level of data) {
            levels.push({
                position: level.position,
                name:     level.name,
                level_id: level.level_id,
            });
        }

        console.log(`✔️ 페이지 ${page} 완료: ${data.length}개 (누적: ${levels.length}개)`);

        if (data.length < pageSize) break;
        page++;
    }

    return levels;
}

// 개별 레벨의 creators 가져오기 (병렬, 동시 20개씩)
async function fetchCreatorsForLevels(levels) {
    const CONCURRENCY = 20;
    const result = [...levels];

    for (let i = 0; i < result.length; i += CONCURRENCY) {
        const chunk = result.slice(i, i + CONCURRENCY);
        const promises = chunk.map(async (level) => {
            try {
                const res = await axios.get(`${AREDL_BASE}/levels/${level.level_id}/creators`, {
                    timeout: 10000
                });
                const data = res.data;
                // creators 배열에서 user_name 추출, 여러 명이면 콤마로 join
                if (Array.isArray(data) && data.length > 0) {
                    level.publisher = data.map(c => c.user?.user_name ?? c.user_name ?? '?').join(', ');
                } else {
                    level.publisher = null;
                }
            } catch (e) {
                console.error(`⚠️ creators 페치 실패 (level_id: ${level.level_id}):`, e.message);
                level.publisher = null;
            }
            return level;
        });
        await Promise.all(promises);
        console.log(`👥 creators 페치 ${Math.min(i + CONCURRENCY, result.length)}/${result.length}`);
    }

    return result;
}

app.get("/api/aredl", async (req, res) => {
    console.log("🤝 AREDL 요청 수신");
    try {
        if (aredlCache && Date.now() - aredlLastFetch < CACHE_TIME) {
            console.log("✅ AREDL 캐시 사용");
            return res.json(aredlCache);
        }

        console.log("⚙️ AREDL 데이터 페치 시작...");

        // 1단계: 전체 레벨 목록
        const levels = await fetchAllAredlLevels();
        console.log(`📋 총 ${levels.length}개 레벨 목록 완료. creators 페치 시작...`);

        // 2단계: 각 레벨 creators 병렬 페치
        const result = await fetchCreatorsForLevels(levels);

        console.log(`✅ AREDL 완료: ${result.length}개`);
        aredlCache = result;
        aredlLastFetch = Date.now();
        res.json(result);

    } catch (err) {
        console.error("🚨 AREDL 처리 실패:", err);
        res.status(500).json({ error: err.message });
    }
});


// =================================================================================
// 🚀 서버 시작
// =================================================================================
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`================================================================================`);
    console.log(`✅ DIMIGO GD API Gateway Server가 ${PORT} 포트에서 실행되었습니다.`);
    console.log(`   [GDDP]  http://localhost:${PORT}/api/gddp`);
    console.log(`   [AREDL] http://localhost:${PORT}/api/aredl`);
    console.log(`================================================================================`);
});