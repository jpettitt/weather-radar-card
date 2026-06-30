import { describe, it, expect } from 'vitest';
import {
  isValidCssSize,
  isSectionHeightPinned,
  resolveCardLayout,
} from '../src/card-layout';
import type { WeatherRadarCardConfig } from '../src/types';

// Minimal config factory — only the fields the layout cares about.
function cfg(over: Partial<WeatherRadarCardConfig> = {}): WeatherRadarCardConfig {
  return { type: 'custom:weather-radar-card', ...over } as WeatherRadarCardConfig;
}

describe('isValidCssSize', () => {
  it('accepts the supported length units', () => {
    for (const v of ['400px', '50%', '20em', '10rem', '80vh', '100vw', '12.5px']) {
      expect(isValidCssSize(v)).toBe(true);
    }
  });
  it('rejects junk, bare numbers, and declaration-smuggling', () => {
    for (const v of ['400', 'auto', 'px', '100px;border:0', '', undefined]) {
      expect(isValidCssSize(v as string | undefined)).toBe(false);
    }
  });
});

describe('isSectionHeightPinned', () => {
  it('is true only when grid_options.rows is a concrete number', () => {
    expect(isSectionHeightPinned(cfg({ grid_options: { rows: 4 } }))).toBe(true);
    expect(isSectionHeightPinned(cfg({ grid_options: { rows: 12 } }))).toBe(true);
  });
  it('is false for auto, missing rows, or missing grid_options', () => {
    expect(isSectionHeightPinned(cfg({ grid_options: { rows: 'auto' } }))).toBe(false);
    expect(isSectionHeightPinned(cfg({ grid_options: {} }))).toBe(false);
    expect(isSectionHeightPinned(cfg())).toBe(false);
  });
});

describe('resolveCardLayout', () => {
  it('defaults to flex-mode with the 400px baseline', () => {
    expect(resolveCardLayout(cfg())).toEqual({ mode: 'flex', minHeight: '400px' });
  });

  it('uses a valid configured height as the min-height', () => {
    expect(resolveCardLayout(cfg({ height: '600px' }))).toEqual({ mode: 'flex', minHeight: '600px' });
  });

  it('falls back to 400px when the configured height is invalid', () => {
    expect(resolveCardLayout(cfg({ height: 'tall' }))).toEqual({ mode: 'flex', minHeight: '400px' });
  });

  it('uses aspect-mode for square_map without an explicit height', () => {
    expect(resolveCardLayout(cfg({ square_map: true }))).toEqual({ mode: 'aspect', minHeight: null });
  });

  it('explicit height beats square_map (flex-mode, min-height from height)', () => {
    expect(resolveCardLayout(cfg({ square_map: true, height: '500px' })))
      .toEqual({ mode: 'flex', minHeight: '500px' });
  });

  // The bug: a fixed-row section cell must own the height. The card fills
  // the cell (no min-height) and ignores both `height:` and `square_map`.
  it('a fixed-row section cell fills the cell, ignoring config height', () => {
    expect(resolveCardLayout(cfg({ grid_options: { rows: 4 }, height: '900px' })))
      .toEqual({ mode: 'flex', minHeight: null });
  });

  it('a fixed-row section cell overrides square_map (no aspect-mode)', () => {
    expect(resolveCardLayout(cfg({ grid_options: { rows: 6 }, square_map: true })))
      .toEqual({ mode: 'flex', minHeight: null });
  });

  it("rows: 'auto' is unconstrained — config height still applies", () => {
    expect(resolveCardLayout(cfg({ grid_options: { rows: 'auto' }, height: '700px' })))
      .toEqual({ mode: 'flex', minHeight: '700px' });
  });
});
