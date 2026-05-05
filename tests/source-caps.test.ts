import { describe, it, expect } from 'vitest';
import { SOURCE_CAPS, getSourceCaps, getEffectiveTimeRange } from '../src/source-caps';
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

describe('getSourceCaps', () => {
  it('returns RainViewer caps for undefined source (the documented default)', () => {
    expect(getSourceCaps(undefined)).toBe(SOURCE_CAPS.RainViewer);
  });

  it('returns RainViewer caps for an unknown source string instead of throwing', () => {
    // Defensive: the player should never crash because of a typo in the user's YAML.
    expect(getSourceCaps('TotallyMadeUp')).toBe(SOURCE_CAPS.RainViewer);
  });

  it('exposes the right per-source intervals', () => {
    expect(SOURCE_CAPS.RainViewer.intervalMin).toBe(10);
    expect(SOURCE_CAPS.NOAA.intervalMin).toBe(5);
    expect(SOURCE_CAPS.DWD.intervalMin).toBe(5);
  });

  it('flags forecast availability via maxForecastMin', () => {
    expect(SOURCE_CAPS.RainViewer.maxForecastMin).toBe(0);
    expect(SOURCE_CAPS.NOAA.maxForecastMin).toBe(0);
    expect(SOURCE_CAPS.DWD.maxForecastMin).toBeGreaterThan(0);
  });
});

describe('getEffectiveTimeRange', () => {
  it('applies source defaults when nothing is configured (RainViewer)', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'RainViewer' });
    expect(r.pastMin).toBe(60);
    expect(r.forecastMin).toBe(0);
    expect(r.strideMin).toBe(10);
    expect(r.frameCount).toBe(7); // 60/10 + 1
  });

  it('applies DWD defaults (2h past + 2h forecast at 5-min stride)', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'DWD' });
    expect(r.pastMin).toBe(120);
    expect(r.forecastMin).toBe(120);
    expect(r.strideMin).toBe(5);
    expect(r.frameCount).toBe(49); // 240/5 + 1
  });

  it('caps past_minutes at the source max (silent — editor surfaces warnings)', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'RainViewer', past_minutes: 9999 });
    expect(r.pastMin).toBe(120); // RainViewer maxPastMin
  });

  it('caps forecast_minutes at the source max', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'DWD', forecast_minutes: 999 });
    expect(r.forecastMin).toBe(120); // DWD maxForecastMin
  });

  it('clamps negative past_minutes to 0 instead of crashing', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'DWD', past_minutes: -10 });
    expect(r.pastMin).toBe(0);
  });

  it('floors forecast to 0 for sources that have none, even if user sets it', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'RainViewer', forecast_minutes: 60 });
    expect(r.forecastMin).toBe(0);
  });

  it('honours frame_stride_minutes when it is a positive multiple of native interval', () => {
    const r = getEffectiveTimeRange({
      ...base, data_source: 'DWD', past_minutes: 120, forecast_minutes: 0, frame_stride_minutes: 30,
    });
    expect(r.strideMin).toBe(30);
    expect(r.frameCount).toBe(5); // 120/30 + 1
  });

  it('snaps stride to the nearest native multiple — alignment with API timestamps matters', () => {
    // 22 min on a 5-min interval rounds to 4 × 5 = 20 min.
    const r = getEffectiveTimeRange({
      ...base, data_source: 'DWD', past_minutes: 60, frame_stride_minutes: 22,
    });
    expect(r.strideMin).toBe(20);
  });

  it('falls back to native stride when frame_stride_minutes is below native', () => {
    // RainViewer native is 10; stride 3 makes no sense (API serves 10-min spacing).
    const r = getEffectiveTimeRange({
      ...base, data_source: 'RainViewer', frame_stride_minutes: 3,
    });
    expect(r.strideMin).toBe(10);
  });

  it('always returns at least 2 frames so the animation loop has something to switch between', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'RainViewer', past_minutes: 0 });
    expect(r.frameCount).toBe(2);
  });

  it('handles forecast-only ranges (past=0, forecast=120 on DWD)', () => {
    const r = getEffectiveTimeRange({
      ...base, data_source: 'DWD', past_minutes: 0, forecast_minutes: 120,
    });
    expect(r.pastMin).toBe(0);
    expect(r.forecastMin).toBe(120);
    expect(r.frameCount).toBe(25); // 120/5 + 1
  });
});
