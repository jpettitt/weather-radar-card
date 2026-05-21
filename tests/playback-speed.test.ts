import { describe, it, expect, vi } from 'vitest';

// Leaflet stub so radar-toolbar.ts can be imported without a DOM. We
// only touch the pure formatSpeed helper here; the L.Control class isn't
// instantiated.
vi.mock('leaflet', () => {
  class Control {}
  class Map {}
  const DomUtil = { create: vi.fn() };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn(), preventDefault: vi.fn() };
  return {
    Control, Map, DomUtil, DomEvent,
    default: { Control, Map, DomUtil, DomEvent },
  };
});

import { formatSpeed, SPEED_STEPS } from '../src/radar-toolbar';

describe('formatSpeed', () => {
  it('renders ¼ and ½ using Unicode fractions so the toolbar button stays narrow', () => {
    expect(formatSpeed(0.25)).toBe('¼×');
    expect(formatSpeed(0.5)).toBe('½×');
  });

  it('renders integer speeds without a decimal point', () => {
    expect(formatSpeed(1)).toBe('1×');
    expect(formatSpeed(2)).toBe('2×');
    expect(formatSpeed(4)).toBe('4×');
  });

  it('falls back to two decimal places for non-canonical values', () => {
    // Out of preset, but should still print sensibly if someone calls
    // formatSpeed with a stored value that's drifted.
    expect(formatSpeed(0.75)).toBe('0.75×');
    expect(formatSpeed(1.5)).toBe('1.50×');
  });
});

describe('SPEED_STEPS', () => {
  it('is monotonically increasing and includes 1× as the canonical default', () => {
    for (let i = 1; i < SPEED_STEPS.length; i++) {
      expect(SPEED_STEPS[i]).toBeGreaterThan(SPEED_STEPS[i - 1]);
    }
    expect(SPEED_STEPS).toContain(1);
  });

  it('covers a useful range either side of 1× for slowing and speeding up', () => {
    expect(SPEED_STEPS[0]).toBeLessThan(1);  // at least one slow preset
    expect(SPEED_STEPS[SPEED_STEPS.length - 1]).toBeGreaterThan(1);  // at least one fast preset
  });
});

// Mirror of the private resolvePlaybackSpeed in weather-radar-card.ts.
// Duplicated here rather than imported because the card module pulls in
// Lit and the full DOM stack — the test would have to mock too many
// things for ~10 lines of code. The mirror stays in sync via the
// behaviour-locking tests below; if the card's logic changes, the
// duplicated copy needs to track it.
function resolvePlaybackSpeed(stored: string | null, configDefault: number | undefined): number {
  const lo = SPEED_STEPS[0];
  const hi = SPEED_STEPS[SPEED_STEPS.length - 1];
  const clamp = (n: number): number => (n < lo ? lo : n > hi ? hi : n);
  if (stored != null) {
    const n = Number(stored);
    if (Number.isFinite(n) && n > 0) return clamp(n);
  }
  if (typeof configDefault === 'number' && Number.isFinite(configDefault) && configDefault > 0) {
    return clamp(configDefault);
  }
  return 1;
}

describe('resolvePlaybackSpeed', () => {
  it('prefers localStorage over the YAML default', () => {
    expect(resolvePlaybackSpeed('2', 0.5)).toBe(2);
  });

  it('falls back to the YAML default when localStorage is empty', () => {
    expect(resolvePlaybackSpeed(null, 0.5)).toBe(0.5);
  });

  it('falls back to 1× when neither localStorage nor config is set', () => {
    expect(resolvePlaybackSpeed(null, undefined)).toBe(1);
  });

  it('clamps an out-of-range localStorage value to the SPEED_STEPS bounds', () => {
    expect(resolvePlaybackSpeed('100', undefined)).toBe(SPEED_STEPS[SPEED_STEPS.length - 1]);
    expect(resolvePlaybackSpeed('0.001', undefined)).toBe(SPEED_STEPS[0]);
  });

  it('ignores garbage in localStorage and uses the YAML default', () => {
    expect(resolvePlaybackSpeed('not-a-number', 2)).toBe(2);
    expect(resolvePlaybackSpeed('-5', 2)).toBe(2);
  });

  it('ignores a non-positive config default and returns 1×', () => {
    expect(resolvePlaybackSpeed(null, 0)).toBe(1);
    expect(resolvePlaybackSpeed(null, -1)).toBe(1);
  });
});
