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
//   - NOAA 500/min — opengeo.ncep.noaa.gov is the radar.weather.gov
//     production backend (Akamai-fronted, GeoWebCache, cache-control
//     max-age=120), sized for the US public checking radar during
//     storms; 500 matches the RainViewer/DWD budgets. The budget
//     exists for the INIT BURST: the worst-case loop (120-min history
//     at the 2-min frame interval = 61 frames x ~8 tiles ≈ 490
//     requests) must clear in about a minute, then steady-state drops
//     to one frame per refresh cycle. The old 120/min was sized for
//     the small legacy mapservices host (which the fallback path
//     still uses) and stretched even a default init over minutes of
//     visible throttling. The legacy fallback never exceeds ~13
//     frames per loop, so sharing one budget is safe.
//   - DWD 500/min — maps.dwd.de is fronted by Akamai with no
//     documented per-IP limit; 500 matches RainViewer.

import { RateLimiter } from './rate-limiter';

export const rainviewerLimiter = new RateLimiter(500);
export const noaaLimiter = new RateLimiter(500);
export const dwdLimiter = new RateLimiter(500);
