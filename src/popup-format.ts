// Text helpers shared by the hazard popups (wildfires, earthquakes).

export function formatCount(n: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
}

// "40 minutes ago", "5 hours ago", "30 days ago" in HA's language. Days from
// a day up: a month-old perimeter reads as 30 days, not "last month".
export function agoText(thenMs: number, nowMs: number, lang: string): string {
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  }
  const minutes = Math.max(1, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}
