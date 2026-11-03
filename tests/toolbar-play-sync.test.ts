// The toolbar's play icon follows the player, whatever toggles playback:
// its own button or double_tap_action: toggle_play (the card calls
// RadarPlayer.togglePlay directly). Real Leaflet DOM, real toolbar, real player.

import { describe, it, expect, vi } from 'vitest';
import * as L from 'leaflet';
import { RadarToolbar } from '../src/radar-toolbar';
import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('toolbar play icon', () => {
  it('matches player.run after any mix of button presses and double-taps', () => {
    const map = {
      on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
      getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
      getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    } as any;
    const player = new RadarPlayer({
      map, shadowRoot: { getElementById: () => null, host: {} } as any,
      getConfig: () => ({ type: 'custom:weather-radar-card' } as WeatherRadarCardConfig),
      rainviewerLimiter: {} as any, noaaLimiter: {} as any, dwdLimiter: {} as any,
    });
    const toolbar = new RadarToolbar({ showRecenter: false, showPlayback: true, onPlay: () => player.togglePlay() });
    player.toolbar = toolbar;
    const bar = toolbar.onAdd(undefined as unknown as L.Map);
    const playImg = bar.querySelectorAll('img')[1] as HTMLImageElement;
    const iconPlaying = (): boolean => playImg.src.endsWith('pause.png');

    // Every 3-step sequence of the two sources.
    for (let mask = 0; mask < 8; mask++) {
      for (let step = 0; step < 3; step++) {
        if (mask & (1 << step)) (playImg.parentElement as HTMLElement).click();
        else player.togglePlay();
        expect(iconPlaying()).toBe(player.run);
      }
    }
    player.clear();
  });
});
