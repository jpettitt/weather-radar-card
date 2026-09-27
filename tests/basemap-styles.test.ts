import { describe, it, expect } from 'vitest';
import {
  getBasemapTiles,
  getBasemapTone,
  getCustomAttribution,
  isDarkBasemapStyle,
  isInvertedCustomBasemap,
} from '../src/basemap-styles';

describe('getBasemapTiles', () => {
  it('CARTO styles omit ?key= entirely when no API key is set (today\'s default)', () => {
    expect(getBasemapTiles('dark').url).toBe('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png');
    expect(getBasemapTiles('dark').labelUrl).toBe('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png');
    expect(getBasemapTiles('voyager').url)
      .toBe('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png');
    expect(getBasemapTiles('unknown-or-unset').url)
      .toBe('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png');
  });

  it('appends ?key=<value> to every CARTO URL when a key is set', () => {
    const t = getBasemapTiles('dark', 'abc123');
    expect(t.url).toBe('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png?key=abc123');
    expect(t.labelUrl).toBe('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png?key=abc123');
  });

  it('URI-encodes special characters in the key', () => {
    const t = getBasemapTiles('voyager', 'a b/c');
    expect(t.url).toContain(`?key=${encodeURIComponent('a b/c')}`);
  });

  it('trims a whitespace-padded key and treats an all-whitespace key as unset', () => {
    expect(getBasemapTiles('dark', '  abc123  ').url).toContain('?key=abc123');
    expect(getBasemapTiles('dark', '   ').url).not.toContain('?key=');
  });

  it('satellite: ESRI imagery base is never affected by the key, but its CARTO label overlay is', () => {
    const withKey = getBasemapTiles('satellite', 'abc123');
    expect(withKey.url).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
    expect(withKey.labelUrl).toContain('?key=abc123');
    const noKey = getBasemapTiles('satellite');
    expect(noKey.url).toBe(withKey.url);
    expect(noKey.labelUrl).not.toContain('?key=');
  });

  it('osm: no key ever affects it, and labels are baked into the base layer', () => {
    const t = getBasemapTiles('osm', 'abc123');
    expect(t.url).toBe('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(t.labelUrl).toBe('');
    expect(t.labelsBakedIn).toBe(true);
    expect(t.url).not.toContain('key=');
  });

  it('grey/greydark: ESRI canvas tiles, never affected by a CARTO key, need no key at all', () => {
    const grey = getBasemapTiles('grey', 'abc123');
    expect(grey.url).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}');
    expect(grey.labelUrl).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}');
    expect(grey.labelsBakedIn).toBe(false);

    const greyDark = getBasemapTiles('greydark', 'abc123');
    expect(greyDark.url).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}');
    expect(greyDark.labelUrl).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}');
  });

  it('custom: uses the user template as-is (trimmed), labels baked in, CARTO key ignored', () => {
    const t = getBasemapTiles('custom', 'abc123', '  https://tiles.example.com/{z}/{x}/{y}.png  ');
    expect(t.url).toBe('https://tiles.example.com/{z}/{x}/{y}.png');
    expect(t.labelUrl).toBe('');
    expect(t.labelsBakedIn).toBe(true);
    expect(t.subdomains).toBe('abc');
  });

  it('custom: blank or missing URL falls back to OSM instead of an empty map', () => {
    const osm = getBasemapTiles('osm');
    expect(getBasemapTiles('custom')).toEqual(osm);
    expect(getBasemapTiles('custom', undefined, '   ')).toEqual(osm);
  });
});

describe('getCustomAttribution', () => {
  it('escapes user-supplied attribution (it is written to innerHTML)', () => {
    expect(getCustomAttribution('https://t.example.com/{z}/{x}/{y}.png', '© OSM <script>x</script>'))
      .toBe('© OSM &lt;script&gt;x&lt;/script&gt;');
  });

  it('credits the tile host when no attribution is given', () => {
    expect(getCustomAttribution('https://tiles.example.com:8443/{z}/{x}/{y}.png'))
      .toBe('Map tiles: tiles.example.com:8443');
    expect(getCustomAttribution('https://{s}.tile.example.org/{z}/{x}/{y}.png', '  '))
      .toBe('Map tiles: {s}.tile.example.org');
  });

  it('returns empty for a URL it cannot parse a host from', () => {
    expect(getCustomAttribution('/local/tiles/{z}/{x}/{y}.png')).toBe('');
    expect(getCustomAttribution(undefined)).toBe('');
  });
});

describe('getBasemapTone / isDarkBasemapStyle', () => {
  it('classifies each style correctly', () => {
    expect(getBasemapTone('dark')).toBe('dark');
    expect(getBasemapTone('greydark')).toBe('dark');
    expect(getBasemapTone('satellite')).toBe('satellite');
    expect(getBasemapTone('light')).toBe('light');
    expect(getBasemapTone('voyager')).toBe('light');
    expect(getBasemapTone('osm')).toBe('light');
    expect(getBasemapTone('grey')).toBe('light');
    expect(getBasemapTone(undefined)).toBe('light');
  });

  it('is case-insensitive', () => {
    expect(getBasemapTone('Dark')).toBe('dark');
    expect(getBasemapTone('GreyDark')).toBe('dark');
  });

  it('isDarkBasemapStyle is true for dark and satellite tones only', () => {
    expect(isDarkBasemapStyle('dark')).toBe(true);
    expect(isDarkBasemapStyle('satellite')).toBe(true);
    expect(isDarkBasemapStyle('greydark')).toBe(true);
    expect(isDarkBasemapStyle('grey')).toBe(false);
    expect(isDarkBasemapStyle('osm')).toBe(false);
    expect(isDarkBasemapStyle(undefined)).toBe(false);
  });

  it('custom: tone follows custom_tile_theme (invert counts as dark), default light', () => {
    expect(getBasemapTone('custom')).toBe('light');
    expect(getBasemapTone('custom', 'light')).toBe('light');
    expect(getBasemapTone('Custom', 'Dark')).toBe('dark');
    expect(getBasemapTone('custom', 'invert')).toBe('dark');
    expect(isDarkBasemapStyle('custom', 'invert')).toBe(true);
  });

  it('custom_tile_theme has no effect on built-in styles', () => {
    expect(getBasemapTone('osm', 'dark')).toBe('light');
    expect(getBasemapTone('dark', 'light')).toBe('dark');
  });
});

describe('isInvertedCustomBasemap', () => {
  it('only inverts a custom basemap with custom_tile_theme: invert', () => {
    expect(isInvertedCustomBasemap('custom', 'invert')).toBe(true);
    expect(isInvertedCustomBasemap('Custom', 'Invert')).toBe(true);
    expect(isInvertedCustomBasemap('custom', 'dark')).toBe(false);
    expect(isInvertedCustomBasemap('custom')).toBe(false);
    expect(isInvertedCustomBasemap('osm', 'invert')).toBe(false);
  });
});
