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

// Mirrors of the private load / save helpers in weather-radar-card.ts.
// Duplicated rather than imported because the card module pulls in Lit
// and the full DOM stack — the test would have to mock too many things
// for ~20 lines of code. The mirror stays in sync via the behaviour-
// locking tests below; if the card's logic changes the duplicated copy
// needs to track it.
const FACTORY = 1;
function clamp(n: number): number {
  const lo = SPEED_STEPS[0];
  const hi = SPEED_STEPS[SPEED_STEPS.length - 1];
  return n < lo ? lo : n > hi ? hi : n;
}
function configured(configDefault: number | undefined): number {
  if (typeof configDefault === 'number' && Number.isFinite(configDefault) && configDefault > 0) {
    return clamp(configDefault);
  }
  return FACTORY;
}
interface StateStub { get: (key: string) => unknown; }
function loadPlaybackSpeed(state: StateStub | null, configDefault: number | undefined): number {
  if (state) {
    const v = state.get('playback_speed');
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return clamp(v);
  }
  return configured(configDefault);
}

// Sparse-storage save: returns the action a real call would have
// taken so the test can assert on it without instantiating ViewerState.
function savePlaybackSpeedAction(value: number, configDefault: number | undefined): { action: 'delete' | 'set'; value?: number } {
  if (value === configured(configDefault)) return { action: 'delete' };
  return { action: 'set', value };
}

describe('loadPlaybackSpeed', () => {
  it('prefers the per-user override when ViewerState has one', () => {
    const state: StateStub = { get: (k) => (k === 'playback_speed' ? 2 : undefined) };
    expect(loadPlaybackSpeed(state, 0.5)).toBe(2);
  });

  it('falls back to the YAML default when ViewerState has no override', () => {
    const state: StateStub = { get: () => undefined };
    expect(loadPlaybackSpeed(state, 0.5)).toBe(0.5);
  });

  it('falls back to 1× when neither override nor config is set', () => {
    expect(loadPlaybackSpeed(null, undefined)).toBe(1);
    const state: StateStub = { get: () => undefined };
    expect(loadPlaybackSpeed(state, undefined)).toBe(1);
  });

  it('clamps an out-of-range override to the SPEED_STEPS bounds', () => {
    const fast: StateStub = { get: () => 100 };
    const slow: StateStub = { get: () => 0.001 };
    expect(loadPlaybackSpeed(fast, undefined)).toBe(SPEED_STEPS[SPEED_STEPS.length - 1]);
    expect(loadPlaybackSpeed(slow, undefined)).toBe(SPEED_STEPS[0]);
  });

  it('ignores a non-numeric override and falls through to the YAML default', () => {
    const state: StateStub = { get: () => 'not-a-number' as unknown as number };
    expect(loadPlaybackSpeed(state, 2)).toBe(2);
  });

  it('ignores a non-positive config default and returns 1×', () => {
    expect(loadPlaybackSpeed(null, 0)).toBe(1);
    expect(loadPlaybackSpeed(null, -1)).toBe(1);
  });

  it('treats a null ViewerState (dormant admin opt-in) as "no override"', () => {
    expect(loadPlaybackSpeed(null, 2)).toBe(2);
  });
});

describe('savePlaybackSpeed (sparse-storage convention)', () => {
  it('deletes the override when the new value matches the YAML default', () => {
    expect(savePlaybackSpeedAction(0.5, 0.5)).toEqual({ action: 'delete' });
  });

  it('deletes the override when picking 1× and YAML is unset', () => {
    expect(savePlaybackSpeedAction(1, undefined)).toEqual({ action: 'delete' });
  });

  it('stores the override when it differs from the YAML default', () => {
    expect(savePlaybackSpeedAction(2, 0.5)).toEqual({ action: 'set', value: 2 });
  });

  it('stores the override when it differs from the factory 1×', () => {
    expect(savePlaybackSpeedAction(0.25, undefined)).toEqual({ action: 'set', value: 0.25 });
  });
});

// ── setSpeed preset snapping (2026-06 review backlog) ────────────────────

describe('RadarToolbar.setSpeed snapping', () => {
  it('snaps non-preset values to the nearest preset', async () => {
    // A raw YAML value like playback_speed: 1.5 used to be stored
    // verbatim; SPEED_STEPS.indexOf(1.5) === -1 made the next button
    // click cycle to ¼× instead of the adjacent step.
    const { RadarToolbar } = await import('../src/radar-toolbar');
    const tb = Object.create(RadarToolbar.prototype);
    tb._speedBtn = null;
    tb.setSpeed(1.5);
    expect(SPEED_STEPS).toContain(tb._speed);
    // 1.5 is equidistant from 1 and 2; the reduce keeps the LOWER
    // candidate on ties — same convention as onAdd's initialSpeed snap.
    expect(tb._speed).toBe(1);
    tb.setSpeed(0.3);
    expect(tb._speed).toBe(0.25);
    tb.setSpeed(4);
    expect(tb._speed).toBe(4);          // exact presets unchanged
  });
});
