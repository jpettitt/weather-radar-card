// The part of the vector basemap that needs MapLibre (1 MB minified, 276 KB
// gzipped), loaded by vector-basemap.ts with import() so rollup splits it
// into its own file: only cards with map_style: MapTilesVector download it.
// It must not import anything the card's main file also uses (Leaflet
// included): rollup would then move that code out of weather-radar-card.js
// into a shared file, and the card would no longer be one file.
import * as maplibreModule from 'maplibre-gl';
// @ts-expect-error — rollup-plugin-string imports *.css as text
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css';
import type * as Leaflet from 'leaflet';
import { defineMaplibreLayer, type MaplibreLayer } from './maplibre-leaflet-layer';

// maplibre-gl ships as UMD; rollup's CommonJS interop may put it under default.
const maplibre = ((maplibreModule as unknown as { default?: typeof maplibreModule }).default ?? maplibreModule);

let createLayer: ((options: Record<string, unknown>) => MaplibreLayer) | undefined;
let rtlRequested = false;

/**
 * A Leaflet layer drawing `style` with MapLibre, as HA's own Leaflet maps do
 * (frontend base-layer.ts). Not yet on the map: adding it builds the WebGL
 * map, which throws when the browser refuses a context.
 */
export function createVectorLayer(opts: {
  L: typeof Leaflet;
  style: unknown;
  transformRequest: (url: string) => { url: string };
  rtlPluginUrl: string;
  cssRoot: Node;
}): MaplibreLayer {
  addCss(opts.cssRoot);
  if (!rtlRequested) {
    rtlRequested = true;
    // Without it Arabic and Hebrew labels render reversed. Page-wide, once.
    maplibre.setRTLTextPlugin(opts.rtlPluginUrl, true).catch(() => { /* labels stay unshaped */ });
  }
  createLayer ??= defineMaplibreLayer(opts.L, maplibre);
  return createLayer({
    style: opts.style,
    transformRequest: opts.transformRequest,
    interactive: false,
    // CJK labels drawn with a device font, so their glyphs are never
    // requested — as HA's own map does.
    localIdeographFontFamily: 'sans-serif',
  });
}

// MapLibre's CSS has to be inside the card's shadow root to reach its canvas.
function addCss(root: Node): void {
  const host = root as Node & { querySelector?: (s: string) => Element | null; appendChild(n: Node): Node };
  if (!host.querySelector || host.querySelector('style[data-wrc-maplibre]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-wrc-maplibre', '');
  style.textContent = maplibreCss;
  host.appendChild(style);
}
