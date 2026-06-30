import type { WeatherRadarCardConfig } from './types';

// Single source of truth for the CSS length grammar the card accepts in
// `height` / `width`. Anchored so a stray "100px;border:0" can't smuggle
// extra declarations into an inline style attribute.
const CSS_SIZE_RE = /^\d+(\.\d+)?(px|%|em|rem|vh|vw)$/;

export function isValidCssSize(value: string | undefined): value is string {
  return !!value && CSS_SIZE_RE.test(value);
}

/**
 * True when a sections-view grid cell constrains the card to a fixed pixel
 * height. HA writes `grid_options.rows` as a concrete number once the user
 * drags the resize handle (or accepts a fixed default); `'auto'` — or the
 * field being absent — means HA lets the card pick its own height, which is
 * back to the unconstrained case. Only a numeric `rows` actually pins the
 * cell, so that's the signal. (The editor uses the same test to grey out
 * controls that have no effect under the constraint — keep them in sync.)
 */
export function isSectionHeightPinned(config: WeatherRadarCardConfig): boolean {
  return typeof config.grid_options?.rows === 'number';
}

export type CardLayoutMode = 'aspect' | 'flex';

export interface CardLayout {
  mode: CardLayoutMode;
  /**
   * Inline `min-height` to apply to ha-card, or null to apply none. Null
   * means "fill the container" — the card's `height:100%` takes over. We
   * return null when a fixed-row section cell owns the height, so the card
   * sizes to the cell instead of overflowing it with the configured height.
   */
  minHeight: string | null;
}

/**
 * Resolve the card's outer layout from its config.
 *
 * Precedence, highest first:
 *  1. A fixed-row sections-grid cell. HA owns the height; the card fills the
 *     cell (no min-height) and stays in flex-mode. This deliberately
 *     overrides both an explicit `height:` and `square_map` — in a pinned
 *     cell neither can change the card's vertical extent, so honouring them
 *     would only make the card overflow or underflow the cell. (This is the
 *     fix for "section rows not 'auto' but the card still uses config height".)
 *  2. square_map without an explicit height → aspect-mode: the map div is
 *     1:1 and the card grows to its content.
 *  3. Everything else → flex-mode with min-height from `height:` (validated)
 *     or the 400px default, so a regular (non-section) dashboard renders at
 *     the expected baseline while still being able to grow to fill a cell.
 */
export function resolveCardLayout(config: WeatherRadarCardConfig): CardLayout {
  if (isSectionHeightPinned(config)) return { mode: 'flex', minHeight: null };
  if (config.square_map && !config.height) return { mode: 'aspect', minHeight: null };
  return { mode: 'flex', minHeight: isValidCssSize(config.height) ? config.height : '400px' };
}
