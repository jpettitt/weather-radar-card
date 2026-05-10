import { describe, it, expect } from 'vitest';
import {
  classifyDwdPixel,
  dwdPaletteFor,
  WN_PALETTE_PURPLES,
  RV_PALETTE_PURPLES,
} from '../src/radar-player';

// classifyDwdPixel is the heart of the DWD coverage-mask stripping
// pipeline (PR #132 / #142). It decides whether each fetched-tile
// pixel is real radar data, the grey "no-data" wash, or the magenta
// coverage outline. Two filter functions consume it: one drops
// everything that isn't 'data' (so the radar tiles render clean), the
// other inverts that to render the boundary as a separate snap-switched
// overlay (so it doesn't pulse during crossfade).
//
// The fragile part is that DWD's heavy-rain palette includes purples
// that are RGB-indistinguishable from outline-on-data antialiasing
// blends. The classifier handles this by whitelisting palette entries
// by exact (r, g, b) triple. These tests pin that whitelist plus the
// surrounding rules so a future DWD palette tweak that breaks the
// classifier is caught immediately.

describe('classifyDwdPixel', () => {
  // ── opaque palette purples (rare radar colours) — must classify as 'data' ──

  it('WN palette purples classify as data when the WN palette is selected', () => {
    for (const key of WN_PALETTE_PURPLES) {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b = key & 0xff;
      expect(classifyDwdPixel(r, g, b, 255, WN_PALETTE_PURPLES))
        .toBe('data');
    }
  });

  it('RV palette purples classify as data when the RV palette is selected', () => {
    for (const key of RV_PALETTE_PURPLES) {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b = key & 0xff;
      expect(classifyDwdPixel(r, g, b, 255, RV_PALETTE_PURPLES))
        .toBe('data');
    }
  });

  it('a WN palette purple classifies as outline when the RV palette is selected', () => {
    // Defensive: same purple triple, wrong palette → looks like an
    // outline blend. Pins that paletteKeys is actually consulted.
    const wn = WN_PALETTE_PURPLES.values().next().value as number;
    const r = (wn >> 16) & 0xff;
    const g = (wn >> 8) & 0xff;
    const b = wn & 0xff;
    if (!RV_PALETTE_PURPLES.has(wn)) {
      expect(classifyDwdPixel(r, g, b, 255, RV_PALETTE_PURPLES))
        .toBe('outline');
    }
  });

  // ── opaque outline — pure magenta ──

  it('pure magenta (255, 0, 255) classifies as outline', () => {
    expect(classifyDwdPixel(255, 0, 255, 255, WN_PALETTE_PURPLES))
      .toBe('outline');
  });

  it('any G=0 + B=255 colour classifies as outline (the canonical DWD outline rule)', () => {
    // R varies but G=0 and B=255 always means "magenta-family outline".
    expect(classifyDwdPixel(0, 0, 255, 255, WN_PALETTE_PURPLES)).toBe('outline');
    expect(classifyDwdPixel(128, 0, 255, 255, WN_PALETTE_PURPLES)).toBe('outline');
    expect(classifyDwdPixel(200, 0, 255, 255, WN_PALETTE_PURPLES)).toBe('outline');
  });

  // ── opaque outline — non-palette purple shape ──

  it('off-palette purple-shape pixels classify as outline (data + outline antialiasing blend)', () => {
    // Purple-shape: G low, R and B both bright, neither matches a palette entry.
    expect(classifyDwdPixel(188, 38, 204, 255, WN_PALETTE_PURPLES)).toBe('outline');
    expect(classifyDwdPixel(177, 23, 200, 255, WN_PALETTE_PURPLES)).toBe('outline');
  });

  // ── opaque grey — no-data wash ──

  it('equal-channel pixels (r === g === b) classify as grey', () => {
    expect(classifyDwdPixel(126, 126, 126, 255, WN_PALETTE_PURPLES)).toBe('grey');
    expect(classifyDwdPixel(0, 0, 0, 255, WN_PALETTE_PURPLES)).toBe('grey');
    expect(classifyDwdPixel(255, 255, 255, 255, WN_PALETTE_PURPLES)).toBe('grey');
  });

  // ── opaque data — typical radar palette colours ──

  it('pure red / orange / yellow / green / blue / cyan classify as data (B ≤ G or G ≥ R, not purple-shape)', () => {
    // These are the canonical radar palette ramp colours that should
    // pass through untouched by the mask stripper.
    expect(classifyDwdPixel(255, 0, 0, 255, WN_PALETTE_PURPLES)).toBe('data');         // pure red — B=0
    expect(classifyDwdPixel(255, 165, 0, 255, WN_PALETTE_PURPLES)).toBe('data');       // orange — B=0
    expect(classifyDwdPixel(255, 255, 0, 255, WN_PALETTE_PURPLES)).toBe('data');       // yellow — equal but G high
    // Hmm: pure yellow (255,255,0) — first rule: r === g === b? 255 !== 0 so no.
    //      magenta? g=255 not 0. Purple-shape? g=255 not <120. → data. Correct.
    expect(classifyDwdPixel(0, 255, 0, 255, WN_PALETTE_PURPLES)).toBe('data');         // green — R=0, B=0, but g not <120 anyway
    expect(classifyDwdPixel(0, 0, 255, 255, WN_PALETTE_PURPLES)).toBe('outline');      // pure blue is magenta-family! G=0 B=255
    expect(classifyDwdPixel(0, 200, 255, 255, WN_PALETTE_PURPLES)).toBe('data');       // cyan — G high, not purple-shape
  });

  it('a pixel where B ≤ G is never purple-shape (e.g. brown 165, 130, 90)', () => {
    expect(classifyDwdPixel(165, 130, 90, 255, WN_PALETTE_PURPLES)).toBe('data');
  });

  it('a pixel where G ≥ 120 is never purple-shape (e.g. lavender 200, 130, 220)', () => {
    expect(classifyDwdPixel(200, 130, 220, 255, WN_PALETTE_PURPLES)).toBe('data');
  });

  it('a pixel where R or B ≤ 50 is never purple-shape (the brightness floor)', () => {
    expect(classifyDwdPixel(40, 10, 200, 255, WN_PALETTE_PURPLES)).toBe('data');  // R below floor
    expect(classifyDwdPixel(200, 10, 40, 255, WN_PALETTE_PURPLES)).toBe('data');  // B below floor
  });

  // ── semi-transparent (antialiased mask edges) ──

  it('semi-transparent grey edge (R≈G≈B, alpha < 255) classifies as grey', () => {
    // The wash boundary antialiases as semi-transparent grey.
    expect(classifyDwdPixel(126, 126, 126, 100, WN_PALETTE_PURPLES)).toBe('grey');
    expect(classifyDwdPixel(120, 130, 125, 50, WN_PALETTE_PURPLES)).toBe('grey');  // small channel drift
  });

  it('semi-transparent magenta-blend edge classifies as outline', () => {
    // Outline antialiasing produces semi-transparent purple-ish pixels.
    expect(classifyDwdPixel(220, 50, 220, 100, WN_PALETTE_PURPLES)).toBe('outline');
    expect(classifyDwdPixel(180, 30, 180, 50, WN_PALETTE_PURPLES)).toBe('outline');
  });

  it('semi-transparent grey is grey even when channels drift up to 15 apart (the threshold)', () => {
    expect(classifyDwdPixel(120, 130, 130, 50, WN_PALETTE_PURPLES)).toBe('grey');
    expect(classifyDwdPixel(135, 120, 130, 50, WN_PALETTE_PURPLES)).toBe('grey');
  });

  it('semi-transparent pixel with channel drift > 15 classifies as outline (not grey)', () => {
    // Just past the 15-unit grey-detection threshold.
    expect(classifyDwdPixel(100, 130, 100, 50, WN_PALETTE_PURPLES)).toBe('outline');
    expect(classifyDwdPixel(180, 100, 180, 50, WN_PALETTE_PURPLES)).toBe('outline');
  });
});

// dwdPaletteFor picks the correct palette set based on the active WMS
// layer. Tests pin the layer-name → palette mapping so a future layer
// rename doesn't silently fall back to the wrong palette.

describe('dwdPaletteFor', () => {
  it('returns WN palette for Radar_wn-* layer names', () => {
    expect(dwdPaletteFor('Radar_wn-product_1x1km_ger')).toBe(WN_PALETTE_PURPLES);
    expect(dwdPaletteFor('Radar_wn-anything')).toBe(WN_PALETTE_PURPLES);
  });

  it('returns RV palette for Niederschlagsradar (the default)', () => {
    expect(dwdPaletteFor('Niederschlagsradar')).toBe(RV_PALETTE_PURPLES);
  });

  it('returns RV palette for any non-Radar_wn-prefixed layer (defensive default)', () => {
    expect(dwdPaletteFor('Some_Other_Layer')).toBe(RV_PALETTE_PURPLES);
    expect(dwdPaletteFor('')).toBe(RV_PALETTE_PURPLES);
  });
});
