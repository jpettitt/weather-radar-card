// Tests for user-configurable progress bar colors (issue #233).
//
// _segColor's "at rest" states (empty/loaded) are the cosmetic part of the
// palette a user would theme; loading/failed stay hardcoded since they
// signal real state (still fetching / fetch failed), not decoration.
//
// Follows the "stub Leaflet, test the helpers" convention.

import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(config: Partial<WeatherRadarCardConfig>): RadarPlayer {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 7,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  const shadowRoot = { getElementById: () => null, host: {} } as any;
  return new RadarPlayer({
    map,
    shadowRoot,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...config } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

describe('_segColor — progress_bar_background_color / progress_bar_active_color overrides', () => {
  it('with no overrides, falls back to the built-in light-map palette', () => {
    const p = makePlayer({}) as any;
    expect(p._segColor('empty', false)).toBe('#e0e0e0');
    expect(p._segColor('loaded', false)).toBe('#ccf2ff');
    expect(p._segColor('loaded', true)).toBe('#66d9ff');
  });

  it('greydark map_style gets the dark palette, same as dark/satellite', () => {
    const p = makePlayer({ map_style: 'greydark' }) as any;
    expect(p._segColor('empty', false)).toBe('#444');
    expect(p._segColor('loaded', true)).toBe('#6baed6');
  });

  it('grey map_style gets the light palette', () => {
    const p = makePlayer({ map_style: 'grey' }) as any;
    expect(p._segColor('empty', false)).toBe('#e0e0e0');
  });

  it('progress_bar_background_color overrides non-current empty/loaded segments', () => {
    const p = makePlayer({ progress_bar_background_color: '#123456' }) as any;
    expect(p._segColor('empty', false)).toBe('#123456');
    expect(p._segColor('loaded', false)).toBe('#123456');
  });

  it('progress_bar_background_color does not touch the current (playing) segment', () => {
    const p = makePlayer({ progress_bar_background_color: '#123456' }) as any;
    expect(p._segColor('loaded', true)).toBe('#66d9ff');
  });

  it('progress_bar_active_color overrides only the current segment\'s empty/loaded states', () => {
    const p = makePlayer({ progress_bar_active_color: '#abcdef' }) as any;
    expect(p._segColor('loaded', true)).toBe('#abcdef');
    expect(p._segColor('empty', true)).toBe('#abcdef');
    expect(p._segColor('loaded', false)).toBe('#ccf2ff');
  });

  it('loading/failed status colors are never overridden — they signal state, not theme', () => {
    const p = makePlayer({
      progress_bar_background_color: '#123456',
      progress_bar_active_color: '#abcdef',
    }) as any;
    expect(p._segColor('loading', false)).toBe('#ffcc00');
    expect(p._segColor('failed', false)).toBe('#ff4444');
    expect(p._segColor('loading', true)).toBe('#ffe566');
    expect(p._segColor('failed', true)).toBe('#ff8888');
  });

  it('both overrides can be set together and apply independently by current/non-current', () => {
    const p = makePlayer({
      progress_bar_background_color: '#111111',
      progress_bar_active_color: '#222222',
    }) as any;
    expect(p._segColor('empty', false)).toBe('#111111');
    expect(p._segColor('loaded', true)).toBe('#222222');
  });

  it('overrides apply the same regardless of map_style (dark/satellite palette bypassed)', () => {
    const p = makePlayer({ map_style: 'dark', progress_bar_background_color: '#123456' }) as any;
    expect(p._segColor('empty', false)).toBe('#123456');
  });
});

describe('_applyNowMarker — progress_bar_now_color override', () => {
  function seedNowMarker(config: Partial<WeatherRadarCardConfig>, nowFrameIndex: number) {
    const p = makePlayer(config) as any;
    const seg = { style: {} as Record<string, string>, title: '' };
    p._segEls = [seg];
    p._nowFrameIndex = nowFrameIndex;
    p._applyNowMarker();
    return seg;
  }

  it('defaults to the HA warning-color theme variable', () => {
    const seg = seedNowMarker({}, 0);
    expect(seg.style.boxShadow).toBe('inset 0 2px 0 0 var(--warning-color, #ff9800)');
  });

  it('progress_bar_now_color overrides the marker stripe color', () => {
    const seg = seedNowMarker({ progress_bar_now_color: '#00ff00' }, 0);
    expect(seg.style.boxShadow).toBe('inset 0 2px 0 0 #00ff00');
  });
});

describe('_segColor — follows the basemap actually drawn', () => {
  it('uses the dark palette when Auto resolves to a dark map', () => {
    const p = new RadarPlayer({
      map: {
        on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
        getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
        getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      } as any,
      shadowRoot: { getElementById: () => null, host: {} } as any,
      getConfig: () => ({ type: 'custom:weather-radar-card', map_style: 'Auto' } as WeatherRadarCardConfig),
      getMapStyle: () => 'dark',
      rainviewerLimiter: {} as any,
      noaaLimiter: {} as any,
      dwdLimiter: {} as any,
    }) as any;
    expect(p._segColor('empty', false)).toBe('#444');
  });
});
