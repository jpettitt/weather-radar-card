import { describe, it, expect } from 'vitest';
import * as L from 'leaflet';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  basemapCredits,
  cartoKeyMissing,
  resolveAutoBasemap,
  getBasemapTiles,
  getBasemapTone,
  getCustomAttribution,
  isDarkBasemapStyle,
  isInvertedBasemap,
  resolveBasemapStyle,
  unknownTilePlaceholders,
  showsCartoKeyField,
  extraLabelsApply,
  effectiveBasemapStyle,
  themeModeApplies,
  MAP_STYLE_CHOICES,
  VECTOR_STYLES,
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

  it('maptiles: proxied OSM raster via HA core, token placeholder, never affected by a CARTO key', () => {
    const t = getBasemapTiles('maptiles', 'abc123');
    expect(t.url).toBe('/api/map_tiles/raster/{z}/{x}/{y}.png?token={token}');
    expect(t.subdomains).toBe('');
    expect(t.labelUrl).toBe('');
    expect(t.labelsBakedIn).toBe(true);
    expect(t.url).not.toContain('key=');
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
      .toBe('Map tiles: tile.example.org');
  });

  it('resolves relative and protocol-relative URLs against the page', () => {
    const page = 'http://homeassistant.local:8123/lovelace/0';
    expect(getCustomAttribution('/local/tiles/{z}/{x}/{y}.png', undefined, page))
      .toBe('Map tiles: homeassistant.local:8123');
    expect(getCustomAttribution('//tiles.example.net/{z}/{x}/{y}.png', undefined, page))
      .toBe('Map tiles: tiles.example.net');
  });

  it('returns empty for a URL it cannot parse a host from', () => {
    expect(getCustomAttribution('/local/tiles/{z}/{x}/{y}.png')).toBe('');
    expect(getCustomAttribution(undefined)).toBe('');
  });

  it('strips embedded userinfo credentials before they reach the map footer', () => {
    expect(getCustomAttribution('https://user:pass@tiles.example.com/{z}/{x}/{y}.png'))
      .toBe('Map tiles: tiles.example.com');
    expect(getCustomAttribution('https://apikey@tiles.example.com:8443/{z}/{x}/{y}.png'))
      .toBe('Map tiles: tiles.example.com:8443');
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

describe('isInvertedBasemap', () => {
  it('only inverts a custom basemap with custom_tile_theme: invert', () => {
    expect(isInvertedBasemap('custom', 'invert')).toBe(true);
    expect(isInvertedBasemap('Custom', 'Invert')).toBe(true);
    expect(isInvertedBasemap('custom', 'dark')).toBe(false);
    expect(isInvertedBasemap('custom')).toBe(false);
    expect(isInvertedBasemap('osm', 'invert')).toBe(false);
  });
});

describe('unknownTilePlaceholders', () => {
  // The same data Leaflet's getTileUrl fills for a basemap layer.
  const filled = { s: 'a', x: 1, y: 2, z: 3, r: '', '-y': 4 };
  const leafletThrows = (url: string): boolean => {
    try { L.Util.template(url, filled); return false; } catch { return true; }
  };

  it('flags exactly the templates Leaflet would throw on', () => {
    const urls = [
      'https://{s}.tile.example.com/{z}/{x}/{y}{r}.png',
      'https://tiles.example.com/{z}/{x}/{-y}.png',
      'https://tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey={apikey}',
      'https://tiles.example.com/{ z }/{x}/{y}.png',
      'https://tiles.example.com/{z}/{x}/{y}.png?style={"a":1}',
      'https://tiles.example.com/{z}/{x}/{y}.png?key=abc123',
    ];
    for (const url of urls) {
      expect(unknownTilePlaceholders(url).length > 0, url).toBe(leafletThrows(url));
    }
    expect(unknownTilePlaceholders(urls[2])).toEqual(['apikey']);
  });
});

describe('resolveBasemapStyle', () => {
  const custom = 'https://tiles.example.com/{z}/{x}/{y}.png';

  it('falls back to OSM for MapTiles without the map_tiles integration', () => {
    expect(resolveBasemapStyle('maptiles', { mapTilesLoaded: false })).toBe('osm');
    expect(resolveBasemapStyle('maptiles', { mapTilesLoaded: true })).toBe('maptiles');
  });

  it('falls back to OSM for Custom without a usable URL', () => {
    expect(resolveBasemapStyle('custom', { mapTilesLoaded: true })).toBe('osm');
    expect(resolveBasemapStyle('custom', { mapTilesLoaded: true, customTileUrl: '  ' })).toBe('osm');
    expect(resolveBasemapStyle('custom', { mapTilesLoaded: true, customTileUrl: `${custom}?k={apikey}` })).toBe('osm');
    expect(resolveBasemapStyle('custom', { mapTilesLoaded: true, customTileUrl: custom })).toBe('custom');
  });

  it('leaves every other style alone', () => {
    for (const style of ['light', 'dark', 'voyager', 'satellite', 'osm', 'grey', 'greydark']) {
      expect(resolveBasemapStyle(style, { mapTilesLoaded: false })).toBe(style);
    }
  });

  it('gives an unusable Custom URL OSM tiles', () => {
    expect(getBasemapTiles('custom', undefined, `${custom}?k={apikey}`).url).toBe(getBasemapTiles('osm').url);
  });
});

describe('basemapCredits', () => {
  const text = (html: string[]): string[] => html.map((h) => h.replace(/<[^>]+>/g, '').replace('&copy;', '©'));

  it('lists each map provider separately, so the Sources popup can put one per line', () => {
    expect(text(basemapCredits('grey'))).toEqual(['© OpenStreetMap contributors', '© Esri, HERE, Garmin']);
    expect(text(basemapCredits('dark'))).toEqual(['© OpenStreetMap contributors', '© CARTO']);
    expect(text(basemapCredits('osm'))).toEqual(['© OpenStreetMap contributors']);
    expect(text(basemapCredits('maptiles'))).toEqual(['© OpenStreetMap contributors']);
    expect(text(basemapCredits('satellite'))).toEqual(['© ESRI']);
  });

  it('credits a custom basemap by its attribution or host, and drops an empty one', () => {
    expect(basemapCredits('custom', 'https://t.example.com/{z}/{x}/{y}.png', 'My tiles')).toEqual(['My tiles']);
    expect(basemapCredits('custom', 'https://t.example.com/{z}/{x}/{y}.png')).toEqual(['Map tiles: t.example.com']);
    expect(basemapCredits('custom', '/local/{z}/{x}/{y}.png')).toEqual([]);
  });
});

// CARTO answers keyless requests with a blank "API KEY REQUIRED" tile
// (checked 2026-10-08), so Auto must not pick it without a key.
describe('resolveAutoBasemap', () => {
  const auto = (dark: boolean, english: boolean, key: string | undefined, mapTilesLoaded: boolean): string =>
    resolveAutoBasemap({ dark, english, cartoApiKey: key, mapTilesLoaded });

  it("uses Home Assistant's map tiles without a CARTO key, inverted in dark mode", () => {
    expect(auto(false, true, undefined, true)).toBe('maptiles');
    expect(auto(true, true, '', true)).toBe('maptiles-dark');
  });

  it('falls back to the keyless Grey styles (OSM for other languages) on older cores', () => {
    expect(auto(false, true, undefined, false)).toBe('grey');
    expect(auto(true, false, undefined, false)).toBe('greydark');
    expect(auto(false, false, undefined, false)).toBe('osm');
  });

  it('keeps the CARTO choice when a key is set', () => {
    expect(auto(false, true, 'k', true)).toBe('light');
    expect(auto(true, false, 'k', true)).toBe('dark');
    expect(auto(false, false, 'k', true)).toBe('osm');
  });
});

describe('effectiveBasemapStyle and theme_mode', () => {
  const style = (cfg: Parameters<typeof effectiveBasemapStyle>[0], haDark: boolean, mapTilesLoaded = true): string =>
    effectiveBasemapStyle(cfg, { haDark, english: true, mapTilesLoaded });

  it('auto (or unset, or unknown) follows HA for the vector map and Auto, as before', () => {
    for (const theme_mode of [undefined, 'auto', 'Auto', 'sepia']) {
      const cfg = theme_mode ? { theme_mode } : {};
      expect(style({ ...cfg, map_style: 'MapTilesVector' }, true)).toBe('maptiles-vector-dark');
      expect(style({ ...cfg, map_style: 'MapTilesVector' }, false)).toBe('maptiles-vector');
      expect(style(cfg, true)).toBe('maptiles-dark');
      expect(style({ ...cfg, carto_api_key: 'k' }, true)).toBe('dark');
    }
  });

  it('auto keeps MapTiles light in dark mode, as before', () => {
    expect(style({ map_style: 'MapTiles' }, true)).toBe('maptiles');
    expect(style({ map_style: 'MapTiles', theme_mode: 'auto' }, true)).toBe('maptiles');
  });

  it('light forces the light version in HA dark mode', () => {
    expect(style({ map_style: 'MapTilesVector', theme_mode: 'light' }, true)).toBe('maptiles-vector');
    expect(style({ theme_mode: 'light' }, true)).toBe('maptiles');
    expect(style({ theme_mode: 'light', carto_api_key: 'k' }, true)).toBe('light');
    expect(style({ theme_mode: 'light' }, true, false)).toBe('grey');
    expect(style({ map_style: 'MapTiles', theme_mode: 'light' }, true)).toBe('maptiles');
  });

  it('dark forces the dark version in HA light mode, inverting MapTiles', () => {
    expect(style({ map_style: 'MapTilesVector', theme_mode: 'Dark' }, false)).toBe('maptiles-vector-dark');
    expect(style({ theme_mode: 'dark' }, false)).toBe('maptiles-dark');
    expect(style({ theme_mode: 'dark', carto_api_key: 'k' }, false)).toBe('dark');
    expect(style({ theme_mode: 'dark' }, false, false)).toBe('greydark');
    expect(style({ map_style: 'MapTiles', theme_mode: 'dark' }, false)).toBe('maptiles-dark');
    // Without map_tiles, MapTiles falls back to OSM whatever the theme.
    expect(style({ map_style: 'MapTiles', theme_mode: 'dark' }, false, false)).toBe('osm');
  });

  it("doesn't change styles with only one version", () => {
    for (const map_style of ['Light', 'Voyager', 'Dark', 'OSM', 'Grey', 'GreyDark', 'Satellite']) {
      expect(style({ map_style, theme_mode: 'dark' }, false)).toBe(map_style.toLowerCase());
      expect(style({ map_style, theme_mode: 'light' }, true)).toBe(map_style.toLowerCase());
    }
    expect(style({ map_style: 'Custom', custom_tile_url: 'https://t.example/{z}/{x}/{y}.png', theme_mode: 'dark' }, false)).toBe('custom');
  });

  it('is offered in the editor only for those styles', () => {
    for (const s of [undefined, 'Auto', 'MapTiles', 'MapTilesVector']) expect(themeModeApplies(s)).toBe(true);
    for (const s of ['Light', 'Voyager', 'Dark', 'OSM', 'Grey', 'GreyDark', 'Satellite', 'Custom']) expect(themeModeApplies(s)).toBe(false);
  });
});

describe("the editor's map style list", () => {
  it("offers every style, Auto first, then HA's own maps", () => {
    expect(MAP_STYLE_CHOICES.map((c) => c.value)).toEqual([
      'Auto', 'MapTiles', 'MapTilesVector', 'OSM', 'Satellite', 'Light', 'Voyager', 'Dark', 'Grey', 'GreyDark', 'Custom',
    ]);
  });

  it('has every label and description it shows in every language', () => {
    const dir = join(process.cwd(), 'src/localize/languages');
    const keys = [
      ...MAP_STYLE_CHOICES.flatMap((c) => [c.label, c.desc].filter((k): k is string => !!k)),
      ...VECTOR_STYLES.map((v) => `vector_style_${v}`),
      ...['auto', 'light', 'dark'].map((m) => `theme_mode_${m}`),
      'vector_style', 'theme_mode', 'needs_map_tiles', 'key_required',
    ];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const map = JSON.parse(readFileSync(join(dir, file), 'utf8')).editor.map;
      const missing = keys.filter((k) => typeof map[k] !== 'string' || !map[k].trim());
      expect({ file, missing }).toEqual({ file, missing: [] });
    }
  });
});

describe('maptiles-dark (Auto in dark mode)', () => {
  it('draws MapTiles through the invert filter with the dark palette', () => {
    expect(getBasemapTiles('maptiles-dark').url).toBe(getBasemapTiles('maptiles').url);
    expect(isInvertedBasemap('maptiles-dark')).toBe(true);
    expect(isDarkBasemapStyle('maptiles-dark')).toBe(true);
    expect(basemapCredits('maptiles-dark')).toEqual(basemapCredits('maptiles'));
  });
});

describe('cartoKeyMissing', () => {
  it('flags the CARTO styles without a key, and nothing else', () => {
    for (const style of ['Light', 'voyager', 'Dark']) expect(cartoKeyMissing(style, undefined)).toBe(true);
    expect(cartoKeyMissing('Light', '  ')).toBe(true);
    expect(cartoKeyMissing('Light', 'k')).toBe(false);
    for (const style of ['Auto', 'Satellite', 'OSM', 'Grey', 'MapTiles', undefined]) expect(cartoKeyMissing(style, undefined)).toBe(false);
  });

  it("leaves Satellite's CARTO labels off without a key", () => {
    expect(getBasemapTiles('satellite').labelUrl).toBe('');
    expect(getBasemapTiles('satellite', 'k').labelUrl).toContain('voyager_only_labels');
  });
});

// Editor rules: the CARTO key field only where a key does something, and
// extra_labels greyed out where it has no effect.
describe('editor rules for map styles', () => {
  it('shows the CARTO key field for the styles a key changes', () => {
    for (const style of ['Auto', undefined, 'Light', 'Voyager', 'Dark', 'Satellite']) {
      expect(showsCartoKeyField(style, '')).toBe(true);
    }
  });

  it('hides an empty CARTO key field where no CARTO tiles are used', () => {
    for (const style of ['OSM', 'Grey', 'GreyDark', 'Custom', 'MapTiles', 'MapTilesVector']) {
      expect(showsCartoKeyField(style, '')).toBe(false);
      expect(showsCartoKeyField(style, '   ')).toBe(false);
    }
  });

  it('keeps showing a CARTO key that is set, so it can be cleared', () => {
    expect(showsCartoKeyField('MapTilesVector', 'abc123')).toBe(true);
  });

  it('greys out extra labels only for the vector map', () => {
    expect(extraLabelsApply('MapTilesVector')).toBe(false);
    expect(extraLabelsApply('maptilesvector')).toBe(false);
    for (const style of ['MapTiles', 'OSM', 'Light', 'Custom', 'Satellite', undefined]) {
      expect(extraLabelsApply(style)).toBe(true);
    }
  });
});
