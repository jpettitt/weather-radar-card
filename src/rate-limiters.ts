// Per-radar-source rate limiters. Instantiated as MODULE-LEVEL singletons
// so that:
//   1. The sliding-window counter survives card teardown / re-init when
//      the user edits config (which would otherwise reset every count to
//      zero on every keystroke).
//   2. Multiple weather-radar-card instances on the same dashboard share
//      one budget per source — two cards both pulling RainViewer tiles
//      can't independently both consume 500 calls/min.
//
// Cross-tab / cross-window sharing is intentionally NOT implemented —
// the browser already de-duplicates parallel image fetches across tabs
// via the HTTP cache, and the SharedWorker / BroadcastChannel plumbing
// to coordinate counters across tabs would be more complexity than the
// problem warrants. Per-tab is enough for the realistic use case.
//
// Limits chosen per source:
//   - RainViewer 500/min — RainViewer's TOS doesn't publish a per-IP
//     limit; 500 is what we've used historically without issues.
//   - NOAA 120/min — conservative for the public mapservices.weather
//     .noaa.gov endpoint, which has no documented limit but is a
//     small federal government service.
//   - DWD 500/min — maps.dwd.de is fronted by Akamai with no
//     documented per-IP limit; 500 matches RainViewer.

import { RateLimiter } from './rate-limiter';

export const rainviewerLimiter = new RateLimiter(500);
export const noaaLimiter = new RateLimiter(120);
export const dwdLimiter = new RateLimiter(500);
