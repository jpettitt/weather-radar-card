// Tests for the initial radar-load ordering fix (issue #246): "now" loads
// first, then forward through any forecast frames, then backward through
// any past frames — instead of always loading the highest array index
// first, which for a forecast-heavy config (little/no past_minutes) meant
// loading the farthest-future frame before "now".
//
// Follows the "stub Leaflet, test the helpers" convention.

import { describe, it, expect } from 'vitest';

// Stub Leaflet — radar-player imports it eagerly (and pulls in
// fetch-tile-layer, which extends L.TileLayer / L.TileLayer.WMS at
// class-definition time), but buildLoadOrder/insertSorted are pure and
// never touch any L.* API.
import { vi } from 'vitest';
vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  (TileLayer as any).WMS = WMS;
  return { TileLayer, default: { TileLayer } };
});

/* eslint-disable @typescript-eslint/no-explicit-any */

import { buildLoadOrder, insertSorted } from '../src/radar-player';

describe('buildLoadOrder', () => {
  it('past-only config (nowIndex = frameCount-1): matches the old descending order', () => {
    expect(buildLoadOrder(5, 4)).toEqual([4, 3, 2, 1, 0]);
  });

  it('forecast-only config (nowIndex = 0): ascending order, now first', () => {
    expect(buildLoadOrder(5, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it('mixed config (nowIndex in the middle): back through history, then the forecast', () => {
    // History is usually cached and the forecast isn't, and frames load one
    // at a time — forecast-first held a cached loop behind the network (#279).
    expect(buildLoadOrder(6, 2)).toEqual([2, 1, 0, 3, 4, 5]);
  });

  it('single-frame config', () => {
    expect(buildLoadOrder(1, 0)).toEqual([0]);
  });

  it('clamps an out-of-range nowIndex into [0, frameCount-1]', () => {
    expect(buildLoadOrder(4, 99)).toEqual([3, 2, 1, 0]);
    expect(buildLoadOrder(4, -5)).toEqual([0, 1, 2, 3]);
  });

  it('always produces a permutation of 0..frameCount-1', () => {
    const order = buildLoadOrder(7, 3);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('insertSorted', () => {
  it('inserts into an empty array', () => {
    const arr: number[] = [];
    expect(insertSorted(arr, 5)).toBe(0);
    expect(arr).toEqual([5]);
  });

  it('inserts at the start', () => {
    const arr = [3, 5, 7];
    expect(insertSorted(arr, 1)).toBe(0);
    expect(arr).toEqual([1, 3, 5, 7]);
  });

  it('inserts in the middle', () => {
    const arr = [1, 3, 7];
    expect(insertSorted(arr, 5)).toBe(2);
    expect(arr).toEqual([1, 3, 5, 7]);
  });

  it('inserts at the end', () => {
    const arr = [1, 3, 5];
    expect(insertSorted(arr, 7)).toBe(3);
    expect(arr).toEqual([1, 3, 5, 7]);
  });

  it('duplicate values insert before existing equal entries (stable low-index rule)', () => {
    const arr = [1, 3, 3, 5];
    expect(insertSorted(arr, 3)).toBe(1);
    expect(arr).toEqual([1, 3, 3, 3, 5]);
  });

  it('building an array via repeated insertSorted stays sorted regardless of insertion order', () => {
    const arr: number[] = [];
    [4, 1, 3, 0, 2].forEach((v) => insertSorted(arr, v));
    expect(arr).toEqual([0, 1, 2, 3, 4]);
  });
});
