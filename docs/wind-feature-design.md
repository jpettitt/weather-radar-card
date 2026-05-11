# Wind overlay — design

10 m wind overlay sourced from DWD's [ICON-D2 forecast model](https://www.dwd.de/EN/research/weatherforecasting/num_modelling/01_num_weather_prediction_modells/icon_description.html), rendered as static icons (barbs or arrows) and/or animated streamlines. The model is global at 0.25° native resolution (~28 km cells); updates every 3 hours.

## Status — initial drop in v3.6.0-beta1, bulk-fetch rework in v3.6.0-beta2

Implementation:

- [src/wind-grid-fetcher.ts](../src/wind-grid-fetcher.ts) — single-call WCS fetcher + parser, request-coalescing cache, sampling helpers (pure)
- [src/wind-overlay.ts](../src/wind-overlay.ts) — static icon overlay (barbs / arrows)
- [src/wind-flow-overlay.ts](../src/wind-flow-overlay.ts) — animated streamline overlay (Canvas2D)
- Card wiring in [src/weather-radar-card.ts](../src/weather-radar-card.ts); editor row in the Wind Overlay subpage of [src/editor.ts](../src/editor.ts)
- Tests in [tests/wind-grid-fetcher.test.ts](../tests/wind-grid-fetcher.test.ts) (33 cases) and [tests/wind-helpers.test.ts](../tests/wind-helpers.test.ts) (icon helpers)

The original v3.6.0-beta1 drop (PR #133, [@genericJE](https://github.com/genericJE)) used per-cell WMS GetFeatureInfo — one HTTP request per visual icon position, parallelised via `Promise.all`. The v3.6.0-beta2 rework consolidates everything into a single bulk WCS GetCoverage call per refresh.

---

## Why bulk fetch

The first version's per-icon `GetFeatureInfo` burst was the dominant cost on every map move:

- **Before:** 60–290 parallel HTTP requests per refresh (capped at `MAX_POINTS = 400`), each ~600 B in / ~600 B out. Two overlays active = double the burst. Browser caps ~6 concurrent connections per origin, so the whole burst serialised behind the radar's tile fetches.
- **After:** **1** WCS GetCoverage request per refresh per overlay, ~3 KB to ~2 MB depending on bbox. Coalescing cache means concurrent overlays share the same request.

The factor-of-60-to-290 reduction in HTTP requests is the headline number. The architectural payoff is that the data is now indexed locally — both overlays sample the same `WindGrid` via cheap table lookups, instead of each maintaining its own per-point fetch path.

### Why WCS, not WMS

DWD's GeoServer exposes the same ICON-D2 wind data via two protocols:

- **WMS** (`Web Map Service`) — designed for rendered tiles; `GetFeatureInfo` is a per-pixel afterthought that returns one feature per call.
- **WCS** (`Web Coverage Service`) — designed for raster data delivery; `GetCoverage` returns the entire bbox as a structured grid.

WCS is the right tool for "I want all the U/V values for this bbox at native resolution." The endpoint accepts:

```http
GET /geoserver/dwd/wcs?
    service=WCS
    &version=2.0.1
    &request=GetCoverage
    &coverageId=dwd__Icon_reg025_fd_sl_UV10M
    &subset=Lat(south,north)
    &subset=Long(west,east)
    &subset=time("ISO8601")
    &format=text/plain
```

### Why text/plain, not GeoTIFF or NetCDF

DWD's WCS supports `image/tiff;application=geotiff`, `application/x-netcdf`, `application/x-netcdf4`, and `text/plain`. We chose text/plain because:

1. **No external dep.** `geotiff.js` is ~25 KB gzipped; NetCDF parsers are bigger. text/plain parses with a single `String.prototype.split()` walk.
2. **Affine transform inline.** The header carries `Grid bounds`, `Grid CRS`, and `Grid to world` (the affine matrix's `elt_0_0` / `elt_1_1` for per-axis steps). The parser doesn't need a CRS library — it just reads the numbers.
3. **Bounded payload size.** Text-encoded `f64` values are ~25 B per cell; with the adaptive scaling cap of 50 000 cells, max response is ~2 MB.

Format reads:

```text
Grid bounds: GeneralBounds[(lonMin, latMin), (lonMax, latMax)]
Grid CRS: GEOGCS[...]
Grid range: GridEnvelope2D[colStart..colEnd, rowStart..rowEnd]
Grid to world: PARAM_MT["Affine",
  PARAMETER["elt_0_0", lonStep], …,
  PARAMETER["elt_1_1", -latStep], …]
Contents:
Band 0:
<row 0 of U values, top-down>
<row 1 of U values, top-down>
…
Band 1:
<row 0 of V values, top-down>
…
```

Note the file walks rows **top-down (north-first, image convention)**. The parser flips them so `cells[0]` is the SOUTHERNMOST row, matching the bottom-up cell-centre layout used by `sampleWindGridBilinear` downstream. This was a recurring source of off-by-N row bugs during development; the row-flip is now pinned by tests.

---

## Adaptive WCS Scaling

The WCS endpoint advertises support for the [WCS 2.0 Scaling extension](https://www.ogc.org/standards/wcs). For very large bboxes (continental and world-scale viewports at z ≤ 4) we pass a `scaleSize` parameter so GeoServer downsamples server-side instead of returning every native cell:

```http
&scaleSize=http://www.opengis.net/def/axis/OGC/1/i(316),http://www.opengis.net/def/axis/OGC/1/j(158)
```

The math: pick a target number of cells (default `MAX_CELLS = 50 000` ≈ 2 MB text). If `nativeRows × nativeCols > MAX_CELLS`, scale both axes by `√(MAX_CELLS / nativeCells)` to preserve aspect ratio. Resulting grid fits the budget; fetcher transparently parses the scaled response.

**Subtle bug we hit during scaling rollout:** when GeoServer returns a scaled grid, the lon and lat steps in the affine `(elt_0_0, elt_1_1)` are NOT necessarily equal — they're whatever fits the requested `scaleSize` per axis. The first parser revision used `step = abs(elt_0_0)` for both row AND column counts, which was correct for native data (square cells) but produced an off-by-one row count under scaling and the parser would reject the grid with "Band 0: has 138 rows, expected 139". Fix: read both `elt_0_0` and `elt_1_1` and use each on its own axis.

---

## Coalescing fetcher

When both wind overlays (icons + flow) are active on the same map, every map move event triggers BOTH overlays to refresh independently. Without coalescing they'd each fire their own WCS request, doubling the load on DWD and the network.

`WindGridFetcher` (in `wind-grid-fetcher.ts`) wraps `fetchWindGrid` with a small key-based cache:

```typescript
const key = `${coverageId}|${timeIso}|${snap(bbox)}`;
//                                ^ snapped to 0.25° grid so jittery
//                                  viewport changes share a key
```

Cache entries hold the in-flight Promise (so concurrent calls share); on resolution they sit in the cache for `CACHE_TTL_MS = 60` seconds before expiring; on rejection they're evicted immediately so the next caller retries.

A module-level singleton (`windGridFetcher`) is shared between the two overlays, so a "moveend" event triggers exactly one upstream fetch even when both overlays are active.

---

## Sampling

Two helpers in `wind-grid-fetcher.ts`:

- **`sampleWindGridNearest(grid, lat, lon)`** — snap to the cell containing `(lat, lon)` and return its U/V. Out-of-bbox returns `(0, 0)`. Used by the static-icon overlay's `_gridPoints` validation in early development; current code uses bilinear instead.
- **`sampleWindGridBilinear(grid, lat, lon)`** — bilinear-blend between the four neighbouring cells. Cell-centre-anchored (the WCS convention): a sample exactly at a cell centre returns that cell's value; off-centre samples blend the four neighbours.

The streamline overlay's per-particle interpolation uses `sampleWindGridBilinear` — earlier revisions had a separate `bilinearUV` with node-anchored semantics, which produced a half-cell systematic offset (~14 km at native, smaller under scaling). Consolidated to one sampler in v3.6.0-beta2.

---

## Refresh cadence

ICON-D2 publishes new model runs every **3 hours** at 00, 03, 06, 09, 12, 15, 18, 21 UTC, typically becoming available at the WCS endpoint within 30–60 minutes of model start. Our "current" time anchor is hour-bucketed (`Math.trunc(timeMs / 3 600 000)`), so the *requested* TIME parameter only changes once per hour.

Both overlays self-schedule a refresh at **HH:00:30** of each clock hour — the moment when:

- the hour bucket changes (so we ask for a new TIME), AND
- DWD has had a chance to publish a fresher run for that hour (the 30-second offset).

Polling more often than once per hour returns identical data; less often risks lag at the bucket rollover. Top-of-hour catches both signals at the moment they happen.

---

## Streamline rendering

Canvas2D, ~1500 particles in a 500×600 viewport (tunable via `PARTICLE_DENSITY`). Each frame:

1. Decay existing trails with `destination-out` alpha (works on any basemap).
2. Walk every particle: sample wind at its current geo position, advance by `wind × pxPerMpsPerFrame`, draw the segment.
3. Respawn particles whose age exceeded lifetime or that drifted off-canvas.

### Why Canvas2D, not WebGL

At 1500 particles with a single `stroke()` per frame, Canvas2D runs ~5 ms/frame on integrated graphics. WebGL would only matter at 50 k+ particles or full-screen continuous use.

### Zoom-aware speed

Earlier revisions used a fixed `PARTICLE_SPEED_PX_PER_MPS = 0.4` constant. That made low zoom look very fast (a 10 m/s wind raced across the continent each second) and high zoom look very slow (the same wind crawled across a city block).

The current path computes `pxPerMpsPerFrame` per refresh from the map's actual pixels-per-meter at the centre latitude (Mercator stretches with latitude, so the centre's lat matters):

```typescript
const pxPerDegLon = pixels(centerLat, centerLon → centerLat, centerLon + 1);
const metersPerDegLon = 111_320 * cos(centerLat);
const pxPerMeter = pxPerDegLon / metersPerDegLon;
const scaled = REFERENCE_PX_PER_MPS_PER_FRAME * (pxPerMeter / REFERENCE_PX_PER_M);
return clamp(scaled, MIN_PX_PER_MPS_PER_FRAME, MAX_PX_PER_MPS_PER_FRAME);
```

Reference is calibrated at zoom 8 / lat 50 (`pxPerMeter ≈ 0.00255` → `0.1 px/(m/s)/frame`). Clamps avoid extreme zooms producing imperceptible drift (low) or off-screen blur (high).

### Constant-streak-length compensation

Pure pixel-speed scaling produced a second problem: at low zoom each particle moves so few pixels per frame that its trail becomes a tiny dot, while at high zoom the trail blasts off-canvas in a fraction of a second. Visible streak length varied wildly with zoom.

The fix: `_particleLifetimeFrames` is also computed per refresh — particles live LONGER when they move slower, so they trace out the same target streak length (~40 px on screen) regardless of zoom. Trail fade auto-recalibrates to match the lifetime so the start of the ribbon is still visible when the particle dies.

```typescript
const lifetime = TARGET_STREAK_PX / (TYPICAL_MPS_FOR_STREAK * pxPerMpsPerFrame);
const fade = 1 - Math.pow(0.05, 1 / lifetime); // decays to ~5% over lifetime
```

### Zoom-detail multiplier

A second, independent zoom-based scale (`_zoomDetailMultiplier`) drives BOTH particle count AND lifetime:

| Zoom | Multiplier | Effect                                                                       |
|------|------------|------------------------------------------------------------------------------|
| 3    | 0.09       | Low: very few particles, short trails (continental views don't paint over)   |
| 4    | 0.23       |                                                                              |
| 8    | ~0.79      |                                                                              |
| 10   | 1.08       |                                                                              |
| 12+  | 1.37       | High: dense particles, longer trails (city views look vibrant)               |

Linearly interpolated between z3 (LOW) and z12 (HIGH). The slope was iterated against real-world testing — earlier versions with a flat 0.25-at-low / 1.0-at-high curve still over-painted continental views at z3-4 and felt too sparse at z10+.

### prefers-reduced-motion

The streamline animation is purely decorative — barbs/arrows still convey direction & speed without it. The overlay listens to the `(prefers-reduced-motion: reduce)` media query (live, not just at construction) and skips the entire animation when the user has reduced motion enabled. Toggling System Settings takes effect without a card reload.

---

## Layering

The streak canvas lives in Leaflet's existing `overlayPane` (z-index 400). This buys two things "for free":

1. **Stacking under markers and popups.** `markerPane` (600) renders ABOVE overlayPane, so wildfire/NWS/marker icons and their popups paint on top of the streaks. Earlier revisions put the canvas at `map.getContainer()` (outside `mapPane` entirely) and ended up painting OVER everything regardless of its own z-index — the canvas was a sibling of `mapPane`, not a descendant, so its z-index lived in a different stacking context.
2. **Drag tracking via inherited transform.** `mapPane` gets a `transform: translate3d(dx, dy, 0)` during pan; every child pane (including overlayPane) inherits that transform automatically. The canvas drifts smoothly with the cursor instead of staying frozen until moveend.

Zoom is still handled with explicit `opacity: 0` on `zoomstart` and a clean rebuild on `zoomend` — the SCALE component of mapPane's zoom-animation transform would otherwise visibly stretch the canvas content.

---

## Static-icon rendering

`wind-overlay.ts` is straightforward: the `_gridPoints` method produces a sparse set of `(lat, lon)` positions based on the current zoom and `density` config, each position gets sampled via `sampleWindGridBilinear`, and a Leaflet `divIcon` (SVG path string) is mounted at that point.

Bilinear sampling matches what the legacy GetFeatureInfo path produced (GeoServer's default raster sampler is bilinear), so swapping to the bulk fetch is visually transparent.

The two icon styles share `speedColour` (Beaufort-ish band colours) and `decomposeBarbKnots` (WMO pennant/full/half decomposition). Both are pure helpers tested in `wind-helpers.test.ts`.

---

## Failure handling

Three classes of failure that quietly broke the overlay during development, all now surfaced cleanly:

1. **WCS XML exception with HTTP 200.** GeoServer returns an `ows:ExceptionReport` body for recoverable errors (out-of-bounds subset, invalid scaleSize, …) — but with status 200. The fetcher detects the `<?xml` / `ExceptionReport` prefix and throws `WCS returned exception — <text>` so the caller's console log points at the real cause instead of a downstream "missing Grid bounds line" parse fail.

2. **Out-of-extent bbox.** Leaflet's `getBounds()` at low zoom on a wide viewport readily produces lat/lon outside `[-90, 90] / [-180, 180]` (world wraparound). The fetcher clamps before building the WCS subset; the WCS endpoint never sees an invalid value.

3. **Per-axis step mismatch under scaling.** Already documented above. Fixed by reading both `elt_0_0` and `elt_1_1`.

When any of these triggers a parse failure, the overlay's `try/catch` resets to an empty grid and waits for the next refresh — no exception bubbles to the user.

---

## Open follow-ups

Known issues from 3.6.0-beta2 we intend to address before stable:

- **Wind streaks render above markers and popups.** The streak canvas is a child of `map.getContainer()` — outside Leaflet's `mapPane` stacking context — so its `z-index: 500` puts it above the panes for markers (600) and popups (700) regardless. Two earlier fix attempts (custom child pane and `overlayPane` reuse) both broke streamline POSITIONING — content offset by ~half the viewport and drifted relative to the map during scroll. Root cause: SVG and L.Canvas renderers in Leaflet position themselves per update via `setPosition(container, b.min)` against a padded layer-bounds rectangle; our naïve canvas-at-`(0,0)`-of-pane skipped that step. The fix is to subclass `L.Layer` and participate in the renderer-bounds + setPosition lifecycle (~50 lines, mirrors what `L.Canvas` does for shape rendering). Marker/popup *clicks* are unaffected — `pointer-events: none` lets them through; this is purely visual.
- **No dateline wrap on the wind layer.** When a low-zoom view's bbox crosses the antimeridian (e.g., a Pacific-centred view that shows -200° to +160° lon), `fetchWindGrid` clamps to `[-180, 180]` and the wrapped strip on one edge renders without wind data. Splitting into two WCS requests at the dateline and stitching the results would fix it; deferred because it complicates the cache key and adds a synchronisation point. Affects the small fraction of users who centre their map at extreme longitudes.

Roadmap items in [todo.md](todo.md):

- **Wind source choice** — registry pattern for AICON, BRD-1km, NOAA NCSS as alternative coverages. Tier 1 (AICON drop-in) is ~20 lines of code.
- **Per-user / per-card layer visibility** — a runtime toggle for the wind overlay (and other overlays) without re-opening the editor.
