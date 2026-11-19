const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
    BUNDLE_ENDPOINT_KEYS,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_STALE_AGE_MS,
    buildAnalyticsBundle
} = require('../../src/utils/analytics-bundle');
const { computeHopAnalysis } = require('../../src/utils/hop-analysis');
const { normalizeCacheKey } = require('../../src/utils/api-cache');

function invokeExpress(app, { method = 'GET', url = '/' }) {
    return new Promise((resolve, reject) => {
        const headers = {};
        let statusCode = 200;
        let finished = false;
        const parsed = new URL(url, 'http://localhost');
        const req = {
            method,
            url,
            originalUrl: url,
            path: parsed.pathname,
            query: Object.fromEntries(parsed.searchParams.entries()),
            headers: {},
            get(n) { return this.headers[String(n).toLowerCase()]; }
        };
        const res = {
            statusCode: 200,
            setHeader(n, v) { headers[String(n).toLowerCase()] = v; },
            status(c) { statusCode = c; this.statusCode = c; return this; },
            json(p) { if (!finished) { finished = true; resolve({ statusCode, headers, body: p }); } return this; }
        };
        app.handle(req, res, (err) => {
            if (err) return reject(err);
            if (!finished) { finished = true; resolve({ statusCode: 404, headers, body: null }); }
        });
    });
}

test('Stage 4.1: Analytics Bundle enforces TTL, Stale Fallback within maxStaleAgeMs, and rejects 24h-old stale cache with 503', async () => {
    const cacheMap = {};
    const okFetcher = async () => ({ ok: true, status: 200, async json() { return { ok: true }; } });
    const failAllFetcher = async () => ({ ok: false, status: 503 });

    const t0 = 1_000_000;
    const initial = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '7d',
        fetcher: okFetcher,
        cacheMap,
        now: t0
    });
    assert.equal(initial.status, 200);
    assert.equal(initial.staleFallback, false);

    // Within TTL (t0 + 5m) -> normal cache hit
    const withinTtl = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '7d',
        fetcher: failAllFetcher,
        cacheMap,
        now: t0 + 5 * 60 * 1000
    });
    assert.equal(withinTtl.status, 200);
    assert.equal(withinTtl.fromCache, true);
    assert.equal(withinTtl.staleFallback, false);

    // Just past TTL (t0 + 12m), within 30m maxStaleAgeMs, all APIs fail -> stale fallback with metadata
    const staleOk = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '7d',
        fetcher: failAllFetcher,
        cacheMap,
        now: t0 + DEFAULT_TTL_MS + 2 * 60 * 1000
    });
    assert.equal(staleOk.status, 200);
    assert.equal(staleOk.staleFallback, true);
    assert.equal(staleOk.data._meta.staleFallback, true);
    assert.equal(staleOk.data._meta.staleAgeMs, DEFAULT_TTL_MS + 2 * 60 * 1000);
    // Original cached object must NOT be mutated
    assert.equal(cacheMap['7d'].data._meta.staleFallback, false);

    // Partial failure while complete cache is within maxStaleAgeMs must NOT overwrite complete cache
    let callCount = 0;
    const partialFetcher = async () => {
        callCount++;
        if (callCount === 1) return { ok: false, status: 500 };
        return { ok: true, status: 200, async json() { return { partial: true }; } };
    };
    const partialRes = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '7d',
        fetcher: partialFetcher,
        cacheMap,
        now: t0 + DEFAULT_TTL_MS + 3 * 60 * 1000
    });
    assert.equal(partialRes.partialFailure, true);
    assert.equal(cacheMap['7d'].partialFailure, false, 'Partial result must not overwrite complete cache');

    // 24 hours later -> exceeds maxStaleAgeMs -> MUST NOT return HTTP 200 stale data!
    const expired24h = await buildAnalyticsBundle({
        baseUrl: 'http://127.0.0.1:3000',
        range: '7d',
        fetcher: failAllFetcher,
        cacheMap,
        now: t0 + 24 * 60 * 60 * 1000
    });
    assert.equal(expired24h.status, 503);
    assert.equal(expired24h.staleExpired, true);
    assert.ok(expired24h.staleAgeMs > DEFAULT_MAX_STALE_AGE_MS);
    assert.equal(cacheMap['7d'], undefined);
});

test('Stage 4.2: Hop Analysis SQL errors return 500 and never produce false healthy diagnosis', async () => {
    const app = express();
    let mockDb;
    app.get('/api/analytics/hop-analysis', (req, res) => {
        computeHopAnalysis(mockDb, (err, payload) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json(payload);
        });
    });

    // 1. Both succeed
    mockDb = {
        all(sql, params, cb) {
            if (sql.includes('packet_logs')) return cb(null, [{ hop: 1, count: 10 }]);
            return cb(null, [{ hop: 3, count: 5 }]);
        }
    };
    const okRes = await invokeExpress(app, { url: '/api/analytics/hop-analysis' });
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.body.avgActualHops, 1);
    assert.equal(okRes.body.avgConfiguredHops, 3);

    // 2. sqlActual fails
    mockDb = {
        all(sql, params, cb) {
            if (sql.includes('packet_logs')) return cb(new Error('SQLITE_CORRUPT: packet_logs'));
            return cb(null, []);
        }
    };
    const errActual = await invokeExpress(app, { url: '/api/analytics/hop-analysis' });
    assert.equal(errActual.statusCode, 500);
    assert.equal(errActual.body.recommendation, undefined);

    // 3. sqlConfigured fails
    mockDb = {
        all(sql, params, cb) {
            if (sql.includes('packet_logs')) return cb(null, [{ hop: 1, count: 10 }]);
            return cb(new Error('SQLITE_ERROR: nodes failed'));
        }
    };
    const errConfigured = await invokeExpress(app, { url: '/api/analytics/hop-analysis' });
    assert.equal(errConfigured.statusCode, 500);
    assert.equal(errConfigured.body.recommendation, undefined);
});

test('Stage 5.1: API Cache preserves repeated query param order by default while canonicalizing confirmed set params', () => {
    const sortAscDesc = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sort=timestamp&sort=snr' });
    const sortDescAsc = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sort=snr&sort=timestamp' });
    assert.notEqual(sortAscDesc, sortDescAsc, 'Repeated ordered params like sort must not share cache');

    const unknownOrder1 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?filter=a&filter=b' });
    const unknownOrder2 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?filter=b&filter=a' });
    assert.notEqual(unknownOrder1, unknownOrder2, 'Unknown repeated params must preserve order');

    const set1 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!2&node_ids=!1' });
    const set2 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!1&node_ids=!2' });
    assert.equal(set1, set2, 'Confirmed set param node_ids may share canonicalized cache key');
});

