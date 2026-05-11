# Data Sources

The `data_source` config field selects where radar tile data comes from.

| Value        | Coverage | Notes                                                                                                                                                                                                                                            |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RainViewer` | Global   | Default. Updated every 5 minutes, ~1–6 minute lag. No API key required. Personal/educational use only per RainViewer terms.                                                                                                                      |
| `NOAA`       | US only  | Experimental. Uses NOAA/NWS MRMS base reflectivity composite via `mapservices.weather.noaa.gov`. Government data — free, no API key. 15-minute lag, 5-minute frame steps.                                                                        |
| `DWD`        | Germany  | Deutscher Wetterdienst's `Niederschlagsradar` WMS at `maps.dwd.de`. 5-minute frame steps, ~3 days of history, +2 hours of nowcast forecast available. Government data — free, no API key. Coverage is the German radar network footprint.        |

## Per-source caps

The card knows each source's capabilities (native frame interval, max past, max forecast) and uses them to:

- Cap `past_minutes` to the source's API limit (silent clamp).
- Hide the **Forecast Duration** editor row entirely on sources without a forecast.
- Filter the editor's **History Duration** preset dropdown.

| Source       | Native interval   | Max past (API)   | Editor cap     | Max forecast   |
| ------------ | ----------------- | ---------------- | -------------- | -------------- |
| RainViewer   | 10 min            | 120 min          | 120 min        | 0              |
| NOAA         | 5 min             | 120 min          | 120 min        | 0              |
| DWD          | 5 min             | 5040 min (84 h)  | 720 min (12 h) | 120 min        |

NOAA's `mapservices.weather.noaa.gov` advertises 4 h of history but in practice frames > 2 h back come back as empty tiles, so we cap at 120 min until that's understood. DWD's editor cap is lower than the API cap because at 5-min intervals, 84 h × 12 frames/h = 1008 frames is impractical for tile fetching; YAML configs can still set `past_minutes` higher (and combine with `frame_stride_minutes` to keep the frame count sane).

## NOAA note

This is an experimental feature using a public government service with no documented rate limits. It is US-only. Radar tiles are fetched at a maximum of zoom 7 (the native 1 km MRMS resolution) and upscaled for display.

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

## Why source-agnostic time fields

Earlier versions used a single `frame_count` config: 6 frames meant "the last hour" on RainViewer (6 × 10 min) but "30 minutes" on NOAA / DWD (6 × 5 min). Switching `data_source` silently changed how much history showed.

Since 3.5, the card uses `past_minutes` and `forecast_minutes` directly, and each source's native interval is used to compute the actual frame count under the hood. Switching sources keeps the same time-range visible. Existing configs with the legacy `frame_count` field auto-migrate on load.
