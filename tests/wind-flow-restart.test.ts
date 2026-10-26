/* eslint-disable @typescript-eslint/no-explicit-any */
// WindFlowOverlay restart races (pre-4.0 review, 2026-10-26). Real overlay
// methods; only Leaflet, the map and the grid fetcher (network edge) are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  const DomUtil = {
    create: vi.fn(() => ({ style: {}, width: 0, height: 0, getContext: () => ctx, parentNode: null })),
    setPosition: vi.fn(),
  };
  return { DomUtil, default: { DomUtil } };
});

import { WindFlowOverlay } from '../src/wind-flow-overlay';
import { windGridFetcher, type WindGrid } from '../src/wind-grid-fetcher';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeMap(handlers: Record<string, () => void> = {}): any {
  const pane = { style: {}, appendChild: () => undefined };
  return {
    getPane: () => pane, createPane: () => pane,
    on: (ev: string, fn: () => void) => { handlers[ev] = fn; }, off: () => undefined,
    getBounds: () => ({ getSouth: () => 48, getWest: () => 8, getNorth: () => 52, getEast: () => 14 }),
    getSize: () => ({ x: 100, y: 100 }),
    getZoom: () => 8,
    getCenter: () => ({ lat: 50, lng: 11 }),
    latLngToContainerPoint: (ll: [number, number]) => ({ x: ll[1] * 100, y: 0 }),
    containerPointToLayerPoint: () => ({ x: 0, y: 0 }),
  };
}

// Bare instance with the fields the constructor sets, so a test controls
// every _restart; _tick is stubbed because the animation is not under test.
function bareFlow(): any {
  const o = Object.create(WindFlowOverlay.prototype);
  Object.assign(o, {
    _map: fakeMap(), _source: 'dwd_aicon', _gridSource: 'dwd_aicon', _timeIso: null,
    _paused: false, _preloadWhileHidden: false, _gen: 0, _running: false, _animFrame: 0,
    _lastDrawMs: 0, _reducedMotionMql: null, _refreshTimer: null,
    _grid: { rows: 0, cols: 0, latMin: 0, lonMin: 0, step: 0.25, cells: [] },
    _canvas: { width: 0, height: 0, style: {} },
    _ctx: { clearRect: () => undefined },
  });
  o._spawnParticles = vi.fn();
  o._tick = vi.fn();
  return o;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WindFlowOverlay superseded fetches', () => {
  it('a slow fetch from an older view does not replace the newer view grid', async () => {
    const gridOld: WindGrid = { rows: 1, cols: 1, latMin: 30, lonMin: -100, step: 1, cells: [[{ u: 1, v: 0 }]] };
    const gridNew: WindGrid = { rows: 1, cols: 1, latMin: 48, lonMin: 8, step: 6, cells: [[{ u: 2, v: 0 }]] };
    const dOld = deferred<WindGrid>();
    const dNew = deferred<WindGrid>();
    vi.spyOn(windGridFetcher, 'fetch').mockReturnValueOnce(dOld.promise).mockReturnValueOnce(dNew.promise);
    const o = bareFlow();
    const pOld = o._restart();
    const pNew = o._restart();
    dNew.resolve(gridNew);
    await pNew;
    dOld.resolve(gridOld);
    await pOld;
    expect(o._grid).toBe(gridNew);
    expect(o._tick).toHaveBeenCalledTimes(1);
  });

  it('a failing fetch from an older view does not blank the newer view grid', async () => {
    const gridNew: WindGrid = { rows: 1, cols: 1, latMin: 48, lonMin: 8, step: 6, cells: [[{ u: 2, v: 0 }]] };
    const dOld = deferred<WindGrid>();
    const dNew = deferred<WindGrid>();
    vi.spyOn(windGridFetcher, 'fetch').mockReturnValueOnce(dOld.promise).mockReturnValueOnce(dNew.promise);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const o = bareFlow();
    const pOld = o._restart();
    const pNew = o._restart();
    dNew.resolve(gridNew);
    await pNew;
    dOld.reject(new Error('fetchWindGrid: HTTP 503'));
    await pOld;
    expect(o._grid).toBe(gridNew);
  });

  it('a hidden-card preload fetch that lands after resume does not replace the resumed grid', async () => {
    vi.useFakeTimers();
    const gridPreload: WindGrid = { rows: 1, cols: 1, latMin: 30, lonMin: -100, step: 1, cells: [[{ u: 1, v: 0 }]] };
    const gridResumed: WindGrid = { rows: 1, cols: 1, latMin: 48, lonMin: 8, step: 6, cells: [[{ u: 2, v: 0 }]] };
    const dPreload = deferred<WindGrid>();
    const dResumed = deferred<WindGrid>();
    vi.spyOn(windGridFetcher, 'fetch').mockReturnValueOnce(dPreload.promise).mockReturnValueOnce(dResumed.promise);
    const o = bareFlow();
    o._preloadWhileHidden = true;
    o._paused = true;
    o._scheduleRefreshTick();
    vi.advanceTimersToNextTimer();   // the half-hour tick fires while hidden: preload fetch
    o.resume();                       // card shown: _restart fetches again
    dResumed.resolve(gridResumed);
    await vi.advanceTimersByTimeAsync(0);
    dPreload.resolve(gridPreload);
    await vi.advanceTimersByTimeAsync(0);
    expect(o._grid).toBe(gridResumed);
    clearTimeout(o._refreshTimer);
  });
});

describe('WindFlowOverlay pause during a restart', () => {
  it('pause() while the fetch is in flight keeps the loop stopped but keeps the grid', async () => {
    const grid: WindGrid = { rows: 1, cols: 1, latMin: 48, lonMin: 8, step: 6, cells: [[{ u: 2, v: 0 }]] };
    const d = deferred<WindGrid>();
    vi.spyOn(windGridFetcher, 'fetch').mockReturnValueOnce(d.promise);
    const o = bareFlow();
    const p = o._restart();
    o.pause();
    d.resolve(grid);
    await p;
    expect(o._running).toBe(false);
    expect(o._tick).not.toHaveBeenCalled();
    expect(o._grid).toBe(grid);
  });
});

describe('WindFlowOverlay zoom', () => {
  it('one zoom (zoomstart, movestart, zoomend, moveend) restarts the streamlines once', async () => {
    vi.spyOn(windGridFetcher, 'fetch').mockResolvedValue({ rows: 1, cols: 1, latMin: 0, lonMin: 0, step: 1, cells: [[{ u: 0, v: 0 }]] });
    const handlers: Record<string, () => void> = {};
    const o: any = new WindFlowOverlay(fakeMap(handlers), { source: 'dwd_icon' });
    await Promise.resolve();
    const restart = vi.spyOn(o, '_restart');
    // Leaflet's _moveEnd fires zoomend, then moveend, in one dispatch.
    handlers.zoomstart(); handlers.movestart(); handlers.zoomend(); handlers.moveend();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(o._canvas.style.opacity).toBe('');
    o.destroy();
  });
});
