/**
 * Bounded-concurrency Analytics Bundle fetcher with partial-failure tracking
 * and short-TTL protection so incomplete bundles are not cached long-term.
 */

async function runWithConcurrency(items, concurrency, workerFn) {
    const limit = Math.max(1, Math.min(concurrency || 4, items.length || 1));
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const idx = nextIndex++;
            results[idx] = await workerFn(items[idx], idx);
        }
    }

    const workers = [];
    for (let i = 0; i < limit; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

const BUNDLE_ENDPOINT_KEYS = [
    { key: 'kpi', path: (range) => `/api/analytics/kpi?range=${encodeURIComponent(range)}` },
    { key: 'trends', path: (range) => `/api/analytics/trends?range=${encodeURIComponent(range)}` },
    { key: 'roles', path: () => '/api/analytics/roles' },
    { key: 'traffic', path: (range) => `/api/analytics/traffic?range=${encodeURIComponent(range)}` },
    { key: 'signalHealth', path: (range) => `/api/analytics/signal-health?range=${encodeURIComponent(range)}` },
    { key: 'hopDist', path: (range) => `/api/analytics/hop-distribution?range=${encodeURIComponent(range)}` },
    { key: 'hopAnalysis', path: () => '/api/analytics/hop-analysis' },
    { key: 'hourlyActivity', path: (range) => `/api/analytics/hourly-activity?range=${encodeURIComponent(range)}` },
    { key: 'hourlyStacked', path: () => '/api/analytics/hourly-peak-stacked' },
    { key: 'cuDist', path: () => '/api/analytics/cu-distribution' },
    { key: 'hwModels', path: () => '/api/analytics/hardware-models' },
    { key: 'firmwareVersions', path: () => '/api/analytics/firmware-versions' },
    { key: 'envTrends', path: (range) => `/api/analytics/environment-trends?range=${encodeURIComponent(range)}` },
    { key: 'cwaComparison', path: () => '/api/analytics/cwa-comparison' },
    { key: 'cwaNodeComparison', path: () => '/api/analytics/cwa-node-comparison' },
    { key: 'airUtilDist', path: () => '/api/analytics/air-util-distribution' },
    { key: 'topGateways', path: (range) => `/api/analytics/top-gateways?range=${encodeURIComponent(range)}` },
    { key: 'duplicateStats', path: () => '/api/analytics/duplicate-stats' },
    { key: 'powerHealth', path: () => '/api/analytics/power-health' },
    { key: 'meshInterconnectivity', path: () => '/api/analytics/mesh-interconnectivity' },
    { key: 'weakSignalAlerts', path: () => '/api/analytics/weak-signal-alerts' },
    { key: 'solarChargingHealth', path: () => '/api/analytics/solar-charging-health' },
    { key: 'countyWeatherTrends', path: () => '/api/analytics/county-weather-trends' }
];

async function buildAnalyticsBundle({
    baseUrl,
    range = '7d',
    fetcher = fetch,
    concurrency = 4,
    cacheMap = {},
    ttlMs = 10 * 60 * 1000,
    partialTtlMs = 15 * 1000,
    now = Date.now()
} = {}) {
    const cached = cacheMap[range];
    const effectiveTtl = cached && cached.partialFailure ? partialTtlMs : ttlMs;
    if (cached && (now - cached.timestamp < effectiveTtl)) {
        return { status: 200, fromCache: true, data: cached.data };
    }

    const startMs = Date.now();
    const failedEndpoints = [];

    const fetched = await runWithConcurrency(BUNDLE_ENDPOINT_KEYS, concurrency, async (spec) => {
        const ep = spec.path(range);
        try {
            const r = await fetcher(`${baseUrl}${ep}`);
            if (!r || !r.ok) {
                failedEndpoints.push({ key: spec.key, endpoint: ep, status: r ? r.status : 0 });
                return { key: spec.key, ok: false, data: null };
            }
            const json = await r.json();
            return { key: spec.key, ok: true, data: json };
        } catch (err) {
            failedEndpoints.push({ key: spec.key, endpoint: ep, error: err && err.message ? err.message : 'fetch_error' });
            return { key: spec.key, ok: false, data: null };
        }
    });

    const successCount = fetched.filter((x) => x.ok).length;
    const totalCount = fetched.length;
    const durationMs = Date.now() - startMs;

    if (successCount === 0) {
        if (cached) {
            return { status: 200, fromCache: true, staleFallback: true, data: cached.data };
        }
        return {
            status: 502,
            fromCache: false,
            error: 'All analytics sub-endpoints failed',
            failedEndpoints
        };
    }

    const payload = {};
    for (const item of fetched) {
        payload[item.key] = item.data;
    }

    const partialFailure = failedEndpoints.length > 0;
    payload._meta = {
        partialFailure,
        failedEndpoints,
        successCount,
        totalCount,
        durationMs,
        cachedAt: new Date(now).toISOString()
    };

    cacheMap[range] = {
        data: payload,
        timestamp: now,
        partialFailure
    };

    return {
        status: 200,
        fromCache: false,
        partialFailure,
        data: payload
    };
}

module.exports = {
    runWithConcurrency,
    BUNDLE_ENDPOINT_KEYS,
    buildAnalyticsBundle
};

