import { describe, it, expect } from 'vitest';
import { getBasemapTiles, getBasemapTone, isDarkBasemapStyle } from '../src/basemap-styles';

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

  it('maptiles: proxied OSM raster via HA core, token placeholder, never affected by a CARTO key', () => {
    const t = getBasemapTiles('maptiles', 'abc123');
    expect(t.url).toBe('/api/map_tiles/raster/{z}/{x}/{y}.png?token={token}');
    expect(t.subdomains).toBe('');
    expect(t.labelUrl).toBe('');
    expect(t.labelsBakedIn).toBe(true);
    expect(t.url).not.toContain('key=');
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
    expect(getBasemapTone('maptiles')).toBe('light');
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
});
