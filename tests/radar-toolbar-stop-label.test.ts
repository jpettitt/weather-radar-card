// The re-centre button's place in the toolbar and the stop label beside it,
// built with real Leaflet DOM helpers.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as L from 'leaflet';
import { RadarToolbar, STOP_LABEL_MS } from '../src/radar-toolbar';

/* eslint-disable @typescript-eslint/no-explicit-any */

function build(opts: Partial<ConstructorParameters<typeof RadarToolbar>[0]> = {}) {
  const onClearStop = vi.fn();
  const onRecenter = vi.fn();
  const tb = new RadarToolbar({ showRecenter: true, showPlayback: true, onRecenter, onClearStop, ...opts });
  const bar = tb.onAdd(undefined as unknown as L.Map);
  const chip = bar.querySelector('.radar-stop-label') as HTMLButtonElement | null;
  return { tb, bar, chip, onClearStop, onRecenter };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('re-centre button', () => {
  it('is the last button, below the playback controls', () => {
    const { bar, onRecenter } = build();
    const buttons = [...bar.querySelectorAll('a')];
    expect(buttons.map((a) => a.title)).toEqual(['Previous frame', 'Play / Pause', 'Next frame', 'Playback speed', 'Re-centre']);
    buttons[4].click();
    expect(onRecenter).toHaveBeenCalledOnce();
  });

  it('takes the tooltip it is given', () => {
    const { tb, bar } = build();
    tb.setRecenterTitle('Bay Area');
    const btn = [...bar.querySelectorAll('a')].pop()!;
    expect(btn.title).toBe('Bay Area');
    expect(btn.getAttribute('aria-label')).toBe('Re-centre');
  });
});

describe('stop label', () => {
  it('starts hidden', () => {
    expect(build().chip!.hidden).toBe(true);
  });

  it('shows Default or a tracked name for 5 seconds, and tapping it does nothing', () => {
    vi.useFakeTimers();
    const { tb, chip, onClearStop } = build();
    tb.showStopLabel('Default', false);
    expect(chip!.hidden).toBe(false);
    expect(chip!.textContent).toContain('Default');
    expect(chip!.classList.contains('sticky')).toBe(false);
    chip!.click();
    expect(onClearStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STOP_LABEL_MS - 1);
    expect(chip!.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chip!.hidden).toBe(true);
  });

  it("keeps a preset's chip until cleared, and a tap clears it", () => {
    vi.useFakeTimers();
    const { tb, chip, onClearStop } = build();
    tb.showStopLabel('Bay Area', true);
    expect(chip!.classList.contains('sticky')).toBe(true);
    expect(chip!.getAttribute('aria-label')).toBe('Clear preset: Bay Area');
    vi.advanceTimersByTime(STOP_LABEL_MS * 10);
    expect(chip!.hidden).toBe(false);
    chip!.click();
    expect(onClearStop).toHaveBeenCalledOnce();
  });

  it("a preset shown during Default's 5 seconds isn't hidden by its timer", () => {
    vi.useFakeTimers();
    const { tb, chip } = build();
    tb.showStopLabel('Default', false);
    vi.advanceTimersByTime(STOP_LABEL_MS - 1000);
    tb.showStopLabel('Bay Area', true);
    vi.advanceTimersByTime(STOP_LABEL_MS);
    expect(chip!.hidden).toBe(false);
    expect(chip!.textContent).toContain('Bay Area');
  });

  it('null hides it at once', () => {
    const { tb, chip } = build();
    tb.showStopLabel('Bay Area', true);
    tb.showStopLabel(null, false);
    expect(chip!.hidden).toBe(true);
  });

  it('is absent without a re-centre button', () => {
    const { tb, chip } = build({ showRecenter: false });
    expect(chip).toBeNull();
    expect(() => tb.showStopLabel('Default', false)).not.toThrow();
  });
});
