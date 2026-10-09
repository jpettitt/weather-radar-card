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
  startVectorBasemap, withMapTilesToken, loadVectorStyle, instanceOrigin, _setWebGL2ForTests,
} from '../src/vector-basemap';
import { buildVectorStyle } from '../src/vector-styles';
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

  it('builds a dark variant of each style', () => {
    const background = (s: any): unknown => s.layers.find((l: any) => l.type === 'background').paint['background-color'];
    expect(background(buildVectorStyle('muted-dark', URLS))).not.toEqual(background(muted));
  });
});

describe('startVectorBasemap', () => {
  const realFetch = global.fetch;
  let hass: any;
  let gl: { handlers: Record<string, (e?: any) => void>; setStyle: ReturnType<typeof vi.fn>; on: (ev: string, fn: (e?: any) => void) => void };
  let layer: { addTo: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; getMaplibreMap: () => typeof gl };
  let created: any[];
  let onFallback: ReturnType<typeof vi.fn<(reason: string) => void>>;
  const map = { getContainer: () => ({ getRootNode: () => document }) } as any;

  let built: string[];
  const fakeModule = () => Promise.resolve({
    createVectorLayer: (opts: any) => { created.push(opts); return layer; },
    buildVectorStyle: (theme: string, urls: unknown) => { built.push(theme); return buildVectorStyle(theme, urls); },
  } as any);
  const requested = (): string[] => (global.fetch as any).mock.calls.map((c: unknown[]) => String(c[0]));
  const start = (overrides: Record<string, unknown> = {}) => startVectorBasemap({
    map, hass, dark: false, onFallback, loadLayerModule: fakeModule, ...overrides,
  });

  beforeEach(() => {
    _setWebGL2ForTests(true);
    created = [];
    built = [];
    onFallback = vi.fn<(reason: string) => void>();
    gl = { handlers: {}, setStyle: vi.fn(), on(ev, fn) { this.handlers[ev] = fn; } };
    layer = { addTo: vi.fn(), remove: vi.fn(), getMaplibreMap: () => gl };
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

  it('after a refused request, fetches a fresh token and applies the style again, at most every 30 s', async () => {
    start();
    await flush();
    gl.handlers.error({ error: { status: 403 } });
    await flush();
    expect(hass.callWS).toHaveBeenCalledTimes(2); // the first token, then the fresh one
    expect(gl.setStyle).toHaveBeenCalledOnce();
    expect(created[0].transformRequest('/api/map_tiles/x').url).toContain('token=tok2');
    gl.handlers.error({ error: { status: 403 } });
    gl.handlers.error({ error: { status: 500 } });
    await flush();
    expect(gl.setStyle).toHaveBeenCalledOnce();
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
