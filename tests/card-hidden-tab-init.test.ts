// A card built while its tab is already hidden (a background tab, restored
// tabs, or a rebuild while hidden) gets no visibilitychange, and the
// IntersectionObserver's first entry is intersecting: it must still pause.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { cardHass, mountCard, tick } from './helpers/mount-card';

/* eslint-disable @typescript-eslint/no-explicit-any */

const realIO = (globalThis as any).IntersectionObserver;
class FakeIO {
  constructor(private cb: (e: any[]) => void) {}
  // Browsers deliver an initial entry after observe(); on-screen => intersecting.
  observe(): void { setTimeout(() => this.cb([{ isIntersecting: true }]), 0); }
  disconnect(): void { /* nothing to release */ }
  unobserve(): void { /* nothing to release */ }
}

let hidden = true;
beforeEach(() => {
  hidden = true;
  (globalThis as any).IntersectionObserver = FakeIO;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterEach(() => {
  document.body.innerHTML = '';
  delete (document as any).hidden;
  (globalThis as any).IntersectionObserver = realIO;
});

describe('card built in a hidden tab', () => {
  it('pauses the radar player and the overlays', async () => {
    const el = await mountCard({ show_wildfires: true, show_alerts: true }, cardHass());
    await tick(5);
    expect(el._viewHidden).toBe(true);
    expect(el._player.viewPaused).toBe(true);
    expect(el._wildfireLayer._pausedAt).not.toBeNull();
    expect(el._alertsLayer._pausedAt).not.toBeNull();
  });

  it('resumes when the tab is shown', async () => {
    const el = await mountCard({ show_alerts: true }, cardHass());
    await tick(5);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(el._viewHidden).toBe(false);
    expect(el._player.viewPaused).toBe(false);
    expect(el._alertsLayer._pausedAt).toBeNull();
  });
});
