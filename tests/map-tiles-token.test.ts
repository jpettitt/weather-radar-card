/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { HomeAssistant } from 'custom-card-helpers';
import { attachMapTilesLayer, isMapTilesLoaded, startMapTilesToken } from '../src/map-tiles-token';

// Minimal hass mock — mirrors tests/lightning-helpers.test.ts's shape for
// isMapTilesLoaded, and tests/viewer-state.test.ts's callWS-mocking
// pattern for startMapTilesToken.
function hassWithComponents(components: unknown): HomeAssistant {
  return { config: { components } } as unknown as HomeAssistant;
}

describe('isMapTilesLoaded', () => {
  it('returns true when map_tiles is in the loaded components list', () => {
    expect(isMapTilesLoaded(hassWithComponents(['frontend', 'map_tiles', 'sun']))).toBe(true);
  });

  it('returns false when map_tiles is absent', () => {
    expect(isMapTilesLoaded(hassWithComponents(['frontend', 'sun']))).toBe(false);
  });

  it('returns false when components is empty', () => {
    expect(isMapTilesLoaded(hassWithComponents([]))).toBe(false);
  });

  it('returns false when components is missing', () => {
    expect(isMapTilesLoaded({ config: {} } as unknown as HomeAssistant)).toBe(false);
  });

  it('returns false when components is not an array', () => {
    expect(isMapTilesLoaded(hassWithComponents(new Set(['map_tiles'])))).toBe(false);
  });

  it('returns false when hass itself is undefined', () => {
    expect(isMapTilesLoaded(undefined)).toBe(false);
  });
});

describe('startMapTilesToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once immediately and calls onToken with the resolved token', async () => {
    const callWS = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const hass = { callWS } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    await vi.advanceTimersByTimeAsync(0); // flush the immediate fetch's .then()

    expect(callWS).toHaveBeenCalledWith({ type: 'map_tiles/access_token' });
    expect(onToken).toHaveBeenCalledWith('tok-1');

    stop();
  });

  it('swallows a failed fetch — no throw, onToken not called', async () => {
    const callWS = vi.fn().mockRejectedValue(new Error('ws unavailable'));
    const hass = { callWS } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    await vi.advanceTimersByTimeAsync(0);

    expect(callWS).toHaveBeenCalledOnce();
    expect(onToken).not.toHaveBeenCalled();

    stop();
  });

  it('refetches every 20 minutes', async () => {
    const callWS = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const hass = { callWS } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    await vi.advanceTimersByTimeAsync(0);
    expect(callWS).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(callWS).toHaveBeenCalledTimes(2);

    stop();
  });

  it('does not call onToken for a fetch that resolves after stop() was called', async () => {
    let resolveFetch: (value: { token: string }) => void;
    const callWS = vi.fn().mockReturnValue(
      new Promise<{ token: string }>((resolve) => { resolveFetch = resolve; }),
    );
    const hass = { callWS } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    stop();
    resolveFetch!({ token: 'late-token' });
    await vi.advanceTimersByTimeAsync(0);

    expect(onToken).not.toHaveBeenCalled();
  });

  it('retries a failed fetch after a minute instead of waiting out the interval', async () => {
    const callWS = vi.fn().mockRejectedValueOnce(new Error('core restarting')).mockResolvedValue({ token: 'tok-1' });
    const hass = { callWS } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    await vi.advanceTimersByTimeAsync(59 * 1000);
    expect(onToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callWS).toHaveBeenCalledTimes(2);
    expect(onToken).toHaveBeenCalledWith('tok-1');

    stop();
  });

  it("refetches when HA's websocket reconnects, since a core restart invalidates the token", async () => {
    const listeners = new Map<string, () => void>();
    const connection = {
      addEventListener: vi.fn((ev: string, fn: () => void) => { listeners.set(ev, fn); }),
      removeEventListener: vi.fn((ev: string) => { listeners.delete(ev); }),
    };
    const callWS = vi.fn().mockResolvedValueOnce({ token: 'old' }).mockResolvedValue({ token: 'after-restart' });
    const hass = { callWS, connection } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    await vi.advanceTimersByTimeAsync(0);
    listeners.get('ready')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(onToken).toHaveBeenLastCalledWith('after-restart');

    stop();
    expect(listeners.has('ready')).toBe(false);
  });

  it('stop() clears the refresh interval', async () => {
    const callWS = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const hass = { callWS } as unknown as HomeAssistant;
    const onToken = vi.fn();

    const stop = startMapTilesToken(hass, onToken);
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(callWS).toHaveBeenCalledOnce();
  });

  it('stop() also cancels a pending retry', async () => {
    const callWS = vi.fn().mockRejectedValue(new Error('ws unavailable'));
    const hass = { callWS } as unknown as HomeAssistant;

    const stop = startMapTilesToken(hass, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(callWS).toHaveBeenCalledOnce();
  });
});

// The card used to add the MapTiles basemap with an empty token, so every
// visible tile went out as `?token=` and came back 403 before the token
// landed. A stub map that tracks which layers are on it stands in for Leaflet.
describe('attachMapTilesLayer', () => {
  interface StubMap { layers: Set<unknown>; hasLayer: (l: unknown) => boolean }

  function makeMapAndLayer(): {
    map: StubMap;
    layer: {
      options: { token?: string };
      _tileFailed: number;
      redraw: Mock<() => void>;
      addTo: Mock<(m: StubMap) => unknown>;
    };
  } {
    const layers = new Set<unknown>();
    const map: StubMap = { layers, hasLayer: (l) => layers.has(l) };
    const layer = {
      options: { token: '' } as { token?: string },
      _tileFailed: 0,
      redraw: vi.fn<() => void>(),
      addTo: vi.fn<(m: StubMap) => unknown>((m) => { m.layers.add(layer); return layer; }),
    };
    return { map, layer };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not put the layer on the map before a token exists', () => {
    const hass = { callWS: vi.fn(() => new Promise(() => {})) } as unknown as HomeAssistant;
    const { map, layer } = makeMapAndLayer();
    const stop = attachMapTilesLayer(hass, layer, () => map);
    expect(layer.addTo).not.toHaveBeenCalled();
    stop();
  });

  it('adds the layer once, with the token, when the first token arrives', async () => {
    const hass = { callWS: vi.fn().mockResolvedValue({ token: 'tok-1' }) } as unknown as HomeAssistant;
    const { map, layer } = makeMapAndLayer();
    const stop = attachMapTilesLayer(hass, layer, () => map);
    await vi.advanceTimersByTimeAsync(0);
    expect(layer.options.token).toBe('tok-1');
    expect(layer.addTo).toHaveBeenCalledTimes(1);
    expect(layer.addTo).toHaveBeenCalledWith(map);
    expect(layer.redraw).not.toHaveBeenCalled();
    stop();
  });

  it('a refreshed token goes into the options without redrawing the basemap', async () => {
    const callWS = vi.fn().mockResolvedValueOnce({ token: 'tok-1' }).mockResolvedValue({ token: 'tok-2' });
    const hass = { callWS } as unknown as HomeAssistant;
    const { map, layer } = makeMapAndLayer();
    const stop = attachMapTilesLayer(hass, layer, () => map);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(layer.options.token).toBe('tok-2');
    expect(layer.addTo).toHaveBeenCalledTimes(1);
    expect(layer.redraw).not.toHaveBeenCalled();
    stop();
  });

  it('redraws once when tiles failed since the last token (403s after a core restart)', async () => {
    const callWS = vi.fn()
      .mockResolvedValueOnce({ token: 'tok-1' })
      .mockResolvedValueOnce({ token: 'tok-2' })
      .mockResolvedValue({ token: 'tok-3' });
    const hass = { callWS } as unknown as HomeAssistant;
    const { map, layer } = makeMapAndLayer();
    const stop = attachMapTilesLayer(hass, layer, () => map);
    await vi.advanceTimersByTimeAsync(0);
    layer._tileFailed = 6;
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(layer.redraw).toHaveBeenCalledTimes(1);
    // No new failures since: the next refresh leaves the tiles alone.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(layer.redraw).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing when the map is gone or attach was stopped before the token arrived', async () => {
    const hass = { callWS: vi.fn().mockResolvedValue({ token: 'tok-1' }) } as unknown as HomeAssistant;
    const torn = makeMapAndLayer();
    const stopTorn = attachMapTilesLayer(hass, torn.layer, () => null);
    const early = makeMapAndLayer();
    const stopEarly = attachMapTilesLayer(hass, early.layer, () => early.map);
    stopEarly();
    await vi.advanceTimersByTimeAsync(0);
    expect(torn.layer.addTo).not.toHaveBeenCalled();
    expect(early.layer.addTo).not.toHaveBeenCalled();
    stopTorn();
  });
});
