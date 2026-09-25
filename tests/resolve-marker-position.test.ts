import { describe, it, expect } from 'vitest';
import { resolveMarkerPosition } from '../src/marker-utils';
import { mockHass, entityState } from './helpers/mock-hass';

describe('resolveMarkerPosition', () => {
  it('returns entity lat/lon when entity has valid attributes', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34.0, 152.0) } });
    expect(resolveMarkerPosition({ entity: 'device_tracker.van' }, hass, 0, 0)).toEqual({ lat: -34.0, lon: 152.0 });
  });

  it('handles coordinate 0 (equator / Prime Meridian) — must not substitute fallback', () => {
    const hass = mockHass({ states: { 'zone.home': entityState(0, 0) } });
    expect(resolveMarkerPosition({ entity: 'zone.home' }, hass, -33.86, 151.21)).toEqual({ lat: 0, lon: 0 });
  });

  it('falls back to static lat/lon when entity is missing from hass states', () => {
    const hass = mockHass({ states: {} });
    expect(resolveMarkerPosition({ entity: 'device_tracker.missing', latitude: -33.86, longitude: 151.21 }, hass, 0, 0))
      .toEqual({ lat: -33.86, lon: 151.21 });
  });

  it('falls back when entity has no lat/lon attributes', () => {
    const hass = mockHass({ states: { 'sensor.temp': { state: '22', attributes: {} } } });
    expect(resolveMarkerPosition({ entity: 'sensor.temp', latitude: -10, longitude: 20 }, hass, 0, 0))
      .toEqual({ lat: -10, lon: 20 });
  });

  it('falls back when entity attributes are non-numeric strings', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState('unknown', 'unknown') } });
    expect(resolveMarkerPosition({ entity: 'device_tracker.van', latitude: -33.86, longitude: 151.21 }, hass, 0, 0))
      .toEqual({ lat: -33.86, lon: 151.21 });
  });

  it('falls back to the static position when only the entity latitude is numeric', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState(-34.0, 'unknown') } });
    expect(resolveMarkerPosition({ entity: 'device_tracker.van', latitude: -10, longitude: 20 }, hass, 0, 0))
      .toEqual({ lat: -10, lon: 20 });
  });

  it('falls back to the static position when only the entity longitude is numeric', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState('unknown', 152.0) } });
    expect(resolveMarkerPosition({ entity: 'device_tracker.van', latitude: -10, longitude: 20 }, hass, 0, 0))
      .toEqual({ lat: -10, lon: 20 });
  });

  it('falls back to fallback values when hass is undefined', () => {
    expect(resolveMarkerPosition({}, undefined, -33.86, 151.21)).toEqual({ lat: -33.86, lon: 151.21 });
  });

  it('returns static lat/lon when no entity is set', () => {
    expect(resolveMarkerPosition({ latitude: -34.5, longitude: 150.0 }, undefined, 0, 0))
      .toEqual({ lat: -34.5, lon: 150.0 });
  });

  it('uses fallback lat when marker latitude is undefined', () => {
    expect(resolveMarkerPosition({ longitude: 150.0 }, undefined, -33.86, 0))
      .toEqual({ lat: -33.86, lon: 150.0 });
  });

  it('uses fallback lon when marker longitude is undefined', () => {
    expect(resolveMarkerPosition({ latitude: -34.5 }, undefined, 0, 151.21))
      .toEqual({ lat: -34.5, lon: 151.21 });
  });

  it('parses entity attribute values stored as strings', () => {
    const hass = mockHass({ states: { 'device_tracker.van': entityState('-34.5', '150.1') } });
    expect(resolveMarkerPosition({ entity: 'device_tracker.van' }, hass, 0, 0))
      .toEqual({ lat: -34.5, lon: 150.1 });
  });

  it('uses fallback for entirely empty marker config', () => {
    expect(resolveMarkerPosition({}, undefined, -33.86, 151.21)).toEqual({ lat: -33.86, lon: 151.21 });
  });

  it('prefers entity position over static lat/lon when entity is available', () => {
    const hass = mockHass({ states: { 'person.john': entityState(-35.0, 149.0) } });
    expect(resolveMarkerPosition({ entity: 'person.john', latitude: -99, longitude: -99 }, hass, 0, 0))
      .toEqual({ lat: -35.0, lon: 149.0 });
  });
});
