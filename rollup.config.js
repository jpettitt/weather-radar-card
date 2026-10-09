import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import typescript from 'rollup-plugin-typescript2';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import babel from '@rollup/plugin-babel';
import serve from 'rollup-plugin-serve';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import { string } from 'rollup-plugin-string';

const dev = process.env.ROLLUP_WATCH;
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// __MAPLIBRE_FILE_HASH__ versions the card's URL for the MapLibre file by
// its content (the file is built first, below): HA's service worker caches
// /local by full URL, so a rebuild under the same card version would
// otherwise keep serving the old file.
const MAPLIBRE_FILE = 'dist/weather-radar-card-maplibre.js';
const maplibreFileHash = () => createHash('sha256').update(readFileSync(MAPLIBRE_FILE)).digest('hex').slice(0, 10);

// Substitute __BUILD_TIMESTAMP__ / __CARD_VERSION__ in the bundled output —
// the build time and package.json's version, respectively. Both surfaced in
// the card's console signon: the timestamp so users can confirm a hard
// refresh actually loaded the new bundle vs a cached older one, the version
// so it can't drift from package.json (a hardcoded literal here stayed
// stuck at 3.7.0 through four later releases). Runs at the renderChunk
// stage so substitution happens after TS / babel and before terser,
// regardless of mangling.
const buildStampPlugin = () => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return {
    name: 'build-stamp',
    renderChunk(code) {
      return code
        .replace(/__BUILD_TIMESTAMP__/g, stamp)
        .replace(/__CARD_VERSION__/g, pkg.version)
        .replace(/__MAPLIBRE_FILE_HASH__/g, maplibreFileHash);
    },
  };
};

// Regenerate dist/<bundle>.gz alongside each emitted .js. HA's frontend
// will serve gzip when the .gz exists next to the .js — without this
// every `npm run build` leaves a stale .gz behind, and a Docker-loaded
// HA happily serves yesterday's gzipped bundle even though the .js is
// fresh. Cheap (~50 ms for a 320 KB bundle).
const gzipBundlePlugin = () => ({
  name: 'gzip-bundle',
  writeBundle(opts, bundle) {
    for (const fileName of Object.keys(bundle)) {
      if (!fileName.endsWith('.js')) continue;
      // opts.file for a single-file output (the MapLibre build).
      const jsPath = join(opts.dir ?? dirname(opts.file), fileName);
      writeFileSync(jsPath + '.gz', gzipSync(readFileSync(jsPath)));
    }
  },
});

// Licence texts for bundled packages that ship no licence file.
const LICENCE_TEXT_OVERRIDES = {
  // MIT per its package.json; the copyright line is its bundled file's header.
  'leaflet.markercluster': `MIT License

Copyright (c) 2012-2017, Dave Leaver, smartrak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
};

const licenceText = (name, dir) => {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (file) return readFileSync(join(dir, file), 'utf8').trim();
  if (LICENCE_TEXT_OVERRIDES[name]) return LICENCE_TEXT_OVERRIDES[name];
  throw new Error(`${name} is bundled but ships no licence file: add its notice to LICENCE_TEXT_OVERRIDES in rollup.config.js`);
};

// Puts the licence texts of the third-party code in each bundle at its top,
// which their BSD and MIT licences require in every copy: minification strips
// the packages' own notices. Found from what the bundle actually contains, so
// a new dependency is covered, or fails the build, without a list to keep.
// Runs after terser, which would otherwise remove the header too. `extra`
// adds notices for bundled code that isn't a package.
const thirdPartyNoticesPlugin = (extra = []) => ({
  name: 'third-party-notices',
  renderChunk(code, chunk) {
    const packages = new Map();
    for (const [id, module] of Object.entries(chunk.modules)) {
      const match = id.replace(/^\0/, '').match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
      if (match && module.renderedLength > 0) packages.set(match[2], match[1]);
    }
    if (packages.size === 0 && extra.length === 0) return null;
    // Packages with the same text share one copy.
    const byText = new Map();
    for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
      const text = licenceText(name, dir);
      byText.set(text, [...(byText.get(text) ?? []), name]);
    }
    for (const [name, text] of extra) byText.set(text, [...(byText.get(text) ?? []), name]);
    const body = [...byText].map(([text, names]) => `${names.join(', ')}\n\n${text}`).join('\n\n---\n\n');
    return `/*! Third-party notices for ${chunk.fileName}\n\n${body.replace(/\*\//g, '* /')}\n*/\n${code}`;
  },
});

// The adapter ported from @maplibre/maplibre-gl-leaflet: ISC, its notice kept
// in the source's /*! */ block.
const maplibreAdapterNotice = () => [
  '@maplibre/maplibre-gl-leaflet 0.1.4 (ported in src/maplibre-leaflet-layer.ts)',
  readFileSync(new URL('./src/maplibre-leaflet-layer.ts', import.meta.url), 'utf8')
    .match(/\/\*!.*\n([\s\S]*?)\*\//)[1]
    .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim(),
];

const serveopts = {
  contentBase: ['./dist'],
  host: '0.0.0.0',
  port: 5000,
  allowCrossOrigin: true,
  headers: {
    'Access-Control-Allow-Origin': '*',
  },
};

const makePlugins = (notices = []) => [
  // Import *.css files as raw strings (for unsafeCSS() in LitElement)
  string({ include: ['**/*.css'] }),
  nodeResolve(),
  commonjs(),
  typescript(),
  json(),
  babel({
    exclude: 'node_modules/**',
    babelHelpers: 'bundled',
  }),
  buildStampPlugin(),
  // Minify production builds; skip in watch mode for fast iteration.
  !dev && terser({
    format: { comments: false },
    compress: { passes: 2, drop_console: false },
    mangle: { keep_classnames: /^WeatherRadar/ },
  }),
  thirdPartyNoticesPlugin(notices),
  // Regenerate the .gz only on full builds — watch mode would serve
  // the .js directly from rollup-plugin-serve and a stale .gz isn't
  // in the way there.
  !dev && gzipBundlePlugin(),
  dev && serve(serveopts),
];

export default [
  // MapLibre for map_style: MapTilesVector, a separate build the card loads
  // from next to itself only when that style is used (vector-basemap.ts).
  // Separate rather than split off with import(): rollup would share code
  // (even its CommonJS helper) between the two, moving the card's own code
  // out of weather-radar-card.js and making every install need two files.
  // First, so the card's build can hash it. rollup -c builds in order.
  {
    input: 'src/vector-basemap-layer.ts',
    output: {
      file: MAPLIBRE_FILE,
      format: 'es',
    },
    plugins: makePlugins([maplibreAdapterNotice()]),
  },
  {
    input: 'src/weather-radar-card.ts',
    output: {
      dir: 'dist',
      format: 'es',
    },
    plugins: makePlugins(),
  },
];
