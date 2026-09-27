// Basemap tile URL templates per map_style, factored out of
// weather-radar-card.ts so they're unit-testable without Leaflet/DOM.
//
// CARTO's free basemap tiles (Dark/Voyager/Light, and Satellite's label
// overlay) now stamp anonymous requests with a visible "API key
// required" watermark — the tiles still load, just watermarked. A free
// key (carto.com/basemaps/apikey — no account needed) removes it via a
// `?key=` query param. Grey/GreyDark are ESRI Living Atlas Canvas
// basemaps that never need a key at all, for anyone who'd rather not
// sign up — same free-for-public-apps basis this project already
// relies on for Satellite's World_Imagery.
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
      if (!url) return getBasemapTiles('osm');
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
      return {
        url: `${ESRI_HOST}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
        subdomains: 'abcd',
        labelUrl: cartoTile('rastertiles/voyager_only_labels', cartoApiKey),
        labelsBakedIn: false,
      };
    case 'osm':
      return {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: 'abc',
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
  if (s === 'dark' || s === 'greydark') return 'dark';
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
export function isInvertedCustomBasemap(
  mapStyle: string | undefined,
  customTileTheme?: string,
): boolean {
  return mapStyle?.toLowerCase() === 'custom' && customTileTheme?.toLowerCase() === 'invert';
}

/**
 * Attribution HTML for a custom basemap. The user's text is escaped (it
 * lands in innerHTML); without one, credit the tile host so the map is
 * never shown uncredited.
 */
export function getCustomAttribution(customTileUrl?: string, attribution?: string): string {
  const text = attribution?.trim();
  if (text) return escapeHtml(text);
  const host = customTileUrl?.trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1];
  return host ? `Map tiles: ${escapeHtml(host)}` : '';
}
