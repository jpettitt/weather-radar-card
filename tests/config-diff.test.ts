import { describe, it, expect } from 'vitest';
import { isOnlyKeysChanged } from '../src/config-diff';
import type { WeatherRadarCardConfig } from '../src/types';

function cfg(over: Partial<WeatherRadarCardConfig> = {}): WeatherRadarCardConfig {
  return { type: 'custom:weather-radar-card', ...over } as WeatherRadarCardConfig;
}

describe('isOnlyKeysChanged', () => {
  it('is false when nothing changed', () => {
    expect(isOnlyKeysChanged(cfg(), cfg(), new Set(['height']))).toBe(false);
  });

  it('is true when only an allowed key changed', () => {
    expect(isOnlyKeysChanged(cfg({ height: '400px' }), cfg({ height: '500px' }), new Set(['height']))).toBe(true);
  });

  it('is false when a disallowed key also changed', () => {
    expect(isOnlyKeysChanged(
      cfg({ height: '400px' }),
      cfg({ height: '500px', width: '90%' }),
      new Set(['height']),
    )).toBe(false);
  });

  it('is true when an allowed key changed from present to absent', () => {
    expect(isOnlyKeysChanged(cfg({ height: '400px' }), cfg(), new Set(['height']))).toBe(true);
  });
});
