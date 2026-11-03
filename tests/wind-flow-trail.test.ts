/* eslint-disable @typescript-eslint/no-explicit-any */
// The streamline trail length follows the source that answered the fetch.
// NDFD's trails are cut to a third for its 2.5 km grid; an NDFD config
// outside the US gets AICON's ~28 km grid, which needs full-length trails.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  const DomUtil = { create: vi.fn(() => ({ style: {} })), setPosition: vi.fn() };
  return { DomUtil, default: { DomUtil } };
});

import { WindFlowOverlay } from '../src/wind-flow-overlay';
import { windGridFetcher, type WindGrid } from '../src/wind-grid-fetcher';

const grid: WindGrid = { rows: 1, cols: 1, latMin: 0, lonMin: 0, step: 1, cells: [[{ u: 1, v: 1 }]] };

function flowAt(source: 'ndfd_wind' | 'dwd_aicon', b: { s: number; w: number; n: number; e: number }): any {
  const o = Object.create(WindFlowOverlay.prototype);
  o._source = source;
  o._gridSource = source;
  o._timeIso = null;
  o._map = {
    getBounds: () => ({ getSouth: () => b.s, getWest: () => b.w, getNorth: () => b.n, getEast: () => b.e }),
  };
  return o;
}
const europe = { s: 48, w: 8, n: 52, e: 14 };
const kansas = { s: 37, w: -100, n: 40, e: -96 };

describe('WindFlowOverlay trail length', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an NDFD config outside the US draws AICON-length trails', async () => {
    vi.spyOn(windGridFetcher, 'fetch').mockResolvedValue(grid);
    const ndfd = flowAt('ndfd_wind', europe);
    const aicon = flowAt('dwd_aicon', europe);
    await ndfd._fetchGrid();
    await aicon._fetchGrid();
    expect(ndfd._drawSegmentCount()).toBe(aicon._drawSegmentCount());
  });

  it('an NDFD config inside the US keeps its shorter trails', async () => {
    vi.spyOn(windGridFetcher, 'fetch').mockResolvedValue(grid);
    const ndfd = flowAt('ndfd_wind', kansas);
    const aicon = flowAt('dwd_aicon', kansas);
    await ndfd._fetchGrid();
    await aicon._fetchGrid();
    expect(ndfd._drawSegmentCount()).toBeLessThan(aicon._drawSegmentCount());
  });
});
