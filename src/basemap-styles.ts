// Basemap tile URL templates per map_style, factored out of
// weather-radar-card.ts so they're unit-testable without Leaflet/DOM.
//
// CARTO's basemap tiles (Dark/Voyager/Light, and Satellite's label
// overlay) need a free key (carto.com/basemaps/apikey — no account), sent
// as `?key=`. Without one CARTO answers every tile with a blank "API KEY
// REQUIRED" placeholder (checked 2026-10-08; earlier it only watermarked
// real tiles), so Auto avoids CARTO unless a key is set. Grey/GreyDark are
// ESRI Living Atlas Canvas basemaps that never need a key — same
// free-for-public-apps basis as Satellite's World_Imagery.
//
// Custom is a user-supplied {z}/{x}/{y} template (a self-hosted tile
// server or caching proxy, a commercial provider with the key baked into
// the URL, ...). The card can't know whether those tiles are light or
// dark, so `custom_tile_theme` says so; `invert` renders light tiles dark
// via a CSS filter (see CUSTOM_INVERT_CLASS).

import { escapeHtml } from './string-utils';

const CARTO_HOST = 'https://{s}.basemaps.cartocdn.com';
const ESRI_HOST = 'https://server.arcgisonline.com/ArcGIS/rest/services';

function cartoTile(path: string, apiKey?: string): string {
  const key = apiKey?.trim();
  const suffix = key ? `?key=${encodeURIComponent(key)}` : '';
  return `${CARTO_HOST}/${path}/{z}/{x}/{y}.png${suffix}`;
}

export interface BasemapTiles {
  /** Leaflet {s}/{z}/{x}/{y} template for the base layer. */
  url: string;
  subdomains: string;
  /** Empty when the base layer already carries labels (osm). */
  labelUrl: string;
  labelsBakedIn: boolean;
}

/** Leaflet `className` put on the basemap layer for `custom_tile_theme: invert`. */
export const CUSTOM_INVERT_CLASS = 'wrc-basemap-invert';

export type CustomTileTheme = 'light' | 'dark' | 'invert';

// Mirrors Leaflet's Util.template regex. Leaflet throws on any name it
// can't fill, from inside addTo(), which left the card half-built with no
// radar — so an unedited provider template like `?apikey={apikey}` has to
// be caught before the layer exists.
const TEMPLATE_RE = /\{ *([\w_ -]+) *\}/g;
const TILE_PLACEHOLDERS = new Set(['s', 'x', 'y', 'z', 'r', '-y']);

/** Placeholders in a custom tile URL that Leaflet can't fill. */
export function unknownTilePlaceholders(url: string): string[] {
  return [...url.matchAll(TEMPLATE_RE)].map((m) => m[1]).filter((n) => !TILE_PLACEHOLDERS.has(n));
}

/**
 * The style actually drawn for a configured one (lowercase, `auto` already
 * resolved): MapTiles needs HA's `map_tiles` integration (2026.10+) and
 * falls back to OSM, the same tiles fetched directly (Light would be blank
 * without a CARTO key); Custom needs a usable URL and falls back to OSM.
 * Tiles, attribution and the light/dark palette all follow this.
 */
export function resolveBasemapStyle(
  mapStyle: string,
  opts: { mapTilesLoaded: boolean; customTileUrl?: string; dark?: boolean },
): string {
  if ((mapStyle === 'maptiles' || mapStyle === 'maptilesvector') && !opts.mapTilesLoaded) return 'osm';
  // The vector map follows HA's dark mode with HA's own dark style.
  if (mapStyle === 'maptilesvector') return opts.dark ? 'maptiles-vector-dark' : 'maptiles-vector';
  if (mapStyle === 'custom') {
    const url = opts.customTileUrl?.trim();
    if (!url || unknownTilePlaceholders(url).length > 0) return 'osm';
  }
  return mapStyle;
}

export function getBasemapTiles(
  mapStyle: string,
  cartoApiKey?: string,
  customTileUrl?: string,
): BasemapTiles {
  switch (mapStyle) {
    case 'custom': {
      const url = customTileUrl?.trim();
      // No URL yet (e.g. mid-edit in the visual editor) — show OSM rather
      // than an empty map; OSM has localized labels and needs no key.
      if (!url || unknownTilePlaceholders(url).length > 0) return getBasemapTiles('osm');
      return {
        url,
        // Only used when the template contains {s}.
        subdomains: 'abc',
        labelUrl: '',
        labelsBakedIn: true,
      };
    }
    case 'dark':
      return {
        url: cartoTile('dark_nolabels', cartoApiKey),
        subdomains: 'abcd',
        labelUrl: cartoTile('dark_only_labels', cartoApiKey),
        labelsBakedIn: false,
      };
    case 'voyager':
      return {
        url: cartoTile('rastertiles/voyager_nolabels', cartoApiKey),
        subdomains: 'abcd',
        labelUrl: cartoTile('rastertiles/voyager_only_labels', cartoApiKey),
        labelsBakedIn: false,
      };
    case 'satellite':
      // Without a key CARTO's label tiles are "API KEY REQUIRED" placeholders
      // that would print across the imagery, so leave the labels off.
      return {
        url: `${ESRI_HOST}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
        subdomains: 'abcd',
        labelUrl: cartoApiKey?.trim() ? cartoTile('rastertiles/voyager_only_labels', cartoApiKey) : '',
        labelsBakedIn: false,
      };
    case 'osm':
      return {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: 'abc',
        labelUrl: '',
        labelsBakedIn: true,
      };
    case 'maptiles':
    case 'maptiles-dark':
    // The vector styles' raster fallback (vector-basemap.ts).
    case 'maptiles-vector':
    case 'maptiles-vector-dark':
      // HA core's map_tiles integration (2026.10+) — proxies the same OSM
      // raster tiles through the HA instance itself, behind a rotating
      // access token substituted into {token} (see map-tiles-token.ts).
      // Single host, no {s} subdomains. Caller falls this case back to
      // 'light' when the integration isn't loaded on the connected core.
      return {
        url: '/api/map_tiles/raster/{z}/{x}/{y}.png?token={token}',
        subdomains: '',
        labelUrl: '',
        labelsBakedIn: true,
      };
    case 'grey':
      return {
        url: `${ESRI_HOST}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
        subdomains: 'abcd',
        labelUrl: `${ESRI_HOST}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
        labelsBakedIn: false,
      };
    case 'greydark':
      return {
        url: `${ESRI_HOST}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
        subdomains: 'abcd',
        labelUrl: `${ESRI_HOST}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
        labelsBakedIn: false,
      };
    default: // light / unset
      return {
        url: cartoTile('light_nolabels', cartoApiKey),
        subdomains: 'abcd',
        labelUrl: cartoTile('light_only_labels', cartoApiKey),
        labelsBakedIn: false,
      };
  }
}

export type BasemapTone = 'light' | 'dark' | 'satellite';

export function getBasemapTone(
  mapStyle: string | undefined,
  customTileTheme?: string,
): BasemapTone {
  const s = mapStyle?.toLowerCase();
  if (s === 'satellite') return 'satellite';
  if (s === 'dark' || s === 'greydark' || s === 'maptiles-dark' || s === 'maptiles-vector-dark') return 'dark';
  if (s === 'custom') {
    const t = customTileTheme?.toLowerCase();
    return t === 'dark' || t === 'invert' ? 'dark' : 'light';
  }
  return 'light';
}

/** True for any basemap dark enough to need light-on-dark UI colors. */
export function isDarkBasemapStyle(
  mapStyle: string | undefined,
  customTileTheme?: string,
): boolean {
  return getBasemapTone(mapStyle, customTileTheme) !== 'light';
}

/** True when the custom basemap should be colour-inverted by CSS. */
/** True when the basemap is light tiles shown dark by the CSS invert filter:
 *  Custom with `custom_tile_theme: invert`, or Auto's dark-mode MapTiles. */
export function isInvertedBasemap(
  mapStyle: string | undefined,
  customTileTheme?: string,
): boolean {
  const s = mapStyle?.toLowerCase();
  // maptiles-vector-dark: its raster fallback, shown when the vector map can't run.
  return s === 'maptiles-dark' || s === 'maptiles-vector-dark' || (s === 'custom' && customTileTheme?.toLowerCase() === 'invert');
}

/** CARTO styles whose tiles are blank without a key (Satellite only loses its labels). */
const CARTO_STYLES = new Set(['light', 'voyager', 'dark']);

/** True when a CARTO style is chosen without a key, so its tiles will be blank. */
/** Styles the CARTO key changes: CARTO's own, Satellite's labels, and Auto (a key switches it to CARTO). */
const CARTO_KEY_STYLES = new Set(['auto', 'light', 'voyager', 'dark', 'satellite']);

/** Whether the editor shows the CARTO key field: where a key does something, or when one is set (so it can be cleared). */
export function showsCartoKeyField(mapStyle: string | undefined, cartoApiKey?: string): boolean {
  return CARTO_KEY_STYLES.has((mapStyle || 'auto').toLowerCase()) || !!cartoApiKey?.trim();
}

/** extra_labels draws raster tiles a zoom level higher at half size; the vector map has no tiles to resize. */
export function extraLabelsApply(mapStyle: string | undefined): boolean {
  return (mapStyle || 'auto').toLowerCase() !== 'maptilesvector';
}

export function cartoKeyMissing(mapStyle: string | undefined, cartoApiKey?: string): boolean {
  return CARTO_STYLES.has(mapStyle?.toLowerCase() ?? '') && !cartoApiKey?.trim();
}

/**
 * What `map_style: Auto` draws. With a CARTO key, as before: CARTO Dark in
 * dark mode, CARTO Light for English, OSM otherwise. Without one CARTO is
 * blank, so: Home Assistant's own map tiles (2026.10+), shown inverted in
 * dark mode like HA's own map; on older cores the keyless Grey/GreyDark,
 * or OSM for its localized labels.
 */
export function resolveAutoBasemap(opts: {
  dark: boolean;
  english: boolean;
  cartoApiKey?: string;
  mapTilesLoaded: boolean;
}): string {
  if (opts.cartoApiKey?.trim()) return opts.dark ? 'dark' : opts.english ? 'light' : 'osm';
  if (opts.mapTilesLoaded) return opts.dark ? 'maptiles-dark' : 'maptiles';
  return opts.dark ? 'greydark' : opts.english ? 'grey' : 'osm';
}

const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/**
 * Map tile credits for the drawn style (resolved — see resolveBasemapStyle),
 * one HTML entry per provider: the footer joins them on one line, the
 * Sources popup lists them one per line. Empty for a custom URL with no
 * readable host and no attribution.
 */
export function basemapCredits(
  mapStyle: string,
  customTileUrl?: string,
  customTileAttribution?: string,
  baseUrl?: string,
): string[] {
  if (mapStyle === 'custom' && customTileUrl?.trim()) {
    const credit = getCustomAttribution(customTileUrl, customTileAttribution, baseUrl);
    return credit ? [credit] : [];
  }
  switch (mapStyle) {
    case 'osm':
    case 'custom':
    case 'maptiles':
    case 'maptiles-dark':
    case 'maptiles-vector':
    case 'maptiles-vector-dark':
      return [`${OSM_CREDIT} contributors`];
    case 'satellite':
      return ['&copy; <a href="http://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank">ESRI</a>'];
    case 'grey':
    case 'greydark':
      return [`${OSM_CREDIT} contributors`, '&copy; <a href="https://www.esri.com" target="_blank">Esri</a>, HERE, Garmin'];
    default:
      return [`${OSM_CREDIT} contributors`, '&copy; <a href="https://carto.com/attribution" target="_blank">CARTO</a>'];
  }
}

/**
 * Attribution HTML for a custom basemap. The user's text is escaped (it
 * lands in innerHTML); without one, credit the tile host so the map is
 * never shown uncredited.
 */
export function getCustomAttribution(customTileUrl?: string, attribution?: string, baseUrl?: string): string {
  const text = attribution?.trim();
  if (text) return escapeHtml(text);
  const raw = customTileUrl?.trim();
  if (!raw) return '';
  let host = '';
  try {
    // Placeholders aren't valid in a hostname, so drop them (and a `{s}.`
    // subdomain prefix) first. baseUrl resolves relative and
    // protocol-relative URLs. URL.host excludes user:pass@, so credentials
    // in a custom tile URL never reach the map footer.
    host = new URL(raw.replace(/\{[^{}]*\}\.?/g, ''), baseUrl).host;
  } catch {
    // Not a URL we can read a host from.
  }
  return host ? `Map tiles: ${escapeHtml(host)}` : '';
}
