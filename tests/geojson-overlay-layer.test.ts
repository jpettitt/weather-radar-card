import { afterEach, describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';
import {
  GeoJsonOverlayLayer, enabledGeoJsonSources, colorForFeature, buildPopupHtml, isGeoJsonSourceRelevant,
  _resetGeoJsonOverlayCacheForTests,
} from '../src/geojson-overlay-layer';

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetGeoJsonOverlayCacheForTests();
  document.body.replaceChildren();
});

describe('GeoJsonOverlayLayer', () => {
  const ridgeSource = {
    id: 'ridge_to_rivers',
    name: 'Trail Conditions',
    url: 'https://example.invalid/trails.geojson',
    color_property: 'Condition',
    color_map: {
      'Dry / Tacky - Enjoy': '#2e7d32',
      'Muddy – DO NOT USE': '#c62828',
    },
    fallback_color: '#6b7280',
    popup_fields: ['TrailName', 'Condition', 'ConditionDate', 'ConditionNotes', 'TrailSubSystem'],
    date_properties: ['ConditionDate'],
    attribution: 'Ridge to Rivers',
  };

  it('uses a mapped property colour and a neutral fallback', () => {
    expect(colorForFeature({ Condition: 'Dry / Tacky - Enjoy' }, ridgeSource)).toBe('#2e7d32');
    expect(colorForFeature({ Condition: 'Unknown' }, ridgeSource)).toBe('#6b7280');
    expect(colorForFeature({}, ridgeSource)).toBe('#6b7280');
  });

  it('builds an escaped popup with configured date fields and attribution', () => {
    const popup = buildPopupHtml({
      TrailName: '<img src=x onerror=alert(1)>',
      Condition: 'Muddy – DO NOT USE',
      ConditionDate: 1710928070000,
      ConditionNotes: 'Turn around <script>alert(1)</script>',
      TrailSubSystem: 'Camels Back / Hulls Gulch',
    }, ridgeSource);

    expect(popup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(popup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(popup).toContain('2024');
    expect(popup).toContain('Source: Ridge to Rivers');
  });

  it('keeps overlays off until the dashboard explicitly enables them', () => {
    expect(enabledGeoJsonSources([
      { id: 'off', name: 'Off', url: 'https://example.invalid/off.geojson' },
      { id: 'on', name: 'On', url: 'https://example.invalid/on.geojson', enabled: true },
    ])).toEqual([
      { id: 'on', name: 'On', url: 'https://example.invalid/on.geojson', enabled: true },
    ]);
  });

  it('only considers a bounded source relevant near its configured area and zoom', () => {
    const map = makeMap();
    const source = {
      id: 'boise', name: 'Boise', url: 'https://example.invalid/boise.geojson',
      bounds: [-116.32, 43.53, -115.97, 43.81] as [number, number, number, number], min_zoom: 9,
    };
    expect(isGeoJsonSourceRelevant(map, source)).toBe(true);
    map.setView([45.0, -114.0], 10, { animate: false });
    expect(isGeoJsonSourceRelevant(map, source)).toBe(false);
    map.setView([43.7, -116.2], 8, { animate: false });
    expect(isGeoJsonSourceRelevant(map, source)).toBe(false);
    map.remove();
  });

  it('hides a bounded source after the map leaves its relevant area', async () => {
    const map = makeMap();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(TRAILS), { status: 200 })));
    const layer = new GeoJsonOverlayLayer(map, () => ({
      id: 'bounded', name: 'Bounded', url: 'https://example.invalid/bounded.geojson',
      bounds: [-116.32, 43.53, -115.97, 43.81], min_zoom: 9,
    }));
    await layer.start();
    map.setView([45.0, -114.0], 10, { animate: false });
    map.fire('moveend');

    const mapLayers: L.Layer[] = [];
    map.eachLayer((parent) => mapLayers.push(parent));
    expect(mapLayers.some((parent) => parent instanceof L.GeoJSON)).toBe(false);
    layer.clear();
    map.remove();
  });

  it('reuses a successful source cache when an overlay is toggled back on', async () => {
    const map = makeMap();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(TRAILS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const source = { id: 'cached', name: 'Cached', url: 'https://example.invalid/cached.geojson' };

    const first = new GeoJsonOverlayLayer(map, () => source);
    await first.start();
    first.clear();
    const second = new GeoJsonOverlayLayer(map, () => source);
    await second.start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    second.clear();
    map.remove();
  });

  it('refreshes at the configured interval and preserves rendered data when refresh fails', async () => {
    vi.useFakeTimers();
    const map = makeMap();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(TRAILS), { status: 200 }))
      .mockRejectedValueOnce(new Error('service unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const layer = new GeoJsonOverlayLayer(map, () => ({
      id: 'refreshing', name: 'Refreshing', url: 'https://example.invalid/refresh.geojson', refresh_minutes: 1,
    }));

    await layer.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const mapLayers: L.Layer[] = [];
    map.eachLayer((parent) => mapLayers.push(parent));
    expect(mapLayers.some((parent) => parent instanceof L.GeoJSON)).toBe(true);
    layer.clear();
    map.remove();
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
