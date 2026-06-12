// NOAA opengeo frame-list discovery: GetCapabilities time-dimension
// parsing and ideal-grid-to-listing snapping. This replaced the blind
// 10-min grid + 15-min lag of the eventdriven server (whose metadata
// refused browsers) — frame times now come from the server's own
// listing, so every frame is real and unique by construction.

import { describe, it, expect } from 'vitest';
import { parseTimeDimension, pickFrameTimes } from '../src/noaa-frame-list';
import { getEffectiveTimeRange } from '../src/source-caps';

const dim = (content: string, tag = 'Dimension'): string =>
  `<WMS_Capabilities><Layer><${tag} name="time" units="ISO8601" default="x">${content}</${tag}></Layer></WMS_Capabilities>`;

describe('parseTimeDimension', () => {
  it('parses the discrete CSV list form into sorted epoch seconds', () => {
    const xml = dim('2026-06-12T13:58:05.000Z,2026-06-12T13:54:17.000Z,2026-06-12T14:00:10.000Z');
    expect(parseTimeDimension(xml)).toEqual([
      Date.parse('2026-06-12T13:54:17Z') / 1000,
      Date.parse('2026-06-12T13:58:05Z') / 1000,
      Date.parse('2026-06-12T14:00:10Z') / 1000,
    ]);
  });

  it('accepts the WMS 1.1.1 Extent form too', () => {
    const xml = dim('2026-06-12T14:00:10.000Z', 'Extent');
    expect(parseTimeDimension(xml)).toHaveLength(1);
  });

  it('returns [] for the interval form rather than synthesising a grid', () => {
    // Expanding start/end/period would reintroduce guessed timestamps —
    // exactly what this module exists to remove. Caller falls back.
    const xml = dim('2026-06-12T12:00:00Z/2026-06-12T14:00:00Z/PT2M');
    expect(parseTimeDimension(xml)).toEqual([]);
  });

  it('returns [] when no time dimension is present or values are garbage', () => {
    expect(parseTimeDimension('<WMS_Capabilities></WMS_Capabilities>')).toEqual([]);
    expect(parseTimeDimension(dim('not-a-date,also-not'))).toEqual([]);
  });
});

describe('pickFrameTimes', () => {
  // Listing every 2 min from t0, slightly irregular like the real server.
  const t0 = Date.parse('2026-06-12T12:00:00Z') / 1000;
  const listed = Array.from({ length: 60 }, (_, i) => t0 + i * 120 + (i % 3) * 7);

  it('anchors at the newest listed time', () => {
    const out = pickFrameTimes(listed, 60, 5);
    expect(out[out.length - 1]).toBe(listed[listed.length - 1]);
  });

  it('honours the past window at the requested stride (60 min / 5 min ≈ 13 frames)', () => {
    const out = pickFrameTimes(listed, 60, 5);
    expect(out.length).toBe(13);
    const newest = out[out.length - 1];
    const oldest = out[0];
    // Window ≈ 60 min, allow snap slop of one native step.
    expect(newest - oldest).toBeGreaterThanOrEqual(60 * 60 - 150);
    expect(newest - oldest).toBeLessThanOrEqual(60 * 60 + 150);
  });

  it('every returned time is one the server listed', () => {
    const set = new Set(listed);
    for (const t of pickFrameTimes(listed, 120, 2)) expect(set.has(t)).toBe(true);
  });

  it('collapses duplicate snaps when stride is finer than the listing', () => {
    // Sparse listing (10-min spacing) with a 2-min stride: adjacent
    // ideal slots snap to the same scan and must dedupe.
    const sparse = Array.from({ length: 7 }, (_, i) => t0 + i * 600);
    const out = pickFrameTimes(sparse, 60, 2);
    expect(out).toEqual(sparse);   // no duplicates, all 7 distinct scans
  });

  it('returns [] for an empty listing', () => {
    expect(pickFrameTimes([], 60, 5)).toEqual([]);
  });
});

describe('getEffectiveTimeRange with stride choices (NOAA)', () => {
  const base = { type: 'custom:weather-radar-card' } as any;

  it('defaults to the 5-min stride', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'NOAA' });
    expect(r.strideMin).toBe(5);
    expect(r.frameCount).toBe(13);   // 60 min default past / 5 + 1
  });

  it('accepts each offered choice', () => {
    for (const s of [2, 5, 10]) {
      const r = getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: s });
      expect(r.strideMin).toBe(s);
    }
  });

  it('snaps an off-menu YAML stride to the nearest choice', () => {
    expect(getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: 4 }).strideMin).toBe(5);
    expect(getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: 1 }).strideMin).toBe(2);
    expect(getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: 60 }).strideMin).toBe(10);
  });

  it('leaves grid sources (DWD multiple-of-native) behaviour unchanged', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'DWD', frame_stride_minutes: 15 });
    expect(r.strideMin).toBe(15);   // 3 × native 5
    const r2 = getEffectiveTimeRange({ ...base, data_source: 'DWD', frame_stride_minutes: 3 });
    expect(r2.strideMin).toBe(5);   // below native → native
  });
});
