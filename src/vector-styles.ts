/* eslint-disable @typescript-eslint/no-explicit-any */
// HA's non-default vector styles (Colorful, Natural, Muted, Gray, Toner),
// built in the browser as HA's frontend builds them: VersaTiles' palette,
// then HA's finalizeMapStyle steps. Bundled only into the MapLibre file
// (vector-basemap-layer.ts); the card's main file must not import it.
import { osm } from '@versatiles/style';

const TILEJSON_PATH = '/api/map_tiles/tilejson.json';
// Names sorting before U+0250 (the end of Latin Extended-B) are Latin.
const FIRST_NON_LATIN = 'ɐ';

// The card's own `classic` style: the colours of the classic OpenStreetMap
// map (openstreetmap-carto, what the raster MapTiles show) on VersaTiles'
// Colorful cartography. Roads keep Colorful's widths and zoom thresholds,
// which are already carto's.
const CLASSIC_LIGHT: Record<string, string> = {
  background: '#f2efe9', land: '#f2efe9', water: '#aad3df', glacier: '#ddecec',
  natureWood: '#add19e', natureGrass: '#cdebb0', naturePark: '#c8facc', natureAgriculture: '#eef0d5',
  natureSand: '#f5e9c6', natureRock: '#eee5dc', natureWetland: '#d6ebe0', natureLeisure: '#dffce2',
  areaResidential: '#e0dfdf', areaCommercial: '#f2dad9', areaIndustrial: '#ebdbe8', areaWaste: '#b6b592', areaBurial: '#aacbaf',
  siteConstruction: '#c7c7b4', siteEducation: '#ffffe5', siteHospital: '#ffffe5', siteDanger: '#f3e4de',
  sitePrison: '#e6e6e6', siteParking: '#eeeeee', siteSports: '#aae0cb',
  building: '#d9d0c9', buildingBg: '#c4b9ad',
  roadStreet: '#ffffff', roadStreetBg: '#bbbbbb', roadMotorway: '#e892a2', roadMotorwayBg: '#dc2a67',
  roadTrunk: '#f9b29c', roadTrunkBg: '#c84e2f',
  transitRail: '#707070', transitSubway: '#a0a0a0', transitCycle: '#3030e0', transitFoot: '#fa8072',
  boundary: '#ac46ac', boundaryDisputed: '#ac46ac',
  label: '#000000', labelHalo: '#ffffff', labelShield: '#000000', labelSymbol: '#734a08', labelPoi: '#734a08',
  labelHousenumber: '#666666', labelWater: '#4d80b3',
};
// Tuned by hand rather than inverted: the raster MapTiles dark is an
// inverted image, which turns water brown and forests purple. Dark neutral
// ground, low-saturation features, water blue and woods green.
const CLASSIC_DARK: Record<string, string> = {
  background: '#1c1d20', land: '#1f2023', water: '#1d3550', glacier: '#2a3136',
  natureWood: '#223326', natureGrass: '#273a2a', naturePark: '#253a28', natureAgriculture: '#27281f',
  natureSand: '#2d2b23', natureRock: '#29282c', natureWetland: '#212e2d', natureLeisure: '#24332c',
  areaResidential: '#262729', areaCommercial: '#2e2729', areaIndustrial: '#2a272e', areaWaste: '#2b2a21', areaBurial: '#24332c',
  siteConstruction: '#2c2c25', siteEducation: '#2c2c21', siteHospital: '#2c2c21', siteDanger: '#302525',
  sitePrison: '#2c2c2c', siteParking: '#282828', siteSports: '#243c32',
  building: '#2b2c31', buildingBg: '#3a3b41',
  roadStreet: '#6b6e75', roadStreetBg: '#3a3c41', roadMotorway: '#a85c6c', roadMotorwayBg: '#7a3a4a',
  roadTrunk: '#a67a5e', roadTrunkBg: '#6b4530',
  transitRail: '#8a8a8a', transitSubway: '#6a6a6a', transitCycle: '#5a6ab0', transitFoot: '#9a6a62',
  boundary: '#8a5a8a', boundaryDisputed: '#8a5a8a',
  label: '#e0e0e0', labelHalo: '#1c1d20', labelShield: '#ececec', labelSymbol: '#cfa882', labelPoi: '#cfa882',
  labelHousenumber: '#9a9a9a', labelWater: '#8fb3d9',
};
// Road colours the palette can't express (the builder derives primary and
// secondary from the trunk colour): [line, casing] per class. Dark keeps
// the raster dark's light-grey roads, with a hint of carto's tints.
const CLASSIC_ROADS: Record<'light' | 'dark', Record<string, [string, string]>> = {
  light: { primary: ['#fcd6a4', '#a06b00'], secondary: ['#f7fabf', '#707d05'], tertiary: ['#ffffff', '#8f8f8f'] },
  dark: { primary: ['#a39372', '#5a4d33'], secondary: ['#8c8d88', '#4a4a44'], tertiary: ['#6b6e75', '#3a3c41'] },
};

/**
 * The style for `theme` ('muted', 'muted-dark', 'classic', …) from the
 * frontend's /static/map/urls.json (glyph and sprite URLs). Flat and without
 * sky for the reason in loadVectorStyle.
 */
export function buildVectorStyle(theme: string, urls: unknown): any {
  const dark = theme.endsWith('-dark');
  const classic = theme === 'classic' || theme === 'classic-dark';
  const options: Record<string, unknown> = {
    theme: classic ? (dark ? 'colorful-dark' : 'colorful') : theme,
    urls, projection: 'mercator', sky: false,
  };
  if (classic) options.colors = dark ? CLASSIC_DARK : CLASSIC_LIGHT;
  const style = osm(options as Parameters<typeof osm>[0]);
  if (classic) recolorRoads(style, CLASSIC_ROADS[dark ? 'dark' : 'light']);
  return finishForHa(style);
}

// Every line layer of the classes in `roads` (bridges, tunnels and links
// included); the `:outline` layers are the casings.
function recolorRoads(style: any, roads: Record<string, [string, string]>): void {
  for (const layer of style.layers) {
    const m = /street-(primary|secondary|tertiary)(?:-link)?(?::|$)/.exec(layer.id);
    if (!m || layer.type !== 'line' || !layer.paint?.['line-color']) continue;
    const [line, casing] = roads[m[1]];
    layer.paint['line-color'] = layer.id.includes(':outline') ? casing : line;
  }
}

/** HA's finalizeMapStyle steps, on a VersaTiles style, in place. */
export function finishForHa(style: any): any {
  useMapTiles(style);
  for (const layer of style.layers) {
    const layout = layer.layout;
    if (layer.type === 'symbol' && isPlainName(layout?.['text-field'])) {
      layout['text-field'] = withEnglishName(layout['symbol-placement'] === 'line');
    }
  }
  return style;
}

// VersaTiles points its one source at its own tile server; HA's TileJSON
// carries map_tiles' tile URL, zoom range and credit instead.
function useMapTiles(style: any): void {
  const sources = Object.values(style.sources ?? {}) as any[];
  if (sources.length !== 1) throw new Error(`expected one tile source, got ${sources.length}`);
  for (const key of ['tiles', 'attribution', 'bounds', 'minzoom', 'maxzoom', 'scheme']) delete sources[0][key];
  sources[0].url = TILEJSON_PATH;
}

function isPlainName(field: unknown): boolean {
  return Array.isArray(field) && field.length === 2 && field[0] === 'get' && field[1] === 'name';
}

// A non-Latin name gets its English name too, when the tile has one: on its
// own line for points and areas, in brackets along roads and rivers.
function withEnglishName(alongLine: boolean): unknown[] {
  const name = ['get', 'name'];
  const english = ['get', 'name_en'];
  return [
    'case',
    ['<', name, FIRST_NON_LATIN], name,
    ['!', ['has', 'name_en']], name,
    alongLine
      ? ['concat', name, ' (', english, ')']
      : ['format', name, {}, '\n', {}, english, { 'font-scale': 0.8 }],
  ];
}
