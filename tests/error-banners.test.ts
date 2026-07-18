// Tests for the rate-limit / server-error banner lifecycle on RadarPlayer.
//
// Regression coverage for two things fixed together (issue #223):
//   1. A 5xx (server error) used to be indistinguishable from a 429
//      (rate limit) once the fetch error lost its status code — see
//      tests/fetch-abort.test.ts for the fetch-layer half of this.
//   2. The rate-limit banner never explicitly hid itself once shown —
//      it just sat there until the next full teardown/rebuild. Both
//      banners now clear the instant any tile succeeds again, via the
//      same onTileRecovered signal, and that recovery also cancels the
//      rate-limit path's fallback reinit timer so a freshly-recovered
//      loop doesn't get torn down 10s later for no reason.
//
// Follows the "stub Leaflet, test the helpers" convention. Private
// methods are reached via `as any` (TS-private is compile-time only).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// A minimal DOM stand-in: getElementById returns a stable per-id element
// (style object survives across calls, like a real shadow root) rather
// than a fresh object each time.
function makeShadowRoot(): { getElementById: (id: string) => any; host: unknown } {
  const elements = new Map<string, { style: Record<string, string> }>();
  return {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, { style: {} });
      return elements.get(id);
    },
    host: {},
  };
}

function makePlayer(shadowRoot: ReturnType<typeof makeShadowRoot>): RadarPlayer {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 7,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: shadowRoot as any,
    getConfig: () => ({ type: 'custom:weather-radar-card' } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('rate-limit banner', () => {
  it('shows on _onRateLimited and hides on _onTileRecovered', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;

    p._onRateLimited();
    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('block');

    p._onTileRecovered();
    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('none');
    expect(p._isRateLimited).toBe(false);
  });

  it('cancels the fallback reinit timer on recovery — no redundant teardown of a healthy loop', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onRateLimited();
    p._onTileRecovered();

    // The 10s fallback would otherwise fire here.
    vi.advanceTimersByTime(10_000);
    expect(p._clearLayers).not.toHaveBeenCalled();
    expect(p._initRadar).not.toHaveBeenCalled();
  });

  it('without recovery, the 10s fallback still tears down and reinitialises', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onRateLimited();
    vi.advanceTimersByTime(10_000);

    expect(p._clearLayers).toHaveBeenCalledOnce();
    expect(p._initRadar).toHaveBeenCalledOnce();
    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('none');
    expect(p._isRateLimited).toBe(false);
  });

  it('a second _onRateLimited while already showing does not reset the fallback timer', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onRateLimited();
    vi.advanceTimersByTime(6_000);
    p._onRateLimited(); // still rate-limited — guarded no-op, timer untouched
    vi.advanceTimersByTime(4_000); // total 10s from the FIRST call

    expect(p._clearLayers).toHaveBeenCalledOnce();
  });
});

describe('server-error banner', () => {
  it('shows on _onServerError and hides on _onTileRecovered', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;

    p._onServerError();
    expect(shadowRoot.getElementById('server-error-banner').style.display).toBe('block');

    p._onTileRecovered();
    expect(shadowRoot.getElementById('server-error-banner').style.display).toBe('none');
    expect(p._isServerError).toBe(false);
  });

  it('has no forced reinit — recovery is purely the banner clearing', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onServerError();
    p._onTileRecovered();
    vi.advanceTimersByTime(60_000);

    expect(p._clearLayers).not.toHaveBeenCalled();
    expect(p._initRadar).not.toHaveBeenCalled();
  });
});

describe('cross-transitions between the two banners', () => {
  it('a 5xx arriving while rate-limited cancels the pending fallback reinit', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onRateLimited(); // arms the 10s fallback reinit
    vi.advanceTimersByTime(5_000); // partway through the wait
    p._onServerError(); // a different tile comes back with a genuine 502

    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('block');
    expect(shadowRoot.getElementById('server-error-banner').style.display).toBe('block');

    // The fallback would have fired at the 10s mark; it must not now.
    vi.advanceTimersByTime(10_000);
    expect(p._clearLayers).not.toHaveBeenCalled();
    expect(p._initRadar).not.toHaveBeenCalled();
  });

  it('a 429 arriving while a server error is active shows its banner but arms no reinit', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onServerError(); // known server-side outage, no timer scheduled
    p._onRateLimited(); // a different tile also comes back statusless/429

    expect(shadowRoot.getElementById('server-error-banner').style.display).toBe('block');
    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('block');

    vi.advanceTimersByTime(30_000);
    expect(p._clearLayers).not.toHaveBeenCalled();
    expect(p._initRadar).not.toHaveBeenCalled();
  });

  it('recovering after a 5xx-then-429 sequence clears both banners with no stray timer', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn();

    p._onRateLimited();
    p._onServerError();
    p._onTileRecovered();

    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('none');
    expect(shadowRoot.getElementById('server-error-banner').style.display).toBe('none');

    vi.advanceTimersByTime(30_000);
    expect(p._clearLayers).not.toHaveBeenCalled();
    expect(p._initRadar).not.toHaveBeenCalled();
  });
});

describe('_onTileRecovered with nothing to recover from', () => {
  it('is a harmless no-op when neither banner is showing', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;

    expect(() => p._onTileRecovered()).not.toThrow();
    // Neither banner was ever shown, so _onTileRecovered's guards mean
    // .display was never touched at all — not even set to 'none'.
    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBeUndefined();
    expect(shadowRoot.getElementById('server-error-banner').style.display).toBeUndefined();
  });

  it('clears both banners independently when both are active', () => {
    const shadowRoot = makeShadowRoot();
    const p = makePlayer(shadowRoot) as any;

    p._onRateLimited();
    p._onServerError();
    p._onTileRecovered();

    expect(shadowRoot.getElementById('rate-limit-banner').style.display).toBe('none');
    expect(shadowRoot.getElementById('server-error-banner').style.display).toBe('none');
  });
});
