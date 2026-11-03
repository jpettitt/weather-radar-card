import * as L from 'leaflet';
import { HAZARD_MARKER_PANE, Z_HAZARD_MARKERS } from './const';
import { hideElementWhileZooming } from './hide-while-zooming';

/**
 * The pane for wind arrows/barbs and fire icons, created on first use.
 * Out of Leaflet's markerPane so the place names can sit over them while
 * the user's own markers stay above the names (see const.ts).
 *
 * The pane leaves the page while the map zooms: Leaflet animates every
 * marker's transform on a zoom snap, and up to 400 wind barbs plus the
 * fire icons were part of what crashed Safari on an iPhone on a pinch
 * (see hide-while-zooming.ts). The user's own markers, in Leaflet's
 * markerPane, are few and stay.
 */
export function hazardMarkerPane(map: L.Map): string {
  if (!map.getPane(HAZARD_MARKER_PANE)) {
    map.createPane(HAZARD_MARKER_PANE).style.zIndex = String(Z_HAZARD_MARKERS);
    hideElementWhileZooming(map, () => map.getPane(HAZARD_MARKER_PANE));
  }
  return HAZARD_MARKER_PANE;
}
