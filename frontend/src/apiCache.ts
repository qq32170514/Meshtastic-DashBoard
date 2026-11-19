/**
 * 4.0.3.1 Frontend API Cache & In-Flight Request Deduplication
 * - Bounded LRU cache capacity with expired-entry pruning
 * - True AbortController cancellation passed to fetch()
 * - Subscriber ref-counting so one caller's abort does not cancel other shared callers
 */

interface CacheEntry<T = any> {
    data: T;
    expiresAt: number;
}

interface InFlightEntry<T = any> {
    controller: AbortController;
    activeSubscribers: number;
    promise: Promise<T>;
}

const DEFAULT_MAX_ENTRIES = 100;
let maxCacheEntries = DEFAULT_MAX_ENTRIES;

const responseCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, InFlightEntry>();

function createAbortError(): Error {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
}

export function pruneExpiredApiCache(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of responseCache.entries()) {
        if (entry.expiresAt <= now) {
            responseCache.delete(key);
            removed++;
        }
    }
    return removed;
}

export function setApiCacheEntry<T>(url: string, data: T, ttlMs: number, now: number = Date.now()): void {
    if (ttlMs <= 0 || maxCacheEntries <= 0) return;
    pruneExpiredApiCache(now);

    if (responseCache.has(url)) {
        responseCache.delete(url);
    } else {
        while (responseCache.size >= maxCacheEntries) {
            const oldestKey = responseCache.keys().next().value;
            if (oldestKey === undefined) break;
            responseCache.delete(oldestKey);
        }
    }

    responseCache.set(url, {
        data,
        expiresAt: now + ttlMs
    });
}

export function getApiCacheStats() {
    return {
        size: responseCache.size,
        inFlight: inFlightRequests.size,
        maxEntries: maxCacheEntries
    };
}

export function setApiCacheMaxEntries(limit: number): void {
    maxCacheEntries = Math.max(1, Math.floor(limit));
    while (responseCache.size > maxCacheEntries) {
        const oldestKey = responseCache.keys().next().value;
        if (oldestKey === undefined) break;
        responseCache.delete(oldestKey);
    }
}

export async function fetchJsonCached<T = any>(
    url: string,
    options: { ttlMs?: number; signal?: AbortSignal; force?: boolean; fetcher?: typeof fetch } = {}
): Promise<T> {
    const { ttlMs = 15000, signal, force = false, fetcher = fetch } = options;

    if (signal?.aborted) {
        throw createAbortError();
    }

    const now = Date.now();
    if (!force) {
        const cached = responseCache.get(url);
        if (cached) {
            if (cached.expiresAt > now) {
                // Refresh LRU order
                responseCache.delete(url);
                responseCache.set(url, cached);
                return cached.data as T;
            }
            responseCache.delete(url);
        }
    }

    let entry = !force ? inFlightRequests.get(url) : undefined;
    if (!entry) {
        const controller = new AbortController();
        const promise = (async () => {
            try {
                const res = await fetcher(url, { signal: controller.signal });
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status} for ${url}`);
                }
                const data = (await res.json()) as T;
                setApiCacheEntry(url, data, ttlMs);
                return data;
            } finally {
                if (inFlightRequests.get(url)?.controller === controller) {
                    inFlightRequests.delete(url);
                }
            }
        })();

        entry = { controller, activeSubscribers: 0, promise };
        inFlightRequests.set(url, entry);
    }

    entry.activeSubscribers += 1;

    if (!signal) {
        try {
            return await entry.promise;
        } finally {
            entry.activeSubscribers = Math.max(0, entry.activeSubscribers - 1);
        }
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;

        const onAbort = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            entry!.activeSubscribers = Math.max(0, entry!.activeSubscribers - 1);
            if (entry!.activeSubscribers === 0) {
                if (inFlightRequests.get(url) === entry) {
                    inFlightRequests.delete(url);
                }
                entry!.controller.abort();
            }
            reject(createAbortError());
        };

        signal.addEventListener('abort', onAbort, { once: true });

        entry!.promise.then(
            (data) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                entry!.activeSubscribers = Math.max(0, entry!.activeSubscribers - 1);
                resolve(data);
            },
            (err) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                entry!.activeSubscribers = Math.max(0, entry!.activeSubscribers - 1);
                reject(err);
            }
        );
    });
}

export function invalidateApiCache(prefix?: string) {
    if (!prefix) {
        responseCache.clear();
        return;
    }
    for (const key of responseCache.keys()) {
        if (key.startsWith(prefix)) {
            responseCache.delete(key);
        }
    }
}
