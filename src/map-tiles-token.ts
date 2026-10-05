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

/**
 * Fetches the map_tiles access token once immediately, then every 20 min,
 * calling onToken(token) on each success. Failures are swallowed — the
 * caller's layer keeps whatever token it already has (or none), which
 * FetchTileLayer's own bounded retry/backoff degrades to a blank tile for,
 * not a crash (see fetch-tile-layer.ts).
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

  const fetchOnce = (): void => {
    hass.callWS<{ token: string }>({ type: 'map_tiles/access_token' })
      .then(({ token }) => {
        if (!stopped) onToken(token);
      })
      .catch(() => {
        // Swallowed — see doc comment above.
      });
  };

  fetchOnce();
  const interval = setInterval(fetchOnce, TOKEN_REFRESH_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

/** The slice of a Leaflet tile layer / map that attachMapTilesLayer touches. */
export interface TokenTileLayer {
  options: { token?: string };
  redraw(): unknown;
  addTo(map: any): unknown;
}

/**
 * Keeps a MapTiles basemap layer's token current, adding the layer to the
 * map only once the first token arrives. Added with an empty token, every
 * visible tile is requested as `?token=` and rejected 403 (then retried)
 * before the token lands. The layer itself is still created synchronously
 * by the caller — only the addTo waits, the same patch-an-async-result-in
 * pattern as the redraw (see startMapTilesToken).
 *
 * Returns startMapTilesToken's stop() function.
 */
export function attachMapTilesLayer(
  hass: HomeAssistant,
  layer: TokenTileLayer,
  getMap: () => { hasLayer(layer: any): boolean } | null | undefined,
): () => void {
  return startMapTilesToken(hass, (token) => {
    const map = getMap();
    if (!map) return;
    layer.options.token = token;
    if (map.hasLayer(layer)) layer.redraw();
    else layer.addTo(map);
  });
}
