# Motion Compensation — Feature Design

Status: **shipped** (initial implementation on `feature/lk-motion-compensation`)
Builds on: [#156](https://github.com/jpettitt/weather-radar-card/pull/156) (`@genericJE`)

## TL;DR

`motion_compensation: true` slides each radar layer in the estimated
direction of rain motion during the crossfade, so rain appears to
drift between frames instead of teleporting to the new position while
the old one fades. Motion is recovered by pyramidal Lucas-Kanade
optical flow on consecutive frame snapshots — no external wind data,
no source-specific dispatch. Works for all three sources (DWD,
RainViewer, NOAA). Runs in a Web Worker by default; falls back to
synchronous main-thread execution under strict CSPs.

## Background

### What `@genericJE`'s PR #156 contributed

[#156](https://github.com/jpettitt/weather-radar-card/pull/156) added
motion compensation by comparing two consecutive radar frames with
**sum-of-absolute-differences (SAD) block matching** on the alpha
channel. The contribution was substantial: it established the
snapshot-capture pipeline (canvas readback from
`img.leaflet-tile-loaded`), the `_frameSnapshot` / `_frameMotion`
arrays, the generation-guarded invalidation on pan/zoom/resize, and
the dual-translate animation in `_showSlot`. **This feature reuses
that infrastructure directly** — the only swap is the algorithm and
the channel extraction.

The original PR's algorithm was source-agnostic on paper but in
practice only produced useful vectors for **DWD**:

| Source | Palette shape | Alpha signal |
|---|---|---|
| DWD (`Niederschlagsradar`) | Banded, with smooth alpha gradients at each intensity step | Strong — SAD finds real motion |
| RainViewer | Smooth colour ramp, mostly-binary alpha (rain vs. no rain) | Weak — alpha is flat where rain is, SAD locks onto edges only |
| NOAA MRMS | Similar to RainViewer; smooth-ish coloured palette, near-binary alpha | Weak — same problem |

Testing in the dev HA testbed confirmed: motion compensation worked
visibly on DWD, but on RainViewer / NOAA it either produced zero
motion or noisy motion that jittered the layer.

### Why LK can do what SAD cannot

SAD asks "does this block from frame 0 match a block from frame 1
within ±R pixels?" — it needs both blocks to contain similar pixel
intensities. On a smooth palette where most of the moving content has
near-uniform alpha, there isn't enough block-level texture for the
metric to discriminate.

LK asks a different question: "given the spatial gradients of frame
0, what displacement most consistently explains the temporal
difference between the two frames?" It uses Sobel gradients, which
fire on **any continuous brightness transition** — including the
smooth-ramp interiors where SAD struggles. The over-determined
least-squares solve aggregates evidence across the whole frame, so
even a few thousand weak-gradient pixels produce a stable estimate.

Pyramidal LK additionally handles motion much larger than its
per-level convergence radius (~5 px) by starting at a coarse
resolution and refining up — at 3 levels the coarsest sees 30 px of
native motion as ~7 px, comfortably within range. SAD would need a
search radius scaling with the largest expected motion.

## Algorithm

### Pyramidal Lucas-Kanade (single global vector)

For each consecutive frame pair (I0, I1), produce a single
displacement `(dx, dy)` such that warping I1 by `+(dx, dy)` brings it
into alignment with I0. The displacement is the bulk motion of the
rain field between the two frame times.

Algorithm steps (see [`src/lk.ts`](../src/lk.ts) for the full
implementation):

1. **Build pyramids** — `buildPyramid` halves each level's
   dimensions, with each output pixel being the 2×2 average of its
   source block. Stops when a halved dimension would fall below 4 px
   (the LK window can't operate below that).
2. **Walk coarsest → finest.** At each level:
   - Compute Sobel gradients (Ix, Iy) of I0 once.
   - Accumulate the gradient tensor `[[sum Ix², sum Ix·Iy], [sum Ix·Iy, sum Iy²]]`.
   - Iteratively refine `(vx, vy)` by:
     - Warping I1 by the current `(vx, vy)`.
     - Computing temporal differences `It = I1_warped - I0`.
     - Solving `A·v = -b` for the LK update via Cramer's rule.
     - Breaking when the update magnitude drops below 0.005 px.
   - Scale the result up by 2 before passing to the next-finer level.
3. **Return** `(dx, dy)` from the finest level, plus a Shi-Tomasi
   confidence (minimum eigenvalue of the gradient tensor, normalised
   by pixel count) used to gate whether to apply the vector.

Defaults: 3 pyramid levels, 5 refinement iterations per level. Pinned
constants — no config exposure for v1.

### Channel extraction: distance-from-white

PR #156 extracted alpha. We extract **distance-from-white**
(`255 - min(R, G, B)`, gated and weighted by alpha):

- **DWD banded palette** — distance-from-white correlates with
  intensity, so the signal is at least as strong as alpha.
- **RainViewer / NOAA smooth colour palettes** — distance-from-white
  reads the colour ramp as a continuous gradient. This is the unlock
  that makes motion compensation source-agnostic.
- **NOAA near-binary alpha** — alpha would have been useless; this
  gets real signal.

Edge case: rare palettes that include white as a valid colour would
underweight white pixels. None of the supported sources do; flag if a
future source adds one.

### Confidence floor

Vectors with Shi-Tomasi confidence below 5 (the "borderline" band
from prototype experiments) are dropped — the gradient field is too
flat for the estimate to be trustworthy. Those transitions render as
the regular static crossfade, no jitter.

### Why linear distance-from-white, not squared

Empirically observed during dev: outlines drift smoothly while storm
cores "jump" between frames. Hypothesis was that LK's gradient signal
is dominated by the strong no-rain → light-blue outline transition,
so the bulk vector tracks outline motion and leaves cores under-
corrected. **Tried** squaring the extraction (`d² / 255` instead of
`d`) to re-weight LK toward saturated red/yellow pixels. **Result**:
no visible improvement. The residual core motion is apparently storm
evolution (cell rotation, decay, splitting, internal reorganisation),
not translation that LK could track better. Reverted to linear; the
right fix for core-tracking is dense per-region flow (a v2 project
needing a new rendering path), not better single-vector weighting.

Documenting so the next contributor with the same hypothesis doesn't
re-run the experiment.

## Architecture

### File layout

| File | Purpose |
|---|---|
| [`src/lk.ts`](../src/lk.ts) | Algorithm in pure TypeScript. Used directly for tests and as the sync-fallback path. ~270 lines. |
| [`src/lk-worker.ts`](../src/lk-worker.ts) | Worker factory + `LkWorkerClient` (promise wrapper) + `estimateMotionLk` helper with sync fallback. Embeds the algorithm as a JS string (see "Worker without a build step" below). ~340 lines. |
| [`src/radar-player.ts`](../src/radar-player.ts) | Snapshot capture, motion-vector lifecycle, crossfade-time translate. Reuses PR #156's structure with the algorithm swap. |
| [`src/types.ts`](../src/types.ts) | `motion_compensation?: boolean` config option. |
| [`tests/lk.test.ts`](../tests/lk.test.ts) | Five synthetic scenarios + primitive coverage + worker↔TS parity tests. 20 tests. |

### Worker without a build step

The standard way to add a Web Worker to a Rollup bundle is to add a
second entry point in `rollup.config.js` (so the worker is emitted as
its own chunk and loaded via
`new Worker(new URL('./lk-worker.ts', import.meta.url))`). [AGENTS.md
hard-no #4](../AGENTS.md) marks `rollup.config.js` as off-limits
without explicit approval, and the existing
setTimeout-shim worker in `radar-player.ts` already uses an
**inline-Blob** pattern that avoids the build-config change entirely.
We follow that precedent.

The cost is one real duplication: the algorithm exists both as
TypeScript in `src/lk.ts` (executed on the main thread for the sync
fallback and tests) and as a JS template-string constant
`LK_ALGORITHM_SOURCE` in `src/lk-worker.ts` (concatenated with the
message-handler and Blob-URL'd as the worker source). A parity test
in `tests/lk.test.ts` evaluates the embedded string via `new
Function` and asserts byte-for-byte agreement with the TypeScript
version on the same fixtures — any drift fails CI before review.

### Result handling

LK is called asynchronously (Promise-based), regardless of whether
the worker is used or not (the sync fallback wraps in
`Promise.resolve` to keep the API uniform). Snapshots are captured
synchronously on the `'load'` event; motion-vector computation
returns a promise that resolves later.

The animation in `_showSlot` reads `_frameMotion[newFi]` *at tick
time*. If the LK call hasn't resolved by the next tick, the
transition renders un-compensated for that frame. There's no special
"waiting" state — the next tick just gets the vector if it's there,
and the one after that almost certainly will. On a 60 FPS display
with a 500 ms `frame_delay`, the LK call has 30+ frame budgets to
land before the next tick fires.

Stale results from a previous viewport (pan, zoom, resize between
call and resolve) are discarded via the `_snapshotGen` counter —
bumped on every invalidation, captured at call time, compared on
resolve.

### Crossfade translate

When `_frameMotion[newFi]` is present at tick time:
- **Incoming layer** starts at `translate(-dx, -dy)` — where its rain
  *would have been* at the previous frame's time — and transitions
  linearly to `translate(0, 0)` over `frame_delay` ms.
- **Outgoing layer** starts at `translate(0, 0)` and transitions to
  `translate(+dx, +dy)` — where its rain *would be* at the new
  frame's time — over the same window.

At any instant the two layers' rain positions overlap, so the
composite reads as one drifting field. Linear easing keeps the
perceived drift speed constant.

Disabled when:
- `opts.snap` (loop-restart) — sliding across the loop reads wrong.
- `useChain` is false (animations off) — no transition to slide on.
- `motion_compensation` config is off.
- Vector unavailable (snapshot pending, low confidence, etc.).

### Lifecycle integration

| Event | Behaviour |
|---|---|
| Layer `'load'` (per-frame, via `wireSpinner`) | Capture snapshot for that frame, compute motion into/out of it. |
| Map `'moveend'` | Invalidate all snapshots + resnapshot (handles cached-pan where Leaflet doesn't refetch tiles). |
| Map `'zoomend'` | Same — plus update `_pinnedNativeZoom`. |
| Map `'resize'` | Same — Leaflet will re-fetch tiles and `'load'` will fire again, but we don't wait for it. |
| `_initRadar` per-frame load | Snapshot + compute as each frame becomes 'loaded' (frames load newest-first). |
| `_updateRadar` refresh | Shift `_frameSnapshot` / `_frameMotion` arrays alongside the frame arrays. |
| `clear()` | Bump `_snapshotGen` to discard in-flight results; dispose the `LkWorkerClient`. |

## Decisions

- **Single global vector over dense per-cell flow.** The differential
  test scenario (two cells moving in different directions) showed
  ~0.5 px residual error from a single bulk vector — sub-pixel,
  visually invisible. Dense flow would need either WebGL or a layer
  mesh for per-region translation, a separate larger project.
- **Distance-from-white over alpha.** Works for all three sources
  including the smooth-palette ones the PR #156 algorithm couldn't
  handle.
- **Worker mandatory (with sync fallback).** ~2 ms on a fast desktop
  implies ~10–25 ms on low-end devices; that's enough to drop a
  render frame during the crossfade. Sync fallback for strict-CSP
  environments where blob: workers are blocked.
- **Inline-Blob worker over rollup config change.** Matches the
  precedent already in `radar-player.ts` for the setTimeout-shim
  worker. Avoids AGENTS.md hard-no #4. The algorithm duplication is
  guarded by a parity test.
- **Async result, first-paint-uncompensated over synchronous-blocking.**
  Keeps the worker call off the critical render path. At 60 FPS with
  500 ms `frame_delay`, the LK result almost always lands before the
  next tick anyway.
- **Pinned LK parameters (no config exposure).** One user knob
  (`motion_compensation: bool`) matches the existing PR's contract
  and the "minimum viable surface" principle. Parameters can be
  promoted to config if real-world reports demand tuning.
- **No motion smoothing for v1.** PR #156 used median-of-5 on adjacent
  motion vectors to absorb SAD jitter. LK output was clean enough in
  synthetic tests that smoothing felt premature. Easy to add an EMA
  later if reports indicate frame-to-frame jitter.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Worker construction blocked by CSP | Low (HA is permissive by default) | Sync fallback path; logged once at startup |
| LK assumes brightness constancy; palette intensity transitions slightly violate this | Low impact | Pyramid averaging absorbs most of the residual; bias is sub-pixel |
| Heterogeneous storm with cells moving in opposite directions | Real but uncommon | Single vector approximates bulk; visible mismatch is the entry condition for a future dense-flow project |
| Algorithm-vs-string drift between `lk.ts` and `LK_ALGORITHM_SOURCE` | Low (caught by CI) | Parity test in `tests/lk.test.ts` evaluates the embedded source and asserts equivalence |
| Bundle size growth | Low — ~6 KB added net | Acceptable for a behaviour-improving feature |

## Out of scope (deliberate)

- **Per-cell dense flow.** Requires a different rendering pipeline.
- **User-visible confidence indicator.** Could surface "high/low
  confidence" badges in the card UI; defer until users ask.
- **Storm-cell tracking / wind arrows.** Different problem; LK output
  could feed those but is not the goal here.
- **Configurable LK parameters.** Pinned until reports demand
  exposure.

## Tuning knobs (for future iteration)

If real-world experience indicates problems, here are the levers and
where to find them:

- `SNAPSHOT_GRID` — `src/radar-player.ts`. Default 96. Higher =
  better sub-pixel resolution, more compute (quadratic).
- `CONFIDENCE_FLOOR` — `src/radar-player.ts`. Default 5. Raise to be
  stricter about which vectors to apply.
- LK `levels` / `iterations` — `src/lk.ts` and `LK_ALGORITHM_SOURCE`
  in `src/lk-worker.ts`. Defaults 3 / 5. Promotable to options on
  `estimateMotionLk` if needed.
- Channel extraction mode — `src/lk.ts` `extractChannel`. Currently
  hard-coded to `'distance-from-white'` in `_captureFrameSnapshot`.
  Other modes available (`'alpha'`, `'luminance'`, `'saturation'`)
  for per-source dispatch if ever needed.
