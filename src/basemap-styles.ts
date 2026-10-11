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
  // The vector map has HA's own dark style for a dark theme.
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

/**
 * A config value as a lowercase word. YAML hands over a boolean or a number
 * where a word was meant (`vector_labels: false`), and calling string methods
 * on those threw while the map was being built.
 */
export function configWord(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** vector_labels: over the radar unless `below`, or `false`. */
export function vectorLabelsAbove(value: unknown): boolean {
  return value !== false && configWord(value) !== 'below';
}

/** theme_mode as auto, light or dark: anything else is auto. */
export function themeModeName(value: unknown): 'auto' | 'light' | 'dark' {
  const mode = configWord(value);
  return mode === 'light' || mode === 'dark' ? mode : 'auto';
}

/** Styles the CARTO key changes: CARTO's own, Satellite's labels, and Auto (a key switches it to CARTO). */
const CARTO_KEY_STYLES = new Set(['auto', 'light', 'voyager', 'dark', 'satellite']);

/**
 * Whether the editor shows the CARTO key field: where a key does something,
 * or when one is set (so it can be cleared). An unknown style counts: the
 * card draws CARTO Light for it.
 */
export function showsCartoKeyField(mapStyle: unknown, cartoApiKey?: string): boolean {
  const style = configWord(mapStyle) || 'auto';
  return CARTO_KEY_STYLES.has(style) || !MAP_STYLE_CHOICES.some((c) => c.value.toLowerCase() === style) || !!cartoApiKey?.trim();
}

/** extra_labels draws raster tiles a zoom level higher at half size; the vector map has no tiles to resize. */
export function extraLabelsApply(mapStyle: unknown): boolean {
  return configWord(mapStyle) !== 'maptilesvector';
}

/** True when a CARTO style is chosen without a key, so its tiles will be blank. */
export function cartoKeyMissing(mapStyle: unknown, cartoApiKey?: string): boolean {
  return CARTO_STYLES.has(configWord(mapStyle)) && !cartoApiKey?.trim();
}

/**
 * The editor's map style list: Auto, HA's own maps, then the online ones.
 * `label` and `desc` (the line under the list for the chosen style) are
 * editor.map locale keys; `mapTiles` needs HA's map_tiles integration,
 * `cartoKey` a CARTO key.
 */
export const MAP_STYLE_CHOICES: ReadonlyArray<{
  value: string; label: string; desc?: string; mapTiles?: boolean; cartoKey?: boolean;
}> = [
  { value: 'Auto', label: 'style_auto', desc: 'style_desc_auto' },
  { value: 'MapTiles', label: 'style_maptiles', desc: 'style_desc_maptiles', mapTiles: true },
  { value: 'MapTilesVector', label: 'style_maptiles_vector', desc: 'style_desc_maptiles_vector', mapTiles: true },
  { value: 'OSM', label: 'style_osm', desc: 'style_desc_osm' },
  { value: 'Satellite', label: 'style_satellite', desc: 'style_desc_satellite' },
  { value: 'Light', label: 'style_light', desc: 'style_desc_carto', cartoKey: true },
  { value: 'Voyager', label: 'style_voyager', desc: 'style_desc_carto', cartoKey: true },
  { value: 'Dark', label: 'style_dark', desc: 'style_desc_carto', cartoKey: true },
  { value: 'Grey', label: 'style_grey', desc: 'style_desc_esri' },
  { value: 'GreyDark', label: 'style_grey_dark', desc: 'style_desc_esri' },
  // Its own fields carry the help.
  { value: 'Custom', label: 'style_custom' },
];

/** HA's vector map styles, as its map card offers them, plus the card's own
 *  Classic: the classic OpenStreetMap colours (vector-styles.ts). */
export const VECTOR_STYLES = ['default', 'classic', 'colorful', 'natural', 'muted', 'gray', 'toner'] as const;
export type VectorStyle = typeof VECTOR_STYLES[number];

/** `vector_style` as one of VECTOR_STYLES: unset or unknown is Default. */
export function vectorStyleName(value: unknown): VectorStyle {
  const name = configWord(value);
  return (VECTOR_STYLES as readonly string[]).includes(name) ? name as VectorStyle : 'default';
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

/** Styles theme_mode changes: those with light and dark versions. */
const THEMED_STYLES = new Set(['auto', 'maptiles', 'maptilesvector']);

/** Whether the editor shows theme_mode for this map_style. */
export function themeModeApplies(mapStyle: unknown): boolean {
  return THEMED_STYLES.has(configWord(mapStyle) || 'auto');
}

/**
 * The basemap drawn for the card's config. theme_mode `light` or `dark`
 * overrides HA's dark mode for the styles with both versions; `auto` (or
 * unset) keeps each style's usual behaviour.
 */
export function effectiveBasemapStyle(
  cfg: { map_style?: unknown; theme_mode?: unknown; custom_tile_url?: string; carto_api_key?: string },
  env: { haDark: boolean; english: boolean; mapTilesLoaded: boolean },
): string {
  const mode = themeModeName(cfg.theme_mode);
  const dark = mode === 'dark' || (mode === 'auto' && env.haDark);
  const configured = configWord(cfg.map_style);
  if (configured && configured !== 'auto') {
    // Only when forced: MapTiles has always stayed light in HA's dark mode,
    // and auto-updated cards shouldn't change.
    if (configured === 'maptiles' && mode === 'dark' && env.mapTilesLoaded) return 'maptiles-dark';
    return resolveBasemapStyle(configured, { mapTilesLoaded: env.mapTilesLoaded, customTileUrl: cfg.custom_tile_url, dark });
  }
  return resolveAutoBasemap({ dark, english: env.english, cartoApiKey: cfg.carto_api_key, mapTilesLoaded: env.mapTilesLoaded });
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
  /** Satellite with its labels from HA's map tiles: OSM data over the imagery. */
  satelliteVectorLabels = false,
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
    case 'satellite': {
      const esri = '&copy; <a href="http://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank">ESRI</a>';
      return satelliteVectorLabels ? [esri, `${OSM_CREDIT} contributors`] : [esri];
    }
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
