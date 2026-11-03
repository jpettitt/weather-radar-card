/* eslint-disable @typescript-eslint/no-explicit-any */
// A failed refresh kept the arrows' last grid but blanked the streamlines'
// grid, so streamlines went away until the next pan or 30 min tick.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  const DomUtil = {
    create: vi.fn(() => ({ style: {}, width: 0, height: 0, getContext: () => ctx, parentNode: null })),
    setPosition: vi.fn(),
  };
  return { DomUtil, default: { DomUtil } };
});

import { WindFlowOverlay } from '../src/wind-flow-overlay';
import { windGridFetcher } from '../src/wind-grid-fetcher';

afterEach(() => { vi.unstubAllGlobals(); windGridFetcher.clear(); vi.restoreAllMocks(); });

function fakeMap(): any {
  return {
    getBounds: () => ({ getSouth: () => 48, getWest: () => 8, getNorth: () => 52, getEast: () => 14 }),
  };
}

describe('wind streamlines on a failed refresh of the same view', () => {
  it('keeps the grid it already has, as the arrows overlay does', async () => {
    const o = Object.create(WindFlowOverlay.prototype);
    const good = { rows: 2, cols: 2, latMin: 48, lonMin: 8, step: 0.25, cells: [{ u: 1, v: 1 }] };
    Object.assign(o, { _map: fakeMap(), _source: 'dwd_aicon', _timeMs: null, _gen: 3, _grid: good });
    // Network edge: every request fails (outage / 5xx).
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await o._fetchGrid(3);
    expect(o._grid.rows).toBe(2);
  });
});
