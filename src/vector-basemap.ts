/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import type { HomeAssistant } from 'custom-card-helpers';
import { startMapTilesToken } from './map-tiles-token';
import { vectorStyleName } from './basemap-styles';

// map_style: MapTilesVector (experimental, opt-in): HA 2026.10's vector map,
// drawn in one of HA's styles from OSM Shortbread tiles that core's
// map_tiles integration proxies, as a MapLibre layer under the radar — the
// way HA's Leaflet maps do it (frontend src/common/map/base-layer.ts).
// Whatever stops it — no WebGL2, the MapLibre file or the style failing to
// load, the browser taking the WebGL context back — hands over to the raster
// MapTiles layer.

// HA serves these from the frontend build, not an API; a moved file is a
// failed load, which falls back to raster.
const STYLE_PATH = { light: '/static/map/light.json', dark: '/static/map/dark.json' };
// Glyph and sprite URLs for the styles built in the browser.
const URLS_PATH = '/static/map/urls.json';
const RTL_PLUGIN_PATH = '/static/map/mapbox-gl-rtl-text.js';
const PROXY_PATH = '/api/map_tiles/';
// Browsers keep about 16 WebGL contexts and drop the oldest; one lost for
// this long is treated as gone. HA's maps use the same grace.
const CONTEXT_RESTORE_GRACE_MS = 2000;
// A refused request (stale token, proxy restarting) leaves MapLibre's source
// dead until the style is applied again: at most one retry per this long.
const RECOVERY_THROTTLE_MS = 30_000;

type GlLayer = L.Layer & { getMaplibreMap(): any };

let webGL2: boolean | undefined;

/** WebGL2, which MapLibre needs. Rules out older iOS/Android and blocklisted drivers. */
export function supportsWebGL2(): boolean {
  if (webGL2 === undefined) {
    try {
      const context = document.createElement('canvas').getContext('webgl2');
      webGL2 = !!context;
      // Contexts are scarce; the probe mustn't keep one.
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      webGL2 = false;
    }
  }
  return webGL2;
}

/** @internal */
export function _setWebGL2ForTests(value: boolean | undefined): void {
  webGL2 = value;
}

/** The HA instance's origin: on Cast the page isn't served by it. */
export function instanceOrigin(hass: HomeAssistant | undefined): string {
  const url = (hass as any)?.auth?.data?.hassUrl ?? location.origin;
  return String(url).replace(/\/+$/, '');
}

/**
 * MapLibre fetches from a worker, which can't resolve relative URLs, so
 * every URL is made absolute against the instance; map_tiles proxy URLs get
 * the access token.
 */
export function withMapTilesToken(url: string, origin: string, token: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return url;
  }
  if (!parsed.pathname.startsWith(PROXY_PATH)) return parsed.href;
  const onInstance = new URL(`${origin}${parsed.pathname}${parsed.search}`);
  if (token) onInstance.searchParams.set('token', token);
  return onInstance.href;
}

/**
 * HA's vector style, with the sprite URL made absolute (MapLibre rejects a
 * relative one) and flat Mercator in place of the style's globe: HA's own
 * map shows a globe at low zoom, but under Leaflet's flat map a globe put
 * the corners hundreds of pixels off the radar (~455 px at zoom 3, measured
 * 2026-10-08), and its projection check reads pixels back every frame.
 */
export async function loadVectorStyle(origin: string, dark: boolean): Promise<any> {
  return prepareStyle(await fetchJson(origin + (dark ? STYLE_PATH.dark : STYLE_PATH.light)), origin);
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`style ${res.status}`);
  return res.json();
}

function prepareStyle(style: any, origin: string): any {
  style.projection = { type: 'mercator' };
  delete style.sky;
  const absolute = (u: string): string => new URL(u, origin).href;
  if (typeof style.sprite === 'string') style.sprite = absolute(style.sprite);
  else if (Array.isArray(style.sprite)) style.sprite = style.sprite.map((s: any) => ({ ...s, url: absolute(s.url) }));
  return style;
}

// The MapLibre file's content hash, filled in by the build.
const MAPLIBRE_FILE_HASH = '__MAPLIBRE_FILE_HASH__';

// The MapLibre file, built separately (rollup.config.js) and installed next to
// the card. A computed URL, so rollup leaves it alone.
function loadMaplibreFile(): Promise<typeof import('./vector-basemap-layer')> {
  const url = new URL(`./weather-radar-card-maplibre.js?v=${MAPLIBRE_FILE_HASH}`, import.meta.url).href;
  return import(/* computed: not bundled */ url);
}

/**
 * Starts the vector basemap on `map`. Map setup stays synchronous (the
 * #110 rule, see map-tiles-token.ts): the layer goes on the map once the
 * MapLibre file, the style and a token have all arrived, unless stop() ran
 * first. onFallback runs at most once, and never after stop().
 *
 * Returns stop(), for teardown.
 */
export function startVectorBasemap(opts: {
  map: L.Map;
  hass: HomeAssistant;
  dark: boolean;
  /** The card's vector_style. */
  vectorStyle?: string;
  onFallback: (reason: string) => void;
  /** Injected in tests; the real one splits MapLibre into its own file. */
  loadLayerModule?: () => Promise<typeof import('./vector-basemap-layer')>;
}): () => void {
  const { map, hass, dark } = opts;
  if (!supportsWebGL2()) {
    opts.onFallback('no WebGL2');
    return () => { /* nothing started */ };
  }
  const origin = instanceOrigin(hass);
  let stopped = false;
  let layer: GlLayer | undefined;
  let token: string | undefined;
  let contextLost = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRecovery = 0;
  let style: any;

  let gotToken!: () => void;
  const firstToken = new Promise<void>((resolve) => { gotToken = resolve; });
  const stopToken = startMapTilesToken(hass, (t) => { token = t; gotToken(); });

  const transformRequest = (url: string): { url: string } => ({ url: withMapTilesToken(url, origin, token) });

  const cleanup = (): void => {
    stopped = true;
    stopToken();
    clearTimeout(graceTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    if (layer) {
      try { layer.remove(); } catch { /* the map may already be gone */ }
      layer = undefined;
    }
  };
  const fallback = (reason: string): void => {
    if (stopped) return;
    cleanup();
    opts.onFallback(reason);
  };

  // Backgrounding drops the context too, and it comes back on return.
  const scheduleFallback = (): void => {
    clearTimeout(graceTimer);
    if (!stopped && !document.hidden) graceTimer = setTimeout(() => fallback('WebGL context lost'), CONTEXT_RESTORE_GRACE_MS);
  };
  function onVisibility(): void {
    if (contextLost) scheduleFallback();
  }

  // 403 is a stale token, 404 the proxy not registered yet after a restart,
  // no status a network failure: a fresh token and the style again recover
  // all three.
  const onError = (event: any): void => {
    const status = event?.error?.status;
    if (status !== undefined && status !== 403 && status !== 404) return;
    if (Date.now() - lastRecovery < RECOVERY_THROTTLE_MS) return;
    lastRecovery = Date.now();
    hass.callWS<{ token: string }>({ type: 'map_tiles/access_token' })
      .then(({ token: t }) => {
        if (stopped || !layer) return;
        token = t;
        layer.getMaplibreMap()?.setStyle(style);
      })
      .catch(() => { /* the next refused request tries again */ });
  };

  // HA serves Default ready-made; the other styles are built from urls.json
  // with the builder in the MapLibre file. Either download runs alongside
  // the file's. A style that won't build falls back to Default.
  const vectorStyle = vectorStyleName(opts.vectorStyle);
  const defaultStyle = vectorStyle === 'default' ? loadVectorStyle(origin, dark) : undefined;
  const urls = defaultStyle ? undefined : fetchJson(origin + URLS_PATH);
  urls?.catch(() => { /* reported by buildStyle */ });
  const buildStyle = async (mod: typeof import('./vector-basemap-layer')): Promise<any> => {
    try {
      return prepareStyle(mod.buildVectorStyle(dark ? `${vectorStyle}-dark` : vectorStyle, await urls), origin);
    } catch (err) {
      if (!stopped) console.warn(`[weather-radar-card] Vector style ${vectorStyle} unavailable (${(err as Error)?.message ?? err}); using Default.`);
      return loadVectorStyle(origin, dark);
    }
  };

  const loadLayerModule = opts.loadLayerModule ?? loadMaplibreFile;
  Promise.all([loadLayerModule(), defaultStyle, firstToken])
    .then(async ([mod, loadedStyle]) => {
      if (stopped) return;
      style = loadedStyle ?? await buildStyle(mod);
      if (stopped) return;
      try {
        layer = mod.createVectorLayer({
          L,
          style,
          transformRequest,
          rtlPluginUrl: origin + RTL_PLUGIN_PATH,
          cssRoot: map.getContainer().getRootNode(),
        });
        // Adding it builds the WebGL map, which throws when the browser
        // refuses a context.
        layer.addTo(map);
      } catch (err) {
        fallback(`could not start: ${(err as Error)?.message ?? err}`);
        return;
      }
      const gl = layer.getMaplibreMap();
      gl.on('webglcontextlost', () => { contextLost = true; scheduleFallback(); });
      gl.on('webglcontextrestored', () => { contextLost = false; clearTimeout(graceTimer); });
      gl.on('error', onError);
      document.addEventListener('visibilitychange', onVisibility);
    })
    .catch((err) => fallback(`could not load: ${(err as Error)?.message ?? err}`));

  return cleanup;
}
