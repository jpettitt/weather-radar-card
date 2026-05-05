# Radar Animation Architecture

## Status

Current architecture as of **v3.5.0-beta1**. The original design (single
"current" slot at opacity 1, all others at 0, opposing crossfade between two
slots) shipped through v3.3.0; it was replaced in v3.4.0-beta to fix a
mid-fade alpha dip ([#113](https://github.com/Makin-Things/weather-radar-card/pull/113))
and refined further in 3.5: dynamic tile size, pause when hidden, the
`smooth_overlap` knob, and the `past_minutes` / `forecast_minutes` /
`frame_stride_minutes` time-range model (replacing `frame_count`).

## Goal

Show a looping animation of N radar frames (oldest → newest), with the
newest frame held longer (`restart_delay`) before the loop repeats. When
`animated_transitions` is enabled (default), consecutive frames crossfade
smoothly; when disabled, they cut instantly. Optional `smooth_animation`
spans the fade across the whole inter-frame interval so motion looks
continuous instead of stepped.

The crossfade must:

- **Avoid the alpha dip.** Two layers each at opacity 0.5 alpha-compose to
  ~0.75 visible — an opposing-direction crossfade lets 25% of the basemap
  show through at the midpoint, visible as a "white pulse" against light
  basemaps.
- **Avoid ghosting.** Radar tiles are mostly transparent (clear pixels are
  zero-alpha PNG data). A naive z-stack lets every previous frame's
  precipitation show through the new frame's transparent areas.
- **Honour `radar_opacity`.** When the user sets the radar to `0.6`, the
  composite over the basemap should genuinely be 60% radar / 40% basemap,
  not double-counted by stacked layers.

---

## Three-layer z-stack with selective visibility

At any moment during a transition, exactly three radar layers participate.
Older frames stay at opacity 0 and contribute nothing.

```text
z-index   role                                opacity                   transition
────────────────────────────────────────────────────────────────────────────────────
high+1    new (incoming)                      0 → radar_opacity         opacity Xms ease-in-out
high      prev1 (the one just shown)          radar_opacity (stable)    none
high-1    prev2 (the one two ago)             radar_opacity → 0         opacity Xms ease-in-out
…older    discarded                           0                         none
```

`high` is the previous monotonic z-index; the new layer takes `high + 1`
each tick (`_zCounter` increments forever — `Number.MAX_SAFE_INTEGER` is
many years away in any realistic playback).

### Why this avoids the alpha dip

The new layer's z-index is strictly above `prev1`'s. Where the new layer
has data, it covers `prev1` opaquely. Where the new layer is transparent
(a clear-air pixel), `prev1` shows through at full opacity — so there is
never a moment where two semi-transparent layers stack against the
basemap.

### Why this avoids ghosting

Only `prev1` is visible underneath the new layer. `prev2` is in the
process of fading out (z-stack is below `prev1`), and everything older is
already at opacity 0. The new frame's clear pixels expose `prev1` and
nothing else.

### Why this honours `radar_opacity`

`prev1` sits at the user's `radar_opacity`. The new layer fades from 0 to
the same `radar_opacity`. At any pixel where the new layer has full data
opacity, it covers `prev1` — composite is just the new layer at
`radar_opacity` over basemap. At a clear pixel, `prev1` shows at
`radar_opacity` over basemap. No double-counting.

---

## State

```ts
private _zCounter = 0;          // monotonic; next slot gets 100 + ++_zCounter
private _prev1Slot = -1;        // the "fully visible underneath" middle layer
private _prev2Slot = -1;        // the "fading out" bottom layer
```

After each `_showSlot(slot)` call, the chain shifts:

```ts
this._prev2Slot = this._prev1Slot;
this._prev1Slot = slot;
```

`_clearLayers()` resets all three counters so a teardown doesn't leave
stale references to layers that no longer exist.

### `_activeOpacity` getter

Returns the user's `radar_opacity` config (clamped to 0.1–1.0) as a
string — Leaflet writes `el.style.opacity = active`, which is a string.
Default `'1'`.

```ts
private get _activeOpacity(): string {
  const v = this._cfg.radar_opacity;
  if (typeof v !== 'number' || !isFinite(v)) return '1';
  return String(Math.max(0, Math.min(1, v)));
}
```

---

## `_showSlot(slot, opts?)` — the per-tick loop body

```ts
private _showSlot(slot: number, opts?: { snap?: boolean }): void {
  const fade = opts?.snap ? 0 : this._fadeMs;
  const transition = fade > 0 ? `opacity ${fade}ms ease-in-out` : 'none';
  const active = this._activeOpacity;

  this._zCounter++;
  const newZ = 100 + this._zCounter;
  const prev1 = this._prev1Slot;
  const prev2 = this._prev2Slot;

  for (let s = 0; s < n; s++) {
    const el = /* this slot's outer .leaflet-layer container */;
    if (!el) continue;

    if (s === slot) {
      // New frame: snap to 0 at the new highest z, then animate in.
      el.style.zIndex = String(newZ);
      el.style.transition = 'none';
      el.style.opacity = '0';
      void el.offsetHeight;             // forced reflow — see below
      el.style.transition = transition;
      el.style.opacity = active;
    } else if (!opts?.snap && s === prev1) {
      // Fully visible underneath — stable for this whole tick.
      el.style.transition = 'none';
      el.style.opacity = active;
    } else if (!opts?.snap && s === prev2) {
      // Fading out from active → 0 over the same duration.
      el.style.transition = transition;
      el.style.opacity = '0';
    } else {
      // Older or already-discarded: hidden, no animation.
      el.style.transition = 'none';
      el.style.opacity = '0';
    }
  }

  this._prev2Slot = opts?.snap ? -1 : prev1;
  this._prev1Slot = slot;
}
```

### Why the forced reflow

Setting `transition = 'none'`, then `opacity = '0'`, then `transition = X`,
then `opacity = active` in a single synchronous block lets the browser
coalesce both opacity writes — it sees the final value (`active`) and
skips the transition entirely. `void el.offsetHeight` between the two
opacity assignments forces a layout commit, splitting the writes into two
animation frames so the transition fires.

### Why snap at the loop boundary

When the player wraps from frame N-1 back to frame 0 after the
`restart_delay` pause, `_scheduleNext` passes `{ snap: true }` to
`_showSlot`. Reasoning: the restart pause has already broken perceived
continuity — a smooth crossfade across the loop reads as "time ran
backwards" because frame 0's data is much older than frame N-1's. A clean
snap reads instead as "loop reset", which is what the user expects.

Snap mode also resets `_prev2Slot = -1` since there's no legitimate
"two ago" to fade out on the next tick.

---

## Frame timing

```text
_startLoop(startSlot?)
  ├── _showSlot(currentSlot)          ← initial (no fade — prev1/prev2 = -1)
  └── _scheduleNext(gen)
        └── [after delay] currentSlot = (currentSlot + 1) % n
        └── _showSlot(currentSlot, { snap: isLoopBack })
        └── _scheduleNext(gen)        ← repeats
```

Per-tick delay:

- Slots 0..N-2: `frame_delay`
- Slot N-1: `frame_delay + restart_delay` (the held final frame)

The `gen` token (incremented by `_stopLoop()`) is checked inside the
callback to abort stale timers — `gen !== this._loopGen` returns early.

`_fadeMs` is one of:

- `0` if `animated_transitions === false` (or snap mode)
- `transition_time` if explicitly set
- `frame_delay` if `smooth_animation === true` (continuous flow)
- 40% of `frame_delay` otherwise (the historical default)

---

## Opacity ownership

Leaflet normally controls tile opacity through `_updateOpacity()`, which
writes `container.style.opacity` (outer layer div) and `tile.style.opacity`
(each img). For radar layers this would fight `_showSlot`.

`animationOwnsOpacity: true` activates an override of `_updateOpacity()` in
`FetchTileLayer` / `FetchWmsTileLayer`:

- **Outer `.leaflet-layer` container** — never touched by Leaflet. Only
  `_showSlot` writes `el.style.opacity` and `el.style.zIndex` here.
- **Inner `.leaflet-tile-container` divs** — set to `opacity: 1` by the
  override (bypasses the CSS fade-in that normally starts them at 0).
- **Individual `<img>` tile elements** — set to `opacity: 1` by the
  override (bypasses Leaflet's 200 ms per-tile fade-in).

The inner tiles are always fully visible and renderable. The outer
container's opacity and z-index are the only knobs the animation needs.

---

## Tile size — chosen at layer creation

`_radarTileSize()` picks the radar tile size from `map.getSize()` so
panel-view / fullscreen maps get bigger tiles and fewer requests.
Quantised to powers of 2 because all three radar sources speak the same
sizes:

| Map max dimension | Tile size | `zoomOffset` | `maxNativeZoom` adjust |
|---|---|---|---|
| ≤ 600 px | 256 | 0 | base |
| 600–1200 | 512 | -1 | +1 |
| 1200–2400 | 1024 | -2 | +2 |
| > 2400 | 2048 | -3 | +3 |

`zoomOffset` and `maxNativeZoom` are adjusted in lockstep so the on-screen
scale of the radar matches the basemap regardless of tile size. RainViewer
encodes the size in the URL path (`/512/{z}/{x}/{y}/...`); NOAA and DWD
WMS render server-side to whatever `width`/`height` the request carries.

The chosen size is fixed for that layer's lifetime — Leaflet doesn't
support runtime `tileSize` changes. New layers (next refresh cycle) pick
up a different size if the map has been resized.

---

## Pause when hidden

When the host card is off-screen (IntersectionObserver) or the tab is
hidden (document.visibilitychange), `_player.onVisibilityHidden()` is
called:

- `viewPaused = true` — gates `_scheduleNext` (no new ticks fire).
- `_stopLoop()` — increments `_loopGen` so any in-flight `setTimeout`
  callbacks return early.
- `_doRadarUpdate = true` is set if a periodic update fires while paused
  so the radar refreshes on resume.

`onVisibilityVisible()` resumes:

- If `_doRadarUpdate` is set, calls `_updateRadar()` immediately —
  displayed frames are stale, refetch.
- Otherwise restarts the loop from the current slot via `_startLoop()`.

The wildfire and NWS-alerts overlay layers have their own
`pause()` / `resume()` methods called from the same visibility hooks; they
cancel their refresh timers and refetch on resume if paused longer than
the visible-refresh interval.

---

## Frame loading sequence

Frames are loaded newest-first. As each frame settles (`layerSettled`):

1. Its outer container starts at `opacity: 0`.
2. The very first frame to load is shown as a static preview
   (`opacity: 1`) while older frames load in the background.
3. Once two frames are loaded, `_startLoop(n-1)` starts the animation at
   the newest slot so the preview continues without a flash.
4. Each subsequent older frame that loads causes `_currentSlot++` to keep
   the index pointing at the same frame (since `unshift` shifts all
   indices up by 1).

---

## Invariants

1. Only `_showSlot` writes the outer `.leaflet-layer` container's
   `opacity` and `zIndex` while the loop is running.
2. `_updateOpacity` (overridden) sets inner tile and tile-container
   opacities to `1` but never touches the outer container.
3. `_currentSlot` is always a valid index into `_loadedSlots`
   (`_showSlot` bounds-checks and returns early if not).
4. `_frameGeneration` is checked after every `await` in `_initRadar` and
   `_updateRadar` to abort stale async chains after teardown.
5. `_loopGen` is checked at the top of every `_scheduleNext` callback to
   discard timers that fired after a `_stopLoop()` call.
6. `_zCounter`, `_prev1Slot`, `_prev2Slot` are all reset by
   `_clearLayers()` so a teardown + re-init starts from a clean chain.
