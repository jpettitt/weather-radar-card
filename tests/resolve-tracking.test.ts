import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTracking } from '../src/marker-utils';
import { mockHass, entityState } from './helpers/mock-hass';
import { Marker } from '../src/types';

const FB_LAT = -33.86;
const FB_LON = 151.21;

describe('resolveTracking', () => {
  it('returns null when no markers have track set', () => {
    expect(resolveTracking([{ latitude: -34, longitude: 151 }], mockHass(), FB_LAT, FB_LON)).toBeNull();
  });

  it('returns null for an empty markers array', () => {
    expect(resolveTracking([], mockHass(), FB_LAT, FB_LON)).toBeNull();
  });

  it('returns null when hass is undefined and no tracked markers', () => {
    expect(resolveTracking([{ latitude: -34, longitude: 151 }], undefined, FB_LAT, FB_LON)).toBeNull();
  });

  // ── track: true (priority 1) ──────────────────────────────────────────────

  it('follows track:true marker using entity position', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34, 152) } });
    const markers: Marker[] = [{ entity: 'device_tracker.van', track: true }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 152 });
  });

  it('follows track:true marker using static position', () => {
    const markers: Marker[] = [{ latitude: -34, longitude: 151, track: true }];
    expect(resolveTracking(markers, mockHass(), FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 151 });
  });

  // ── track: entity non-person (priority 2) ────────────────────────────────

  it('follows track:entity on a device_tracker (priority 2)', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34, 152) } });
    const markers: Marker[] = [{ entity: 'device_tracker.van', track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 152 });
  });

  it('track:entity on a non-person entity beats track:true', () => {
    const hass = mockHass({ states: {
      'device_tracker.van': entityState(-34, 152),
      'device_tracker.bike': entityState(-35, 151),
    }});
    const markers: Marker[] = [
      { entity: 'device_tracker.bike', track: true },
      { entity: 'device_tracker.van', track: 'entity' },
    ];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 152 });
  });

  // ── track: entity person matching current user (priority 3) ──────────────

  it('follows track:entity on person.* matching hass.user.id (priority 3)', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.john': { state: 'not_home', attributes: { latitude: -35, longitude: 149, user_id: 'user-abc' } },
      },
    });
    const markers: Marker[] = [{ entity: 'person.john', track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -35, lon: 149 });
  });

  it('matching person (p3) beats device_tracker (p2) regardless of list order', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'device_tracker.van': entityState(-36, 150),
        'person.john': { state: 'not_home', attributes: { latitude: -35, longitude: 149, user_id: 'user-abc' } },
      },
    });
    const markers: Marker[] = [
      { entity: 'device_tracker.van', track: 'entity' },
      { entity: 'person.john', track: 'entity' },
    ];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -35, lon: 149 });
  });

  it('person with non-matching user_id is treated as priority 2, not 3', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.jane': { state: 'not_home', attributes: { latitude: -35, longitude: 149, user_id: 'user-xyz' } },
      },
    });
    const markers: Marker[] = [{ entity: 'person.jane', track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -35, lon: 149 });
  });

  // ── Tie-breaking ──────────────────────────────────────────────────────────

  it('warns and uses first when two track:true markers tie', () => {
    const hass = mockHass({ states: {
      'device_tracker.a': entityState(-34, 152),
      'device_tracker.b': entityState(-35, 151),
    }});
    const markers: Marker[] = [
      { entity: 'device_tracker.a', track: true },
      { entity: 'device_tracker.b', track: true },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTracking(markers, hass, FB_LAT, FB_LON);
    expect(result).toMatchObject({ lat: -34, lon: 152 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('priority'));
    warn.mockRestore();
  });

  it('warns and uses first when two track:entity markers tie at p2', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.jane': { state: 'not_home', attributes: { latitude: -35, longitude: 149, user_id: 'user-xyz' } },
        'device_tracker.van': entityState(-36, 150),
      },
    });
    const markers: Marker[] = [
      { entity: 'person.jane', track: 'entity' },
      { entity: 'device_tracker.van', track: 'entity' },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveTracking(markers, hass, FB_LAT, FB_LON);
    expect(result).toMatchObject({ lat: -35, lon: 149 }); // first wins
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── Unavailable entities ──────────────────────────────────────────────────

  it('returns static fallback position when tracked entity is missing from hass states', () => {
    const hass = mockHass({ states: {} });
    const markers: Marker[] = [{ entity: 'device_tracker.ghost', latitude: -34, longitude: 151, track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 151 });
  });

  it('returns home fallback position when tracked entity has no lat/lon', () => {
    const hass = mockHass({ states: { 'sensor.temp': { state: '22', attributes: {} } } });
    const markers: Marker[] = [{ entity: 'sensor.temp', track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: FB_LAT, lon: FB_LON });
  });

  it('returns position when winning entity marker is at any location (no home suppression)', () => {
    const farLat = FB_LAT + 0.009;
    const hass = mockHass({
      states: { 'device_tracker.van': entityState(farLat, FB_LON) },
    });
    const markers: Marker[] = [{ entity: 'device_tracker.van', track: 'entity' }];
    const result = resolveTracking(markers, hass, FB_LAT, FB_LON);
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(farLat, 4);
  });

  it('returns position even when winning marker is at home coords', () => {
    const markers: Marker[] = [{ latitude: FB_LAT, longitude: FB_LON, track: true }];
    expect(resolveTracking(markers, mockHass(), FB_LAT, FB_LON)).toMatchObject({ lat: FB_LAT, lon: FB_LON });
  });

  it('returns result when hass is undefined (uses static position)', () => {
    const markers: Marker[] = [{ latitude: -34, longitude: 151, track: true }];
    expect(resolveTracking(markers, undefined, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 151 });
  });

  // ── track:entity with no entity field ────────────────────────────────────

  it('skips track:entity marker that has no entity field', () => {
    const markers: Marker[] = [{ track: 'entity' }];
    expect(resolveTracking(markers, mockHass(), FB_LAT, FB_LON)).toBeNull();
  });

  // ── markerIndex in result ────────────────────────────────────────────────

  it('returns the correct markerIndex for the winning marker', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34, 152) } });
    const markers: Marker[] = [
      { latitude: -33, longitude: 151 },                     // index 0 — not tracked
      { entity: 'device_tracker.van', track: 'entity' },     // index 1 — winner
    ];
    const result = resolveTracking(markers, hass, FB_LAT, FB_LON);
    expect(result?.markerIndex).toBe(1);
  });

  it('returns markerIndex 0 when the first marker wins', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34, 152) } });
    const markers: Marker[] = [{ entity: 'device_tracker.van', track: true }];
    const result = resolveTracking(markers, hass, FB_LAT, FB_LON);
    expect(result?.markerIndex).toBe(0);
  });
});

// ── Partial hass objects and priority edge cases ─────────────────────────────

describe('resolveTracking — partial hass and priority edges', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw when hass has no user object', () => {
    const hass = { states: { 'device_tracker.van': entityState(-34, 152) } } as any;
    const markers: Marker[] = [{ entity: 'device_tracker.van', track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 152 });
  });

  it('does not rank a non-person entity as the current user even if it carries a matching user_id', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'device_tracker.bike': entityState(-35, 151),
        'device_tracker.van': entityState(-34, 152, { user_id: 'user-abc' }),
      },
    });
    const markers: Marker[] = [
      { entity: 'device_tracker.bike', track: 'entity' },
      { entity: 'device_tracker.van', track: 'entity' },
    ];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Both are priority 2, so the first marker wins.
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -35, lon: 151, markerIndex: 0 });
  });

  it('treats a person entity without an attributes object as priority 2 and does not throw', () => {
    const hass = mockHass({ states: { 'person.ghost': { state: 'unknown' } } });
    const markers: Marker[] = [{ entity: 'person.ghost', latitude: -34, longitude: 151, track: 'entity' }];
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 151 });
  });

  it('does not warn when a lower-priority marker follows a higher-priority winner', () => {
    const hass = mockHass({ states: {
      'device_tracker.van': entityState(-34, 152),
      'device_tracker.bike': entityState(-35, 151),
    }});
    const markers: Marker[] = [
      { entity: 'device_tracker.van', track: 'entity' },
      { entity: 'device_tracker.bike', track: true },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveTracking(markers, hass, FB_LAT, FB_LON)).toMatchObject({ lat: -34, lon: 152, markerIndex: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn about a priority tie for a track:entity marker that has no entity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveTracking([{ track: 'entity' }], mockHass(), FB_LAT, FB_LON)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
