import fs from 'fs';
import path from 'path';
import os from 'os';
import sqlite3Pkg from 'sqlite3';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { encodeRgbaToPng } from './png_encoder.mjs';

const sqlite3 = sqlite3Pkg.verbose();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bounding box for Taiwan and surrounding islands
export const TAIWAN_BBOX = {
    north: 25.5,
    south: 21.8,
    west: 119.3,
    east: 122.2
};

// Canvas Resolution: 400 px/degree (~250m per pixel)
const IPPD = 400;
const CANVAS_WIDTH = Math.round((TAIWAN_BBOX.east - TAIWAN_BBOX.west) * IPPD);   // ~1160 px
const CANVAS_HEIGHT = Math.round((TAIWAN_BBOX.north - TAIWAN_BBOX.south) * IPPD); // ~1480 px

export function getStationsFromDb(dbPath, days = 14) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, err => {
            if (err) return reject(err);
        });

        // 挑選指定天數內有上線、經緯度在台灣範圍內的測站
        // 優先順序：固定基礎設施 (ROUTER, REPEATER, CLIENT_BASE) -> 最愛節點 -> 一般客戶端
        // 同時以坐標聚合 (四捨五入至小數點後 3 位，約 100m) 避免同地點多台設備重複計算
        const query = `
            SELECT 
                ROUND(latitude, 3) as lat_round,
                ROUND(longitude, 3) as lng_round,
                COUNT(*) as node_count,
                GROUP_CONCAT(short_name) as names,
                MAX(node_id) as primary_node_id,
                MAX(short_name) as primary_name,
                AVG(latitude) as lat,
                AVG(longitude) as lng,
                MAX(role) as role,
                MAX(last_seen) as last_seen
            FROM nodes
            WHERE latitude IS NOT NULL AND longitude IS NOT NULL
              AND latitude BETWEEN ${TAIWAN_BBOX.south} AND ${TAIWAN_BBOX.north}
              AND longitude BETWEEN ${TAIWAN_BBOX.west} AND ${TAIWAN_BBOX.east}
              AND (
                  role IN ('CLIENT_BASE', 'ROUTER', 'ROUTER_LATE', 'REPEATER')
                  OR is_favorite = 1
                  OR role = 'CLIENT'
              )
              AND last_seen >= datetime('now', '-${days} days')
            GROUP BY lat_round, lng_round
            ORDER BY 
                CASE role 
                    WHEN 'ROUTER' THEN 1 
                    WHEN 'ROUTER_LATE' THEN 2 
                    WHEN 'REPEATER' THEN 3 
                    WHEN 'CLIENT_BASE' THEN 4
                    ELSE 5 
                END,
                node_count DESC,
                last_seen DESC
        `;

        db.all(query, (err, rows) => {
            db.close();
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function colorizeRgba(val) {
    // val is 0 for no signal / uncomputed, or 200 + dBm
    // LoRa SF11/12 sensitivity is ~ -130 dBm -> val >= 70
    if (val < 70) {
        return [0, 0, 0, 0]; // 完全透明
    }

    const dbm = val - 200; // -130 dBm to -40 dBm

    // 階梯漸層：專業 RF 覆蓋熱區配色 (深紫/藍 -> 翡翠青綠 -> 琥珀黃 -> 亮紅/亮橙)
    if (dbm < -115) {
        // 微弱邊緣訊號 (-130 ~ -115 dBm): 藍紫冷色系
        const t = (dbm - (-130)) / 15;
        const r = Math.round(99 + (6 - 99) * t);
        const g = Math.round(102 + (182 - 102) * t);
        const b = Math.round(241 + (212 - 241) * t);
        const a = Math.round(120 + 30 * t); // 半透明
        return [r, g, b, a];
    } else if (dbm < -95) {
        // 中等可用訊號 (-115 ~ -95 dBm): 青綠色系
        const t = (dbm - (-115)) / 20;
        const r = Math.round(6 + (16 - 6) * t);
        const g = Math.round(182 + (185 - 182) * t);
        const b = Math.round(212 + (129 - 212) * t);
        const a = Math.round(150 + 35 * t);
        return [r, g, b, a];
    } else if (dbm < -75) {
        // 良好主力訊號 (-95 ~ -75 dBm): 亮黃/青黃色系
        const t = (dbm - (-95)) / 20;
        const r = Math.round(16 + (234 - 16) * t);
        const g = Math.round(185 + (179 - 185) * t);
        const b = Math.round(129 + (8 - 129) * t);
        const a = Math.round(185 + 30 * t);
        return [r, g, b, a];
    } else {
        // 極強訊號 (-75 dBm ~ -40 dBm): 暖橘/鮮紅色系
        const t = Math.min(1, (dbm - (-75)) / 25);
        const r = Math.round(234 + (239 - 234) * t);
        const g = Math.round(179 + (68 - 179) * t);
        const b = Math.round(8 + (68 - 8) * t);
        const a = Math.round(215 + 35 * t);
        return [r, g, b, a];
    }
}

function mergeSignal(result, compositeSignal) {
    const { width, height, north, south, east, west, signalData } = result;
    for (let py = 0; py < height; py++) {
        const pLat = north - (py / height) * (north - south);
        if (pLat < TAIWAN_BBOX.south || pLat > TAIWAN_BBOX.north) continue;
        const cy = Math.round(((TAIWAN_BBOX.north - pLat) / (TAIWAN_BBOX.north - TAIWAN_BBOX.south)) * (CANVAS_HEIGHT - 1));

        const rowOffset = py * width;
        for (let px = 0; px < width; px++) {
            const sVal = signalData[rowOffset + px];
            if (sVal < 70) continue; // 小於 -130 dBm 忽略

            const pLon = west + (px / width) * (east - west);
            if (pLon < TAIWAN_BBOX.west || pLon > TAIWAN_BBOX.east) continue;
            const cx = Math.round(((pLon - TAIWAN_BBOX.west) / (TAIWAN_BBOX.east - TAIWAN_BBOX.west)) * (CANVAS_WIDTH - 1));

            const cIdx = cy * CANVAS_WIDTH + cx;
            if (sVal > compositeSignal[cIdx]) {
                compositeSignal[cIdx] = sVal;
            }
        }
    }
}

export async function runCoverageBake(options = {}) {
    const startTime = Date.now();
    const days = options.days || 14;
    const maxStations = options.maxStations || 500; // 擴增為全島 500 站
    const radiusKm = options.radiusKm || 35.0;      // 每站模擬半徑 35 公里
    const dbPath = options.dbPath || path.join(__dirname, '../meshtastic.db');
    
    // 多核心並行線程數：根據系統核心數自動指派 (最多 6 個 worker，保留足夠餘裕給系統)
    const cpuCount = (os.cpus() && os.cpus().length) || 4;
    const concurrency = options.concurrency || Math.min(5, Math.max(2, Math.floor(cpuCount / 2)));

    console.log(`📡 [RF 覆蓋烘焙 - 多核心加速模式] CPU 核心: ${cpuCount} | 並行線程數: ${concurrency} | 目標站數: ${maxStations}`);
    console.log(`🔍 正在自 ${dbPath} 提取過去 ${days} 天活躍之固定地理站點...`);
    const allStations = await getStationsFromDb(dbPath, days);
    console.log(`📊 共篩選出 ${allStations.length} 個固定地理站點`);

    const stationsToSimulate = allStations.slice(0, maxStations);
    const totalCount = stationsToSimulate.length;
    console.log(`🎯 本次排程將深度模擬全島前 ${totalCount} 個核心站點 (模擬半徑 ${radiusKm}km)...`);

    // 初始化全台大圖矩陣 (全部填 0)
    const compositeSignal = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);
    const simulatedStationsMeta = [];

    // 建立 Worker 線程池
    const workers = [];
    let completedCount = 0;
    let nextStationIndex = 0;

    await new Promise((resolve, reject) => {
        let activeWorkers = concurrency;

        for (let i = 0; i < concurrency; i++) {
            const worker = new Worker(path.join(__dirname, 'worker.mjs'));
            workers.push(worker);

            const dispatchNext = () => {
                if (nextStationIndex < totalCount) {
                    const taskIndex = nextStationIndex++;
                    const st = stationsToSimulate[taskIndex];
                    worker.postMessage({
                        type: 'compute',
                        taskId: taskIndex,
                        station: st,
                        radiusKm
                    });
                } else {
                    worker.terminate();
                    activeWorkers--;
                    if (activeWorkers === 0) {
                        resolve();
                    }
                }
            };

            worker.on('message', (msg) => {
                if (msg.type === 'ready') {
                    dispatchNext();
                } else if (msg.type === 'result') {
                    completedCount++;
                    mergeSignal(msg, compositeSignal);

                    const st = msg.station;
                    simulatedStationsMeta.push({
                        id: st.primary_node_id,
                        name: st.primary_name || st.primary_node_id,
                        role: st.role,
                        lat: Math.round(st.lat * 10000) / 10000,
                        lng: Math.round(st.lng * 10000) / 10000,
                        node_count: st.node_count
                    });

                    if (completedCount % 25 === 0 || completedCount === totalCount) {
                        const elapsed = (Date.now() - startTime) / 1000;
                        const pace = elapsed / completedCount;
                        const remaining = Math.round(pace * (totalCount - completedCount));
                        console.log(`  [${completedCount}/${totalCount}] (${((completedCount / totalCount) * 100).toFixed(1)}%) - 已耗時 ${elapsed.toFixed(0)}s (預估剩餘 ${remaining}s)`);
                    }

                    dispatchNext();
                } else if (msg.type === 'error') {
                    console.error(`⚠️ 站點模擬異常 (TaskId: ${msg.taskId}): ${msg.error}`);
                    completedCount++;
                    dispatchNext();
                } else if (msg.type === 'init_error') {
                    console.error('❌ Worker 初始化失敗:', msg.error);
                    reject(new Error(msg.error));
                }
            });

            worker.on('error', (err) => {
                console.error('❌ Worker 崩潰:', err);
                reject(err);
            });
        }
    });

    console.log(`🎨 正在將全島覆蓋訊號矩陣 (${CANVAS_WIDTH}x${CANVAS_HEIGHT}) 著色並編碼為 PNG...`);
    const rgbaBuffer = Buffer.alloc(CANVAS_WIDTH * CANVAS_HEIGHT * 4);
    let totalCoveredPixels = 0;

    for (let i = 0; i < compositeSignal.length; i++) {
        const val = compositeSignal[i];
        if (val >= 70) {
            totalCoveredPixels++;
            const [r, g, b, a] = colorizeRgba(val);
            const idx4 = i * 4;
            rgbaBuffer[idx4 + 0] = r;
            rgbaBuffer[idx4 + 1] = g;
            rgbaBuffer[idx4 + 2] = b;
            rgbaBuffer[idx4 + 3] = a;
        }
    }

    const png = encodeRgbaToPng(CANVAS_WIDTH, CANVAS_HEIGHT, rgbaBuffer);
    console.log(`📦 PNG 編碼完成！檔案大小: ${(png.length / 1024).toFixed(1)} KB，有效覆蓋像素: ${totalCoveredPixels}`);

    const metadata = {
        updated_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        station_count: simulatedStationsMeta.length,
        covered_pixels: totalCoveredPixels,
        bounds: [
            [TAIWAN_BBOX.south, TAIWAN_BBOX.west],
            [TAIWAN_BBOX.north, TAIWAN_BBOX.east]
        ],
        canvas_size: [CANVAS_WIDTH, CANVAS_HEIGHT],
        stations: simulatedStationsMeta
    };

    // 儲存至公共目錄供前端與 API 存取
    const outDirs = [
        path.join(__dirname, '../public/coverage'),
        path.join(__dirname, '../frontend/public/coverage')
    ];

    for (const d of outDirs) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'taiwan_coverage.png'), png);
        fs.writeFileSync(path.join(d, 'taiwan_coverage.json'), JSON.stringify(metadata, null, 2));
    }

    console.log(`🎉 [全台 RF 覆蓋圖層烘焙完成] 成功模擬 ${simulatedStationsMeta.length} 站！總耗時: ${((Date.now() - startTime) / 1000).toFixed(1)}s！`);
    return metadata;
}

// 支援命令列直接執行
if (process.argv[1] && process.argv[1].endsWith('bake.mjs')) {
    const limit = parseInt(process.argv[2], 10) || 500; // 預設 500 個站點
    runCoverageBake({ maxStations: limit }).catch(console.error);
}
