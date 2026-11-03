// Regression coverage for the one-canvas-renderer-per-map rule.
//
// Live-debugged: NWS alert polygons stopped being clickable the moment
// the wildfire layer lazily created its OWN canvas renderer (first fire
// crossing the icon→polygon zoom threshold) — the second canvas stacked
// over the first and swallowed its clicks, and stayed dead after
// zooming back out. The fix is a single shared renderer per map; these
// tests pin the sharing contract.
//
// The renderer's canvas is also hidden while the map zooms: Leaflet scales
// it with a CSS transform on every touch move of a pinch, and that killed
// Safari on an iPhone whenever an overlay had drawn to it (2026-10-16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MAP_QUIET_MS } from '../src/map-quiet';

vi.mock('leaflet', () => {
  const canvas = vi.fn((opts?: unknown) => ({ kind: 'canvas-renderer', opts }));
  return { canvas, default: { canvas } };
});

import * as L from 'leaflet';
import { sharedCanvasRenderer, hideWhileZooming } from '../src/shared-canvas-renderer';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A map stub that records listeners (space-separated event lists, as Leaflet takes them) so a test can fire them. */
function fakeMap(): any {
  const listeners = new Map<string, Array<() => void>>();
  const split = (events: string) => events.split(' ').filter(Boolean);
  return {
    listeners,
    on: vi.fn((events: string, fn: () => void) => { for (const e of split(events)) listeners.set(e, [...(listeners.get(e) ?? []), fn]); }),
    off: vi.fn((events: string, fn: () => void) => { for (const e of split(events)) listeners.set(e, (listeners.get(e) ?? []).filter((f) => f !== fn)); }),
    fire: (event: string) => { for (const fn of listeners.get(event) ?? []) fn(); },
  };
}

beforeEach(() => {
  (L.canvas as unknown as ReturnType<typeof vi.fn>).mockClear();
});

describe('sharedCanvasRenderer', () => {
  it('returns the same renderer instance for the same map', () => {
    const map = fakeMap();
    const a = sharedCanvasRenderer(map);
    const b = sharedCanvasRenderer(map);
    expect(a).toBe(b);
    expect(L.canvas).toHaveBeenCalledTimes(1);
  });

  it('returns distinct renderers for distinct maps (card rebuild gets a fresh one)', () => {
    expect(sharedCanvasRenderer(fakeMap())).not.toBe(sharedCanvasRenderer(fakeMap()));
  });

  it('creates the renderer with pan padding', () => {
    sharedCanvasRenderer(fakeMap());
    expect(L.canvas).toHaveBeenCalledWith({ padding: 0.5 });
  });

  it('subscribes the hide-while-zooming hooks once per map', () => {
    const map = fakeMap();
    sharedCanvasRenderer(map);
    sharedCanvasRenderer(map);
    // zoomstart: the hide itself plus the quiet gate's cancel; moveend: the quiet gate's arm.
    expect(map.listeners.get('zoomstart')).toHaveLength(2);
    expect(map.listeners.get('moveend')).toHaveLength(1);
  });
});

describe('hideWhileZooming', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takes the canvas out of the page on zoomstart and puts it back MAP_QUIET_MS after moveend', () => {
    const map = fakeMap();
    const r: any = { _container: { style: { display: '' } } };
    hideWhileZooming(map, r);
    map.fire('zoomstart');
    expect(r._container.style.display).toBe('none');
    map.fire('zoomend');
    map.fire('moveend');
    expect(r._container.style.display).toBe('none');   // not on Leaflet's moveend itself
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(r._container.style.display).toBe('');
  });

  it('a gesture that resumes within the quiet window keeps the canvas out', () => {
    const map = fakeMap();
    const r: any = { _container: { style: { display: '' } } };
    hideWhileZooming(map, r);
    map.fire('zoomstart');
    map.fire('moveend');
    vi.advanceTimersByTime(50);
    map.fire('zoomstart');
    vi.advanceTimersByTime(200);
    expect(r._container.style.display).toBe('none');
    map.fire('moveend');
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(r._container.style.display).toBe('');
  });

  it('a plain pan never hides the canvas', () => {
    const map = fakeMap();
    const r: any = { _container: { style: { display: '' } } };
    hideWhileZooming(map, r);
    map.fire('movestart');
    map.fire('moveend');
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(r._container.style.display).toBe('');
  });

  it('is a no-op before the renderer has a canvas (not added to the map yet)', () => {
    const map = fakeMap();
    const r: any = {};
    hideWhileZooming(map, r);
    expect(() => { map.fire('zoomstart'); map.fire('moveend'); }).not.toThrow();
  });
});
