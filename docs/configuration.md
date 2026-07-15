# Configuration

All options can be configured using the GUI editor — there is no need to edit YAML directly. The options below are listed for reference and for users who prefer YAML or need fine-grained control beyond the editor (e.g. oversize `past_minutes` on DWD, the streamline colour overrides, etc.).

## Options table

| Name                      | Type            | Requirement    | Description                                                                                                                                                                                                                                            | Default                               |
|---------------------------|-----------------|----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------|
| type                      | string          | **Required**   |                                                                                                                                                                                                                                                        | must be `'custom:weather-radar-card'` |
| data_source               | string          | **Optional**   | Radar tile source (see [Data Sources](data-sources.md))                                                                                                                                                                                                | `'RainViewer'`                        |
| past_minutes              | number          | **Optional**   | How much history to show. Source-specific defaults; capped at the source's API limit. Editor offers 20 min – 12 h (DWD) / 2 h (NOAA, RainViewer). YAML can exceed the editor cap up to the API limit (DWD: 84 h).                                      | source-specific                       |
| forecast_minutes          | number          | **Optional**   | How much forecast to include in the playback. Only honoured by sources that have a forecast (currently DWD: 0 / 60 / 120). Editor hides the row entirely for sources without a forecast.                                                               | source-specific                       |
| frame_stride_minutes      | number          | **Optional**   | Custom frame interval. NOAA exposes it as the editor **Frame interval** dropdown (2/5/10 min, snapped to the nearest step); for RainViewer/DWD a YAML-only escape hatch to trim frame count on large `past_minutes` ranges.                            | source's native interval              |
| frame_count               | number          | **Deprecated** | Replaced in 3.5 by `past_minutes`. Migrated to `past_minutes` when set alone; **ignored** when `past_minutes` or `frame_stride_minutes` is also set (those win, and the card logs a console warning). Removed in a future major.                       | —                                     |
| dwd_layer                 | string          | **Optional**   | DWD-only. WMS layer name override. Default `Niederschlagsradar` (mm/h). Set to `Radar_wn-product_1x1km_ger` for reflectivity (dBZ) plus +2 h nowcast frames. Auto-switched to the latter when `forecast_minutes > 0` unless explicitly set.            | `'Niederschlagsradar'`                |
| dwd_time_override         | string          | **Optional**   | DWD-only. ISO timestamp to anchor frames at a fixed point in the past instead of "now" — useful for verifying the overlay renders when current weather is dry.                                                                                         | unset                                 |
| dwd_forecast_hours        | number          | **Deprecated** | Replaced in 3.5 by `forecast_minutes`. Auto-migrated to `forecast_minutes = dwd_forecast_hours × 60` on load.                                                                                                                                          | —                                     |
| frame_delay               | number          | **Optional**   | Milliseconds to display each frame                                                                                                                                                                                                                     | `500`                                 |
| restart_delay             | number          | **Optional**   | Extra milliseconds to hold the last frame before looping                                                                                                                                                                                               | `1000`                                |
| playback_speed            | number          | **Optional**   | Default playback-speed multiplier applied to `frame_delay`. The toolbar's speed button (¼× / ½× / 1× / 2× / 4×) cycles from this default; with `viewer_layer_control` on, each viewer's chosen speed is persisted and overrides it.                    | `1`                                   |
| start_paused              | boolean         | **Optional**   | Start paused on the latest radar frame instead of auto-playing the animation loop. The displayed frame still refreshes automatically as new data arrives. Tap the play button or use `double_tap_action: toggle_play` to start the animation.           | `false`                               |
| animated_transitions      | boolean         | **Optional**   | Enable crossfade transitions between frames                                                                                                                                                                                                            | `true`                                |
| transition_time           | number          | **Optional**   | Crossfade duration in ms. Default is 40% of `frame_delay`. Ignored when `smooth_animation: true`.                                                                                                                                                      | auto                                  |
| smooth_animation          | boolean         | **Optional**   | When `true`, the crossfade auto-calibrates so the full cycle equals `frame_delay` — the radar appears to flow continuously instead of stepping. Overrides `transition_time`.                                                                           | `false`                               |
| smooth_overlap            | number          | **Optional**   | Cross-fade overlap fraction when `smooth_animation: true`. `0` = sequential (no brightness dip; previous frame held at full opacity, then fades out). `1` = fully simultaneous (brief mid-transition brightness dip). Tune for your basemap.           | `1`                                   |
| motion_compensation       | boolean         | **Optional**   | Slide each radar layer in the estimated direction of rain motion during the crossfade, so rain drifts between frames instead of teleporting. See [Motion compensation](#motion-compensation).                                                          | `false`                               |
| radar_opacity             | number          | **Optional**   | Opacity of the active radar frame (0.1–1.0). Lower values let more of the basemap show through                                                                                                                                                         | `1.0`                                 |
| zoom_level                | number          | **Optional**   | Initial zoom level, 3–10                                                                                                                                                                                                                               | `7`                                   |
| center_latitude           | number / string | **Optional**   | Initial map center latitude — number or entity ID                                                                                                                                                                                                      | HA instance location                  |
| center_longitude          | number / string | **Optional**   | Initial map center longitude — number or entity ID                                                                                                                                                                                                     | HA instance location                  |
| map_style                 | string          | **Optional**   | Map style (see [Map Style](#map-style))                                                                                                                                                                                                                | `'Auto'` (follows OS dark/light mode) |
| markers                   | list            | **Optional**   | List of map markers (see [Markers](markers.md))                                                                                                                                                                                                        | none                                  |
| cluster_markers           | boolean         | **Optional**   | Cluster nearby markers into a badge; tap/click the badge to spiderfy (fan out) individual markers. The tracked marker always renders outside the cluster. Clusters containing a home marker render the home icon with a small superscript count badge. | `true`                                |
| show_snow                 | boolean         | **Optional**   | Include snow in the precipitation display (RainViewer only)                                                                                                                                                                                            | `false`                               |
| show_color_bar            | boolean         | **Optional**   | Show the radar colour scale bar (per-source palette: RainViewer universal-blue, NWS reflectivity for NOAA, DWD precipitation gradient for DWD)                                                                                                         | `true`                                |
| show_progress_bar         | boolean         | **Optional**   | Show the frame progress / timeline bar                                                                                                                                                                                                                 | `true`                                |
| progress_bar_touch_height | number          | **Optional**   | YAML-only. Height in pixels of the tappable/draggable timeline region. Any height above the 8 px visible track overlays the lower map area rather than increasing the footer height. Values smaller than 8 are treated as 8.                            | `8`                                   |
| show_loading_spinner      | boolean         | **Optional**   | Show a small spinner in the centre of the bottom bar while radar tiles are being fetched (initial load, post-pan/zoom reload, and the periodic refresh). Hidden during cached-frame playback.                                                          | `true`                                |
| show_scale                | boolean         | **Optional**   | Show a distance scale bar on the map                                                                                                                                                                                                                   | `false`                               |
| double_tap_action         | string / object | **Optional**   | Action on double-tap: `'zoom_in'` (default), `'recenter'`, `'toggle_play'`, `'none'`, or any HA action object (see [Double-tap action](#double-tap-action))                                                                                            | `'zoom_in'`                           |
| disable_scroll            | boolean         | **Optional**   | Disable map pan/drag while keeping pinch-to-zoom; lets mobile users swipe the page past the map                                                                                                                                                        | `false`                               |
| static_map                | boolean         | **Optional**   | Disable all panning and zooming                                                                                                                                                                                                                        | `false`                               |
| viewer_layer_control      | boolean         | **Optional**   | Admin opt-in for per-user, per-card state (e.g. `playback_speed` overrides) persisted via HA's frontend storage. When unset, no per-user identity is minted and no extra storage calls fire. See [viewer state API](viewer-state-api.md).              | `false`                               |
| show_zoom                 | boolean         | **Optional**   | Show zoom controls                                                                                                                                                                                                                                     | `false`                               |
| square_map                | boolean         | **Optional**   | Keep the map square. Editor disables this toggle when a `height` is set (or a sections-grid cell pins the height).                                                                                                                                     | `false`                               |
| show_playback             | boolean         | **Optional**   | Show playback controls toolbar                                                                                                                                                                                                                         | `false`                               |
| show_recenter             | boolean         | **Optional**   | Show re-center button in toolbar                                                                                                                                                                                                                       | `false`                               |
| show_range                | boolean         | **Optional**   | Show range rings around the first marker                                                                                                                                                                                                               | `false`                               |
| extra_labels              | boolean         | **Optional**   | Show more place labels (labels become smaller)                                                                                                                                                                                                         | `false`                               |
| height                    | string          | **Optional**   | Custom card height using CSS units e.g. `'400px'`, `'50vh'`. Ignored when a sections-grid cell pins the height with a fixed row count — the cell wins (see [Sections-grid support](#sections-grid-support)).                                            | `'400px'`                             |
| width                     | string          | **Optional**   | Custom card width using CSS units e.g. `'500px'`, `'80%'`                                                                                                                                                                                              | `'100%'`                              |
| show_wildfires            | boolean         | **Optional**   | Overlay active US wildfire perimeters from NIFC's WFIGS feed (see [Hazard Overlays](overlays.md#wildfires))                                                                                                                                            | `false`                               |
| wildfire_min_acres        | number          | **Optional**   | Hide incidents smaller than this acreage                                                                                                                                                                                                               | `10`                                  |
| wildfire_radius_km        | number          | **Optional**   | Only show fires within N km of the map center                                                                                                                                                                                                          | unset                                 |
| wildfire_color            | string          | **Optional**   | Active fire colour (stroke + icon)                                                                                                                                                                                                                     | `'#ff3300'`                           |
| wildfire_contained_color  | string          | **Optional**   | 100%-contained fire colour                                                                                                                                                                                                                             | `'#888888'`                           |
| wildfire_fill_opacity     | number          | **Optional**   | Polygon fill opacity (0 = perimeter only)                                                                                                                                                                                                              | `0.2`                                 |
| wildfire_refresh_minutes  | number          | **Optional**   | Override the adaptive 5/30-min refresh interval                                                                                                                                                                                                        | adaptive                              |
| show_alerts               | boolean         | **Optional**   | Overlay active US NWS watches and warnings (see [Hazard Overlays](overlays.md#nws-watches--warnings))                                                                                                                                                  | `false`                               |
| alerts_categories         | string[]        | **Optional**   | Allowlist of category keys (`tornado`, `thunderstorm`, `flood`, `winter`, `tropical`, `fire_weather`, `heat`, `wind`, `marine`, `other`); default omits `marine`                                                                                       | all except `marine`                   |
| alerts_types              | string[]        | **Optional**   | Explicit event-string allowlist; overrides `alerts_categories` when set                                                                                                                                                                                | unset                                 |
| alerts_min_severity       | string          | **Optional**   | One of `Extreme`, `Severe`, `Moderate`, `Minor`, `Unknown`                                                                                                                                                                                             | `'Minor'`                             |
| alerts_radius_km          | number          | **Optional**   | Only show alerts within N km of the map center                                                                                                                                                                                                         | unset                                 |
| alerts_fill_opacity       | number          | **Optional**   | Alert polygon fill opacity (0 = outline only)                                                                                                                                                                                                          | `0.25`                                |
| alerts_refresh_seconds    | number          | **Optional**   | Override the adaptive 60s/300s refresh interval                                                                                                                                                                                                        | adaptive                              |
| show_lightning            | boolean         | **Optional**   | Overlay live lightning strikes from the [Blitzortung integration](https://github.com/mrk-its/homeassistant-blitzortung) (see [Hazard Overlays](overlays.md#lightning-blitzortung))                                                                  | `false`                               |
| lightning_max_age_minutes | number          | **Optional**   | Card-side cap. Hide strikes older than N minutes. Does NOT change the Blitzortung integration's own max-age setting (effective cap is whichever is smaller).                                                                                           | `30`                                  |
| lightning_pulse           | boolean         | **Optional**   | One-shot brightness flash on new-strike appearance. Honours `prefers-reduced-motion`.                                                                                                                                                                  | `true`                                |
| lightning_icon_size       | number          | **Optional**   | YAML-only. Pixel size for the + sign; the bolt renders at 1.3× this size.                                                                                                                                                                              | `14`                                  |
| dwd_wind                  | string          | **Optional**   | Wind overlay style: `off`, `barbs`, `arrows`. Source-independent (uses DWD ICON-D2 globally; see [Wind overlay](overlays.md#wind)). Stacks with `dwd_wind_flow`.                                                                                       | `'off'`                               |
| dwd_wind_flow             | boolean         | **Optional**   | Animated wind streamlines a la DWD WarnWetter / earth.nullschool. Stacks independently with `dwd_wind`.                                                                                                                                                | `false`                               |
| dwd_wind_density          | number          | **Optional**   | Density of wind icons. Range 0.25-4. Higher = more arrows on screen. Capped at native ICON resolution (0.25 deg).                                                                                                                                      | `1`                                   |
| dwd_wind_size             | number          | **Optional**   | Wind icon size multiplier. Range 0.5-2 (default = 22 px). Independent of density.                                                                                                                                                                      | `1`                                   |
| dwd_wind_flow_color_light | string          | **Optional**   | YAML-only. Stroke colour for streamline particles on light basemaps. Any CSS colour string. Useful for theming.                                                                                                                                        | `rgba(25,30,45,1)`                    |
| dwd_wind_flow_color_dark  | string          | **Optional**   | YAML-only. Stroke colour for streamline particles on the dark Carto basemap. Any CSS colour string.                                                                                                                                                    | `rgba(220,225,235,1)`                 |
| dwd_wind_flow_color_sat   | string          | **Optional**   | YAML-only. Stroke colour for streamline particles on satellite basemaps. Brighter default than dark since satellite imagery has more varied terrain. Any CSS colour string.                                                                            | `rgba(255,255,255,1)`                 |

## Map Style

Specifies the base map style. All CARTO-based styles render labels in English only. Use OpenStreetMap for localized labels.

| Value       | Description                                                                                      |
|-------------|--------------------------------------------------------------------------------------------------|
| `Auto`      | Follows OS dark/light mode — Dark when system is dark, Light (English) or OSM (other) when light |
| `Light`     | CARTO Light — English only                                                                       |
| `Dark`      | CARTO Dark — English only                                                                        |
| `Voyager`   | CARTO Voyager — English only                                                                     |
| `Satellite` | ESRI World Imagery — English only                                                                |
| `OSM`       | OpenStreetMap — labels rendered in local language                                                |

When `map_style` is not set or set to `Auto`, the card picks Dark when the OS is in dark mode, `Light` for English-language instances in light mode, and `OSM` for all other languages in light mode. The map updates automatically if the OS theme changes.

> **OpenStreetMap note:** OSM tiles are provided by the OpenStreetMap community. For high-traffic deployments please consider the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Animation

The user-facing knobs are summarised here. For the rendering architecture (two-slot crossfade, layer z-stack, opacity ownership), see [animation.md](animation.md).

**Timeline scrubbing** — click anywhere on the progress bar to jump to that frame, or click and drag to scrub through the loop. Dragging pauses the animation; releasing resumes it if playback was active. On touchscreen dashboards, set `progress_bar_touch_height: 44` to create a larger scrub target. The extra touch area overlays the lower edge of the map; it does not increase the visible 8 px track or bottom chrome height.

**Timestamp** — uses the browser's locale via `Intl.DateTimeFormat`, so 12 h (AM/PM) or 24 h format is chosen automatically based on the user's regional settings. On narrow cards (≤ 397 px) the date prefix is hidden; only the time remains visible.

**Crossfade** (`animated_transitions: true`) — a two-slot crossfade. The new frame fades in over a "cushion" of the previous frame held at full opacity; the cushion then fades out via CSS `transition-delay`. Avoids the alpha-compositing dip that a naive symmetric crossfade produces against light basemaps.

**Smooth animation** (`smooth_animation: true`) — auto-calibrates the fade duration so the full crossfade cycle equals `frame_delay`. Each transition is still in progress when the next begins; the radar appears to flow continuously instead of stepping. Overrides `transition_time`.

The relative timing of the two fades when `smooth_animation: true` is controlled by `smooth_overlap` (`0`–`1`):

| Value         | Behaviour                                                                                                            |
|---------------|----------------------------------------------------------------------------------------------------------------------|
| `0`           | Sequential — previous frame held at full opacity until the new frame is fully in, then fades out. No brightness dip. |
| `0.5`         | 50% overlap — fade-out begins halfway through fade-in.                                                               |
| `1` (default) | Fully simultaneous — both fades run together. Brief mid-transition brightness dip but the smoothest motion.          |

Tune for your basemap: lighter bases benefit from lower `smooth_overlap` to avoid pulsing.

### Motion compensation

`motion_compensation: true` slides each radar layer in the estimated direction of rain motion during the crossfade. The new frame slides in from where its rain *would have been* at the previous frame's time, and the old frame slides out toward where its rain *would be* at the new frame's time. The two layers' rain positions stay overlapped throughout the transition, so the composite reads as one drifting precipitation field rather than two crossfading frames at different positions.

The motion vector is recovered from the frame pair itself — pyramidal Lucas-Kanade optical flow on a 96 × 96 intensity grid extracted from the visible tiles. No external wind data, no source-specific dispatch. Works for **all three radar sources** (DWD, RainViewer, NOAA).

Runs in a Web Worker by default so the LK compute (~2 ms on a fast desktop, ~10–25 ms on a low-end mobile/tablet) doesn't block the main thread during the animation. Falls back to synchronous main-thread execution if Worker construction is blocked (e.g. by a strict CSP); a console line records the fallback.

Auto-skipped on frame pairs where LK doesn't find enough gradient signal to produce a confident vector (light rain, clear skies, near-uniform palette). Those transitions render as the regular static crossfade — no jitter, no slide on noise.

Pairs naturally with `smooth_overlap: 0` (sequential timing) so the composite stays at full opacity through the slide. Higher overlap values still work but let the alpha dip be slightly visible mid-slide.

```yaml
type: 'custom:weather-radar-card'
smooth_animation: true
smooth_overlap: 0
motion_compensation: true
```

**Loop boundary snap** — when the loop wraps from the last frame back to the first after `restart_delay`, the transition is a hard cut rather than a fade. The pause has already broken perceived continuity, so a smooth crossfade across the loop reads as "time ran backwards"; a snap reads as "the loop restarted".

**Hard cut** (`animated_transitions: false`) — opacity changes are instant. Each frame snaps in / out.

**Pause settles state** — when playback pauses (manual stop, navigation, off-screen, tab hidden), the layer stack is settled to a single visible layer at `radar_opacity`, all other slots forced to `0`. This prevents stale CSS transitions from leaving a "trail" if the user later changes animation settings.

**Automatic pause** — animation pauses when the card is scrolled out of view or the browser tab is hidden, and resumes when visible again. During map navigation (pan / zoom), only the latest single frame is loaded to reduce tile requests; full frame history is restored 100 ms after the map settles.

## Double-tap action

`double_tap_action` fires when the user double-clicks the map (or double-taps on touch).

Simple shortcut values:

| Value         | Behaviour                                                                                             |
|---------------|-------------------------------------------------------------------------------------------------------|
| `zoom_in`     | Default. Leaflet's built-in double-click zoom remains active; no card action runs.                    |
| `recenter`    | Return the map to the configured center and zoom. Suppresses Leaflet's built-in zoom.                 |
| `toggle_play` | Toggle radar playback on/off. Suppresses Leaflet's built-in zoom.                                     |
| `none`        | Do nothing. Suppresses Leaflet's built-in zoom too — when you really want double-click to be a no-op. |

When the card is unset, behaviour is identical to `zoom_in`. To turn off the default zoom without configuring a card action, set `none`.

For advanced use, any standard HA action object is accepted in YAML:

```yaml
double_tap_action:
  action: navigate
  navigation_path: /lovelace/cameras
```

```yaml
double_tap_action:
  action: call-service
  service: scene.turn_on
  service_data:
    entity_id: scene.evening
```

## Sections-grid support

The card declares `getGridOptions()` so HA's sections-view grid can resize it without warnings. Defaults: 12 columns × 7 rows (≈ 392 px at the default 56 px row height), min 6 columns × 4 rows. The card's flex layout fills the grid cell vertically — the chrome (colour bar, progress bar, bottom row) stays at fixed heights and the map div absorbs whatever space is left.

**The grid cell wins.** When a sections-grid cell has a fixed row count (any value other than `auto`), that cell's height owns the card — the `height:` config field and `square_map` are ignored, and the card sizes itself to the cell. Use the row slider in the grid layout editor to resize it. (`height:` and `square_map` still apply in masonry/panel views, and in a sections cell set to `auto` rows.)

When the user pins the card height (either via the `height:` config field or by giving a sections-grid cell a fixed row count), the `square_map` toggle in the editor is disabled and dimmed — square_map's aspect-ratio override has no effect once another constraint is pinning the height.
