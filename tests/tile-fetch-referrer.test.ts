import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  return {
    TileLayer: Object.assign(TileLayer, { WMS }),
    default: { TileLayer: Object.assign(TileLayer, { WMS }) },
  };
});

import { createFetchTile } from '../src/fetch-tile-layer';

// A cross-origin tile request sends the HA origin as Referer, not the
// dashboard path and query. It must send one: HA's page policy is
// no-referrer, and OSM answers a request with none with a "blocked" tile
// (measured 2026-10-27 in the testbed: x-blocked "No referer sent").
describe('tile fetch Referer', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('third-party tile request does not send the dashboard path/query as referrer', () => {
    (window as any).happyDOM.setURL('https://myha.example.org:8123/dashboard-security/cameras?edit=1');
    const inits: RequestInit[] = [];
    global.fetch = vi.fn((_u: string | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const layer = {
      getTileUrl: vi.fn(() => 'https://tile.openstreetmap.org/5/10/12.png'),
      options: { maxRetries: 1, retryDelay: 0 },
      _tilePending: 0, _tileFailed: 0, _tileLoaded: 0,
    };
    createFetchTile.call(layer as never, { x: 10, y: 12, z: 5 } as never, vi.fn());
    expect(inits.length).toBe(1);
    const init = inits[0];
    // The browser trims the referrer to the origin under this policy; without
    // an explicit one, HA's no-referrer page policy would send none.
    expect(init.referrerPolicy).toBe('strict-origin-when-cross-origin');
    expect(init.referrer).toBe(window.location.href);
  });
});
