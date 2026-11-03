// Tiles are positioned with left/top instead of Leaflet's translate3d, so
// each tile is not its own compositing layer: on WebKit every such layer
// carried a device-resolution buffer, 11.8 MB per radar tile on a 3x
// phone, and iOS killed the page at its 2 GB limit (2026-10-16).

import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  class GridLayer {}
  return { TileLayer: Object.assign(TileLayer, { WMS }), GridLayer, default: { TileLayer: Object.assign(TileLayer, { WMS }), GridLayer } };
});

import { flattenTile, wireFlatTiles, wireAbortLifecycle } from '../src/fetch-tile-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('flattenTile', () => {
  it('replaces the translate3d Leaflet set with left/top from the stored position', () => {
    const tile = document.createElement('img') as any;
    tile._leaflet_pos = { x: 512, y: -256 };
    tile.style.transform = 'translate3d(512px, -256px, 0px)';
    flattenTile(tile);
    expect(tile.style.transform).toBe('');
    expect(tile.style.left).toBe('512px');
    expect(tile.style.top).toBe('-256px');
  });

  it('leaves a tile Leaflet has not positioned alone', () => {
    const tile = document.createElement('img') as any;
    tile.style.transform = 'translate3d(1px, 2px, 0px)';
    flattenTile(tile);
    expect(tile.style.transform).toBe('translate3d(1px, 2px, 0px)');
    expect(tile.style.left).toBe('');
  });
});

describe('wireFlatTiles', () => {
  it('flattens each tile on tileloadstart, which Leaflet fires after positioning it', () => {
    const listeners = new Map<string, (e: any) => void>();
    const layer: any = { on: vi.fn((ev: string, fn: (e: any) => void) => { listeners.set(ev, fn); }) };
    wireFlatTiles(layer);
    const tile = document.createElement('img') as any;
    tile._leaflet_pos = { x: 0, y: 1024 };
    tile.style.transform = 'translate3d(0px, 1024px, 0px)';
    listeners.get('tileloadstart')!({ tile });
    expect(tile.style.transform).toBe('');
    expect(tile.style.top).toBe('1024px');
  });

  it('is part of the fetch layers\' lifecycle wiring', () => {
    const layer: any = { on: vi.fn(), _tiles: {} };
    wireAbortLifecycle(layer);
    expect(layer.on).toHaveBeenCalledWith('tileloadstart', expect.any(Function));
  });
});
