// Replaced at build time by rollup with package.json's version — a plain
// literal here drifted stale for four releases (stuck at 3.7.0 through
// 3.7.0-beta2/3.7.1-beta1/3.7.1/3.7.2-beta1) because nothing forced it to
// track package.json. Sourcing it from the one place bump-version already
// updates makes that drift structurally impossible.
export const CARD_VERSION = '__CARD_VERSION__';
// Replaced at build time by rollup with the ISO build timestamp. Lets the
// card's console signon show *which build* loaded — useful for confirming
// a fresh bundle has replaced a cached one in the browser.
export const BUILD_TIMESTAMP = '__BUILD_TIMESTAMP__';

// Map layer z-index stacking (low → high). Markers (incl. wind overlay) default to ~600 in Leaflet.
export const Z_BASEMAP = 0;
export const Z_LABELS = 2;
export const Z_RADAR_BASE = 100;       // current radar frame floor; +1 each crossfade
