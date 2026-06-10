/**
 * Sliding-window rate limiter with URL cache awareness.
 * Successfully fetched URLs are stored in a Set; repeat requests for the same
 * URL are assumed to be served from the browser cache and don't count against
 * the rate limit.
 */
// Cap on the fetched-URL memo. Radar tile URLs are timestamped, so every
// ~5-10 min refresh adds a fresh batch of unique URLs forever — on the
// canonical wall-mounted-dashboard use case (a tab alive for weeks) the
// unbounded Set was a slow memory leak, and it also conflated "fetched
// once ever" with "still in the browser's HTTP cache". 1000 entries
// comfortably covers every URL whose tile could plausibly still be
// cached, at ~150 KB worst case.
const URL_CACHE_MAX = 1000;

export class RateLimiter {
  private _window: Array<{ time: number; url: string }> = [];
  private _cache = new Set<string>();

  constructor(private readonly _maxPerMinute: number) {}

  private _prune(): void {
    const cutoff = Date.now() - 60_000;
    while (this._window.length && this._window[0].time <= cutoff) {
      this._window.shift();
    }
  }

  canFetch(url: string): boolean {
    if (this._cache.has(url)) return true;
    this._prune();
    return this._window.length < this._maxPerMinute;
  }

  record(url: string): void {
    if (!this._cache.has(url)) {
      this._window.push({ time: Date.now(), url });
    }
  }

  recordSuccess(url: string): void {
    // Re-insert to refresh recency (Set preserves insertion order, so
    // the first entry is always the least recently confirmed).
    this._cache.delete(url);
    this._cache.add(url);
    if (this._cache.size > URL_CACHE_MAX) {
      const oldest = this._cache.values().next().value;
      if (oldest !== undefined) this._cache.delete(oldest);
    }
  }

  /** Milliseconds until the oldest window entry expires (plus 50ms buffer). */
  msUntilSlot(): number {
    this._prune();
    if (!this._window.length) return 0;
    return this._window[0].time + 60_000 - Date.now() + 50;
  }
}
