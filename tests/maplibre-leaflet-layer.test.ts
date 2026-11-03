// The ported Leaflet adapter, on a real Leaflet map. Only MapLibre is faked:
// it can't run without WebGL, and refusing a context is the case under test.

import { describe, it, expect, vi } from 'vitest';
import * as L from 'leaflet';
import { defineMaplibreLayer } from '../src/maplibre-leaflet-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const makeMap = (): L.Map => {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 400 });
  Object.defineProperty(el, 'clientHeight', { value: 300 });
  document.body.appendChild(el);
  return L.map(el, { zoomAnimation: false }).setView([50, 10], 6);
};

describe('MapLibre Leaflet layer', () => {
  it('leaves the map clean when the browser refuses a WebGL context', () => {
    const refusing = { Map: vi.fn(() => { throw new Error('Failed to initialize WebGL'); }) } as any;
    const map = makeMap();
    const layer = defineMaplibreLayer(L, refusing)({ style: {} });
    expect(() => layer.addTo(map)).toThrow('Failed to initialize WebGL');
    layer.remove();
    expect(map.hasLayer(layer)).toBe(false);
    // Its move handler would otherwise run on every pan, on a map it never built.
    expect(() => map.fire('move')).not.toThrow();
    expect(map.getPane('tilePane')!.querySelector('.leaflet-gl-layer')).toBeNull();
  });
});
