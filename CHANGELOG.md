# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Loading spinner** — a small rotating indicator now sits in the centre of the bottom bar (between the timestamp and attribution) while radar tiles are being fetched. Visible during the initial load, after pan/zoom reload, and the periodic 5-minute refresh; hidden when only cached frames are cycling. Honours `prefers-reduced-motion` (the dot stays visible but does not spin).
- **`show_loading_spinner` config option** — toggles the loading spinner described above. Defaults to `true`; set to `false` to suppress it on cards where the brief load is imperceptible and the indicator would only add noise.

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

[Unreleased]: https://github.com/Makin-Things/weather-radar-card/compare/v3.3.0...HEAD
[3.3.0]: https://github.com/Makin-Things/weather-radar-card/compare/v3.1.2...v3.3.0
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
