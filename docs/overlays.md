# Hazard & Layer Overlays

Optional overlays that stack on top of the radar. Three are US-only and carry strong life-safety disclaimers (Wildfires, NWS Alerts, Lightning); one is global (Wind).

For non-US instances, the card surfaces a banner reminding the user that the data is US-only when either of the US-specific overlays is enabled with `hass.config.country !== 'US'`.

## Wildfires

When `show_wildfires: true`, the card overlays active US wildfire perimeters from the National Interagency Fire Center's [WFIGS Current Interagency Fire Perimeters](https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters/about) feed.

Active fires draw red; fires reported as 100% contained draw grey. Small incidents render as a fire icon at the centroid; larger incidents render as a polygon outline with translucent fill. Click any fire to see its name, acreage, containment, and discovery date, with a link to NIFC's InciWeb for further information (gated against InciWeb's RSS index so we don't link to 404s).

The overlay refreshes every 5 minutes when fires are visible (matching NIFC's update cadence) and every 30 minutes when none are. Defaults filter out incidents under 10 acres; tune with `wildfire_min_acres` or `wildfire_radius_km`.

> [!WARNING]
> **Wildfire data is for informational purposes only.** This overlay shows fire perimeters from NIFC's WFIGS feed, which updates approximately every 5 minutes and may be **delayed, incomplete, or inaccurate**. Reported perimeters typically lag the actual fire front by hours, and not every active incident appears in the feed.
>
> **Do not rely on this overlay for evacuation, life-safety, or property-protection decisions.** Follow your local emergency management agency, official evacuation orders, and Wireless Emergency Alerts.
>
> NIFC provides this data without warranty of accuracy, completeness, or timeliness. The card developers make no warranty that this overlay accurately reflects current fire activity.

### Wildfire knobs

| Field                      | Default     | Description                                     |
|----------------------------|-------------|-------------------------------------------------|
| `show_wildfires`           | `false`     | Enable the overlay                              |
| `wildfire_min_acres`       | `10`        | Hide incidents smaller than this acreage        |
| `wildfire_radius_km`       | unset       | Only show fires within N km of the map center   |
| `wildfire_color`           | `'#ff3300'` | Active fire colour (stroke + icon)              |
| `wildfire_contained_color` | `'#888888'` | 100%-contained fire colour                      |
| `wildfire_fill_opacity`    | `0.2`       | Polygon fill opacity (`0` = perimeter only)     |
| `wildfire_refresh_minutes` | adaptive    | Override the adaptive 5/30-min refresh interval |

## NWS Watches & Warnings

When `show_alerts: true`, the card overlays active US National Weather Service watches and warnings from the public [NWS API](https://www.weather.gov/documentation/services-web-api).

Each alert is drawn as a translucent polygon coloured per [NWS's standard warning palette](https://www.weather.gov/help-map) — Tornado Warning red, Severe Thunderstorm Warning orange, Flash Flood Warning dark red, and so on. When alerts overlap, more severe ones render on top so their colour wins.

Click any alert to see its event type, headline, severity / certainty / urgency, effective and expiry times, affected areas, and a link out to weather.gov for the full alert text.

The overlay refreshes every 60 seconds when alerts are visible (alerts can have minute-scale lifespans, especially tornado warnings) and every 5 minutes when none are. Filter by category, by severity floor, or by distance from the map centre.

The default filter excludes the `marine` category (most users are inland; coastal users opt back in via `alerts_categories`). Other categories: `tornado`, `thunderstorm`, `flood`, `winter`, `tropical`, `fire_weather`, `heat`, `wind`, `other`.

> [!CAUTION]
> **NWS alert data is for informational purposes only.**
>
> This overlay polls the National Weather Service public API on a delay (60 seconds when alerts are visible, 5 minutes otherwise). Network latency, API outages, browser tab throttling, and rendering delays mean the alerts you see here may be **seconds to minutes behind reality**.
>
> **Do not rely on this overlay for life-safety decisions.** For tornado, flash flood, hurricane, and other immediate-threat warnings, use:
>
> - **Wireless Emergency Alerts (WEA)** on your mobile phone
> - **NOAA Weather Radio** with SAME alerting
> - **Your local emergency management agency**
> - **Official evacuation orders** from local authorities
>
> The National Weather Service provides alert data without warranty of accuracy, completeness, or timeliness. The card developers make no warranty that this overlay accurately reflects current NWS alerts.

Both polygon-bearing alerts (most warnings) and zone-based alerts (most advisories — Wind, Frost, Heat, etc.) render. Zone shapes are fetched on demand from `api.weather.gov/zones/...` and cached for 30 days in `localStorage` (versioned key prefix `wrc-zone-v1:`), so the same zone is never re-fetched.

### Alert knobs

| Field                    | Default             | Description                                                                                                                               |
|--------------------------|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `show_alerts`            | `false`             | Enable the overlay                                                                                                                        |
| `alerts_categories`      | all except `marine` | Allowlist of category keys (`tornado`, `thunderstorm`, `flood`, `winter`, `tropical`, `fire_weather`, `heat`, `wind`, `marine`, `other`). |
| `alerts_types`           | unset               | Explicit event-string allowlist; overrides `alerts_categories` when set                                                                   |
| `alerts_min_severity`    | `'Minor'`           | One of `Extreme`, `Severe`, `Moderate`, `Minor`, `Unknown`. Hides alerts below the chosen severity floor.                                 |
| `alerts_radius_km`       | unset               | Only show alerts within N km of the map center                                                                                            |
| `alerts_fill_opacity`    | `0.25`              | Alert polygon fill opacity (`0` = outline only)                                                                                           |
| `alerts_refresh_seconds` | adaptive            | Override the adaptive 60s/300s refresh interval                                                                                           |

## Lightning (Blitzortung)

When `show_lightning: true` *and* the [Blitzortung integration](https://www.home-assistant.io/integrations/blitzortung/) is loaded in Home Assistant, the card overlays live lightning strikes from the integration's `geo_location.lightning_strike_*` entities. No external HTTP from the card — the integration handles all the data plumbing (WebSocket polling, distance filtering, age-capping); the card just renders.

Each strike appears as a brief flash with a lightning-bolt icon (the "happening now!" indicator), and after 30 s settles into a coloured **+** sign. The + sign's fill colour ages through Blitzortung's web-map gradient: white → yellow → orange → coral → red → dark red, mirroring the visual language users coming from [their map](https://map.blitzortung.org/) already know. Newer strikes always paint on top of older ones.

The toggle in the editor's Hazard Overlays subpage is greyed out when the Blitzortung integration isn't loaded, with a tooltip explaining that the integration must be installed first.

### Lightning knobs

| Field                       | Default | Description                                                                                                                                                                                                    |
|-----------------------------|---------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `show_lightning`            | `false` | Enable the overlay                                                                                                                                                                                             |
| `lightning_max_age_minutes` | `30`    | Hide strikes older than this many minutes. **Card-side cap only — does NOT change the Blitzortung integration's own max-age setting**, which the integration itself controls and may differ (default 120 min). |
| `lightning_pulse`           | `true`  | One-shot brightness flash on new-strike appearance. Honours `prefers-reduced-motion`.                                                                                                                          |
| `lightning_icon_size`       | `14`    | YAML-only. Pixel size for the + sign; the bolt renders at 1.3× this size.                                                                                                                                      |

> [!NOTE]
> The card's `lightning_max_age_minutes` is purely a display filter — it doesn't tell the Blitzortung integration to drop entities. The integration's own max-age setting (configured in HA → Integrations → Blitzortung) is the upper bound; the card's cap is whichever is smaller. Strikes you've hidden via the card cap are still in `hass.states` and visible in the integration's sidebar.

> [!WARNING]
> Blitzortung is a community-run, free, best-effort lightning detection network. Coverage and accuracy vary regionally. **Not for life-safety decisions** — use NOAA Weather Radio, official storm warnings, or your local emergency channels for those.

## Wind

When `dwd_wind` is set to `barbs` or `arrows`, or `dwd_wind_flow: true` is set, the card overlays 10 m wind from a forecast model. Two sources are available, picked via the `wind_source` config field (or the editor's Wind Data Source dropdown):

- **`wind_source: 'dwd_aicon'`** (default for non-US) — DWD's AI-augmented variant of ICON-D2. Same 0.25° global grid (~28 km) and hourly cadence as ICON-D2, served from the same WCS endpoint; visibly better short-range accuracy at zero behaviour cost.
- **`wind_source: 'dwd_icon'`** — Raw DWD [ICON-D2 forecast model](https://www.dwd.de/EN/research/weatherforecasting/num_modelling/01_num_weather_prediction_modells/icon_description.html). 0.25° global grid (~28 km), new model run every 3 hours. Opt-in for users who prefer the unadjusted numerical output.
- **`wind_source: 'ndfd_wind'`** (default for fresh installs in US locations) — NWS National Digital Forecast Database, the forecaster blend of HRRR + RAP + NAM + GFS. 2.5 km native over CONUS / AK / HI / PR; outside those regions cells are no-data and render as calm. Updates hourly, 3-hourly forecast steps out to 7+ days.

Existing configs that don't set `wind_source` continue to use ICON-D2 — the field is purely additive, no migration runs.

The wind overlay is **not coupled to the radar source** — both ICON and NDFD are independent of the radar tiles, so the wind layer stacks usefully on RainViewer / NOAA / DWD radars alike. (For DWD radar specifically, `dwd_time_override` and `forecast_minutes` anchor the wind to the same time as the radar playback frame; for the other sources the wind always shows live.)

### Three styles

`dwd_wind` picks one of two static-icon styles, and `dwd_wind_flow` independently enables or disables the animated streamline layer. The two stack — barbs/arrows + flow is a valid combination.

- **`dwd_wind: 'barbs'`** — meteorological wind barbs in WMO/Northern-Hemisphere convention (feathers on the CCW side of the staff). Pennants = 50 kt, full feathers = 10 kt, half feathers = 5 kt. Calm cells (< 2.5 kt) draw an open circle.
- **`dwd_wind: 'arrows'`** — discrete downwind arrows colour-coded by Beaufort-ish bands (calm grey → light green → moderate teal → fresh orange → strong red-orange → gale red). Calm cells are suppressed.
- **`dwd_wind_flow: true`** — animated Canvas2D streamlines, ~1500 particles drifting along the local wind vector with alpha-fade trails. Visually similar to the DWD WarnWetter app and earth.nullschool.net. Particle density and trail length scale with map zoom so continental views don't get painted-over and city views remain detailed.

### Refresh cadence

The overlay schedules a self-rescheduling timer that wakes shortly after each clock hour (HH:00:30) — exactly when the underlying ICON hour bucket changes (or when DWD publishes a fresher run for the same hour). One fetch per hour per overlay; no fixed-interval polling.

### Reduced motion

The streamline layer respects the OS-level `prefers-reduced-motion` setting. When the user has reduced motion enabled, the streamline animation is disabled entirely (the static barbs/arrows still convey direction & speed). The matchMedia listener is live, so toggling the system setting takes effect without a card reload.

### Wind knobs

| Field               | Default        | Description                                                                                                                                            |
|---------------------|----------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|
| `wind_source`       | `'dwd_aicon'`  | One of `dwd_aicon` (default), `dwd_icon`, or `ndfd_wind`. Fresh US installs auto-pick `ndfd_wind`. See "Sources" above for details.                    |
| `dwd_wind`          | `'off'`        | One of `off`, `barbs`, `arrows`. Picks the static-icon style.                                                                                          |
| `dwd_wind_flow`     | `false`        | Enable the animated streamline layer. Stacks with `dwd_wind`.                                                                                          |
| `dwd_wind_density`  | `1`            | Density of static icons. Range 0.25–4. Higher = more icons. Capped at the native source grid.                                                          |
| `dwd_wind_size`     | `1`            | Icon size multiplier. Range 0.5–2 (default 22 px). Independent of density.                                                                             |

### Architecture note

Both wind overlays consume a shared `WindGrid` produced by a single bulk WCS GetCoverage request per refresh, replacing what was a 60–290-call WMS GetFeatureInfo burst per visual icon. Continental and world-scale views use the WCS Scaling extension to downsample server-side so the response stays ~2 MB max regardless of zoom. Source dispatch lives in `src/wind-source-caps.ts`: each entry supplies the WCS endpoint, coverage ID, CRS (`EPSG:4326` for ICON, `EPSG:3857` for NDFD), and band semantics (U/V for ICON, speed/direction for NDFD — converted to U/V client-side before storage). The cache key includes the source so two configs differing only by `wind_source` don't collide.

> [!NOTE]
> Both ICON-D2 and NDFD are forecast products — values represent model predictions for the snapshotted hour, not direct measurement. Surface winds in particular can differ noticeably from station observations (terrain channelling, urban canyons, etc.). Use this as a synoptic overview, not a backyard wind reading.
