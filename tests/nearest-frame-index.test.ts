import { describe, it, expect, vi } from 'vitest';

// Stub Leaflet — radar-player imports it eagerly (and pulls in fetch-tile-layer
// which extends L.TileLayer / L.TileLayer.WMS at class-definition time), but
// nearestFrameIndex itself is pure and never touches any L.* API.
vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  (TileLayer as any).WMS = WMS;
  return { TileLayer, default: { TileLayer } };
});

import { nearestFrameIndex } from '../src/radar-player';

describe('nearestFrameIndex', () => {
  it('returns -1 for an empty frame list', () => {
    expect(nearestFrameIndex([], 0)).toBe(-1);
    expect(nearestFrameIndex([], 1_700_000_000)).toBe(-1);
  });

  it('picks the frame closest to the given clock time', () => {
    // Frames at -10 / -5 / 0 / +5 / +10 minutes (epoch seconds), clock at +2 min.
    // Closest is the +5 frame at index 3 (3 min away vs. 2 min for index 2 — wait,
    // let's be careful: |0 - 120| = 120 s, |300 - 120| = 180 s — index 2 wins).
    const minute = 60;
    const frames = [
      { time: -10 * minute },
      { time:  -5 * minute },
      { time:   0 * minute },
      { time:   5 * minute },
      { time:  10 * minute },
    ];
    expect(nearestFrameIndex(frames, 2 * minute)).toBe(2); // 0-min frame is closer than +5
    expect(nearestFrameIndex(frames, 3 * minute)).toBe(3); // +5 wins (2 min vs 3)
    expect(nearestFrameIndex(frames, -10 * minute)).toBe(0);
    expect(nearestFrameIndex(frames, 99 * minute)).toBe(4);
  });

  it('resolves ties to the lower index', () => {
    const frames = [{ time: -5 }, { time: 5 }];
    // |-5 - 0| === |5 - 0| === 5; first-wins because the loop only swaps on `<`.
    expect(nearestFrameIndex(frames, 0)).toBe(0);
  });

  it('handles a single-frame list', () => {
    const frames = [{ time: 1_777_000_000 }];
    expect(nearestFrameIndex(frames, 0)).toBe(0);
    expect(nearestFrameIndex(frames, 1_777_000_000)).toBe(0);
    expect(nearestFrameIndex(frames, 9_999_999_999)).toBe(0);
  });
});
