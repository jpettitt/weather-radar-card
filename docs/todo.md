# Weather Radar Card — Backlog

Backlog of design notes for shipped and proposed work. Items marked ✅ are
released; remaining unchecked items are open ideas.

## Multi-marker Support ✅ — shipped in 3.1.0

Complete redesign of the marker system supporting multiple markers, entity-based
positions, and automatic map tracking. **Breaking change** — single-marker
config fields are deprecated and auto-migrated in memory on load.

### Track resolution rules

Each marker can carry a `track` option. On every `hass` update the card evaluates
which marker (if any) should be used to auto-centre the map, using this priority
order:

1. **`track: entity` on a `person.*` entity** whose `user_id` matches the current
   logged-in HA user → highest priority. "I am this person, follow me."
2. **`track: entity` on any other entity** (e.g. `device_tracker.*`) → second
   priority. The device is tracked for all viewers regardless of who is using it
   or logged in. Overridden only by a matching person in rule 1.
3. **`track: true`** → lowest always-on fallback. Any `track: entity` match from
   rules 1 or 2 overrides this.
4. Multiple markers at the **same priority level** → log a console warning and
   use the first one in the array.

### YAML format

```yaml
markers:
  - entity: person.john          # centres only when john is the logged-in user
    icon: entity_picture
    track: entity

  - entity: device_tracker.van   # always centres on the van for all viewers
    icon: mdi:car                #   overridden for john by the person rule above
    track: entity

  - entity: device_tracker.bike  # lowest-priority always-on fallback
    icon: mdi:bicycle
    track: true

  - latitude: -33.86             # static marker, no tracking
    longitude: 151.21
    icon: mdi:home
```

### Tasks

- [x] Marker config schema — `markers[]` array; `track: entity | true`;
  resolution priority described above
- [x] `Marker` interface (`latitude?`, `longitude?`, `entity?`, `icon?`,
  `icon_entity?`, `color?`, `track?`, `mobile_only?`); legacy fields kept on
  `WeatherRadarCardConfig` for migration only
- [x] Multi-marker rendering with live position updates on every hass change
- [x] Entity-based marker positions (`device_tracker.*`, `person.*`, `zone.*`,
  any entity with `latitude`/`longitude` attributes)
- [x] Track resolution with priority + tie-warning
- [x] Auto-migration in `setConfig()` — synthesises a `markers[]` from the old
  fields in memory; deprecation warning logged; same-string lat/lon entity pairs
  collapsed to a single `entity` field; `mobile_only: true` added to mobile
  variants
- [x] Default `zone.home` marker when `markers` is absent; `markers: []` opts out
- [x] Editor — list-based markers section; per-row entity / lat-lon / icon /
  track / colour / mobile-only controls; HA `ha-icon-picker` for icon
  autocomplete; auto-detect icon from selected entity
- [x] Marker clustering with spiderfy and home-cluster badge representation
- [x] README and CHANGELOG updates

---

## Scroll / Swipe Passthrough ✅ — shipped in 3.0.1

`disable_scroll` config option suppresses single-finger pan / mouse drag while
preserving pinch-to-zoom, so mobile users can scroll past the card.

### Tasks

- [x] `disable_scroll` config option (boolean, default `false`)
- [x] Disable Leaflet `dragging` on map init when option is on
- [x] Editor toggle in the Interaction section
- [x] README and CHANGELOG updates

---

## Other Backlog Items

### Open

- **Open-Meteo as an alternate wind source for global coverage.**
  The wind overlay landing in 3.6 (PR #133) is DWD-only — Germany +
  immediate neighbours via the ICON-D2 model. To extend the feature
  globally, add [Open-Meteo](https://open-meteo.com/) as a second
  source. They auto-pick the best regional model per location (DWD
  ICON in Europe, NOAA GFS for the Americas, JMA in Japan, ECMWF
  elsewhere), expose `wind_u_component_10m` / `wind_v_component_10m`
  in the same U/V form the existing layer expects, and crucially
  support **bulk lat/lon queries in a single HTTPS GET** — would
  collapse PR #133's 400-parallel-WMS-request burst per pan into 1
  batched JSON call.

  Implementation pattern: parallel `WIND_SOURCE_CAPS` table in a new
  `src/wind-source-caps.ts`, mirroring `src/source-caps.ts` for
  radar — each entry declaring native grid resolution, fetch
  strategy (`'wms-getfeatureinfo'` vs `'json-bulk'`), max points per
  request, and global / regional coverage. New `wind_source` config
  field with auto-pick default ("DWD if EU, Open-Meteo elsewhere"),
  matching the auto map-style behaviour we already do.

  Caveats: Open-Meteo is non-commercial use only (HACS distribution
  probably qualifies but verify current terms before shipping); free
  tier is 10k req/day per IP (with bulk batching, not even close to
  hitting it); resolution drops to ~28 km outside Europe vs DWD's
  native 2.2 km, but invisible at typical card zoom levels.

  Order: land #133 first (DWD-only baseline), then this PR adds the
  source abstraction without changing the EU experience.

- **Wind source registry — tiered alternatives to ICON-D2** — partially
  shipped. The `WindSource` registry in `src/wind-source-caps.ts` is
  live; the cache key in `WindGridFetcher` includes `source`; the editor
  has a Wind Data Source dropdown above Style/Density/Size; the cadence
  helper line is per-source. Adding a new source is now: caps-table
  entry + (if not WCS-text-plain) a parser variant.

  **Shipped — 3.6.1:**

  - ✅ `ndfd_wind` — NWS NDFD (HRRR + RAP + NAM + GFS forecaster blend) at
    2.5 km over CONUS / AK / HI / PR. Originally classified Tier 3 but
    research showed the NDFD GeoServer at `mapservices.weather.noaa.gov`
    serves WCS text/plain on the same shape as DWD's GeoServer — so it
    only needed an EPSG:3857 → degrees conversion (Mercator math) and a
    speed/direction → U/V band conversion. CORS open. Auto-defaults for
    fresh installs whose `hass.config.country === 'US'` (or whose lat/lon
    falls in the CONUS / AK / HI / PR bbox if country is unset).
  - ✅ `dwd_aicon` — DWD's AI-augmented variant of ICON-D2. Plug-compatible
    one-line caps-table addition (same WCS endpoint, same global 0.25°
    grid, same U/V bands). Confirmed identical-shape via DescribeCoverage.

  **Tier 2 — same fetcher, small adapter (~30 lines):**

  - `dwd__Icon_reg025_fd_pl_UV` — ICON pressure levels (250/500/700/850/925
    hPa). Needs an `elevation` subset axis. Same 0.25° grid as ICON-D2.
  - DWD wave-model winds (`dwd__Cwam_reg0013x0008_*` ~1.4 × 0.9 km North
    Sea / Baltic; `dwd__Ewam_reg005x010_fd_sl_UV10M` ~5.5 × 11 km covering
    NE Atlantic plus N Sea plus Baltic). **Marine-only** — no land
    coverage. Useful only for sailing-focused dashboards; would need a
    "this source has no land data" UX note to avoid confusing inland users.

  **Tier 3 — no finer-than-ICON-D2 deterministic wind product over land
  for Europe via DWD's public WCS.** Verified 2026-05-15:

  - ICON-EU (0.0625° native ~6.25 km) exposes Temp / QFF / TOTPREC but
    **no UV10M or SP10M/DD10M coverages**.
  - ICON-D2-EPS at native 0.02° (~2 km) exposes only ensemble probability
    products (`pVMAX10MgtX`, `FP`, `FPW`) — no deterministic U/V.
  - `dwd__BRD_1km_winddaten_10m` looked promising by name but is a **20-year
    climatology** ("Mittlere jährliche Windgeschwindigkeiten … 1981-2000"):
    static annual-mean field at 1 km for wind-turbine site planning, NOT
    a real-time forecast or observation. Unusable for the streamline overlay.
  - Conclusion: for finer-than-ICON-D2 real-time European wind we would
    have to leave DWD entirely (Météo-France AROME 1.3 km, MET Norway MEPS
    2.5 km Nordic, ECMWF HRES 0.1°). Each is ~100 lines of new fetch + parser.

  **Tier 3 (US) — different provider, new fetch impl + parser (~100 lines):**

  - NOAA HRRR direct (NCEP NOMADS, AWS Open Data, NCEI THREDDS) — finer
    3 km native, hourly updates, but the formats are GeoTIFF/NetCDF/GRIB
    (heavy in-browser parser). NDFD already gives 2.5 km CONUS via plain
    WCS text; HRRR direct is only worth it for sub-3-hour temporal
    resolution.

  **Tier 4 — bad fit (avoid):**

  - Open-Meteo — per-point only, no bbox API. Would undo the bulk-fetch
    win. The Open-Meteo backlog item above pre-dates the bulk-fetch
    refactor; revisit only if Open-Meteo adds a bbox endpoint.

  **Recommended order:** ICON pressure levels next if anyone asks for upper-
  level winds. Marine wave-model winds only with an explicit sailing-mode
  UX. External-provider sources (AROME, ECMWF, HRRR direct) deferred
  unless a user requests them.

- **Real-time per-user layer control panel.** UI for toggling individual
  overlays (radar, wildfires, NWS alerts, lightning, wind, DWD coverage,
  range rings, markers) in real time, without re-opening the editor or
  reloading the dashboard. State persists per-user across browsers and
  devices.

  **Storage dependency: shipped.** The `ViewerState` framework (per-user
  state via HA's frontend-storage WebSocket API, per-card identity nonce
  in YAML) landed dormant in 3.6.5 ([#175](https://github.com/jpettitt/weather-radar-card/pull/175))
  and was first exercised by the adjustable playback-speed toggle in
  3.7.0-alpha1 ([#157](https://github.com/jpettitt/weather-radar-card/pull/157)).
  The framework + identity + sparse-override semantics + WS hydrate are
  proven.

  **What's still pending:** the layer-control panel UI itself (an on-map
  `mdi:layers` button → expanding panel listing the active overlays with
  per-row toggles) plus the per-overlay wiring (construct / tear down
  layers based on the override-or-YAML resolution).

  Full design in [`layer-control-design.md`](layer-control-design.md) —
  UX, composition semantics (subset of YAML-authorised layers), storage
  key shape, edge cases.

### Investigated, won't pursue

- **Custom HACS icon** ([#126](https://github.com/jpettitt/weather-radar-card/issues/126)).
  HACS doesn't render custom icons for Lovelace plugins — verified
  empirically by checking the HACS frontend tab: zero plugins in the
  default store carry one, and the
  [home-assistant/brands](https://github.com/home-assistant/brands) repo
  path that works for HACS *integrations* (`custom_integrations/<slug>/icon.png`)
  isn't wired up for the *plugins* category. Submitting to brands would
  be a no-op until / unless HACS adds the support upstream.
  Practical workaround that other authors use: prefix the card name in
  `customCards` with an emoji (e.g. `📡 Weather Radar Card`) — no
  external PR, guaranteed to render. We've held off on that to keep the
  card name canonical; revisit if the issue gets attention.

- **TypeScript module augmentation for Leaflet** — code-health pass.
  About 25 source files carry `/* eslint-disable @typescript-eslint/no-explicit-any */`
  to access Leaflet APIs we legitimately need (`getContainer()`,
  `_tilePending`, project-internal extensions like `_wrcCfg`). The
  principled fix is a `declare module 'leaflet'` augmentation block
  declaring our extension fields and exposing the private methods we
  rely on as typed. Replacing the `any` casts with proper types
  catches typos at compile time and removes a real source of latent
  bugs without behavioural change.

  Identified by Gemini code review (issue #1). Estimated ~1-2 days of
  mechanical work; no user-facing impact, so deferred to a dedicated
  code-health release rather than slipped into a feature PR.

- **Web Worker for the DWD pixel filter** — perf, conditional on profiling.
  `applyPixelFilter` in `src/fetch-tile-layer.ts` does a pixel-pass
  scan on the main thread to strip DWD's baked-in coverage mask.
  Each tile is ~65K pixels × ~13 ops = ~7-13ms per refresh across a
  typical 10-20 tile viewport. That's well under a frame budget and
  only runs at 5-minute refresh ticks (not per animation frame), so
  the absolute cost is small.

  Moving to OffscreenCanvas + a Worker would cleanly remove it from
  the main thread, BUT the inter-thread transfer of pixel buffers
  (~256 KB per tile) likely erases the win for this small payload.
  **Don't act until profiling shows a real spike** — if
  `performance.measure` flags >50ms here on representative hardware,
  THEN consider the Worker. The `wind-flow-overlay.ts` per-frame
  canvas work at 15 fps is a bigger perf fish for the same effort.

  Identified by Gemini code review (issue #2).

- **WindGridFetcher cancellation via consumer reference-counting** —
  pair with the layer-control panel work.
  The other four fetch sites (`fetch-tile-layer.ts`, `wildfire-layer.ts`,
  `nws-alerts-layer.ts`, `radar-player.ts`) gained `AbortController` in
  3.6.2 to stop superseded fetches from completing on the wire.
  `WindGridFetcher` was intentionally skipped because it
  request-coalesces across multiple callers (both wind-icon and
  wind-flow overlays share one in-flight fetch). Aborting it correctly
  needs reference-counting: only abort when the LAST consumer has lost
  interest, not when any one of them does. The 60-second cache TTL
  provides similar bandwidth conservation in practice.

  When the layer-control panel adds explicit per-card cancellation
  semantics — the user toggles wind off on a card mid-fetch — this
  becomes a real requirement. Until then, the cache TTL is fine.

### Shipped

- Clickable / draggable timeline ✅
- AM / PM vs 24 h time display (browser locale) ✅
- Configurable double-tap action ✅
- Hide progress bar option ✅
- Hide / show colour bar option ✅
- Dynamic map style (Auto) ✅
- Marker clustering ✅
- Multi-marker support ✅
- DWD radar source ✅ — 3.4.0
- Crossfade alpha-dip fix + smooth_animation ✅ — 3.4.0
- `smooth_overlap` tunable crossfade overlap + editor mutual gating ✅ — 3.4.0-beta2 / 3.5.0
- Wildfire perimeter overlay (US-only) ✅ — 3.5.0
- NWS watches & warnings overlay (US-only) ✅ — 3.5.0
- Hazard Overlays editor subpage ✅ — 3.5.0
- Region-warning utility for non-US installs ✅ — 3.5.0
- Time-based playback range (`past_minutes` / `forecast_minutes` / `frame_stride_minutes`) replacing `frame_count` — source-agnostic via SOURCE_CAPS table; auto-migrates legacy configs ✅ — 3.5.0
- WYSIWYG map editing (back-prop pan/zoom into editor Lat/Long fields) ✅ — 3.5.0
- Build timestamp in console signon (cache-bust verification aid) ✅ — 3.5.0
- Loading spinner + `show_loading_spinner` config (contributed by @genericJE, [#124](https://github.com/jpettitt/weather-radar-card/pull/124)) ✅ — 3.5.0
- Now marker on the progress bar (contributed by @genericJE, [#125](https://github.com/jpettitt/weather-radar-card/pull/125)) ✅ — 3.5.0
- Dark / satellite map scale text-shadow fix (contributed by @genericJE, [#123](https://github.com/jpettitt/weather-radar-card/pull/123)) ✅ — 3.5.0
- `npm run build` regenerates `.js.gz` so HA can't serve a stale gzipped bundle ✅ — 3.5.0
- DWD-outside-coverage region banner — visible UI cue replacing the developer-only `console.warn` from 3.4.0 ✅ — 3.5.0
- Markercluster `_bounds`-undefined race in the resize path (RAF defer + `try/catch`) ✅ — 3.5.0
- README split into a slim landing page + focused docs under `docs/` (Configuration, Data Sources, Hazard Overlays, Markers, Examples, Animation architecture) ✅ — 3.5.0
- `animation.md` rewritten to match the current two-slot + delayed-fade-out model ✅ — 3.5.0
- 11-language i18n parity sweep (100% key coverage, stale `frame_count` keys dropped) ✅ — 3.5.0
- Lightning overlay (Blitzortung integration) — bolt + pulse for first 30 s, then a Blitzortung-style coloured + sign on a two-pane outline-vs-fill split (so dense storm clusters read clean instead of black-blob). Card-side max-age cap (default 30 min, distinct from the integration's own setting). Editor toggle disabled with tooltip when integration not loaded. ✅ — 3.6.0
- Wind overlay — barbs / arrows / animated streamlines from DWD's ICON-D2 model. Bulk WCS fetch with 60 s coalescing cache. ✅ — 3.6.0
- Wind source registry — `WindSource` caps table in `src/wind-source-caps.ts`; `ndfd_wind` (NWS NDFD 2.5 km CONUS/AK/HI/PR) + `dwd_aicon` (DWD AI-augmented ICON-D2). Auto-defaults `ndfd_wind` for fresh US installs. ✅ — 3.6.1
- AbortController on tile + data fetches (`fetch-tile-layer`, `wildfire-layer`, `nws-alerts-layer`, `radar-player`) so superseded fetches don't complete on the wire ✅ — 3.6.2
- `ha-textfield` → `ha-input` migration after invisible-editor-input regression on current HA ✅ — 3.6.3
- Lightning strikes — newest renders on top within each pane (z-index by timestamp) ([#171](https://github.com/jpettitt/weather-radar-card/pull/171)) ✅ — 3.6.4
- Tablet-friendly progress-bar touch target via `progress_bar_touch_height` YAML option (contributed by [@cgjolberg](https://github.com/cgjolberg), [#172](https://github.com/jpettitt/weather-radar-card/pull/172)) ✅ — 3.6.4
- Lightning strike distance now uses HA's preferred length unit (km / mi) ([#176](https://github.com/jpettitt/weather-radar-card/pull/176)) ✅ — 3.6.5
- Per-user state framework on `main` — `src/viewer-state.ts` wraps HA's frontend storage WebSocket API; per-card identity nonce auto-minted into YAML. Dormant on landing; first consumer shipped in 3.7.0-alpha1. ([#175](https://github.com/jpettitt/weather-radar-card/pull/175)) ✅ — 3.6.5
- DWD/NOAA region-warning auto-suppress when the map's actual coverage is visible ([#180](https://github.com/jpettitt/weather-radar-card/pull/180)) ✅ — 3.6.5
- Adjustable playback speed via toolbar button + editor dropdown — cycles ¼× / ½× / 1× / 2× / 4×. Optional per-user persistence via `viewer_layer_control` admin opt-in (first exercise of the viewer-state framework). Contributed by [@genericJE](https://github.com/genericJE) ([#157](https://github.com/jpettitt/weather-radar-card/pull/157)) ✅ — 3.7.0-alpha1
- Motion compensation for radar transitions — opt-in `motion_compensation: true`. Pyramidal Lucas-Kanade optical flow on a distance-from-white intensity channel; source-agnostic across DWD / RainViewer / NOAA. Built on top of [@genericJE](https://github.com/genericJE)'s [#156](https://github.com/jpettitt/weather-radar-card/pull/156). ([#183](https://github.com/jpettitt/weather-radar-card/pull/183)) ✅ — 3.7.0-alpha2
- NOAA `intervalMin` bump 5 → 10 — matches empirical publication cadence on the eventdriven WMS service, eliminates duplicate frames at the source ✅ — 3.7.0-alpha2
- Stale-frame full re-init on resume from long-hidden / device-sleep windows ✅ — 3.7.0-alpha2
- Local Docker HA testbed (`npm run ha:up`) replacing the abandoned `.devcontainer/` ✅ — post-3.4.0

## Canvas rendering for lightning + hazard layers

Motivation (observed live on alpha2, 2026-06-09): with `lightning_max_age_minutes: 20`
during an active storm, every strike is two DOM markers with inline SVG —
hundreds of nodes that make pan/zoom and editor-open heavy. The time-sliced
backlog drain (3.7.0-alpha3) fixed the open-freeze; canvas rendering is the
structural fix for steady-state DOM weight.

Design sketch (clickability confirmed feasible for both):

- **Hazard polygons (NWS alerts, wildfire perimeters)**: near-free — pass a
  shared `L.canvas()` renderer to the existing `L.polygon`/`L.geoJSON` layers.
  Leaflet's canvas renderer keeps its own hit-testing, so popups and click
  handlers keep working unchanged. Mostly a constructor-options change plus
  regression-testing popup behaviour.
- **Lightning strikes**: custom `L.Layer` painting strikes into one canvas
  per map (redraw on move/zoom/age-tick; age-based fade becomes a cheap
  global-alpha pass instead of per-marker style writes). Markers lose DOM
  hit-testing, so add a DIY hit test: map `click` → nearest strike within
  ~10 px tolerance → open the existing popup content at that latlng.
  ~200–250 lines incl. tests; the strike data model and `_collectStrikes`
  pipeline stay as-is.
