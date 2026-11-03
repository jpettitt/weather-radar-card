// Alert polygons and fire perimeters share one canvas renderer, whose draw
// list is also its tap order (the last path that contains the point wins).
// Fire perimeters stay above the alerts whichever layer rebuilt last, on a
// real Leaflet map and canvas renderer.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as L from 'leaflet';
import { sharedCanvasRenderer } from '../src/shared-canvas-renderer';
import { NwsAlertsLayer } from '../src/nws-alerts-layer';
import { WildfireLayer } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeAll(() => {
  // happy-dom has no 2D context; a no-op one lets Leaflet's real Canvas renderer run.
  const ctx: any = new Proxy({}, { get: (_t, p) => (p === 'canvas' ? undefined : () => undefined), set: () => true });
  (HTMLCanvasElement.prototype as any).getContext = () => ctx;
});

const box = (w: number, s: number, e: number, n: number): GeoJSON.Polygon =>
  ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

/** Names of the paths in the renderer's draw list, bottom to top. */
function drawOrder(r: any): string[] {
  const out: string[] = [];
  for (let o = r._drawFirst; o; o = o.next) out.push(o.layer.feature?.properties?.name ?? '?');
  return out;
}

/** Name of the path a tap at the map centre opens. */
function tapAtCentre(r: any): string | undefined {
  const fired = vi.spyOn(r, '_fireEvent');
  r._onClick({ type: 'click', clientX: 300, clientY: 200, target: r._container, srcElement: r._container });
  const hit = (fired.mock.calls[0]?.[0] as any)?.[0]?.feature?.properties?.name;
  fired.mockRestore();
  return hit;
}

describe('shared canvas order: alerts and fire perimeters', () => {
  it('keeps the fire perimeter on top, and the alerts in severity order, whichever layer rebuilt last', async () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 600 });
    Object.defineProperty(el, 'clientHeight', { value: 400 });
    document.body.appendChild(el);
    const map = L.map(el).setView([40, -100], 7, { animate: false });
    const r: any = sharedCanvasRenderer(map);
    const cfg = () => ({ type: 'custom:weather-radar-card' } as any);

    const alerts: any = new NwsAlertsLayer(map, cfg, undefined);
    // Paint order (severity ascending): the warning draws over the advisory.
    alerts._features = [
      { type: 'Feature', id: 'adv', properties: { name: 'advisory', event: 'Wind Advisory', severity: 'Moderate' }, geometry: box(-103, 37, -97, 43) },
      { type: 'Feature', id: 'rfw', properties: { name: 'red flag', event: 'Red Flag Warning', severity: 'Severe' }, geometry: box(-102, 38, -98, 42) },
    ];
    alerts._render({ skipIfDecisionsUnchanged: true });

    // ~36 px across at zoom 7: drawn as a perimeter, not an icon.
    const fires: any = new WildfireLayer(map, cfg, undefined);
    fires._features = [{ type: 'Feature', id: 'fire', properties: { name: 'fire', poly_IncidentName: 'Test' }, geometry: box(-100.2, 39.8, -99.8, 40.2) }];
    fires._render();
    expect(drawOrder(r)).toEqual(['advisory', 'red flag', 'fire']);

    // A zoom across a level changes every alert's `|z<lod>` decision, so the alerts layer rebuilds.
    map.setZoom(8, { animate: false });
    alerts._render({ skipIfDecisionsUnchanged: true });
    expect(drawOrder(r)).toEqual(['advisory', 'red flag', 'fire']);
    expect(tapAtCentre(r)).toBe('fire');

    // And a wildfire rebuild after it.
    fires._render();
    expect(drawOrder(r)).toEqual(['advisory', 'red flag', 'fire']);
    expect(tapAtCentre(r)).toBe('fire');
    // Let the queued canvas redraw run first: under happy-dom it otherwise runs after remove and throws.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    map.remove();
  });
});
