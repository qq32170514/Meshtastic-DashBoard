import fs from 'fs';
import path from 'path';
import { parentPort } from 'worker_threads';
import { fileURLToPath } from 'url';
import createSplatModule from './splat_driver.mjs';
import { getTerrainPage } from './terrain.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let m = null;

async function init() {
    try {
        const wasmBinary = fs.readFileSync(path.join(__dirname, 'splat_driver.wasm'));
        m = await createSplatModule({ wasmBinary });
        parentPort.postMessage({ type: 'ready' });
    } catch (err) {
        parentPort.postMessage({ type: 'init_error', error: err.message });
    }
}

parentPort.on('message', async (task) => {
    if (task.type === 'compute') {
        const { taskId, station, radiusKm } = task;
        const lat = station.lat;
        const lon = station.lng;

        try {
            const handle = m._splat_create(
                lat, lon,
                33, 6, // 33ft (~10m) tx, 6ft (~2m) rx
                923.0,
                0.38,  // 0.38W ERP
                15.0, 0.005, 301.0, 5, 1, 0.5, 0.5, 0.0,
                radiusKm,
                1200
            );

            const pageCount = m._splat_page_count(handle);
            const outPtr = m._splat_malloc(8);
            for (let i = 0; i < pageCount; i++) {
                m._splat_page_info(handle, i, outPtr);
                const minNorth = m.HEAP32[outPtr >> 2];
                const minWest = m.HEAP32[(outPtr >> 2) + 1];

                const pageData = await getTerrainPage(minNorth, minWest, 1200);
                const bytes = new Uint8Array(pageData.buffer, pageData.byteOffset, pageData.byteLength);
                const dataPtr = m._splat_malloc(bytes.length);
                m.HEAPU8.set(bytes, dataPtr);
                m._splat_load_page(handle, i, dataPtr);
                m._splat_free(dataPtr);
            }
            m._splat_free(outPtr);

            const radialCount = m._splat_radial_count(handle);
            m._splat_run_radials(handle, 0, radialCount);
            m._splat_rasterize(handle);

            const regPtr = m._splat_malloc(64);
            m._splat_region_info(handle, regPtr);
            const base = regPtr >> 3;
            const width = Math.round(m.HEAPF64[base]);
            const height = Math.round(m.HEAPF64[base + 1]);
            const north = m.HEAPF64[base + 2];
            const south = m.HEAPF64[base + 3];
            const east = m.HEAPF64[base + 4];
            const west = m.HEAPF64[base + 5];

            const signalPtr = m._splat_signal_ptr(handle);
            const signalData = m.HEAPU8.slice(signalPtr, signalPtr + width * height);

            m._splat_free(regPtr);
            m._splat_destroy(handle);

            parentPort.postMessage({
                type: 'result',
                taskId,
                station,
                width,
                height,
                north,
                south,
                east,
                west,
                signalData
            }, [signalData.buffer]);
        } catch (err) {
            parentPort.postMessage({
                type: 'error',
                taskId,
                station,
                error: err.message
            });
        }
    }
});

init();
