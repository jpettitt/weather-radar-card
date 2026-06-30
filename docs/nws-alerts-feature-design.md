# NWS watches & warnings overlay — design

US National Weather Service active alerts as a toggleable map overlay. Polygons coloured to NWS's official per-event-type palette. Companion to the wildfire overlay (see [wildfire-feature-design.md](wildfire-feature-design.md)) — same lifecycle pattern, same US-only banner, same generation-guard fetch.

This design also introduces a **session-only layer-toggle menu** on the map for switching individual warning types and the wildfire layer on/off without editing config.

## Status — shipped in v3.5.0

Both Phase 1 (polygon-only alerts) and Phase 2 (zone resolution) released in [v3.5.0](https://github.com/jpettitt/weather-radar-card/releases/tag/v3.5.0). Tracking issue [#116](https://github.com/jpettitt/weather-radar-card/issues/116) closed.

**Implementation:** [src/nws-alerts-layer.ts](../src/nws-alerts-layer.ts), [src/nws-alert-colors.ts](../src/nws-alert-colors.ts), [src/nws-alert-categories.ts](../src/nws-alert-categories.ts). Shared helpers in [src/geo-utils.ts](../src/geo-utils.ts), [src/string-utils.ts](../src/string-utils.ts), [src/region-warning.ts](../src/region-warning.ts). Editor surface in the "Hazard Overlays" subpage of [src/editor.ts](../src/editor.ts). Tests in [tests/nws-alert-categories.test.ts](../tests/nws-alert-categories.test.ts), [tests/nws-alert-colors.test.ts](../tests/nws-alert-colors.test.ts), [tests/nws-alerts-helpers.test.ts](../tests/nws-alerts-helpers.test.ts), [tests/region-warning.test.ts](../tests/region-warning.test.ts).

**Deviations from this design**:

- **Layer-menu control deferred.** The design called for a custom on-map `LayerMenuControl` (`mdi:layers` button → expanding panel) for session-only category toggles. Replaced by the editor's Hazard Overlays subpage with a 2-column grid of category checkboxes (persistent in config rather than session-only). Simpler, covers the configuration use case, and avoids the design's biggest piece of new code. The session-only menu can still be added later if there's demand.
- **Persistent zone cache** added — not in the original design (which only specified an in-memory `_zoneCache`). Persists across browser sessions (TTL 30 days), so a returning user has zero zone fetches in steady state. Originally localStorage (`wrc-zone-v1:` key prefix); moved to **IndexedDB** in 3.7.1 — the full NWS zone set is ~8,400 zones / ~170 MB raw, which overflowed localStorage's shared ~5 MB origin quota and silently broke persistence. See `src/zone-store.ts`: geometry is quantised to 4 dp and gzip-compressed (~4×, binary stored directly — no base64), bounded by TTL + an entry-count cap, with the legacy localStorage entries purged on first sweep.
- **Bug fixed during implementation: empty `alerts_categories: []` now means "render nothing"** instead of falling back to defaults. Required a shared `getActiveAlertCategories(configured)` helper to distinguish `undefined` (use defaults) from `[]` (explicit empty). Previously the editor's "uncheck everything" toggle reverted to the default set on next render.
- **Bug fixed during implementation: `_zoneFetches` ordering race** — refactored so `_fetchZone` self-registers as its first action, so the matching `finally { delete }` always pairs with a real entry. Without this, localStorage cache hits left stale entries in the dedupe map.
- **WCAG-style relative-luminance check** for popup accent colour — replaces a hardcoded list of "light" hex values, so future palette additions get the right text colour automatically.
- **Popup `autoPan: true` + 12 px inset** so off-edge alerts slide into view.
- **No-rebuild-on-tick guard** wired in from day 1 (per the lessons section above): `_renderDecisions` map keyed by stable `feature.id` (NWS URL), with `zones:N/M` count baked into the decision string so re-renders fire only when new zones actually arrive.

The rest of the design — colour palette, severity-sort overlap, adaptive 60s/5min refresh, category-not-events filter, US-only banner, marine off by default, multi-language localization, README `[!CAUTION]` disclaimer — landed as written.

---

## Lessons from the wildfire build

Concrete refinements to this design folded back from implementing the wildfire overlay (PR off `wildfire-overlay`, issue #115):

1. **Mandatory `skipIfDecisionsUnchanged` on the update path.** HA pushes hass updates frequently — every state change of every entity. Tearing down and rebuilding the polygon layer on every tick destroys any popup the user has open mid-interaction. This is the same shape of bug that hit the marker-cluster spider in #110. The implementation MUST cache per-feature render decisions and skip the rebuild when they're unchanged. The same guard applies to zone-fetch completions: filling in geometry for one zone must not blow away popups for adjacent zones. See `WildfireLayer._renderInner` + `decisionsEqual()` for the working pattern to copy.

2. **Stable feature keys via `feature.properties.id`.** NWS alerts each carry a canonical `id` URL — perfect stable key for the `_renderDecisions` map and for future per-feature reconciliation (the wildfire layer's weakness when an icon swaps to polygon at a zoom-threshold crossing and loses its open popup). The wildfire layer used a fallback `name + discovery date` composite; alerts get a clean upstream-provided ID.

3. **Default `marine` category to OFF.** Most users are inland; coastal/offshore alerts generate noise that's irrelevant to them. Coastal users opt in via the layer menu in seconds. The config default for `alerts_categories` should be `[tornado, thunderstorm, flood, winter, tropical, fire_weather, heat, wind, other]` (marine omitted).

4. **`layer_menu: false` is a first-class config choice.** YAML-only users may not want the on-map menu. When `layer_menu: false`, the menu is hidden and the active filter is exactly what `alerts_categories` / `alerts_types` specifies — no session override possible.

Plus things validated empirically that the rest of this design relies on:

- ArcGIS REST is CORS-friendly from a browser context (proven in wildfire fetch + InciWeb RSS xref). NWS `api.weather.gov` is documented as CORS-enabled but should be verified with a one-line `fetch()` before committing the architecture.
- Inline-styled HTML in `bindPopup(htmlString, { autoPan: false })` works correctly. The `autoPan: false` matters — without it, opening a popup can trigger map pan, which fires move/zoom handlers that interfere with the host card's pointer/action handler.
- The card-wide `BUILD_TIMESTAMP` in the console signon (added during wildfire work) is the fast way to confirm a hard refresh actually loaded the new bundle vs a cached older one. Use it during alerts iteration too.
- DOMParser handles XML in the browser fine (used for InciWeb RSS). NWS API is JSON so this isn't directly relevant, but reassuring for any future XML-shaped feeds.

## Data source

NWS public API — active alerts as GeoJSON:

```
https://api.weather.gov/alerts/active?status=actual&message_type=alert
```

- **Coverage:** US + territories (PR, VI, GU, AS, MP) + coastal/marine zones.
- **CORS:** enabled. No auth required.
- **User-Agent header is required** by NWS — must include a contact identifier. Use `weather-radar-card (https://github.com/jpettitt/weather-radar-card)`.
- **Update cadence on NWS's side:** alerts are pushed within seconds of issuance. Polling at 60s is fine; we'll use 60s when alerts are visible, 5 min when none.
- **Volume:** typically 200–800 active alerts nationwide. Each `Feature` has a polygon (or sometimes only zone references — see below) and a `properties.event` string like `"Tornado Warning"`.

### Polygon vs zone-based alerts

The NWS API returns two kinds of alert geometries:

1. **Polygon alerts** — `feature.geometry` is a `Polygon` or `MultiPolygon`. Most warnings (Tornado, Severe T-storm, Flash Flood) are storm-based polygons. Render directly.
2. **Zone-based alerts** — `feature.geometry` is `null`; the alert applies to one or more SAME/UGC zones referenced in `properties.affectedZones` (URLs like `.../zones/forecast/MNZ073`). Most advisories and watches are zone-based.

For zone-based alerts we need the zone polygons. Two options:

- **Option A — fetch zone shapes on demand** from `api.weather.gov/zones/{type}/{id}`. Each is a small GeoJSON. Cache aggressively (zones don't change month to month).
- **Option B — bundle the zone shapefile** at build time. ~3 MB minified. Avoids per-zone fetches but bloats the bundle.

**Decision: Option A**, with an in-memory cache keyed by zone URL, persisting for the lifetime of the card instance. Most users only ever see a handful of zones near them; bundling 3 MB to support fires-in-Alaska that they'll never look at is wasteful.

## Visual model

Each alert is rendered as a translucent polygon overlay coloured per NWS's [warning colour standard](https://www.weather.gov/help-map). Stroke uses the same colour at full opacity; fill uses the colour at `alerts_fill_opacity` (default `0.25`).

No icon-substitution at low zoom (unlike wildfires) — alert polygons are typically county- or storm-cell sized and remain visible at all reasonable zoom levels. If a future need arises, the wildfire icon-swap pattern is reusable.

### Standard NWS colours

A subset of the most-used types (full table in implementation):

| Event | Hex | Notes |
|---|---|---|
| Tornado Warning | `#FF0000` | Red |
| Tornado Watch | `#FFFF00` | Yellow |
| Severe Thunderstorm Warning | `#FFA500` | Orange |
| Severe Thunderstorm Watch | `#DB7093` | Pale violet red |
| Flash Flood Warning | `#8B0000` | Dark red |
| Flash Flood Watch | `#2E8B57` | Sea green |
| Flood Warning | `#00FF00` | Green |
| Flood Watch | `#2E8B57` | Sea green |
| Winter Storm Warning | `#FF69B4` | Pink |
| Winter Storm Watch | `#4682B4` | Steel blue |
| Blizzard Warning | `#FF4500` | Orange red |
| Hurricane Warning | `#DC143C` | Crimson |
| Hurricane Watch | `#FF00FF` | Magenta |
| Tropical Storm Warning | `#B22222` | Firebrick |
| High Wind Warning | `#DAA520` | Goldenrod |
| Red Flag Warning | `#FF1493` | Deep pink |
| Heat Advisory | `#FF7F50` | Coral |
| Excessive Heat Warning | `#C71585` | Medium violet red |
| Wind Chill Warning | `#B0C4DE` | Light steel blue |
| Dense Fog Advisory | `#708090` | Slate grey |
| Special Weather Statement | `#FFE4B5` | Moccasin |

Colours live in a single map (`NWS_ALERT_COLORS`) in `src/nws-alert-colors.ts`. Unknown event types fall back to `#7B68EE` (medium slate blue) so they render but are visually distinct.

### Z-ordering within the alert layer

When two alerts overlap, the more severe one should render on top. NWS exposes `properties.severity` (`Extreme` > `Severe` > `Moderate` > `Minor` > `Unknown`). Sort features by severity ascending before rendering — Leaflet draws later features on top.

### Click → popup

Click any alert polygon to open a popup with:

- Event type (`properties.event`)
- Headline (`properties.headline`) — truncated to ~120 chars with full text on a "more" expand
- Effective → Expires window (`properties.effective`, `properties.expires`, locale-formatted)
- Severity / Certainty / Urgency (`properties.severity`, `.certainty`, `.urgency`)
- Affected areas (`properties.areaDesc` — already a comma-joined list)
- **More info → NWS** link (target: `properties.uri`, the canonical alert page on weather.gov)

If multiple alerts overlap at the click point, Leaflet fires the topmost-only by default. Acceptable — the layer-toggle menu lets users hide types they don't care about to reach the ones underneath.

## Refresh strategy

Same adaptive pattern as wildfires:

| Visible after filtering | Next refresh |
|---|---|
| ≥ 1 alert | 60 seconds (alerts are time-critical; a tornado warning issued 5 min ago is stale) |
| 0 alerts | 5 minutes |

Override via `alerts_refresh_seconds` (note: seconds, not minutes — alerts move faster than fires).

Single fetch per interval pulls all active US alerts. Filter client-side. Same rationale as wildfires.

## Filtering

Three axes:

| Filter | Default | Effect |
|---|---|---|
| `alerts_types` | all enabled types | Allowlist of event strings to show. See "Type selection" below. |
| `alerts_radius_km` | unset | If set, drop alerts whose centroid is further than N km from map center |
| `alerts_min_severity` | `'Minor'` | One of `Extreme`/`Severe`/`Moderate`/`Minor`/`Unknown`. Drop anything below this. |

### Type selection

The full set of NWS alert event types is ~90 strings. Exposing 90 toggles to YAML is unworkable. Instead:

- Group event types into **categories** (Tornado, Thunderstorm, Flood, Winter, Tropical, Fire Weather, Heat, Wind, Marine, Other). The category list and which-events-belong-to-which-category live in `src/nws-alert-categories.ts`.
- Config takes a list of categories *or* an explicit list of event strings:

```yaml
alerts_categories: [tornado, thunderstorm, flood, fire_weather]
# OR for fine control:
alerts_types: ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning']
```

- Default: every category **except `marine`** enabled. Marine zones (coastal / offshore alerts) generate a high volume of activity that's irrelevant to most users, who are inland. Coastal users opt back in via the layer menu in two clicks.
- When both `alerts_categories` and `alerts_types` are set, `alerts_types` wins.

### Severity floor

`alerts_min_severity: Severe` is a sensible "warnings only, skip advisories" preset. Default of `Minor` shows everything except things tagged `Unknown` (rare, and usually administrative).

## Session-only layer toggle menu

A small expanding panel anchored to the map (top-right by default, configurable via `layer_menu_position`) that lets the user toggle individual layers on/off **for the current browser session only** — no config write, no persistence across reload.

### Trigger

A single button with `mdi:layers` icon, sized and styled to match existing map controls (`show_zoom`, `show_recenter`, `show_playback`). Visible whenever at least one toggleable layer is enabled in config (currently: wildfires, alerts).

### Expanded panel

When the user clicks the layers button, a panel slides out (or drops down — depends on position) showing:

```
┌─────────────────────┐
│ ☑ Wildfires         │
│                     │
│ Watches & Warnings  │
│ ☑ Tornado           │
│ ☑ Thunderstorm      │
│ ☑ Flood             │
│ ☐ Winter            │
│ ☑ Fire Weather      │
│ ☐ Heat              │
│ ☑ Other             │
└─────────────────────┘
```

Notes:
- Sections appear only when the underlying layer is enabled in config. A user with `show_wildfires: false` doesn't see the wildfires row.
- Alert categories are listed individually so the user can drill into "show me tornado warnings but hide winter storm advisories" without touching YAML.
- All checkboxes default to *on* (matches what the underlying layer is currently rendering).
- Toggling a checkbox immediately re-filters and re-renders the affected layer — no apply button.
- Click outside the panel collapses it. Click the layers button again also collapses.

### State persistence

**Memory only.** Session state lives in the card instance (a `Map<string, boolean>`). When the card is rebuilt (config edit, page reload, HA dashboard switch), state resets to defaults.

Justification: the user explicitly asked for this. It also avoids three thorny problems:
1. localStorage scoping across multiple radar cards on different dashboards
2. Migration burden if the toggle set changes between releases
3. "Why is my tornado warning hidden?" support tickets after a user toggled it off six months ago and forgot

If users later ask for persistence, add `persist_layer_toggles: true` and write to `localStorage` keyed by card config hash. Don't build it now.

### Position config

| Value | Anchor |
|---|---|
| `top-right` (default) | `L.control` `topright` slot |
| `top-left` | `topleft` |
| `bottom-right` | `bottomright` |
| `bottom-left` | `bottomleft` |

Same slots Leaflet uses for built-in controls. Coexists with zoom/recenter/playback because Leaflet stacks controls within a slot.

### Disabled state

The on-map menu is hidden in three situations, in order of precedence:

1. **`layer_menu: false`** in the user's YAML — explicit opt-out for users who manage everything via config. The session-filter source becomes the config-declared `alerts_categories` / `alerts_types` exactly, with no per-session override path.
2. **Both wildfires and alerts are disabled** in config — the menu has no purpose with nothing to toggle.
3. **Only wildfires is enabled and `cluster_markers` style controls are not pre-conflicting** — currently the wildfire layer has no per-feature toggles, so a menu with one row is useless. Suppress until a second toggleable surface exists (i.e. once alerts ship, the menu becomes meaningful even with just `show_wildfires` on, because hiding/showing wildfires from the map UI is a useful interaction).

The layers button itself is also hidden in all three cases — no button, no panel.

## US-only warning

Same banner mechanism as the wildfire layer — both the `WildfireLayer` and `NwsAlertsLayer` will use the shared region-warning utility extracted as part of the wildfire implementation.

Detection: `hass.config.country !== 'US'`.

The banner says:

> "NWS alerts are US-only. Your Home Assistant location is outside the US — no alerts will show."

If both wildfires and alerts are enabled outside the US, show a single combined banner rather than two stacked ones:

> "Wildfire and NWS alert data are US-only. Your Home Assistant location is outside the US — no overlays will show."

The shared banner utility handles this consolidation.

## Config surface

| Field | Type | Default | Notes |
|---|---|---|---|
| `show_alerts` | bool | `false` | Master toggle |
| `alerts_categories` | string[] | all except `marine` | Allowlist of category keys (`tornado`, `thunderstorm`, `flood`, `winter`, `tropical`, `fire_weather`, `heat`, `wind`, `marine`, `other`). Default omits `marine` since most users are inland. |
| `alerts_types` | string[] | unset | Explicit event-string allowlist. Overrides `alerts_categories` when set. |
| `alerts_radius_km` | number | unset | Filter to alerts within N km of map center |
| `alerts_min_severity` | string | `'Minor'` | `Extreme` / `Severe` / `Moderate` / `Minor` / `Unknown` |
| `alerts_fill_opacity` | number | `0.25` | Polygon fill opacity (`0` = perimeter only) |
| `alerts_refresh_seconds` | number | unset | Override the adaptive 60s/300s interval |
| `layer_menu` | bool | `true` | Show the on-map layer-toggle menu when at least one toggleable layer is enabled |
| `layer_menu_position` | string | `'top-right'` | `top-right` / `top-left` / `bottom-right` / `bottom-left` |

Editor exposes the master toggle in **Display** near `show_wildfires`. Category checkboxes appear conditionally below it (visible only when `show_alerts` is on). `alerts_min_severity` gets a dropdown in the editor since it's the most-tweaked knob. Other knobs YAML-only initially.

## Implementation

### New file `src/nws-alerts-layer.ts`

Mirrors `WildfireLayer`'s shape, with two non-negotiable additions called out in **Lessons from the wildfire build** above:

- `_renderDecisions: Map<string, DecisionShape>` keyed by `feature.properties.id` (NWS-supplied stable URL ID), and a `decisionsEqual()` check on the update path so a no-op hass tick or zone-resolution callback doesn't tear down popups.
- All hass-driven re-renders MUST flow through `_render({ skipIfDecisionsUnchanged: true })`. Only fetch-driven re-renders (where features may genuinely have appeared or disappeared) get the unconditional rebuild path.

```ts
export class NwsAlertsLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;
  private _getSessionFilter: () => Set<string>;  // categories currently toggled on

  private _polygonLayer: L.GeoJSON | null = null;
  private _features: GeoJSON.Feature[] = [];
  private _zoneCache: Map<string, GeoJSON.Geometry> = new Map();
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _gen = 0;

  constructor(
    map: L.Map,
    getConfig: () => WeatherRadarCardConfig,
    getSessionFilter: () => Set<string>,
    hass?: HomeAssistant
  );

  start(): void
  clear(): void
  updateHass(hass: HomeAssistant): void
  applySessionFilter(): void  // called by the layer-menu when a toggle changes; re-renders without re-fetching

  private async _fetch(): Promise<void>
  private async _resolveZones(features): Promise<void>  // fills geometry from _zoneCache + fetches missing
  private _filter(features): GeoJSON.Feature[]
  private _render(): void
  private _scheduleNext(): void
}
```

### New file `src/layer-menu-control.ts`

Custom Leaflet control. Owns the session-state map and renders the toggle panel. Notifies registered layers when a toggle flips.

```ts
export class LayerMenuControl extends L.Control {
  private _state: Map<string, boolean> = new Map();
  private _listeners: Map<string, Array<() => void>> = new Map();

  constructor(opts: { position: L.ControlPosition });

  registerSection(opts: {
    id: string;             // 'wildfires' or 'alerts'
    label: string;          // localized
    items: Array<{ id: string; label: string; defaultOn: boolean }>;
    onChange: () => void;   // called when any item in this section flips
  }): void

  isOn(sectionId: string, itemId: string): boolean
  isAnyOn(sectionId: string): boolean   // for the wildfire layer (single toggle, no items)

  // Standard L.Control overrides
  onAdd(map: L.Map): HTMLElement
  onRemove(map: L.Map): void
}
```

### Shared `src/region-warning.ts` (extracted during wildfire impl)

```ts
export function getRegionWarnings(hass: HomeAssistant, cfg: WeatherRadarCardConfig): string[]
```

Returns an array of banner strings. Caller (the card) renders them in the existing status-banner stack. Both `WildfireLayer` and `NwsAlertsLayer` contribute to this.

### Lifecycle in `weather-radar-card.ts`

```
_initMap:
  if (cfg.show_wildfires || cfg.show_alerts):
    create LayerMenuControl, add to map (if cfg.layer_menu !== false)
  if (cfg.show_wildfires):
    new WildfireLayer(...).start()
    register section in LayerMenuControl
  if (cfg.show_alerts):
    new NwsAlertsLayer(..., () => menuControl.activeAlertCategories()).start()
    register section in LayerMenuControl

_teardown:
  call clear() on each layer; remove menu control
```

### Z-ordering across layers

From bottom to top:
1. Base map tiles
2. Radar tiles (WMS)
3. Wildfire polygons + icons (existing wildfire pane)
4. **NWS alert polygons** (new pane, between wildfires and markers)
5. Markers / cluster layer
6. Popups (Leaflet default — always on top)

Alerts above wildfires because alerts are typically more time-critical (active tornado > distant wildfire).

### Localization

Adds these strings (English, with fallback for other 10 languages):

- `editor.show_alerts` — "Show NWS Alerts"
- `editor.alerts_min_severity` — "Minimum severity"
- `editor.alerts_categories` — "Alert categories"
- `layer_menu.title` — "Layers"
- `layer_menu.wildfires` — "Wildfires"
- `layer_menu.alerts_section` — "Watches & Warnings"
- `layer_menu.category.tornado` — "Tornado"
- `layer_menu.category.thunderstorm` — "Thunderstorm"
- `layer_menu.category.flood` — "Flood"
- `layer_menu.category.winter` — "Winter"
- `layer_menu.category.tropical` — "Tropical"
- `layer_menu.category.fire_weather` — "Fire Weather"
- `layer_menu.category.heat` — "Heat"
- `layer_menu.category.wind` — "Wind"
- `layer_menu.category.marine` — "Marine"
- `layer_menu.category.other` — "Other"
- `region_warning.alerts` — banner text
- `region_warning.combined` — combined banner text

Plus the alert-popup field labels (`Effective`, `Expires`, `Severity`, `Affected areas`, `More info`).

## Sequencing with the wildfire overlay

1. **Wildfire layer** — ✅ landed on `wildfire-overlay`, ready for PR after #113/#114 rebase. Introduced `WildfireLayer`, the shared `region-warning` utility, the alert-pane Z-ordering scheme, the `mdi:fire` inline-SVG path, the `BUILD_TIMESTAMP` console signon, and the InciWeb RSS xref pattern (gating popup links against an external index). No layer-menu — wildfires has a single config toggle.
2. **NWS alerts layer + layer-menu control** (this design) — own PR, branched off `wildfire-overlay`. Introduces `NwsAlertsLayer`, `LayerMenuControl`, and registers both wildfires and alerts in the menu. The wildfire toggle in the menu becomes meaningful in this PR.
3. **Refactor pass** (optional, only if a third overlay is planned): extract `GeoJsonOverlay` base class with `_fetchGeojson()`, `_styleFeature(f)`, `_getRefreshMs()` abstract methods. Two overlays still doesn't strictly justify the abstraction; three would.

Splitting into two PRs keeps each diff reviewable and lets wildfires soak in users' hands before the heavier alerts work lands.

## Disclaimer / README warning

This overlay is the most safety-critical feature in the card. A user seeing (or not seeing) a tornado warning polygon could make a decision with life-or-death consequences. The README disclaimer must be **stronger** than the wildfire one and impossible to miss.

Required elements:

1. **Top-of-section callout** in a GitHub `> [!CAUTION]` admonition (renders red on github.com).
2. **Same disclaimer repeated** in the alert popup itself — every popup carries a one-line "Not for life-safety decisions — see [NWS source]" footer above the More-info link.
3. **Editor help text** under `show_alerts` carries an abbreviated version so users see it when they enable the feature.

Draft language to refine:

> **⚠️ CAUTION — NWS alert data is for informational purposes only.**
>
> This overlay polls the National Weather Service public API on a delay (60 seconds when alerts are visible, 5 minutes otherwise). Network latency, API outages, browser tab throttling, and rendering delays mean the alerts you see here may be **seconds to minutes behind reality**. Some alerts (zone-based advisories) require a second fetch to render their geometry and may appear later still.
>
> **Do not rely on this overlay for life-safety decisions.**
>
> For tornado, flash flood, hurricane, and other immediate-threat warnings, use:
> - **Wireless Emergency Alerts (WEA)** on your mobile phone
> - **NOAA Weather Radio** with SAME alerting
> - **Your local emergency management agency**
> - **Official evacuation orders** from local authorities
>
> The National Weather Service provides alert data without warranty of accuracy, completeness, or timeliness. This card's developers make no warranty that the overlay accurately reflects current NWS alerts.

The alerts overlay should also display a **persistent in-card footer/badge** when active alerts are being shown — small text near the layer-menu reading "NWS alerts — informational only" with a tooltip linking back to the README disclaimer. This keeps the warning visible to users who only ever interact with the card and never read the README.

Borrow disclaimer-of-warranty phrasing from NIFC's WFIGS license (used in the wildfire feature) since the legal structure is similar: government data provider disclaiming accuracy/completeness/timeliness for downstream use. NWS's own [api.weather.gov terms of service](https://www.weather.gov/disclaimer) also has reusable language about not relying on the API for safety-of-life decisions — borrow from there in preference to NIFC for the alerts feature, since it's the actual upstream source.

## Decisions

- **Polygon-only rendering, no icon swap.** Alert polygons are county-scale; they remain visible at all useful zooms.
- **Zone-based alerts resolved on-demand** with in-memory caching (Option A above). Bundling the full SAME zone shapefile is wasteful for users who only view their local area.
- **Severity sort for overlap.** More severe alerts render on top so their colour wins at intersections.
- **Session-only layer toggles.** No persistence. Resets on reload. (Per user request.)
- **Single combined US-only banner** when wildfires + alerts are both enabled outside the US, rather than two stacked banners.
- **Categories, not raw event strings, in the editor and menu.** ~10 categories vs ~90 events. Power users can still use `alerts_types` in YAML for fine control.
- **60s refresh when alerts visible.** Faster than wildfires (5 min) because tornado/flash-flood warnings have minute-scale lifespans.
