import { readFileSync } from 'fs';
import resolve from '@rollup/plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';
import babel from '@rollup/plugin-babel';
import serve from 'rollup-plugin-serve';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Keep this in sync with rollup.config.js's buildStampPlugin — same two
// tokens, same substitution, just duplicated because this is a separate
// rollup entrypoint for `npm start` (watch mode).
const buildStampPlugin = () => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return {
    name: 'build-stamp',
    renderChunk(code) {
      return code
        .replace(/__BUILD_TIMESTAMP__/g, stamp)
        .replace(/__CARD_VERSION__/g, pkg.version);
    },
  };
};

export default {
  input: 'src/weather-radar-card.ts',
  output: {
    dir: './dist',
    format: 'es',
  },
  plugins: [
    resolve(),
    typescript(),
    json(),
    babel({
      exclude: 'node_modules/**',
      babelHelpers: 'bundled',
    }),
    buildStampPlugin(),
    terser(),
    serve({
      contentBase: './dist',
      host: '0.0.0.0',
      port: 5000,
      allowCrossOrigin: true,
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    }),
  ],
};
