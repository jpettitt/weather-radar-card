# Lightning overlay — design

Live lightning-strike overlay sourced from the user's existing [Blitzortung integration](https://www.home-assistant.io/integrations/blitzortung/) in Home Assistant. No external HTTP from the card — strikes are already in `hass.states` as `geo_location` entities, and the integration handles all polling, distance filtering, and age-capping. The card just renders.

## Status — proposed for v3.6

Tracking issue: TBD on creation. Targeted at the 3.6 milestone (post 3.5.0 stable).

**Why it fits the card:** lightning is a natural complement to a precipitation radar view, especially in summer / convective seasons where strike density tells you which side of a cell is active. The Blitzortung integration is widely installed (HACS popular plus shipping in HA Core), so adoption barrier is low for users who already track lightning.

**Why it's a thin slice of work:** all the data plumbing (polling, distance filter, age cap, distance/azimuth/counter sensors) belongs to the integration. Our job is detection + rendering + a popup.

---

## Data source

The Blitzortung integration exposes individual strikes as `geo_location` entities — one entity per strike, named like `geo_location.lightning_strike_<n>`. Each carries:

- `attributes.latitude` / `attributes.longitude` — strike location
- `attributes.publication_date` (or similar timestamp) — when the strike was observed
- `attributes.source` — the string `'blitzortung'` (used to disambiguate from other geo_location sources, e.g. earthquakes, fires)
- `state` — distance from the integration's configured center, in km

The integration also exposes:

- `sensor.blitzortung_lightning_distance` — nearest strike's distance
- `sensor.blitzortung_lightning_azimuth` — nearest strike's bearing
- `sensor.blitzortung_lightning_counter` — recent strike count

We don't use the sensors. We render the geo_location entities directly, since each one is a strike with its own coordinates.

**Lifecycle:** the integration adds a geo_location entity when a strike comes in via Blitzortung's WebSocket, and removes it after the user-configured max age (default **7200 s = 120 min**, verified empirically on a fresh install). The card listens for hass updates and reflects the appear/disappear churn.

**Distance filtering:** the integration also has its own configured radius. Strikes outside it never reach hass.states. The card therefore inherits the user's chosen distance — no card-side `lightning_radius_km` knob needed (we'd just be re-applying the same filter).

**Age cap:** same story. The integration's max-age setting is the cap; we don't add a second one.

---

## Detection

The toggle gates on whether the integration is loaded, **not** on whether any strikes are currently visible (a quiet day shouldn't make the toggle disappear):

```ts
function isBlitzortungLoaded(hass: HomeAssistant): boolean {
  return Array.isArray(hass?.config?.components)
      && hass.config.components.includes('blitzortung');
}
```

`hass.config.components` is the loaded-integrations list. It's populated at HA startup and stable thereafter.

### Editor behaviour

The **Show Lightning** toggle on the Hazard Overlays subpage is rendered always but disabled + dimmed when `isBlitzortungLoaded` is false, with a tooltip:

> *Requires the [Blitzortung integration](https://www.home-assistant.io/integrations/blitzortung/) — install it in HA first.*

Same pattern as `square_map`'s disabled-when-height-pinned UX. Discoverable, honest about why.

---

## Visual model

A small lightning-bolt outline at each strike location, with the **interior coloured by age** (white when fresh, fading through yellow / orange to red over the integration's max-age window). Mirrors the colour language used by Blitzortung's own [web map](https://www.blitzortung.org/) so users coming from there feel at home.

### Icon

`mdi:lightning-bolt-outline` rendered as inline SVG inside a Leaflet `divIcon`, identical to how the wildfire layer renders fire icons:

```html
<svg viewBox="0 0 24 24" width="14" height="14" style="display:block">
  <path d="<mdi:lightning-bolt-outline path>"
        fill="<age colour>"
        stroke="var(--primary-text-color, #000)"
        stroke-width="0.5" />
</svg>
```

- **14 px** default size — small enough that a busy storm doesn't clutter the map, large enough to be clickable.
- **Stroke** in HA's primary text colour gives the bolt a crisp outline that reads on both light and dark basemaps without recolouring per map style.
- **Fill** is the age-derived colour (next section).

### Age → colour

Linear interpolation through four stops, normalised against the integration's configured max age:

```ts
function colorForAge(ageSec: number, maxAgeSec: number): string {
  const t = Math.min(1, ageSec / maxAgeSec);
  if (t < 0.25) return lerp('#ffffff', '#ffeb3b', t / 0.25);          // white → yellow
  if (t < 0.5)  return lerp('#ffeb3b', '#ff9800', (t - 0.25) / 0.25); // yellow → orange
  return                lerp('#ff9800', '#ff0000', (t - 0.5) / 0.5);  // orange → red
}
```

Reading the integration's max age: query `sensor.blitzortung_lightning_distance` attributes for the configured cap, or fall back to the default 7200 s (120 min) if it's not exposed. (Open question — see below.)

### Pulse on appearance

A **one-shot brightness flash** when a strike first appears — communicates "new strike" without making every existing icon animate forever (which gets seizure-inducing during active storms with 50+ strikes/min).

CSS keyframe on the divIcon's outer div, removed by `animationend`:

```css
@keyframes wrc-lightning-pulse {
  0%   { transform: scale(2);   filter: brightness(2); opacity: 1; }
  60%  { transform: scale(1.3); filter: brightness(1.4); opacity: 1; }
  100% { transform: scale(1);   filter: brightness(1);   opacity: 1; }
}
.wrc-lightning-pulse {
  animation: wrc-lightning-pulse 600ms ease-out;
}
```

After the 600 ms pulse, the icon settles into its steady state and ages-fades from there. Adds a `wrc-lightning-pulse` class on insertion, removes it on `animationend`. `prefers-reduced-motion` opts out of the animation (icon appears at its target state immediately) — same accessibility pattern as the loading spinner.

### Periodic age refresh

A 30-second interval recomputes the fill colour for every visible marker. Simpler than per-marker timers, and 30 s smoothing on the 0–600 s gradient is visually indistinguishable from continuous fade.

---

## Popup

Click any strike for:

```text
Lightning strike
12 km NE
28 s ago
Source: Blitzortung
```

- **Distance** — from the map centre (recomputed at popup-open time, since the map may have panned since the strike).
- **Bearing** — N / NE / E / SE / S / SW / W / NW (cardinal + ordinal, 8-way).
- **Time** — relative ("just now" / "28 s ago" / "3 min ago"). Updates live if the popup stays open.

Same `maxHeight` cap (80 % of map height) as the wildfire / NWS popups.

A "More info → Blitzortung" link to the Blitzortung web map zoomed to the strike location. The web map's URL is fragment-based and takes zoom / lat / lon directly:

```text
https://map.blitzortung.org/#<zoom>/<lat>/<lon>
```

Use the card's current zoom level (clamped to the web map's range, ~3–13). No API call required — pure deep link.

---

## Config surface

Minimal — most behaviour comes from the integration:

```yaml
show_lightning: false                 # toggle (default off)
lightning_pulse: true                 # brief flash on new-strike appearance
lightning_icon_size: 14               # px; YAML-only escape hatch
```

**Deliberately not added:**

- `lightning_max_age_minutes` — Blitzortung integration owns this. Adding a second cap on the card side would silently mask strikes the user can see in the Blitzortung sidebar.
- `lightning_radius_km` — same. Integration filters at the source.
- `lightning_color` — the colour gradient is the visual language; per-stop overrides feel like overkill. Revisit if requested.
- `lightning_cluster` — Blitzortung's distance + age caps already keep counts modest in practice. If a power user reports 200+ visible strikes regularly, consider markercluster then.

---

## Implementation sketch

### Lifecycle

New file `src/lightning-layer.ts`, mirroring the structure of `wildfire-layer.ts` and `nws-alerts-layer.ts`:

```ts
export class LightningLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;
  private _markers: Map<string, L.Marker> = new Map();  // entity_id → marker
  private _strikes: Map<string, { ts: number; lat: number; lon: number }> = new Map();
  private _ageTimer: ReturnType<typeof setInterval> | null = null;

  start(): void { /* register hass listener via the card; start age timer */ }
  clear(): void { /* remove all markers, clear timer */ }
  pause(): void { /* same as wildfire/alerts: stop the age timer */ }
  resume(): void { /* restart age timer */ }
  updateHass(hass: HomeAssistant): void {
    /* diff against current strike set:
       - new entities → add marker with pulse class
       - removed entities → remove marker
       - existing → leave alone (next age tick handles fade) */
  }
  private _refreshAges(): void { /* recolour every marker based on now - ts */ }
}
```

Card wiring in `weather-radar-card.ts`:

```ts
if (cfg.show_lightning === true && isBlitzortungLoaded(this.hass)) {
  this._lightningLayer = new LightningLayer(this._map, () => this._config, this.hass);
  this._lightningLayer.start();
}
```

`updateHass` flows through the same path the wildfire / alerts layers already use (called from the card's `updated()` on hass change).

### Z-ordering

Above radar tiles, above wildfire perimeters, **above** NWS alert polygons (so a lightning strike inside a thunderstorm warning stays visible). Below markers, below popups.

Concrete: lightning markers go on a Leaflet `pane` with `z-index: 650` (between Leaflet's default `overlayPane` at 400 and `markerPane` at 600 — actually no, we want it above markers? Decision deferred to implementation; default markerPane is probably fine).

### Detection helper

Lives next to the layer (`isBlitzortungLoaded` exported from `lightning-layer.ts`), or in `region-warning.ts` if it grows to a generic "is integration X loaded" check (currently just one user, so: keep with the layer).

### Editor

Add a row in the Hazard Overlays subpage of [src/editor.ts](../src/editor.ts) following the wildfire / alerts pattern. Reuse the `disabled-row` CSS class introduced for `square_map`.

### Localization

New keys (11 languages):

- `editor.display.show_lightning`
- `editor.overlays.lightning_header`
- `editor.overlays.lightning_description`
- `editor.overlays.lightning_disabled_helper` (Blitzortung not detected)
- `ui.lightning.popup_title`
- `ui.lightning.bearing_n` / `_ne` / `_e` / `_se` / `_s` / `_sw` / `_w` / `_nw`
- `ui.lightning.relative_just_now` / `_seconds_ago` (with `{n}`) / `_minutes_ago` / `_hours_ago`
- `ui.lightning.source_label` ("Source: Blitzortung")

---

## Region considerations

Blitzortung is **community-run, global**. Coverage varies (Europe + parts of North America are densest; Africa, parts of Asia, oceans are patchier), but there's no equivalent of the US-only banner. The integration being installed is the only gate — if it's running, the user has chosen to consume Blitzortung data and we'll render it.

No banner needed.

---

## Performance

Active storms can produce 50–100 visible strikes simultaneously. Comparison points:

- The wildfire layer handles 100+ polygons during peak season — fine.
- The NWS alerts layer handles dozens of polygons + per-zone fetches — fine.
- A divIcon marker is dramatically cheaper than a Leaflet polygon.

Two efficiency rules to honour:

1. **No-op hass tick short-circuit.** Only re-process when the visible strike set actually changes (pattern from `nws-alerts-layer.ts`'s `decisionsEqual`). Hass updates fire frequently for unrelated state changes; we shouldn't iterate every geo_location entity on each tick.

2. **Age refresh on interval, not per tick.** The 30-second age timer is the only path that re-paints every visible marker. Hass updates only add/remove.

---

## Disclaimer

Blitzortung data is community-contributed, free, best-effort. Not for life-safety decisions. The Blitzortung integration's docs already cover this; the card popup includes a brief one-line "Source: Blitzortung" attribution. No additional disclaimer banner — lightning isn't a "what should I evacuate from" data point in the way wildfires and NWS warnings are.

---

## Open questions to resolve during implementation

1. **How to read Blitzortung's configured max age from HA?** The integration's options flow stores it; whether it's exposed via an entity attribute, a dispatcher event, or only readable via the `hass.config_entries` API needs a spike. Fall back: hardcode the integration's default (600 s) if we can't introspect cleanly.
2. **Pulse intensity** — the keyframe values above are a starting guess. Iterate during implementation to find a flash that's noticeable but not jarring at 50-strike-per-minute rates.
3. **Z-ordering** — does it look better above or below the alerts polygon fill? Easy to A/B during build.
4. **`lightning_icon_size` knob** — keep YAML-only or expose in editor? Default 14 px should cover everyone; YAML is fine for v1.

---

## Decisions

- Detect the integration via `hass.config.components`, not by entity presence (a quiet day shouldn't make the toggle vanish).
- Inherit Blitzortung's distance + age caps; don't add card-side duplicates that could silently mask strikes.
- **No dedup of nearby strikes.** Blitzortung's own web map renders every detection — a single physical strike can be reported by several sensors triangulating from different angles, and the duplicates are part of how the visual conveys signal strength. Match that behaviour. Revisit if the rendered density turns out to be unreadable on busy days; spatial-temporal clustering (within ~500 m and ~30 s of another strike) would be the obvious knob to add later.
- One-shot pulse on appearance, not continuous animation — animations everywhere during a storm is unusable.
- mdi:lightning-bolt-outline filled with the age colour + dark stroke for visibility on any basemap.
- 4-stop white → yellow → orange → red gradient over the integration's max age.
- 30-second timer for age recompute; not per-hass-tick.
- No new disclaimer (Blitzortung integration's docs cover the data caveats).
