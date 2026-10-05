import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  (TileLayer as any).WMS = WMS;
  return { TileLayer, default: { TileLayer } };
});

import { pickRadarTileSize } from '../src/radar-player';

describe('pickRadarTileSize', () => {
  it('never goes below 512 px, even for a map that has not been laid out yet (#279)', () => {
    expect(pickRadarTileSize(0)).toEqual({ size: 512, zoomOffset: -1 });
    expect(pickRadarTileSize(300)).toEqual({ size: 512, zoomOffset: -1 });
    expect(pickRadarTileSize(600)).toEqual({ size: 512, zoomOffset: -1 });
  });

  it('keeps 512 up to and including 1200 px', () => {
    expect(pickRadarTileSize(601)).toEqual({ size: 512, zoomOffset: -1 });
    expect(pickRadarTileSize(1200)).toEqual({ size: 512, zoomOffset: -1 });
  });

  it('steps up to 1024 and 2048 on large maps', () => {
    expect(pickRadarTileSize(1201)).toEqual({ size: 1024, zoomOffset: -2 });
    expect(pickRadarTileSize(2400)).toEqual({ size: 1024, zoomOffset: -2 });
    expect(pickRadarTileSize(2401)).toEqual({ size: 2048, zoomOffset: -3 });
  });

  it('pairs each size with the zoomOffset that keeps on-screen scale constant', () => {
    for (const px of [100, 900, 1500, 3000]) {
      const { size, zoomOffset } = pickRadarTileSize(px);
      expect(size).toBe(256 * 2 ** -zoomOffset);
    }
  });
});
