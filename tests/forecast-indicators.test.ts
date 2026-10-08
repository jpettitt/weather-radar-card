// Forecast and stale-data cues (#279, 3.12): forecast segments are hatched,
// forecast frames say how far ahead they are, a cached forecast says it's
// updating, and old data says how old it is.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { RadarPlayer, relativeTimeText } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW = Math.floor(Date.now() / 60_000) * 60; // seconds, on a whole minute

function makePlayer(cfg: Partial<WeatherRadarCardConfig>): any {
  const els: Record<string, HTMLElement> = {
    'div-progress-track': document.createElement('div'),
    timestamp: document.createElement('div'),
  };
  const p = new RadarPlayer({
    map: {
      on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
      getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
      getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    } as any,
    shadowRoot: { getElementById: (id: string) => els[id] ?? null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  }) as any;
  p._els = els;
  return p;
}

// Five frames 10 min apart, "now" in the middle.
function seed(p: any): void {
  p._configFrameCount = 5;
  p._radarPaths = [-20, -10, 0, 10, 25].map((m) => ({ time: NOW + m * 60, path: '' }));
  p._radarTime = p._radarPaths.map(() => ({ date: 'Wed', time: '10:00' }));
  p._nowFrameIndex = 2;
}

const hatched = (p: any): boolean[] => p._segEls.map((s: HTMLElement) => s.style.backgroundImage.includes('repeating-linear-gradient'));
const stamp = (p: any, fi: number): string => { p._setTimestamp(fi); return p._els.timestamp.textContent; };

describe('progress bar', () => {
  it('hatches only the segments after "now"', () => {
    const p = makePlayer({ data_source: 'DWD' });
    seed(p);
    p._buildSegments();
    expect(hatched(p)).toEqual([false, false, false, true, true]);
  });

  it('moves the hatching when "now" moves, and keeps it through status repaints', () => {
    const p = makePlayer({ data_source: 'DWD' });
    seed(p);
    p._buildSegments();
    p._nowFrameIndex = 3;
    p._applyNowMarker();
    expect(hatched(p)).toEqual([false, false, false, false, true]);
    p._setSegment(4, 'loaded');
    expect(hatched(p)[4]).toBe(true);
  });
});

describe('timestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it('says how far back or ahead every frame is', () => {
    const p = makePlayer({ data_source: 'DWD' });
    seed(p);
    p._dwdLatestRun = NOW - 300;
    expect(stamp(p, 0)).toBe('Wed 10:00 · 20 minutes ago');
    expect(stamp(p, 2)).toBe('Wed 10:00 (latest)');
    expect(stamp(p, 3)).toBe('Wed 10:00 · Forecast · in 10 minutes');
  });

  it('marks the clock time optional only when a relative label replaces it', () => {
    // Narrow cards hide .ts-time-optional and .ts-sep, leaving the label.
    const p = makePlayer({ data_source: 'DWD' });
    seed(p);
    p._setTimestamp(1);
    expect(p._els.timestamp.querySelector('.ts-time')!.className).toBe('ts-time ts-time-optional');
    const q = makePlayer({ data_source: 'DWD', dwd_time_override: '2026-10-07T06:00:00Z' });
    seed(q);
    q._setTimestamp(1);
    expect(q._els.timestamp.querySelector('.ts-time')!.className).toBe('ts-time');
  });

  it('marks forecast frames as updating while a cached forecast is being replaced', () => {
    const p = makePlayer({ data_source: 'DWD' });
    seed(p);
    p._dwdLatestRun = NOW - 300;
    p._catchUpPending = true;
    expect(stamp(p, 4)).toBe('Wed 10:00 · Forecast · in 25 minutes · updating…');
    expect(stamp(p, 1)).toBe('Wed 10:00 · 10 minutes ago');
  });

  it("flags DWD data whose newest run is older than DWD ever lags", () => {
    const p = makePlayer({ data_source: 'DWD' });
    seed(p);
    p._dwdLatestRun = NOW - 14 * 60;
    expect(stamp(p, 1)).toBe('Wed 10:00 · 10 minutes ago');
    p._dwdLatestRun = NOW - 30 * 60;
    expect(stamp(p, 1)).toBe('Wed 10:00 · 10 minutes ago ⚠ 30 min old');
  });

  it('flags a listed source whose newest frame is overdue', () => {
    const p = makePlayer({ data_source: 'RainViewer' });
    seed(p);
    p._radarPaths = [-60, -50, -40].map((m) => ({ time: NOW + m * 60, path: '' }));
    p._nowFrameIndex = 2;
    expect(stamp(p, 0)).toBe('Wed 10:00 · 1:00 hours ago ⚠ 40 min old');
  });

  it('shows neither tag for a pinned-in-the-past loop (dwd_time_override)', () => {
    const p = makePlayer({ data_source: 'DWD', dwd_time_override: '2026-10-07T06:00:00Z' });
    seed(p);
    p._dwdLatestRun = NOW - 3 * 3600;
    expect(stamp(p, 3)).toBe('Wed 10:00');
  });
});

describe('relativeTimeText', () => {
  const MIN = 60_000;

  it("uses Intl's own phrase under an hour", () => {
    expect(relativeTimeText(-15 * MIN, 'en')).toBe('15 minutes ago');
    expect(relativeTimeText(25 * MIN, 'en')).toBe('in 25 minutes');
    expect(relativeTimeText(-20 * 1000, 'en')).toBe('1 minute ago');
  });

  it('puts h:mm into the plural-hours phrase from an hour up, whole hours included', () => {
    // No "1 hour ago" → "1:05 hours ago" jump as the loop crosses the hour.
    expect(relativeTimeText(-60 * MIN, 'en')).toBe('1:00 hours ago');
    expect(relativeTimeText(-80 * MIN, 'en')).toBe('1:20 hours ago');
    expect(relativeTimeText(-120 * MIN, 'de')).toBe('vor 2:00 Stunden');
    expect(relativeTimeText(80 * MIN, 'en')).toBe('in 1:20 hours');
    expect(relativeTimeText(-725 * MIN, 'en')).toBe('12:05 hours ago');
  });

  it("is worded in HA's language, as HA's own relative times are", () => {
    expect(relativeTimeText(-80 * MIN, 'de')).toBe('vor 1:20 Stunden');
    expect(relativeTimeText(80 * MIN, 'fr')).toBe('dans 1:20 heures');
    expect(relativeTimeText(-15 * MIN, 'sv')).toBe('för 15 minuter sedan');
  });

  it('falls back to English for a locale Intl rejects', () => {
    expect(relativeTimeText(-15 * MIN, 'not a locale!')).toBe('15 minutes ago');
  });
});
