// onMapQuiet: a callback that runs once the map has been still for MAP_QUIET_MS
// after a move or zoom, so hazard overlays rebuild and large canvases come
// back after the gesture's compositing has settled, not on the same
// dispatch as Leaflet's moveend (crashed Safari on an iPhone, 2026-10-16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onMapQuiet, MAP_QUIET_MS } from '../src/map-quiet';

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeMap(): any {
  const listeners = new Map<string, Array<() => void>>();
  const split = (events: string) => events.split(' ').filter(Boolean);
  return {
    on: vi.fn((events: string, fn: () => void) => { for (const e of split(events)) listeners.set(e, [...(listeners.get(e) ?? []), fn]); }),
    off: vi.fn((events: string, fn: () => void) => { for (const e of split(events)) listeners.set(e, (listeners.get(e) ?? []).filter((f) => f !== fn)); }),
    fire: (event: string) => { for (const fn of listeners.get(event) ?? []) fn(); },
    count: (event: string) => (listeners.get(event) ?? []).length,
  };
}

describe('onMapQuiet', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs MAP_QUIET_MS after moveend, not before', () => {
    const map = fakeMap();
    const cb = vi.fn();
    onMapQuiet(map, cb);
    map.fire('moveend');
    vi.advanceTimersByTime(MAP_QUIET_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a gesture that starts again within the window cancels it; the next end re-arms', () => {
    const map = fakeMap();
    const cb = vi.fn();
    onMapQuiet(map, cb);
    map.fire('moveend');
    vi.advanceTimersByTime(60);
    map.fire('movestart');
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
    map.fire('moveend');
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('pinch events (zoom, move) during the gesture keep it cancelled', () => {
    const map = fakeMap();
    const cb = vi.fn();
    onMapQuiet(map, cb);
    map.fire('zoomstart');
    for (let i = 0; i < 5; i++) { map.fire('zoom'); map.fire('move'); vi.advanceTimersByTime(40); }
    map.fire('zoomend');
    map.fire('moveend');
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('zoomend followed by moveend in the same dispatch runs the callback once', () => {
    const map = fakeMap();
    const cb = vi.fn();
    onMapQuiet(map, cb);
    map.fire('zoomend');
    map.fire('moveend');
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('the disposer removes the listeners and drops a pending run', () => {
    const map = fakeMap();
    const cb = vi.fn();
    const dispose = onMapQuiet(map, cb);
    map.fire('moveend');
    dispose();
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(cb).not.toHaveBeenCalled();
    for (const e of ['movestart', 'zoomstart', 'move', 'zoom', 'moveend', 'zoomend']) expect(map.count(e)).toBe(0);
  });

  it('accepts a custom quiet period', () => {
    const map = fakeMap();
    const cb = vi.fn();
    onMapQuiet(map, cb, 250);
    map.fire('moveend');
    vi.advanceTimersByTime(249);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
