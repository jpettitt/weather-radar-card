// WildfireLayer.clear() while a fire popup is open and a render waits for
// popupclose: removing the layers closed the popup, the deferred render drew
// new fire layers inside clear(), and they stayed on the map, clickable,
// with the overlay toggled off. Real Leaflet map + real WildfireLayer.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as L from 'leaflet';
import { WildfireLayer } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeAll(() => {
  const ctx: any = new Proxy({}, { get: (_t, p) => (p === 'canvas' ? undefined : () => undefined), set: () => true });
  (HTMLCanvasElement.prototype as any).getContext = () => ctx;
  // InciWeb lookup on popupopen: never answers, irrelevant here.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

const box = (w: number, s: number, e: number, n: number): GeoJSON.Polygon =>
  ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

function makeMap(): L.Map {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 600 });
  Object.defineProperty(el, 'clientHeight', { value: 400 });
  document.body.appendChild(el);
  return L.map(el).setView([40, -100], 7, { animate: false });
}

function fireLayersOnMap(map: L.Map): number {
  let n = 0;
  map.eachLayer((l: any) => { if (l.feature?.properties?.poly_IncidentName || l.options?.icon?.options?.className === 'wildfire-icon') n++; });
  return n;
}

const cfg = () => ({ type: 'custom:weather-radar-card' } as any);

describe('WildfireLayer.clear() with a deferred popupclose render', () => {
  it('perimeter popup: no fire layer is left on the map after clear()', () => {
    const map = makeMap();
    const fires: any = new WildfireLayer(map, cfg, undefined);
    fires._features = [{ type: 'Feature', id: '1', properties: { poly_IncidentName: 'Big' }, geometry: box(-100.2, 39.8, -99.8, 40.2) }];
    fires._render();
    expect(fireLayersOnMap(map)).toBe(1);
    const path: any = fires._polygonLayer.getLayers()[0];
    path.openPopup();
    expect(path.isPopupOpen()).toBe(true);
    // What _fetchDetail / _showDetail do when an outline lands while the popup is open.
    fires._renderUnlessPopupOpen();
    expect(fires._renderOnPopupClose).toBe(true);
    // Layer toggle off -> card._stopOverlay('wildfires') -> clear().
    fires.clear();
    expect(fireLayersOnMap(map)).toBe(0);
  });

  it('icon popup: no fire layer is left on the map after clear()', () => {
    const map = makeMap();
    const fires: any = new WildfireLayer(map, cfg, undefined);
    // Tiny fire at zoom 7 -> drawn as an icon.
    fires._features = [{ type: 'Feature', id: '2', properties: { poly_IncidentName: 'Small' }, geometry: box(-100.001, 39.999, -99.999, 40.001) }];
    fires._render();
    expect(fires._iconLayer).toBeTruthy();
    const marker: any = fires._iconLayer.getLayers()[0];
    marker.openPopup();
    expect(marker.isPopupOpen()).toBe(true);
    fires._renderUnlessPopupOpen();
    fires.clear();
    expect(fireLayersOnMap(map)).toBe(0);
  });
});

describe('control: same steps without the deferred render', () => {
  it('clear() with a popup open but no deferred render leaves nothing', () => {
    const map = makeMap();
    const fires: any = new WildfireLayer(map, cfg, undefined);
    fires._features = [{ type: 'Feature', id: '1', properties: { poly_IncidentName: 'Big' }, geometry: box(-100.2, 39.8, -99.8, 40.2) }];
    fires._render();
    fires._polygonLayer.getLayers()[0].openPopup();
    fires.clear();
    expect(fireLayersOnMap(map)).toBe(0);
  });
});
