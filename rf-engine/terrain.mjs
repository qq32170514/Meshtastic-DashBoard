import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HGT_SIZE = 3601;
export const DOWNSAMPLED_SIZE = 1201;
export const PAGE_SIZE = 1200;
export const SRTM_NODATA = -32768;

const CACHE_DIR = path.join(__dirname, 'terrain_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function pageSignedFloorLon(minWest) {
    return minWest < 180 ? -(minWest + 1) : 359 - minWest;
}

export function tileNameForPage(minNorth, minWest) {
    const lat = minNorth;
    const lon = pageSignedFloorLon(minWest);
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    const alat = String(Math.abs(lat)).padStart(2, '0');
    const alon = String(Math.abs(lon)).padStart(3, '0');
    return `${ns}${alat}${ew}${alon}`;
}

export function parseHgt(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cells = HGT_SIZE * HGT_SIZE;
    if (view.byteLength < cells * 2) {
        throw new Error(`hgt too small: ${view.byteLength} bytes`);
    }
    const out = new Int16Array(cells);
    for (let i = 0; i < cells; i++) {
        out[i] = view.getInt16(i * 2, false); // big-endian
    }
    return out;
}

export function downsampleAverage(src, srcSize = HGT_SIZE, dstSize = DOWNSAMPLED_SIZE, nodata = SRTM_NODATA) {
    const ratio = srcSize / dstSize;
    const out = new Int16Array(dstSize * dstSize);
    const lo = new Int32Array(dstSize);
    const hi = new Int32Array(dstSize);
    const loW = new Float64Array(dstSize);
    const hiW = new Float64Array(dstSize);

    for (let d = 0; d < dstSize; d++) {
        const start = d * ratio;
        const end = (d + 1) * ratio;
        let s = Math.floor(start);
        let e = Math.ceil(end);
        if (e > srcSize) e = srcSize;
        lo[d] = s;
        hi[d] = e;
        loW[d] = Math.min(s + 1, end) - start;
        hiW[d] = end - Math.max(e - 1, start);
    }

    for (let j = 0; j < dstSize; j++) {
        for (let i = 0; i < dstSize; i++) {
            let total = 0;
            let weight = 0;
            for (let y = lo[j]; y < hi[j]; y++) {
                const wy = y === lo[j] ? loW[j] : y === hi[j] - 1 ? hiW[j] : 1;
                const row = y * srcSize;
                for (let x = lo[i]; x < hi[i]; x++) {
                    const v = src[row + x];
                    if (v === nodata) continue;
                    const wx = x === lo[i] ? loW[i] : x === hi[i] - 1 ? hiW[i] : 1;
                    const w = wx * wy;
                    total += v * w;
                    weight += w;
                }
            }
            if (weight === 0) {
                out[j * dstSize + i] = nodata;
            } else {
                const v = total / weight;
                out[j * dstSize + i] = v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
            }
        }
    }
    return out;
}

export function srtm2sdfTransform(grid, pageSize = PAGE_SIZE) {
    const n = pageSize + 1;
    const mpi = pageSize - 1;
    const minElevation = 0;
    const srtm = Int32Array.from(grid);

    for (let i = 0; i < srtm.length; i++) {
        if (srtm[i] < -32768) srtm[i] = -32768;
        if (srtm[i] > 32767) srtm[i] = 32767;
    }
    const at = (y, x) => srtm[y * n + x];

    const averageTerrain = (y, x) => {
        const badValue = at(y, x);
        let accum = 0;
        let count = 0;
        let temp = 0;
        const consider = (yy, xx) => {
            temp = at(yy, xx);
            if (temp > badValue) {
                accum += temp;
                count++;
            }
        };
        if (y >= 2) consider(y - 1, x);
        if (y <= mpi) consider(y + 1, x);
        if (y >= 2 && x <= mpi - 1) consider(y - 1, x + 1);
        if (x <= mpi - 1) consider(y, x + 1);
        if (x <= mpi - 1 && y <= mpi) consider(y + 1, x + 1);
        if (x >= 1 && y >= 2) consider(y - 1, x - 1);
        if (x >= 1) consider(y, x - 1);
        if (y <= mpi && x >= 1) consider(y + 1, x - 1);
        if (count !== 0) {
            const average = accum / count;
            temp = Math.trunc(average + 0.5);
        }
        srtm[y * n + x] = temp > minElevation ? temp : minElevation;
    };

    const out = new Int16Array(pageSize * pageSize);
    let k = 0;
    for (let y = pageSize; y >= 1; y--) {
        for (let x = mpi; x >= 0; x--) {
            const byte = at(y, x);
            if (byte < minElevation) {
                averageTerrain(y, x);
                out[k++] = at(y, x);
            } else {
                out[k++] = byte;
            }
        }
    }
    return out;
}

async function fetchBufferWithRetry(url, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const req = https.get(url, { timeout: 10000 }, res => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        return fetchBufferWithRetry(res.headers.location, retries).then(resolve).catch(reject);
                    }
                    if (res.statusCode === 404) {
                        return resolve(null);
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Failed ${url}: status ${res.statusCode}`));
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                });
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.on('error', reject);
            });
        } catch (err) {
            if (attempt === retries) {
                console.warn(`⚠️ 切片下載失敗 (${url}): ${err.message}，將降級為海平面 (0m)`);
                return null;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return null;
}

export async function getTerrainPage(minNorth, minWest, ippd = 1200) {
    const tileName = tileNameForPage(minNorth, minWest);
    const cacheFile = path.join(CACHE_DIR, `${tileName}_${ippd}.bin`);

    if (fs.existsSync(cacheFile)) {
        const buf = fs.readFileSync(cacheFile);
        return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    }

    const dir = tileName.slice(0, 3);
    const url = `https://elevation-tiles-prod.s3.amazonaws.com/v2/skadi/${dir}/${tileName}.hgt.gz`;
    console.log(`🌐 正在獲取地形切片: ${tileName} (${url})...`);

    const gzBuf = await fetchBufferWithRetry(url);
    if (!gzBuf) {
        // Open ocean or missing tile -> Sea level (0m)
        console.log(`🌊 切片 ${tileName} 為開闊海洋/無陸地，填入海平面 (0m)`);
        const zeroPage = new Int16Array(PAGE_SIZE * PAGE_SIZE);
        fs.writeFileSync(cacheFile, Buffer.from(zeroPage.buffer));
        return zeroPage;
    }

    console.log(`📦 解壓縮並重抽樣 ${tileName} (${gzBuf.length} bytes)...`);
    const hgtBuf = zlib.gunzipSync(gzBuf);
    const full = parseHgt(hgtBuf);
    const processed = srtm2sdfTransform(downsampleAverage(full), PAGE_SIZE);

    fs.writeFileSync(cacheFile, Buffer.from(processed.buffer));
    console.log(`✅ 切片 ${tileName} 處理完成並存入快取！`);
    return processed;
}
