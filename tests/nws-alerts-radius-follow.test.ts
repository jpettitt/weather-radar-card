// alerts_radius_km is measured from the map centre. It was applied at fetch
// time only, so a pan or a tracked marker moving the map did not bring a
// nearby warning in until the next fetch (up to 5 min with nothing in range).
import { describe, it, expect, vi, afterEach } from 'vitest';

const { built } = vi.hoisted(() => ({ built: [] as GeoJSON.Feature[][] }));
vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const geoJSON = vi.fn((features: GeoJSON.Feature[]) => {
    built.push(features);
    return { addTo: vi.fn(), on: vi.fn(), getLayers: () => [] };
  });
  const canvas = vi.fn(() => ({}));
  return { Layer, TileLayer, Control, geoJSON, canvas, default: { Layer, TileLayer, Control, geoJSON, canvas } };
});

import { NwsAlertsLayer } from '../src/nws-alerts-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; built.length = 0; });

describe('alerts_radius_km after the map centre moves', () => {
  it('shows a warning near the new centre without waiting for the next fetch', async () => {
    let centre = { lat: 35, lng: -97 };   // Oklahoma
    const map: any = {
      on: vi.fn(), off: vi.fn(), removeLayer: vi.fn(),
      getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
      getCenter: () => centre,
      getBounds: () => ({ pad: () => ({ getWest: () => -180, getSouth: () => -90, getEast: () => 180, getNorth: () => 90 }) }),
    };
    const layer: any = new NwsAlertsLayer(map, () => ({ type: 'custom:weather-radar-card', alerts_radius_km: 100 } as any), undefined);
    layer._scheduleNext = vi.fn();
    layer._resolveZones = vi.fn();
    // Network edge: one tornado warning near Dallas (~300 km from the first centre).
    const ends = new Date(Date.now() + 3600_000).toISOString();
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [{
      type: 'Feature', id: 'tw1',
      properties: { id: 'tw1', event: 'Tornado Warning', severity: 'Extreme', expires: ends, ends },
      geometry: { type: 'Polygon', coordinates: [[[-96.9, 32.7], [-96.7, 32.7], [-96.7, 32.9], [-96.9, 32.9], [-96.9, 32.7]]] },
    }] }))) as any;
    await layer._fetch();
    expect(layer._features).toHaveLength(0);     // out of radius: correct
    centre = { lat: 32.8, lng: -96.8 };          // tracked marker / pan / preset moves the map to Dallas
    layer._onMapQuiet();
    expect(layer._features.length).toBe(1);
    // And back out of range.
    centre = { lat: 35, lng: -97 };
    layer._onMapQuiet();
    expect(layer._features).toHaveLength(0);
  });
});
