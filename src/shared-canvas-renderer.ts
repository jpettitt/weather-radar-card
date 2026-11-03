import * as L from 'leaflet';
import { hideElementWhileZooming } from './hide-while-zooming';

// ONE canvas renderer per map, shared by every vector overlay (NWS
// alerts, wildfire perimeters). This is load-bearing, not a memory
// optimisation: an L.Canvas receives clicks as DOM events on its own
// canvas element, which covers the whole viewport+padding. With two
// renderers stacked in the overlay pane, the topmost canvas swallows
// every click — it hit-tests only ITS OWN paths, and DOM events bubble
// up to ancestors, never down to the sibling canvas underneath. Live
// symptom: alert polygons stopped being clickable the moment the first
// fire perimeter crossed the icon→polygon zoom threshold (which lazily
// created the second renderer on top), and stayed dead after zooming
// back out (the empty renderer stays attached). SVG renderers never
// collide like this because pointer events sit on the individual path
// elements, not the renderer root — canvas interactivity only works
// with a single shared renderer, which hit-tests all layers in one
// draw list (topmost path wins, matching SVG behaviour).
//
// padding 0.5 = render half a viewport beyond each edge so short pans
// don't reveal blank vectors before the post-move redraw.
//
// Keyed weakly by map: a card rebuild creates a fresh map and gets a
// fresh renderer; the old one is garbage with its map. Layers must NOT
// remove the renderer from the map in their clear() — another layer
// may still be drawing through it. An empty renderer left attached is
// harmless: markers live in higher panes, and map-level click handlers
// (e.g. the lightning hit-test) still fire via bubbling.
const renderers = new WeakMap<L.Map, L.Canvas>();

export function sharedCanvasRenderer(map: L.Map): L.Canvas {
  let r = renderers.get(map);
  if (!r) {
    r = L.canvas({ padding: 0.5 });
    renderers.set(map, r);
    hideWhileZooming(map, r);
  }
  return r;
}

// During a pinch or an animated zoom Leaflet scales this canvas with a CSS
// transform on every touch move: 1560x2960 px on a phone, 16x for a
// four-level pinch. Safari on an iPhone died on a fast pinch whenever an
// overlay had drawn to the canvas and never without one (2026-10-16), so
// the canvas leaves the page for the gesture; see hide-while-zooming.ts.
export function hideWhileZooming(map: L.Map, r: L.Canvas): void {
  hideElementWhileZooming(map, () => (r as unknown as { _container?: HTMLElement })._container);
}
