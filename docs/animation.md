# Radar Animation Architecture

## Status

Current architecture as of **v3.5.0**. The original symmetric crossfade
(both layers fade in/out at the same time) shipped through v3.3.0 — it
produced a visible alpha dip at the midpoint where both layers sat at
~0.5 opacity. v3.4.0 replaced that with the **two-slot delayed-fadeout
model** documented below ([#113](https://github.com/jpettitt/weather-radar-card/pull/113)),
and 3.4.0-beta2 / 3.5.0 added the `smooth_overlap` knob, dynamic
tile size, pause-when-hidden, and the `past_minutes` /
`forecast_minutes` / `frame_stride_minutes` time-range model
(replacing `frame_count`).

## Goal

Show a looping animation of N radar frames (oldest → newest), with the
newest frame held longer (`restart_delay`) before the loop repeats. When
`animated_transitions` is enabled (default), consecutive frames crossfade
smoothly; when disabled, they cut instantly. Optional `smooth_animation`
spans the fade across the inter-frame interval so motion looks
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

## Two-slot model with delayed fade-out

Only **two** slots actively participate in any single transition: the
incoming new frame and the previous-current frame ("cushion"). Older
slots stay at opacity 0 and don't move during the tick — though a
slot's own fade-out from a *previous* tick may still be in progress
when the next tick fires (this is how `smooth_animation` overlaps two
consecutive transitions).

```text
z-index    role                                opacity                   transition
────────────────────────────────────────────────────────────────────────────────────
high+1     new (incoming)                      0 → radar_opacity         opacity Xms ease-in-out
high       prev1 (the just-shown frame)        radar_opacity → 0         opacity Xms ease-in-out Yms
…older     hidden                              0 (or tail-fading)        none (or tick-1's fadeout)
```

`high` is the previous monotonic z-index; the new layer takes `high + 1`
each tick (`_zCounter` increments forever — `Number.MAX_SAFE_INTEGER`
is many years away in any realistic playback).

The **`Yms` transition-delay** on `prev1`'s fade-out is the key trick:
the cushion is held at full opacity for `Y` ms after the new layer
starts fading in, then begins its own fade-out. Setting `Y` controls
the overlap between the two fades:

| `Y` (delayMs) | Behaviour                                                                   |
|---------------|-----------------------------------------------------------------------------|
| `Y == X`      | Sequential — cushion holds until new is fully in, then fades. No alpha dip. |
| `Y == X/2`    | 50% overlap — cushion fades during the second half of new's fade-in.        |
| `Y == 0`      | Simultaneous — both fades run together. Brief mid-transition alpha dip.     |

### Why this avoids the alpha dip

`Y == X` (the regular non-smooth case) is hold-then-fade: at every
moment, *exactly one* of `{new, prev1}` is at full opacity over the
basemap. The other layer is either snapping in from 0 (covered by
`prev1` underneath) or fading out from full (with `new` already at full
above it). The composite over the basemap is always ≥ `radar_opacity`
where the new frame has data, and `prev1` shows through full-opacity
where it doesn't.

The smooth-mode default (`Y == 0`, full overlap) does dip briefly —
the cost paid for continuous-motion appearance. The user picks the
trade-off via `smooth_overlap`.

### Why this avoids ghosting

Only `prev1` is visible underneath the new layer. Older slots are at
opacity 0 (or finishing their own delayed fade-out from a prior tick,
which is below `prev1` in z-order and therefore covered). The new
frame's clear pixels expose `prev1` — and only `prev1`.

### Why this honours `radar_opacity`

`prev1` sits at the user's `radar_opacity`. The new layer fades from 0
to the same `radar_opacity`. At any pixel where the new layer has full
data opacity, it covers `prev1` — composite is just the new layer at
`radar_opacity` over basemap. At a clear pixel, `prev1` shows at
`radar_opacity` over basemap. No double-counting.

---

## State

```ts
private _zCounter = 0;          // monotonic; next slot gets 100 + ++_zCounter
private _prev1Slot = -1;        // the just-shown frame (becomes the cushion next tick)
```

After each `_showSlot(slot)` call:

```ts
this._prev1Slot = slot;
```

`_clearLayers()` resets `_zCounter` and `_prev1Slot` so a teardown +
re-init starts from a clean chain.

There is no `_prev2Slot`. A previous tick's cushion fade-out is left
running — at next tick the new tick doesn't need to know about it; it
just promotes `_prev1Slot` to the new cushion and lets the old tail
finish at its own pace. This is what makes overlapping fades work
without per-slot bookkeeping.

### `_activeOpacity` getter

Returns the user's `radar_opacity` config (clamped to 0–1) as a
string — Leaflet writes `el.style.opacity = active`, which is a
string. Default `'1'`.

```ts
private get _activeOpacity(): string {
  const v = this._cfg.radar_opacity;
  if (typeof v !== 'number' || !isFinite(v)) return '1';
  return String(Math.max(0, Math.min(1, v)));
}
```

---

## `_crossfadeTiming()` — the timing source of truth

```ts
private _crossfadeTiming(): { fadeMs: number; delayMs: number } {
  if (this._cfg.animated_transitions === false) return { fadeMs: 0, delayMs: 0 };
  if (this._cfg.smooth_animation) {
    const overlap = Math.max(0, Math.min(1, this._cfg.smooth_overlap ?? 1));
    const fade = Math.floor(this._timeout / (2 - overlap));
    const delay = Math.floor(fade * (1 - overlap));
    return { fadeMs: fade, delayMs: delay };
  }
  const fade = this._cfg.transition_time ?? Math.floor(this._timeout * 0.4);
  return { fadeMs: fade, delayMs: fade };
}
```

Three modes:

| Mode                          | `fadeMs`                                  | `delayMs`          | Cycle length                     |
|-------------------------------|-------------------------------------------|--------------------|----------------------------------|
| Animations off                | 0                                         | 0                  | snap                             |
| Regular (smooth off)          | `transition_time` or 40% of `frame_delay` | same as fade       | `2×fade`                         |
| Smooth, `overlap=0`           | `frame_delay/2`                           | `fade`             | `2×fade = frame_delay`           |
| Smooth, `overlap=1` (default) | `frame_delay`                             | `0`                | `fade = frame_delay`             |
| Smooth, arbitrary overlap     | `frame_delay/(2-overlap)`                 | `fade×(1-overlap)` | `(2-overlap)×fade = frame_delay` |

The smooth-mode formula is derived from the constraint that the
**total visible cycle length equals `frame_delay`** regardless of
overlap — solving `(1-overlap)×fade + fade = frame_delay` gives
`fade = frame_delay / (2 - overlap)`. That keeps the perceived loop
duration constant whether the user picks no-dip or full-overlap.

---

## `_showSlot(slot, opts?)` — the per-tick loop body

```ts
private _showSlot(slot: number, opts?: { snap?: boolean }): void {
  const timing = opts?.snap ? { fadeMs: 0, delayMs: 0 } : this._crossfadeTiming();
  const fade = timing.fadeMs;
  const fadeOutDelay = timing.delayMs;
  const transition = fade > 0 ? `opacity ${fade}ms ease-in-out` : 'none';
  const active = this._activeOpacity;

  this._zCounter++;
  const newZ = 100 + this._zCounter;
  const prev1 = this._prev1Slot;
  const useChain = fade > 0;

  for (let s = 0; s < n; s++) {
    const el = /* this slot's outer .leaflet-layer container */;
    if (!el) continue;

    if (s === slot) {
      // New frame: snap to 0 at the new highest z, then animate (or snap) in.
      el.style.zIndex = String(newZ);
      el.style.transition = 'none';
      el.style.opacity = '0';
      void el.offsetHeight;             // forced reflow — see below
      el.style.transition = transition;
      el.style.opacity = active;
    } else if (useChain && s === prev1) {
      // Just-promoted cushion: delayed fade-out. The transition-delay
      // (the second time value) holds at active for fadeOutDelay ms,
      // then fades over fade ms. The two together control overlap.
      el.style.transition = `opacity ${fade}ms ease-in-out ${fadeOutDelay}ms`;
      el.style.opacity = '0';
    } else if (!useChain) {
      // Snap mode: hide everything else immediately so we never see two
      // layers at opacity 1 at once.
      el.style.transition = 'none';
      el.style.opacity = '0';
    }
    // useChain && older: don't touch. Their delayed fade-out from a
    // previous tick is either still finishing or already at 0.
  }

  this._prev1Slot = slot;

  const fi = this._loadedSlots[slot];
  if (fi !== undefined) {
    this._setTimestamp(fi);
    this._highlightSegment(fi);
  }
}
```

### Why the forced reflow

Setting `transition = 'none'`, then `opacity = '0'`, then `transition = X`,
then `opacity = active` in a single synchronous block lets the browser
coalesce both opacity writes — it sees the final value (`active`) and
skips the transition entirely. `void el.offsetHeight` between the two
opacity assignments forces a layout commit, splitting the writes into
two animation frames so the transition fires.

### Why snap at the loop boundary

When the player wraps from frame N-1 back to frame 0 after the
`restart_delay` pause, `_scheduleNext` passes `{ snap: true }` to
`_showSlot`. Reasoning: the restart pause has already broken perceived
continuity — a smooth crossfade across the loop reads as "time ran
backwards" because frame 0's data is much older than frame N-1's. A
clean snap reads instead as "loop reset", which is what the user
expects.

### `_settleVisibility()` on pause

When the loop is stopped (manual pause, navigation, off-screen, tab
hidden, scrub end), `_stopLoop()` calls `_settleVisibility()` which
snaps every slot to a known clean state: only `_prev1Slot` is visible
at `_activeOpacity`, every other slot at 0. This guarantees no
half-finished CSS transition is left behind to produce a visible
"trail" the next time the loop starts.

---

## Frame timing

```text
_startLoop(startSlot?)
  ├── _showSlot(currentSlot)          ← initial (prev1Slot is -1, no cushion to fade)
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

---

## Opacity ownership

Leaflet normally controls tile opacity through `_updateOpacity()`,
which writes `container.style.opacity` (outer layer div) and
`tile.style.opacity` (each img). For radar layers this would fight
`_showSlot`.

`animationOwnsOpacity: true` activates an override of
`_updateOpacity()` in `FetchTileLayer` / `FetchWmsTileLayer`:

- **Outer `.leaflet-layer` container** — never touched by Leaflet.
  Only `_showSlot` writes `el.style.opacity` and `el.style.zIndex` here.
- **Inner `.leaflet-tile-container` divs** — set to `opacity: 1` by
  the override (bypasses the CSS fade-in that normally starts them at 0).
- **Individual `<img>` tile elements** — set to `opacity: 1` by the
  override (bypasses Leaflet's 200 ms per-tile fade-in).

The inner tiles are always fully visible and renderable. The outer
container's opacity and z-index are the only knobs the animation needs.

---

## Tile size — chosen at layer creation

`_radarTileSize()` picks the radar tile size from `map.getSize()` so
panel-view / fullscreen maps get bigger tiles and fewer requests.
Quantised to powers of 2 because all three radar sources speak the
same sizes:

| Map max dimension | Tile size | `zoomOffset` | `maxNativeZoom` adjust |
|-------------------|-----------|--------------|------------------------|
| ≤ 600 px          | 256       | 0            | base                   |
| 600–1200          | 512       | -1           | +1                     |
| 1200–2400         | 1024      | -2           | +2                     |
| > 2400            | 2048      | -3           | +3                     |

`zoomOffset` and `maxNativeZoom` are adjusted in lockstep so the
on-screen scale of the radar matches the basemap regardless of tile
size. RainViewer encodes the size in the URL path
(`/512/{z}/{x}/{y}/...`); NOAA and DWD WMS render server-side to
whatever `width`/`height` the request carries.

The chosen size is fixed for that layer's lifetime — Leaflet doesn't
support runtime `tileSize` changes. New layers (next refresh cycle)
pick up a different size if the map has been resized.

---

## Pause when hidden

When the host card is off-screen (IntersectionObserver) or the tab is
hidden (document.visibilitychange), `_player.onVisibilityHidden()` is
called:

- `viewPaused = true` — gates `_scheduleNext` (no new ticks fire).
- `_stopLoop()` — increments `_loopGen` so any in-flight `setTimeout`
  callbacks return early, and runs `_settleVisibility()`.
- `_doRadarUpdate = true` is set if a periodic update fires while
  paused so the radar refreshes on resume.

`onVisibilityVisible()` resumes:

- If `_doRadarUpdate` is set, calls `_updateRadar()` immediately —
  displayed frames are stale, refetch.
- Otherwise restarts the loop from the current slot via `_startLoop()`.

The wildfire and NWS-alerts overlay layers have their own
`pause()` / `resume()` methods called from the same visibility hooks;
they cancel their refresh timers and refetch on resume if paused
longer than the visible-refresh interval.

---

## Frame loading sequence

Frames are loaded newest-first. As each frame settles
(`layerSettled`):

1. Its outer container starts at `opacity: 0`.
2. The very first frame to load is shown as a static preview
   (`opacity: _activeOpacity`) while older frames load in the background.
3. Once two frames are loaded, `_startLoop(n-1)` starts the animation
   at the newest slot so the preview continues without a flash.
4. Each subsequent older frame that loads causes `_currentSlot++` to
   keep the index pointing at the same frame (since `unshift` shifts
   all indices up by 1).

---

## Time-range model

The number of frames isn't configured directly — it's derived from
time-range fields by `getEffectiveTimeRange()`
([src/source-caps.ts](../src/source-caps.ts)):

```ts
frameCount = max(2, floor((past_minutes + forecast_minutes) / strideMin) + 1)
```

`strideMin` defaults to the source's default frame interval (10 min for
RainViewer, 5 min for DWD, 5 min for NOAA) and can be overridden by
`frame_stride_minutes`. For the grid sources (RainViewer / DWD) the
override snaps to a multiple of the native interval; for NOAA — whose
frames come from the opengeo time listing rather than a computed grid —
it snaps to the nearest offered step (2 / 5 / 10 min, exposed as the
editor's "Frame interval" dropdown).

The legacy `frame_count` field, when set alone, auto-migrates to
`past_minutes = (frame_count - 1) × defaultStride`, preserving roughly
the same time window across the change. It is ignored (with a console
warning) when a time-based field is also present.

See [data-sources.md](data-sources.md#per-source-caps) for the full
per-source cap table.

---

## Invariants

1. Only `_showSlot` writes the outer `.leaflet-layer` container's
   `opacity` and `zIndex` while the loop is running.
2. `_updateOpacity` (overridden) sets inner tile and tile-container
   opacities to `1` but never touches the outer container.
3. `_currentSlot` is always a valid index into `_loadedSlots`
   (`_showSlot` bounds-checks and returns early if not).
4. `_frameGeneration` is checked after every `await` in `_initRadar`
   and `_updateRadar` to abort stale async chains after teardown.
5. `_loopGen` is checked at the top of every `_scheduleNext` callback
   to discard timers that fired after a `_stopLoop()` call.
6. `_zCounter` and `_prev1Slot` are reset by `_clearLayers()` so a
   teardown + re-init starts from a clean chain.
7. Pause-then-resume goes through `_settleVisibility()` so the layer
   DOM is always in a known clean state at the start of any new loop.
