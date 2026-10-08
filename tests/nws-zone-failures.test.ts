// Zone shapes are fetched all at once (api.weather.gov is HTTP/2, so a cold
// cache can mean hundreds of requests). Failures — a rate-limited burst fails
// many together — are logged as one error per batch, not one warning per zone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const layerGroup = vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn(), clearLayers: vi.fn() }));
  return { Layer, TileLayer, Control, layerGroup, default: { Layer, TileLayer, Control, layerGroup } };
});

import { NwsAlertsLayer } from '../src/nws-alerts-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZONE = (id: string): string => `https://api.weather.gov/zones/forecast/${id}`;

describe('NWS zone fetch failures', () => {
  const realFetch = global.fetch;
  let errors: unknown[][];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function layerWithAlert(zones: string[]): any {
    const layer = new NwsAlertsLayer({} as any, () => ({ type: 'custom:weather-radar-card' } as any)) as any;
    layer._features = [{ type: 'Feature', geometry: null, properties: { affectedZones: zones } }];
    layer._render = vi.fn();
    return layer;
  }

  it('logs one error for the batch, saying how many failed and hinting at rate limiting', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url === ZONE('OKZ001')) return new Response(JSON.stringify({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }));
      if (url === ZONE('OKZ002')) throw new TypeError('Failed to fetch');
      return new Response('gone', { status: 404 });
    }) as unknown as typeof fetch;
    const layer = layerWithAlert([ZONE('OKZ001'), ZONE('OKZ002'), ZONE('OKZ003')]);

    await layer._resolveZones();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain('2 of 3 zone requests failed');
    expect(String(errors[0][0])).toContain('rate-limiting');
    expect(layer._zoneCache.has(ZONE('OKZ001'))).toBe(true);
  });

  it('logs nothing when every zone arrives', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }))) as unknown as typeof fetch;
    const layer = layerWithAlert([ZONE('OKZ001'), ZONE('OKZ002')]);

    await layer._resolveZones();
    expect(errors).toEqual([]);
  });
});
