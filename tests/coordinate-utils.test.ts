import { describe, it, expect } from 'vitest';
import {
  resolveCoordinate,
  resolveCoordinatePair,
  getCurrentUserInfo,
  getCoordinateConfig,
} from '../src/coordinate-utils';
import { mockHass, entityState } from './helpers/mock-hass';

// ── resolveCoordinate ────────────────────────────────────────────────────────

describe('resolveCoordinate', () => {
  it('returns a number literal directly', () => {
    expect(resolveCoordinate(-33.86, 'latitude', 0, undefined)).toBe(-33.86);
  });

  it('returns the fallback for undefined config', () => {
    expect(resolveCoordinate(undefined, 'latitude', -33.86, undefined)).toBe(-33.86);
  });

  it('returns the fallback for null config', () => {
    expect(resolveCoordinate(null as any, 'latitude', -33.86, undefined)).toBe(-33.86);
  });

  it('resolves entity latitude attribute', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34.5, 151.0) } });
    expect(resolveCoordinate('device_tracker.van', 'latitude', 0, hass)).toBe(-34.5);
  });

  it('resolves entity longitude attribute', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34.5, 151.0) } });
    expect(resolveCoordinate('device_tracker.van', 'longitude', 0, hass)).toBe(151.0);
  });

  it('returns coordinate 0 without substituting fallback — equator / Prime Meridian', () => {
    const hass = mockHass({ states: { 'zone.home': entityState(0, 0) } });
    expect(resolveCoordinate('zone.home', 'latitude', -33.86, hass)).toBe(0);
  });

  it('returns fallback when entity is missing from states', () => {
    const hass = mockHass({ states: {} });
    expect(resolveCoordinate('device_tracker.missing', 'latitude', -33.86, hass)).toBe(-33.86);
  });

  it('returns fallback when entity attribute is undefined', () => {
    const hass = mockHass({ states: { 'sensor.temp': { state: '22', attributes: {} } } });
    expect(resolveCoordinate('sensor.temp', 'latitude', -33.86, hass)).toBe(-33.86);
  });

  it('resolves EntityCoordinate with default attribute names', () => {
    const hass = mockHass({ states: { 'sensor.loc': entityState(-34, 151) } });
    expect(resolveCoordinate({ entity: 'sensor.loc' }, 'latitude', 0, hass)).toBe(-34);
  });

  it('resolves EntityCoordinate with custom latitude attribute name', () => {
    const hass = mockHass({ states: { 'sensor.custom': { state: 'ok', attributes: { my_lat: -35 } } } });
    expect(resolveCoordinate({ entity: 'sensor.custom', latitude_attribute: 'my_lat' }, 'latitude', 0, hass)).toBe(-35);
  });

  it('resolves EntityCoordinate with custom longitude attribute name', () => {
    const hass = mockHass({ states: { 'sensor.custom': { state: 'ok', attributes: { my_lon: 150 } } } });
    expect(resolveCoordinate({ entity: 'sensor.custom', longitude_attribute: 'my_lon' }, 'longitude', 0, hass)).toBe(150);
  });

  it('returns fallback when EntityCoordinate entity is missing', () => {
    const hass = mockHass({ states: {} });
    expect(resolveCoordinate({ entity: 'sensor.missing' }, 'latitude', -33.86, hass)).toBe(-33.86);
  });

  it('resolves EntityCoordinate longitude with the default attribute name', () => {
    const hass = mockHass({ states: { 'sensor.loc': entityState(-34, 151) } });
    expect(resolveCoordinate({ entity: 'sensor.loc' }, 'longitude', 0, hass)).toBe(151);
  });

  it('returns fallback for an entity string when hass is undefined', () => {
    expect(resolveCoordinate('device_tracker.van', 'latitude', -33.86, undefined)).toBe(-33.86);
  });

  it('returns fallback when a string-config entity has no attributes object', () => {
    const hass = mockHass({ states: { 'sensor.bare': { state: 'on' } } });
    expect(resolveCoordinate('sensor.bare', 'latitude', -33.86, hass)).toBe(-33.86);
  });

  it('returns fallback when an EntityCoordinate entity has no attributes object', () => {
    const hass = mockHass({ states: { 'sensor.bare': { state: 'on' } } });
    expect(resolveCoordinate({ entity: 'sensor.bare' }, 'longitude', 151.21, hass)).toBe(151.21);
  });

  it('does not look up a state when an object config has no entity key', () => {
    // A guard-less lookup would stringify the missing entity to the key "undefined".
    const hass = mockHass({ states: { undefined: entityState(-34, 151) } });
    expect(resolveCoordinate({ latitude_attribute: 'latitude' } as any, 'latitude', -33.86, hass)).toBe(-33.86);
  });

  it('returns fallback for a malformed boolean config instead of throwing', () => {
    expect(resolveCoordinate(true as any, 'latitude', -33.86, mockHass())).toBe(-33.86);
  });
});

// ── resolveCoordinatePair ────────────────────────────────────────────────────

describe('resolveCoordinatePair', () => {
  it('uses single-entity shortcut when lat and lon are the same entity string', () => {
    const hass = mockHass({ states: { 'person.john': entityState(-34, 151) } });
    expect(resolveCoordinatePair('person.john', 'person.john', 0, 0, hass)).toEqual({ lat: -34, lon: 151 });
  });

  it('resolves independently when lat and lon reference different entities', () => {
    const hass = mockHass({ states: {
      'device_tracker.a': entityState(-34, 0),
      'device_tracker.b': entityState(0, 151),
    }});
    expect(resolveCoordinatePair('device_tracker.a', 'device_tracker.b', 0, 0, hass))
      .toEqual({ lat: -34, lon: 151 });
  });

  it('mixes a static number and an entity string', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34, 151) } });
    expect(resolveCoordinatePair(-34, 'device_tracker.van', 0, 0, hass)).toEqual({ lat: -34, lon: 151 });
  });

  it('returns fallback pair when both configs are undefined', () => {
    expect(resolveCoordinatePair(undefined, undefined, -33.86, 151.21, undefined))
      .toEqual({ lat: -33.86, lon: 151.21 });
  });

  it('handles coordinate 0 from entity without substituting fallback', () => {
    const hass = mockHass({ states: { 'zone.null_island': entityState(0, 0) } });
    expect(resolveCoordinatePair('zone.null_island', 'zone.null_island', -33.86, 151.21, hass))
      .toEqual({ lat: 0, lon: 0 });
  });

  it('takes lat and lon from their own entities when both entities have non-zero coordinates', () => {
    // Zero coordinates elsewhere mask a wrongly-shared lookup: the shortcut skips falsy values.
    const hass = mockHass({ states: {
      'device_tracker.a': entityState(-34, 100),
      'device_tracker.b': entityState(10, 151),
    }});
    expect(resolveCoordinatePair('device_tracker.a', 'device_tracker.b', 0, 0, hass))
      .toEqual({ lat: -34, lon: 151 });
  });

  it('falls back per axis when the shared entity has an unparseable latitude', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState('unknown', 151) } });
    expect(resolveCoordinatePair('device_tracker.van', 'device_tracker.van', -33.86, 0, hass))
      .toEqual({ lat: -33.86, lon: 151 });
  });

  it('falls back per axis when the shared entity has an unparseable longitude', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34, 'unknown') } });
    expect(resolveCoordinatePair('device_tracker.van', 'device_tracker.van', 0, 151.21, hass))
      .toEqual({ lat: -34, lon: 151.21 });
  });

  it('returns the fallback pair when the shared entity has no attributes object', () => {
    const hass = mockHass({ states: { 'sensor.bare': { state: 'on' } } });
    expect(resolveCoordinatePair('sensor.bare', 'sensor.bare', -33.86, 151.21, hass))
      .toEqual({ lat: -33.86, lon: 151.21 });
  });
});

// ── getCurrentUserInfo ───────────────────────────────────────────────────────

describe('getCurrentUserInfo', () => {
  it('returns null when hass is undefined', () => {
    expect(getCurrentUserInfo(undefined)).toBeNull();
  });

  it('returns null when no person entity matches the current user', () => {
    const hass = mockHass({ userId: 'user-abc', states: {} });
    expect(getCurrentUserInfo(hass)).toBeNull();
  });

  it('finds the person entity whose user_id matches', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.john': { state: 'home', attributes: { user_id: 'user-abc', device_trackers: ['device_tracker.phone'] } },
      },
    });
    const result = getCurrentUserInfo(hass);
    expect(result?.personEntity).toBe('person.john');
    expect(result?.deviceTracker).toBe('device_tracker.phone');
  });

  it('does not match a person with a different user_id', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.jane': { state: 'home', attributes: { user_id: 'user-xyz' } },
      },
    });
    expect(getCurrentUserInfo(hass)).toBeNull();
  });

  it('handles device_trackers as a comma-separated string', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.john': { state: 'home', attributes: { user_id: 'user-abc', device_trackers: 'device_tracker.phone, device_tracker.tablet' } },
      },
    });
    expect(getCurrentUserInfo(hass)?.deviceTracker).toBe('device_tracker.phone');
  });

  it('returns undefined deviceTracker when person has no device_trackers attribute', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.john': { state: 'home', attributes: { user_id: 'user-abc' } },
      },
    });
    expect(getCurrentUserInfo(hass)?.deviceTracker).toBeUndefined();
  });

  it('returns null when hass has no user object', () => {
    const hass = { states: {} } as any;
    expect(getCurrentUserInfo(hass)).toBeNull();
  });

  it('returns null without a user even if a person entity has no user_id', () => {
    // undefined === undefined would otherwise "match" an unlinked person.
    const hass = { states: { 'person.unlinked': { state: 'home', attributes: {} } } } as any;
    expect(getCurrentUserInfo(hass)).toBeNull();
  });

  it('ignores non-person entities that carry a matching user_id', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'sensor.impostor': { state: 'on', attributes: { user_id: 'user-abc' } },
      },
    });
    expect(getCurrentUserInfo(hass)).toBeNull();
  });

  it('skips a person entity that has no attributes object and keeps searching', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.ghost': { state: 'unknown' },
        'person.john': { state: 'home', attributes: { user_id: 'user-abc' } },
      },
    });
    expect(getCurrentUserInfo(hass)?.personEntity).toBe('person.john');
  });

  it('trims whitespace around the first comma-separated device tracker', () => {
    const hass = mockHass({
      userId: 'user-abc',
      states: {
        'person.john': { state: 'home', attributes: { user_id: 'user-abc', device_trackers: '  device_tracker.phone , device_tracker.tablet' } },
      },
    });
    expect(getCurrentUserInfo(hass)?.deviceTracker).toBe('device_tracker.phone');
  });
});

// ── getCoordinateConfig ──────────────────────────────────────────────────────

describe('getCoordinateConfig', () => {
  it('returns base config on desktop regardless of mobile config', () => {
    expect(getCoordinateConfig(-33.86, -34, false)).toBe(-33.86);
  });

  it('returns mobile config on mobile when set', () => {
    expect(getCoordinateConfig(-33.86, -34, true)).toBe(-34);
  });

  it('falls back to base config on mobile when mobile config is undefined', () => {
    expect(getCoordinateConfig(-33.86, undefined, true)).toBe(-33.86);
  });

  it('returns userDeviceTracker on mobile when base and mobile configs are both undefined', () => {
    expect(getCoordinateConfig(undefined, undefined, true, 'device_tracker.phone')).toBe('device_tracker.phone');
  });

  it('returns undefined on desktop when base config is undefined', () => {
    expect(getCoordinateConfig(undefined, undefined, false)).toBeUndefined();
  });

  it('ignores userDeviceTracker on desktop', () => {
    expect(getCoordinateConfig(undefined, undefined, false, 'device_tracker.phone')).toBeUndefined();
  });
});
