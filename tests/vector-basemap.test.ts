// map_style: MapTilesVector — HA's vector map as a MapLibre layer under the
// radar. MapLibre itself can't run here (no WebGL), so the module that wraps
// it is faked at the edge; everything that decides when to start, what to
// request and when to fall back to raster runs for real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  (TileLayer as unknown as { WMS: unknown }).WMS = class {};
  return { Layer, TileLayer, default: { Layer, TileLayer } };
});

import {
  startVectorBasemap, withMapTilesToken, loadVectorStyle, instanceOrigin, splitLabels, _setWebGL2ForTests,
} from '../src/vector-basemap';
import { buildVectorStyle, finishForHa } from '../src/vector-styles';
import {
  resolveBasemapStyle, isDarkBasemapStyle, isInvertedBasemap, basemapCredits, vectorStyleName,
} from '../src/basemap-styles';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORIGIN = 'http://ha.local:8123';
const STYLE = { version: 8, sprite: [{ id: 'base', url: '/static/map/sprites/base?v=1' }], sources: {}, layers: [] };
// HA 2026.10's /static/map/urls.json.
const URLS = { base: '', glyphsPattern: '/api/map_tiles/fonts/{fontstack}/{range}.pbf', sprite: [{ id: 'base', url: '/static/map/sprites/base?v=2' }] };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('vector basemap URLs and style', () => {
  it('makes proxy URLs absolute and adds the token; leaves other hosts alone', () => {
    expect(withMapTilesToken('/api/map_tiles/tilejson.json', ORIGIN, 'tok'))
      .toBe(`${ORIGIN}/api/map_tiles/tilejson.json?token=tok`);
    expect(withMapTilesToken(`${ORIGIN}/api/map_tiles/fonts/Noto%20Sans/0-255.pbf?token=old`, ORIGIN, 'new'))
      .toBe(`${ORIGIN}/api/map_tiles/fonts/Noto%20Sans/0-255.pbf?token=new`);
    expect(withMapTilesToken('/static/map/sprites/base.json', ORIGIN, 'tok')).toBe(`${ORIGIN}/static/map/sprites/base.json`);
    expect(withMapTilesToken('/api/map_tiles/tilejson.json', ORIGIN, undefined)).toBe(`${ORIGIN}/api/map_tiles/tilejson.json`);
  });

  it("uses HA's instance URL, which on Cast isn't the page's", () => {
    expect(instanceOrigin({ auth: { data: { hassUrl: 'http://ha.local:8123/' } } } as any)).toBe(ORIGIN);
    expect(instanceOrigin(undefined)).toBe(location.origin);
  });

  describe('loadVectorStyle', () => {
    const realFetch = global.fetch;
    let requested: string[];
    beforeEach(() => {
      requested = [];
      global.fetch = vi.fn(async (url: string) => {
        requested.push(String(url));
        return new Response(JSON.stringify(STYLE));
      }) as unknown as typeof fetch;
    });
    afterEach(() => { global.fetch = realFetch; });

    it("flattens HA's globe to Mercator, to stay aligned with Leaflet's map", async () => {
      global.fetch = vi.fn(async () => new Response(JSON.stringify({ ...STYLE, projection: { type: 'globe' }, sky: {} }))) as unknown as typeof fetch;
      const style = await loadVectorStyle(ORIGIN, false);
      expect(style.projection).toEqual({ type: 'mercator' });
      expect(style.sky).toBeUndefined();
    });

    it("fetches HA's light or dark style and makes the sprite URL absolute", async () => {
      const light = await loadVectorStyle(ORIGIN, false);
      await loadVectorStyle(ORIGIN, true);
      expect(requested).toEqual([`${ORIGIN}/static/map/light.json`, `${ORIGIN}/static/map/dark.json`]);
      expect(light.sprite[0].url).toBe(`${ORIGIN}/static/map/sprites/base?v=1`);
    });

    it('fails on a missing style, so the card falls back to raster', async () => {
      global.fetch = vi.fn(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
      await expect(loadVectorStyle(ORIGIN, false)).rejects.toThrow('style 404');
    });
  });
});

// The real VersaTiles builder. HA's Default style comes out of the same
// steps, and on 2026.10 this output's source and all 48 label expressions
// matched HA's light.json exactly (checked 2026-10-08).
describe('buildVectorStyle', () => {
  const muted = buildVectorStyle('muted', URLS);
  const symbol = (id: string): any => muted.layers.find((l: any) => l.id === id);

  it("points the one tile source at map_tiles' TileJSON", () => {
    expect(muted.sources).toEqual({ 'versatiles-shortbread': { type: 'vector', url: '/api/map_tiles/tilejson.json' } });
    expect(muted.glyphs).toBe(URLS.glyphsPattern);
  });

  it('is flat, without sky', () => {
    expect(muted.projection).toEqual({ type: 'mercator' });
    expect(muted.sky).toBeUndefined();
  });

  it('adds English to non-Latin names: below for points, in brackets along lines', () => {
    const point = symbol('poi-amenity').layout['text-field'];
    const line = symbol('label-street-track').layout['text-field'];
    expect(point.slice(0, 5)).toEqual(['case', ['<', ['get', 'name'], '\u0250'], ['get', 'name'], ['!', ['has', 'name_en']], ['get', 'name']]);
    expect(point[5]).toEqual(['format', ['get', 'name'], {}, '\n', {}, ['get', 'name_en'], { 'font-scale': 0.8 }]);
    expect(line[5]).toEqual(['concat', ['get', 'name'], ' (', ['get', 'name_en'], ')']);
    // Labels that aren't just the name (house numbers, refs) stay as they are.
    expect(muted.layers.filter((l: any) => l.type === 'symbol' && JSON.stringify(l.layout?.['text-field']) === '["get","name"]')).toEqual([]);
  });

  it('leaves labels that aren\'t just the name, and everything that isn\'t a label, alone', () => {
    const raw = buildVectorStyle('muted', URLS); // already finished: run the step on a fresh copy
    const fresh = structuredClone(raw);
    const housenumber = fresh.layers.find((l: any) => l.id === 'label-address-housenumber');
    const before = JSON.stringify(housenumber.layout['text-field']);
    const fill = fresh.layers.find((l: any) => l.type === 'fill');
    finishForHa(fresh);
    expect(JSON.stringify(housenumber.layout['text-field'])).toBe(before);
    expect(fill.layout?.['text-field']).toBeUndefined();
  });

  it("drops VersaTiles' own tile URLs and zoom range for map_tiles' TileJSON", () => {
    const style = {
      sources: { osm: { type: 'vector', url: 'https://tiles.versatiles.org/tiles/osm.json', tiles: ['x'], attribution: 'a', bounds: [0, 0, 1, 1], minzoom: 0, maxzoom: 14, scheme: 'xyz' } },
      layers: [],
    };
    expect(finishForHa(style).sources).toEqual({ osm: { type: 'vector', url: '/api/map_tiles/tilejson.json' } });
  });

  it('refuses a style with more than one tile source, which it would repoint wrongly', () => {
    expect(() => finishForHa({ sources: { a: {}, b: {} }, layers: [] })).toThrow('expected one tile source, got 2');
  });

  it.each(['classic', 'colorful', 'natural', 'muted', 'gray', 'toner'])('builds a dark variant of %s', (theme) => {
    const background = (s: any): unknown => s.layers.find((l: any) => l.type === 'background').paint['background-color'];
    expect(background(buildVectorStyle(`${theme}-dark`, URLS))).not.toEqual(background(buildVectorStyle(theme, URLS)));
  });

  it("classic: the classic OpenStreetMap colours on Colorful's cartography, light and dark", () => {
    const paint = (s: any, id: string, prop: string): unknown => s.layers.find((l: any) => l.id === id)?.paint?.[prop];
    const light = buildVectorStyle('classic', URLS);
    expect(paint(light, 'land-residential', 'fill-color')).toBe('rgb(224,223,223)');   // #e0dfdf
    expect(paint(light, 'water-area', 'fill-color')).toBe('rgb(170,211,223)');          // #aad3df
    expect(paint(light, 'land-forest', 'fill-color')).toBe('rgb(173,209,158)');         // #add19e
    // The builder derives primary and secondary from the trunk colour, so these are set per layer.
    expect(paint(light, 'street-primary', 'line-color')).toBe('#fcd6a4');
    expect(paint(light, 'street-primary:outline', 'line-color')).toBe('#a06b00');
    expect(paint(light, 'street-secondary', 'line-color')).toBe('#f7fabf');
    expect(paint(light, 'street-motorway', 'line-color')).toBe('rgb(232,146,162)');     // #e892a2
    const dark = buildVectorStyle('classic-dark', URLS);
    expect(paint(dark, 'water-area', 'fill-color')).toBe('rgb(29,53,80)');              // blue, not the inverted raster's brown
    expect(paint(dark, 'land-forest', 'fill-color')).toBe('rgb(34,51,38)');             // green, not purple
    expect(paint(dark, 'street-primary', 'line-color')).toBe('#a39372');
    expect(paint(dark, 'street-minor', 'line-color')).toBe('rgb(107,110,117)');         // light grey roads, as the raster dark has
    expect(light.sources['versatiles-shortbread'].url).toBe('/api/map_tiles/tilejson.json');
  });

  it('classic shows forests as soon as the tiles carry them (tile zoom 7), where Colorful fades them in to 8', () => {
    const forest = (s: any): any => s.layers.find((l: any) => l.id === 'land-forest');
    expect(forest(buildVectorStyle('classic', URLS)).minzoom).toBe(7);
    expect(forest(buildVectorStyle('classic', URLS)).paint['fill-opacity']).toBe(1);
    expect(forest(buildVectorStyle('classic-dark', URLS)).paint['fill-opacity']).toBe(1);
    expect(Array.isArray(forest(buildVectorStyle('colorful', URLS)).paint['fill-opacity'])).toBe(true);
  });
});

describe('splitLabels', () => {
  it('puts the labels in a style of their own, leaving the rest and the input alone', () => {
    const muted = buildVectorStyle('muted', URLS);
    const before = JSON.stringify(muted);
    const { base, labels } = splitLabels(muted);
    expect(labels.layers.length).toBe(48);
    expect(labels.layers.every((l: any) => l.type === 'symbol')).toBe(true);
    expect(base.layers.some((l: any) => l.type === 'symbol')).toBe(false);
    expect(base.layers.length + labels.layers.length).toBe(muted.layers.length);
    expect(labels.sources).toEqual(muted.sources);
    expect(labels.glyphs).toBe(muted.glyphs);
    expect(JSON.stringify(muted)).toBe(before);
  });
});

describe('startVectorBasemap', () => {
  const realFetch = global.fetch;
  type FakeGl = {
    handlers: Record<string, (e?: any) => void>;
    once: (ev: string, fn: () => void) => void;
    onceHandlers: Record<string, () => void>;
    // MapLibre's map.style: null while its WebGL context is lost.
    style: object | null;
    setStyle: ReturnType<typeof vi.fn>;
    on: (ev: string, fn: (e?: any) => void) => void;
  };
  type FakeLayer = { addTo: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; getMaplibreMap: () => FakeGl };
  let hass: any;
  // The basemap layer, then the label layer, in the order the code creates them.
  let gl: FakeGl;
  let layer: FakeLayer;
  let labelGl: FakeGl;
  let labelLayer: FakeLayer;
  let created: any[];
  let onFallback: ReturnType<typeof vi.fn<(reason: string) => void>>;
  let panes: Record<string, { style: Record<string, string> }>;
  const map = {
    getContainer: () => ({ getRootNode: () => document }),
    getPane: (name: string) => panes[name],
    createPane: (name: string) => (panes[name] = { style: {} }),
  } as any;
  const makeLayer = (): [FakeGl, FakeLayer] => {
    const g: FakeGl = {
      handlers: {}, onceHandlers: {}, style: {}, setStyle: vi.fn(),
      on(ev, fn) { this.handlers[ev] = fn; },
      once(ev, fn) { this.onceHandlers[ev] = fn; },
    };
    return [g, { addTo: vi.fn(), remove: vi.fn(), getMaplibreMap: () => g }];
  };

  let built: string[];
  const fakeModule = () => Promise.resolve({
    createVectorLayer: (opts: any) => { created.push(opts); return created.length === 1 ? layer : labelLayer; },
    buildVectorStyle: (theme: string, urls: unknown) => { built.push(theme); return buildVectorStyle(theme, urls); },
  } as any);
  const requested = (): string[] => (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
  const tileError = (status: number, path = '/api/map_tiles/vector/6/16/26.mvt?token=tok1') => ({ error: { status, url: `${ORIGIN}${path}` } });
  const start = (overrides: Record<string, unknown> = {}) => startVectorBasemap({
    map, hass, dark: false, onFallback, loadLayerModule: fakeModule, ...overrides,
  });

  beforeEach(() => {
    _setWebGL2ForTests(true);
    created = [];
    built = [];
    panes = {};
    onFallback = vi.fn<(reason: string) => void>();
    [gl, layer] = makeLayer();
    [labelGl, labelLayer] = makeLayer();
    let n = 0;
    hass = {
      auth: { data: { hassUrl: ORIGIN } },
      callWS: vi.fn(async () => ({ token: `tok${++n}` })),
      connection: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    };
    global.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).endsWith('/urls.json') ? URLS : STYLE))) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    _setWebGL2ForTests(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('falls back to raster at once without WebGL2, fetching nothing', () => {
    _setWebGL2ForTests(false);
    start();
    expect(onFallback).toHaveBeenCalledWith('no WebGL2');
    expect(hass.callWS).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('adds the layer once MapLibre, the style and a token are in, with tokenised requests', async () => {
    start();
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0].style.sprite[0].url).toBe(`${ORIGIN}/static/map/sprites/base?v=1`);
    expect(created[0].transformRequest('/api/map_tiles/tilejson.json').url).toBe(`${ORIGIN}/api/map_tiles/tilejson.json?token=tok1`);
    expect(layer.addTo).toHaveBeenCalledWith(map);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("loads HA's ready-made style for Default, and for an unknown vector_style", async () => {
    start({ vectorStyle: 'sepia' });
    await flush();
    expect(requested()).toEqual([`${ORIGIN}/static/map/light.json`]);
    expect(built).toEqual([]);
    expect(created).toHaveLength(1);
  });

  it("builds the other styles from urls.json, in HA's dark variant in dark mode", async () => {
    start({ vectorStyle: 'Toner', dark: true });
    await flush();
    expect(requested()).toEqual([`${ORIGIN}/static/map/urls.json`]);
    expect(built).toEqual(['toner-dark']);
    expect(created[0].style.sources['versatiles-shortbread'].url).toBe('/api/map_tiles/tilejson.json');
    expect(created[0].style.sprite[0].url).toBe(`${ORIGIN}/static/map/sprites/base?v=2`);
    expect(layer.addTo).toHaveBeenCalledWith(map);
  });

  it("falls back to HA's Default style when the chosen one can't be built", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi.fn(async (url: string) => (String(url).endsWith('/urls.json')
      ? new Response('gone', { status: 404 })
      : new Response(JSON.stringify(STYLE)))) as unknown as typeof fetch;
    start({ vectorStyle: 'muted' });
    await flush();
    expect(requested()).toEqual([`${ORIGIN}/static/map/urls.json`, `${ORIGIN}/static/map/light.json`]);
    expect(created[0].style.sprite[0].url).toBe(`${ORIGIN}/static/map/sprites/base?v=1`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vector style muted unavailable (style 404)'));
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back to raster when neither the chosen style nor Default loads', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi.fn(async () => new Response('down', { status: 502 })) as unknown as typeof fetch;
    start({ vectorStyle: 'gray' });
    await flush();
    expect(created).toEqual([]);
    expect(onFallback).toHaveBeenCalledWith('could not load: style 502');
  });

  it('never adds the layer if stopped while the chosen style is building', async () => {
    let resolveUrls!: (r: Response) => void;
    global.fetch = vi.fn(() => new Promise<Response>((r) => { resolveUrls = r; })) as unknown as typeof fetch;
    const stop = start({ vectorStyle: 'natural' });
    await flush(); // MapLibre and the token are in; urls.json is still loading
    stop();
    resolveUrls(new Response(JSON.stringify(URLS)));
    await flush();
    expect(created).toEqual([]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('never adds the layer if stopped while loading (the #110 race)', async () => {
    const stop = start();
    stop();
    await flush();
    expect(created).toEqual([]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('never adds the layer if stopped after the token but before MapLibre arrives', async () => {
    let resolveModule!: (m: any) => void;
    const stop = start({ loadLayerModule: () => new Promise((r) => { resolveModule = r; }) });
    await flush(); // the token is in; MapLibre is still loading
    stop();
    resolveModule(await fakeModule());
    await flush();
    expect(created).toEqual([]);
    expect(layer.addTo).not.toHaveBeenCalled();
  });

  it("doesn't fall back for a load that fails after stop()", async () => {
    let rejectModule!: (e: Error) => void;
    const stop = start({ loadLayerModule: () => new Promise((_, reject) => { rejectModule = reject; }) });
    await flush();
    stop();
    rejectModule(new Error('404'));
    await flush();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back when the MapLibre file or the style fails to load', async () => {
    start({ loadLayerModule: () => Promise.reject(new Error('404')) });
    await flush();
    expect(onFallback).toHaveBeenCalledWith('could not load: 404');
  });

  it('falls back when the browser refuses a WebGL context', async () => {
    layer.addTo.mockImplementation(() => { throw new Error('Failed to initialize WebGL'); });
    start();
    await flush();
    expect(onFallback).toHaveBeenCalledWith('could not start: Failed to initialize WebGL');
    expect(layer.remove).toHaveBeenCalled();
  });

  it('falls back when a lost WebGL context stays lost for 2 s, not when it comes back', async () => {
    start();
    await flush();
    vi.useFakeTimers();
    gl.handlers.webglcontextlost();
    vi.advanceTimersByTime(1500);
    gl.handlers.webglcontextrestored();
    vi.advanceTimersByTime(1000);
    expect(onFallback).not.toHaveBeenCalled();
    gl.handlers.webglcontextlost();
    vi.advanceTimersByTime(2000);
    expect(onFallback).toHaveBeenCalledWith('WebGL context lost');
    expect(layer.remove).toHaveBeenCalled();
  });

  it('after a refused request, fetches a fresh token and reloads the style in full, at most every 30 s', async () => {
    start();
    await flush();
    gl.handlers.error(tileError(403));
    await flush();
    expect(hass.callWS).toHaveBeenCalledTimes(2); // the first token, then the fresh one
    // A diffed setStyle with the same style changes nothing; only a full one refetches.
    expect(gl.setStyle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 8 }), { diff: false });
    expect(created[0].transformRequest('/api/map_tiles/x').url).toContain('token=tok2');
    gl.handlers.error(tileError(403));
    await flush();
    expect(hass.callWS).toHaveBeenCalledTimes(2);
  });

  it('retries when the throttle ends, rather than dropping an error that came too soon', async () => {
    start();
    await flush();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    gl.handlers.error(tileError(0));
    await vi.advanceTimersByTimeAsync(0);
    expect(gl.setStyle).toHaveBeenCalledTimes(1);
    // The reload's own requests fail too: HA isn't back yet.
    vi.advanceTimersByTime(10_000);
    gl.handlers.error(tileError(0));
    gl.handlers.error(tileError(0));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(gl.setStyle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hass.callWS).toHaveBeenCalledTimes(3);
    expect(gl.setStyle).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending retry on stop()', async () => {
    const stop = start();
    await flush();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    gl.handlers.error(tileError(0));
    await vi.advanceTimersByTimeAsync(0);
    gl.handlers.error(tileError(0));
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hass.callWS).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a network failure', 0, '/api/map_tiles/vector/6/16/26.mvt'],
    ['a stale token', 401, '/api/map_tiles/vector/6/16/26.mvt'],
    ['a TileJSON not served yet', 404, '/api/map_tiles/tilejson.json'],
  ])('recovers from %s', async (_name, status, path) => {
    start();
    await flush();
    gl.handlers.error(tileError(status, path));
    await flush();
    expect(gl.setStyle).toHaveBeenCalledOnce();
  });

  it.each([
    ['a server error', 500, '/api/map_tiles/vector/6/16/26.mvt'],
    ['a sprite from HA, not map_tiles', 404, '/static/map/sprites/base@2x.json'],
    ['an error with no request', undefined, ''],
  ])('ignores %s', async (_name, status, path) => {
    start();
    await flush();
    gl.handlers.error(path ? tileError(status as number, path) : { error: new Error('style warning') });
    await flush();
    expect(hass.callWS).toHaveBeenCalledOnce();
    expect(gl.setStyle).not.toHaveBeenCalled();
  });

  it('reloads with the next token when fetching a fresh one fails, e.g. after HA restarts', async () => {
    let onReady!: () => void;
    hass.connection.addEventListener = vi.fn((ev: string, fn: () => void) => { if (ev === 'ready') onReady = fn; });
    start();
    await flush();
    hass.callWS.mockRejectedValueOnce(new Error('not connected'));
    gl.handlers.error(tileError(0));
    await flush();
    expect(gl.setStyle).not.toHaveBeenCalled();
    onReady(); // the socket reconnects; startMapTilesToken fetches a token
    await flush();
    expect(gl.setStyle).toHaveBeenCalledExactlyOnceWith(expect.anything(), { diff: false });
  });

  it('waits for a token before adding the layer', async () => {
    let giveToken!: (t: { token: string }) => void;
    hass.callWS = vi.fn(() => new Promise((r) => { giveToken = r; }));
    start();
    await flush();
    expect(created).toEqual([]);
    giveToken({ token: 'late' });
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0].transformRequest('/api/map_tiles/tilejson.json').url).toContain('token=late');
  });

  it('stops refreshing the token on stop()', async () => {
    const stop = start();
    await flush();
    stop();
    expect(hass.connection.removeEventListener).toHaveBeenCalledWith('ready', expect.any(Function));
  });

  it("doesn't fall back while the page is hidden, which drops contexts too; only once it's back and still lost", async () => {
    start();
    await flush();
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    gl.handlers.webglcontextlost();
    vi.advanceTimersByTime(60_000);
    expect(onFallback).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1999);
    expect(onFallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFallback).toHaveBeenCalledWith('WebGL context lost');
  });

  describe('labels over the radar', () => {
    const LAYERED = {
      ...STYLE,
      layers: [{ id: 'land', type: 'background' }, { id: 'water', type: 'fill' }, { id: 'towns', type: 'symbol' }],
    };
    const ids = (style: any): string[] => style.layers.map((l: any) => l.id);
    beforeEach(() => {
      global.fetch = vi.fn(async () => new Response(JSON.stringify(LAYERED))) as unknown as typeof fetch;
    });

    it('draws the labels in a second layer, in a pane over the radar, and the rest under it', async () => {
      start({ labelsAbove: true });
      await flush();
      expect(created.map((c) => ids(c.style))).toEqual([['land', 'water'], ['towns']]);
      expect(created[0].pane).toBeUndefined();
      expect(created[1].pane).toBe('wrcVectorLabels');
      expect(panes.wrcVectorLabels.style).toEqual({ zIndex: '450', pointerEvents: 'none' });
      expect(layer.addTo).toHaveBeenCalledWith(map);
      expect(labelLayer.addTo).toHaveBeenCalledWith(map);
    });

    it("draws the labels under the radar when their layer can't start, keeping the vector map", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      labelLayer.addTo.mockImplementation(() => { throw new Error('Failed to initialize WebGL'); });
      start({ labelsAbove: true });
      await flush();
      expect(labelLayer.remove).toHaveBeenCalled();
      expect(ids(gl.setStyle.mock.calls[0][0])).toEqual(['land', 'water', 'towns']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to initialize WebGL'));
      expect(layer.remove).not.toHaveBeenCalled();
      expect(onFallback).not.toHaveBeenCalled();
    });

    it('brings the labels back under the radar when their context stays lost', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      start({ labelsAbove: true });
      await flush();
      vi.useFakeTimers();
      labelGl.handlers.webglcontextlost();
      vi.advanceTimersByTime(2000);
      expect(labelLayer.remove).toHaveBeenCalled();
      expect(ids(gl.setStyle.mock.calls[0][0])).toEqual(['land', 'water', 'towns']);
      expect(onFallback).not.toHaveBeenCalled();
      // A refused request afterwards applies the full style, not the split one.
      vi.useRealTimers();
      gl.handlers.error(tileError(403));
      await flush();
      expect(ids(gl.setStyle.mock.calls[1][0])).toEqual(['land', 'water', 'towns']);
      expect(labelGl.setStyle).not.toHaveBeenCalled();
    });

    it('falls back to raster, removing both layers, when the basemap context stays lost', async () => {
      start({ labelsAbove: true });
      await flush();
      vi.useFakeTimers();
      gl.handlers.webglcontextlost();
      vi.advanceTimersByTime(2000);
      expect(onFallback).toHaveBeenCalledWith('WebGL context lost');
      expect(layer.remove).toHaveBeenCalled();
      expect(labelLayer.remove).toHaveBeenCalled();
    });

    it('applies both styles again after a refused request, from either layer', async () => {
      start({ labelsAbove: true });
      await flush();
      labelGl.handlers.error(tileError(403));
      await flush();
      expect(ids(gl.setStyle.mock.calls[0][0])).toEqual(['land', 'water']);
      expect(ids(labelGl.setStyle.mock.calls[0][0])).toEqual(['towns']);
      expect(labelGl.setStyle.mock.calls[0][1]).toEqual({ diff: false });
      expect(created[1].transformRequest('/api/map_tiles/x').url).toContain('token=tok2');
    });

    it('gives the labels back to a basemap whose context is lost only once it returns', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      start({ labelsAbove: true });
      await flush();
      vi.useFakeTimers();
      gl.style = null; // MapLibre drops the style with the context
      labelGl.handlers.webglcontextlost();
      vi.advanceTimersByTime(2000);
      // Set now, it would be overwritten by the style MapLibre restores.
      expect(gl.setStyle).not.toHaveBeenCalled();
      gl.style = {};
      gl.onceHandlers.webglcontextrestored();
      expect(ids(gl.setStyle.mock.calls[0][0])).toEqual(['land', 'water', 'towns']);
    });

    it('leaves a map with its context lost out of a reload: it reloads itself when the context returns', async () => {
      start({ labelsAbove: true });
      await flush();
      gl.style = null;
      labelGl.handlers.error(tileError(403));
      await flush();
      expect(gl.setStyle).not.toHaveBeenCalled();
      expect(labelGl.setStyle).toHaveBeenCalledOnce();
    });

    it('removes both layers on stop(), and a lost label context afterwards does nothing', async () => {
      const stop = start({ labelsAbove: true });
      await flush();
      vi.useFakeTimers();
      stop();
      labelGl.handlers.webglcontextlost();
      vi.advanceTimersByTime(5000);
      expect(layer.remove).toHaveBeenCalled();
      expect(labelLayer.remove).toHaveBeenCalled();
      expect(gl.setStyle).not.toHaveBeenCalled();
    });
  });

  describe('labels only, for Satellite', () => {
    const SYMBOLS = {
      ...STYLE,
      layers: [{ id: 'land', type: 'fill' }, { id: 'label-place-city', type: 'symbol', layout: { 'text-field': ['get', 'name'] } }],
    };
    beforeEach(() => {
      global.fetch = vi.fn(async () => new Response(JSON.stringify(SYMBOLS))) as unknown as typeof fetch;
    });

    it("draws HA's dark-style labels alone, from one layer in the pane over the radar", async () => {
      start({ labelsOnly: true, dark: true });
      await flush();
      expect(requested()).toEqual([`${ORIGIN}/static/map/dark.json`]);
      expect(created).toHaveLength(1);
      expect(created[0].pane).toBe('wrcVectorLabels');
      expect(created[0].style.layers.map((l: any) => l.id)).toEqual(['label-place-city']);
      expect(panes.wrcVectorLabels.style).toEqual({ zIndex: '450', pointerEvents: 'none' });
      expect(layer.addTo).toHaveBeenCalledWith(map);
      expect(onFallback).not.toHaveBeenCalled();
    });

    it('falls back without WebGL2, so the card can draw CARTO labels instead', () => {
      _setWebGL2ForTests(false);
      start({ labelsOnly: true, dark: true });
      expect(onFallback).toHaveBeenCalledWith('no WebGL2');
      expect(created).toEqual([]);
    });

    it("falls back when the layer can't start", async () => {
      layer.addTo = vi.fn(() => { throw new Error('no context'); });
      start({ labelsOnly: true, dark: true });
      await flush();
      expect(onFallback).toHaveBeenCalledWith('could not start: no context');
    });

    it('reloads the label style in full after a refused request, and removes the layer on stop()', async () => {
      const stop = start({ labelsOnly: true, dark: true });
      await flush();
      gl.handlers.error(tileError(403));
      await flush();
      expect(gl.setStyle).toHaveBeenCalledWith(expect.objectContaining({ layers: [expect.objectContaining({ id: 'label-place-city' })] }), { diff: false });
      stop();
      expect(layer.remove).toHaveBeenCalled();
    });

    it('credits OSM for the labels over ESRI imagery only when they come from HA', () => {
      expect(basemapCredits('satellite')).toHaveLength(1);
      expect(basemapCredits('satellite', undefined, undefined, undefined, true)).toEqual([
        expect.stringContaining('ESRI'), expect.stringContaining('OpenStreetMap'),
      ]);
    });
  });

  it('calls onFallback at most once, and never after stop()', async () => {
    const stop = start();
    await flush();
    vi.useFakeTimers();
    gl.handlers.webglcontextlost();
    stop();
    vi.advanceTimersByTime(5000);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe('MapTilesVector style resolution', () => {
  it('reads vector_style case-insensitively; unset or unknown is Default', () => {
    expect(vectorStyleName('Muted')).toBe('muted');
    expect(vectorStyleName(undefined)).toBe('default');
    expect(vectorStyleName('sepia')).toBe('default');
  });

  it("follows HA's dark mode, and needs map_tiles like MapTiles", () => {
    expect(resolveBasemapStyle('maptilesvector', { mapTilesLoaded: true, dark: false })).toBe('maptiles-vector');
    expect(resolveBasemapStyle('maptilesvector', { mapTilesLoaded: true, dark: true })).toBe('maptiles-vector-dark');
    expect(resolveBasemapStyle('maptilesvector', { mapTilesLoaded: false, dark: true })).toBe('osm');
  });

  it('is a dark basemap in dark mode, inverts only its raster fallback, and credits OSM', () => {
    expect(isDarkBasemapStyle('maptiles-vector-dark')).toBe(true);
    expect(isDarkBasemapStyle('maptiles-vector')).toBe(false);
    expect(isInvertedBasemap('maptiles-vector-dark')).toBe(true);
    expect(basemapCredits('maptiles-vector').join('')).toContain('OpenStreetMap');
  });
});
