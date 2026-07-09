import { describe, it, expect } from 'vitest';
import { PopupPanRestore } from '../src/popup-pan-restore';

describe('PopupPanRestore', () => {
  it('restores the center captured before the popup opened', () => {
    const r = new PopupPanRestore<string>();
    r.onOpen(() => 'A');
    const token = r.onClose();
    expect(r.onCloseSettled(token)).toBe('A');
  });

  it('returns null when settled with no pending close', () => {
    const r = new PopupPanRestore<string>();
    expect(r.onCloseSettled(0)).toBeNull();
  });

  it('a reopen before the settle tick cancels the pending restore (switching popups)', () => {
    const r = new PopupPanRestore<string>();
    r.onOpen(() => 'A');
    const token = r.onClose();
    r.onOpen(() => 'B');   // switched directly to another popup — same tick, Leaflet's autoClose order
    expect(r.onCloseSettled(token)).toBeNull();
  });

  it('a chain of switches restores once, to the pre-chain center', () => {
    const r = new PopupPanRestore<string>();
    r.onOpen(() => 'A');
    const t1 = r.onClose();
    r.onOpen(() => 'B');           // A -> B, cancels t1
    expect(r.onCloseSettled(t1)).toBeNull();
    const t2 = r.onClose();
    r.onOpen(() => 'C');           // B -> C, cancels t2; still doesn't overwrite saved 'A'
    expect(r.onCloseSettled(t2)).toBeNull();
    const t3 = r.onClose();        // C closes for good
    expect(r.onCloseSettled(t3)).toBe('A');
  });

  it('a fresh open/close cycle after a completed restore captures a new center', () => {
    const r = new PopupPanRestore<string>();
    r.onOpen(() => 'A');
    expect(r.onCloseSettled(r.onClose())).toBe('A');

    r.onOpen(() => 'B');
    expect(r.onCloseSettled(r.onClose())).toBe('B');
  });

  it('getCenter is only invoked on the first open of a chain', () => {
    const r = new PopupPanRestore<string>();
    let calls = 0;
    const getCenter = () => { calls++; return 'A'; };
    r.onOpen(getCenter);
    r.onOpen(getCenter);
    r.onOpen(getCenter);
    expect(calls).toBe(1);
  });
});
