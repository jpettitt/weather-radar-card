// Regression tests for the periodic-refresh path of RadarPlayer —
// the three compounding bugs from the 2026-06-09 review:
//
//   1. `_updateRadar` used to append the fetched "latest" frame without
//      checking it was actually NEW — the ~6-min refresh cycle is faster
//      than every source's publication cadence, so roughly every other
//      refresh appended a duplicate and destroyed a real historical
//      frame at slot 0 (long-running dashboards degraded monotonically).
//   2. `onNavSettled` compared its requested frame count against the
//      DISPLAYED count, which legitimately diverges (API returned fewer
//      frames; _dedupFrames pruned duplicates) — once diverged, every
//      pan/zoom took the full teardown + refetch branch forever.
//   3. `_scheduleUpdate` never cancelled the previously armed timer and
//      had no generation check, so rate-limit-retry and sleep/wake paths
//      could fork parallel update chains.
//
// Follows the "stub Leaflet, test the helpers" convention — Leaflet is
// mocked, the player is constructed against a minimal map stub, and
// private internals are reached via `as any` (TS-private is
// compile-time only).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { RadarPlayer, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(cfg: Partial<WeatherRadarCardConfig> = {}): RadarPlayer {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 7,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  const shadowRoot = { getElementById: () => null, host: {} } as any;
  return new RadarPlayer({
    map,
    shadowRoot,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

function frames(...times: number[]): RadarFrame[] {
  return times.map((t) => ({ time: t, path: '' }));
}

/** Minimal stand-in for a Leaflet tile layer created by _createLayer. */
function fakeLayer(): any {
  return {
    addTo: vi.fn(),
    remove: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    getContainer: () => undefined,
    _tileFailed: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. Newness guard ─────────────────────────────────────────────────────

describe('_updateRadar newness guard', () => {
  it('skips the destructive shift when the source has not published a new frame', async () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._radarPaths = frames(1000, 1600);
    // The source listing returns the SAME newest frame we already hold.
    p._fetchPaths = vi.fn(async () => frames(1000, 1600));
    p._createLayer = vi.fn(fakeLayer);
    p._scheduleUpdate = vi.fn();

    await p._updateRadar();

    expect(p._createLayer).not.toHaveBeenCalled();          // no append
    expect(p._radarPaths.map((f: RadarFrame) => f.time)).toEqual([1000, 1600]); // untouched
    expect(p._scheduleUpdate).toHaveBeenCalledOnce();       // chain continues
    // Fetch succeeded → data verified current → freshness clock bumps so
    // the visibility-resume staleness heuristic doesn't force a re-init.
    expect(p._lastFrameRefreshAt).toBeGreaterThan(0);
  });

  it('appends when the listing gained a genuinely newer frame', async () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._radarPaths = frames(1000, 1600);
    p._configFrameCount = 2;
    p._fetchPaths = vi.fn(async () => frames(1600, 2200));
    const layer = fakeLayer();
    p._createLayer = vi.fn(() => layer);
    p._scheduleUpdate = vi.fn();

    await p._updateRadar();

    expect(p._createLayer).toHaveBeenCalledOnce();
    expect(p._createLayer.mock.calls[0][0]).toMatchObject({ time: 2200 });
    expect(layer.addTo).toHaveBeenCalledOnce();
    // Oldest frame dropped, new frame appended.
    expect(p._radarPaths.map((f: RadarFrame) => f.time)).toEqual([1600, 2200]);
  });
});

// ── 2. Requested vs displayed frame count ────────────────────────────────

describe('onNavSettled frame-count comparison', () => {
  it('does NOT re-init when only the displayed count diverged (dedup/API shortfall)', async () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._requestedFrameCount = 12;
    p._configFrameCount = 9;          // dedup pruned 3 duplicates
    p._initRadar = vi.fn();
    p._clearLayers = vi.fn();
    p.run = false;                    // keep the loop-resume path quiet

    await p.onNavSettled(12);         // card still requests 12

    expect(p._initRadar).not.toHaveBeenCalled();
    expect(p._clearLayers).not.toHaveBeenCalled();
  });

  it('DOES re-init when the requested count actually changed', async () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._requestedFrameCount = 12;
    p._configFrameCount = 9;
    p._initRadar = vi.fn();
    p._clearLayers = vi.fn();

    await p.onNavSettled(7);          // user shrank past_minutes

    expect(p._initRadar).toHaveBeenCalledOnce();
    expect(p._requestedFrameCount).toBe(7);
  });

  it('does NOT tear down an in-flight init on moveend (tracked-marker churn)', async () => {
    // Configs that pan programmatically (tracked device markers
    // re-centre on GPS jitter) fire moveend continuously. A
    // DWD+forecast init loads ~48 frames sequentially and needs the
    // first two before _radarReady flips true — without the in-flight
    // guard, every moveend in that window tore the init down and
    // restarted it, a self-sustaining loop (observed live: continuous
    // tile requests, mask pane re-filling every cycle).
    const p = makePlayer() as any;
    p._radarReady = false;            // init still loading
    p._requestedFrameCount = 12;
    p._initFlightGen = p._frameGeneration;  // init in flight for current gen
    p._initRadar = vi.fn();
    p._clearLayers = vi.fn();
    p.run = false;

    await p.onNavSettled(12);         // same request shape → let it finish

    expect(p._initRadar).not.toHaveBeenCalled();
    expect(p._clearLayers).not.toHaveBeenCalled();
  });

  it('still re-inits mid-flight when the REQUEST changed (user edited config)', async () => {
    const p = makePlayer() as any;
    p._radarReady = false;
    p._requestedFrameCount = 12;
    p._initFlightGen = p._frameGeneration;
    p._initRadar = vi.fn();
    p._clearLayers = vi.fn();

    await p.onNavSettled(7);          // request shape changed mid-load

    expect(p._initRadar).toHaveBeenCalledOnce();
  });
});

// ── 3. Dedup compaction must remove EVERYTHING it drops ─────────────────

describe('_dedupFrames orphan prevention', () => {
  it('removes layers/masks of never-loaded frames, not just duplicates', () => {
    // Mask-pane leak observed live on DWD with forecast enabled: the
    // compaction maps the per-frame arrays through keptFi, so any frame
    // NOT in keptFi vanishes from tracking — and _clearLayers can only
    // sweep what's tracked. Frames that never made it into _loadedSlots
    // (failed / still settling at dedup time) therefore stayed attached
    // to the map forever; with repeated re-inits the mask pane grew
    // without bound.
    const p = makePlayer() as any;
    const layers = [fakeLayer(), fakeLayer(), fakeLayer()];
    p._radarImage = [...layers];
    p._radarTime = [{ date: 'a', time: '1' }, { date: 'a', time: '2' }, { date: 'a', time: '3' }];
    p._radarPaths = frames(1000, 1600, 2200);
    p._frameSnapshot = [new Float32Array(4), new Float32Array(4), null];
    p._frameSnapshotNz = [500, 500, 0];   // frames 0+1 identical → 1 is a duplicate
    p._frameMotion = [null, null, null];
    p._loadedSlots = [0, 1];              // frame 2 was created but never loaded
    p._currentSlot = 0;
    p._prev1Slot = 0;

    p._dedupFrames();

    expect(layers[1].remove).toHaveBeenCalled();     // duplicate's layer
    expect(layers[2].remove).toHaveBeenCalled();     // ORPHAN: never-loaded frame's layer
    expect(layers[0].remove).not.toHaveBeenCalled(); // kept frame untouched
    expect(p._radarImage).toHaveLength(1);
  });
});

// ── 4. Single update chain ───────────────────────────────────────────────

describe('_scheduleUpdate single-chain invariant', () => {
  it('cancels the previously armed timer when re-armed (no chain forking)', () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._updateRadar = vi.fn();

    p._scheduleUpdate();
    p._scheduleUpdate();              // re-arm — must cancel the first

    vi.advanceTimersByTime(400_000);  // past framePeriod + lag (360s)
    expect(p._updateRadar).toHaveBeenCalledTimes(1);
  });

  it('a timer armed before a generation bump does not fire into the new generation', () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._updateRadar = vi.fn();

    p._scheduleUpdate();
    p._frameGeneration++;             // teardown/re-init happened

    vi.advanceTimersByTime(400_000);
    expect(p._updateRadar).not.toHaveBeenCalled();
    expect(p._doRadarUpdate).toBe(false);  // and no deferred-update flag either
  });

  it('clear() cancels the armed update timer', () => {
    const p = makePlayer() as any;
    p._radarReady = true;
    p._updateRadar = vi.fn();

    p._scheduleUpdate();
    p.clear();

    vi.advanceTimersByTime(400_000);
    expect(p._updateRadar).not.toHaveBeenCalled();
  });
});
