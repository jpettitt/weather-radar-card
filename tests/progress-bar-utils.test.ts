import { describe, expect, it } from 'vitest';
import {
  PROGRESS_BAR_TRACK_HEIGHT,
  progressBarFrameIndex,
  resolveProgressBarTouchHeight,
} from '../src/progress-bar-utils';

describe('progress bar touch target', () => {
  it('preserves the 8px visible track and default touch height', () => {
    expect(PROGRESS_BAR_TRACK_HEIGHT).toBe(8);
    expect(resolveProgressBarTouchHeight(undefined)).toBe(8);
  });

  it('accepts a larger tablet-friendly touch height', () => {
    expect(resolveProgressBarTouchHeight(44)).toBe(44);
    expect(PROGRESS_BAR_TRACK_HEIGHT).toBe(8);
  });

  it('falls back to the visible track height for invalid or undersized values', () => {
    expect(resolveProgressBarTouchHeight(7)).toBe(8);
    expect(resolveProgressBarTouchHeight(Number.NaN)).toBe(8);
    expect(resolveProgressBarTouchHeight(Number.POSITIVE_INFINITY)).toBe(8);
    expect(resolveProgressBarTouchHeight('44')).toBe(8);
  });

  it('preserves horizontal frame selection for scrubbing', () => {
    expect(progressBarFrameIndex(0, 0, 100, 10)).toBe(0);
    expect(progressBarFrameIndex(51, 0, 100, 10)).toBe(5);
    expect(progressBarFrameIndex(100, 0, 100, 10)).toBe(9);
  });
});
