import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { readFileSync, writeFileSync } from 'fs';
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

// Substitute __BUILD_TIMESTAMP__ / __CARD_VERSION__ in the bundled output —
// the build time and package.json's version, respectively. Both surfaced in
// the card's console signon: the timestamp so users can confirm a hard
// refresh actually loaded the new bundle vs a cached older one, the version
// so it can't drift from package.json (a hardcoded literal here stayed
// stuck at 3.7.0 through four later releases). Runs at the renderChunk
// stage so substitution happens after TS / babel and before terser,
// regardless of mangling.
// __MAPLIBRE_FILE_HASH__ versions the card's URL for the MapLibre file by
// its content (the file is built first, below): HA's service worker caches
// /local by full URL, so a rebuild under the same card version would
// otherwise keep serving the old file.
const MAPLIBRE_FILE = 'dist/weather-radar-card-maplibre.js';
const maplibreFileHash = () => createHash('sha256').update(readFileSync(MAPLIBRE_FILE)).digest('hex').slice(0, 10);

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

// The licence notices the MapLibre file's bundled code requires in every
// copy. MapLibre's own @license line survives minification, but not its full
// text; the others don't survive at all: rollup drops the adapter's notice
// with the type-only imports it sits on.
const maplibreFileBanner = () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const adapter = read('./src/maplibre-leaflet-layer.ts').match(/\/\*!([\s\S]*?)\*\//)[1]
    .split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n');
  const notices = [
    ['MapLibre GL JS (maplibre-gl)', read('./node_modules/maplibre-gl/LICENSE.txt')],
    ['@versatiles/style', read('./node_modules/@versatiles/style/LICENSE.md')],
    ['', adapter],
  ];
  const text = notices.map(([name, body]) => `${name}\n\n${body.trim()}`.trim()).join('\n\n---\n\n');
  return `/*! Third-party notices for weather-radar-card-maplibre.js\n\n${text}\n*/`;
};

const serveopts = {
  contentBase: ['./dist'],
  host: '0.0.0.0',
  port: 5000,
  allowCrossOrigin: true,
  headers: {
    'Access-Control-Allow-Origin': '*',
  },
};

const makePlugins = () => [
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
    // 'some' keeps licence notices (/*! */, @license, @preserve), which the
    // BSD, MIT and ISC licences of what's bundled require in every copy.
    format: { comments: 'some' },
    compress: { passes: 2, drop_console: false },
    mangle: { keep_classnames: /^WeatherRadar/ },
  }),
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
      banner: maplibreFileBanner,
    },
    plugins: makePlugins(),
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
