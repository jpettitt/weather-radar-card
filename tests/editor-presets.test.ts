// The editor's presets page: field edits, removal, "Add as preset" on a
// marker, and the idle-timeout dropdown's Never choice.

import { describe, it, expect, vi } from 'vitest';
import * as editorModule from '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

const proto = (Object.values(editorModule).find(
  (v: any) => typeof v === 'function' && v.prototype?._setPresetField,
) as any).prototype;

function ctxWith(config: Record<string, unknown>): any {
  return {
    _config: config,
    hass: {},
    dispatchEvent: vi.fn(),
    _setPresets: proto._setPresets,
  };
}

const sent = (ctx: any) => ctx.dispatchEvent.mock.calls.at(-1)[0].detail.config;

describe('_setPresetField', () => {
  it('sets a field on a copy, leaving the original config alone', () => {
    const original = { type: 'custom:weather-radar-card', presets: [{ latitude: 1, longitude: 2 }] };
    const ctx = ctxWith(original);
    proto._setPresetField.call(ctx, 0, 'zoom', 9);
    expect(sent(ctx).presets).toEqual([{ latitude: 1, longitude: 2, zoom: 9 }]);
    expect(original.presets[0]).toEqual({ latitude: 1, longitude: 2 });
  });

  it('removes a cleared field instead of storing undefined', () => {
    const ctx = ctxWith({ type: 'custom:weather-radar-card', presets: [{ name: 'Lake', entity: 'person.me' }] });
    proto._setPresetField.call(ctx, 0, 'name', undefined);
    expect(sent(ctx).presets[0]).toEqual({ entity: 'person.me' });
    expect(Object.keys(sent(ctx).presets[0])).toEqual(['entity']);
  });
});

describe('_setPresets', () => {
  it('drops the key when the last preset is removed', () => {
    const ctx = ctxWith({ type: 'custom:weather-radar-card', presets: [{ latitude: 1, longitude: 2 }] });
    proto._setPresets.call(ctx, []);
    expect(sent(ctx)).not.toHaveProperty('presets');
  });
});

describe('_addMarkerAsPreset', () => {
  it("copies a marker's entity, or its coordinates when it has none", () => {
    const ctx = ctxWith({ type: 'custom:weather-radar-card' });
    proto._addMarkerAsPreset.call(ctx, { entity: 'person.me', icon: 'entity_picture', track: 'entity' });
    expect(sent(ctx).presets).toEqual([{ entity: 'person.me' }]);
    ctx._config = sent(ctx);
    proto._addMarkerAsPreset.call(ctx, { latitude: 1, longitude: 2, icon: 'mdi:home' });
    expect(sent(ctx).presets).toEqual([{ entity: 'person.me' }, { latitude: 1, longitude: 2 }]);
  });
});

describe('preset_timeout dropdown', () => {
  it('stores Never as 0 and the default as no key', () => {
    const ctx = ctxWith({ type: 'custom:weather-radar-card' });
    proto._handleSelectorNumberChanged.call(ctx, { target: { configValue: 'preset_timeout' }, detail: { value: '0' } });
    expect(sent(ctx).preset_timeout).toBe(0);
    proto._handleSelectorNumberChanged.call(ctx, { target: { configValue: 'preset_timeout' }, detail: { value: '' } });
    expect(sent(ctx)).not.toHaveProperty('preset_timeout');
  });
});
