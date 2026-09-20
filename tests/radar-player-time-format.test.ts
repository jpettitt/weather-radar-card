// Tests for _getTimeString's hass.locale.time_format support (issue #239).
//
// The browser's ambient locale is an unreliable signal for 12h/24h:
// many users run an en-US browser/OS language regardless of where they
// live, and even an explicit OS 24-hour override often isn't honoured by
// Intl's locale resolution. When hass/locale is available, the timeline
// timestamp defers to HA's own time_format setting (Settings > General)
// via custom-card-helpers' formatTime instead.
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

function makePlayer(hass: any): RadarPlayer {
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
    getConfig: () => ({ type: 'custom:weather-radar-card' } as WeatherRadarCardConfig),
    getHass: () => hass,
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

// 15:00 local time in a fixed, unambiguous instant.
const AFTERNOON_MS = new Date('2026-08-20T15:00:00').getTime();

describe('_getTimeString time_format handling', () => {
  it('without hass, falls back to the previous browser-locale behaviour (no throw, produces a time)', () => {
    const p = makePlayer(undefined) as any;
    const result = p._getTimeString(AFTERNOON_MS);
    expect(typeof result.time).toBe('string');
    expect(result.time.length).toBeGreaterThan(0);
  });

  it('hass.locale.time_format: "24" never renders AM/PM', () => {
    const hass = { locale: { language: 'en', number_format: 'language', time_format: '24' } };
    const p = makePlayer(hass) as any;
    const result = p._getTimeString(AFTERNOON_MS);
    expect(result.time).not.toMatch(/AM|PM/i);
  });

  it('hass.locale.time_format: "12" renders AM/PM', () => {
    const hass = { locale: { language: 'en', number_format: 'language', time_format: '12' } };
    const p = makePlayer(hass) as any;
    const result = p._getTimeString(AFTERNOON_MS);
    expect(result.time).toMatch(/AM|PM/i);
  });

  it('hass.locale.time_format: "system" derives from the runtime default locale, not language', () => {
    // en locale would normally imply 12h, but "system" ignores language
    // and asks Date#toLocaleString(undefined) whether AM/PM appears —
    // this just needs to run without throwing and produce a time string,
    // since the actual answer depends on the test runner's own locale.
    const hass = { locale: { language: 'en', number_format: 'language', time_format: 'system' } };
    const p = makePlayer(hass) as any;
    const result = p._getTimeString(AFTERNOON_MS);
    expect(typeof result.time).toBe('string');
    expect(result.time.length).toBeGreaterThan(0);
  });

  it('the date part is unaffected by time_format (still weekday/day/month)', () => {
    const hass24 = { locale: { language: 'en', number_format: 'language', time_format: '24' } };
    const hass12 = { locale: { language: 'en', number_format: 'language', time_format: '12' } };
    const result24 = (makePlayer(hass24) as any)._getTimeString(AFTERNOON_MS);
    const result12 = (makePlayer(hass12) as any)._getTimeString(AFTERNOON_MS);
    expect(result24.date).toBe(result12.date);
    expect(result24.date.length).toBeGreaterThan(0);
  });
});
