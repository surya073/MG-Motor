/**
 * requestCache.js
 * -----------------------------------------------------------------------
 * Tiny in-memory cache for read-only lists that several pages load on open
 * (the dealer list is fetched by the Dashboard, Integrations and Dealer CRM
 * pages). Concurrent callers share one request, and the result is reused
 * for a short time so moving between pages shows it instantly.
 *
 * axiosInstance clears everything on any write (POST/PUT/PATCH/DELETE), so a
 * change made in the app is never hidden behind a cached copy.
 */

const entries = new Map();

export function cachedRequest(key, ttlMs, load) {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && (hit.pending || now < hit.until)) return hit.promise;

  const promise = load();
  const entry = { promise, pending: true, until: 0 };
  entries.set(key, entry);
  promise.then(
    () => {
      entry.pending = false;
      entry.until = Date.now() + ttlMs;
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    }
  );
  return promise;
}

export function clearRequestCache() {
  entries.clear();
}
