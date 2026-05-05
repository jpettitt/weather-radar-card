// Pure string helpers used by overlay popup HTML generation. The popups
// render inside Leaflet's own container (outside the card's shadow root),
// so any user-supplied text MUST be HTML-escaped before insertion.

// Escape the HTML-significant characters in a string. Must cover the
// minimum set that prevents tag injection AND attribute breakouts:
// & < > " '. Anything we render into innerHTML or an attribute value
// goes through this.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

// Truncate a string to at most n characters, appending an ellipsis when
// it gets cut. The ellipsis itself counts toward n so the result is
// always <= n characters.
export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Lowercase + collapse whitespace and punctuation runs into single
// hyphens. Used for the InciWeb URL slug ("Sand Drain" → "sand-drain")
// and any future slug-from-name needs.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
