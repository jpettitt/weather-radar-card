// Frame and run listings gate the radar's init and its update chain: a
// request the server accepts and never answers would hold the map blank and
// stop all later refreshes, so each listing gives up after a limit. Measured
// 2026-10-26: the NOAA and RainViewer listings answer in 0.2–1.2 s (8 KB / 1 KB).
export const LISTING_TIMEOUT_MS = 10_000;
// Overlay data has no other way out of a request that never answers either:
// the alerts and wildfire refresh chains await it, and a hung InciWeb check
// stayed cached as the fire's lookup. Measured 2026-10-26 (3 runs each): NWS
// alerts list 0.3-0.5 s (108 KB), a zone 0.2-0.3 s, WFIGS attributes
// 0.4-0.5 s, outlines 1.7-2.6 s (116 KB), InciWeb 0.3-1.3 s.
export const DATA_TIMEOUT_MS = 30_000;
// A cold DWD wind request took 12.8 s for a 10° x 15° box (then ~1 s), and
// a whole-world request is larger.
export const WIND_TIMEOUT_MS = 60_000;

/** Rejection of {@link withTimeout} when the limit ran out (not an AbortError, which callers read as "superseded"). */
export class ListingTimeoutError extends Error {
  constructor(ms: number) {
    super(`request took longer than ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Run `request` (fetch and body read) with a signal that aborts after `ms`
 * or when `signal` aborts. The limit rejects with ListingTimeoutError even if
 * the request ignores the abort; a caller's abort keeps its AbortError.
 */
export async function withTimeout<T>(
  ms: number, signal: AbortSignal | null | undefined, request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // setTimeout rather than AbortSignal.timeout(): older tablet WebViews lack it.
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    // Reject before aborting, so the race settles on the timeout and not on
    // the AbortError the abort raises in the request.
    timer = setTimeout(() => { reject(new ListingTimeoutError(ms)); ctrl.abort(); }, ms);
  });
  try {
    return await Promise.race([request(ctrl.signal), limit]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
