import { gzipSync } from 'zlib';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import typescript from 'rollup-plugin-typescript2';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import babel from '@rollup/plugin-babel';
import serve from 'rollup-plugin-serve';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import { string } from 'rollup-plugin-string';

const dev = process.env.ROLLUP_WATCH;

// Substitute __BUILD_TIMESTAMP__ in the bundled output with the actual build
// time. Surfaced in the card's console signon so users can confirm a hard
// refresh actually loaded the new bundle vs a cached older one. Runs at the
// renderChunk stage so the substitution happens after TS / babel and before
// terser, regardless of mangling.
const buildStampPlugin = () => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return {
    name: 'build-stamp',
    renderChunk(code) {
      return code.replace(/__BUILD_TIMESTAMP__/g, stamp);
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
      const jsPath = join(opts.dir, fileName);
      writeFileSync(jsPath + '.gz', gzipSync(readFileSync(jsPath)));
    }
  },
});

const serveopts = {
  contentBase: ['./dist'],
  host: '0.0.0.0',
  port: 5000,
  allowCrossOrigin: true,
  headers: {
    'Access-Control-Allow-Origin': '*',
  },
};

const plugins = [
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
  // Regenerate the .gz only on full builds — watch mode would serve
  // the .js directly from rollup-plugin-serve and a stale .gz isn't
  // in the way there.
  !dev && gzipBundlePlugin(),
  dev && serve(serveopts),
];

export default [
  {
    input: 'src/weather-radar-card.ts',
    output: {
      dir: 'dist',
      format: 'es',
    },
    plugins: [...plugins],
  },
];
