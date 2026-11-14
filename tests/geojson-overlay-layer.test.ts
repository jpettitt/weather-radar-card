import { afterEach, describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';
import { GeoJsonOverlayLayer, enabledGeoJsonSources } from '../src/geojson-overlay-layer';

vi.mock('../src/shared-canvas-renderer', () => ({ sharedCanvasRenderer: () => undefined }));

const TRAILS: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 188052,
      properties: { TrailName: 'Mores Mountain Interpretive Trail' },
      geometry: {
        type: 'LineString',
        coordinates: [[-116.2, 43.7], [-116.19, 43.71]],
      },
    },
  ],
};

function makeMap(): L.Map {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 600 });
  Object.defineProperty(el, 'clientHeight', { value: 400 });
  document.body.appendChild(el);
  return L.map(el).setView([43.7, -116.2], 10, { animate: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('GeoJsonOverlayLayer', () => {
  it('keeps overlays off until the dashboard explicitly enables them', () => {
    expect(enabledGeoJsonSources([
      { id: 'off', name: 'Off', url: 'https://example.invalid/off.geojson' },
      { id: 'on', name: 'On', url: 'https://example.invalid/on.geojson', enabled: true },
    ])).toEqual([
      { id: 'on', name: 'On', url: 'https://example.invalid/on.geojson', enabled: true },
    ]);
  });

  it('fetches GeoJSON and draws its line features in the configured fixed colour', async () => {
    const map = makeMap();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(TRAILS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const layer = new GeoJsonOverlayLayer(map, () => ({
      id: 'ridge_to_rivers',
      name: 'Trail Conditions',
      url: 'https://example.invalid/trails.geojson',
      color: '#0055aa',
    }));

    await layer.start();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/trails.geojson',
      expect.objectContaining({ cache: 'no-cache' }),
    );
    const mapLayers: L.Layer[] = [];
    map.eachLayer((parent) => mapLayers.push(parent));
    const rendered = mapLayers
      .flatMap((parent) => parent instanceof L.GeoJSON ? parent.getLayers() : []) as L.Path[];
    expect(rendered).toHaveLength(1);
    expect(rendered[0].options.color).toBe('#0055aa');

    layer.clear();
    const afterClear: L.Layer[] = [];
    map.eachLayer((parent) => afterClear.push(parent));
    expect(afterClear.some((parent) => parent instanceof L.GeoJSON)).toBe(false);
    map.remove();
  });
});
