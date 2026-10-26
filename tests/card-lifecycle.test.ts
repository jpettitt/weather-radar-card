/* eslint-disable @typescript-eslint/no-explicit-any */
// Mounts the real card element under happy-dom. Only the radar player (frame
// network) is faked; fetch never settles, so no layer data arrives.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { players } = vi.hoisted(() => ({ players: [] as any[] }));
vi.mock('../src/radar-player', () => {
  class RadarPlayer {
    run = true; toolbar: unknown = null; frameCount = 0; paused = false;
    constructor(public opts: any) { players.push(this); }
    setSpeedMultiplier(): void {}
    start(): void {}
    clear(): void {}
    onNavPaused(): void {}
    onNavSettled(): void {}
    togglePlay(): void {}
    onVisibilityHidden(): void { this.paused = true; }
    onVisibilityVisible(): void { this.paused = false; }
  }
  return { RadarPlayer };
});

import '../src/weather-radar-card';
import { _resetLiveCardsForTests } from '../src/viewer-state';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

// matchMedia with a flip() that fires every registered change listener.
function installMatchMedia(initialDark: boolean): { flip: (dark: boolean) => void } {
  let dark = initialDark;
  const mqls: Array<{ listeners: Array<() => void> }> = [];
  (window as any).matchMedia = vi.fn((q: string) => {
    const mql: any = {
      get matches() { return q.includes('dark') ? dark : false; },
      listeners: [] as Array<() => void>,
      addEventListener: (_t: string, fn: () => void) => { mql.listeners.push(fn); },
      removeEventListener: (_t: string, fn: () => void) => {
        mql.listeners = mql.listeners.filter((f: () => void) => f !== fn);
      },
    };
    mqls.push(mql);
    return mql;
  });
  return {
    flip: (d: boolean) => {
      dark = d;
      for (const m of [...mqls]) for (const l of [...m.listeners]) l();
    },
  };
}

// IntersectionObserver whose callbacks the test drives.
let ioCallbacks: Array<(e: any[]) => void> = [];
class FakeIO {
  constructor(cb: (e: any[]) => void) { ioCallbacks.push(cb); }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}
const reportIntersecting = (on: boolean): void => ioCallbacks[ioCallbacks.length - 1]([{ isIntersecting: on }]);

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

function makeHass(over: Record<string, unknown> = {}): any {
  return {
    config: { latitude: 51, longitude: 0, unit_system: { length: 'km' }, components: [], time_zone: 'UTC' },
    states: {}, themes: { darkMode: false }, language: 'en', locale: { language: 'en' },
    user: { id: 'u1', name: 'Viewer' },
    callWS: vi.fn(async () => ({ value: {} })),
    ...over,
  };
}

function makeCard(config: Record<string, unknown> = {}): any {
  const el: any = document.createElement('weather-radar-card');
  el.setConfig({ type: 'custom:weather-radar-card', ...config });
  return el;
}

async function mount(config: Record<string, unknown>, hass: any): Promise<any> {
  const el = makeCard(config);
  el.hass = hass;
  document.body.appendChild(el);
  await el.updateComplete;
  await tick();
  return el;
}

const playersOf = (el: any): any[] => players.filter((p) => p.opts.shadowRoot === el.shadowRoot);

const realIO = (globalThis as any).IntersectionObserver;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  players.length = 0;
  ioCallbacks = [];
  _resetLiveCardsForTests();
  (globalThis as any).IntersectionObserver = FakeIO;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as any).hidden;   // back to the prototype getter
  (globalThis as any).IntersectionObserver = realIO;
  (window as any).matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OS colour-scheme change (map_style auto)', () => {
  it('rebuilds once when HA follows the OS: hass update, then the media query event', async () => {
    const mm = installMatchMedia(false);
    const el = await mount({}, makeHass({ themes: { darkMode: false } }));
    expect(playersOf(el)).toHaveLength(1);
    el.hass = makeHass({ themes: { darkMode: true } });
    await el.updateComplete;
    await tick();
    expect(playersOf(el)).toHaveLength(2);
    mm.flip(true);
    await tick();
    expect(playersOf(el)).toHaveLength(2);
  });

  it('does not rebuild when theme_mode pins the style', async () => {
    const mm = installMatchMedia(false);
    const el = await mount({ theme_mode: 'light' }, makeHass());
    const style = el._currentMapStyle;
    mm.flip(true);
    await tick();
    expect(el._currentMapStyle).toBe(style);
    expect(playersOf(el)).toHaveLength(1);
  });

  it('still rebuilds when HA exposes no dark-mode flag and the OS flip changes the style', async () => {
    const mm = installMatchMedia(false);
    const el = await mount({}, makeHass({ themes: {} }));
    const style = el._currentMapStyle;
    mm.flip(true);
    await tick();
    expect(el._currentMapStyle).not.toBe(style);
    expect(playersOf(el)).toHaveLength(2);
  });
});

describe('card detached by HA visibility conditions', () => {
  it('does not build a map from a hass update while detached', async () => {
    installMatchMedia(false);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const el = makeCard();
    el.hass = makeHass();
    host.appendChild(el);
    await el.updateComplete;
    await tick();
    expect(el._map).not.toBeNull();
    host.removeChild(el);              // hui-card: condition false
    expect(el._map).toBeNull();
    el.hass = makeHass();              // hui-card keeps assigning hass
    await el.updateComplete;
    await tick();
    expect(el._map).toBeNull();
    expect(el._resizeObserver).toBeNull();
    expect(players).toHaveLength(1);
    host.appendChild(el);              // condition true again
    await tick();
    expect(el._map).not.toBeNull();
    expect(players).toHaveLength(2);
  });
});

describe('hass assigned after the card is connected', () => {
  it('builds the map at the HA home location with a viewer store', async () => {
    installMatchMedia(false);
    const el = makeCard({ viewer_layer_control: true });
    document.body.appendChild(el);
    await el.updateComplete;
    await tick();
    expect(el._map).toBeNull();
    el.hass = makeHass();              // home 51, 0
    await el.updateComplete;
    await tick();
    const c = el._map.getCenter();
    expect(Math.round(c.lat)).toBe(51);
    expect(Math.round(c.lng)).toBe(0);
    expect(el._viewerState).not.toBeNull();
    expect(players).toHaveLength(1);
  });
});

describe('off-screen card and a tab switch', () => {
  it('stays paused after the tab comes back while the card is still scrolled away', async () => {
    installMatchMedia(false);
    const el = await mount({ show_wildfires: true }, makeHass());
    const p = playersOf(el)[0];
    const wf = el._wildfireLayer;
    reportIntersecting(false);
    expect(p.paused).toBe(true);
    setDocumentHidden(true);
    setDocumentHidden(false);
    expect(p.paused).toBe(true);
    expect(wf._pausedAt).not.toBeNull();
    reportIntersecting(true);          // scrolled back into view
    expect(p.paused).toBe(false);
    expect(wf._pausedAt).toBeNull();
  });
});

describe('overlays started while the card is hidden', () => {
  const layerConfig = {
    viewer_layer_control: true,
    _layer_state_id: { dash: window.location.pathname, nonce: 'lc0test' },
  };

  // Holds the viewer-store read open so the overlays wait for hydrate.
  function hassWithPendingRead(): { hass: any; answer: () => void } {
    let resolve!: (v: unknown) => void;
    const hass = makeHass({
      callWS: vi.fn((m: any) => (m.type === 'frontend/get_user_data'
        ? new Promise((r) => { resolve = r; })
        : Promise.resolve(null))),
    });
    return { hass, answer: () => resolve({ value: {} }) };
  }

  it('pauses an overlay that hydrate starts after a tab hide', async () => {
    installMatchMedia(false);
    const { hass, answer } = hassWithPendingRead();
    const el = await mount({ ...layerConfig, show_wildfires: true }, hass);
    expect(el._viewerState.isActive).toBe(true);
    expect(el._wildfireLayer).toBeNull();          // held until hydrate
    setDocumentHidden(true);
    answer();
    await tick();
    expect(el._wildfireLayer).not.toBeNull();
    expect(el._wildfireLayer._pausedAt).not.toBeNull();
  });

  it('pauses wind and alert overlays that hydrate starts after the card scrolled away', async () => {
    installMatchMedia(false);
    // happy-dom has no 2D canvas; the streamline overlay only needs no-op calls.
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as any);
    const { hass, answer } = hassWithPendingRead();
    const el = await mount({
      ...layerConfig, show_alerts: true, dwd_wind: 'barbs', dwd_wind_flow: true,
    }, hass);
    expect(el._windFlow).toBeNull();
    reportIntersecting(false);                     // below the fold at load
    answer();
    await tick();
    expect(el._windOverlay?._paused).toBe(true);
    expect(el._windFlow?._paused).toBe(true);
    expect(el._alertsLayer?._pausedAt).not.toBeNull();
    reportIntersecting(true);
    expect(el._windFlow._paused).toBe(false);
    expect(el._alertsLayer._pausedAt).toBeNull();
  });
});
