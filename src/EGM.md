# src

## Overview

All card source: a Lit + Leaflet Lovelace card in TypeScript. Rollup builds two
bundles from here (see [rollup.config.js](../rollup.config.js)):

- `weather-radar-card.ts` → `dist/weather-radar-card.js`, the card that HA
  loads.
- `vector-basemap-layer.ts` → `dist/weather-radar-card-maplibre.js`,
  MapLibre. The card loads this file only for `map_style: MapTilesVector`, or
  for the `Satellite` place labels when HA's `map_tiles` integration is loaded
  and `low_power_mode` is off.

The card element owns one Leaflet map. Onto it, it adds a `RadarPlayer`
(radar frame fetch and crossfade), a `RadarToolbar`, markers, `ViewPresets`
and the optional overlays (NWS alerts, wind, wildfires, lightning). For the
layer stack and crossfade design, read
[docs/animation.md](../docs/animation.md) before you change playback, fetch or
opacity code. Each overlay has a design doc in [docs/](../docs/).

## Interface

### Card and config

- `weather-radar-card` (`WeatherRadarCard`, `weather-radar-card.ts`): the
  Lovelace card. `setConfig`, `getCardSize`, `getGridOptions`,
  `static getConfigElement`, `static getStubConfig`.
- `weather-radar-card-editor` (`WeatherRadarCardEditor`, `editor.ts`): the
  visual editor (`ha-selector` form).
- `WeatherRadarCardConfig`, `Marker`, `ViewPreset`, `CoordinateConfig`
  (`types.ts`): the config shape. Deprecated fields (`frame_count`,
  `dwd_forecast_hours`, the single-marker fields) stay in the type for
  migration.
- `migrateConfig` (`marker-utils.ts`) and `isOnlyKeysChanged`
  (`config-diff.ts`): config migration and the diff that the `setConfig` fast
  paths use.
- `CARD_VERSION`, `BUILD_TIMESTAMP`, `Z_*` z-index constants,
  `HAZARD_MARKER_PANE` (`const.ts`).
- `resolveCardLayout`, `isSectionHeightPinned` (`card-layout.ts`),
  `cardColumns`, `sectionCardWidth` (`section-width.ts`), `haAtLeast`
  (`ha-version.ts`).

### Radar playback and tiles

- `RadarPlayer`, `RadarFrame`, `FrameStatus`, `FRAME_FETCH_WINDOW`,
  `planFetchWindow` (`radar-player.ts`): frame lists, fetch scheduling, the
  two-slot crossfade.
- `RadarToolbar`, `SPEED_STEPS` (`radar-toolbar.ts`): playback controls.
- `SOURCE_CAPS`, `getSourceCaps`, `getEffectiveTimeRange` (`source-caps.ts`);
  `fetchNoaaFrameTimes` (`noaa-frame-list.ts`); `planForecastRefresh`,
  `fetchLatestRun` (`forecast-refresh.ts`, DWD model-run choice).
- `FetchTileLayer`, `FetchWmsTileLayer` (`fetch-tile-layer.ts`): Leaflet tile
  layers that load with `fetch` and can be aborted.
- `sharedFetch`, `memoGet`, `persistedGet`, `storeTile` (`tile-cache.ts`): the
  tile cache, an in-memory memo plus IndexedDB, with in-flight de-duplication.
- `rainviewerLimiter`, `noaaLimiter`, `dwdLimiter` (`rate-limiters.ts`),
  `RateLimiter` (`rate-limiter.ts`); `withTimeout` and the `*_TIMEOUT_MS`
  values (`fetch-timeout.ts`).
- `estimateMotionLk`, `LkWorkerClient` (`lk-worker.ts`),
  `lucasKanadePyramidal` (`lk.ts`): motion compensation.

### Overlays and basemaps

- `NwsAlertsLayer` (`nws-alerts-layer.ts`) with `categoryForEvent`
  (`nws-alert-categories.ts`), `colorForEvent` (`nws-alert-colors.ts`) and
  the zone-shape store `readZone`, `writeZone`, `sweepZones`
  (`zone-store.ts`).
- `WindOverlay` (barbs and arrows, `wind-overlay.ts`), `WindFlowOverlay`
  (streamlines, `wind-flow-overlay.ts`), `windGridFetcher`
  (`wind-grid-fetcher.ts`), `WIND_SOURCE_CAPS` (`wind-source-caps.ts`).
- `LightningLayer` (`lightning-layer.ts`, `lightning-helpers.ts`).
- `WildfireLayer` (`wildfire-layer.ts`) and `findInciwebPage` (`inciweb.ts`).
- `LayerToggleBar`, `OverlayVisibility` (`layer-toggles.ts`): the viewer's
  overlay toggles.
- `getBasemapTiles`, `effectiveBasemapStyle`, `basemapCredits`
  (`basemap-styles.ts`): raster basemaps.
- `startVectorBasemap` (`vector-basemap.ts`), `createVectorLayer`
  (`vector-basemap-layer.ts`, the MapLibre bundle entry),
  `defineMaplibreLayer` (`maplibre-leaflet-layer.ts`), `startMapTilesToken`
  (`map-tiles-token.ts`): the HA `map_tiles` vector basemap and the
  `Satellite` vector labels (`labelsOnly`).
- `sharedCanvasRenderer` (`shared-canvas-renderer.ts`), `hazardMarkerPane`
  (`hazard-marker-pane.ts`).

### Viewer state and presets

- `ViewerState` (`viewer-state.ts`): saves each viewer's preferences per card
  (see [docs/viewer-state-api.md](../docs/viewer-state-api.md)).
- `ViewPresets`, `recenterRequested`, `PRESET_FOCUS_EVENT`,
  `PRESET_MAP_EVENT` (`view-presets.ts`): the re-centre rotation.

### Subdirectories

- [localize/](./localize/EGM.md): `localize()` and the language files.

## Invariants

### Card lifecycle

- `setConfig` assigns `_config` synchronously. A structural change only
  schedules a rebuild (teardown plus `_initMap`) after a 250 ms trailing
  debounce, and never on a detached card. The editor sends `config-changed`
  on each keystroke.
- Four fast paths keep the map: view back-propagation
  (`center_latitude`/`center_longitude`/`zoom_level`), `playback_speed`,
  `presets`/`preset_timeout` (when `recenterRequested` does not change) and
  `_layer_state_id`. A new key that changes only at run time needs an entry in
  the matching allow-list, or each change causes a full rebuild.
- Do not rebuild map state on each `hass` update. `updated()` rebuilds only
  when the effective map style changes (a dark-mode flip). Overlays re-render
  only when their per-feature decisions change, and they defer while a popup
  is open, so a `hass` update cannot close it.
- `shouldUpdate` passes only `_config`, `hass`, `editMode` and `layout`
  changes, so a bare `requestUpdate()` has no effect. A reconnect must call
  `_initMap()` directly.
- `disconnectedCallback` always calls `_teardown()`, and it disposes
  `ViewerState`. `_overlayVisibility` is stored on the element, not on the
  map, so the viewer's toggles stay through a rebuild.
- HA calls `setConfig` before it sets `hass`. `ViewerState` is created lazily
  and idempotently, and created again after a reconnect. It stays dormant
  unless `viewer_layer_control` is on.
- Map setup stays synchronous: create layers at once and put async results
  (tokens, styles) into the live layer. Do not make layer creation wait for a
  network request. The rule comes from the `leaflet.markercluster` init race
  (issue #110); see the comment in `map-tiles-token.ts`.

### Fetching and caching

- The rate limiters and `windGridFetcher` are module-level singletons, so
  their state stays through rebuilds and all cards in a tab share them. Do
  not make them per-card.
- Do not set `User-Agent` in a browser `fetch()`. It is a forbidden header,
  and the browser rejects the request.
- Each fetching overlay increments a generation counter on each fetch and
  drops responses from an older generation. NWS alerts and wildfires also
  abort the previous `AbortController`. The wind overlays do not abort: they
  share the `windGridFetcher` cache, and only its 60 s timeout aborts a
  request. Lightning does not fetch.
- Pause and resume differ per layer:
  - NWS alerts and wildfires: `pause()` keeps only the due time, and nothing
    re-arms a timer while the layer is paused. `resume()` waits only for the
    remaining time. `preload_while_hidden` disables both.
  - `WindOverlay` and `WindFlowOverlay`: `resume()` refreshes at once and
    re-arms the half-hour tick. `WindFlowOverlay.pause()` always stops the
    animation, also with `preload_while_hidden`.
  - `LightningLayer`: `pause()` stops the 30 s age timer and ignores
    `preload_while_hidden`. `resume()` runs an age pass at once.
- An NWS alert stops at the earlier of `expires` and `ends` (`alertOverAt`).
  `alerts/active` returns alerts after `expires`.
- NWS zone requests use a pool (24 at a time, minimum 4). After a burst block
  (a 403 without CORS headers), the pool backs off from 5 s up to 5 min and
  resumes at half size. The NWS layer starts no zone requests and does no
  rendering while the map moves (iOS Safari memory).
- Zone shapes: IndexedDB `weather-radar-card`/`nws-zones`, 30-day TTL,
  12,000-entry cap. Change `ZONE_FORMAT` when the record format changes.
- MapLibre must never be imported statically. `vector-basemap.ts` loads it
  through a computed `import()` URL with `?v=<content hash>` so that HA's
  service worker does not serve an old file. The vector basemap needs WebGL2
  and falls back to raster on any failure.
- Alert and fire polygons draw through `sharedCanvasRenderer(map)`.
  `clear()` must not remove the shared renderer.

### Layer stack

Map panes, by z-index from low to high:

| Pane                  | z-index | Contents                                                                   |
| --------------------- | ------- | -------------------------------------------------------------------------- |
| Leaflet `tilePane`    | 200     | Basemap (layer z-index `Z_BASEMAP` 0) and raster labels (`Z_LABELS` 2)     |
| `wrcRadar`            | 240     | Radar frames (layer z-index `Z_RADAR_BASE` 100, plus 1 for each crossfade) |
| `wrcWindFlow`         | 250     | Wind streamlines                                                           |
| `dwd-coverage-mask`   | 350     | DWD coverage mask                                                          |
| Leaflet `overlayPane` | 400     | Alert and fire polygons                                                    |
| `wrc-lightning`       | 410     | Lightning canvas                                                           |
| `wrcHazardMarkers`    | 420     | Wind arrows and barbs, fire icons                                          |
| `wrcVectorLabels`     | 450     | Vector place labels (no pointer events)                                    |
| Leaflet `markerPane`  | 600     | User markers                                                               |

## Side Effects

- **Custom elements:** registers `weather-radar-card` and
  `weather-radar-card-editor`, and adds an entry to `window.customCards`.
- **Network (radar):** `api.rainviewer.com`, `tilecache.rainviewer.com`,
  `opengeo.ncep.noaa.gov` and `mapservices.weather.noaa.gov` (NOAA WMS),
  `maps.dwd.de` (DWD WMS).
- **Network (overlays):** `api.weather.gov` (alerts and zones),
  `services3.arcgis.com` (WFIGS fires), `inciweb.wildfire.gov` (page
  probes), `maps.dwd.de` and `mapservices.weather.noaa.gov` WCS (wind).
  Basemap tiles come from CARTO, OSM, Esri, HA's `/api/map_tiles/` proxy or
  `custom_tile_url`.
- **Network (HA instance):** the vector basemap fetches
  `/static/map/{light,dark,urls}.json` and the RTL text plugin, and loads
  `weather-radar-card-maplibre.js?v=<hash>` from next to the card. Lightning makes no HTTP calls. It reads Blitzortung
  `geo_location.*` entities from `hass.states`.
- **HA websocket:** `frontend/get_user_data` and `frontend/set_user_data`
  (`ViewerState`, key prefix `weather-radar-card.viewer-state.`, writes
  debounced 500 ms); `map_tiles/access_token` (while a MapTiles basemap or
  the Satellite vector labels are in use: every 20 min, on each websocket
  reconnect, and 60 s after a failure).
- **Storage:** IndexedDB `weather-radar-card-tiles` (tiles) and
  `weather-radar-card`/`nws-zones` (zone shapes). `localStorage` keys
  `weather-radar-card:stride-phase:*` and
  `weather-radar-card:dwd-forecast-run:*`, plus a read of
  `selectedLanguage` (`localize`). Each zone sweep (on each
  `NwsAlertsLayer.start()`) scans `localStorage` and removes old zone keys
  (`wrc-zone-v1:`, `wrc1z:`).
- **Workers:** two Blob-URL Web Workers. One runs motion estimation
  (`lk-worker.ts`). The other runs the radar player's update timer so that it
  keeps time in background tabs, with a `setTimeout` fallback.
- **Window:** listens for `weather-radar-editor-opened`/`-closed` and
  `PRESET_FOCUS_EVENT`. Sends `weather-radar-center-update` and
  `PRESET_MAP_EVENT`. Globals `window.__weatherRadarCardEditorCount` (editor
  mount count) and `window.__weatherRadarPresetFocus` (the preset the editor
  shows).
- **Timers and observers:** rebuild debounce (250 ms), user-move grace
  (500 ms), post-move reload, radar player timers (update, rate-limit retry,
  init retry, fade-out), overlay refresh chains, a lightning age tick (30 s),
  wind half-hour refresh, fetch timeouts.
  `IntersectionObserver` and `visibilitychange` pause hidden cards.
  `ResizeObserver` resizes the map. With `map_style: Auto`, a
  `prefers-color-scheme` listener rebuilds the map when the OS theme changes.
  `hass.themes.darkMode` takes priority when HA sets it.
- **Map panes:** creates `wrcRadar`, `wrcWindFlow`, `dwd-coverage-mask`,
  `wrc-lightning`, `wrcHazardMarkers` and `wrcVectorLabels` (see the table
  above).

## Verification

- Run: `npm test` (Vitest, specs in [tests/](../tests/); use Node 24, see
  [.nvmrc](../.nvmrc)).
- Run: `npm run build` (ESLint over `src/*.ts`, then both Rollup bundles).
  HA loads `dist/`, so rebuild after any change to `src/`.
