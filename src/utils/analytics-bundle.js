/**
 * Bounded-concurrency Analytics Bundle fetcher with:
 * - Separate Cache TTL, Stale Fallback, and Maximum Stale Age (default 30m)
 * - Partial-failure protection (does not overwrite a valid complete cache)
 * - Immutable response copy when adding stale metadata
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

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PARTIAL_TTL_MS = 15 * 1000;
const DEFAULT_MAX_STALE_AGE_MS = 30 * 60 * 1000;

async function buildAnalyticsBundle({
    baseUrl,
    range = '7d',
    fetcher = fetch,
    concurrency = 4,
    cacheMap = {},
    ttlMs = DEFAULT_TTL_MS,
    partialTtlMs = DEFAULT_PARTIAL_TTL_MS,
    maxStaleAgeMs = DEFAULT_MAX_STALE_AGE_MS,
    now = Date.now()
} = {}) {
    const cached = cacheMap[range];
    const effectiveTtl = cached && cached.partialFailure ? partialTtlMs : ttlMs;
    if (cached && (now - cached.timestamp < effectiveTtl)) {
        return {
            status: 200,
            fromCache: true,
            staleFallback: false,
            partialFailure: Boolean(cached.partialFailure),
            data: cached.data
        };
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
            const staleAgeMs = Math.max(0, now - cached.timestamp);
            if (staleAgeMs <= maxStaleAgeMs) {
                // Return a safe shallow clone with updated _meta; never mutate cached.data
                const clonedPayload = {
                    ...cached.data,
                    _meta: {
                        ...(cached.data && cached.data._meta ? cached.data._meta : {}),
                        staleFallback: true,
                        partialFailure: true,
                        generatedAt: (cached.data && cached.data._meta && cached.data._meta.cachedAt) || new Date(cached.timestamp).toISOString(),
                        staleAgeMs
                    }
                };
                return {
                    status: 200,
                    fromCache: true,
                    staleFallback: true,
                    partialFailure: true,
                    staleAgeMs,
                    data: clonedPayload
                };
            }
            // Over maxStaleAgeMs: evict expired stale cache and return 503
            delete cacheMap[range];
            return {
                status: 503,
                fromCache: false,
                staleExpired: true,
                staleAgeMs,
                error: 'Analytics data unavailable: all sub-endpoints failed and cached data exceeded maximum stale age',
                failedEndpoints
            };
        }

        return {
            status: 503,
            fromCache: false,
            staleExpired: false,
            error: 'All analytics sub-endpoints failed',
            failedEndpoints
        };
    }

    const payload = {};
    for (const item of fetched) {
        payload[item.key] = item.data;
    }

    const partialFailure = failedEndpoints.length > 0;
    const generatedAt = new Date(now).toISOString();
    payload._meta = {
        partialFailure,
        staleFallback: false,
        failedEndpoints,
        successCount,
        totalCount,
        durationMs,
        generatedAt,
        cachedAt: generatedAt
    };

    // Never overwrite a still-within-maxStaleAge complete cache with a partial failure result
    const hasValidCompleteCache = Boolean(
        cached &&
        !cached.partialFailure &&
        (now - cached.timestamp <= maxStaleAgeMs)
    );
    if (!partialFailure || !hasValidCompleteCache) {
        cacheMap[range] = {
            data: payload,
            timestamp: now,
            partialFailure
        };
    }

    return {
        status: 200,
        fromCache: false,
        staleFallback: false,
        partialFailure,
        data: payload
    };
}

module.exports = {
    runWithConcurrency,
    BUNDLE_ENDPOINT_KEYS,
    DEFAULT_TTL_MS,
    DEFAULT_PARTIAL_TTL_MS,
    DEFAULT_MAX_STALE_AGE_MS,
    buildAnalyticsBundle
};
