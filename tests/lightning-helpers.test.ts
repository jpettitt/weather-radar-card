/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { HomeAssistant } from 'custom-card-helpers';
import {
  isBlitzortungLoaded,
  colorForAge,
  lerpHex,
  bearingCardinal,
  relativeTime,
  formatBlitzortungUrl,
  DEFAULT_BLITZORTUNG_MAX_AGE_SEC,
} from '../src/lightning-helpers';

// Minimal hass mock — we only ever read hass.config.components in these
// helpers, so the rest of the type doesn't matter for the test surface.
function hassWithComponents(components: unknown): HomeAssistant {
  return { config: { components } } as unknown as HomeAssistant;
}

describe('isBlitzortungLoaded', () => {
  it('returns true when blitzortung is in the loaded components list', () => {
    expect(isBlitzortungLoaded(hassWithComponents(['frontend', 'blitzortung', 'sun']))).toBe(true);
  });

  it('returns false when blitzortung is absent', () => {
    expect(isBlitzortungLoaded(hassWithComponents(['frontend', 'sun']))).toBe(false);
  });

  it('returns false when components is empty', () => {
    expect(isBlitzortungLoaded(hassWithComponents([]))).toBe(false);
  });

  it('returns false when components is missing', () => {
    expect(isBlitzortungLoaded({ config: {} } as unknown as HomeAssistant)).toBe(false);
  });

  it('returns false when components is not an array (HA version that exposes a Set)', () => {
    expect(isBlitzortungLoaded(hassWithComponents(new Set(['blitzortung'])))).toBe(false);
  });

  it('returns false when hass itself is undefined', () => {
    expect(isBlitzortungLoaded(undefined)).toBe(false);
  });

  it('does not match a substring (e.g. "non-blitzortung-thing")', () => {
    expect(isBlitzortungLoaded(hassWithComponents(['frontend', 'non-blitzortung-thing']))).toBe(false);
  });
});

describe('lerpHex', () => {
  it('returns the start colour at t=0', () => {
    expect(lerpHex('#ff0000', '#00ff00', 0)).toBe('#ff0000');
  });

  it('returns the end colour at t=1', () => {
    expect(lerpHex('#ff0000', '#00ff00', 1)).toBe('#00ff00');
  });

  it('interpolates each channel at t=0.5', () => {
    // Halfway between #000000 and #ffffff is #808080 (rounded from 127.5).
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('clamps t<0 to the start colour', () => {
    expect(lerpHex('#ff0000', '#00ff00', -1)).toBe('#ff0000');
  });

  it('clamps t>1 to the end colour', () => {
    expect(lerpHex('#ff0000', '#00ff00', 5)).toBe('#00ff00');
  });

  it('handles hex without leading #', () => {
    expect(lerpHex('ff0000', '00ff00', 0)).toBe('#ff0000');
  });
});

describe('colorForAge', () => {
  it('is white at t=0 (fresh strike)', () => {
    expect(colorForAge(0, 600)).toBe('#ffffff');
  });

  it('is yellow at t=0.25 of max age', () => {
    expect(colorForAge(150, 600)).toBe('#ffeb3b');
  });

  it('is orange at t=0.5 of max age', () => {
    expect(colorForAge(300, 600)).toBe('#ff9800');
  });

  it('is red at t=1.0 of max age', () => {
    expect(colorForAge(600, 600)).toBe('#ff0000');
  });

  it('clamps to red for ages past max', () => {
    expect(colorForAge(99999, 600)).toBe('#ff0000');
  });

  it('clamps to white for negative ages (clock skew)', () => {
    expect(colorForAge(-30, 600)).toBe('#ffffff');
  });

  it('returns white when maxAgeSec is zero (defensive — no divide-by-zero)', () => {
    expect(colorForAge(50, 0)).toBe('#ffffff');
  });

  it('returns white when maxAgeSec is negative', () => {
    expect(colorForAge(50, -10)).toBe('#ffffff');
  });

  it('default max age constant matches the Blitzortung integration default (verified empirically)', () => {
    expect(DEFAULT_BLITZORTUNG_MAX_AGE_SEC).toBe(7200);
  });

  it('progresses monotonically through the gradient (no backwards segments)', () => {
    // Sample a sequence of ages and confirm each successive colour differs.
    // Just a smoke check that the segment boundaries don't double back.
    const sequence = [0, 100, 200, 300, 400, 500, 600].map(s => colorForAge(s, 600));
    const unique = new Set(sequence);
    expect(unique.size).toBe(sequence.length);
  });
});

describe('bearingCardinal', () => {
  // Anchor: a fixed observer in the middle of the US for predictable bearings.
  const ORIGIN = { lat: 39.0, lon: -98.0 };

  it('returns N for a strike directly north', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, 45.0, ORIGIN.lon)).toBe('n');
  });

  it('returns S for a strike directly south', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, 30.0, ORIGIN.lon)).toBe('s');
  });

  it('returns E for a strike directly east', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, ORIGIN.lat, -90.0)).toBe('e');
  });

  it('returns W for a strike directly west', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, ORIGIN.lat, -110.0)).toBe('w');
  });

  it('returns NE for a strike northeast', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, 42.0, -94.0)).toBe('ne');
  });

  it('returns SW for a strike southwest', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, 35.0, -102.0)).toBe('sw');
  });

  it('handles same-point input gracefully (atan2(0,0) → 0 → N)', () => {
    expect(bearingCardinal(ORIGIN.lat, ORIGIN.lon, ORIGIN.lat, ORIGIN.lon)).toBe('n');
  });

  it('handles antimeridian crossing without wrapping into the wrong sector', () => {
    // From a point just west of the antimeridian to one just east — the
    // shorter great-circle path is east, so bearing should round to E.
    expect(bearingCardinal(0, 179, 0, -179)).toBe('e');
  });
});

describe('relativeTime', () => {
  it('returns just_now for ages under 5 seconds', () => {
    expect(relativeTime(0)).toEqual({ key: 'just_now', n: 0 });
    expect(relativeTime(4)).toEqual({ key: 'just_now', n: 0 });
  });

  it('returns seconds_ago for 5..119 seconds', () => {
    expect(relativeTime(5)).toEqual({ key: 'seconds_ago', n: 5 });
    expect(relativeTime(28)).toEqual({ key: 'seconds_ago', n: 28 });
    expect(relativeTime(119)).toEqual({ key: 'seconds_ago', n: 119 });
  });

  it('returns minutes_ago for 120..3599 seconds', () => {
    expect(relativeTime(120)).toEqual({ key: 'minutes_ago', n: 2 });
    expect(relativeTime(180)).toEqual({ key: 'minutes_ago', n: 3 });
    expect(relativeTime(3599)).toEqual({ key: 'minutes_ago', n: 59 });
  });

  it('returns hours_ago for ≥ 3600 seconds', () => {
    expect(relativeTime(3600)).toEqual({ key: 'hours_ago', n: 1 });
    expect(relativeTime(7200)).toEqual({ key: 'hours_ago', n: 2 });
    expect(relativeTime(86400)).toEqual({ key: 'hours_ago', n: 24 });
  });

  it('floors fractional seconds (no rounding up)', () => {
    expect(relativeTime(28.9)).toEqual({ key: 'seconds_ago', n: 28 });
  });

  it('clamps negative inputs to just_now (clock skew defence)', () => {
    expect(relativeTime(-30)).toEqual({ key: 'just_now', n: 0 });
  });
});

describe('formatBlitzortungUrl', () => {
  it('formats with 4 decimal places of precision', () => {
    expect(formatBlitzortungUrl(9, 38.5381, -96.9897))
      .toBe('https://map.blitzortung.org/#9/38.5381/-96.9897');
  });

  it('rounds extra precision down to 4 decimals', () => {
    expect(formatBlitzortungUrl(7, 38.538117, -96.989712))
      .toBe('https://map.blitzortung.org/#7/38.5381/-96.9897');
  });

  it('clamps zoom < 3 to the web map minimum', () => {
    expect(formatBlitzortungUrl(0, 0, 0))
      .toBe('https://map.blitzortung.org/#3/0.0000/0.0000');
  });

  it('clamps zoom > 13 to the web map maximum', () => {
    expect(formatBlitzortungUrl(20, 0, 0))
      .toBe('https://map.blitzortung.org/#13/0.0000/0.0000');
  });

  it('rounds fractional zoom to the nearest integer', () => {
    expect(formatBlitzortungUrl(7.6, 0, 0))
      .toBe('https://map.blitzortung.org/#8/0.0000/0.0000');
  });

  it('handles negative coordinates', () => {
    expect(formatBlitzortungUrl(8, -33.8688, 151.2093))
      .toBe('https://map.blitzortung.org/#8/-33.8688/151.2093');
  });
});
