import { beforeEach, describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// docs/network-access.md tells users which outside servers the card
// contacts. This fails when src/ gains a URL host that the page doesn't name.
// It finds only hosts written as scheme://host. A host that comes from data
// (RainViewer's tile host, NWS zone URLs) or from the user (custom_tile_url)
// needs a manual update of the page.

// Hosts in src/ that the browser never contacts.
const NOT_CONTACTED = [
  'opengis.net', // WCS axis identifiers, sent as a parameter value (wind-grid-fetcher)
  'tiles.example.com', // the example in the custom_tile_url help text
];

const SRC = join(process.cwd(), 'src');
const DOC = join(process.cwd(), 'docs/network-access.md');

// Whole-line comments cite sources (e.g. the NWS colour chart) rather than
// contact them, so they're skipped.
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  for (const line of text.split('\n')) {
    if (isCommentLine(line)) continue;
    for (const m of line.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9.{}-]+)/g)) {
      hosts.push(m[1].toLowerCase().replace(/^\{s\}\./, '').replace(/^www\./, ''));
    }
  }
  return hosts;
}

function sourceHosts(): Set<string> {
  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts') || f.endsWith('.json'));
  return new Set(files.flatMap((f) => hostsIn(readFileSync(join(SRC, f), 'utf8'))));
}

describe('docs/network-access.md', () => {
  let hosts: Set<string>;
  let doc: string;
  beforeEach(() => {
    hosts = sourceHosts();
    doc = readFileSync(DOC, 'utf8');
  });

  it('names every host that src/ contacts', () => {
    const missing = [...hosts].filter((h) => !NOT_CONTACTED.includes(h) && !doc.includes(h));
    expect(missing).toEqual([]);
  });

  // An empty scan would pass the check above.
  it('the scan finds known hosts', () => {
    for (const h of ['api.rainviewer.com', 'maps.dwd.de', 'api.weather.gov', 'basemaps.cartocdn.com']) {
      expect(hosts.has(h), h).toBe(true);
    }
  });

  it('each ignored host is still in src/', () => {
    for (const h of NOT_CONTACTED) expect(hosts.has(h), h).toBe(true);
  });
});
