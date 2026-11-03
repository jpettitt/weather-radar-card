// The re-centre rotation over view presets, driven on a real Leaflet map
// (happy-dom gives it no size, so moves apply synchronously). Only hass is
// faked.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as L from 'leaflet';
import {
  ViewPresets, StopChange, liveTrackedStop, nextStop, presetName, presetPosition,
  presetTimeoutMs, recenterRequested,
} from '../src/view-presets';
import type { WeatherRadarCardConfig } from '../src/types';
import { mockHass, entityState } from './helpers/mock-hass';

const HOME = { lat: 37.4, lon: -122.1 };
const BAY = { name: 'Bay Area', latitude: 37.6, longitude: -122.2, zoom: 9 };
const ME = { 'person.me': entityState(37.0, -121.9, { friendly_name: 'Me' }) };

function setup(cfg: Partial<WeatherRadarCardConfig>, states: Record<string, unknown> = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  // The card's own zoom limits (weather-radar-card.ts _initMap).
  const map = L.map(el, { minZoom: 3, maxZoom: 16 }).setView([HOME.lat, HOME.lon], 7);
  const changes: StopChange[] = [];
  const ctx = {
    cfg: { type: 'custom:weather-radar-card', zoom_level: 7, ...cfg } as WeatherRadarCardConfig,
    hass: mockHass({ states: states as never }),
  };
  const vp = new ViewPresets({
    map,
    getConfig: () => ctx.cfg,
    getHass: () => ctx.hass,
    defaultCenter: () => HOME,
    onChange: (c) => changes.push(c),
  });
  const view = () => {
    const c = map.getCenter();
    return { lat: +c.lat.toFixed(4), lon: +c.lng.toFixed(4), zoom: map.getZoom() };
  };
  return { map, vp, changes, ctx, view, last: () => changes[changes.length - 1] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('presetTimeoutMs', () => {
  it('defaults to 5 minutes', () => {
    expect(presetTimeoutMs({})).toBe(5 * 60_000);
  });

  it('0 means never', () => {
    expect(presetTimeoutMs({ preset_timeout: 0 })).toBeNull();
  });

  it('takes minutes', () => {
    expect(presetTimeoutMs({ preset_timeout: 15 })).toBe(15 * 60_000);
  });

  it('falls back to the default for a negative or non-numeric value', () => {
    expect(presetTimeoutMs({ preset_timeout: -1 })).toBe(5 * 60_000);
    expect(presetTimeoutMs({ preset_timeout: NaN })).toBe(5 * 60_000);
    expect(presetTimeoutMs({ preset_timeout: '10' as unknown as number })).toBe(5 * 60_000);
  });
});

describe('recenterRequested', () => {
  it('an explicit show_recenter wins', () => {
    expect(recenterRequested({ show_recenter: false, presets: [BAY] })).toBe(false);
    expect(recenterRequested({ show_recenter: true })).toBe(true);
  });

  it('defaults to on once presets exist, since the button is how they are reached', () => {
    expect(recenterRequested({ presets: [BAY] } as never)).toBe(true);
    expect(recenterRequested({ presets: [] } as never)).toBe(false);
    expect(recenterRequested({} as never)).toBe(false);
  });
});

describe('presetPosition', () => {
  it("uses the entity's position", () => {
    const hass = mockHass({ states: ME as never });
    expect(presetPosition({ entity: 'person.me', latitude: 1, longitude: 2 }, hass)).toEqual({ lat: 37.0, lon: -121.9 });
  });

  it('falls back to the coordinates when the entity reports no position', () => {
    const hass = mockHass({ states: { 'person.me': { state: 'unavailable', attributes: {} } } as never });
    expect(presetPosition({ entity: 'person.me', latitude: 1, longitude: 2 }, hass)).toEqual({ lat: 1, lon: 2 });
    expect(presetPosition({ entity: 'person.me' }, hass)).toBeNull();
  });

  it('needs both coordinates', () => {
    expect(presetPosition({ latitude: 1 }, mockHass())).toBeNull();
  });
});

describe('presetName', () => {
  const hass = mockHass({ states: { ...ME, 'device_tracker.van': entityState(1, 2) } as never });

  it('prefers the trimmed name', () => {
    expect(presetName({ name: '  Lake  ', entity: 'person.me' }, 0, hass)).toBe('Lake');
  });

  it("falls back to the entity's friendly name, then its id", () => {
    expect(presetName({ name: ' ', entity: 'person.me' }, 0, hass)).toBe('Me');
    expect(presetName({ entity: 'device_tracker.van' }, 0, hass)).toBe('device_tracker.van');
  });

  it("uses the id for an entity that is gone or has no attributes", () => {
    expect(presetName({ entity: 'person.gone' }, 0, hass)).toBe('person.gone');
    const bare = mockHass({ states: { 'person.bare': { state: 'home' } } as never });
    expect(presetName({ entity: 'person.bare' }, 0, bare)).toBe('person.bare');
  });

  it('numbers an unnamed location from 1', () => {
    expect(presetName({ latitude: 1, longitude: 2 }, 2, hass)).toBe('Preset 3');
  });
});

describe('liveTrackedStop', () => {
  it('is the tracked marker while its entity reports a position', () => {
    const hass = mockHass({ states: ME as never });
    expect(liveTrackedStop([{ entity: 'person.me', track: 'entity' }], hass))
      .toEqual({ lat: 37.0, lon: -121.9, entity: 'person.me', name: 'Me' });
  });

  it('is null when the tracked entity has no position, or the tracked marker is static', () => {
    const hass = mockHass({ states: { 'person.me': { state: 'unknown', attributes: {} } } as never });
    expect(liveTrackedStop([{ entity: 'person.me', track: 'entity' }], hass)).toBeNull();
    expect(liveTrackedStop([{ latitude: 1, longitude: 2, track: true }], hass)).toBeNull();
    expect(liveTrackedStop([{ entity: 'person.me' }], mockHass({ states: ME as never }))).toBeNull();
  });
});

describe('nextStop', () => {
  const stops = ['tracked', 'default', 0, 1] as const;

  it('moves on from a stop the map is on, wrapping at the end', () => {
    expect(nextStop([...stops], 'default', true)).toBe(0);
    expect(nextStop([...stops], 1, true)).toBe('tracked');
  });

  it('returns to the current stop when the map has left it', () => {
    expect(nextStop([...stops], 0, false)).toBe(0);
  });

  it('starts over when the current stop is gone', () => {
    expect(nextStop(['default', 1], 0, true)).toBe('default');
  });
});

describe('ViewPresets rotation', () => {
  it('without tracking: Default, then each preset, then Default', () => {
    const { vp, view, last } = setup({ presets: [BAY, { entity: 'person.me' }] }, ME);

    vp.recenter();
    expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
    expect(last()).toEqual({ held: 0, label: 'Bay Area', sticky: true });
    expect(vp.isHolding).toBe(true);

    vp.recenter();
    expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 7 });
    expect(last()).toEqual({ held: 1, label: 'Me', sticky: true });

    vp.recenter();
    expect(view()).toEqual({ ...HOME, zoom: 7 });
    expect(last()).toEqual({ held: null, label: 'Default', sticky: false });
    expect(vp.isHolding).toBe(false);
  });

  it('with a live tracked marker: it is the resting stop, and Default is held like a preset', () => {
    const { map, vp, view, last } = setup(
      { markers: [{ entity: 'person.me', track: 'entity' }], presets: [BAY] }, ME,
    );
    map.setView([37.0, -121.9], 7);   // where tracking has the map

    vp.recenter();
    expect(view()).toEqual({ ...HOME, zoom: 7 });
    expect(last()).toEqual({ held: 'default', label: 'Default', sticky: false });
    expect(vp.isHolding).toBe(true);

    vp.recenter();
    expect(last()).toEqual({ held: 0, label: 'Bay Area', sticky: true });

    vp.recenter();
    expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 7 });
    expect(last()).toEqual({ held: null, label: 'Me', sticky: false });
    expect(vp.isHolding).toBe(false);
  });

  it('without presets, a tracked marker and Default take turns', () => {
    const { map, vp, view, last } = setup({ markers: [{ entity: 'person.me', track: 'entity' }] }, ME);
    map.setView([37.0, -121.9], 7);
    vp.recenter();
    expect(view()).toEqual({ ...HOME, zoom: 7 });
    expect(last()).toEqual({ held: 'default', label: 'Default', sticky: false });
    vp.recenter();
    expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 7 });
    expect(last()).toEqual({ held: null, label: 'Me', sticky: false });
  });

  it('with only Default, a press re-centres without a label', () => {
    const { map, vp, view, last } = setup({});
    expect(vp.nextLabel()).toBe('Re-centre');
    map.setView([30, -100], 5);
    vp.recenter();
    expect(view()).toEqual({ ...HOME, zoom: 7 });
    expect(last()).toEqual({ held: null, label: null, sticky: false });
    vp.recenter();
    expect(view()).toEqual({ ...HOME, zoom: 7 });
    expect(vp.isHolding).toBe(false);
  });

  describe('a preset of the tracked entity', () => {
    const tracked = { markers: [{ entity: 'person.me', track: 'entity' as const }] };

    it('at the card\'s zoom is left out: the tracked stop already shows it', () => {
      for (const zoom of [undefined, 7]) {
        const { map, vp, last } = setup({ ...tracked, presets: [{ entity: 'person.me', zoom }, BAY] }, ME);
        map.setView([37.0, -121.9], 7);
        vp.recenter();
        vp.recenter();
        expect(last().held).toBe(1);
      }
    });

    it('at another zoom is a stop of its own, at its zoom', () => {
      const { map, vp, view, last } = setup({ ...tracked, presets: [{ entity: 'person.me', zoom: 12 }] }, ME);
      map.setView([37.0, -121.9], 7);
      vp.recenter();
      vp.recenter();
      expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 12 });
      expect(last()).toEqual({ held: 0, label: 'Me', sticky: true });
      vp.recenter();
      expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 7 });   // tracked, at the card's zoom
      expect(last().held).toBeNull();
    });

    it('compares zooms as the map applies them', () => {
      const { map, vp, last } = setup({ ...tracked, zoom_level: 16, presets: [{ entity: 'person.me', zoom: 18 }, BAY] }, ME);
      map.setView([37.0, -121.9], 16);
      vp.recenter();
      vp.recenter();
      expect(last().held).toBe(1);
    });

    it('stays when the tracked marker is a different entity', () => {
      const { map, vp, last } = setup(
        { ...tracked, presets: [{ entity: 'device_tracker.van' }] },
        { ...ME, 'device_tracker.van': entityState(37.5, -122.0) },
      );
      map.setView([37.0, -121.9], 7);
      vp.recenter();
      vp.recenter();
      expect(last().held).toBe(0);
    });
  });

  it('a press after panning or zooming away returns to the current stop', () => {
    const { map, vp, view, last } = setup({ presets: [BAY, { latitude: 40, longitude: -100 }] });
    vp.recenter();
    map.panTo([38.5, -121]);
    vp.recenter();
    expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
    expect(last().held).toBe(0);

    map.setZoom(11);
    vp.recenter();
    expect(view().zoom).toBe(9);
    expect(last().held).toBe(0);
  });

  it('skips a preset that has no position', () => {
    const { vp, last } = setup(
      { presets: [{ entity: 'person.gone' }, BAY] },
      { 'person.gone': { state: 'unavailable', attributes: {} } },
    );
    vp.recenter();
    expect(last().held).toBe(1);
  });

  it('a preset beyond the map\'s zoom range still moves on at the next press', () => {
    const { vp, view, last } = setup({ presets: [{ ...BAY, zoom: 18 }, { latitude: 40, longitude: -100 }] });
    vp.recenter();
    expect(view().zoom).toBe(16);   // Leaflet clamps setView to maxZoom
    vp.recenter();
    expect(last().held).toBe(1);
  });

  describe('clear', () => {
    it('returns to the live tracked marker', () => {
      const { vp, view, last } = setup(
        { markers: [{ entity: 'person.me', track: 'entity' }], presets: [BAY] }, ME,
      );
      vp.recenter();   // the map starts off the tracked marker: this press goes there
      vp.recenter();
      vp.recenter();
      expect(last().held).toBe(0);
      vp.clear();
      expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 7 });
      expect(last()).toEqual({ held: null, label: 'Me', sticky: false });
    });

    it('returns to Default when nothing tracked reports a position', () => {
      const { vp, view, last } = setup(
        { markers: [{ entity: 'person.me', track: 'entity' }], presets: [BAY] },
        { 'person.me': { state: 'unknown', attributes: {} } },
      );
      vp.recenter();
      expect(last().held).toBe(0);
      vp.clear();
      expect(view()).toEqual({ ...HOME, zoom: 7 });
      expect(last()).toEqual({ held: null, label: 'Default', sticky: false });
    });
  });

  describe('idle timeout', () => {
    it('returns to rest after 5 idle minutes by default', () => {
      vi.useFakeTimers();
      const { vp, view, last } = setup({ presets: [BAY] });
      vp.recenter();
      vi.advanceTimersByTime(5 * 60_000 - 1);
      expect(vp.isHolding).toBe(true);
      vi.advanceTimersByTime(1);
      expect(vp.isHolding).toBe(false);
      expect(view()).toEqual({ ...HOME, zoom: 7 });
      expect(last()).toEqual({ held: null, label: 'Default', sticky: false });
    });

    it('restarts on every touch', () => {
      vi.useFakeTimers();
      const { vp } = setup({ presets: [BAY] });
      vp.recenter();
      vi.advanceTimersByTime(4 * 60_000);
      vp.touch();
      vi.advanceTimersByTime(4 * 60_000);
      expect(vp.isHolding).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(vp.isHolding).toBe(false);
    });

    it('never fires with preset_timeout: 0', () => {
      vi.useFakeTimers();
      const { vp } = setup({ presets: [BAY], preset_timeout: 0 });
      vp.recenter();
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(vp.isHolding).toBe(true);
    });

    it('also ends a held Default, back to the tracked marker', () => {
      vi.useFakeTimers();
      const { map, vp, view } = setup(
        { markers: [{ entity: 'person.me', track: 'entity' }], presets: [BAY], preset_timeout: 1 }, ME,
      );
      map.setView([37.0, -121.9], 7);
      vp.recenter();
      expect(vp.isHolding).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(vp.isHolding).toBe(false);
      expect(view()).toEqual({ lat: 37.0, lon: -121.9, zoom: 7 });
    });

    it('touching the map at rest arms nothing', () => {
      vi.useFakeTimers();
      const { vp, changes } = setup({ presets: [BAY] });
      vp.touch();
      vi.advanceTimersByTime(10 * 60_000);
      expect(changes).toHaveLength(0);
    });

    it('is cancelled by going back to rest', () => {
      vi.useFakeTimers();
      const { vp, changes } = setup({ presets: [BAY] });
      vp.recenter();
      vp.clear();
      vi.advanceTimersByTime(10 * 60_000);
      expect(changes).toHaveLength(2);
    });

    it('is cancelled by drop', () => {
      vi.useFakeTimers();
      const { vp, changes, view } = setup({ presets: [BAY] });
      vp.recenter();
      vp.drop();
      vi.advanceTimersByTime(10 * 60_000);
      expect(changes).toHaveLength(2);
      expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
    });

    it('is cancelled by dispose', () => {
      vi.useFakeTimers();
      const { vp, changes } = setup({ presets: [BAY] });
      vp.recenter();
      vp.dispose();
      vi.advanceTimersByTime(10 * 60_000);
      expect(changes).toHaveLength(1);
    });
  });

  describe('follow', () => {
    it('keeps a held entity preset in view as it moves, ignoring jitter', () => {
      const { map, vp, ctx, view } = setup({ presets: [{ entity: 'device_tracker.van', zoom: 12 }] },
        { 'device_tracker.van': entityState(37.5, -122.0) });
      vp.recenter();
      const panTo = vi.spyOn(map, 'panTo');
      ctx.hass = mockHass({ states: { 'device_tracker.van': entityState(37.50008, -122.0) } as never });
      vp.follow();
      expect(panTo).not.toHaveBeenCalled();
      ctx.hass = mockHass({ states: { 'device_tracker.van': entityState(37.52, -122.0) } as never });
      vp.follow();
      expect(view()).toEqual({ lat: 37.52, lon: -122.0, zoom: 12 });
      // Measured from where it last panned, not from where the preset started.
      ctx.hass = mockHass({ states: { 'device_tracker.van': entityState(37.52008, -122.0) } as never });
      vp.follow();
      expect(panTo).toHaveBeenCalledOnce();
    });

    it('does nothing at rest or on a fixed preset', () => {
      const { vp, ctx, view } = setup({ presets: [BAY] }, { 'device_tracker.van': entityState(37.5, -122.0) });
      vp.follow();
      expect(view()).toEqual({ ...HOME, zoom: 7 });
      vp.recenter();
      ctx.hass = mockHass({ states: { 'device_tracker.van': entityState(30, -100) } as never });
      vp.follow();
      expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
    });
  });

  describe('edit', () => {
    it('holds the preset open in the editor, with no idle timeout', () => {
      vi.useFakeTimers();
      const { vp, view, last } = setup({ presets: [BAY, { latitude: 40, longitude: -100 }] });
      vp.edit(1);
      expect(view()).toEqual({ lat: 40, lon: -100, zoom: 7 });
      expect(last()).toEqual({ held: 1, label: 'Preset 2', sticky: true });
      vi.advanceTimersByTime(60 * 60_000);
      expect(vp.isHolding).toBe(true);
    });

    it('re-showing the preset already in view leaves the map still', () => {
      const { map, vp } = setup({ presets: [BAY] });
      vp.edit(0);
      const setView = vi.spyOn(map, 'setView');
      vp.edit(0);
      expect(setView).not.toHaveBeenCalled();
    });

    it('moves the map when the preset being edited changes', () => {
      const { vp, ctx, view } = setup({ presets: [BAY] });
      vp.edit(0);
      ctx.cfg = { ...ctx.cfg, presets: [{ ...BAY, latitude: 38 }] };
      vp.edit(0);
      expect(view()).toEqual({ lat: 38, lon: -122.2, zoom: 9 });
    });

    it('holds a preset with no position yet without moving the map', () => {
      const { vp, view } = setup({ presets: [{}] });
      vp.edit(0);
      expect(vp.isHolding).toBe(true);
      expect(view()).toEqual({ ...HOME, zoom: 7 });
    });

    it('null returns to rest, and the idle timeout applies again', () => {
      vi.useFakeTimers();
      const { vp, view } = setup({ presets: [BAY] });
      vp.edit(0);
      vp.edit(null);
      expect(vp.isHolding).toBe(false);
      expect(view()).toEqual({ ...HOME, zoom: 7 });
      vp.recenter();
      vi.advanceTimersByTime(5 * 60_000);
      expect(vp.isHolding).toBe(false);
    });

    it('re-centre and the chip return to the open preset instead of rotating', () => {
      const { map, vp, view } = setup({ presets: [BAY, { latitude: 40, longitude: -100 }] });
      vp.edit(0);
      expect(vp.nextLabel()).toBe('Bay Area');
      vp.recenter();
      expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
      expect(vp.held).toBe(0);
      map.setView([30, -90], 5);
      vp.recenter();
      expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
      map.setView([30, -90], 5);
      vp.clear();
      expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
      expect(vp.held).toBe(0);
    });

    it('null with nothing open leaves the map alone', () => {
      const { vp, changes } = setup({ presets: [BAY] });
      vp.recenter();
      vp.edit(null);
      expect(changes).toHaveLength(1);
      expect(vp.isHolding).toBe(true);
    });
  });

  it('drop at rest does nothing', () => {
    const { vp, changes } = setup({ presets: [BAY] });
    vp.drop();
    expect(changes).toHaveLength(0);
  });

  it('drop forgets the held stop without moving the map', () => {
    const { vp, view, last } = setup({ presets: [BAY] });
    vp.recenter();
    vp.drop();
    expect(vp.isHolding).toBe(false);
    expect(last()).toEqual({ held: null, label: null, sticky: false });
    expect(view()).toEqual({ lat: 37.6, lon: -122.2, zoom: 9 });
  });

  it('nextLabel names where the next press goes', () => {
    const { map, vp } = setup({ presets: [BAY] });
    expect(vp.nextLabel()).toBe('Bay Area');
    vp.recenter();
    expect(vp.nextLabel()).toBe('Default');
    map.panTo([30, -100]);
    expect(vp.nextLabel()).toBe('Bay Area');
  });
});
