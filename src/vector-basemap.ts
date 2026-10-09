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
// A refused request (stale token, proxy restarting) leaves what it was for
// failed until the style is reloaded: at most one token fetch per this long.
const RECOVERY_THROTTLE_MS = 30_000;
// MapLibre's statuses for a map_tiles request that a fresh token or a
// reload can fix: 0 is a network failure (HA restarting), 401/403 a stale
// token, 404 the proxy not registered yet. A 404 tile fails silently (MapLibre
// draws it empty), so only the TileJSON's 404 gets here.
const RECOVERABLE_STATUS = new Set([0, 401, 403, 404]);
// The labels' own pane: over the radar (240), the wind flow (250), DWD's
// coverage wash (350) and hazard overlays (400), so every name stays
// readable; under lightning (500), markers and popups. Clicks pass through
// to the warnings below: the pane is pointer-events: none, and nothing in it
// turns them back on (MapLibre only does for controls and popups, and this
// map has neither).
const LABEL_PANE = 'wrcVectorLabels';
const LABEL_PANE_Z_INDEX = 450;

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

/**
 * A style split in two: everything but the labels, drawn under the radar,
 * and the labels alone (no background, so the rest shows through), drawn
 * over it.
 */
export function splitLabels(style: any): { base: any; labels: any } {
  const part = (keep: (layer: any) => boolean): any => {
    const copy = structuredClone(style);
    copy.layers = copy.layers.filter(keep);
    return copy;
  };
  return { base: part((l) => l.type !== 'symbol'), labels: part((l) => l.type === 'symbol') };
}

// Calls onGone once a lost WebGL context stays lost for the grace period.
// Backgrounding the page drops contexts too, and they come back on return.
// Returns stop().
function watchContext(gl: any, onGone: () => void): () => void {
  let active = true;
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    if (active && !document.hidden) timer = setTimeout(onGone, CONTEXT_RESTORE_GRACE_MS);
  };
  const onVisibility = (): void => { if (lost) schedule(); };
  gl.on('webglcontextlost', () => { lost = true; schedule(); });
  gl.on('webglcontextrestored', () => { lost = false; clearTimeout(timer); });
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    active = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

const removeLayer = (layer: GlLayer | undefined): void => {
  try { layer?.remove(); } catch { /* the map may already be gone */ }
};

// The MapLibre file's content hash, filled in by the build.
const MAPLIBRE_FILE_HASH = '__MAPLIBRE_FILE_HASH__';

// The MapLibre file, built separately (rollup.config.js) and installed next to
// the card. A computed URL, so rollup leaves it alone.
// Async so a bad base URL rejects, and falls back, rather than throwing out
// of startVectorBasemap with the token refresh already running.
async function loadMaplibreFile(): Promise<typeof import('./vector-basemap-layer')> {
  const url = new URL(`./weather-radar-card-maplibre.js?v=${MAPLIBRE_FILE_HASH}`, import.meta.url).href;
  return import(/* computed: not bundled */ url);
}

/**
 * Starts the vector basemap on `map`. Map setup stays synchronous (the
 * #110 rule, see map-tiles-token.ts): the layers go on the map once the
 * MapLibre file, the style and a token have all arrived, unless stop() ran
 * first. onFallback runs at most once, and never after stop().
 *
 * With labelsAbove the labels are a second MapLibre layer over the radar, a
 * second WebGL context. If that one can't run, the basemap draws its labels
 * again, under the radar, rather than giving up the vector map.
 *
 * Returns stop(), for teardown.
 */
export function startVectorBasemap(opts: {
  map: L.Map;
  hass: HomeAssistant;
  dark: boolean;
  /** The card's vector_style. */
  vectorStyle?: string;
  /** Labels over the radar instead of under it. */
  labelsAbove?: boolean;
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
  let base: GlLayer | undefined;
  let labels: GlLayer | undefined;
  let token: string | undefined;
  let lastRecovery = 0;
  let needsReload = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  // full is drawn while the labels have no layer of their own; base and
  // labels while they do.
  let styles: { full: any; base?: any; labels?: any } | undefined;
  let stopBaseWatch = (): void => { /* not started */ };
  let stopLabelWatch = (): void => { /* not started */ };

  // A map whose WebGL context is lost has no style: MapLibre re-applies the
  // one it had when the context returns, so a new style waits for that.
  const applyStyle = (layer: GlLayer | undefined, style: any): void => {
    const gl = layer?.getMaplibreMap();
    if (!gl) return;
    if (gl.style) gl.setStyle(style);
    else gl.once('webglcontextrestored', () => { if (!stopped) gl.setStyle(style); });
  };

  // A full reload: setStyle with the style already applied diffs to nothing,
  // and failed tiles and a failed TileJSON are only fetched again this way.
  // A map with its context lost reloads by itself when it comes back.
  const reload = (): void => {
    if (stopped || !base || !styles) return;
    needsReload = false;
    const reloadMap = (layer: GlLayer | undefined, style: any): void => {
      const gl = layer?.getMaplibreMap();
      if (gl?.style) gl.setStyle(style, { diff: false });
    };
    reloadMap(base, styles.base ?? styles.full);
    if (styles.labels) reloadMap(labels, styles.labels);
  };

  let gotToken!: () => void;
  const firstToken = new Promise<void>((resolve) => { gotToken = resolve; });
  // Every new token also finishes a pending reload: that covers a token
  // fetch that failed, and HA restarting (the socket reconnects, and a
  // token follows).
  const stopToken = startMapTilesToken(hass, (t) => {
    token = t;
    gotToken();
    if (needsReload) reload();
  });

  const transformRequest = (url: string): { url: string } => ({ url: withMapTilesToken(url, origin, token) });

  const cleanup = (): void => {
    stopped = true;
    stopToken();
    clearTimeout(recoveryTimer);
    stopBaseWatch();
    stopLabelWatch();
    removeLayer(labels);
    removeLayer(base);
    labels = undefined;
    base = undefined;
  };
  const fallback = (reason: string): void => {
    if (stopped) return;
    cleanup();
    opts.onFallback(reason);
  };
  const labelsGone = (reason: string): void => {
    if (stopped || !styles?.labels) return;
    console.warn(`[weather-radar-card] Vector labels can't go over the radar (${reason}); drawing them under it.`);
    stopLabelWatch();
    removeLayer(labels);
    labels = undefined;
    styles = { full: styles.full };
    applyStyle(base, styles.full);
  };

  const recover = (): void => {
    recoveryTimer = undefined;
    lastRecovery = Date.now();
    hass.callWS<{ token: string }>({ type: 'map_tiles/access_token' })
      .then(({ token: t }) => {
        if (stopped) return;
        token = t;
        reload();
      })
      .catch(() => { /* the next token from startMapTilesToken reloads */ });
  };
  // Only map_tiles requests: a missing sprite or a style warning isn't
  // something a token fixes. Within the throttle the retry is put off, not
  // dropped: a reload that failed again (HA still starting) would otherwise
  // leave a map nobody pans broken until the next token, 20 minutes on.
  const onError = (event: any): void => {
    const err = event?.error;
    if (!String(err?.url ?? '').includes(PROXY_PATH) || !RECOVERABLE_STATUS.has(err?.status)) return;
    needsReload = true;
    if (recoveryTimer !== undefined) return;
    const wait = lastRecovery + RECOVERY_THROTTLE_MS - Date.now();
    if (wait <= 0) recover();
    else recoveryTimer = setTimeout(recover, wait);
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
      const full = loadedStyle ?? await buildStyle(mod);
      if (stopped) return;
      styles = opts.labelsAbove ? { full, ...splitLabels(full) } : { full };
      const create = (style: any, pane?: string): GlLayer => mod.createVectorLayer({
        L, style, transformRequest, pane, rtlPluginUrl: origin + RTL_PLUGIN_PATH, cssRoot: map.getContainer().getRootNode(),
      });
      try {
        base = create(styles.base ?? styles.full);
        // Adding it builds the WebGL map, which throws when the browser
        // refuses a context.
        base.addTo(map);
      } catch (err) {
        fallback(`could not start: ${(err as Error)?.message ?? err}`);
        return;
      }
      const baseGl = base.getMaplibreMap();
      stopBaseWatch = watchContext(baseGl, () => fallback('WebGL context lost'));
      baseGl.on('error', onError);
      if (!styles.labels) return;
      try {
        ensureLabelPane(map);
        labels = create(styles.labels, LABEL_PANE);
        labels.addTo(map);
      } catch (err) {
        labelsGone(`could not start: ${(err as Error)?.message ?? err}`);
        return;
      }
      const labelGl = labels.getMaplibreMap();
      stopLabelWatch = watchContext(labelGl, () => labelsGone('WebGL context lost'));
      labelGl.on('error', onError);
    })
    .catch((err) => fallback(`could not load: ${(err as Error)?.message ?? err}`));

  return cleanup;
}

function ensureLabelPane(map: L.Map): void {
  if (map.getPane(LABEL_PANE)) return;
  const pane = map.createPane(LABEL_PANE);
  pane.style.zIndex = String(LABEL_PANE_Z_INDEX);
  pane.style.pointerEvents = 'none';
}
