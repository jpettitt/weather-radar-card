import { describe, it, expect } from 'vitest';
import { isWheelZoomEnabled } from '../src/map-interaction';

describe('isWheelZoomEnabled', () => {
  it('is on by default', () => {
    expect(isWheelZoomEnabled({})).toBe(true);
  });

  it('disable_wheel_zoom turns it off', () => {
    expect(isWheelZoomEnabled({ disable_wheel_zoom: true })).toBe(false);
  });

  it('static_map turns it off', () => {
    expect(isWheelZoomEnabled({ static_map: true })).toBe(false);
  });

  it('explicit false values leave it on', () => {
    expect(isWheelZoomEnabled({ static_map: false, disable_wheel_zoom: false })).toBe(true);
  });

  it('only a literal true disables it (mirrors the other boolean options)', () => {
    expect(isWheelZoomEnabled({ disable_wheel_zoom: 'true' as unknown as boolean })).toBe(true);
  });
});
