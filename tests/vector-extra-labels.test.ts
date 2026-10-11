// extra_labels on the vector map: the raster trick (tiles a zoom level
// higher at half size) has no counterpart in a style, so denserLabels moves
// each label kind a zoom level earlier (street names two), never before the
// tiles carry it, shrinks the text and packs it tighter.

import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  return { Layer, TileLayer, Control, default: { Layer, TileLayer, Control } };
});

import { denserLabels } from '../src/vector-basemap';
import { buildVectorStyle } from '../src/vector-styles';

/* eslint-disable @typescript-eslint/no-explicit-any */

const URLS = { base: '', glyphsPattern: '/api/map_tiles/fonts/{fontstack}/{range}.pbf', sprite: [{ id: 'base', url: '/static/map/sprites/base?v=2' }] };
const layer = (s: any, id: string): any => s.layers.find((l: any) => l.id === id);

describe('denserLabels', () => {
  const plain = buildVectorStyle('colorful', URLS);
  const dense = denserLabels(buildVectorStyle('colorful', URLS));

  it('draws each label kind a zoom level earlier, street names two, never before the tiles carry them', () => {
    expect(layer(dense, 'label-place-town').minzoom).toBe(layer(plain, 'label-place-town').minzoom - 1);   // 7 → 6
    expect(layer(dense, 'label-place-village').minzoom).toBe(10);        // the tiles have villages from 10
    expect(layer(dense, 'label-place-hamlet').minzoom).toBe(12);         // 13 → 12
    expect(layer(dense, 'label-street-residential').minzoom).toBe(10);   // 12 → 10
  });

  it('moves the text-size stops with the zoom and shrinks them by 15%', () => {
    expect(layer(plain, 'label-place-town').layout['text-size']).toEqual(['interpolate', ['linear'], ['zoom'], 8, 11, 12, 14]);
    expect(layer(dense, 'label-place-town').layout['text-size']).toEqual(['interpolate', ['linear'], ['zoom'], 7, 11 * 0.85, 11, 14 * 0.85]);
    expect(layer(dense, 'label-place-quarter').layout['text-size']).toBe(13 * 0.85);
  });

  it('packs labels tighter: padding 1, closer repeats along roads', () => {
    expect(layer(dense, 'label-place-town').layout['text-padding']).toBe(1);
    const street = layer(dense, 'label-street-residential');
    expect(street.layout['symbol-placement']).toBe('line');
    expect(street.layout['symbol-spacing']).toBe(Math.round((layer(plain, 'label-street-residential').layout['symbol-spacing'] ?? 250) * 0.6));
  });

  it('leaves everything that is not a label alone', () => {
    expect(layer(dense, 'street-primary')).toEqual(layer(plain, 'street-primary'));
    expect(layer(dense, 'land-forest')).toEqual(layer(plain, 'land-forest'));
  });

  it('leaves a text-size expression it does not understand as it is', () => {
    const style = { layers: [{ id: 'label-x', type: 'symbol', minzoom: 5, layout: { 'text-size': ['step', ['zoom'], 10, 12, 14] } }] };
    denserLabels(style);
    expect(style.layers[0].layout['text-size']).toEqual(['step', ['zoom'], 10, 12, 14]);
    expect(style.layers[0].minzoom).toBe(4);
  });
});
