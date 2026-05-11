export const CARD_VERSION = '3.6.0-rc1';
// Replaced at build time by rollup with the ISO build timestamp. Lets the
// card's console signon show *which build* loaded — useful for confirming
// a fresh bundle has replaced a cached one in the browser.
export const BUILD_TIMESTAMP = '__BUILD_TIMESTAMP__';

// Map layer z-index stacking (low → high). Markers (incl. wind overlay) default to ~600 in Leaflet.
export const Z_BASEMAP = 0;
export const Z_LABELS = 2;
export const Z_RADAR_BASE = 100;       // current radar frame floor; +1 each crossfade
