/* eslint-disable @typescript-eslint/no-explicit-any */
// HA's non-default vector styles (Colorful, Natural, Muted, Gray, Toner),
// built in the browser as HA's frontend builds them: VersaTiles' palette,
// then HA's finalizeMapStyle steps. Bundled only into the MapLibre file
// (vector-basemap-layer.ts); the card's main file must not import it.
import { osm } from '@versatiles/style';

const TILEJSON_PATH = '/api/map_tiles/tilejson.json';
// Names sorting before U+0250 (the end of Latin Extended-B) are Latin.
const FIRST_NON_LATIN = 'ɐ';

/**
 * The style for `theme` ('muted', 'muted-dark', …) from the frontend's
 * /static/map/urls.json (glyph and sprite URLs). Flat and without sky for
 * the reason in loadVectorStyle.
 */
export function buildVectorStyle(theme: string, urls: unknown): any {
  const style: any = osm({ theme, urls, projection: 'mercator', sky: false } as Parameters<typeof osm>[0]);
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
