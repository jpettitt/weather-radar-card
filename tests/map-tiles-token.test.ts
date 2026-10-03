/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HomeAssistant } from 'custom-card-helpers';
import { isMapTilesLoaded, startMapTilesToken } from '../src/map-tiles-token';

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
});
