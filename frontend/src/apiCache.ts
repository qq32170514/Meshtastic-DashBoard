// frontend/src/apiCache.ts
// Lightweight TTL + in-flight deduplication cache for GET JSON APIs.
// Keyed by full request URL (including query parameters) so different filters/pages never collide.

interface CacheEntry<T = any> {
  data: T;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<any>>();

export async function fetchJsonCached<T = any>(
  url: string,
  options: {
    ttlMs?: number;
    signal?: AbortSignal;
    force?: boolean;
  } = {}
): Promise<T> {
  const { ttlMs = 0, signal, force = false } = options;
  const now = Date.now();

  if (!force && ttlMs > 0) {
    const cached = responseCache.get(url);
    if (cached && cached.expiresAt > now) {
      return cached.data as T;
    }
  }

  // Deduplicate identical concurrent GET requests when no caller-specific abort signal is attached,
  // or attach an abort race so cancelling one caller does not break another.
  let sharedPromise = !force ? inFlightRequests.get(url) : undefined;
  if (!sharedPromise) {
    sharedPromise = fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        const data = await res.json();
        if (ttlMs > 0) {
          responseCache.set(url, { data, expiresAt: Date.now() + ttlMs });
        }
        return data;
      })
      .finally(() => {
        if (inFlightRequests.get(url) === sharedPromise) {
          inFlightRequests.delete(url);
        }
      });
    inFlightRequests.set(url, sharedPromise);
  }

  if (!signal) {
    return sharedPromise as Promise<T>;
  }

  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    sharedPromise!.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) resolve(val as T);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) reject(err);
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

