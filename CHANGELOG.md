# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.6.0-rc2] - 2026-05-11

> Wind streamline tuning pass on top of rc1. Surfaced during rc1 testing: at low zoom (z3-5) the streamlines compounded into a uniform grey band along the wind direction, obscuring the basemap. Fixed by tightening the trail decay, reducing low-zoom particle density, and compensating visually with thicker per-stroke line width. z7 was used as the visual reference (no change to its appearance); the taper applies only at zooms below it.

### Changed

- **Streamline decay sharpened.** Trail fade now targets ~0.5% alpha by particle-lifetime end (was 5%) so the tail visibly ends rather than asymptotically lingering. Particle lifetime cap dropped from 600 frames (20 s) to 120 frames (4 s) so any single slow-moving particle can't deposit ink at the same pixel for an extended window — the dominant contributor to canvas saturation at low zoom.
- **Per-stroke alpha attenuated at low zoom.** New `globalAlpha = pow(detailMultiplier, 1/3)` cube-root scaling: full opacity at z12+, ~0.45 at z3. Cuts ink contribution per stroke without making mid-zoom too faint.
- **Low-zoom density additionally tapered.** Below z7, particle count gets an EXTRA reduction on top of the existing `_zoomDetailMultiplier`: linear ramp from 0.5× at z3 to 1.0× at z7. Z7+ unchanged.
- **Line width inverse-scaled at low zoom.** Strokes are 3 px at z3 → 1 px at z7+ (linear ramp). Compensates visually for the lower density — fewer particles, but each one renders thicker, so the wind field stays readable at continental views.

The cumulative effect: at z3 you get ~50% the particle count, each rendered at 3 px width and ~45% opacity, with trails that crisply fade to invisible by 4 seconds. At z7+ the previous behaviour is unchanged.

## [3.6.0-rc1] - 2026-05-11

> Release candidate for 3.6.0. Both beta2 known issues are resolved (streak layering, dateline wrap), plus an unrelated edit-mode regression caught via live-browser testing. No new features over beta2 beyond per-basemap streamline colour tuning. If nothing surfaces during the rc1 bake, this is what 3.6.0 ships as.

### Added

- **Per-basemap streamline colour defaults + YAML overrides.** The streamline stroke colour was previously a single dark-vs-light branch — satellite shared the dark Carto map's near-white, which got lost on bright terrain. Satellite now has its own brighter pure-white default. Light basemaps also get a deeper default (`rgb(25,30,45)` was `rgb(50,55,75)`) for crisper contrast on OSM / Carto-light tiles. New YAML-only override keys `dwd_wind_flow_color_light`, `_dark`, and `_sat` accept any CSS colour string for theming or custom basemap palettes (editor doesn't expose them).

### Fixed

- **No dateline wrap on the wind layer** (one of the two beta2 known issues). Pacific-centred low-zoom views previously left the wrapped strip on one side of the antimeridian without wind data because `fetchWindGrid` clamped lon to `[-180, 180]`. Now the fetcher detects when the requested bbox extends past ±180° and expands to the full world; the samplers (`sampleWindGridNearest` / `sampleWindGridBilinear`) wrap the queried lon so coords like `-200` correctly resolve to the cell at lon `160`. Costs ~2 MB on the wire (the adaptive-scaling cap), but only triggers on viewports that actually wrap.
- **Wind streaks render above markers and popups** (the second beta2 known issue, now resolved). The streamline canvas now lives in a custom Leaflet pane (z-index 250) — directly above the radar/basemap tile pane and below everything else (wildfire perimeters, NWS polygons, marker shadows, markers, popups). Two earlier in-pane attempts produced a half-viewport offset bug because Leaflet's `mapPane` is intentionally translated to `(W/2, H/2)` to anchor its layer-point coordinate system at the map centre; the fix mirrors what `L.Canvas` does for shape rendering: `L.DomUtil.setPosition(canvas, containerPointToLayerPoint([0, 0]))` cancels that offset so the canvas's `(0, 0)` lands at viewport `(0, 0)`. Side benefit: the manual `_onMove` transform mirror is gone — the pane inherits `mapPane`'s drag transform automatically.
- **Radar tiles disappear when entering edit mode.** HA detaches and re-attaches the card when reorganising the DOM (entering edit mode, sections-grid layout changes). `disconnectedCallback` correctly tore down the Leaflet map; `connectedCallback` didn't re-init it; nothing else triggered a property change so `updated()` never fired and the radar (plus wind, plus all overlays) stayed blank. Fixed by calling `requestUpdate()` in `connectedCallback` when there's a config but no map — the existing `if (!this._map && this._config)` branch in `updated()` then re-initialises the map.

## [3.6.0-beta2] - 2026-05-10

> Wind overlay rework: replaces the per-cell GetFeatureInfo burst with a single bulk WCS GetCoverage call (often **60–290× fewer requests per refresh**), makes the overlay available regardless of `data_source`, and adds substantial visual tuning. No new user-facing config; existing wind YAML keeps working unchanged.

### Added

- **Wind overlay no longer requires `data_source: DWD`.** The ICON-D2 model is global, so the same overlay now stacks usefully on RainViewer / NOAA radar too. Editor's Wind Overlay subpage is shown for all sources. `dwd_time_override` and `forecast_minutes` anchoring is still DWD-only (those concepts don't exist for the other sources).
- **Cadence note in the editor's Wind Overlay subpage** — italic line under the description identifying the source (DWD ICON-D2 forecast, global 0.25°) and refresh cadence (top of each clock hour; new model runs every 3 h). Translated into all 11 supported languages.

### Changed

- **Bulk fetch via WCS instead of N parallel WMS GetFeatureInfo calls.** The wind overlay used to fire one `GetFeatureInfo` request per visual icon position (60–290 per refresh, capped at 400). Now one `GetCoverage` request returns the entire visible bbox as a `text/plain` U/V grid that's parsed locally and indexed by both overlays. **Massive HTTP reduction** with no visual change for the user. When both wind overlays (icons + streamlines) are active on the same map, a request-coalescing cache (60 sec TTL) means they share a single fetch instead of duplicating.
- **Adaptive WCS Scaling for huge bboxes.** Continental and world-scale viewports (z ≤ 4 on wide panels) ask for ~50 000-cell grids via the standard WCS Scaling extension, so the response stays bounded (~2 MB max) instead of exploding to ~25 MB at native resolution. Smaller bboxes still get native 0.25° data. Earlier versions silently rendered nothing at low zoom because the bbox tripped a hard cell cap.
- **Streamline animation: zoom-aware speed + constant on-screen streak length.** Previously the per-frame pixel speed was fixed across zooms — fast at low zoom, crawling at high zoom. Now we compute pixels-per-(m/s) from the map's current centre/zoom (clamped 0.01–0.3 px/(m/s)/frame) so motion is roughly proportional to ground speed at every zoom. Particle lifetime and trail fade auto-recalibrate per refresh to keep the visible ribbon ~40 px regardless of zoom — slower particles live longer and trail more gently.
- **Zoom-detail multiplier** (~0.09 at z3 → ~1.37 at z12, linearly interpolated) drives BOTH particle count AND lifetime. Continental views get fewer, shorter-lived streaks (so the ocean doesn't get painted into a uniform texture); city views get more, longer-lived ones.
- **Hour-aligned refresh** instead of fixed-interval polling. The overlay now self-schedules a refresh at HH:00:30 of each clock hour — exactly when the underlying ICON model's hour bucket changes (or when DWD publishes a fresher run for the same hour). One fetch per hour per overlay, vs. the old 30-min interval that would fetch identical data twice per hour.
- **Streak canvas now lives in Leaflet's `overlayPane`** (z-index 400) instead of being a child of the map container. Two payoffs: marker icons / popups / NWS / wildfire layers now render ABOVE the streaks (was the reverse — wind canvas was overlaying everything because it sat outside `mapPane`'s stacking context); and the canvas inherits Leaflet's per-frame drag transform automatically, so streaks drift smoothly with the cursor instead of "jumping" on moveend.
- **Bilinear sampling consolidated.** Both overlays now share `sampleWindGridBilinear`, with cell-centre-anchored semantics that match the WCS data layout. The streamline overlay was previously using a node-anchored variant that introduced a half-cell systematic offset (~14 km at native).

### Fixed

- **Wind silently rendering nothing at low zoom + wide viewports.** Three independent failure modes resolved: (a) bbox cell count exceeding the previous hard cap → fixed by switching to adaptive WCS Scaling; (b) Leaflet's `getBounds()` returning lat/lon outside `[-90, 90] / [-180, 180]` on wide panels at low zoom → fixed by clamping the WCS subset to layer extent; (c) WCS Scaling returning a grid where lon-step ≠ lat-step but the parser using one step for both axes → fixed by reading `elt_0_0` and `elt_1_1` separately.
- **WCS XML exception bodies in HTTP 200 responses** are now detected explicitly and surfaced with a descriptive error (`WCS returned exception — <text>`). Previously they bubbled up as a useless `parseWcsTextGrid: missing Grid bounds line` message that obscured the real cause.
- **Wind icons (barbs/arrows) waiting behind the radar tile burst on every map move.** The static-icon overlay now debounces moves at 50 ms (down from 250 ms) — the WCS request fires before the radar player's 100 ms post-moveend tile fetch saturates the browser's per-origin connection pool.

### Tests

370 → **399**. Net change after dropping 7 standalone `bilinearUV` tests (the function was deleted and the streamline overlay now shares `sampleWindGridBilinear`'s coverage in `wind-grid-fetcher.test.ts`). New cases pin: the WCS text parser (8 cases — bounds/dimensions, row-flip, band-split, bad-input rejection, single-cell grid, non-square cells under WCS Scaling); `sampleWindGridNearest` and `sampleWindGridBilinear` (10 cases — exact-cell, half-cell-blend, both-axis-blend, bbox-edge clamping, out-of-bbox, empty grid); `fetchWindGrid` URL building (8 cases — multi-subset format, time-quoting, scaleSize add/skip, layer-extent clamp, 5xx error, XML exception detection); `WindGridFetcher` coalescing (7 cases — concurrent share, TTL expiry, key separation by bbox/time, jitter snap, retry-on-failure).

### Known issues

Two visual issues we know about and intend to address before 3.6.0 stable:

- **Wind streaks render above markers and popups.** The streak canvas lives in `map.getContainer()` (outside Leaflet's `mapPane` stacking context), so its z-index puts it above marker/popup panes regardless of value. Putting the canvas inside any `mapPane` child produced a positioning bug — the canvas content offset by ~half the viewport and drifted relative to the map during scroll. The proper fix is to subclass `L.Layer` and participate in Leaflet's renderer-bounds + setPosition lifecycle (mirrors what L.Canvas does for its shape rendering). Marker/popup *clicks* are unaffected — `pointer-events: none` lets them through; this is purely a visual layering issue.
- **No dateline wrap on the wind layer.** When a low-zoom view's bbox crosses the antimeridian (e.g., a Pacific-centred view that shows -200° to +160° lon), the fetcher clamps to `[-180, 180]` and the wrapped strip on one edge renders without wind data. Splitting into two WCS requests at the dateline and stitching the results would fix it; deferred because it complicates the cache key and adds a synchronisation point. Affects the small fraction of users who centre their map at high or low longitude.

## [3.6.0-beta1] - 2026-05-10

> Promotes the 3.6 alpha line to beta and folds in @genericJE's [DWD wind overlay (PR #133)](https://github.com/Makin-Things/weather-radar-card/pull/133): wind barbs, arrows, and animated streamlines, all sampled from the same ICON-D2 10 m wind layer DWD's WarnWetter app uses. Beta scope freeze — no new features after this; bugfix-only path to 3.6.0.

### Added

- **DWD wind overlay** — three independent styles, all client-rendered from DWD's `Icon_reg025_fd_sl_UV10M` WMS layer (10 m wind from ICON-D2):
  - `dwd_wind: 'barbs'` — meteorological wind barbs in northern-hemisphere convention (feathers CCW of staff). Calm cells render as open circles.
  - `dwd_wind: 'arrows'` — discrete downwind arrows colour-coded by Beaufort-ish bands (calm grey → light green → fresh teal → orange → storm red).
  - `dwd_wind_flow: true` — animated streamlines à la the DWD WarnWetter app / earth.nullschool.net. Canvas2D with alpha-fade trails, ~1500 particles. Stacks with barbs/arrows.

  Both static modes honour `dwd_time_override` and `forecast_minutes`, so the wind layer follows the radar's current playback anchor. `dwd_wind_density` (0.25–4, default 1) tunes the on-screen grid; `dwd_wind_size` (0.5–2, default 1) is an independent multiplier on icon size — the two parameters used to be coupled (size = base / √density), but that bundled "more arrows" with "smaller arrows" and made one slider do two jobs. Editor exposes a new "Wind Overlay" subpage under MARKERS AND OVERLAYS, only shown when `data_source: DWD`.

  Streamlines respect OS-level `prefers-reduced-motion` (the animation is purely decorative — barbs/arrows still convey direction & speed), with a live matchMedia listener so toggling System Settings takes effect without a card reload.

  Example config:

  ```yaml
  type: custom:weather-radar-card
  data_source: DWD
  dwd_wind: arrows
  dwd_wind_flow: true
  dwd_wind_density: 1.0
  dwd_wind_size: 1.0
  ```

  Contributed by [@genericJE](https://github.com/genericJE).

### Changed

- **Map z-index constants** centralised in `const.ts` (`Z_BASEMAP`, `Z_LABELS`, `Z_RADAR_BASE`) so the layer stack is documented in one place. Wind overlays sit above tilePane (200) and below markerPane (600); the streamline canvas explicitly at z=500.

### Tests

347 → **370**. New: 23 cases for the wind overlay's pure helpers — `speedColour` (all 6 Beaufort band boundaries), `decomposeBarbKnots` (rounding to nearest 5 kt; pennant → full → half decomposition order including the 55-kt = 1 pennant + 1 half edge case), `bilinearUV` (empty grid, out-of-bbox samples, exact corner sampling, single-axis interpolation, full bilinear blend, off-zero origin + non-1 step). Lifted out of class-state methods so the most fragile new code is unit-testable in isolation.

### Cumulative since 3.5.0

This beta consolidates everything from the 3.6 alpha line:

- **DWD as a fully-supported data source** with regional WMS layers, NIFC wildfires, lightning markers, and the new wind overlay (3.6.0-alpha1)
- **NWS alert paint order** is now a lex sort over (severity, urgency, certainty), not single-key severity (3.6.0-alpha3)
- **Static-frame mode** via History Duration "Off" / `past_minutes: 0` (3.6.0-alpha2)
- **DWD coverage-mask cross-fade pulse fix** — strip the server-baked grey wash + magenta outline at fetch time, re-render the boundary as a snap-switched overlay (3.6.0-alpha4)
- **XSS-hardening pass** on three popup `href` interpolations (3.6.0-alpha3)

## [3.6.0-alpha4] - 2026-05-10

> Lands @genericJE's DWD coverage-overlay fix (originally [PR #132](https://github.com/Makin-Things/weather-radar-card/pull/132), brought across as [PR #141](https://github.com/Makin-Things/weather-radar-card/pull/141)) — the per-frame snap-switched mask that kills the cross-fade pulse on the DWD coverage outline.

### Fixed

- **DWD coverage-mask cross-fade pulse.** The grey "no-data" wash and magenta coverage outline that DWD's WMS bakes into every Niederschlagsradar / Radar_wn tile were stacking during the per-frame cross-fade — two semi-transparent layers compounded the dim and produced a visible pulse on the boundary every animation tick. Two-part fix: strip the mask + outline at fetch time via a new `pixelFilter` option on `FetchTileOptions`, then re-render the boundary as a separate snap-switched overlay on a dedicated Leaflet pane (z-index 350) so it doesn't participate in the cross-fade. Per-frame mask layers (rather than a single static one) so radar-station outages track correctly. Tested in the wild against the Feldberg outage at 08:25 UTC. Contributed by [@genericJE](https://github.com/genericJE).

### Added

- **Two CSS theme variables** for the coverage overlay colours — set either to `transparent` to hide:
  - `--dwd-coverage-dim-color` (default `rgba(0, 0, 0, 1)`)
  - `--dwd-coverage-outline-color` (default `rgba(255, 0, 255, 1)`)

  RGB picks the colour, alpha multiplies the original mask alpha so wash density and outline antialiasing both scale.

### Tests

329 → **347**. New: 18 cases for `classifyDwdPixel` (the heart of the mask-stripping pipeline — opaque palette purples per palette, canonical magenta-outline rule, off-palette purple-shape blends, equal-channel grey, canonical radar palette colours that should pass through, brightness-floor and saturation-shape boundary cases, semi-transparent edges, the 15-unit drift threshold for grey detection) plus 3 cases for `dwdPaletteFor` (layer-name → palette mapping). Pin against DWD palette drift — if their colour ramp ever changes, the strict-match whitelist will silently mis-classify, and these tests catch it.

## [3.6.0-alpha3] - 2026-05-07

> Two NWS-layer improvements: a smarter paint order for overlapping alerts, plus an XSS-hardening pass on every popup `href` interpolation. Same-day fix-and-improvement release for the 3.6 alpha track.

### Security

- **Escape three popup `href` interpolations.** The NWS, wildfire, and lightning popup builders each had a `<a href="${url}">` interpolation that wasn't going through `escapeHtml`. Only the NWS one had a known attack surface (`props.uri` is server-controlled, but the existing scheme check blocks `javascript:` URIs *not* HTML attribute breakouts via `"` or `>`). Wildfire (`linkSlug` is `slugify`-derived) and lightning (`url` is built from clamped numeric inputs) were safe by construction; defensive escape protects against future refactors. No known live exploit at any of the three sites — the fix closes the theoretical gap.

### Changed

- **NWS alert paint order is now lexicographic over (severity, urgency, certainty)** — replaces the prior single-key severity-ascending sort. Severity dominates (matching the `alerts_min_severity` filter), urgency breaks severity ties (`Past < Unknown < Future < Expected < Immediate`), certainty breaks urgency ties (`Unknown < Unlikely < Possible < Likely < Observed`). Result: a Tornado Warning Observed paints over a Tornado Warning Radar-Indicated; both paint over Severe Thunderstorm Warnings; Wind Advisory Observed over Frost Advisory; etc. CAP-standard fields, no event-name regex.

### Tests

316 → **329**. New coverage:

- 8 cases for the three-axis lex sort (severity primary, urgency secondary, certainty tertiary, severity-dominates-other-axes, Past < Unknown urgency, all-defaults vs missing properties, realistic mixed-alerts pin)
- 5 cases for `buildPopupHtml` URL escaping (attribute-breakout escaped, javascript: scheme triggers fallback, normal uri unchanged, `< > &` in uri escaped, null/undefined uri falls back to alerts index)

## [3.6.0-alpha2] - 2026-05-06

> Small follow-up to alpha1: a "no animation" option for users who want a static current-frame view. The animation was always on prior to 3.6 because `getEffectiveTimeRange` floored the frame count at 2 — `past_minutes: 0` silently became a 2-frame loop. Now `0` means 1 frame.

### Added

- **History Duration "Off (static frame, no animation)"** option in the editor's preset dropdown. Selecting it sets `past_minutes: 0`, the player loads exactly one frame and stays on it (no animation loop). The periodic 5-minute refresh still updates the single frame so it doesn't go stale. Helper text under the dropdown switches to "Static frame — no animation, refreshes every 5 min" to confirm the mode.

### Fixed

- **`getEffectiveTimeRange` floor lowered from 2 to 1**, so `past_minutes: 0` actually produces 1 frame instead of being silently rounded up to 2 (which previously made the static-frame mode unreachable from YAML or the editor).

### Tests

314 → **316**. Two new cases pin the new floor behaviour: single-frame for past=0 + no forecast, multi-frame still produced when past=0 + forecast > 0 on DWD.

### Localization

11 languages updated for the two new editor strings (`past_off`, `helper_static`). Coverage parity verified at 100%.

## [3.6.0-alpha1] - 2026-05-06

> First alpha cut of the 3.6 line. New feature: a lightning overlay sourced from the Blitzortung HA integration. No external HTTP from the card — the integration handles all the data plumbing; we just render.
>
> Also includes the tile-active fix and the radar pan/zoom no-teardown perf improvement (PRs [#130](https://github.com/Makin-Things/weather-radar-card/pull/130) + [#131](https://github.com/Makin-Things/weather-radar-card/pull/131) from [@genericJE](https://github.com/genericJE), already on master) — they're carried through this alpha by virtue of merging master in.
>
> **Coming in 3.6.0-beta1:** the DWD coverage-mask pulse fix ([#132](https://github.com/Makin-Things/weather-radar-card/pull/132)) and the wind overlay ([#133](https://github.com/Makin-Things/weather-radar-card/pull/133)) — both pending review feedback addressed by [@genericJE](https://github.com/genericJE). 3.6.0 stable will consolidate alpha1 + beta1.

### Added

- **Lightning overlay** (`show_lightning: true`) — live lightning strikes from the [Blitzortung integration](https://www.home-assistant.io/integrations/blitzortung/), rendered from the integration's `geo_location.lightning_strike_*` entities. Each strike appears as a brief lightning-bolt flash with a one-shot pulse animation (the "happening now!" indicator), and after 30 s settles into a coloured **+** sign. The + sign's fill colour ages through Blitzortung's web-map gradient (white → yellow → orange → coral → red → dark red), mirroring the visual language of [their map](https://map.blitzortung.org/). Newer strikes always paint on top of older ones. Click any strike for a popup with distance / cardinal-bearing from the map centre, relative time, and a deep link into the Blitzortung web map at the strike location.
- **Two-pane outline-vs-fill rendering** for the + sign — outline marker on a pane at z 499, coloured-fill marker on z 500. At low zoom many overlapping strikes don't dissolve into a "black blob" — outlines stack harmlessly underneath, the topmost colour fill stays clean on top. Bolts stay single-marker (they're bigger and only last 30 s, no stacking issue).
- **`lightning_max_age_minutes` config** (default 30) — card-side cap that hides strikes older than N minutes. Distinct from the Blitzortung integration's own max-age setting (the integration's setting is the upper bound; the card's cap is whichever is smaller). Editor field with a helper line making the boundary clear.
- **`lightning_pulse` config** (default `true`) — disable the appearance flash. Honours `prefers-reduced-motion` automatically.
- **`lightning_icon_size` config** (YAML-only, default 14 px) — pixel size for the + sign; the bolt renders at 1.3× this size.
- **Hazard Overlays editor row** — Show Lightning toggle disabled + dimmed when the Blitzortung integration isn't loaded, with a tooltip explaining how to enable it. Same `disabled-row` UX pattern as `square_map` when the height is pinned.
- **Detection helper `isBlitzortungLoaded(hass)`** — checks `hass.config.components` for `'blitzortung'`. Editor and layer both gate on this so a quiet day (no current strikes) doesn't make the toggle disappear.
- **6-stop colour gradient** in `colorForAge()` — driven by a `COLOR_STOPS` table, single `lerpHex` per call regardless of where t lands. Adding a stop is a one-line edit.
- **CSS drop-shadow halo** on every strike marker — gives a 2 px black outline against any basemap or radar overlay colour. Cheaper than nesting concentric SVG shapes.
- **Custom Leaflet panes** `wrc-lightning` (z 500) and `wrc-lightning-outline` (z 499) — between the default `overlayPane` (400) and `markerPane` (600), so lightning sits over radar / wildfire / NWS-alert polygons but the home / person markers stay on top of any strike at the same point.

### Localization

11 language files updated for the new editor strings (Lightning section header / description / integration-required tooltip / max-age field + helper / overlay summary label / Show Lightning toggle) and the popup strings (lightning_strike title, source label, "more info" link, eight cardinal bearings, four relative-time keys). Coverage parity verified at 100% across all 11 languages.

### Tests

314 unit tests (43 new for lightning helpers — `isBlitzortungLoaded` edge cases, `colorForAge` 6-stop endpoints + monotonicity + clamps + zero-maxAge defence, `bearingCardinal` 8-way + same-point + antimeridian, `relativeTime` bucket boundaries + fractional flooring + negative-input clamp, `formatBlitzortungUrl` precision + zoom clamping, plus pins on `BOLT_DURATION_SEC` and `DEFAULT_BLITZORTUNG_MAX_AGE_SEC`).

### Documentation

- New [docs/lightning-feature-design.md](docs/lightning-feature-design.md) marked shipped-in-3.6.0-alpha, with deviations-from-design notes covering the visual-treatment iteration that landed during smoke testing.
- [docs/overlays.md](docs/overlays.md) gains a Lightning section with the knobs table and a NOTE explaining the card-side cap vs the integration's setting.
- [docs/configuration.md](docs/configuration.md) options table gains the four lightning fields.
- [docs/todo.md](docs/todo.md) moves the lightning entry from Open to Shipped.

## [3.5.0] - 2026-05-05

> Stable cut of the 3.5 line. Two big new US-only overlays (wildfires, NWS watches & warnings), a source-agnostic time-range editor that retires `frame_count`, a DWD-outside-coverage banner, animation polish, three quality-of-life contributions from [@genericJE](https://github.com/genericJE), and a full docs sweep. Consolidates the `3.5.0-alpha`, `3.5.0-alpha2`, and `3.5.0-beta1` prereleases.
>
> **US-only data** in the new overlays — see the strong life-safety disclaimers in [docs/overlays.md](docs/overlays.md).

### Added

#### Hazard overlays (US-only)

- **Wildfire perimeter overlay** — `show_wildfires: true` overlays active US wildfire perimeters from NIFC's [WFIGS Current Interagency Fire Perimeters](https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters/about) feed. Active fires draw red, fully-contained ones grey. Small incidents render as a fire icon at the centroid; larger ones as a polygon outline. Click any fire for a popup with name, acreage, containment %, discovery date, and a link to NIFC's InciWeb (gated against InciWeb's RSS index so we don't link to 404s). Adaptive 5/30-minute refresh. Filter knobs: `wildfire_min_acres` (default 10), `wildfire_radius_km`, plus colour / fill / refresh overrides.
- **NWS watches & warnings overlay** — `show_alerts: true` overlays active US National Weather Service watches and warnings from `api.weather.gov/alerts/active`. Alerts render as translucent polygons coloured per [NWS's standard warning palette](https://www.weather.gov/help-map). Both polygon-bearing and zone-based alerts render: zone shapes are fetched on-demand from `api.weather.gov/zones/...` and cached in localStorage (TTL 30 days, versioned key prefix `wrc-zone-v1:`) so they're zero-network on subsequent sessions. Click any alert for a popup with event, headline, severity / certainty / urgency, effective and expiry windows, full description (preserves NWS's line breaks), and a link to weather.gov.
- **Hazard Overlays editor subpage** — new top-level "Markers and Overlays" section in the editor groups two nav rows: **Markers** (the existing list) and **Hazard Overlays** (new). The Hazard Overlays subpage exposes the wildfire and alerts toggles, their per-overlay knobs (min_acres, radius_km, min_severity), and a 2-column grid of NWS alert-category checkboxes (Tornado, Thunderstorm, Flood, Winter, Tropical, Fire Weather, Heat, Wind, Marine, Other; marine off by default).
- **Region-warning utility** — surfaces a banner when any US-only feature (wildfires, alerts, NOAA radar) is enabled with `hass.config.country !== 'US'`. Multiple US-only features collapse into a single combined banner instead of stacking. Adds a separate banner for **DWD selected outside its coverage** (Germany + immediate neighbours: NL, BE, LU, FR, CH, AT, CZ, PL, DK), replacing the developer-facing one-shot `console.warn` from 3.4.0 with a visible UI cue.

#### Time-range editor (replaces `frame_count`)

- **`past_minutes` / `forecast_minutes` config** — source-agnostic time-range fields that work across all radar sources. The editor renders them as preset dropdowns filtered by per-source caps: RainViewer and NOAA show `20 / 40 / 60 / 120 min` (cap 2 h — NOAA's API advertises 4 h but frames > 2 h come back empty in practice); DWD shows up to 12 h (`20 min – 12 h`). YAML can reach the API cap (DWD: 84 h, paired with `frame_stride_minutes` to keep the frame count sane).
- **Forecast Duration field** appears only on sources with a forecast (currently DWD: `Off / 1 h / 2 h`). Hidden in the DOM for RainViewer / NOAA.
- **`frame_stride_minutes`** — YAML-only escape hatch for users who want very large past windows on DWD without the implied frame count.
- **`SOURCE_CAPS` table** in `src/source-caps.ts` is the single source of truth for per-source `intervalMin` / `maxPastMin` / `editorMaxPastMin` / `maxForecastMin` / defaults. Adding a new radar source = adding a row.
- **Auto-migration** — `migrateConfig` silently converts legacy `frame_count` to `past_minutes` (using the source's native interval) and `dwd_forecast_hours` to `forecast_minutes`. Existing configs need no changes; warning logged once. The DWD-only `dwd_past_hours` field proposed in [#121](https://github.com/Makin-Things/weather-radar-card/pull/121) by [@genericJE](https://github.com/genericJE) prompted this broader source-agnostic redesign.

#### Animation

- **`smooth_overlap` config knob (0–1)** — tunable crossfade overlap when `smooth_animation: true`. `0` = sequential (no brightness dip; cushion held), `0.5` = 50% overlap, `1` = fully simultaneous (default; brief mid-transition dip). Fade duration auto-calibrates so the full cycle still equals `frame_delay` regardless of overlap. Exposed in the editor as a 0–1 slider with mutual gating against `transition_time`.

#### Other

- **Loading spinner** — a small rotating indicator sits in the centre of the bottom bar while radar tiles are being fetched (initial load, post-pan/zoom reload, periodic 5-minute refresh); hidden when only cached frames are cycling. Honours `prefers-reduced-motion`. `show_loading_spinner: false` suppresses. Contributed by [@genericJE](https://github.com/genericJE) (#124).
- **"Now" marker on the progress bar** — the segment whose timestamp is closest to wall clock now gets a small amber stripe at the top, a `title="Now"` tooltip, and the displayed timestamp gains a `(now)` suffix while playback shows that frame. Mostly useful with DWD forecast frames where "now" sits in the middle of the timeline. The stripe colour follows HA's `--warning-color` theme variable. Contributed by [@genericJE](https://github.com/genericJE) (#125).
- **Build timestamp in console signon** — the card's startup signon now reads `WEATHER-RADAR-CARD Version X.Y.Z (built YYYY-MM-DD HH:MM:SS UTC)` so users can confirm a hard refresh actually loaded the new bundle vs a cached older one.

### Changed

- **WYSIWYG map editing** — when this card's edit dialog is open, every pan/zoom in the live map auto-propagates to the editor's Lat/Long/Zoom fields in real time. The "Save as map center" button is removed entirely. Detection via window-level events from the editor element's connect/disconnect lifecycle, with a global mount counter to handle the dialog mount-order race.
- **Toggle layout standardised** — every `<label>` switch now renders as `[switch] [text]` left-aligned with a gap. Single source of truth.
- **Per-source rate limiters are now module-level singletons** — survive card teardown (config edits no longer reset the count) and are shared across multiple weather-radar-cards on the same dashboard.
- **Pause when hidden** — wildfire and NWS-alerts layers stop their refresh timers when the card scrolls off-screen or the tab is hidden, and refetch on resume if the pause was longer than the visible-refresh interval. Radar player already paused itself.
- **Dynamic radar tile size** — picks 256 / 512 / 1024 / 2048 from `map.getSize()` so panel-view / fullscreen maps load with bigger tiles (fewer requests for the same coverage). All three radar sources support this. **Empirically cuts load time and rate-limit hits on larger maps.**
- **`npm run build` regenerates `.js.gz`** alongside the `.js` so HA can't serve a stale gzipped bundle from a previous build.

### Fixed

- **Trail on first cycle after editing animation settings.** Changing animation settings used to leave stale CSS-transition state on the radar layers, producing a visible trail on the first cycle after the change. `setConfig` now does a full teardown + reinit on any structural config change. Exception: back-propagated `center_latitude` / `center_longitude` / `zoom_level` are diffed and skipped — a teardown there would interrupt the user's active interaction. Direct YAML edits still move the map via `setView`, guarded against re-firing as a back-prop bounce.
- **Editor-open detection race** — a fresh card opened in HA's edit dialog used to silently miss the back-propagation of map pan/zoom into the editor's Lat/Long fields, because the dialog can mount the editor before the preview card. Card now consults a global mount counter on connect to recover from the missed event.
- **`alerts_categories: []` now correctly hides everything.** Previously an explicit empty array fell back to the default category set, so unchecking every category in the editor reverted to "show everything". New `getActiveAlertCategories(configured)` helper distinguishes `undefined` (use defaults) from `[]` (none).
- **Popup `[wildfire]` race during zone resolution.** `_zoneFetches` could be left with stale entries on localStorage cache hits because the function returned synchronously before the caller registered it. Refactored so `_fetchZone` self-registers as its first action.
- **Popup accent colour uses WCAG-style relative luminance** — replaces a hardcoded list of "light" hex values, so any future palette additions get the right text colour automatically.
- **Dark / satellite map scale rendered a faint duplicate label** behind the main "50 km" text. Leaflet's default `.leaflet-control-scale-line` carries a `text-shadow: 1px 1px #fff` for readability on light basemaps; on the dark / satellite styles that shadow rendered as a ghost. The `.map-dark` override now sets `text-shadow: none`. Contributed by [@genericJE](https://github.com/genericJE) (#123).
- **Popup "See README" links scrolled to the top of the README** instead of the relevant safety-disclaimer section. The README split that landed during 3.5 removed the `#wildfires` and `#nws-watches--warnings` headings the popup links anchored against; both wildfire and NWS-alert popup links now target the matching headings in `docs/overlays.md`.
- **Editor toggle markup standardisation regression.** The Loading Spinner row was the lone holdout — text-then-switch with no `<span>`, instead of the canonical `[switch][text]` pattern used everywhere else. Realigned.
- **Markercluster `_bounds`-undefined race in the resize path** ([#110](https://github.com/Makin-Things/weather-radar-card/issues/110) re-emergence). The 3.1.3 fix capped cluster zoom at 11 to avoid the same race during `_zoomEnd`; the resize path (`invalidateSize` → `markercluster._zoomEnd`) hits the same trap when a `ResizeObserver` callback fires before the cluster group's first bounds computation completes. Defer to next animation frame and wrap `invalidateSize()` in a `try/catch` to recover on the rare remaining edge case.

### Documentation

- New `docs/wildfire-feature-design.md` and `docs/nws-alerts-feature-design.md` design docs; planning notes moved to `docs/`.
- 495-line README split into a slim landing page plus focused docs under `docs/` (Configuration, Data Sources, Hazard Overlays, Markers, Examples, Animation architecture). Options table moved to [`docs/configuration.md`](docs/configuration.md) and now includes `past_minutes`, `forecast_minutes`, `show_loading_spinner`, `show_wildfires`, `show_alerts`, the DWD-only fields, and all per-overlay knobs.
- `docs/animation.md` rewritten to match the current two-slot + delayed-fade-out model (`_crossfadeTiming()` table, `_settleVisibility()`, dynamic tile size, time-range derivation).

### Localization

11 language files now at **100% key parity**. Pre-release pass added the 5 keys missing from the 10 non-English files (`editor.display.show_loading_spinner`, `editor.map.source_dwd`, `ui.loading_radar_tiles`, `ui.now`, `ui.now_tooltip`), the new `ui.region_warning.dwd_de_only` for the DWD coverage banner, and dropped the stale `editor.animation.frame_count` / `editor.animation.default_5` keys from all 11 files (replaced by the time-range editor in 3.5). Brand acronyms (NWS, NOAA, NIFC, README) and the "Acres" US unit intentionally retained in source form.

### Tests

128 → **268** unit tests (140 added). New coverage: geo helpers (centroid, haversine, bbox), string helpers (escapeHtml XSS injection patterns, slugify, truncate), NWS alert categories, NWS alert colour table, region-warning composition (now including DWD coverage countries, non-coverage countries, case-insensitive matching, US-only + DWD stacking), alert-layer helpers (featureKey, decisionsEqual including zone-arrival diff, severity-sort, luminance, formatDateTime, localStorage zone cache round-trip + TTL eviction + corrupt JSON + quota-exceeded handling), `getEffectiveTimeRange` (defaults, clamps, stride snapping, edge cases), `migrateConfig` time-range migration, `nearestFrameIndex` for the now marker. Pure-helper extraction (`src/geo-utils.ts`, `src/string-utils.ts`, `src/source-caps.ts`) deduplicates code that was previously identical between layers.

## [3.4.0] - 2026-05-04

> Stable cut of the 3.4 line. Two new radar sources, a rebuilt crossfade engine, and a clean editor experience for the animation timing knobs. Pre-releases `3.4.0-beta` (DWD + crossfade fix) and `3.4.0-beta2` (smooth_overlap + setConfig polish) consolidated here.

### Added

- **DWD radar source** — `data_source: DWD` uses Deutscher Wetterdienst's `Niederschlagsradar` WMS at `maps.dwd.de`. 5-minute frame steps (vs. RainViewer's public 10-minute tier), ~3 days of history, +2 hours of forecast available via the `Radar_*-product_*` layers. Coverage is the German radar network footprint (Germany + immediate neighbours). Contributed by [@genericJE](https://github.com/genericJE) (#114).
- **`dwd_layer` config option** — DWD-only WMS layer name override. Default `Niederschlagsradar` (mm/h). Set to `Radar_wn-product_1x1km_ger` for reflectivity (dBZ) with 2-hour nowcast frames included.
- **`dwd_time_override` config option** — DWD-only ISO timestamp to anchor frames at a fixed point in time instead of "now". Useful for verifying the overlay renders when current weather is dry.
- **`dwd_forecast_hours` config option** — DWD-only. Includes this many hours of nowcast forecast in the playback range as if they were "current". When set to a positive value the layer auto-switches from `Niederschlagsradar` to `Radar_wn-product_1x1km_ger` (which carries the +2h nowcast frames) unless `dwd_layer` explicitly overrides it. Matches the DWD WarnWetter app's default behaviour.
- **DWD-coloured colour bar** — `data_source: DWD` shows a horizontal strip using DWD's `Niederschlagsradar` palette (15 bands sampled from DWD's official legend), replacing the misleading universal-blue scale used as a fallback before. Same UI shape as the existing NOAA / RainViewer bars; honours `show_color_bar: false`.
- **DWD coverage check** — `data_source: DWD` emits a one-shot `console.warn` when HA's configured location falls outside the bounding box of Germany and its immediate neighbours, so the inevitable no-data grey wash isn't mistaken for a broken card.
- **`smooth_animation` config option** — when `true`, the crossfade auto-calibrates so the full cycle equals `frame_delay`; the radar appears to flow continuously instead of stepping. Overrides `transition_time`. Contributed by [@genericJE](https://github.com/genericJE) (#113).
- **`smooth_overlap` config knob (0–1)** — tunable crossfade overlap when `smooth_animation: true`. `0` = sequential (no brightness dip; cushion held), `0.5` = 50% overlap, `1` = fully simultaneous (default; brief mid-transition dip). Fade duration auto-calibrates so the full cycle still equals `frame_delay` regardless of overlap. Exposed in the editor as a 0–1 slider.
- **Editor mutual gating for animation timing** — `transition_time` is disabled when Smooth Animation is on (the smooth path computes its own fade); `smooth_overlap` is disabled when Smooth Animation is off. Both fields stay visible so the relationship is obvious.

### Changed

- **DWD rate limiter raised to 500/min** (from the initial conservative 120/min, copied from NOAA). DWD's `maps.dwd.de` is fronted by Akamai with no documented per-IP limit; 120 was visibly throttling pan/zoom bursts (~80 tile requests in one move) without ever seeing 429s from the server. 500/min matches RainViewer.
- **DWD tiles requested at 512×512** instead of the default 256×256 — quarters the request count for the same map coverage. Useful for the same burst case above and reduces total bandwidth slightly since the per-tile overhead is amortised.

### Fixed

- **Crossfade no longer pulses against light basemaps** (#113). The previous symmetric crossfade animated the outgoing layer 1→0 while the incoming layer animated 0→1. At the midpoint both layers sat at opacity 0.5 and alpha-composed to ~0.75 visibility — letting 25% of the basemap show through at every transition. Replaced with a two-slot model: the new current frame gets a higher z-index, snaps to `0`, then fades to `radar_opacity` with `ease-in-out`; the immediately-previous frame (the cushion) stays at full opacity through the fade-in window via CSS `transition-delay`, then begins its own fade-out so old data dissolves smoothly instead of snapping out. Older frames stay hidden throughout. At the loop boundary — when the player wraps from the last frame back to the first after the restart pause — transitions snap instead of fading, since the natural pause makes a smooth fade across the loop read as "time ran backwards". `_settleVisibility()` is called on every pause to leave a known clean state in the layer DOM.
- **Trail on first cycle after editing animation settings.** Changing animation settings used to leave stale CSS-transition state on the radar layers, producing a visible trail on the first cycle after the change. `setConfig` now does a full teardown + reinit on any structural config change. Exception: when the user pans/zooms the live map in editor mode, the back-propagated `center_latitude` / `center_longitude` / `zoom_level` keys are diffed and skipped — a teardown there would interrupt the user's active interaction. Direct YAML edits to those keys still move the map (via `setView`), guarded against re-firing as a back-prop bounce.
- **Internal options no longer leak into WMS GetMap URLs.** `FetchWmsTileLayer` was passing its full options object to Leaflet's `L.TileLayer.WMS.initialize`, which appends any unrecognised option as a query parameter — so requests carried `&rateLimiter=[object%20Object]&on429=...&animationOwnsOpacity=true` tail-end, which were ignored by the server but bloated the URL and confused log inspection. Now strips those internal fields before delegating, then re-attaches them to `this.options` for the rest of the layer code. Affects both NOAA and DWD WMS layers.

### Documentation

- README config table includes `smooth_overlap`; the Animation section now describes the actual two-slot model with `smooth_animation` / `smooth_overlap` semantics, the loop-boundary snap, and the pause-settle behaviour.
- `animation.md` rewritten to match the v3.4.0 architecture (two-slot crossfade, `_crossfadeTiming()` table, `_settleVisibility`, dynamic tile size).

### Localization

11 language files updated for the new editor strings.

## [3.3.0] - 2026-04-30

### Added

- **Editor localization** — every label, helper, dropdown option, and banner string in the editor and runtime UI now resolves through `localize()`. Existing translations updated for Norwegian Bokmål (nb) and Slovak (sk); new translations added for German (de), French (fr), Dutch (nl), Spanish (es), Italian (it), Polish (pl), Swedish (sv), and Portuguese-Brazilian (pt-BR). Translations are best-effort and welcome native-speaker review.

## [3.2.0] - 2026-04-30

### Added

- **`radar_opacity` config option** — adjust the opacity of the active radar frame (0.1–1.0, default `1.0`). Lower values let more of the basemap show through. Editor exposes a slider in the Appearance section.

## [3.1.3] - 2026-05-01

### Fixed

- **Markers disappeared when clustering was on** (#110). The map's `maxZoom` bump from 10 to 16 in 3.1.2 expanded markercluster's internal cluster tree by six zoom levels, exposing a markercluster bug where a cluster's `_bounds` could end up undefined and crash `_zoomEnd` (`Cannot read properties of undefined (reading 'lat')`). The crash left the marker pane completely empty. Setting `disableClusteringAtZoom: 11` on the cluster group caps the cluster tree depth — beyond zoom 11 markers display individually anyway, so there's no behavioural cost.

## [3.1.2] - 2026-04-29

### Changed

- Map `maxZoom` raised from 10 to 16. Basemaps will sharpen up to their native resolution; the radar overlay (capped at `maxNativeZoom: 7`) will upscale and look pixelated past zoom 7. User-requested tradeoff.
- Cluster badge count fix (3.1.1) now applies to **all** `zone.*` markers, not just `zone.home`. A cluster with `zone.work + 3 device_trackers` shows badge `3`. The cluster icon is rendered from the user-configured icon on the representative zone marker (preferring `zone.home` if present, otherwise the first zone in the cluster), falling back to `mdi:home` / `mdi:map-marker-radius` when no icon is set.

## [3.1.1] - 2026-04-27

### Changed (build / release)

- **`dist/weather-radar-card.js.gz` is no longer tracked on feature branches.** Each branch CI was independently rebuilding the gzipped artefact, causing binary merge conflicts on every PR. The `.gz` is now regenerated by CI on push to `master` (so master always has a fresh one matching the served `.js`) **and** by the release workflow on `release: published` (which uploads `.js` + `.gz` as release assets). HACS picks up the assets directly, so existing installs always overwrite their stale `.gz` on update.

### Changed

- Footer / progress bar / links now use HA theme CSS variables (`--card-background-color`, `--primary-text-color`, `--primary-color`) — custom themes are picked up automatically. The previous hard-coded two-tone scheme is gone.
- `map_style: auto` follows `hass.themes.darkMode` (so the map matches HA's dark-mode setting whether the user picks it manually or has HA follow the browser); falls back to OS `prefers-color-scheme` only when HA hasn't exposed a value. The map rebuilds automatically when the flag flips.

### Fixed

- Home cluster badge now counts only non-home markers (e.g. home + 3 others shows `3`, not `4`). Badge is hidden entirely when a cluster contains only home markers.

## [3.1.0] - 2026-04-26

Multi-marker overhaul. **Breaking:** single-marker config fields (`show_marker`, `marker_latitude`, `marker_longitude`, `marker_icon`, `marker_icon_entity`, `mobile_marker_*`) are deprecated. Existing YAML auto-migrates in memory on load with a console warning; the editor only writes the new `markers[]` format.

### Added

- **Multi-marker support** — `markers[]` array replaces the old single-marker fields. Each entry supports `entity`, `latitude`, `longitude`, `icon`, `icon_entity`, `color`, `track`, and `mobile_only`.
- **Live entity tracking** — markers with an `entity` field update their position on every HA state change. Works with `device_tracker.*`, `person.*`, `zone.*`, or any entity with `latitude`/`longitude` attributes.
- **Track resolution** — set `track: entity` or `track: true` on a marker to auto-centre the map. Priority: (1) `track: entity` on a `person.*` whose `user_id` matches the logged-in HA user, (2) `track: entity` on any other entity, (3) `track: true`. The tracking winner always renders on top (`zIndexOffset: 1000`).
- **Default home marker** — when `markers` is absent, the card auto-creates a single `zone.home` marker. `markers: []` opts out.
- **Auto-migration** — old single-marker fields are converted to `markers[]` in memory on load; existing YAML continues to work.
- **Marker clustering** (`cluster_markers`, default `true`) — nearby markers collapse into a count badge; tap/click to spiderfy. The tracked marker always renders outside the cluster. Home clusters render as the home icon with a small superscript count badge.
- **`mobile_only` marker flag** — a marker with `mobile_only: true` only renders on mobile devices (HA Companion app, mobile UA, or screen width ≤ 768 px). Replaces the old `mobile_marker_*` fields.
- **Any MDI icon supported** — markers render via HA's `<ha-icon>` element so any name in HA's icon database works (e.g. `mdi:car-pickup`, `mdi:rocket`). No hardcoded allow-list.
- **Icon picker autocomplete** — the editor's marker icon field uses HA's `ha-icon-picker` with full MDI autocomplete and live preview.
- **Smart icon auto-detect on entity selection** — picking an entity in the editor auto-fills the icon from `attributes.icon` → `device_class` lookup → `source_type` (device_tracker: router / bluetooth / gps) → domain default (`mdi:account`, `mdi:home`, `mdi:map-marker-radius`, `mdi:map-marker`). Person entities default to their photo when one is available.
- **Use entity picture toggle** — person markers get a dedicated switch to choose between the entity photo and an MDI icon.
- **Per-marker `color`** — CSS colour for `mdi:*` and default icons.
- **Theme-aware footer** — the footer / progress-bar chrome now follows HA's theme setting (or OS `prefers-color-scheme`), independent of map style. Re-renders automatically on theme change.
- **NWS colour bar** — `data_source: NOAA` renders the NWS reflectivity scale (`radar-colour-bar-nws.png`) instead of RainViewer's universal-blue scale.
- **Unit test suite** — 128 Vitest tests covering migration, position resolution, track priority, icon rendering, rate limiting, and mobile detection. Runs in CI on every push and PR.
- **CI builds dist for every branch** — feature branches get an auto-built bundle committed back; bundle marked `linguist-generated` so PR diffs hide it.

### Changed

- **Editor Location section** only contains map-center coordinates; marker configuration is in the new Markers section with per-marker rows.
- **Editor Mobile Overrides section removed** — use `mobile_only: true` on a marker instead.
- **Editor map-style default** — selector correctly shows `Auto` when `map_style` is unset (previously showed `Light`).
- **Production build minified** — terser added back. Bundle ~707 kB → ~278 kB; gzip ~143 kB → ~77 kB. Watch mode skipped for fast iteration.

### Removed

- **`mobile_center_*` fields** — undocumented and unused; removed entirely.
- **Editor `card_title` control** — the field was orphaned (never read anywhere).

### Fixed

- `width` config field is now applied to the card.
- `square_map: true` no longer collapses the map to zero height.
- NOAA animation playback direction (was newest → oldest).
- Colour bar `src` and visibility hoisted into the lit template — previously a rate-limit or fetch failure could leave the bar empty with no `src`.
- `map_style: Satellite` home marker now uses the light SVG (was using dark).
- Map z-index isolation, timestamp wrapping, and LitElement rendering carried forward from v3.0.2.

## [3.0.2] - 2026-04-25

### Fixed

- Map floating above HA navigation drawer / sidebar — added `isolation: isolate` to `:host` to cap Leaflet's z-index:1000 controls inside the card's stacking context (#95).
- Locale-aware timestamp wrapping to a second line in the bottom bar — added `white-space: nowrap`.
- Card producing no DOM after the TS target moved to ES2022 — set `useDefineForClassFields: false` so native class field semantics no longer shadow LitElement's `@property()` accessors. `moduleResolution` updated from deprecated `node` to `bundler`.

## [3.0.1] - 2026-04-24

### Added

- `disable_scroll` option — disables map pan/drag (mouse and touch) while keeping pinch-to-zoom active; lets mobile users swipe through the HA dashboard without moving the map

### Fixed

- `show_scale` had no effect — the Leaflet scale control was never added to the map despite the option being present in config and the editor toggle being wired. Now correctly renders the scale bar, respecting the HA instance unit system (metric / imperial).

## [3.0.0] - 2026-04-24

### Added

- NOAA/NWS radar source — US-only experimental mode using MRMS base reflectivity via `mapservices.weather.noaa.gov`
- Show Snow option — includes or excludes snow in RainViewer precipitation tiles
- Rate-limit banner — visible indicator when the API tile quota is temporarily exhausted
- Save map center in edit mode — pan/zoom the card while editing and click the overlay button to write `center_latitude`, `center_longitude`, and `zoom_level` back to config without manually entering coordinates
- Marker icon options — `default`, `entity_picture`, and MDI icon types configurable per device (desktop / mobile)
- `show_color_bar` option — hide the RainViewer radar colour scale bar (default shown)
- `show_progress_bar` option — hide the frame timeline bar (default shown)
- `map_style: Auto` — follows OS dark/light mode via `prefers-color-scheme`; map reinitialises automatically when the system theme changes at runtime
- `double_tap_action` — configurable double-tap/double-click action: built-in shortcuts (`recenter`, `toggle_play`) or any standard HA action object (`navigate`, `call-service`, etc.)
- Scrubbable timeline — click or drag the progress bar to seek to any frame; dragging pauses playback, releasing resumes it
- Locale-aware frame timestamp — uses `Intl.DateTimeFormat` with the browser locale, so 12 h (AM/PM) or 24 h is chosen automatically per the user's regional settings

### Changed

- **Breaking: Leaflet is now bundled.** `leaflet.js`, `leaflet.css`, `leaflet.toolbar.min.js`, and `leaflet.toolbar.min.css` are no longer distributed as separate files — they are compiled into `weather-radar-card.js`. Delete the old files from `www/community/weather-radar-card/` when upgrading.
- **Breaking: iframe removed.** The card is now a native LitElement / Shadow DOM component. No srcdoc, no opaque origin workarounds, proper HA theming integration.
- Leaflet.Toolbar2 replaced by a native `L.Control` implementation — removes the external toolbar dependency entirely.
- Animation engine replaced: frame switching is now driven by JavaScript opacity writes with CSS `transition` for crossfades, replacing the previous CSS `@keyframes` engine. More reliable across all browsers in Shadow DOM context.
- Map auto-selects `Light` (CARTO) for English-language HA instances in light mode and `OSM` for all other languages; `map_style: Auto` extends this with dark-mode awareness.
- Marker defaults to HA home location (`hass.config.latitude/longitude`) rather than the card's `center_latitude` — changing the map center no longer moves the marker.
- Navigation settle delay reduced from 500 ms to 100 ms.

### Fixed

- Animation flash-on-load caused by duplicate `_initRadar` runs sharing the same frame generation counter
- `_updateRadar` crash when the RainViewer API returns an empty frame list
- `_updateRadar` mutations continuing after card teardown (missing generation guard)
- `once('load')` callback in `_updateRadar` running after `clear()` with no teardown guard
- `resolveCoordinate` treating coordinate `0` (equator / Prime Meridian) as falsy and substituting the fallback value
- Mobile marker icon defaulting to `entity_picture` when not explicitly configured
- `visibilitychange` listener accumulating on `document` across card reinitializations (never removed)
- Worker Blob URL never revoked on `clear()`
- Editor direct mutation of `@state` config via `delete` instead of spreading to a new object

## [2.2.0] - 2026-01-05

### Changed

- **CRITICAL**: Replaced deprecated Rollup build plugins with modern @rollup/* equivalents
  - Migrated from rollup-plugin-babel to @rollup/plugin-babel
  - Migrated from rollup-plugin-commonjs to @rollup/plugin-commonjs
  - Migrated from rollup-plugin-node-resolve to @rollup/plugin-node-resolve
- Updated build tooling to latest versions
  - Rollup: 2.79.1 → 4.31.0
  - TypeScript: 4.8.3 → 5.7.3
  - ESLint: 7.32.0 → 8.57.1
  - Prettier: 2.7.1 → 3.4.2
  - @rollup/plugin-json: 4.1.0 → 6.1.0
  - @rollup/plugin-terser: 0.4.4 (replaces rollup-plugin-terser)
  - @typescript-eslint packages: 5.38.1 → 8.19.1
- Updated framework dependencies
  - Lit: 2.2.2 → 3.3.2
  - home-assistant-js-websocket: 5.11.1 → 9.4.0
- Migrated to ES modules (added "type": "module" to package.json)
- Renamed .eslintrc.js to .eslintrc.cjs for CommonJS compatibility

### Fixed

- Performance: Fixed shouldUpdate() to use proper change detection instead of always returning true
- Security: Added JSON.stringify() to all config value injections to prevent potential template injection
- Build: Added proper ES module imports with .js extensions for Rollup 4.x compatibility
- Build: Added createRequire for require.resolve() usage in ES modules

### Security

- Zero vulnerabilities detected after dependency updates
- Improved security with proper escaping of configuration values in iframe templates

## [2.1.1] - 2024

### Added

- Entity attribute support for dynamic coordinate tracking
- Mobile device detection for coordinate overrides
- Configurable height and width options for the card

### Changed

- Updated maintainer information (John Pettitt)

## [2.1.0] - 2022-09-14

### Fixed

- Fixed compatibility with Home Assistant 2022.11 breaking changes
- Updated Leaflet to 1.9.1

## [2.0.4] - 2022

### Added

- Imperial units support - card displays miles in scale when HA is set to imperial
- Extra attribution links in footer
- Card title support

### Fixed

- Map style exception handling
- Attribution links

### Changed

- Updated default location and zoom level
- Removed radar locations and geofence features

## Earlier Versions

For changes in versions prior to 2.0.4, please refer to the git commit history.

[Unreleased]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-rc2...HEAD
[3.6.0-rc2]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-rc1...v3.6.0-rc2
[3.6.0-rc1]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-beta2...v3.6.0-rc1
[3.6.0-beta2]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-beta1...v3.6.0-beta2
[3.6.0-beta1]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-alpha4...v3.6.0-beta1
[3.6.0-alpha4]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-alpha3...v3.6.0-alpha4
[3.6.0-alpha3]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-alpha2...v3.6.0-alpha3
[3.6.0-alpha2]: https://github.com/Makin-Things/weather-radar-card/compare/v3.6.0-alpha1...v3.6.0-alpha2
[3.6.0-alpha1]: https://github.com/Makin-Things/weather-radar-card/compare/v3.5.0...v3.6.0-alpha1
[3.5.0]: https://github.com/Makin-Things/weather-radar-card/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/Makin-Things/weather-radar-card/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/Makin-Things/weather-radar-card/compare/v3.2.0-beta...v3.3.0
[3.2.0]: https://github.com/Makin-Things/weather-radar-card/compare/v3.1.3-beta...v3.2.0-beta
[3.1.3]: https://github.com/Makin-Things/weather-radar-card/compare/v3.1.2...v3.1.3-beta
[3.1.2]: https://github.com/Makin-Things/weather-radar-card/compare/v3.1.1...v3.1.2
[3.1.1]: https://github.com/Makin-Things/weather-radar-card/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/Makin-Things/weather-radar-card/compare/v3.0.2...v3.1.0
[3.0.2]: https://github.com/Makin-Things/weather-radar-card/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/Makin-Things/weather-radar-card/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/Makin-Things/weather-radar-card/compare/v2.2.0...v3.0.0
[2.2.0]: https://github.com/Makin-Things/weather-radar-card/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/Makin-Things/weather-radar-card/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/Makin-Things/weather-radar-card/compare/v2.0.4...v2.1.0
[2.0.4]: https://github.com/Makin-Things/weather-radar-card/releases/tag/v2.0.4
