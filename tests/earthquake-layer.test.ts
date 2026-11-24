/* eslint-disable @typescript-eslint/no-explicit-any */
// EarthquakeLayer through its real code on a real Leaflet map (happy-dom).
// Only fetch, the timers and the 2D context are faked. The fake fetch
// answers with ten features exactly as the USGS feeds sent them
// (tests/fixtures/usgs-feed-sample.json).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as L from 'leaflet';
import {
  EarthquakeLayer, AGE_COLORS, ageClass, buildPopupHtml, earthquakeFeedUrl, earthquakeSettings,
  markerDiameter, meetsMinMagnitude, parseQuakes, type Quake,
} from '../src/earthquake-layer';
import { DATA_TIMEOUT_MS } from '../src/fetch-timeout';
import { MAP_QUIET_MS } from '../src/map-quiet';

const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/usgs-feed-sample.json'), 'utf8'));
// The feed's own generation time: the fixture's ages are real at this moment.
const GENERATED = FIXTURE.metadata.generated as number;
const MIN = 60_000;
const HOUR = 60 * MIN;

interface Shape { kind: 'circle' | 'diamond'; x: number; y: number; r: number; fill: string; stroke: string }

// Records what the last paint drew. clearRect starts a paint.
function recordingCtx(): any {
  const ctx: any = {
    shapes: [] as Shape[], fillStyle: '', strokeStyle: '', lineWidth: 1, pending: null as Shape | null,
    setTransform() {},
    clearRect() { ctx.shapes = []; },
    beginPath() { ctx.pending = null; },
    arc(x: number, y: number, r: number) { ctx.pending = { kind: 'circle', x, y, r, fill: '', stroke: '' }; },
    moveTo(x: number, y: number) { ctx.pending = { kind: 'diamond', x, y, r: 0, fill: '', stroke: '' }; },
    lineTo(x: number, y: number) { if (ctx.pending?.kind === 'diamond' && ctx.pending.r === 0) { ctx.pending.r = x - ctx.pending.x; ctx.pending.y = y; } },
    closePath() {},
    fill() { ctx.pending.fill = ctx.fillStyle; },
    stroke() { ctx.pending.stroke = ctx.strokeStyle; ctx.shapes.push(ctx.pending); },
  };
  return ctx;
}

let ctx: any;
let fetchMock: ReturnType<typeof vi.fn>;

function makeMap(center: [number, number] = [0, 0], zoom = 0): L.Map {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 600 });
  Object.defineProperty(el, 'clientHeight', { value: 400 });
  document.body.appendChild(el);
  return L.map(el, { attributionControl: false, zoomControl: false }).setView(center, zoom, { animate: false });
}

const feedResponse = (data: unknown = FIXTURE): Response => new Response(JSON.stringify(data), { status: 200 });

function makeLayer(map: L.Map, cfg: Record<string, unknown> = {}, opts: { dark?: boolean; hass?: any } = {}): EarthquakeLayer {
  return new EarthquakeLayer(map, () => ({ type: 'custom:weather-radar-card', ...cfg } as any), () => opts.hass, () => opts.dark === true);
}

// Let the fetch resolve and the rAF paint run.
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(50).then(() => undefined);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(GENERATED);
  ctx = recordingCtx();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  fetchMock = vi.fn(async () => feedResponse());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('feed choice', () => {
  const LEVELS: Record<string, number> = { '4.5': 4.5, '2.5': 2.5, '1.0': 1, all: -Infinity };

  it('uses the coarsest feed that still holds every event at the minimum', () => {
    for (let m = -2; m <= 8; m = Math.round((m + 0.05) * 100) / 100) {
      for (const period of ['hour', 'day', 'week', 'month'] as const) {
        const url = earthquakeFeedUrl(m, period);
        const match = /\/summary\/(4\.5|2\.5|1\.0|all)_(hour|day|week|month)\.geojson$/.exec(url);
        expect(match, url).not.toBeNull();
        const level = LEVELS[match![1]];
        expect(match![2]).toBe(period);
        expect(level, `min ${m}`).toBeLessThanOrEqual(m);
        // No coarser feed would also do.
        for (const other of Object.values(LEVELS)) if (other > level) expect(other, `min ${m}`).toBeGreaterThan(m);
      }
    }
  });

  it('keeps what USGS keeps: the magnitude rounded to one decimal', () => {
    // nc75468742 (2.46) came in 2.5_week; 0.95 was in 1.0_week (2026-11-24).
    expect(meetsMinMagnitude(2.46, 2.5)).toBe(true);
    expect(meetsMinMagnitude(0.95, 1)).toBe(true);
    expect(meetsMinMagnitude(2.44, 2.5)).toBe(false);
    expect(meetsMinMagnitude(-0.07, 0)).toBe(false);
  });

  it('falls back to M2.5 for the past day on missing or bad values', () => {
    expect(earthquakeSettings({} as any)).toEqual({ minMagnitude: 2.5, period: 'day' });
    expect(earthquakeSettings({ earthquake_min_magnitude: Number.NaN, earthquake_period: 'year' } as any))
      .toEqual({ minMagnitude: 2.5, period: 'day' });
    expect(earthquakeSettings({ earthquake_min_magnitude: 0, earthquake_period: 'month' } as any))
      .toEqual({ minMagnitude: 0, period: 'month' });
  });
});

describe('marker style', () => {
  it('ages through hour, day, week, month and older, never back', () => {
    // As on the USGS map, an age equal to a limit is still in that class.
    expect([0, HOUR, HOUR + 1, 24 * HOUR + 1, 7 * 24 * HOUR + 1, 30 * 24 * HOUR + 1].map(ageClass)).toEqual([0, 0, 1, 2, 3, 4]);
    expect(ageClass(-5 * MIN)).toBe(0);
    let last = 0;
    for (let age = 0; age < 40 * 24 * HOUR; age += 17 * MIN) {
      expect(ageClass(age)).toBeGreaterThanOrEqual(last);
      last = ageClass(age);
    }
  });

  it('never draws a larger magnitude smaller', () => {
    for (const zoom of [0, 4.5, 5, 7.9, 8, 18]) {
      let last = 0;
      for (let m = -2; m <= 9.5; m += 0.1) {
        expect(markerDiameter(m, zoom)).toBeGreaterThanOrEqual(last);
        last = markerDiameter(m, zoom);
      }
      expect(markerDiameter(-1.3, zoom)).toBe(markerDiameter(0, zoom));
      expect(markerDiameter(9.1, zoom)).toBe(markerDiameter(7, zoom));
    }
  });

  it('uses the USGS map sizes, larger in each zoom band', () => {
    const classes = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(classes.map((m) => markerDiameter(m, 3))).toEqual([5, 7, 9, 11, 13, 17, 21, 25]);
    expect(classes.map((m) => markerDiameter(m, 6))).toEqual([8, 10, 12, 14, 17, 22, 27, 32]);
    expect(classes.map((m) => markerDiameter(m, 10))).toEqual([12, 13, 15, 17, 19, 24, 30, 36]);
    for (const m of classes) {
      expect(markerDiameter(m, 5)).toBeGreaterThan(markerDiameter(m, 4.9));
      expect(markerDiameter(m, 8)).toBeGreaterThan(markerDiameter(m, 7.9));
    }
  });
});

describe('parseQuakes', () => {
  it('reads every real feature, conditional fields included', () => {
    const qs = parseQuakes(FIXTURE);
    expect(qs).toHaveLength(10);
    const byId = new Map(qs.map((q) => [q.id, q]));
    expect(byId.get('us6000ucly')).toMatchObject({ mag: 5.9, alert: 'yellow', tsunami: false, depthKm: 10 });
    expect(byId.get('us6000ucvm')).toMatchObject({ tsunami: true, alert: 'green', depthKm: 598 });
    expect(byId.get('us6000ucx6')).toMatchObject({ felt: 1 });
    expect(byId.get('ci41579608')).toMatchObject({ type: 'quarry blast', depthKm: -0.51 });
    expect(byId.get('ci41579696')).toMatchObject({ status: 'automatic', felt: null, alert: null });
    expect(byId.get('us6000ucly')!.url).toBe('https://earthquake.usgs.gov/earthquakes/eventpage/us6000ucly');
  });

  it('leaves out events it cannot place, and links that are not https', () => {
    const f = (props: Record<string, unknown>, coords: unknown = [1, 2, 3], id: unknown = 'x') =>
      ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: coords }, properties: { mag: 2, time: 1, ...props } });
    const qs = parseQuakes({ features: [
      f({ mag: null }), f({}, [null, 2]), f({}, [1, 2], ''), null, f({ time: 'yesterday' }),
      f({ url: 'javascript:alert(1)' }, [1, 2, 3], 'kept'),
    ] });
    expect(qs.map((q) => q.id)).toEqual(['kept']);
    expect(qs[0].url).toBeNull();
    expect(parseQuakes(null)).toEqual([]);
    expect(parseQuakes({ features: 'x' })).toEqual([]);
  });
});

describe('popup', () => {
  const base: Quake = {
    id: 'a', lat: 1, lon: 2, depthKm: 10, mag: 5.9, time: GENERATED - 2 * HOUR, type: 'earthquake',
    place: 'Somewhere', url: 'https://earthquake.usgs.gov/earthquakes/eventpage/a', felt: null, alert: null,
    tsunami: false, status: 'reviewed',
  };

  it('escapes feed text', () => {
    const html = buildPopupHtml({ ...base, place: '<img src=x onerror=alert(1)>', type: 'quarry <b>blast</b>' }, undefined, GENERATED);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>blast');
    expect(html).toContain('&lt;img');
  });

  it('shows the tsunami note and the PAGER level only when the feed sets them', () => {
    const plain = buildPopupHtml(base, undefined, GENERATED);
    expect(plain).not.toContain('tsunami.gov');
    expect(plain).not.toContain('PAGER');
    const flagged = buildPopupHtml({ ...base, tsunami: true, alert: 'yellow', felt: 41 }, undefined, GENERATED);
    expect(flagged).toContain('https://www.tsunami.gov');
    expect(flagged).toContain('PAGER alert:</b>');
    expect(flagged).toContain('Yellow');
    expect(flagged).toContain('Felt reports:</b> 41');
  });

  it('a feed value that names an Object member does not break the popup', () => {
    const html = buildPopupHtml({ ...base, alert: 'constructor', status: 'constructor' }, undefined, GENERATED);
    expect(html).not.toContain('PAGER');
    expect(html).toContain('Status:</b> constructor');
  });

  it('gives depth in miles for imperial users, and names other event types', () => {
    const hass: any = { config: { unit_system: { length: 'mi' } } };
    const html = buildPopupHtml({ ...base, depthKm: 10, type: 'quarry blast' }, hass, GENERATED);
    expect(html).toContain('6.2 mi');
    expect(html).toContain('M 5.9 · Quarry blast');
  });

  it('links only to the event page it was given', () => {
    expect(buildPopupHtml(base, undefined, GENERATED)).toContain('href="https://earthquake.usgs.gov/earthquakes/eventpage/a"');
    expect(buildPopupHtml({ ...base, url: null }, undefined, GENERATED)).not.toContain('More info');
  });
});

describe('EarthquakeLayer', () => {
  it('fetches the feed for the config', async () => {
    for (const [cfg, file] of [
      [{}, '2.5_day'], [{ earthquake_min_magnitude: 0 }, 'all_day'],
      [{ earthquake_min_magnitude: 4.5, earthquake_period: 'month' }, '4.5_month'],
    ] as const) {
      fetchMock.mockClear();
      const map = makeMap();
      const layer = makeLayer(map, cfg);
      layer.start();
      await settle();
      expect(String(fetchMock.mock.calls[0][0])).toBe(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${file}.geojson`);
      layer.clear();
      map.remove();
    }
  });

  it('draws the USGS style: size by magnitude, colour by age, diamonds for other events', async () => {
    const map = makeMap();
    const layer = makeLayer(map, { earthquake_min_magnitude: -1 });
    layer.start();
    await settle();
    const shapes: Shape[] = ctx.shapes;
    expect(shapes).toHaveLength(10);
    expect(shapes.filter((s) => s.kind === 'diamond')).toHaveLength(3);   // quarry blast, explosion, ice quake
    expect(new Set(shapes.map((s) => s.stroke))).toEqual(new Set(['#000000']));
    // Past hour: ci41579696 (5 min old). Past week: the three over 24 h.
    expect(shapes.filter((s) => s.fill === AGE_COLORS[0])).toHaveLength(1);
    expect(shapes.filter((s) => s.fill === AGE_COLORS[2])).toHaveLength(4);
    // Bottom to top: never a larger shape over a smaller one.
    const radii = shapes.map((s) => s.r);
    expect(radii).toEqual([...radii].sort((a, b) => b - a));
    layer.clear();
    map.remove();
  });

  it('keeps the minimum magnitude, and outlines light on a dark map', async () => {
    const map = makeMap();
    const layer = makeLayer(map, {}, { dark: true });
    layer.start();
    await settle();
    // 6.5, 5.9, 5.4 and the 2.46 that USGS lists in the 2.5 feed, at zoom 0.
    expect(ctx.shapes.map((s: Shape) => s.r * 2)).toEqual([21, 17, 17, 9]);
    expect(ctx.shapes.every((s: Shape) => s.stroke !== '#000000')).toBe(true);
    layer.clear();
    map.remove();
  });

  it('keeps only events within earthquake_radius_km of the map centre', async () => {
    const map = makeMap([34.5, -118], 6);   // southern California
    const layer = makeLayer(map, { earthquake_min_magnitude: -1, earthquake_radius_km: 150 });
    layer.start();
    await settle();
    // Marina del Rey, Boron and the quarry blast; not Nevada, Montana or Pinnacles.
    const ids = layer._drawOrder().map((d) => d.q.id).sort();
    expect(ids).toEqual(['ci41579608', 'ci41579672', 'ci41579696']);
    layer.clear();
    map.remove();
  });

  it('draws events in the world copy the map shows', async () => {
    // A view of Asia reached by panning west from the US: Leaflet's
    // longitudes there are near -263, the feed's are near +97.
    const map = makeMap([35, -263], 4);
    const layer = makeLayer(map, { earthquake_min_magnitude: -1 });
    fetchMock.mockImplementation(async () => feedResponse({
      features: FIXTURE.features.concat([{   // east of 180, e.g. Tonga
        ...FIXTURE.features[1], id: 'tonga',
        geometry: { type: 'Point', coordinates: [-177.5, -20, 10] },
      }]),
    }));
    layer.start();
    await settle();
    const china = parseQuakes(FIXTURE).find((q) => q.id === 'us6000ucly')!;
    const pt = map.latLngToContainerPoint([china.lat, china.lon - 360]);
    const size = map.getSize();
    expect(pt.x > 0 && pt.x < size.x && pt.y > 0 && pt.y < size.y).toBe(true);   // the event is in view
    expect(layer._hitTest(pt)?.id).toBe('us6000ucly');
    map.fire('click', { containerPoint: pt, latlng: map.containerPointToLatLng(pt) });
    let at: L.LatLng | undefined;
    map.eachLayer((l) => { if (l instanceof L.Popup && l.isOpen()) at = l.getLatLng() ?? undefined; });
    expect(at?.lng).toBeCloseTo(china.lon - 360, 6);   // the popup opens at the marker
    layer.clear();
    map.remove();

    // Centred on the 180° line: an event at -177.5 is drawn just east of it.
    ctx = recordingCtx();
    const pacific = makeMap([-20, 180], 4);
    const l2 = makeLayer(pacific, { earthquake_min_magnitude: -1 });
    l2.start();
    await settle();
    const tp = pacific.latLngToContainerPoint([-20, 182.5]);
    expect(l2._hitTest(tp)?.id).toBe('tonga');
    l2.clear();
    pacific.remove();
  });

  it('recolours an event that crosses an age boundary without a fetch', async () => {
    const map = makeMap();
    const layer = makeLayer(map, { earthquake_min_magnitude: -1, earthquake_refresh_minutes: 600 });
    layer.start();
    await settle();
    expect(ctx.shapes.filter((s: Shape) => s.fill === AGE_COLORS[0])).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(56 * MIN);   // ci41579696 passes one hour
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.shapes.filter((s: Shape) => s.fill === AGE_COLORS[0])).toHaveLength(0);
    layer.clear();
    map.remove();
  });

  it('a click opens the largest event under it, and a refresh leaves the popup open', async () => {
    const map = makeMap([-13.585, 172.267], 6);   // Vanuatu
    const layer = makeLayer(map, { earthquake_min_magnitude: -1, earthquake_refresh_minutes: 1 });
    layer.start();
    await settle();
    // A small event drawn over the centre of the M6.5, and one just off its edge.
    const big = parseQuakes(FIXTURE).find((q) => q.id === 'us6000ucvm')!;
    const withExtra = (id: string, mag: number, place: string, dLon: number) => ({
      ...FIXTURE.features[1], id,
      geometry: { ...FIXTURE.features[1].geometry, coordinates: [big.lon + dLon, big.lat, 10] },
      properties: { ...FIXTURE.features[1].properties, mag, place },
    });
    fetchMock.mockImplementation(async () => feedResponse({
      features: FIXTURE.features.concat([withExtra('small', 1.1, 'On top', 0.01), withExtra('beside', 1.2, 'Beside', 0.6)]),
    }));
    await vi.advanceTimersByTimeAsync(MIN + 50);
    expect(layer._drawOrder().map((d) => d.q.id).indexOf('small'))
      .toBeGreaterThan(layer._drawOrder().map((d) => d.q.id).indexOf('us6000ucvm'));   // drawn over it
    const pt = map.latLngToContainerPoint([big.lat, big.lon]);
    map.fire('click', { containerPoint: pt, latlng: map.containerPointToLatLng(pt) });
    let open: L.Popup[] = [];
    map.eachLayer((l) => { if (l instanceof L.Popup && l.isOpen()) open.push(l); });
    expect(open).toHaveLength(1);
    expect(String(open[0].getContent())).toContain('Vanuatu region');
    // Outside the M6.5's circle the small one is reachable.
    expect(layer._hitTest(map.latLngToContainerPoint([big.lat, big.lon + 0.6]))?.id).toBe('beside');
    await vi.advanceTimersByTimeAsync(3 * MIN);   // three more refreshes
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    open = [];
    map.eachLayer((l) => { if (l instanceof L.Popup && l.isOpen()) open.push(l); });
    expect(open).toHaveLength(1);
    // Off every event: nothing opens.
    expect(layer._hitTest({ x: 1, y: 1 })).toBeNull();
    layer.clear();
    map.remove();
  });

  it('a failed fetch keeps what is drawn and backs off', async () => {
    const map = makeMap();
    const layer = makeLayer(map, { earthquake_refresh_minutes: 1 });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    layer.start();
    await settle();
    expect(ctx.shapes).toHaveLength(4);
    fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
    const at = (): number => fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MIN);        // fails (1st failure)
    expect(at()).toBe(2);
    await vi.advanceTimersByTimeAsync(MIN);        // retry after 1 min fails (2nd)
    expect(at()).toBe(3);
    await vi.advanceTimersByTimeAsync(MIN);        // next one waits 2 min
    expect(at()).toBe(3);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(at()).toBe(4);
    expect(ctx.shapes).toHaveLength(4);
    layer.clear();
    map.remove();
  });

  it('a request that never answers times out and is tried again', async () => {
    const map = makeMap();
    const layer = makeLayer(map);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    layer.start();
    await vi.advanceTimersByTimeAsync(DATA_TIMEOUT_MS + 5 * MIN + 100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    layer.clear();
    map.remove();
  });

  it('hidden and shown more often than the refresh interval still refreshes', async () => {
    const map = makeMap();
    const layer = makeLayer(map, { earthquake_refresh_minutes: 5 });
    layer.start();
    await settle();
    for (let i = 0; i < 10; i++) {   // 30 min, a hide/show every 3 min
      await vi.advanceTimersByTimeAsync(3 * MIN);
      layer.pause();
      layer.resume();
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    layer.clear();
    map.remove();
  });

  it('fetches nothing while hidden, and at once when shown after the refresh came due', async () => {
    const map = makeMap();
    const layer = makeLayer(map);
    layer.start();
    await settle();
    layer.pause();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    layer.resume();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    layer.clear();
    map.remove();
  });

  it('keeps fetching while hidden with preload_while_hidden', async () => {
    const map = makeMap();
    const layer = makeLayer(map, { preload_while_hidden: true });
    layer.start();
    await settle();
    layer.pause();
    await vi.advanceTimersByTimeAsync(10 * MIN + 100);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    layer.clear();
    map.remove();
  });

  it('clear() stops everything: no fetch, no canvas, no handler', async () => {
    const map = makeMap();
    const layer = makeLayer(map, { earthquake_min_magnitude: -1 });
    let pending: ((r: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { pending = resolve; }));
    layer.start();
    expect(map.getContainer().querySelector('.leaflet-pane canvas')).not.toBeNull();
    layer.clear();
    pending!(feedResponse());
    await vi.advanceTimersByTimeAsync(2 * HOUR + MAP_QUIET_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(map.getContainer().querySelector('.leaflet-pane canvas')).toBeNull();
    expect(layer._hitTest({ x: 300, y: 200 })).toBeNull();
    map.remove();
  });
});
