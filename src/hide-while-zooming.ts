import * as L from 'leaflet';
import { onMapQuiet } from './map-quiet';

// Takes an element out of the page from zoomstart until the map has been
// still for MAP_QUIET_MS after the gesture, when Leaflet has repositioned
// or redrawn everything at the new zoom and the compositor has settled.
//
// Why `display: none` and not `visibility: hidden`: a hidden element keeps
// its compositing layer, and Leaflet still runs its 250 ms transform
// transition on every `.leaflet-zoom-animated` element when a zoom snaps
// to a level. Safari on an iPhone died on a fast pinch, and then on the
// snap-back after an over-zoomed pinch, whenever an overlay had put a
// large canvas or dozens of markers on the map (2026-10-16); the radar
// alone never crashed it. Leaflet's own `.leaflet-zoom-hide` does the same
// for popups. Used for the shared canvas renderer, the hazard icon pane
// and the lightning canvas. Returns a disposer for layers that come and go.
export function hideElementWhileZooming(map: L.Map, element: () => HTMLElement | undefined): () => void {
  const hide = (): void => {
    const el = element();
    if (el) el.style.display = 'none';
  };
  const show = (): void => {
    const el = element();
    if (el) el.style.display = '';
  };
  map.on('zoomstart', hide);
  const disposeQuiet = onMapQuiet(map, show);
  return () => {
    map.off('zoomstart', hide);
    disposeQuiet();
    show();
  };
}
