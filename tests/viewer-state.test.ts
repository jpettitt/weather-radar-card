// Tests for the ViewerState framework — identity minting, dashboard-path
// re-mint, within-dashboard copy-paste collision detection, WS storage
// round-trip, debounced writes, sparse storage via delete, reset,
// subscribe/unsubscribe, and graceful degradation on WS failure.
//
// HA's hass.callWS is fully mocked — these tests don't need a real HA
// connection. happy-dom provides window.location.pathname.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ViewerState,
  _resetLiveCardsForTests,
  _liveCardsForTests,
  type LayerStateId,
  type ViewerStateChange,
} from '../src/viewer-state';
import type { WeatherRadarCardConfig } from '../src/types';
import type { HomeAssistant } from 'custom-card-helpers';

// ── Helpers ──────────────────────────────────────────────────────────────

interface MockSetup {
  hass: HomeAssistant;
  callWS: ReturnType<typeof vi.fn>;
  config: WeatherRadarCardConfig;
  setConfig: (next: Partial<WeatherRadarCardConfig>) => void;
  onIdentityMinted: ReturnType<typeof vi.fn>;
  state: ViewerState;
}

function makeState(initial: Partial<WeatherRadarCardConfig> = {}): MockSetup {
  const callWS = vi.fn(async () => ({}));
  const hass = { callWS } as unknown as HomeAssistant;

  let config: WeatherRadarCardConfig = {
    type: 'custom:weather-radar-card',
    ...initial,
  } as WeatherRadarCardConfig;

  const onIdentityMinted = vi.fn((id: LayerStateId) => {
    config = { ...config, _layer_state_id: id };
  });

  const state = new ViewerState({
    hass,
    getConfig: () => config,
    onIdentityMinted,
  });

  return {
    hass,
    callWS,
    config,
    setConfig: (next) => { config = { ...config, ...next }; },
    onIdentityMinted,
    state,
  };
}

beforeEach(() => {
  _resetLiveCardsForTests();
  // happy-dom defaults to about:blank — set a predictable path
  window.history.replaceState({}, '', '/lovelace/0');
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Identity minting ─────────────────────────────────────────────────────

describe('ViewerState — identity minting', () => {
  it('does not mint when viewer_layer_control is off', () => {
    const m = makeState();
    m.state.ensureIdentity();
    expect(m.onIdentityMinted).not.toHaveBeenCalled();
    expect(m.state.isActive).toBe(false);
  });

  it('mints when viewer_layer_control is on and no id present', () => {
    const m = makeState({ viewer_layer_control: true });
    m.state.ensureIdentity();
    expect(m.onIdentityMinted).toHaveBeenCalledOnce();
    const minted = m.onIdentityMinted.mock.calls[0][0] as LayerStateId;
    expect(minted.dash).toBe('/lovelace/0');
    expect(minted.nonce).toMatch(/^[a-z0-9]{1,9}$/);
  });

  it('does not yet activate after the mint callback — waits for setConfig round-trip', () => {
    const m = makeState({ viewer_layer_control: true });
    m.state.ensureIdentity();
    // After mint but before card re-calls ensureIdentity with the new id,
    // we should still be inactive (strict consistency with persisted state).
    expect(m.state.isActive).toBe(false);
  });

  it('activates on second ensureIdentity after onIdentityMinted updates the config', () => {
    const m = makeState({ viewer_layer_control: true });
    m.state.ensureIdentity();
    const minted = m.onIdentityMinted.mock.calls[0][0] as LayerStateId;
    // Card writes back the new id (the mock callback already did this); a
    // subsequent setConfig fires another ensureIdentity.
    m.setConfig({ _layer_state_id: minted });
    m.state.ensureIdentity();
    expect(m.state.isActive).toBe(true);
    expect(m.state.storageKey).toBe(`weather-radar-card.viewer-state.${minted.nonce}`);
  });

  it('re-mints when dashboard path mismatches the stored dash', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/old-dashboard/0', nonce: 'abc1234' },
    });
    m.state.ensureIdentity();
    expect(m.onIdentityMinted).toHaveBeenCalledOnce();
    const remint = m.onIdentityMinted.mock.calls[0][0] as LayerStateId;
    expect(remint.dash).toBe('/lovelace/0');
    expect(remint.nonce).not.toBe('abc1234');
  });

  it('keeps identity stable across repeated ensureIdentity calls when dash matches', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'abc1234' },
    });
    m.state.ensureIdentity();
    m.state.ensureIdentity();
    m.state.ensureIdentity();
    expect(m.onIdentityMinted).not.toHaveBeenCalled();
    expect(m.state.isActive).toBe(true);
  });

  it('deactivates when viewer_layer_control flips to off', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'abc1234' },
    });
    m.state.ensureIdentity();
    expect(m.state.isActive).toBe(true);
    m.setConfig({ viewer_layer_control: false });
    m.state.ensureIdentity();
    expect(m.state.isActive).toBe(false);
    expect(_liveCardsForTests().size).toBe(0);
  });
});

// ── Within-dashboard collision detection ─────────────────────────────────

describe('ViewerState — copy-paste collision', () => {
  it('two cards with the same nonce on the same dashboard cause the second to re-mint', () => {
    const id: LayerStateId = { dash: '/lovelace/0', nonce: 'duplic1' };

    const first = makeState({ viewer_layer_control: true, _layer_state_id: id });
    first.state.ensureIdentity();
    expect(first.state.isActive).toBe(true);

    const second = makeState({ viewer_layer_control: true, _layer_state_id: id });
    second.state.ensureIdentity();

    // First card retains its identity; second re-mints.
    expect(first.onIdentityMinted).not.toHaveBeenCalled();
    expect(second.onIdentityMinted).toHaveBeenCalledOnce();
    expect(_liveCardsForTests().size).toBe(1);
    expect(_liveCardsForTests().get('duplic1')).toBe(first.state);
  });

  it('dispose releases the nonce so a later card can claim it', () => {
    const id: LayerStateId = { dash: '/lovelace/0', nonce: 'releas1' };

    const first = makeState({ viewer_layer_control: true, _layer_state_id: id });
    first.state.ensureIdentity();
    first.state.dispose();
    expect(_liveCardsForTests().size).toBe(0);

    const second = makeState({ viewer_layer_control: true, _layer_state_id: id });
    second.state.ensureIdentity();
    expect(second.onIdentityMinted).not.toHaveBeenCalled();
    expect(second.state.isActive).toBe(true);
  });
});

// ── Hydration + get ──────────────────────────────────────────────────────

describe('ViewerState — hydration + get', () => {
  it('reads the persisted state via callWS and exposes it via get', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'hydra01' },
    });
    m.state.ensureIdentity();
    m.callWS.mockResolvedValueOnce({ value: { playback_speed: 2, foo: 'bar' } });

    await m.state.hydrate();

    expect(m.callWS).toHaveBeenCalledWith({
      type: 'frontend/get_user_data',
      key: 'weather-radar-card.viewer-state.hydra01',
    });
    expect(m.state.get<number>('playback_speed')).toBe(2);
    expect(m.state.get<string>('foo')).toBe('bar');
    expect(m.state.get<unknown>('missing')).toBeUndefined();
  });

  it('treats a null WS response as empty cache', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'hydra02' },
    });
    m.state.ensureIdentity();
    m.callWS.mockResolvedValueOnce(null);

    await m.state.hydrate();
    expect(m.state.get<unknown>('anything')).toBeUndefined();
  });

  it('hydrate is a no-op when inactive', async () => {
    const m = makeState(); // no viewer_layer_control
    await m.state.hydrate();
    expect(m.callWS).not.toHaveBeenCalled();
  });

  it('hydrate is idempotent — second call does not re-read', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'hydra03' },
    });
    m.state.ensureIdentity();
    m.callWS.mockResolvedValue({ value: { x: 1 } });
    await m.state.hydrate();
    await m.state.hydrate();
    expect(m.callWS).toHaveBeenCalledOnce();
  });

  it('logs once and degrades gracefully on hydrate WS failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'hydra04' },
    });
    m.state.ensureIdentity();
    m.callWS.mockRejectedValueOnce(new Error('ws unavailable'));

    await m.state.hydrate();
    expect(warn).toHaveBeenCalledOnce();
    expect(m.state.get<unknown>('anything')).toBeUndefined();
    warn.mockRestore();
  });
});

// ── Set + debounced writes ───────────────────────────────────────────────

describe('ViewerState — set + debounced writes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('updates the in-memory cache immediately', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'setcac1' },
    });
    m.state.ensureIdentity();
    m.state.set('playback_speed', 4);
    expect(m.state.get<number>('playback_speed')).toBe(4);
  });

  it('debounces the WS write — multiple rapid sets coalesce to one write', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'setdeb1' },
    });
    m.state.ensureIdentity();
    m.state.set('a', 1);
    m.state.set('b', 2);
    m.state.set('a', 3); // overrides earlier 'a'
    expect(m.callWS).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    // The flush hydrates first (one get_user_data — the persisted
    // record is the union of every key ever set, so writing a
    // pre-hydrate cache would wipe keys from previous sessions), then
    // does exactly ONE coalesced set_user_data.
    const setCalls = m.callWS.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'frontend/set_user_data',
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toEqual({
      type: 'frontend/set_user_data',
      key: 'weather-radar-card.viewer-state.setdeb1',
      value: { a: 3, b: 2 },
    });
  });

  it('set is a no-op when inactive (no WS call, no cache mutation)', () => {
    const m = makeState();
    m.state.set('playback_speed', 4);
    expect(m.state.get<number>('playback_speed')).toBeUndefined();
    expect(m.callWS).not.toHaveBeenCalled();
  });

  it('set with the same value as the existing cache entry is a no-op', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'setdup1' },
    });
    m.state.ensureIdentity();
    const listener = vi.fn();
    m.state.subscribe(listener);
    m.state.set('a', 1);
    m.state.set('a', 1); // duplicate
    expect(listener).toHaveBeenCalledOnce();
  });
});

// ── Delete (sparse storage) ──────────────────────────────────────────────

describe('ViewerState — delete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('removes the key and triggers a debounced write', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'delkey1' },
    });
    m.state.ensureIdentity();
    m.state.set('a', 1);
    m.state.set('b', 2);
    m.callWS.mockClear();
    m.state.delete('a');

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();

    expect(m.state.get<number>('a')).toBeUndefined();
    expect(m.state.get<number>('b')).toBe(2);
    expect(m.callWS).toHaveBeenCalledWith({
      type: 'frontend/set_user_data',
      key: 'weather-radar-card.viewer-state.delkey1',
      value: { b: 2 },
    });
  });

  it('delete of an absent key is a no-op', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'delnop1' },
    });
    m.state.ensureIdentity();
    const listener = vi.fn();
    m.state.subscribe(listener);
    m.state.delete('missing');
    expect(listener).not.toHaveBeenCalled();
    expect(m.callWS).not.toHaveBeenCalled();
  });
});

// ── Reset ────────────────────────────────────────────────────────────────

describe('ViewerState — reset', () => {
  it('clears the cache and writes an empty object synchronously', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'rsetkey' },
    });
    m.state.ensureIdentity();
    m.state.set('a', 1);
    m.state.set('b', 2);
    m.callWS.mockClear();

    await m.state.reset();

    expect(m.state.get<unknown>('a')).toBeUndefined();
    expect(m.state.get<unknown>('b')).toBeUndefined();
    expect(m.callWS).toHaveBeenCalledOnce();
    expect(m.callWS).toHaveBeenCalledWith({
      type: 'frontend/set_user_data',
      key: 'weather-radar-card.viewer-state.rsetkey',
      value: {},
    });
  });
});

// ── Subscribe ────────────────────────────────────────────────────────────

describe('ViewerState — subscribe', () => {
  it('fires listeners on set / delete / reset / hydrate', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'subscr1' },
    });
    m.state.ensureIdentity();
    const events: ViewerStateChange[] = [];
    m.state.subscribe(e => events.push(e));

    m.callWS.mockResolvedValueOnce({ value: { x: 9 } });
    await m.state.hydrate();
    m.state.set('a', 1);
    m.state.delete('a');
    await m.state.reset();

    expect(events.map(e => e.source)).toEqual(['hydrate', 'set', 'delete', 'reset']);
  });

  it('returned unsubscribe stops the listener', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'subuns1' },
    });
    m.state.ensureIdentity();
    const listener = vi.fn();
    const off = m.state.subscribe(listener);
    m.state.set('a', 1);
    off();
    m.state.set('a', 2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('isolates listener exceptions so a thrower does not block others', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'subisol' },
    });
    m.state.ensureIdentity();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = vi.fn();
    m.state.subscribe(() => { throw new Error('boom'); });
    m.state.subscribe(good);
    m.state.set('a', 1);
    expect(good).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ── Dispose ──────────────────────────────────────────────────────────────

describe('ViewerState — dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('flushes the pending write before deregistering the nonce', async () => {
    // Regression: dispose() used to DROP the pending debounced write,
    // silently losing up to 500 ms of the user's most recent changes on
    // every card teardown (dashboard navigation, edit mode, view
    // switches). It must flush instead. Hydrate first so the flush
    // doesn't take the wait-for-hydrate path (covered separately).
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'dispos1' },
    });
    m.state.ensureIdentity();
    await m.state.hydrate();
    m.state.set('a', 1);   // schedules a write 500ms out
    m.state.dispose();     // must flush it, not drop it

    await vi.runAllTimersAsync();
    const setCalls = m.callWS.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'frontend/set_user_data',
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toMatchObject({ value: { a: 1 } });
    expect(_liveCardsForTests().size).toBe(0);
  });

  it('dispose without a pending write makes no WS call', () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'dispos2' },
    });
    m.state.ensureIdentity();
    m.state.dispose();
    vi.advanceTimersByTime(1000);
    expect(m.callWS).not.toHaveBeenCalled();
    expect(_liveCardsForTests().size).toBe(0);
  });
});

// ── Hydrate/set races (regressions from the 2026-06-09 review) ──────────

describe('ViewerState — hydrate/set races', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('set() during the hydrate round-trip survives the hydrate (merge-under)', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'race001' },
    });
    m.state.ensureIdentity();

    // get_user_data resolves only when we release it, so we can
    // interleave a set() mid-flight.
    let releaseGet!: (v: unknown) => void;
    m.callWS.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'frontend/get_user_data') {
        return new Promise((res) => { releaseGet = res; });
      }
      return Promise.resolve({});
    });

    const hydratePromise = m.state.hydrate();
    m.state.set('playback_speed', 4);          // optimistic write mid-hydrate
    releaseGet({ value: { other_key: 'persisted' } });
    await hydratePromise;

    // The optimistic key survives; the persisted key arrives underneath.
    expect(m.state.get('playback_speed')).toBe(4);
    expect(m.state.get('other_key')).toBe('persisted');
  });

  it('flush before hydrate completes does not wipe previously persisted keys', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'race002' },
    });
    m.state.ensureIdentity();
    m.callWS.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'frontend/get_user_data') {
        return Promise.resolve({ value: { old_key: 'precious' } });
      }
      return Promise.resolve({});
    });

    // set() with NO hydrate() call beforehand — the debounced flush
    // fires first. It must hydrate internally and write the union,
    // not just the fresh key (which would destroy old_key on disk).
    m.state.set('playback_speed', 2);
    await vi.runAllTimersAsync();

    const setCalls = m.callWS.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'frontend/set_user_data',
    );
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toMatchObject({
      value: { old_key: 'precious', playback_speed: 2 },
    });
  });

  it('concurrent hydrate() calls share one WS round-trip', async () => {
    const m = makeState({
      viewer_layer_control: true,
      _layer_state_id: { dash: '/lovelace/0', nonce: 'race003' },
    });
    m.state.ensureIdentity();
    const p1 = m.state.hydrate();
    const p2 = m.state.hydrate();
    await Promise.all([p1, p2]);
    const getCalls = m.callWS.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'frontend/get_user_data',
    );
    expect(getCalls).toHaveLength(1);
  });
});
