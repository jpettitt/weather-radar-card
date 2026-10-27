# Using HA frontend elements in this card

What we've learned (sometimes the hard way) about using
`ha-*` Web Components in a custom Lovelace card. Internal /
contributor reference — not user-facing.

## TL;DR

- **`ha-selector` first**, then `ha-button` / `ha-switch` /
  `ha-icon-picker`, then `ha-input`, then bare HTML with HA design
  tokens. In that preference order, for the reasons below.
- **Verify any new `ha-*` element in the Docker testbed
  (`npm run ha:up`) on a hard-refresh** before shipping. The
  HA element library deprecates and renames without warning, and
  the lazy-load timing for a custom card opening the editor is
  not the same as HA's own bundled UI.
- **The lazy-load failure mode is silent and ugly.** An
  unregistered custom element renders as an invisible zero-height
  block — no console error, no fallback, no warning. The
  symptom is a section header with empty space below it. If you
  see that, the element didn't register.
- **HA design tokens are stable; element names are not.** When
  rolling your own (a small button, a custom layout), target
  `--ha-*` and `--primary-*` CSS custom properties. Don't reach
  for `--mdc-*` — HA is migrating off Material Web Components onto
  WebAwesome and those vars are rotating out.

## The lazy-load problem

HA's frontend lazy-loads its UI element library — the chunk that
registers `ha-button`, `ha-input`, `ha-form`, etc. only loads when
the page hits code that uses them. **Our card loads as a separate
`<script type="module">` before HA's main UI has touched many of
those chunks.** That timing window is the source of every "I used
`ha-foo` and it doesn't show up" bug.

When a custom element isn't registered yet:

- The browser renders it as an `HTMLUnknownElement`.
- It has no shadow DOM, no `:host` styles, no slot rendering.
- Crucially, **it renders at zero height** — the empty tag has no
  intrinsic size and no content to inflate it.
- Result: a section header rendered above it looks isolated, with
  visually empty space underneath. **No console error.**

The pattern in HA's own source code is a side-effect import at the
top of every file that uses the element:

```ts
// In HA frontend source:
import "../../../../components/ha-button";
```

That import resolves the element's module, which triggers its
`@customElement('ha-button')` decorator, which registers the tag
before the template ever renders. **We can't do this** — the path
is internal to HA's source tree, not exposed via npm. So we depend
on HA's own UI having registered the element at some earlier point
in the dashboard's lifetime.

## Element-by-element status (as of 2026-05)

Empirically verified in the Docker HA testbed against current HA
release. Confirms what works in our specific contexts (card
runtime and editor).

| Element | Editor | Card | Notes |
|---|---|---|---|
| `ha-selector` | ✅ | n/a | The dispatcher. Use this with `{ entity: {} }`, `{ number: {...} }`, etc. — not the per-domain pickers directly. Eagerly loaded by `ha-form`. |
| `ha-button` | ✅ | ? | Registers reliably in editor (the dashboard editor toolbar uses it via sibling imports). Not yet tested in card runtime. As of 2026-04-07 it wraps `@home-assistant/webawesome/components/button` — `mwc-button` is dead. |
| `ha-switch` | ✅ | n/a | Works in editor. |
| `ha-icon` | ✅ | ✅ | Works everywhere. |
| `ha-icon-picker` | ✅ | n/a | Works in editor. |
| `ha-card` | n/a | ✅ | Works as the card's root wrapper. |
| `ha-input` | ✅ | n/a | HA 2026.4+ (frontend 20260325.0). The editor's `_textField` picks it by core version. |
| `ha-textfield` | ✅ before 2026.4 | n/a | Removed in HA 2026.5 (frontend 20260429.0, PR 30349). `_textField` uses it on cores before 2026.4 so 4.0 supports 2025.3+: `hint` is `helper` there, with `helperPersistent`. Verified on 2025.3.4 and 2026.3.4 (2026-10-27). |

If you add a new `ha-*` element to this list, add an entry here
with the date and a one-line "what we confirmed."

## Migration history

Watch HA's frontend release notes for element renames. Recent
ones that affected us:

- **2026-04-01:** `ha-textfield` → `ha-input`
  ([commit](https://github.com/home-assistant/frontend/pull/30349)).
  Property rename: `helper` → `hint`. Migration landed in our
  3.6.3 (PR #166). Both exist in 2026.4; `ha-textfield` is gone
  from 2026.5. The 4.0 editor picks the tag from
  `hass.config.version`, not `customElements`: both load lazily,
  so neither may be registered yet at first render.
- **2026-04-07:** `ha-button` reimplemented on top of
  `@home-assistant/webawesome` (was `mwc-button`). Same tag name
  and event surface; CSS custom property surface shifted
  (`--mdc-*` → `--wa-*` / `--ha-*`). No code change needed for
  consumers but rolled-our-own CSS targeting `--mdc-*` will rot.
- **2026-04-07:** `ha-fab` removed in favour of `ha-button`. We
  don't use `ha-fab`, but worth knowing.

## When to use what

Decision tree for a new piece of editor or card UI:

1. **Is it a data field bound to a config schema?** → `ha-selector`
   with the appropriate selector config. This is HA's highest-level
   dispatcher and routes to the right widget per HA version. Used
   throughout our editor for entity, number-with-slider,
   single-select dropdowns, and more.

   ```ts
   <ha-selector
     .hass=${this.hass}
     .selector=${{ entity: { filter: { domain: 'sensor' } } }}
     .value=${value}
     .label=${'Sensor'}
     @value-changed=${this._onChange}
   ></ha-selector>
   ```

   Pickers (including `ha-selector`) **require a `.label` property**
   to render their floating-label layout. Without it the input area
   collapses to zero height even when the element IS loaded.

2. **Is it a free-form text or number input not driven by a schema?**
   → `ha-input` with appropriate `type=`. Provides HA-native
   styling, hint text, validation.

   ```ts
   <ha-input
     label="Centre latitude"
     .value=${value}
     .configValue=${'center_latitude'}
     @input=${this._onInput}
     hint="Number or entity id"
   ></ha-input>
   ```

3. **Is it a toggle, button, icon, or icon-picker?** → `ha-switch`,
   `ha-button`, `ha-icon`, `ha-icon-picker`. All confirmed
   loading reliably in our editor context (see table above).

4. **Is it a custom layout no `ha-*` element fits?** → bare HTML
   styled with HA design tokens. Examples in our codebase:
   - `<button class="subpage-nav-row">` — three-column tile
     (label / summary / chevron) for sub-page navigation
   - `<button class="subpage-back">` — back-link with chevron-only
     affordance
   - `<input type="color">` — HA has no first-class hex color
     picker; native `<input type="color">` is the most reliable
     cross-version solution

5. **None of the above and you need HA visual consistency?** →
   roll your own Lit component styled with the HA design tokens
   listed below. Document the choice with a comment naming the
   `ha-*` element you considered and why it wasn't right.

## HA design tokens to target

When styling your own elements to match HA's look, prefer these
custom properties. They survive the mwc→webawesome migration; the
`--mdc-*` variants do not.

**Color:**
- `--primary-color` — accent / primary button background
- `--text-primary-color` — foreground on primary background
- `--primary-text-color` — body text on card background
- `--secondary-text-color` — labels, hints, captions
- `--divider-color` — separators
- `--error-color`, `--warning-color`, `--success-color`

**Spacing:**
- `--ha-space-1` through `--ha-space-12` — 4px multiples
  (1=4px, 2=8px, 4=16px, etc.)

**Typography:**
- `--ha-font-size-xs` / `-s` / `-m` / `-l` / `-xl`
- `--ha-font-weight-medium` / `-bold`

**Shape:**
- `--ha-border-radius-pill` — full-pill (used by `ha-button`)
- `--ha-card-border-radius` — card corner radius (12px typical)
- `--ha-button-border-radius`, `--ha-button-height` — button-specific

Find the canonical list by grepping HA's frontend source for
`--ha-` in `src/resources/`.

## Defensive patterns

If you must use an `ha-*` element you're not sure is loaded in the
target context, two options:

### `whenDefined` gate

```ts
connectedCallback(): void {
  super.connectedCallback();
  customElements.whenDefined('ha-some-element').then(() => {
    this.requestUpdate();
  });
}
```

Render a bare-HTML fallback in the template until the element
registers, then re-render. Doubles your template surface but is
the most robust pattern. Use sparingly — only when the empirical
test (testbed + hard-refresh) shows the element doesn't
register reliably.

### Conditional render

```ts
${customElements.get('ha-some-element')
  ? html`<ha-some-element ...></ha-some-element>`
  : html`<input ... />`}
```

One-shot check at render time. Doesn't re-render when the element
later registers, so the user sees the fallback until the next
render is triggered for some other reason. Use only when you're
sure something else will trigger a re-render shortly.

## Verifying a new element before shipping

A 90-second test in the local testbed catches most lazy-load
failures:

1. `npm run build` (rebuild the bundle)
2. `npm run ha:up` (start the testbed if not already running)
3. Open http://localhost:8123 in a clean browser tab — **fresh
   page load matters; cached state hides the lazy-load timing
   window**
4. Hard-refresh (Cmd-Shift-R / Ctrl-Shift-F5) the dashboard
5. For an editor element: click "Edit dashboard" → "Add Card" →
   pick weather-radar-card → navigate to the relevant section /
   sub-page. Look at the spot where your new element should be on
   *first paint*.
6. For a card-runtime element: just look at the rendered card.
7. Open DevTools console (F12). Look for "unknown element"
   warnings or property mismatches.

If the element renders styled with no errors → safe.
If you see empty space where the element should be → it didn't
register. Pick a different element, roll your own, or add a
defensive pattern.

## Checking whether an HA element still exists

Before adding a new `ha-foo` to a template:

```bash
gh api repos/home-assistant/frontend/contents/src/components/ha-foo.ts \
  --jq '.content' | base64 -d | head -30
```

If you get `Not Found`, look for it under
`src/components/<subdir>/` or check recent commits for "Migrate"
/ "Remove" in the message:

```bash
gh api 'repos/home-assistant/frontend/commits?path=src/components/ha-foo.ts&per_page=2' \
  --jq '.[] | {date: .commit.author.date, message: (.commit.message | split("\n")[0])}'
```

The replacement element is usually named in the commit message
that removed the original.

## When in doubt, ask: "what does HA actually expose in the
user's installed version?"

This is from the project's global guidance, repeated here because
it keeps mattering. **HA frontend changes between releases.**
Documented patterns and community examples sometimes reference
APIs that no longer exist. When something doesn't work the way
the docs imply, grep the installed `hass_frontend/frontend_latest/*.js`
in the user's HA Docker container for the element name. Confirm
its current shape *first*, then code against it.

The 30-second grep beats three rounds of broken UI in the
browser.
