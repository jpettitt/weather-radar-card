export const PROGRESS_BAR_TRACK_HEIGHT = 8;

export function resolveProgressBarTouchHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PROGRESS_BAR_TRACK_HEIGHT;
  }

  return Math.max(PROGRESS_BAR_TRACK_HEIGHT, value);
}

export function progressBarFrameIndex(
  clientX: number,
  left: number,
  width: number,
  frameCount: number,
): number {
  if (width <= 0 || frameCount <= 0) {
    return 0;
  }

  const ratio = Math.max(0, Math.min(1 - 1e-9, (clientX - left) / width));
  return Math.floor(ratio * frameCount);
}
