import * as L from 'leaflet';

// Runs `cb` once the map has been still for MAP_QUIET_MS after a move or
// zoom. Leaflet's own moveend lands while the end of a gesture is still
// being composited (the snap-back of an over-zoomed pinch runs a 250 ms
// transform transition on every zoom-animated element), and a hazard
// overlay's rebuild on that same dispatch, plus a large canvas coming back
// into the page, crashed Safari on an iPhone (2026-10-16). Armed by
// moveend/zoomend, cancelled by anything that moves the map again.
export const MAP_QUIET_MS = 1000;

export function onMapQuiet(map: L.Map, cb: () => void, quietMs = MAP_QUIET_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const arm = (): void => {
    cancel();
    timer = setTimeout(() => { timer = null; cb(); }, quietMs);
  };
  map.on('movestart zoomstart move zoom', cancel);
  map.on('moveend zoomend', arm);
  return () => {
    cancel();
    map.off('movestart zoomstart move zoom', cancel);
    map.off('moveend zoomend', arm);
  };
}
