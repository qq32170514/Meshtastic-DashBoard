/**
 * Bounded LRU API response cache & canonical cache-key builder.
 * Shared by index.js and automated reliability tests.
 */

class BoundedLRUCache {
    constructor(maxEntries = 300) {
        this.maxEntries = maxEntries;
        this.cache = new Map();
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiredAt) {
            this.cache.delete(key);
            return null;
        }
        // Refresh LRU position
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.data;
    }

    set(key, data, ttlMs) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, { data, expiredAt: Date.now() + ttlMs });
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clearPrefix(prefix) {
        for (const key of this.cache.keys()) {
            const pathPart = key.replace(/^[A-Z]+:/, '');
            if (key.startsWith(prefix) || pathPart.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }

    pruneExpired() {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expiredAt) {
                this.cache.delete(key);
            }
        }
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }
}

const DEFAULT_UNORDERED_SET_PARAMS = new Set(['node_ids']);

/**
 * Normalize an Express request into a canonical cache key:
 * `<METHOD>:<normalizedPath>?<canonicalQuery>`
 *
 * Preserves ALL query parameters and preserves repeated-parameter value order
 * by default (e.g. `?sort=timestamp&sort=snr` !== `?sort=snr&sort=timestamp`),
 * only sorting values for explicitly confirmed set-type parameters.
 */
function normalizeCacheKey(req, options = {}) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    const rawUrl = (req && (req.originalUrl || req.url)) || '/';
    const unorderedSetParams = options.unorderedSetParams || DEFAULT_UNORDERED_SET_PARAMS;

    let url;
    try {
        url = new URL(rawUrl, 'http://localhost');
    } catch (_) {
        const safeRaw = String(rawUrl).split('#')[0];
        return `${method}:${safeRaw}`;
    }

    let pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (pathname.length > 1) {
        pathname = pathname.replace(/\/+$/, '');
    }

    const grouped = new Map();
    for (const [key, value] of url.searchParams.entries()) {
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(value);
    }

    const canonicalParams = new URLSearchParams();
    const sortedKeys = Array.from(grouped.keys()).sort();
    for (const key of sortedKeys) {
        const rawValues = grouped.get(key);
        const finalValues = unorderedSetParams.has(key) ? rawValues.slice().sort() : rawValues;
        for (const val of finalValues) {
            canonicalParams.append(key, val);
        }
    }

    const qs = canonicalParams.toString();
    return qs ? `${method}:${pathname}?${qs}` : `${method}:${pathname}`;
}

/**
 * Create a `withCache(ttlMs)` Express middleware bound to a BoundedLRUCache instance.
 */
function createWithCache(apiCache) {
    return function withCache(ttlMs = 10 * 1000) {
        return (req, res, next) => {
            const method = String(req.method || 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') {
                return next();
            }

            const key = normalizeCacheKey(req);
            const cachedData = apiCache.get(key);
            if (cachedData !== null && cachedData !== undefined) {
                res.setHeader('X-Cache', 'HIT');
                return res.json(cachedData);
            }

            const origJson = res.json.bind(res);
            res.json = (data) => {
                if (res.statusCode >= 200 && res.statusCode < 300 && data !== undefined) {
                    apiCache.set(key, data, ttlMs);
                }
                res.setHeader('X-Cache', 'MISS');
                return origJson(data);
            };
            next();
        };
    };
}

module.exports = {
    BoundedLRUCache,
    normalizeCacheKey,
    createWithCache
};

