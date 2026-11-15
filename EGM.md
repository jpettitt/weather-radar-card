# Weather Radar Card Blueprint

## System Overview

Weather Radar Card is a Home Assistant Lovelace custom card. It shows animated
weather radar from RainViewer, NOAA/NWS and DWD on a Leaflet map, with optional
overlays: NWS watches and warnings, wind, US wildfires and Blitzortung
lightning. The source is Lit + TypeScript in [src/](./src/EGM.md). Rollup builds
it into `dist/weather-radar-card.js`, the one file that HA loads, plus
`dist/weather-radar-card-maplibre.js`, which the card loads only for the vector
basemap.

This file is the architecture contract. For users, see
[README.md](./README.md). For agent rules (branching, pre-commit gates, the
diagnostic discipline), see [AGENTS.md](./AGENTS.md). For design rationale, see
[docs/animation.md](./docs/animation.md) and the `docs/*-feature-design.md`
files.

## Local Interface & Invariants

The root holds only build and tool configuration:

- [rollup.config.js](./rollup.config.js): the production build, two bundles in
  order. First the MapLibre bundle from `src/vector-basemap-layer.ts`, then
  the card from `src/weather-radar-card.ts`. It replaces `__BUILD_TIMESTAMP__`,
  `__CARD_VERSION__` (from `package.json`) and `__MAPLIBRE_FILE_HASH__` (the
  content hash of the MapLibre bundle). It writes a `.gz` next to each `.js`
  and puts the third-party licence notices at the top of each bundle.
  `npm start` runs it in watch mode (`rollup -c --watch`): no terser, the
  `.gz` files still written, and `dist/` served on port 5001 (or `PORT`).
- [vitest.config.ts](./vitest.config.ts): `happy-dom`, specs in
  `tests/**/*.test.ts`, v8 coverage over `src/**/*.ts` except `src/types.ts`.
- [eslint.config.js](./eslint.config.js): `typescript-eslint` recommended.
  The shell glob in `npm run lint` (`src/*.ts`) selects the files, so
  `src/localize/` is not linted.
- [tsconfig.json](./tsconfig.json): `strict` with `noImplicitAny: false`,
  `noEmit`, `moduleResolution: "bundler"`, `resolveJsonModule`.

Invariants:

- Keep `experimentalDecorators: true` and `useDefineForClassFields: false` in
  `tsconfig.json`. The Lit decorators depend on both.
- The MapLibre bundle must build before the card bundle, because the card
  build hashes the MapLibre file. MapLibre stays a separate file: a code-split
  `import()` would move card code into a shared chunk.
- A bundled package that has no licence file fails the build until you add
  its notice to `LICENCE_TEXT_OVERRIDES`.
- In watch mode, only the card bundle may start the dev server.
  `rollup-plugin-serve` binds its port when the config loads and exits the
  run if the port is in use. Watch mode must write the `.gz` files, because HA
  serves an existing `.gz` before the `.js`. `tests/rollup-config.test.ts`
  checks both.

## Subdirectories & System Boundaries

- src: [./src/EGM.md](./src/EGM.md) - the card element, the visual editor,
  radar playback and tile fetching, overlays, basemaps and viewer state.
  - src/localize: [./src/localize/EGM.md](./src/localize/EGM.md) - the
    `localize()` lookup and 11 language files.
- tests: [./tests/](./tests/) - Vitest specs. No contract, because the
  folder holds only tests.
- docs: [./docs/](./docs/) - user docs and per-feature design docs. No
  contract, because the folder holds no code.

## Global Invariants

- HA runs the files in `dist/`, not `src/`. After any change to `src/`, run
  `npm run build`, or HA keeps serving the old bundle.
- A URL is immutable. A file that the card loads on demand gets a
  content-hash query (`?v=`), so HA's service worker does not serve an old
  copy.
- Rate limiters and shared fetchers are module-level singletons, so all cards
  in a tab share them and their state survives a rebuild.
- Do not rebuild map state on each `hass` update. Overlays re-render only
  when their output changes.
- Map setup stays synchronous. Async results go into layers that are already
  live (issue #110).
- No `User-Agent` header in a browser `fetch()`.

## Global Side Effects

- Network calls to RainViewer, NOAA (`opengeo.ncep.noaa.gov`,
  `mapservices.weather.noaa.gov`), DWD (`maps.dwd.de`), `api.weather.gov`,
  ArcGIS WFIGS, InciWeb and basemap tile hosts. The `MapTiles` and
  `MapTilesVector` basemaps use HA's own `/api/map_tiles/` proxy.
- HA websocket calls: `frontend/get_user_data` and `frontend/set_user_data`
  (viewer preferences); `map_tiles/access_token`.
- Browser storage: two IndexedDB databases (tiles, NWS zone shapes) and a
  small number of `localStorage` keys.
- Custom elements `weather-radar-card` and `weather-radar-card-editor`, and
  an entry in `window.customCards`.

## System Verification

- Run: `npm test` (use Node 24, see [.nvmrc](./.nvmrc)).
- Run: `npm run build` (lint, then both bundles).
- CI ([.github/workflows/build.yml](./.github/workflows/build.yml)) runs on
  Node 22 and 24: `npm test` on 22, `npm run test:coverage` on 24 (report
  uploaded as an artifact), and `npm run build` on both.
