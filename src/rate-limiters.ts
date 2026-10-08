// Per-radar-source rate limiters. Instantiated as MODULE-LEVEL singletons
// so that:
//   1. The sliding-window counter survives card teardown / re-init when
//      the user edits config (which would otherwise reset every count to
//      zero on every keystroke).
//   2. Multiple weather-radar-card instances on the same dashboard share
//      one budget per source — two cards both pulling RainViewer tiles
//      can't independently both consume the source's budget.
//
// Cross-tab / cross-window sharing is intentionally NOT implemented —
// the browser already de-duplicates parallel image fetches across tabs
// via the HTTP cache, and the SharedWorker / BroadcastChannel plumbing
// to coordinate counters across tabs would be more complexity than the
// problem warrants. Per-tab is enough for the realistic use case.
//
// Limits chosen per source:
//   - RainViewer 250/min — its tile server advertises 500/min
//     (x-ratelimit-limit) and its API FAQ says 100/IP/min; the limit is
//     per IP, so wall tablets behind one router share it. Frames load one
//     at a time, so a card never needs a burst near either figure.
//   - NOAA 500/min — opengeo.ncep.noaa.gov is the radar.weather.gov
//     production backend (Akamai-fronted, GeoWebCache, cache-control
//     max-age=120), sized for the US public checking radar during
//     storms. The budget
//     exists for the INIT BURST: the worst-case loop (120-min history
//     at the 2-min frame interval = 61 frames x ~8 tiles ≈ 490
//     requests) must clear in about a minute, then steady-state drops
//     to one frame per refresh cycle. The old 120/min was sized for
//     the small legacy mapservices host (which the fallback path
//     still uses) and stretched even a default init over minutes of
//     visible throttling. The legacy fallback never exceeds ~13
//     frames per loop, so sharing one budget is safe.
//   - DWD 500/min — maps.dwd.de is DWD's own GeoServer (no CDN in front)
//     with no documented per-IP limit.

import { RateLimiter } from './rate-limiter';

export const rainviewerLimiter = new RateLimiter(250);
export const noaaLimiter = new RateLimiter(500);
export const dwdLimiter = new RateLimiter(500);
