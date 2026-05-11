# Real-time per-user layer visibility control — design

User-controlled show/hide of individual map overlays in real time, with state persisted per-user via Home Assistant's frontend storage API. No editor round-trip, no YAML edits, no dashboard reload.

## Status — proposed for v3.7

Tracking issue: TBD on creation. Targeted at the 3.7 milestone (post 3.6.0 stable).

The problem this solves: by 3.6 the card carries seven layer concepts that can stack on the radar (wildfires, NWS alerts, lightning, wind, DWD coverage, range rings, markers). A user looking at a busy map needs a way to mute layers temporarily without touching dashboard config — and the next user looking at the same dashboard might want a different subset visible. The editor controls the dashboard-author intent; this control gives the individual viewer real-time customisation within that intent.

## User interaction

### Trigger

A small **`mdi:layers` button** as a custom Leaflet control in the top-right corner of the map. Doesn't piggyback on the existing radar-toolbar (concerns of playback) — separate control surface.

- Hover / long-press shows tooltip "Layer visibility"
- Tap → expands the panel
- Tap again, tap outside, or press Escape → closes

### Panel

Vertical list anchored under the button, sliding in from the right edge:

```text
┌─ Layers ─────────────┐
│ ☑ Radar              │
│ ☑ Wildfires      (5) │
│ ☐ NWS Alerts         │
│ ☑ Lightning      (3) │
│ ☑ Wind: Arrows       │
│ ☐ Range rings        │
│ ☑ DWD Coverage       │
│ ──────────────────── │
│ Reset to defaults    │
└──────────────────────┘
```

- Each row: HA-native `<ha-switch>` + label + optional metadata `(N visible)` for fetched-data overlays, current mode for wind.
- Toggle change is immediate. No save button. No confirm dialog.
- Per-row metadata updates live as data arrives (e.g. wildfire count fills in once the fetch lands).
- Last row: a single **"Reset to defaults"** link that clears all user overrides for this card on this dashboard, falling back to YAML.

### Mobile

Same panel; near-full-width on narrow cards. `<ha-switch>` is touch-friendly out of the box. Tap-outside-to-close works for both pointer and touch.

### Visual feedback

- **Toggle off**: instant panel update; layer pane fades out (CSS opacity 200ms); layer's `pause()` + `clear()` runs.
- **Toggle on**: instant panel update; layer's `start()` runs; the existing card-level spinner covers the fetch — no spinner inside the panel.
- **Persisted-state indicator**: silent (matches HA's own save semantics). If users complain about uncertainty, easy follow-up to add a "Saved" message that fades after 2s.

## Layers in scope

### Toggleable in the panel

- **Radar** — the central layer; user can hide for a static reference map view (e.g. just wildfire perimeters or NWS alerts on the basemap)
- **Wildfires** — only when dashboard YAML enables it
- **NWS Alerts** — only when dashboard YAML enables it
- **Lightning** — only when dashboard YAML enables it AND Blitzortung integration is loaded
- **Wind** — only when dashboard YAML enables it (binary on/off; mode lives in editor)
- **DWD Coverage** — DWD-source-only
- **Range rings** — only when dashboard YAML enables it

### Out of scope (v1)

- **Markers** — leave for now. Conceptually different from data overlays; revisit if requested.
- **Color bar / progress bar / loading spinner / toolbar buttons** — chrome, dashboard-author concern. Keep in the editor.
- **Per-overlay tuning** (alert min severity, wildfire min acres, wind mode, etc.) — these stay in the editor. Panel's job is on/off only.

## Composition semantics — B-strict (curated)

Dashboard YAML curates **which** layers are available; user UI controls whether each available layer is currently visible. **Layers the YAML doesn't enable do not appear in the panel.**

| YAML state                       | Panel behaviour                                              |
| -------------------------------- | ------------------------------------------------------------ |
| `show_wildfires: true`           | Wildfires row visible, switch on by default                  |
| `show_wildfires: false` or unset | Wildfires row absent (no opportunity for the user to enable) |

Radar is special — there's no `show_radar` config and the card always renders the radar layer, so the Radar toggle is **always** present in the panel.

Rationale: the dashboard owner (often the same person, but for shared dashboards or families it's not) chose what's relevant for the location and audience. A non-US user's dashboard owner has no reason to surface US-only wildfires; a viewer shouldn't be able to enable that accidentally.

Trade-off: a curious user can't discover layers they didn't know existed. Mitigated by the existing editor surface — the dashboard owner sees all the toggles when configuring.

## Persistence

### API

Home Assistant's frontend storage WebSocket API:

```ts
// Read
const data = await hass.callWS({
  type: 'frontend/get_user_data',
  key: storageKey(),
});

// Write
await hass.callWS({
  type: 'frontend/set_user_data',
  key: storageKey(),
  value: { wildfires: false, alerts: true, ... },
});
```

Server-side, per-user, syncs across the user's browsers and devices. Same API HA's own frontend uses for sidebar state and view bookmarks.

### Card identity

Storage is keyed off an explicit, card-stored identity rather than a hash of the live config. Two-field shape stored in YAML:

```yaml
type: custom:weather-radar-card
data_source: RainViewer
viewer_layer_control: true              # admin toggle (gates the feature)
_layer_state_id:                        # auto-managed; users don't edit
  dash: '/weather-test/panel-test'      # dashboard path at mint time
  nonce: 'a8f2c3'                       # short random ID
```

**`viewer_layer_control` (admin):** boolean editor toggle. When OFF (default), the on-map layers button doesn't render and no identity is stored. When ON, the runtime panel is exposed AND the card auto-mints `_layer_state_id` on the next `setConfig` (which fires inside the editor where `config-changed` actually writes back to YAML — no in-memory-only failure mode).

**`_layer_state_id` (auto-managed):** the storage key. The card never asks the user to edit this. Includes:

- **`dash`** — `window.location.pathname` at mint time. Used as a copy-detection check (see below), not as part of the storage key itself.
- **`nonce`** — short random string. THE storage key (`wrc-overlays:{nonce}`).

### Detection rules

On every `setConfig`, evaluate the identity in three cases:

| Config state                                                                | Action                                                                                  |
|-----------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `viewer_layer_control` off                                                  | No identity, no storage. Toggle state (if any) is per-page-load only.                   |
| `viewer_layer_control` on, no `_layer_state_id`                             | Mint `{ dash: currentPath, nonce: randomUUID() }`, dispatch `config-changed`.           |
| `viewer_layer_control` on, `_layer_state_id.dash` ≠ current path            | Card was copied or moved to a new dashboard. Re-mint, dispatch `config-changed`.        |
| `viewer_layer_control` on, `_layer_state_id.dash` === current path          | Use `nonce` as storage key. No write-back.                                              |

### Live-collision detection (option 2)

The dash-mismatch check catches **cross-dashboard** copy-paste, but a copy-paste **within the same dashboard** produces two cards with identical `_layer_state_id` (same dash, same nonce) — they'd quietly share state. Belt-and-braces: a module-scoped `Map<nonce, WeatherRadarCard>` of live instances. On `setConfig`:

```ts
const existing = liveCardsByNonce.get(id.nonce);
if (existing && existing !== this) {
  // Two cards claiming the same nonce → we were copy-pasted (or a stale
  // instance is hanging around). Mint a fresh nonce + dispatch
  // config-changed so the YAML reflects the new identity.
  const fresh = { dash: currentPath, nonce: randomUUID() };
  this.dispatchEvent(new CustomEvent('config-changed', {
    detail: { config: { ...config, _layer_state_id: fresh } },
    bubbles: true, composed: true,
  }));
  return;
}
liveCardsByNonce.set(id.nonce, this);
```

`disconnectedCallback` removes the entry. ~10 lines, eliminates the within-dashboard collision case.

### What this design buys

| Scenario                                                          | Behaviour                                                                                                                                |
|-------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| Drag card to new section/pane in the same dashboard               | Path unchanged, nonce unchanged. **Identity preserved.** ✓                                                                               |
| Edit a YAML field (any field other than `_layer_state_id` itself) | Path unchanged, nonce unchanged. **Identity preserved.** ✓                                                                               |
| Copy card to a different dashboard                                | Path mismatch on the new card → re-mint. Independent state. ✓                                                                            |
| Copy card next to itself on the same dashboard                    | Live-collision detected → re-mint on the second instance. ✓                                                                              |
| Move card to a different dashboard (intent: "moved")              | Path mismatch → re-mint. **Overrides reset** — acceptable trade-off; recoverable by toggling the admin switch off + on.                  |
| Dashboard rename (URL path changes)                               | All cards on the dashboard see path mismatch → all re-mint → all overrides reset. Rare; could mitigate later with a stable dashboard ID. |
| Cold copy-paste (delete original, paste later)                    | No live collision possible; pasted card "inherits" the original's state. Semantically a "move". Not detected.                            |

### Sparse storage

Stored value records only **explicit user overrides**, not full state:

```json
{
  "wildfires": false,
  "alerts": true
}
```

Defaults fall through to YAML. A toggle flipped back to its YAML default removes the entry. Result: storage stays small; YAML changes still propagate when the user hasn't taken explicit control.

### Debounced writes

Toggle change triggers an immediate visual update + a debounced (~500 ms) WebSocket write. Rapid-fire toggling doesn't hammer the WS connection.

## Implementation sketch

```ts
// src/layer-control.ts (new)
export class LayerControl {
  private _map: L.Map;
  private _hass: HomeAssistant;
  private _getConfig: () => WeatherRadarCardConfig;
  private _onToggle: (layer: string, on: boolean) => void;
  private _overrides: Map<string, boolean> = new Map();
  private _writeTimer: ReturnType<typeof setTimeout> | null = null;

  // Build the Leaflet control + bind handlers
  start(): void { ... }
  clear(): void { ... }

  // Read existing overrides from HA frontend storage
  private async _hydrate(): Promise<void> { ... }

  // Write debounced
  private _persist(): void { ... }

  // Compose YAML default + override → effective state
  effective(layer: string): boolean { ... }

  // Reset all overrides for this card+dashboard
  async reset(): Promise<void> { ... }

  // Render the panel HTML with current available layers + states
  private _renderPanel(): string { ... }
}
```

### Card wiring

The card decides which layers to construct based on `effective(layer)` (override-or-YAML), not on YAML directly. So:

```ts
// Pre-3.7
if (cfg.show_wildfires === true) this._wildfireLayer = new WildfireLayer(...);

// In 3.7
if (this._layerControl.effective('wildfires')) this._wildfireLayer = new WildfireLayer(...);
```

Toggle change → calls a closure that constructs / tears down the layer in question, then `_layerControl._persist()` fires the debounced WS write.

### Available-layers helper

```ts
function availableLayers(cfg: WeatherRadarCardConfig, hass: HomeAssistant): LayerSpec[] {
  return [
    { key: 'radar',     label: 'Radar' },                                          // always
    cfg.show_wildfires === true && { key: 'wildfires', label: 'Wildfires' },
    cfg.show_alerts === true    && { key: 'alerts',    label: 'NWS Alerts' },
    cfg.show_lightning === true && isBlitzortungLoaded(hass)
                                && { key: 'lightning', label: 'Lightning' },
    cfg.dwd_wind && cfg.dwd_wind !== 'off'
                                && { key: 'wind',      label: `Wind: ${cfg.dwd_wind}` },
    cfg.show_range === true     && { key: 'range',     label: 'Range rings' },
    cfg.data_source === 'DWD'   && { key: 'coverage',  label: 'DWD Coverage' },
  ].filter(Boolean);
}
```

This is also the function the panel reads to render rows. Single source of truth for "what layers are this card capable of right now".

## Edge cases

- **Multiple cards with same config on the same dashboard**: share state via `configHash + dashboardPath`. Two identical cards on the same dashboard genuinely share state. Surprising? Maybe. Differentiating by card index would be fragile to dashboard reorders. Defer; revisit if reported.
- **Dashboard renamed** (URL path changes): user's overrides appear to reset on the renamed dashboard. Rare event; acceptable.
- **YAML field outside the hashed subset edited** (e.g. `frame_delay` changed): hash unchanged, overrides survive. Good.
- **YAML field inside the hashed subset edited** (e.g. user moves the map centre): hash changes, overrides reset. Acceptable — the card is meaningfully different.
- **Layer YAML disabled while user override is on**: B-strict means the layer disappears from the panel; the override entry stays in storage but does nothing. If the layer is re-enabled later, the override surfaces again. Self-cleans on `reset to defaults`.
- **HA frontend storage API unavailable** (very old HA, weird auth state): graceful degradation — overrides apply for the session only, no persistence. Log once; no user-visible error.
- **Storage write race** (two cards on screen, both writing at once): debounced + last-write-wins. Acceptable.

## Open questions

1. **Per-row reset buttons?** Single "Reset to defaults" at the bottom is decided. If users want finer control, easy to add a "↺" button per row in v2.
2. **Wind mode visible in the panel?** Currently shown as `Wind: Arrows` label, but mode-switch happens in the editor. Could expose an inline mode picker; deferred to v2 unless users ask.
3. **Visual indicator for "I have overrides active"?** Could badge the layers button (`mdi:layers-triple`) or show a subtle dot. Defer; first-mile-design-only-what-users-need.
4. **Privacy / per-share-link state?** If a dashboard is shared via share-link auth, the visitor's user_id is the share-link's pseudonym. Their overrides persist for that share-link too. Probably fine — share-link viewers have their own "user" anyway.

## Future extensions

Not in scope for v1, but the design admits these:

- **Layer ordering / z-index control** — e.g. push wildfires above lightning. Complex UX (drag-to-reorder); defer indefinitely unless requested.
- **Per-layer opacity slider** — gives finer-grained "mute without hiding" control. Deferred.
- **Per-overlay quick filters** — `alerts_min_severity` slider, `wildfire_min_acres` field — collapsing some editor functionality into the runtime panel. Deferred until panel UX is proven.
