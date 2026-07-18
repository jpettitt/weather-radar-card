# Data Sources

The `data_source` config field selects where radar tile data comes from.

| Value        | Coverage | Notes                                                                                                                                                                                                                                            |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RainViewer` | Global   | Default. Updated every 5 minutes, ~1–6 minute lag. No API key required. Personal/educational use only per RainViewer terms.                                                                                                                      |
| `NOAA`       | US only  | Uses NOAA/NWS MRMS QC'd base reflectivity via `opengeo.ncep.noaa.gov` — the same GeoServer that powers radar.weather.gov. Government data — free, no API key. Frame times come from the server's own listing: ~2-minute lag, real ~2-minute scan cadence, selectable 2 / 5 / 10-minute frame interval (default 5).                                                                        |
| `DWD`        | Germany  | Deutscher Wetterdienst's `Niederschlagsradar` WMS at `maps.dwd.de`. 5-minute frame steps, ~3 days of history, +2 hours of nowcast forecast available. Government data — free, no API key. Coverage is the German radar network footprint.        |

## Per-source caps

The card knows each source's capabilities (native frame interval, max past, max forecast) and uses them to:

- Cap `past_minutes` to the source's API limit (silent clamp).
- Hide the **Forecast Duration** editor row entirely on sources without a forecast.
- Filter the editor's **History Duration** preset dropdown.

| Source       | Native interval   | Max past (API)   | Editor cap     | Max forecast   |
| ------------ | ----------------- | ---------------- | -------------- | -------------- |
| RainViewer   | 10 min            | 120 min          | 120 min        | 0              |
| NOAA         | ~2 min (native); frame interval selectable 2 / 5 / 10 | 120 min          | 120 min        | 0              |
| DWD          | 5 min             | 5040 min (84 h)  | 720 min (12 h) | 120 min        |

NOAA's opengeo frame listing holds ~60 frames ≈ 2 h of history, hence the 120-min cap. DWD's editor cap is lower than the API cap because at 5-min intervals, 84 h × 12 frames/h = 1008 frames is impractical for tile fetching; YAML configs can still set `past_minutes` higher (and combine with `frame_stride_minutes` to keep the frame count sane).

## NOAA note

US-only (CONUS mosaic). Radar tiles are fetched at a maximum of zoom 7 (the native ~1 km MRMS resolution) and upscaled for display.

Since 3.7, NOAA serves from NCEP's opengeo GeoServer (`conus_bref_qcd` — the radar.weather.gov backend). Its per-layer `GetCapabilities` lists the layer's actual frame timestamps, so the card requests exact scan times: the newest frame is ~2 minutes behind real time, every frame in the loop is a distinct scan, and the **Frame interval** dropdown (2 / 5 / 10 min) controls loop density. The colour bar matches the modern radar.weather.gov reflectivity ramp.

If the frame listing is unavailable, the card falls back to the legacy `mapservices.weather.noaa.gov` eventdriven server for that cycle (10-minute computed grid behind its ~15-minute availability lag — correct but stale) and retries the listing on the next refresh.

## Wind overlay

The optional wind overlay (`dwd_wind` / `dwd_wind_flow`) pulls from a SECOND DWD endpoint — the WCS coverage `dwd__Icon_reg025_fd_sl_UV10M` (10 m wind from the ICON-D2 forecast model, global at 0.25°). It is **independent of `data_source`** — the same wind layer stacks usefully on RainViewer / NOAA / DWD radars alike, since ICON's coverage is global.

For DWD radar specifically, `dwd_time_override` and `forecast_minutes` anchor the wind to the same time bucket as the radar playback frame. Other sources always show live wind.

See [Hazard & Layer Overlays — Wind](overlays.md#wind) for the user-facing knobs and [Wind feature design](wind-feature-design.md) for the bulk-fetch architecture and zoom-aware rendering.

## DWD note

The default layer is `Niederschlagsradar` (precipitation rate, mm/h). Override via `dwd_layer`; `Radar_wn-product_1x1km_ger` gives reflectivity (dBZ) plus the 2-hour nowcast frames.

Outside the German radar coverage you'll see a faint grey wash from the no-data mask; the card emits a one-time `console.warn` if HA's configured location falls outside the bounding box of Germany and its immediate neighbours.

`dwd_time_override` accepts an ISO timestamp to anchor frames at a fixed point in the past instead of "now", useful for verifying the overlay renders when current weather is dry.

`forecast_minutes` (set in the editor as **Forecast Duration**, or in YAML directly) includes that many minutes of nowcast forecast in the playback range as future-timestamped frames; DWD's WarnWetter app default is 2 hours. When `forecast_minutes > 0`, the layer auto-switches to `Radar_wn-product_1x1km_ger` (which carries the +2h nowcast frames) unless you've explicitly set `dwd_layer`.

The colour-bar uses DWD's `Niederschlagsradar` palette sampled from DWD's official legend; units are mm/h. The same gradient is reused for the dBZ layer since the relative colours stay close enough for a quick visual cue.

> **Forecast leading edge:** when `forecast_minutes > 0`, the newest frames in the timeline are timestamped in the future. DWD's WMS only returns tiles for frames its nowcast has actually computed; if a future timestamp is past the nowcast horizon (or hasn't been published yet), those tiles come back transparent and you'll see a brief blank section at the leading edge of the loop. This resolves itself as DWD publishes new forecast frames.

`maps.dwd.de` occasionally answers tile requests with a 502/503/504 during periods of high load — this is on DWD's server, not the card. The card detects this (distinct from its own rate-limit pacing) and retries automatically with a backoff of up to ~30 seconds per tile; a "Radar server error — retrying" banner shows while this is happening and clears once tiles load normally again.

## Why source-agnostic time fields

Earlier versions used a single `frame_count` config: 6 frames meant "the last hour" on RainViewer (6 × 10 min) but "30 minutes" on NOAA / DWD (6 × 5 min). Switching `data_source` silently changed how much history showed.

Since 3.5, the card uses `past_minutes` and `forecast_minutes` directly, and each source's native interval is used to compute the actual frame count under the hood. Switching sources keeps the same time-range visible. Existing configs with the legacy `frame_count` field auto-migrate on load.
