// dwd_interpolation (#326) relies on Leaflet's WMS layer turning an option it
// doesn't know into a GetMap query param. Checked on the real Leaflet, through
// FetchWmsTileLayer's internal-option split.

import { describe, it, expect } from 'vitest';
import * as L from 'leaflet';
import { FetchWmsTileLayer } from '../src/fetch-tile-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('interpolations on a real Leaflet WMS layer', () => {
  it('lands in the GetMap params, next to the internal options it must not leak', () => {
    const layer = new FetchWmsTileLayer('https://maps.dwd.de/geoserver/dwd/wms', {
      layers: 'Niederschlagsradar',
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      TIME: '2026-10-21T23:15:00Z',
      interpolations: 'bilinear',
      tileSize: 512,
      zoomOffset: -1,
      pixelFilter: () => {},
      tileCache: {},
    } as any) as any;
    const query = L.Util.getParamString(layer.wmsParams);
    expect(query).toContain('&interpolations=bilinear');
    expect(query).not.toContain('pixelFilter');
    expect(query).not.toContain('tileCache');
  });
});
