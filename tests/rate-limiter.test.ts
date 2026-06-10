import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../src/rate-limiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── canFetch ───────────────────────────────────────────────────────────────

  it('allows fetches up to the per-minute limit', () => {
    const rl = new RateLimiter(3);
    expect(rl.canFetch('a')).toBe(true);
    rl.record('a');
    expect(rl.canFetch('b')).toBe(true);
    rl.record('b');
    expect(rl.canFetch('c')).toBe(true);
    rl.record('c');
    expect(rl.canFetch('d')).toBe(false);
  });

  it('blocks new urls once the limit is reached', () => {
    const rl = new RateLimiter(2);
    rl.record('a');
    rl.record('b');
    expect(rl.canFetch('c')).toBe(false);
  });

  it('always allows cached urls regardless of window state', () => {
    const rl = new RateLimiter(1);
    rl.record('a');
    rl.recordSuccess('a');
    rl.record('b');
    expect(rl.canFetch('a')).toBe(true); // cached
    expect(rl.canFetch('c')).toBe(false); // window full
  });

  it('canFetch is true on a fresh limiter', () => {
    expect(new RateLimiter(1).canFetch('a')).toBe(true);
  });

  // ── Sliding window expiry ─────────────────────────────────────────────────

  it('window entries older than 60 s are pruned and free up slots', () => {
    const rl = new RateLimiter(2);
    rl.record('a');
    rl.record('b');
    expect(rl.canFetch('c')).toBe(false);
    vi.advanceTimersByTime(60_000); // exactly 60 s — both entries fall outside (cutoff is inclusive)
    expect(rl.canFetch('c')).toBe(true);
  });

  it('partial window expiry frees only the oldest entries', () => {
    const rl = new RateLimiter(2);
    rl.record('a');
    vi.advanceTimersByTime(30_000);
    rl.record('b');
    vi.advanceTimersByTime(30_001); // 60.001 s after 'a' — 'a' expires; 'b' still in window
    expect(rl.canFetch('c')).toBe(true);
    rl.record('c');
    expect(rl.canFetch('d')).toBe(false); // 'b' + 'c' fill the window
  });

  // ── record ────────────────────────────────────────────────────────────────

  it('record does not add cached urls to the window', () => {
    const rl = new RateLimiter(2);
    rl.recordSuccess('a');
    rl.record('a'); // cached, not counted
    rl.record('b');
    rl.record('c');
    expect(rl.canFetch('d')).toBe(false); // limit reached by b + c
    rl.record('a'); // still cached, still no-op
    expect(rl.canFetch('d')).toBe(false);
  });

  // ── recordSuccess ─────────────────────────────────────────────────────────

  it('recordSuccess marks a url as cached so future fetches are free', () => {
    const rl = new RateLimiter(1);
    rl.record('a');
    rl.recordSuccess('a');
    expect(rl.canFetch('a')).toBe(true);
    rl.record('a'); // should not count
    rl.record('b');
    expect(rl.canFetch('c')).toBe(false);
  });

  // ── msUntilSlot ──────────────────────────────────────────────────────────

  it('msUntilSlot is 0 when the window is empty', () => {
    expect(new RateLimiter(5).msUntilSlot()).toBe(0);
  });

  it('msUntilSlot returns time until the oldest entry expires (plus 50 ms buffer)', () => {
    const rl = new RateLimiter(1);
    rl.record('a');
    expect(rl.msUntilSlot()).toBe(60_050); // entry just recorded; 60 s window + 50 ms buffer
    vi.advanceTimersByTime(10_000);
    expect(rl.msUntilSlot()).toBe(50_050); // 50 s remaining + 50 ms
  });

  it('msUntilSlot returns 0 after the entry has expired', () => {
    const rl = new RateLimiter(1);
    rl.record('a');
    vi.advanceTimersByTime(60_001);
    expect(rl.msUntilSlot()).toBe(0);
  });

  it('msUntilSlot reflects the oldest entry, not the most recent', () => {
    const rl = new RateLimiter(3);
    rl.record('a');
    vi.advanceTimersByTime(20_000);
    rl.record('b');
    vi.advanceTimersByTime(20_000);
    rl.record('c');
    // 'a' was recorded 40 s ago; will expire in 20 s + 50 ms buffer
    expect(rl.msUntilSlot()).toBe(20_050);
  });
});

describe('RateLimiter — bounded URL cache (2026-06 review backlog)', () => {
  it('evicts the least recently confirmed URL beyond the cap', () => {
    // Radar tile URLs are timestamped, so every refresh adds unique
    // URLs forever — the unbounded Set was a slow leak on wall-mounted
    // dashboards. Cap is 1000; insert 1001 and the first should fall out.
    const rl = new RateLimiter(1000000);
    for (let i = 0; i < 1001; i++) rl.recordSuccess(`https://t.test/${i}.png`);
    // url 0 evicted → no longer treated as cached → counts against window.
    expect(rl.canFetch('https://t.test/0.png')).toBe(true);   // window empty, allowed
    rl.record('https://t.test/0.png');
    // url 1000 still cached → record() is a no-op for it.
    rl.record('https://t.test/1000.png');
    // Only the evicted URL consumed a window slot.
    const rl2 = new RateLimiter(1);
    for (let i = 0; i < 1001; i++) rl2.recordSuccess(`https://t.test/${i}.png`);
    rl2.record('https://t.test/0.png');         // evicted → consumes the only slot
    expect(rl2.canFetch('https://t.test/0.png')).toBe(false);
    expect(rl2.canFetch('https://t.test/1000.png')).toBe(true); // still cached
  });

  it('re-confirming a URL refreshes its recency', () => {
    const rl = new RateLimiter(1);
    rl.recordSuccess('https://t.test/keep.png');
    for (let i = 0; i < 1000; i++) rl.recordSuccess(`https://t.test/f${i}.png`);
    // keep.png was first in, but NOT re-confirmed → at cap+1 it evicts...
    // unless re-added. Re-confirm and push one more: now f0 evicts instead.
    rl.recordSuccess('https://t.test/keep.png');
    rl.recordSuccess('https://t.test/extra.png');
    rl.record('https://t.test/keep.png');       // still cached → no slot used
    expect(rl.canFetch('https://t.test/anything.png')).toBe(true);
  });
});
