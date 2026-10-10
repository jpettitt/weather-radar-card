// Clearing a centre coordinate in the editor must not mutate the config
// object in place: it can be the one HA holds, and config-changed with an
// unchanged reference re-renders nothing (2026-10-10 review).

import { describe, it, expect, vi } from 'vitest';
import * as editorModule from '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

const proto = (Object.values(editorModule).find(
  (v: any) => typeof v === 'function' && v.prototype?._valueChangedCoordinate,
) as any).prototype;

function ctxWith(config: Record<string, unknown>): any {
  return { _config: config, hass: {}, dispatchEvent: vi.fn() };
}

describe('_valueChangedCoordinate', () => {
  it('clearing a field replaces the config object instead of deleting in place', () => {
    const original = { type: 'custom:weather-radar-card', center_latitude: 51.5, center_longitude: -0.1 };
    const ctx = ctxWith(original);
    proto._valueChangedCoordinate.call(ctx, { target: { configValue: 'center_latitude', value: '' } });
    expect(original.center_latitude).toBe(51.5);   // HA's copy untouched
    expect(ctx._config).not.toBe(original);
    expect(ctx._config).not.toHaveProperty('center_latitude');
    expect(ctx._config.center_longitude).toBe(-0.1);
    const ev = ctx.dispatchEvent.mock.calls[0][0];
    expect(ev.type).toBe('config-changed');
    expect(ev.detail.config).toBe(ctx._config);
  });

  it('a numeric value is stored as a number on a new object', () => {
    const original = { type: 'custom:weather-radar-card' };
    const ctx = ctxWith(original);
    proto._valueChangedCoordinate.call(ctx, { target: { configValue: 'center_latitude', value: '48.1' } });
    expect(ctx._config).not.toBe(original);
    expect(ctx._config.center_latitude).toBe(48.1);
  });
});
