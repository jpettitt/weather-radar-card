// A hidden card's map still moves: tracking runs on every hass update. The
// paused wind arrows refetched and rebuilt on each moveend, and the paused
// wildfire layer fetched outlines on each quiet moment. Real Leaflet map.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import * as L from 'leaflet';
import { WindOverlay } from '../src/wind-overlay';
import { windGridFetcher } from '../src/wind-grid-fetcher';
import { WildfireLayer } from '../src/wildfire-layer';
import { MAP_QUIET_MS } from '../src/map-quiet';

/* eslint-disable @typescript-eslint/no-explicit-any */

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
beforeAll(() => {
  const ctx: any = new Proxy({}, { get: (_t, p) => (p === 'canvas' ? undefined : () => undefined), set: () => true });
  (HTMLCanvasElement.prototype as any).getContext = () => ctx;
});

describe('WindOverlay paused', () => {
  it('does not fetch or rebuild when the map moves while paused', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(windGridFetcher, 'fetch').mockImplementation(() => new Promise(() => {}));
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 600 });
    Object.defineProperty(el, 'clientHeight', { value: 400 });
    document.body.appendChild(el);
    const map = L.map(el).setView([40, -100], 7, { animate: false });
    const o = new WindOverlay(map, { style: 'barbs' } as any);
    const atStart = spy.mock.calls.length;
    o.pause();                          // card scrolled off-screen
    map.panBy([200, 0], { animate: false });   // tracked marker moves the hidden map
    await vi.advanceTimersByTimeAsync(2000);
    expect(spy.mock.calls.length).toBe(atStart);
    o.resume();
    expect(spy.mock.calls.length).toBe(atStart + 1);
    o.destroy();
  });
});

describe('WildfireLayer paused', () => {
  it('fetches no outlines when the map moves while paused; resume catches up', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 600 });
    Object.defineProperty(el, 'clientHeight', { value: 400 });
    document.body.appendChild(el);
    const map = L.map(el).setView([40, -100], 12, { animate: false });
    const l: any = new WildfireLayer(map, () => ({ type: 'custom:weather-radar-card' } as any), undefined);
    l.start();
    const box = { type: 'Polygon', coordinates: [[[-100.01, 39.99], [-99.99, 39.99], [-99.99, 40.01], [-100.01, 40.01], [-100.01, 39.99]]] };
    l._features = [{ type: 'Feature', id: '1', properties: { poly_IncidentName: 'Big', poly_DateCurrent: 1 }, geometry: box }];
    const detail = vi.spyOn(l, '_showDetail');
    l.pause();
    map.panBy([50, 0], { animate: false });
    await vi.advanceTimersByTimeAsync(MAP_QUIET_MS + 100);
    expect(detail).not.toHaveBeenCalled();
    l.resume();
    expect(detail).toHaveBeenCalledOnce();
    l.clear();
    vi.unstubAllGlobals();
  });
});
