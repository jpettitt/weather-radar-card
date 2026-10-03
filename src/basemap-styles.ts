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

export function getBasemapTiles(mapStyle: string, cartoApiKey?: string): BasemapTiles {
  switch (mapStyle) {
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
    case 'maptiles':
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

export function getBasemapTone(mapStyle: string | undefined): BasemapTone {
  const s = mapStyle?.toLowerCase();
  if (s === 'satellite') return 'satellite';
  if (s === 'dark' || s === 'greydark') return 'dark';
  return 'light';
}

/** True for any basemap dark enough to need light-on-dark UI colors. */
export function isDarkBasemapStyle(mapStyle: string | undefined): boolean {
  return getBasemapTone(mapStyle) !== 'light';
}
