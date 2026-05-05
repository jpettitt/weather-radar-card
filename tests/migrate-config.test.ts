import { describe, it, expect, vi } from 'vitest';
import { migrateConfig } from '../src/marker-utils';
import { WeatherRadarCardConfig } from '../src/types';

const base: WeatherRadarCardConfig = {
  type: 'custom:weather-radar-card',
  show_range: false,
  show_scale: false,
  show_playback: false,
  show_recenter: false,
  static_map: false,
  show_zoom: false,
  square_map: false,
};

describe('migrateConfig', () => {
  it('returns the same object reference when markers array already present', () => {
    const cfg = { ...base, markers: [{ latitude: 1, longitude: 2 }] };
    expect(migrateConfig(cfg)).toBe(cfg);
  });

  it('respects an explicitly empty markers array — user removed all markers', () => {
    const cfg = { ...base, markers: [] };
    expect(migrateConfig(cfg)).toBe(cfg);
  });

  it('synthesises a zone.home marker when markers is undefined and no legacy fields', () => {
    const result = migrateConfig(base);
    expect(result).not.toBe(base);
    expect(result.markers).toEqual([{ entity: 'zone.home' }]);
  });

  it('returns empty markers when show_marker:false with no other fields — explicit opt-out', () => {
    const cfg = { ...base, show_marker: false };
    const result = migrateConfig(cfg);
    expect(result.markers).toEqual([]);
  });

  it('migrates numeric lat/lon to static marker', () => {
    const cfg = { ...base, show_marker: true, marker_latitude: -33.86, marker_longitude: 151.21 };
    const result = migrateConfig(cfg);
    expect(result.markers).toHaveLength(1);
    expect(result.markers![0]).toEqual({ latitude: -33.86, longitude: 151.21 });
  });

  it('collapses same entity string for lat and lon to entity field', () => {
    const cfg = { ...base, show_marker: true, marker_latitude: 'person.john', marker_longitude: 'person.john' };
    expect(migrateConfig(cfg).markers![0]).toEqual({ entity: 'person.john' });
  });

  it('uses lat entity string when lat and lon are different entity strings', () => {
    const cfg = { ...base, marker_latitude: 'person.john', marker_longitude: 'person.jane' };
    expect(migrateConfig(cfg).markers![0].entity).toBe('person.john');
  });

  it('copies marker_icon to migrated marker', () => {
    const cfg = { ...base, show_marker: true, marker_icon: 'mdi:home' };
    expect(migrateConfig(cfg).markers![0].icon).toBe('mdi:home');
  });

  it('copies marker_icon_entity to migrated marker', () => {
    const cfg = { ...base, show_marker: true, marker_icon: 'entity_picture', marker_icon_entity: 'person.john' };
    expect(migrateConfig(cfg).markers![0].icon_entity).toBe('person.john');
  });

  it('does not create a mobile marker when mobile position equals desktop', () => {
    const cfg = {
      ...base, show_marker: true,
      marker_latitude: -33.86, marker_longitude: 151.21,
      mobile_marker_latitude: -33.86, mobile_marker_longitude: 151.21,
    };
    expect(migrateConfig(cfg).markers).toHaveLength(1);
  });

  it('creates mobile_only second marker when mobile position differs', () => {
    const cfg = {
      ...base, show_marker: true,
      marker_latitude: -33.86, marker_longitude: 151.21,
      mobile_marker_latitude: -34.0, mobile_marker_longitude: 151.0,
    };
    const result = migrateConfig(cfg);
    expect(result.markers).toHaveLength(2);
    expect(result.markers![1]).toMatchObject({ latitude: -34.0, longitude: 151.0, mobile_only: true });
  });

  it('collapses same mobile entity string to entity field on mobile marker', () => {
    const cfg = {
      ...base, show_marker: true,
      marker_latitude: -33.86, marker_longitude: 151.21,
      mobile_marker_latitude: 'device_tracker.phone', mobile_marker_longitude: 'device_tracker.phone',
    };
    const result = migrateConfig(cfg);
    expect(result.markers![1]).toMatchObject({ entity: 'device_tracker.phone', mobile_only: true });
  });

  it('copies mobile_marker_icon to mobile marker', () => {
    const cfg = {
      ...base, show_marker: true,
      marker_latitude: -33.86, marker_longitude: 151.21,
      mobile_marker_latitude: -34.0, mobile_marker_longitude: 151.0,
      mobile_marker_icon: 'mdi:cellphone',
    };
    expect(migrateConfig(cfg).markers![1].icon).toBe('mdi:cellphone');
  });

  it('copies mobile_marker_icon_entity to mobile marker', () => {
    const cfg = {
      ...base, show_marker: true,
      marker_latitude: -33.86, marker_longitude: 151.21,
      mobile_marker_latitude: 'device_tracker.phone', mobile_marker_longitude: 'device_tracker.phone',
      mobile_marker_icon: 'entity_picture',
      mobile_marker_icon_entity: 'person.john',
    };
    expect(migrateConfig(cfg).markers![1].icon_entity).toBe('person.john');
  });

  it('creates a zone.home marker when show_marker is true but no coordinates given', () => {
    const cfg = { ...base, show_marker: true };
    const result = migrateConfig(cfg);
    expect(result.markers).toHaveLength(1);
    expect(result.markers![0]).toEqual({ entity: 'zone.home' });
  });

  it('migrates when marker_latitude present even without show_marker', () => {
    const cfg = { ...base, marker_latitude: -33.86, marker_longitude: 151.21 };
    expect(migrateConfig(cfg).markers).toHaveLength(1);
  });

  it('migrates when only mobile_marker_latitude is present', () => {
    const cfg = { ...base, mobile_marker_latitude: 'device_tracker.phone', mobile_marker_longitude: 'device_tracker.phone' };
    const result = migrateConfig(cfg);
    // base marker (empty) + mobile marker
    expect(result.markers).toHaveLength(2);
    expect(result.markers![1].mobile_only).toBe(true);
  });

  it('does not mutate the original config object', () => {
    const cfg = { ...base, show_marker: true, marker_latitude: -33.86, marker_longitude: 151.21 };
    const snapshot = JSON.stringify(cfg);
    migrateConfig(cfg);
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it('preserves all other config fields in the result', () => {
    const cfg = { ...base, show_marker: true, marker_latitude: -33.86, marker_longitude: 151.21, zoom_level: 9 };
    expect(migrateConfig(cfg).zoom_level).toBe(9);
  });

  describe('time-range migration', () => {
    it('converts legacy frame_count to past_minutes using the source interval (RainViewer)', () => {
      const cfg = { ...base, data_source: 'RainViewer', frame_count: 5 };
      const r = migrateConfig(cfg);
      // (5 - 1) × 10 min = 40 min
      expect(r.past_minutes).toBe(40);
    });

    it('converts legacy frame_count to past_minutes using the source interval (NOAA, 5-min)', () => {
      const cfg = { ...base, data_source: 'NOAA', frame_count: 12 };
      const r = migrateConfig(cfg);
      // (12 - 1) × 5 min = 55 min
      expect(r.past_minutes).toBe(55);
    });

    it('converts legacy frame_count using RainViewer interval when data_source is undefined', () => {
      // Default source is RainViewer (10-min interval).
      const cfg = { ...base, frame_count: 7 };
      const r = migrateConfig(cfg);
      expect(r.past_minutes).toBe(60);
    });

    it('converts legacy dwd_forecast_hours to forecast_minutes', () => {
      const cfg = { ...base, data_source: 'DWD', dwd_forecast_hours: 2 };
      const r = migrateConfig(cfg);
      expect(r.forecast_minutes).toBe(120);
    });

    it('does not overwrite explicit past_minutes with frame_count derivation', () => {
      const cfg = { ...base, data_source: 'RainViewer', frame_count: 5, past_minutes: 90 };
      expect(migrateConfig(cfg).past_minutes).toBe(90);
    });

    it('does not overwrite explicit forecast_minutes with dwd_forecast_hours derivation', () => {
      const cfg = { ...base, data_source: 'DWD', dwd_forecast_hours: 1, forecast_minutes: 30 };
      expect(migrateConfig(cfg).forecast_minutes).toBe(30);
    });

    it('clamps negative legacy frame_count to 0 minutes (defensive against bad YAML)', () => {
      const cfg = { ...base, frame_count: 0 };
      // (0 - 1) × 10 = -10 → clamped to 0
      expect(migrateConfig(cfg).past_minutes).toBe(0);
    });

    it('migrates both frame_count and dwd_forecast_hours together for DWD', () => {
      const cfg = { ...base, data_source: 'DWD', frame_count: 13, dwd_forecast_hours: 2 };
      const r = migrateConfig(cfg);
      expect(r.past_minutes).toBe(60);  // (13 - 1) × 5
      expect(r.forecast_minutes).toBe(120); // 2 × 60
    });
  });
});
