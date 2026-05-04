# Radar Animation Architecture

> Reflects the v3.4.0 two-slot crossfade. For the older symmetric model
> see git history before commit `43db352` (the cross-fade-fix).

## Goal

Show a looping animation of N radar frames (oldest → newest), with the newest
frame held longer (`restart_delay`) before the loop repeats. When
`animated_transitions` is enabled, consecutive frames crossfade; when disabled,
they cut instantly. Two crossfade modes are available — a fixed-duration
"regular" mode and an auto-calibrated "smooth" mode with a tunable overlap.

---

## Layer structure

Each radar frame is a Leaflet tile layer (`FetchTileLayer` or
`FetchWmsTileLayer`). All frames are added to the map simultaneously. Z-indices
start static (`fi + 1`) but get bumped to `100 + _zCounter` whenever a slot
becomes the new "current" — so the newest frame is always on top of the stack.

During a crossfade tick, **two slots are visible at the same time**: the new
"current" fading in at the top of the z-stack, and the just-promoted "previous
current" (the cushion) fading out underneath. The cushion's full opacity covers
any transparent pixels in the new frame's tiles during the fade-in window.
Older slots stay at `opacity: 0` and are not touched by the per-tick logic.

```text
during a crossfade tick:

z-index 102  ┌──────────────────────────────┐  slot=new (current)  opacity: 0 → active
z-index 101  │  prev1 (cushion)             │                      opacity: active (held), then → 0
z-index ...  │  older slots                 │                      opacity: 0
             (all cover the same geographic area)
```

---

## JS-driven frame loop

The animation is driven by `RadarPlayer._startLoop()` / `_scheduleNext()` /
`_showSlot()` in `src/radar-player.ts`. There are no CSS keyframes.

### `_crossfadeTiming()`

Returns `{ fadeMs, delayMs }` for the current tick:

| Mode                                      | `fadeMs`                                  | `delayMs`                | Cycle length                                  |
| ----------------------------------------- | ----------------------------------------- | ------------------------ | --------------------------------------------- |
| `animated_transitions: false`             | `0`                                       | `0`                      | snap (no fade)                                |
| Regular (`smooth_animation: false`)       | `transition_time` (or 40 % `frame_delay`) | `= fadeMs`               | `2 × fadeMs`, then idle to next tick          |
| Smooth (`smooth_animation: true`)         | `frame_delay / (2 - overlap)`             | `fadeMs × (1 - overlap)` | exactly `frame_delay` (auto-calibrated)       |

`smooth_overlap` (default `1`) controls the relative timing of the two fades.
At `0` the cushion fade-out starts AT fade-in completion (sequential, no
brightness dip but the cushion is held). At `1` both fade through the entire
window simultaneously (brief mid-transition dip, smoothest motion).

### `_showSlot(slot, opts?)`

Per tick, three branches:

1. **`s === slot`** (new current) — bumped to `newZ = 100 + ++_zCounter`,
   `transition: none` then `opacity: 0`, **forced reflow** (`void
   el.offsetHeight`), then `transition: opacity ${fade}ms ease-in-out` and
   `opacity: active`. The browser interpolates 0 → active.
2. **`useChain && s === prev1`** (the cushion) — `transition: opacity
   ${fade}ms ease-in-out ${delayMs}ms; opacity: 0`. The
   `transition-delay` holds it at full opacity for `delayMs` ms before
   beginning its fade-out.
3. **`!useChain`** (snap mode) — `transition: none; opacity: 0` for every
   non-current slot. Single layer always visible.

When `useChain` is true, **older slots are intentionally left untouched**.
Their delayed fade-out from a previous tick is either still completing or
already at `0`. Interrupting it would create a visible jump.

`opts.snap = true` forces snap mode for one tick — used at the loop
boundary (last → first frame after `restart_delay`), where a smooth fade
across the loop reads as "time ran backwards".

### `_settleVisibility()`

Called from `_stopLoop()` whenever playback stops (manual pause, navigation,
visibility change, teardown). Forces a clean state: the current slot
(`_prev1Slot`) snaps to `radar_opacity`, every other slot snaps to `0`, all
with `transition: none`. This guarantees a paused card never shows a stale
held cushion underneath the current frame, and any subsequent change to
animation settings starts from a known baseline.

### `_scheduleNext(gen)`

After showing a slot, schedules the next tick via `setTimeout`:

- Wrapping from last → first: delay = `frame_delay + restart_delay`, and
  `opts.snap = true` is passed to the next `_showSlot` to skip the fade.
- Otherwise: delay = `frame_delay`, normal crossfade.

The `gen` token (incremented by `_stopLoop()`) is checked inside the
callback to abort stale timers without needing to track timer IDs.

---

## Opacity ownership

Leaflet normally controls tile opacity through `_updateOpacity()`, which writes
`container.style.opacity` (outer layer div) and `tile.style.opacity` (each img).
This would fight the animation.

For radar layers, `animationOwnsOpacity: true` is set. This activates an
override of `_updateOpacity()` in `FetchTileLayer` / `FetchWmsTileLayer`:

- **Outer `.leaflet-layer` container** — never touched by Leaflet. The frame
  loop (`_showSlot` / `_settleVisibility`) is the only code that writes
  `el.style.opacity` here.
- **Inner `.leaflet-tile-container` divs** — set to `opacity: 1` by the
  override (bypasses the CSS fade-in that normally starts them at 0).
- **Individual `<img>` tile elements** — set to `opacity: 1` by the override
  (bypasses Leaflet's 200 ms per-tile fade-in).

The inner tiles are always fully visible and renderable. The outer
container's opacity gates whether they appear on screen.

---

## Frame loading sequence

Frames are loaded newest-first (in `_initRadar`). As each frame settles
(`layerSettled`):

1. Its outer container starts at `opacity: 0`.
2. The very first frame to load is shown as a static preview (`opacity:
   active`) while older frames load in the background.
3. Once two frames are loaded, `_startLoop(n - 1)` starts the animation at
   the newest slot so the preview continues without a flash.
4. Each subsequent older frame that loads is `unshift`-ed onto
   `_loadedSlots`, and `_currentSlot++` keeps the index pointing at the
   same frame.

---

## Dynamic tile size

`_radarTileSize()` picks 256 / 512 / 1024 / 2048 px tiles based on
`map.getSize()`. Larger maps (panel mode, fullscreen) request bigger tiles
to cut total request count for the same ground coverage:

| Map dimension (px) | Tile size | `zoomOffset` |
| ------------------ | --------- | ------------ |
| ≤ 600              | 256       | 0            |
| 601–1200           | 512       | -1           |
| 1201–2400          | 1024      | -2           |
| > 2400             | 2048      | -3           |

`zoomOffset` (and `maxNativeZoom`) compensate so the on-screen scale stays
constant. All three radar sources support this — RainViewer encodes the
size in the URL path; NOAA / DWD WMS render server-side to the requested
width/height.

---

## Pause behaviour

Two independent pause sources, both wired through `_stopLoop` →
`_settleVisibility`:

- **`onVisibilityHidden()` / `onVisibilityVisible()`** — IntersectionObserver
  (off-screen) and `document.visibilitychange` (tab hidden) call this.
  Resume refetches if the data is stale.
- **`onNavPaused()` / `onNavSettled()`** — fired on Leaflet `movestart` /
  `moveend`. Only the latest single frame is reloaded after pan/zoom
  settles, to avoid hammering the tile servers with a full timeline
  refresh on every drag.

---

## Invariants

1. Only `_showSlot` and `_settleVisibility` write the outer
   `.leaflet-layer` container's `opacity` while the loop is running.
2. `_updateOpacity` must set inner tile and tile-container opacities to `1`
   but must NOT touch the outer container.
3. `_currentSlot` and `_prev1Slot` are always valid indices into
   `_loadedSlots` (or `-1` for `_prev1Slot` before the first tick).
4. `_frameGeneration` is checked after every `await` in `_initRadar` and
   `_updateRadar` to abort stale async chains after teardown.
5. `_loopGen` is checked at the top of every `_scheduleNext` callback to
   discard timers that fired after a `_stopLoop()` call.
6. After a structural config change (anything other than back-propagated
   `center_latitude` / `center_longitude` / `zoom_level`), the card does a
   full teardown + `_initMap()` rather than reconciling the running player
   with new timing. This is the cleanest way to wipe stale CSS-transition
   state from the layer DOM.
