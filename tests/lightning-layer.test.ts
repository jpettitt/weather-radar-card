/* eslint-disable @typescript-eslint/no-explicit-any */
// LightningLayer through its real start / updateHass / pause paths (pre-4.0
// review, 2026-10-26). Leaflet, the map and the 2D context are faked; the
// context counts calls so a test can count repaints and buffer rebuilds.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  const DomUtil = { setPosition: vi.fn() };
  return { DomUtil, default: { DomUtil } };
});

import { LightningLayer } from '../src/lightning-layer';
import { MAP_QUIET_MS } from '../src/map-quiet';

const ctxByCanvas = new WeakMap<object, any>();

function countingCtx(): any {
  return {
    setTransforms: 0, clears: 0,
    setTransform() { this.setTransforms++; },
    clearRect() { this.clears++; },
    fill() {}, stroke() {}, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {},
  };
}

// lat/lon in [0, 1] map across the viewport, so every strike is on-canvas.
function fakeMap(size = { x: 400, y: 300 }): any {
  const panes: Record<string, HTMLElement> = {};
  const handlers: Record<string, Array<() => void>> = {};
  const map: any = {
    getPane: (n: string) => panes[n],
    createPane: (n: string) => { panes[n] = document.createElement('div'); return panes[n]; },
    on(ev: string, fn: () => void) { for (const e of ev.split(' ')) (handlers[e] ??= []).push(fn); return map; },
    off(ev: string, fn: () => void) { for (const e of ev.split(' ')) handlers[e] = (handlers[e] ?? []).filter((f) => f !== fn); return map; },
    fire(ev: string) { for (const f of [...(handlers[ev] ?? [])]) f(); },
    getSize: () => size,
    containerPointToLayerPoint: ([x, y]: [number, number]) => ({ x, y }),
    latLngToLayerPoint: ([lat, lon]: [number, number]) => ({ x: lon * size.x, y: lat * size.y }),
    latLngToContainerPoint: ([lat, lon]: [number, number]) => ({ x: lon * size.x, y: lat * size.y }),
    getContainer: () => document.createElement('div'),
    closePopup: () => undefined,
  };
  return map;
}

function strikeState(tsMs: number, lat: number, lon: number): any {
  return { state: '10', attributes: { source: 'blitzortung', latitude: lat, longitude: lon, publication_date: new Date(tsMs).toISOString() } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  vi.stubGlobal('Path2D', class { constructor(_p?: string) { void _p; } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let c = ctxByCanvas.get(this);
    if (!c) { c = countingCtx(); ctxByCanvas.set(this, c); }
    return c;
  } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LightningLayer view reset', () => {
  it('a same-zoom view reset hides the canvas until the quiet repaint re-pins it', () => {
    const map = fakeMap();
    const states = { 'geo_location.a': strikeState(Date.now() - 60_000, 0.5, 0.5) };
    const l: any = new LightningLayer(map, () => ({ show_lightning: true } as any), { states } as any);
    l.start();
    vi.advanceTimersByTime(50);
    const rebuildsBefore = ctxByCanvas.get(l._buffer).setTransforms;
    // Leaflet _resetView order for a jump past the map size at the same zoom.
    map.fire('movestart'); map.fire('move'); map.fire('moveend'); map.fire('viewreset');
    expect(l._canvas.style.display).toBe('none');
    vi.advanceTimersByTime(MAP_QUIET_MS - 1);
    expect(l._canvas.style.display).toBe('none');
    vi.advanceTimersByTime(50);
    expect(l._canvas.style.display).toBe('');
    expect(ctxByCanvas.get(l._buffer).setTransforms).toBeGreaterThan(rebuildsBefore);
    l.clear();
  });
});

describe('LightningLayer storm cost', () => {
  it('a storm tick with one arrival and one age-out does not rebuild the buffer; the 30 s age pass does', () => {
    const map = fakeMap();
    // 300 strikes, one every 6 s over the 30 min default cap.
    const states: Record<string, any> = {};
    let n = 0;
    for (let i = 0; i < 300; i++) states[`geo_location.s${n++}`] = strikeState(Date.now() - i * 6000 - 1000, (i % 17) / 17, (i % 23) / 23);
    const l: any = new LightningLayer(map, () => ({ show_lightning: true } as any), { states: { ...states } } as any);
    l.start();
    vi.advanceTimersByTime(50);
    const bctx = ctxByCanvas.get(l._buffer);
    const before = bctx.setTransforms;
    // 60 s of storm: each 6 s tick brings one strike and ages one past the cap.
    for (let step = 0; step < 10; step++) {
      vi.advanceTimersByTime(6000);
      states[`geo_location.s${n++}`] = strikeState(Date.now(), 0.5, 0.5);
      l.updateHass({ states: { ...states } } as any);
    }
    vi.advanceTimersByTime(50);
    // The age timer runs twice in 60 s; 10 ticks must not add rebuilds.
    expect(bctx.setTransforms - before).toBeLessThanOrEqual(2);
    expect(l._strikes.size).toBeLessThanOrEqual(301);
    l.clear();
  });

  it('a strike hass drops inside the cap is erased at once', () => {
    const map = fakeMap();
    const kept = strikeState(Date.now() - 180_000, 0.2, 0.2);
    const states: Record<string, any> = { 'geo_location.a': strikeState(Date.now() - 120_000, 0.5, 0.5), 'geo_location.b': kept };
    const l: any = new LightningLayer(map, () => ({ show_lightning: true } as any), { states: { ...states } } as any);
    l.start();
    vi.advanceTimersByTime(50);
    const bctx = ctxByCanvas.get(l._buffer);
    const before = bctx.setTransforms;
    l.updateHass({ states: { 'geo_location.b': kept } } as any);
    vi.advanceTimersByTime(50);
    expect(l._strikes.size).toBe(1);
    expect(bctx.setTransforms).toBeGreaterThan(before);
    l.clear();
  });
});

describe('LightningLayer pause', () => {
  it('strikes that arrive while paused do not repaint the hidden canvas; resume repaints', () => {
    const states: Record<string, any> = {};
    const l: any = new LightningLayer(fakeMap(), () => ({ show_lightning: true } as any), { states } as any);
    l.start();
    vi.advanceTimersByTime(50);
    l.pause();
    const ctx = ctxByCanvas.get(l._canvas);
    const c0 = ctx.clears;
    for (let i = 0; i < 10; i++) {
      states[`geo_location.s${i}`] = strikeState(Date.now(), 0.5, 0.5);
      l.updateHass({ states: { ...states } } as any);
      vi.advanceTimersByTime(1000);
    }
    expect(ctx.clears - c0).toBe(0);
    expect(l._strikes.size).toBe(10);
    l.resume();
    vi.advanceTimersByTime(50);
    expect(ctx.clears - c0).toBe(1);
    l.clear();
  });
});
