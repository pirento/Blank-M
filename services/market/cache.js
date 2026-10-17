/**
 * Small in-process TTL cache.
 *
 * Both providers rate limit, and the watchlist fetches one quote per row on
 * every page load, so without this a ten-row watchlist can trip a 429 on a
 * single render. Each server process keeps its own copy (PM2 cluster workers
 * do not share it), which is fine: the cache is an optimisation, never a
 * correctness requirement.
 */

const store = new Map();
const MAX_ENTRIES = 500;

/**
 * The cached value for `key`, or undefined when absent or expired (expired entries are dropped).
 */
export function cacheGet(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

/** Caches a value for `ttlMs`, evicting the oldest-inserted entry once 500 are stored. */
export function cacheSet(key, value, ttlMs) {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export const QUOTE_TTL_MS = 30_000;
export const HISTORY_TTL_MS = 10 * 60_000;
