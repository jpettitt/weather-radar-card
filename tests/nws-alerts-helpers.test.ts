import { describe, it, expect, beforeEach, vi } from 'vitest';

// Leaflet has to be mocked before importing the alerts layer (Leaflet's
// browser-DOM probing throws under happy-dom otherwise). Same pattern as
// tests/marker-icon.test.ts.
vi.mock('leaflet', () => {
  const stub = vi.fn();
  return {
    geoJSON: stub,
    layerGroup: stub,
    marker: stub,
    map: stub,
    latLng: vi.fn((lat, lng) => ({ lat, lng })),
    divIcon: stub,
    icon: stub,
    Layer: class {},
    Map: class {},
    default: {
      geoJSON: stub, layerGroup: stub, marker: stub, map: stub,
      latLng: vi.fn((lat, lng) => ({ lat, lng })),
      divIcon: stub, icon: stub,
    },
  };
});

import {
  featureKey,
  decisionsEqual,
  severityAscending,
  relativeLuminance,
  formatDateTime,
  readZoneFromLocalStorage,
  writeZoneToLocalStorage,
  ZONE_LS_KEY_PREFIX,
  ZONE_LS_TTL_MS,
} from '../src/nws-alerts-layer';

// ── featureKey ─────────────────────────────────────────────────────────────

describe('featureKey', () => {
  it('uses feature.id when present (NWS always provides it)', () => {
    const f = { type: 'Feature', id: 'https://api.weather.gov/alerts/abc', properties: {}, geometry: null } as any;
    expect(featureKey(f)).toBe('https://api.weather.gov/alerts/abc');
  });

  it('falls back to properties.id when feature.id is absent', () => {
    const f = { type: 'Feature', properties: { id: 'urn:oid:1.2.3' }, geometry: null } as any;
    expect(featureKey(f)).toBe('urn:oid:1.2.3');
  });

  it('returns empty string when no id is available anywhere', () => {
    const f = { type: 'Feature', properties: {}, geometry: null } as any;
    expect(featureKey(f)).toBe('');
  });

  it('coerces non-string ids via String()', () => {
    const f = { type: 'Feature', id: 12345, properties: {}, geometry: null } as any;
    expect(featureKey(f)).toBe('12345');
  });
});

// ── decisionsEqual ─────────────────────────────────────────────────────────
//
// This is the guard that prevents the popup-disappearing regression: when
// hass tick fires and the per-feature render decisions are unchanged, we
// short-circuit the whole layer rebuild. If this comparator goes wrong,
// popups close on every state push.

describe('decisionsEqual', () => {
  it('returns true for two empty maps', () => {
    expect(decisionsEqual(new Map(), new Map())).toBe(true);
  });

  it('returns true for identical maps', () => {
    const a = new Map([['k1', 'v1'], ['k2', 'v2']]);
    const b = new Map([['k1', 'v1'], ['k2', 'v2']]);
    expect(decisionsEqual(a, b)).toBe(true);
  });

  it('returns true regardless of insertion order', () => {
    const a = new Map([['k1', 'v1'], ['k2', 'v2']]);
    const b = new Map([['k2', 'v2'], ['k1', 'v1']]);
    expect(decisionsEqual(a, b)).toBe(true);
  });

  it('returns false when sizes differ', () => {
    const a = new Map([['k1', 'v1']]);
    const b = new Map([['k1', 'v1'], ['k2', 'v2']]);
    expect(decisionsEqual(a, b)).toBe(false);
  });

  it('returns false when a value flips (zone arrival case)', () => {
    // Simulates the zones:1/3 → zones:2/3 transition that should
    // trigger a re-render when a new zone resolves.
    const before = new Map([['feat-1', 'Tornado Warning|Severe|zones:1/3']]);
    const after = new Map([['feat-1', 'Tornado Warning|Severe|zones:2/3']]);
    expect(decisionsEqual(before, after)).toBe(false);
  });

  it('returns false when keys differ even with same size', () => {
    const a = new Map([['k1', 'v']]);
    const b = new Map([['k2', 'v']]);
    expect(decisionsEqual(a, b)).toBe(false);
  });
});

// ── severityAscending ──────────────────────────────────────────────────────

describe('severityAscending', () => {
  const f = (sev: string) => ({
    type: 'Feature', properties: { severity: sev }, geometry: null,
  } as any);

  it('sorts Unknown before Minor before Severe before Extreme', () => {
    const features = [f('Extreme'), f('Unknown'), f('Severe'), f('Minor'), f('Moderate')];
    features.sort(severityAscending);
    const order = features.map((x) => x.properties.severity);
    expect(order).toEqual(['Unknown', 'Minor', 'Moderate', 'Severe', 'Extreme']);
  });

  it('treats unrecognised severity as 0 (lowest, like Unknown)', () => {
    const features = [f('Extreme'), f('NotARealSeverity'), f('Minor')];
    features.sort(severityAscending);
    expect(features[0].properties.severity).toBe('NotARealSeverity');
    expect(features[features.length - 1].properties.severity).toBe('Extreme');
  });

  it('treats missing severity as 0', () => {
    const features = [
      f('Extreme'),
      { type: 'Feature', properties: {}, geometry: null } as any,
    ];
    features.sort(severityAscending);
    expect(features[0].properties.severity).toBeUndefined();
    expect(features[1].properties.severity).toBe('Extreme');
  });
});

// ── relativeLuminance ──────────────────────────────────────────────────────
//
// Drives the popup accent-colour decision. A value below 0.7 keeps the
// vivid colour; above, we fall back to dark grey for readability.

describe('relativeLuminance', () => {
  it('returns 1 for pure white', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 4);
  });

  it('returns 0 for pure black', () => {
    expect(relativeLuminance('#000000')).toBe(0);
  });

  it('returns the WCAG component values for primary colours', () => {
    // Per the WCAG-style coefficients: 0.2126R + 0.7152G + 0.0722B.
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
  });

  it('classifies typical "light" NWS colours above the 0.7 threshold (would use dark accent)', () => {
    // Yellow (Tornado Watch), Moccasin (Special Weather Statement), light steel blue (Wind Chill Warning)
    expect(relativeLuminance('#FFFF00')).toBeGreaterThan(0.7);
    expect(relativeLuminance('#FFE4B5')).toBeGreaterThan(0.7);
  });

  it('classifies typical "dark" NWS colours below the 0.7 threshold (would use the colour)', () => {
    // Red (Tornado Warning), Dark red (Flash Flood Warning), Crimson (Hurricane Warning)
    expect(relativeLuminance('#FF0000')).toBeLessThan(0.7);
    expect(relativeLuminance('#8B0000')).toBeLessThan(0.7);
    expect(relativeLuminance('#DC143C')).toBeLessThan(0.7);
  });

  it('returns the 0.5 sentinel for malformed hex', () => {
    expect(relativeLuminance('not a hex')).toBe(0.5);
    expect(relativeLuminance('#FFF')).toBe(0.5);   // 3-char shorthand not supported
    expect(relativeLuminance('')).toBe(0.5);
  });

  it('accepts both upper- and lower-case hex digits', () => {
    expect(relativeLuminance('#abcdef')).toBeCloseTo(relativeLuminance('#ABCDEF'), 6);
  });
});

// ── formatDateTime ─────────────────────────────────────────────────────────

describe('formatDateTime', () => {
  it('returns "—" for undefined', () => {
    expect(formatDateTime(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(formatDateTime('')).toBe('—');
  });

  it('formats a valid ISO timestamp via Date.toLocaleString', () => {
    const result = formatDateTime('2026-05-02T17:25:00-07:00');
    // toLocaleString output varies by environment locale, but it should
    // be non-trivial and contain a year.
    expect(result.length).toBeGreaterThan(5);
    expect(result).toMatch(/2026/);
  });

  it('returns the input unchanged when it isn\'t parseable', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

// ── localStorage zone cache ────────────────────────────────────────────────
//
// happy-dom provides a working localStorage. Tests run in isolation so we
// clear it between runs.

describe('zone localStorage cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const sampleGeom: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  };

  it('returns null for a never-cached URL', () => {
    expect(readZoneFromLocalStorage('https://api.weather.gov/zones/forecast/MNZ073')).toBeNull();
  });

  it('round-trips a write → read', () => {
    writeZoneToLocalStorage('https://api.weather.gov/zones/forecast/MNZ073', sampleGeom);
    const got = readZoneFromLocalStorage('https://api.weather.gov/zones/forecast/MNZ073');
    expect(got).toEqual(sampleGeom);
  });

  it('uses the versioned key prefix so format changes can invalidate', () => {
    writeZoneToLocalStorage('zone-X', sampleGeom);
    const raw = localStorage.getItem(ZONE_LS_KEY_PREFIX + 'zone-X');
    expect(raw).not.toBeNull();
    expect(raw).toContain('"geometry"');
    expect(raw).toContain('"ts"');
  });

  it('evicts and returns null for a stale entry past TTL', () => {
    // Manually write an expired entry (timestamp older than TTL).
    const expired = JSON.stringify({
      geometry: sampleGeom,
      ts: Date.now() - ZONE_LS_TTL_MS - 1000,
    });
    localStorage.setItem(ZONE_LS_KEY_PREFIX + 'old', expired);
    expect(readZoneFromLocalStorage('old')).toBeNull();
    // Eviction side-effect: the entry is removed on read.
    expect(localStorage.getItem(ZONE_LS_KEY_PREFIX + 'old')).toBeNull();
  });

  it('returns null and silently swallows corrupt JSON', () => {
    localStorage.setItem(ZONE_LS_KEY_PREFIX + 'broken', '{not json');
    expect(readZoneFromLocalStorage('broken')).toBeNull();
  });

  it('does not throw when localStorage.setItem throws (quota / disabled)', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      expect(() => writeZoneToLocalStorage('any', sampleGeom)).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
