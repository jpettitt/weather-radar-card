/* eslint-disable @typescript-eslint/no-explicit-any */
import type { HomeAssistant } from 'custom-card-helpers';

// Support for HA core's `map_tiles` integration (2026.10+), which proxies
// OSM raster tiles through the HA instance behind a rotating access
// token — see basemap-styles.ts's 'maptiles' case for the tile URL.

// hass.config.components is HA's loaded-integrations list, populated at
// startup and stable thereafter — same gating idiom as isBlitzortungLoaded
// in lightning-helpers.ts.
export function isMapTilesLoaded(hass: HomeAssistant | undefined): boolean {
  const components = (hass?.config as any)?.components;
  return Array.isArray(components) && components.includes('map_tiles');
}

// Core rotates the token every 30 min and keeps 2 live, so one handed out
// now stays valid 30-60 min. Refreshing at 20 min (matching HA's own
// frontend) leaves comfortable margin.
const TOKEN_REFRESH_MS = 20 * 60 * 1000;
// A failed fetch (websocket down, core restarting) retries this soon rather
// than waiting out the 20-min interval with a stale or missing token.
const TOKEN_RETRY_MS = 60 * 1000;

/**
 * Fetches the map_tiles access token once immediately, then every 20 min,
 * calling onToken(token) on each success. Core keeps its tokens in memory
 * only, so a core restart invalidates the card's token: it also refetches
 * whenever HA's websocket reconnects (`ready`). A failed fetch retries
 * after 1 min; until then the layer keeps whatever token it has, which
 * FetchTileLayer's bounded retry degrades to blank tiles, not a crash.
 *
 * Deliberately NOT awaited before the tile layer is created: this card had
 * a real async-init race against the map lifecycle before (the
 * leaflet.markercluster init race, issue #110) and the fix there — and the
 * precedent to follow here — is to keep map setup synchronous and patch
 * async results into an already-live layer, not gate layer creation on a
 * network round trip. Do not "simplify" this into an awaited fetch ahead
 * of layer creation.
 *
 * Returns a stop() function. Call it from teardown. It clears the refresh
 * interval and flips an internal `stopped` flag that the in-flight fetch's
 * `.then()` checks before invoking onToken — this is what makes it safe to
 * stop while a WS round trip is still pending (JS has no real concurrency,
 * so a write made synchronously before stop() returns is guaranteed to be
 * visible to the microtask that resumes the pending `.then()`).
 */
export function startMapTilesToken(
  hass: HomeAssistant,
  onToken: (token: string) => void,
): () => void {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const fetchOnce = (): void => {
    clearTimeout(retry);
    retry = undefined;
    hass.callWS<{ token: string }>({ type: 'map_tiles/access_token' })
      .then(({ token }) => {
        if (!stopped) onToken(token);
      })
      .catch(() => {
        if (!stopped && retry === undefined) retry = setTimeout(fetchOnce, TOKEN_RETRY_MS);
      });
  };

  fetchOnce();
  const interval = setInterval(fetchOnce, TOKEN_REFRESH_MS);
  // hass is replaced on every state change, but its connection object is
  // the one long-lived socket, which fires 'ready' after each reconnect.
  const connection = (hass as any).connection;
  connection?.addEventListener?.('ready', fetchOnce);

  return () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(retry);
    connection?.removeEventListener?.('ready', fetchOnce);
  };
}

/** The slice of a Leaflet tile layer / map that attachMapTilesLayer touches. */
export interface TokenTileLayer {
  options: { token?: string };
  /** FetchTileLayer's running count of tiles that gave up. */
  _tileFailed?: number;
  redraw(): unknown;
  addTo(map: any): unknown;
}

/**
 * Keeps a MapTiles basemap layer's token current, adding the layer to the
 * map only once the first token arrives. Added with an empty token, every
 * visible tile is requested as `?token=` and rejected 403 (then retried)
 * before the token lands. The layer itself is still created synchronously
 * by the caller — only the addTo waits, the same patch-an-async-result-in
 * pattern as startMapTilesToken.
 *
 * A new token only goes into the options: getTileUrl reads it as each tile
 * is created, and tiles already shown don't need it. Redrawing on every
 * refresh dropped and re-downloaded the whole basemap every 20 min (a
 * visible flash); it now redraws only when tiles failed since the last
 * token, e.g. 403s after a core restart.
 *
 * Returns startMapTilesToken's stop() function.
 */
export function attachMapTilesLayer(
  hass: HomeAssistant,
  layer: TokenTileLayer,
  getMap: () => { hasLayer(layer: any): boolean } | null | undefined,
): () => void {
  let failedAtLastToken = 0;
  return startMapTilesToken(hass, (token) => {
    const map = getMap();
    if (!map) return;
    layer.options.token = token;
    if (!map.hasLayer(layer)) {
      layer.addTo(map);
    } else if ((layer._tileFailed ?? 0) > failedAtLastToken) {
      layer.redraw();
    }
    failedAtLastToken = layer._tileFailed ?? 0;
  });
}
