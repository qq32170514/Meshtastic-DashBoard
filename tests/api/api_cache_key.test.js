const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { BoundedLRUCache, normalizeCacheKey, createWithCache } = require('../../src/utils/api-cache');

function invokeExpress(app, { method = 'GET', url = '/' }) {
    return new Promise((resolve, reject) => {
        const headers = {};
        let statusCode = 200;
        let finished = false;

        const parsed = new URL(url, 'http://localhost');
        const query = {};
        for (const [k, v] of parsed.searchParams.entries()) {
            if (Object.prototype.hasOwnProperty.call(query, k)) {
                query[k] = Array.isArray(query[k]) ? [...query[k], v] : [query[k], v];
            } else {
                query[k] = v;
            }
        }

        const req = {
            method,
            url,
            originalUrl: url,
            path: parsed.pathname,
            query,
            headers: {},
            get(name) {
                return this.headers[String(name).toLowerCase()];
            }
        };

        const res = {
            statusCode: 200,
            setHeader(name, val) {
                headers[String(name).toLowerCase()] = val;
            },
            getHeader(name) {
                return headers[String(name).toLowerCase()];
            },
            status(code) {
                statusCode = code;
                this.statusCode = code;
                return this;
            },
            json(payload) {
                if (finished) return this;
                finished = true;
                resolve({ statusCode, headers, body: payload });
                return this;
            },
            send(payload) {
                if (finished) return this;
                finished = true;
                resolve({ statusCode, headers, body: payload });
                return this;
            }
        };

        // Run Express router directly without opening a TCP socket
        app.handle(req, res, (err) => {
            if (err) return reject(err);
            if (!finished) {
                finished = true;
                resolve({ statusCode: 404, headers, body: null });
            }
        });
    });
}

test('Phase 1.1: normalizeCacheKey preserves all filter params (sender, node_ids, timeStart, timeEnd, minSnr, minRssi, unknown)', () => {
    const keys = [
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sender=!1111' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sender=!2222' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!1111,!2222' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!1111' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?timeStart=2026-01-01&timeEnd=2026-01-02' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?timeStart=2026-01-03&timeEnd=2026-01-04' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?minSnr=-5&minRssi=-110' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?minSnr=2&minRssi=-90' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?unknownParam=alpha' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?unknownParam=beta' }),
        normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets' })
    ];

    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, keys.length, 'Every distinct query param combination must produce a unique cache key');
});

test('Phase 1.2: normalizeCacheKey canonicalizes param order, repeated params, URL encoding, and trailing slashes', () => {
    const k1 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets/?b=2&a=1' });
    const k2 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?a=1&b=2' });
    assert.equal(k1, k2);

    const enc1 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sender=%21abcd' });
    const enc2 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sender=!abcd' });
    assert.equal(enc1, enc2);

    const multi1 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!z&node_ids=!a' });
    const multi2 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!a&node_ids=!z' });
    const multiSingle = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?node_ids=!a' });
    assert.equal(multi1, multi2);
    assert.notEqual(multi1, multiSingle);

    const ordered1 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sort=timestamp&sort=snr' });
    const ordered2 = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sort=snr&sort=timestamp' });
    assert.notEqual(ordered1, ordered2);

    const emptyParam = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets?sender=' });
    const noParam = normalizeCacheKey({ method: 'GET', originalUrl: '/api/packets' });
    assert.notEqual(emptyParam, noParam);
});

test('Phase 1.3: BoundedLRUCache clearPrefix works with METHOD-prefixed keys', () => {
    const cache = new BoundedLRUCache(50);
    cache.set('GET:/api/packets?sender=a', { ok: 1 }, 60000);
    cache.set('GET:/api/nodes', { ok: 2 }, 60000);

    cache.clearPrefix('/api/packets');
    assert.equal(cache.get('GET:/api/packets?sender=a'), null);
    assert.deepEqual(cache.get('GET:/api/nodes'), { ok: 2 });
});

test('Phase 1.4: Express A -> B -> A integration verifies zero cross-query cache contamination', async () => {
    const cache = new BoundedLRUCache(50);
    const withCache = createWithCache(cache);
    let dbHits = 0;

    const app = express();
    app.get('/api/packets', withCache(60000), (req, res) => {
        dbHits++;
        res.json({
            sender: req.query.sender || null,
            minSnr: req.query.minSnr || null,
            timeStart: req.query.timeStart || null,
            dbHits
        });
    });

    // Request A
    const resA1 = await invokeExpress(app, { url: '/api/packets?sender=nodeA&minSnr=-5&timeStart=t1' });
    assert.equal(resA1.headers['x-cache'], 'MISS');
    assert.equal(resA1.body.sender, 'nodeA');

    // Request B (different sender, minSnr, timeStart)
    const resB = await invokeExpress(app, { url: '/api/packets?sender=nodeB&minSnr=3&timeStart=t2' });
    assert.equal(resB.headers['x-cache'], 'MISS');
    assert.equal(resB.body.sender, 'nodeB');
    assert.equal(resB.body.minSnr, '3');

    // Request A again (different param order) -> HIT with nodeA's exact payload
    const resA2 = await invokeExpress(app, { url: '/api/packets?timeStart=t1&minSnr=-5&sender=nodeA' });
    assert.equal(resA2.headers['x-cache'], 'HIT');
    assert.equal(resA2.body.sender, 'nodeA');
    assert.equal(resA2.body.minSnr, '-5');
    assert.equal(dbHits, 2);
});
