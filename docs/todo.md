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

- **Lightning overlay (Blitzortung)** — proposed for 3.6. Render live
  lightning strikes from the [Blitzortung HA integration](https://www.home-assistant.io/integrations/blitzortung/)
  as small `mdi:lightning-bolt-outline` markers, interior coloured by
  age (white → yellow → orange → red over the integration's max-age
  window). One-shot pulse animation on appearance. Detection via
  `hass.config.components.includes('blitzortung')`; toggle disabled
  with tooltip when not installed. Inherits the integration's distance
  and age caps (no card-side duplicates). Popup links into the
  Blitzortung web map at the strike location.

  Full design: [docs/lightning-feature-design.md](lightning-feature-design.md).
  Implementation roughly mirrors `wildfire-layer.ts` — new file
  `src/lightning-layer.ts`, editor row in the Hazard Overlays
  subpage, 11-language i18n keys.

### Investigated, won't pursue

- **Custom HACS icon** ([#126](https://github.com/Makin-Things/weather-radar-card/issues/126)).
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
- Loading spinner + `show_loading_spinner` config (contributed by @genericJE, [#124](https://github.com/Makin-Things/weather-radar-card/pull/124)) ✅ — 3.5.0
- Now marker on the progress bar (contributed by @genericJE, [#125](https://github.com/Makin-Things/weather-radar-card/pull/125)) ✅ — 3.5.0
- Dark / satellite map scale text-shadow fix (contributed by @genericJE, [#123](https://github.com/Makin-Things/weather-radar-card/pull/123)) ✅ — 3.5.0
- `npm run build` regenerates `.js.gz` so HA can't serve a stale gzipped bundle ✅ — 3.5.0
- DWD-outside-coverage region banner — visible UI cue replacing the developer-only `console.warn` from 3.4.0 ✅ — 3.5.0
- Markercluster `_bounds`-undefined race in the resize path (RAF defer + `try/catch`) ✅ — 3.5.0
- README split into a slim landing page + focused docs under `docs/` (Configuration, Data Sources, Hazard Overlays, Markers, Examples, Animation architecture) ✅ — 3.5.0
- `animation.md` rewritten to match the current two-slot + delayed-fade-out model ✅ — 3.5.0
- 11-language i18n parity sweep (100% key coverage, stale `frame_count` keys dropped) ✅ — 3.5.0
- Local Docker HA testbed (`npm run ha:up`) replacing the abandoned `.devcontainer/` ✅ — post-3.4.0
