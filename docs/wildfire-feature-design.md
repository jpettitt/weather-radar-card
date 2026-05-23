# Wildfire overlay — design

US wildfire perimeters as a toggleable map overlay, sourced from NIFC's WFIGS GeoJSON feed. Designed with future NWS watches/warnings overlay in mind.

## Status — shipped in v3.5.0

Released as part of [v3.5.0](https://github.com/jpettitt/weather-radar-card/releases/tag/v3.5.0). Tracking issue [#115](https://github.com/jpettitt/weather-radar-card/issues/115) closed.

**Implementation:** [src/wildfire-layer.ts](../src/wildfire-layer.ts), with shared helpers in [src/geo-utils.ts](../src/geo-utils.ts), [src/string-utils.ts](../src/string-utils.ts), and [src/region-warning.ts](../src/region-warning.ts). Editor surface in the new "Hazard Overlays" subpage of [src/editor.ts](../src/editor.ts). Tests in [tests/](../tests/) (geo helpers, string helpers, region-warning composition, plus the wildfire layer's internals via test-only exports).

**Deviations from this design**:

- **Layer-menu control deferred.** The design called for an on-map session-toggle menu (`mdi:layers` button → expanding panel). Replaced by the editor's Hazard Overlays subpage, which covers the configuration use case without a custom Leaflet control. The menu can still be added later if there's demand for "session-only toggle without opening the editor".
- **InciWeb URL gating** added — not in the original design. The popup link now suppresses itself when the computed slug isn't in InciWeb's RSS index, since most WFIGS incidents don't have a public InciWeb page. Both `{slug}` and `{slug}-fire` variants are tested before suppressing.
- **Popup `autoPan: true` + 12 px inset** so off-edge clicks slide the map into view inside the card.
- **Performance work** picked up from the alerts implementation — pause when card hidden, shared rate limiters, dynamic radar tile size — also benefit the wildfire layer indirectly.

The rest of the design — adaptive 5/30 min refresh, polygon-vs-icon swap by pixel bbox, binary containment colour, US-only banner, lifecycle, no-rebuild-on-tick guard — landed as written.

---

## Data source

NIFC WFIGS Current Interagency Fire Perimeters — GeoJSON via ArcGIS Online:

```
https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/
  WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query
  ?where=1=1
  &outFields=poly_IncidentName,poly_GISAcres,attr_PercentContained,attr_FireDiscoveryDateTime
  &f=geojson
```

- **Coverage:** US only.
- **CORS:** ArcGIS REST is cross-origin friendly.
- **Update cadence on NIFC's side:** every ~5 minutes per their docs.
- **Volume:** Up to ~100+ active perimeters during peak season. Polygons can have hundreds of vertices each — request `geometryPrecision=4` to trim coordinate precision and shrink the payload.

## Visual model

Each fire is rendered one of two ways depending on how big its bounding box is on screen at the current zoom:

| Polygon's pixel bbox at current zoom | Render |
|---|---|
| ≥ 20×20 px | Polygon outline + fill |
| < 20×20 px | Fire icon (`mdi:fire`) at polygon centroid |

Re-evaluated on `zoomend`. The "icon vs polygon" decision is per-fire, so a single map can show some fires as icons and others as polygons.

### Icon sizing by acreage

| Acreage | Icon size |
|---|---|
| < 10 | 16 px (small) |
| 10 – 99 | 24 px (medium) |
| ≥ 100 | 32 px (large) |

Use an inline SVG `<path>` for `mdi:fire` (same pattern as `HOME_PATH` / `ZONE_PATH` in `marker-icon.ts`), not `<ha-icon>`. Inline SVG renders synchronously and avoids any custom-element upgrade timing concerns.

### Colour by containment

| Status | Stroke | Fill |
|---|---|---|
| `attr_PercentContained < 100` | `#ff3300` (red) | red @ `wildfire_fill_opacity` |
| `attr_PercentContained == 100` | `#888888` (grey) | grey @ `wildfire_fill_opacity` |

Both polygon perimeter and fire icon follow the same active-vs-contained colour rule. Containment is checked on every render — a fire that becomes 100% contained while shown will switch to grey on the next refresh tick.

### Click → popup

Clicking either the icon or the polygon opens a popup with:

- Fire name (`poly_IncidentName`)
- Acreage (`poly_GISAcres`, formatted with thousands separators)
- Containment % (`attr_PercentContained`)
- Discovery date (`attr_FireDiscoveryDateTime`, locale-formatted)
- **More info → NIFC** link (target: NIFC's InciWeb search for the fire name — `https://inciweb.wildfire.gov/?incident=<urlencoded name>`. Not every WFIGS fire has an InciWeb page; if the search misses, the user lands on InciWeb's index. Acceptable degradation.)

## Refresh strategy

Adaptive interval based on whether anything is currently visible:

| Visible after filtering | Next refresh |
|---|---|
| ≥ 1 fire | 5 minutes (matches NIFC's update cadence) |
| 0 fires | 30 minutes (longer back-off when there's nothing to watch) |

Override via `wildfire_refresh_minutes` if the user wants a fixed interval.

Fetches happen once per interval, not per pan/zoom — the data is the entire US set, filtered client-side. Bbox filtering server-side would let us request less data, but the savings aren't worth the extra request volume during pan.

## Filtering

Two axes:

| Filter | Default | Effect |
|---|---|---|
| `wildfire_min_acres` | `10` | Drop incidents below this size (most are <1 acre and noise) |
| `wildfire_radius_km` | unset | If set, drop fires further than N km from the map center |

Lowered the default `min_acres` from the original sketch's 100 → 10, since small fires now show as icons and aren't visually overwhelming.

## US-only warning

When the user enables wildfires outside the US, surface a banner in the card. Reuses the existing `status-banner` mechanism (currently used for the rate-limit banner). Detection: `hass.config.country !== 'US'`.

The same warning pattern should be added retroactively for **NOAA radar** when used outside the US — currently it silently fails to load tiles. Cheap to add as a small follow-on.

A similar warning for **DWD radar outside Germany** should follow once PR #114 lands. Add a TODO comment in the codebase referencing this design doc.

The banner says something like:

> "Wildfire data is US-only. Your Home Assistant location is outside the US — no fires will show."

Container handles stacking if multiple banners are active (e.g. rate-limit + region warning).

## Config surface

| Field | Type | Default | Notes |
|---|---|---|---|
| `show_wildfires` | bool | `false` | Master toggle |
| `wildfire_min_acres` | number | `10` | Filter out tiny incidents |
| `wildfire_radius_km` | number | unset | Filter to fires within N km of map center |
| `wildfire_color` | string | `'#ff3300'` | Active fire stroke + icon colour |
| `wildfire_contained_color` | string | `'#888888'` | 100%-contained fire stroke + icon colour |
| `wildfire_fill_opacity` | number | `0.2` | Polygon fill opacity (`0` = perimeter only) |
| `wildfire_refresh_minutes` | number | unset | Override the adaptive 5/30-min interval |

Editor exposes the master toggle in the **Display** section, near `show_snow`. Other knobs YAML-only initially — most users won't change them.

## Implementation

New file `src/wildfire-layer.ts`:

```ts
export class WildfireLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;

  private _polygonLayer: L.GeoJSON | null = null;
  private _iconLayer: L.LayerGroup | null = null;
  private _features: GeoJSON.Feature[] = [];   // filtered, ready to render
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _gen = 0;                             // generation guard for fetch races
  private _zoomHandler: (() => void) | null = null;

  constructor(map: L.Map, getConfig: () => WeatherRadarCardConfig, hass?: HomeAssistant);

  start(): void          // initial fetch + schedule refresh + bind zoomend
  clear(): void          // cancel timer, remove layers, unbind zoomend
  updateHass(hass: HomeAssistant): void  // for radius-from-HA-center filtering

  private async _fetch(): Promise<void>
  private _filter(features): GeoJSON.Feature[]   // min_acres + radius_km
  private _render(): void                        // polygon-vs-icon per feature
  private _scheduleNext(): void                  // adaptive interval
}
```

### Lifecycle

- Construct in `_initMap` if `cfg.show_wildfires === true`.
- Tear down in `_teardown`.
- Re-create on `_config` change (existing teardown/init flow handles this).
- Update on `hass` change (currently only matters if `wildfire_radius_km` filters relative to a HA-tracked location — initial implementation can use the static map center).

### Z-ordering

Above radar (so perimeters/icons are visible through tiles), below markers / cluster layer (so fire popups don't fight with marker click handlers). Reuse the existing pane structure — no new pane needed.

### Localization

Adds one editor string ("Show Wildfires" toggle label) — needs a `localize()` key and entries in all 11 language JSON files. English-first, others via fallback.

## Designed for the next overlay (NWS watches/warnings)

The user's near-term plan: a similar overlay for NWS watches and warnings (also US-only, also GeoJSON, also polygon-based, similar refresh cadence). To leave that path open without over-engineering now:

**Don't** introduce an abstract `GeoJsonOverlay` base class on the first implementation — premature. Instead, structure `WildfireLayer` so that the patterns it uses are obvious targets for extraction:

- Lifecycle (`start` / `clear` / `_scheduleNext` with adaptive interval)
- Generation-guard pattern for fetch races (`_gen++` on each fetch start, abort if mismatched at completion)
- Filter → render separation (so different overlay types can share the rendering plumbing but supply their own filter/style)
- US-only banner mechanism (genuinely shared — extract this *now* as a small utility, since both NOAA and wildfires need it)

When the second overlay (NWS) lands, extract a `GeoJsonOverlay` base class with `_fetchGeojson()`, `_styleFeature(f)`, and `_getRefreshMs()` as abstract methods. Two instances justifies the abstraction; one doesn't.

## Disclaimer / README warning

The README must carry a prominent disclaimer that this overlay is **informational only** and is **not a substitute for official notification systems** (Wireless Emergency Alerts, NOAA Weather Radio, local emergency management, evacuation orders from local authorities). The data may be delayed, incomplete, or inaccurate; perimeters lag real fire fronts by hours; not every active incident appears in the WFIGS feed.

Borrow the wording structure from NIFC's WFIGS data license — they explicitly disclaim warranties of accuracy, completeness, and timeliness, and prohibit use as the sole basis for life-safety decisions. The exact NIFC license text should be reviewed at fetch time (it lives on the dataset's "About" page on data-nifc.opendata.arcgis.com) and a fair-use excerpt or paraphrase placed in the README.

Draft language to refine:

> **⚠️ Wildfire data is for informational purposes only.** This overlay shows fire perimeters from the National Interagency Fire Center's WFIGS feed, which updates approximately every 5 minutes and may be delayed, incomplete, or inaccurate. Perimeters typically lag the actual fire front by hours. **Do not rely on this overlay for evacuation, life-safety, or property-protection decisions.** Follow your local emergency management agency, official evacuation orders, and Wireless Emergency Alerts. NIFC provides this data without warranty of accuracy, completeness, or timeliness.

Place this near the top of the wildfire section in the README, in a callout block (`> **Warning:**` or `> [!WARNING]` GitHub admonition). Repeat a one-line condensed version in the popup that appears when a fire is clicked, and in the editor's help text under `show_wildfires`.

## Decisions

- **Binary containment colour** (active red / contained grey). No gradient — keeps the visual noise low.
- **No incident-points layer.** Perimeters only. NIFC's hotspot point feed doubles request volume for marginal benefit.
- **Polygon simplification:** start with ArcGIS's `geometryPrecision=4` query param (server-side coordinate trimming). If profiling shows polygon rendering is still a bottleneck, add `@turf/simplify` (Douglas-Peucker) as a client-side post-process. Likely not needed initially — measure first.
- **`wildfire_radius_km` re-filters on `hass` change.** Tracked-marker users move the map center implicitly; the radius filter follows. Cheap to implement — just re-evaluate filter + re-render in `updateHass()`.

## To do after PR #114 (DWD) merges

- Add a region warning for `data_source: DWD` when `hass.config.country` is outside DE plus immediate neighbours (NL, BE, FR, CH, AT, CZ, PL). Same banner mechanism as the wildfire/NOAA warnings.
