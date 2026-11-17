const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BUNDLE_ENDPOINT_KEYS, buildAnalyticsBundle } = require('../../src/utils/analytics-bundle');

test('Phase 3.1: index.js and NetworkAnalytics.tsx separate /api/analytics/hop-distribution and /api/analytics/hop-analysis', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const hopDistRoutes = indexSrc.match(/app\.get\(['"]\/api\/analytics\/hop-distribution['"]/g) || [];
    const hopAnalysisRoutes = indexSrc.match(/app\.get\(['"]\/api\/analytics\/hop-analysis['"]/g) || [];

    assert.equal(hopDistRoutes.length, 1, 'Expected exactly one /api/analytics/hop-distribution route');
    assert.equal(hopAnalysisRoutes.length, 1, 'Expected exactly one /api/analytics/hop-analysis route');

    const networkAnalyticsSrc = fs.readFileSync(
        path.join(__dirname, '../../frontend/src/NetworkAnalytics.tsx'),
        'utf8'
    );
    assert.ok(
        networkAnalyticsSrc.includes("'/api/analytics/hop-analysis'"),
        'NetworkAnalytics.tsx fallback must call /api/analytics/hop-analysis'
    );

    const hopDistSpec = BUNDLE_ENDPOINT_KEYS.find((e) => e.key === 'hopDist');
    const hopAnalysisSpec = BUNDLE_ENDPOINT_KEYS.find((e) => e.key === 'hopAnalysis');
    assert.equal(hopDistSpec.path('7d'), '/api/analytics/hop-distribution?range=7d');
    assert.equal(hopAnalysisSpec.path('7d'), '/api/analytics/hop-analysis');
});

test('Phase 4.1: buildAnalyticsBundle enforces bounded concurrency and distinguishes complete vs partial vs total failure', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fullFetcher = async (url) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return {
            ok: true,
            status: 200,
            async json() {
                return { endpoint: url };
            }
        };
    };

    const cacheMap = {};
    const fullRes = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '7d',
        fetcher: fullFetcher,
        concurrency: 4,
        cacheMap,
        now: 1000
    });

    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.partialFailure, false);
    assert.equal(fullRes.data._meta.partialFailure, false);
    assert.equal(fullRes.data._meta.successCount, BUNDLE_ENDPOINT_KEYS.length);
    assert.ok(maxInFlight <= 4 && maxInFlight >= 2, `Expected bounded concurrency <= 4, saw ${maxInFlight}`);

    // Partial failure: 2 endpoints fail -> short partialTtlMs (15s) instead of 10m
    const partialCacheMap = {};
    const partialFetcher = async (url) => {
        if (url.includes('hop-analysis') || url.includes('weak-signal-alerts')) {
            return { ok: false, status: 500, async json() { return {}; } };
        }
        return { ok: true, status: 200, async json() { return { ok: true }; } };
    };

    const partialRes = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '24h',
        fetcher: partialFetcher,
        concurrency: 4,
        cacheMap: partialCacheMap,
        ttlMs: 600000,
        partialTtlMs: 15000,
        now: 10000
    });
    assert.equal(partialRes.status, 200);
    assert.equal(partialRes.partialFailure, true);
    assert.equal(partialRes.data._meta.failedEndpoints.length, 2);

    // Within 15s -> served from short cache
    const cachedPartial = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '24h',
        fetcher: fullFetcher,
        cacheMap: partialCacheMap,
        ttlMs: 600000,
        partialTtlMs: 15000,
        now: 20000
    });
    assert.equal(cachedPartial.fromCache, true);

    // After 15s -> cache expired, re-fetches and heals to full bundle
    const healed = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '24h',
        fetcher: fullFetcher,
        cacheMap: partialCacheMap,
        ttlMs: 600000,
        partialTtlMs: 15000,
        now: 30000
    });
    assert.equal(healed.fromCache, false);
    assert.equal(healed.partialFailure, false);

    // Total failure with empty cache -> 502
    const totalFail = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '30d',
        fetcher: async () => ({ ok: false, status: 503 }),
        cacheMap: {},
        now: 40000
    });
    assert.equal(totalFail.status, 502);
});

test('Phase 4.2: frontend/src/apiCache.ts bounds capacity, prunes expired entries, and ref-counts AbortSignal', async () => {
    const apiCacheMod = await import('../../frontend/src/apiCache.ts');
    const {
        fetchJsonCached,
        invalidateApiCache,
        setApiCacheMaxEntries,
        getApiCacheStats,
        pruneExpiredApiCache
    } = apiCacheMod;

    invalidateApiCache();
    setApiCacheMaxEntries(2);

    const okFetcher = async (url) => ({
        ok: true,
        status: 200,
        async json() {
            return { url };
        }
    });

    await fetchJsonCached('/api/one', { ttlMs: 60000, fetcher: okFetcher });
    await fetchJsonCached('/api/two', { ttlMs: 60000, fetcher: okFetcher });
    await fetchJsonCached('/api/three', { ttlMs: 60000, fetcher: okFetcher });
    assert.equal(getApiCacheStats().size, 2, 'Cache size must be bounded by maxEntries=2');

    // Subscriber 1 aborts, Subscriber 2 continues -> underlying fetch NOT aborted
    let underlyingAborted = false;
    const slowFetcher = (url, init) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            resolve({
                ok: true,
                status: 200,
                async json() { return { shared: true }; }
            });
        }, 60);
        init.signal.addEventListener('abort', () => {
            underlyingAborted = true;
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        });
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = fetchJsonCached('/api/shared', { signal: ac1.signal, fetcher: slowFetcher });
    const p2 = fetchJsonCached('/api/shared', { signal: ac2.signal, fetcher: slowFetcher });

    ac1.abort();
    await assert.rejects(p1, (e) => e.name === 'AbortError');
    const res2 = await p2;
    assert.deepEqual(res2, { shared: true });
    assert.equal(underlyingAborted, false, 'Underlying fetch must NOT abort while another subscriber is active');

    // All subscribers abort -> underlying fetch MUST abort and clean inFlight
    invalidateApiCache();
    underlyingAborted = false;
    const acOnly = new AbortController();
    const pOnly = fetchJsonCached('/api/cancel-me', { signal: acOnly.signal, fetcher: slowFetcher });
    acOnly.abort();
    await assert.rejects(pOnly, (e) => e.name === 'AbortError');
    assert.equal(underlyingAborted, true, 'Underlying fetch MUST abort when last subscriber aborts');
    assert.equal(getApiCacheStats().inFlight, 0);

    // Expired entry pruning
    await fetchJsonCached('/api/short-lived', { ttlMs: 10, fetcher: okFetcher });
    await new Promise((r) => setTimeout(r, 25));
    const pruned = pruneExpiredApiCache();
    assert.ok(pruned >= 1);
    setApiCacheMaxEntries(100);
});

