// InciWeb incident pages, found by URL. InciWeb answers any slug with a page
// (status 200 and a title made from the slug), so a page is an incident's
// only if it has the incident's "Date of Origin". Its RSS lists just 50
// incidents: on 2026-10-08 it linked 10 of the 30 largest fires, and checking
// pages directly found 22.
import { slugify } from './string-utils';

const PAGE_URL = 'https://inciweb.wildfire.gov/incident-information/';

/**
 * Slugs to try, most likely first: each unit (jurisdictional, then
 * protecting) with the fire's name, then its complex's, each bare and with
 * "-fire" (InciWeb uses both). Border 2 is filed under its protecting unit
 * (wancp-border-2-fire); Crosswhite, with no jurisdictional unit, under its
 * complex (orprd-rowe-creek-complex).
 */
export function inciwebCandidates(units: Array<string | undefined>, names: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const unit of units) {
    if (!unit) continue;
    for (const name of names) {
      const slug = name ? slugify(name) : '';
      if (!slug) continue;
      const base = `${unit.toLowerCase()}-${slug}`;
      out.push(base, `${base}-fire`);
    }
  }
  return [...new Set(out)];
}

// One lookup per fire per page load, shared by every card.
const lookups = new Map<string, Promise<string | null>>();
const known = new Map<string, string | null>();

/**
 * The first candidate with a real InciWeb page, or null if none has one.
 * A lookup that hit a network error and found nothing isn't remembered, so
 * the next popup tries again.
 */
export function findInciwebPage(candidates: string[]): Promise<string | null> {
  if (candidates.length === 0) return Promise.resolve(null);
  const key = candidates.join(' ');
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = Promise.allSettled(candidates.map(isIncidentPage)).then((results) => {
      const i = results.findIndex((r) => r.status === 'fulfilled' && r.value);
      if (i < 0 && results.some((r) => r.status === 'rejected')) throw new Error('InciWeb page check failed');
      const slug = i < 0 ? null : candidates[i];
      known.set(key, slug);
      return slug;
    });
    lookup.catch(() => lookups.delete(key));
    lookups.set(key, lookup);
  }
  return lookup;
}

/** The page a finished lookup found, for building popup HTML; null until then. */
export function knownInciwebPage(candidates: string[]): string | null {
  return known.get(candidates.join(' ')) ?? null;
}

export function inciwebUrl(slug: string): string {
  return PAGE_URL + slug;
}

async function isIncidentPage(slug: string): Promise<boolean> {
  const res = await fetch(PAGE_URL + slug);
  return res.ok && (await res.text()).includes('Date of Origin');
}

/** @internal */
export function _resetInciwebForTests(): void {
  lookups.clear();
  known.clear();
}
