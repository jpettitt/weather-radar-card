# localize

## Overview

Translation lookup for every user-visible string in the card and the editor.
`localize.ts` resolves a dot-path key (for example `ui.layers.wind`) against
the language files in `languages/`. All 11 language files go into the main
bundle at build time.

## Interface

- `localize(string: string, search = '', replace = '')`: returns the
  translation of the key `string` in the user's language, with English as the fallback.
  When `search` and `replace` are both non-empty, the function replaces the
  first `search` match with `replace`. Example:
  `localize('ui.forecast_offset', '{time}', rel)`.
- `languages/<code>.json`: nested string tables. `en`, `de`, `es`, `fr`, `it`,
  `nb`, `nl`, `pl`, `pt_BR`, `sk`, `sv`. These are data files, not contracts.

## Invariants

- `languages/en.json` is the master file. It must contain every key. Other
  languages may omit keys, and an omitted key falls back to English.
- A key that is missing from `en.json` too has no guard. The lookup returns
  `undefined`, or throws when an intermediate object is missing. With
  `search`/`replace` set, it always throws.
- Callers must not choose a key from feed data without an own-property check
  (`Object.hasOwn`). Plain objects return inherited members for names such as
  `constructor`. An NIFC `attr_FireCause` value once picked an inherited
  function from `CAUSE_KEYS` in `wildfire-layer.ts`, `localize()` threw, and
  the popup did not open. The lookup in `localize()` itself walks plain
  objects too.
- Key segments must not contain `.`. The lookup splits on `.` and walks the
  nested objects.
- Placeholders use the `{name}` form (`{n}`, `{time}`, `{minutes}`). The
  function replaces only the first match. Callers that need more call
  `.replace()` on the result.
- Language codes are normalised: quotes are removed and the first `-` becomes
  `_` (`pt-BR` → `pt_BR`). Registry keys must use the underscore form.
- To add a language, add `languages/<code>.json`, add a static `import` for it,
  and add an entry to the `languages` map in `localize.ts`. Nothing is
  discovered at run time. `@rollup/plugin-json` (see
  [rollup.config.js](../../rollup.config.js)) bundles the files.

## Side Effects

- Reads `localStorage.getItem('selectedLanguage')`, the HA frontend's stored
  language choice, on every call. Nothing is cached, and nothing catches an
  exception from this read. It does not read `hass.language`.
- No writes, no DOM access, no network calls.
- Bundle size: all translations are in `weather-radar-card.js`, about
  18–21 KB per language file before minification.

## Verification

- Run: `npm test` (Vitest; use Node 24, see [.nvmrc](../../.nvmrc)). No test
  targets `localize.ts` directly. `tests/basemap-styles.test.ts` checks that
  every language file has the editor map-style keys.
  `tests/wildfire-popup-cause.test.ts` covers the inherited-property case
  above.
