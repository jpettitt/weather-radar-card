# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Over-determined time-range configs now warn instead of silently ignoring `frame_count`** ([#191](https://github.com/jpettitt/weather-radar-card/issues/191)). `frame_count` has been deprecated since 3.5 and is only consumed when no time-based field is present; a config carrying both (e.g. `frame_count: 12` + `past_minutes: 60` + `frame_stride_minutes: 2`) runs purely on the time fields, which looked self-contradictory with no signal that `frame_count` was doing nothing. The card now logs a console warning on load when `frame_count` appears alongside `past_minutes` or `frame_stride_minutes`, and the deprecated-field documentation spells out the precedence. (`frame_count` will be removed entirely in the next major.)

## [3.7.0-beta2] - 2026-06-12

> **Beta pre-release.** One scoped feature exception to the beta freeze, reopened deliberately: the NOAA source switch below — it directly resolves live beta feedback ("frame increment is 10 instead of 5") and removes the line's biggest data-freshness deficit. Plus the "Latest" label rename and a full translation catch-up. Everything else remains fixes-only until 3.7.0.

### Changed

- **NOAA radar now serves from NCEP's opengeo GeoServer** (`opengeo.ncep.noaa.gov`, `conus_bref_qcd` — the backend radar.weather.gov itself runs on), replacing the eventdriven `mapservices.weather.noaa.gov` WMS. The new server's `GetCapabilities` lists the layer's **actual frame timestamps** (real ~2-min scan cadence) and is CORS-open, so the card now requests exact scan times instead of guessing a grid. What users see: the newest NOAA frame is **~2 minutes behind real time instead of 15–25**, every frame in the loop is a distinct radar scan (the alpha2 "duplicate frames" trade-off is gone), and a new **Frame interval** editor dropdown picks 2 / 5 / 10-minute loop density (default 5 — restoring the 3.6-era 12–13 frames/hour, with genuinely unique frames this time; directly addresses the beta1 "frame increment is 10 instead of 5" feedback). Legacy `frame_count` configs now migrate on the 5-min default stride again (a 3.6-era `frame_count: 12` covers ~55 min as it used to). The refresh cycle scales with the chosen interval so a 2-min loop stays 2-min fresh. The NWS colour bar asset was regenerated to match the new product's modern reflectivity ramp (sampled from the server's own legend). If the frame listing is unavailable the card falls back to the legacy server's computed grid for that cycle (stale but correct) and retries; `_dedupFrames` stays armed as belt-and-braces. The card-side NOAA rate budget was raised 120 → 500 req/min (matching RainViewer/DWD) — the old number was sized for the small legacy host, and the worst-case init burst (120-min loop at the 2-min interval ≈ 490 tile requests, one-time) would have spent minutes visibly throttled against a backend built for radar.weather.gov's public traffic.

- **The newest-frame label now reads "Latest" instead of "Now"** (progress-bar tooltip and the time-display suffix). "Now" overstated freshness — radar frames lag real time by source (DWD ~5 min; RainViewer ~1–2 min; NOAA was ~15–20 min on the legacy server, now ~2 min after the opengeo switch above — the label stays honest either way). Localised in all 11 languages.
- **Translations brought up to date**: the 3.7 editor strings (playback speed block, per-user persistence, motion compensation) shipped in English in all 10 non-English locales — now properly translated (de, es, fr, it, nb, nl, pl, pt_BR, sk, sv), plus unit-name fixes where the language has its own word for acres (it: Acri, pl: Akry, sk: Akre).

## [3.7.0-beta1] - 2026-06-10

> **Beta pre-release — 3.7 is feature complete.** The 3.7 line (per-user state → motion compensation → stability wave → canvas rendering) now enters the beta phase: no further features before 3.7.0, fixes only. Suitable for adventurous daily-driver dashboards; please report anything odd, especially around lightning at storm scale and hazard-polygon clicks.

### Changed

- **Lightning strikes render on a single canvas instead of per-strike DOM markers.** Each strike previously mounted two DOM markers with inline SVG (fill + outline panes); during an active storm with a long `lightning_max_age_minutes` that's hundreds-to-thousands of nodes, which made pan/zoom heavy even after the 3.7.0-alpha3 time-sliced backlog drain. One canvas now holds every strike: two-pass painting preserves the stacked-outline look (outlines under fills, newest on top), the fresh-bolt pulse is drawn as a short rAF animation (still honours `prefers-reduced-motion`), and popups still work via a click hit-test — **the most recent strike within 10 px wins** (recency beats distance when strikes overlap; the fresh strike is the one you're reacting to). Hover still shows a pointer cursor over strikes. Settled strikes (past the 30 s bolt window) live in an offscreen buffer, so the steady-state repaint is one blit plus the newest strikes — a new strike arriving costs O(1), not a full-set repaint (the first cut repainted everything ~36× per arriving strike's pulse animation, which saturated the main thread under storm load). Soak-validated at 10,000 simultaneous strikes (Blitzortung's max) with the page fully responsive. No config changes.
- **NWS alert polygons and wildfire perimeters render through Leaflet's canvas renderer — one shared renderer per map.** Alert outbreaks carry hundreds of multi-ring zone shapes and WFIGS perimeters carry thousands of vertices each; per-ring SVG nodes were the heavy part of pan/zoom with overlays on. Leaflet's canvas renderer keeps its own hit-testing, so popups and click behaviour are unchanged; fire icons remain DOM markers (bounded count). The shared-renderer constraint is load-bearing: a canvas renderer receives clicks as DOM events on its own canvas element, and with two renderers stacked the topmost silently swallows the other's clicks (observed live as alert polygons going permanently unclickable the moment the first fire perimeter crossed the icon→polygon zoom threshold and lazily spawned a second renderer on top).

## [3.7.0-alpha3] - 2026-06-10

> **Alpha pre-release.** Stability wave for the 3.7 line: fixes for every finding from the 2026-06-09 full-project code review plus four issues live-debugged during the alpha2 soak (DWD mask architecture, coverage clipping, rate-limit recovery, lightning-backlog UI freeze). No new features, no config surface changes. **Not recommended for production dashboards** — install to exercise the fixes and report findings.

### Fixed

- **Opening the editor no longer freezes the UI under a large lightning backlog.** Each strike renders as two DOM markers with inline SVG, and a fresh card mount built the entire backlog in one synchronous pass — during an active storm with `lightning_max_age_minutes: 20` that's hundreds of strikes, and opening the edit pane runs TWO full builds at once (the re-attached card plus the preview card), freezing the page for seconds. Strike additions now queue and materialise newest-first in ~8 ms time-budgeted slices per animation frame: the freshest strikes appear immediately, the backlog fills in over a few frames, and steady-state single-strike updates land on the next frame as before.
- **NWS alerts / wildfire polling now backs off exponentially on fetch failures.** api.weather.gov's rate limiter blocks without CORS headers — the browser surfaces that as a statusless `TypeError: Failed to fetch` — and the retry used the normal refresh cadence (60 s with alerts displayed), hammering the very host that was blocking us and keeping the block alive indefinitely (observed live: repeated fetch-failed errors, no recovery). Both polling layers now double their retry delay on consecutive failures (alerts: 60 s → 30 min cap; wildfires: 5 min → 60 min cap) and reset on success. Displayed data stays on the map throughout.
- **Three unbounded caches are now bounded.** The rate-limiter's fetched-URL memo grew by every timestamped tile URL ever fetched (a slow leak on wall-mounted dashboards — now LRU-capped at 1000); the wind-grid cache only replaced expired entries on exact-key re-request, accreting multi-MB grids per pan for the page session (now swept on each fetch); and the NWS zone localStorage cache was only pruned on same-key reads, growing toward the quota until persistence silently broke for new zones (now swept once per layer start, including corrupt entries).
- **Antimeridian handling for Alaska/Aleutian geometries.** Polygons crossing 180°E/W (Aleutian fires, NWS Alaska marine zones) produced planet-wide bounding boxes with mid-Atlantic centroids, making the `wildfire_radius_km` / `alerts_radius_km` filters drop or keep them wrongly — bounds now renormalise into a continuous window across the dateline. The region-warning US coverage check gained a dedicated trans-dateline Aleutian box (Attu-area cards got a false "outside coverage" banner), and the NDFD wind auto-fallback now wraps Leaflet's unwrapped longitudes before its coverage test.
- **Playback-speed button no longer jumps to ¼× after a non-preset YAML value.** `setSpeed` now snaps to the nearest preset (same convention as startup), so `playback_speed: 1.5` cycles sensibly instead of resetting.
- **Blob URL leak on tile decode failure plugged** (`onerror` now revokes alongside `onload`).

### Changed

- **Per-tick progress-bar work reduced to changed-segments-only.** The now-marker and current-frame highlight previously did a shadow-DOM `getElementById` + style write for *every* segment on *every* tick (~770 lookups/sec on a 48-frame loop at 4×). Segment elements are now cached at build time and only the segments whose state changed get touched.
- **Post-pan motion-comp/clip refresh debounced 250 ms.** Tracked-marker configs re-centre on every GPS jitter; each moveend ran the full snapshot + LK + coverage-clip pipeline. Invalidation stays immediate (stale vectors can never apply); only the rebuild work coalesces.
- **Lightning entity scan no longer allocates on every hass tick** (`for-in` with an early prefix test instead of `Object.entries` over the full state machine).
- Doc accuracy: `restart_delay` added to the typed config (was index-signature only), `smooth_overlap` no longer claims "YAML-only" (the editor has a slider), the wind density/size/flow options no longer claim "DWD-only" (they apply to every wind source), and two stale doc references fixed in source-caps / wind-source-caps. Dead `_dynamicStyleEl` removed from the card.

- **Editing the card no longer rebuilds the map on every keystroke.** The editor's text fields fire `config-changed` per keystroke, and each one triggered a full Leaflet teardown + marker/overlay rebuild + radar frame/tile refetch — typing a 7-character latitude meant seven complete rebuilds (also burning the shared rate-limit window). Structural rebuilds are now coalesced behind a 250 ms trailing debounce: the map rebuilds once, after the last keystroke, against the latest config.
- **Hidden cards stop all wind-overlay work.** The wind overlays were missing from the visibility-pause roster (`IntersectionObserver` + `visibilitychange`): the streamline canvas kept its 15 fps particle loop running at full rate while the card was scrolled off-screen (`requestAnimationFrame` only throttles when the *tab* is hidden), and both wind overlays' hourly refresh chains kept fetching. Both now pause on hide and resume — with an immediate refresh to pick up a rolled-over hour bucket — on show.
- **Hidden cards stop wildfire/alerts polling completely.** `pause()` only cancelled the *armed* refresh timer; a fetch already in flight when the card was hidden completed and its tail re-armed the chain, so the layer kept polling NIFC / api.weather.gov at full cadence for as long as the card stayed hidden. The re-arm now checks the paused flag.
- **A transient NIFC failure no longer blanks displayed wildfire perimeters.** The WFIGS fetch returned an empty list on error (503 / rate-limit, which NIFC's ArcGIS endpoint does intermittently) and the layer assigned it unconditionally — every fire polygon and icon vanished for the 5–30 minutes until the next scheduled retry. Failures now keep the currently displayed perimeters (same convention the alerts layer and the InciWeb fetch already used); a *successful* fetch returning genuinely zero fires still clears as before.
- **NOAA "soft-error" tiles are detected and retried.** NOAA's WMS sometimes answers `200 OK` with a small `text/xml` error document instead of a PNG (likely a rate-limit the server doesn't surface as 429). The blob silently failed image decode — the tile rendered blank, was counted as a success, and was never retried. Non-image content types are now detected and routed through the bounded retry path; persistent failures count as failed tiles instead of silent blanks.
- **Forecast rain no longer renders outside the coverage boundary.** Two causes, one fix: nowcast frames carry a different no-data geometry than the analysis frame the displayed boundary is pinned to (so forecast rain can legitimately extend past the drawn outline), and motion compensation slides whole layers (pushing edge rain over the boundary during transitions). The radar pane is now clipped to the coverage region via `clip-path: path(...)` — scanline-run rectangles built from the shared coverage mask's own tiles, in layer-point coordinates so the clip stays glued to geography, rebuilt on pan/zoom/resize with a 25% capture margin so pans don't reveal unclipped edges. (CSS `mask-image` was tried first and is unusable here: Leaflet panes are 0×0 boxes, default `mask-clip` hides everything, and Chrome misrenders `mask-clip: no-clip` on zero-size boxes — verified with a standalone repro.) DWD-only; other sources have no coverage mask and stay unclipped.
- **DWD coverage mask is now a single shared layer instead of one per frame.** Two user-visible wins. (1) *The boundary no longer wobbles during forecast playback*: nowcast frames each carry a slightly different no-data boundary (probed: outline area shifts and the wash grows with lead time), and the old per-frame snap-switch visibly jumped between those geometries on every forecast-frame tick. The mask is now pinned to the newest analysis frame for the whole loop — marginally approximate during forecast frames, completely steady. (2) *Massive request reduction on long histories*: per-frame masks meant one extra WMS layer per radar frame — at 12 h of history that was ~144 mask layers ≈ ~900 redundant tile requests per init, which saturated the browser's per-origin connection pool (observed as tile requests that never finished). One layer now, fetched once per init.
- **DWD mask-pane leak: dedup compaction now removes everything it drops.** `_dedupFrames` removed the layers/masks of *duplicate* frames but only compacted the tracked arrays past frames that never finished loading — their layers and coverage masks stayed attached to the map with no remaining reference, so no later sweep could ever remove them. On DWD with forecast enabled (~48 frames, a radar layer + coverage-mask layer each), repeated init cycles grew the mask pane without bound (observed live in devtools as a new mask layer per cycle). Compaction now tears down every layer not in the kept set.
- **Long-running dashboards no longer accumulate duplicate frames.** The 5-minute refresh appended the fetched "latest" frame without checking it was actually new — and the refresh cycle is faster than every source's publication cadence, so roughly every other refresh appended a duplicate while destroying a real historical frame. Over hours the loop filled with adjacent duplicate pairs as its time span shrank. The refresh now honours the source's frame listing (RainViewer's `weather-maps.json` timestamps; computed grids for NOAA/DWD) and skips the shift entirely when nothing new has been published.
- **Pan/zoom no longer triggers a full teardown + refetch after frame dedup.** The motion-compensation dedup (3.7.0-alpha2) shrinks the displayed frame count, but the post-navigation "did frame_count change?" check compared against the displayed count — once they diverged, every map move took the full re-init branch forever, defeating the keep-layers-attached pan optimisation. The check now compares against the *requested* count. (Also fixes the pre-existing variant where a source returning fewer frames than requested caused the same loop.)
- **The periodic-refresh timer can no longer fork into parallel chains.** Rate-limit retries and sleep/wake resumes could each arm a fresh refresh chain while the old timer was still pending; each surviving chain doubled the refresh rate. Re-arming now cancels the previous timer, and a stale timer firing after a teardown/re-init bails on a generation check.
- **Per-user state writes are no longer lost on card teardown.** `ViewerState.dispose()` cancelled the pending debounced write, silently dropping up to 500 ms of the user's most recent changes (e.g. a playback-speed click) on every dashboard navigation / edit-mode entry. Dispose now flushes the pending write first.
- **Per-user state can no longer be wiped by a hydrate/write race.** A value set while the initial storage read was still in flight was discarded when the read landed (wholesale cache replace), and in the opposite interleaving the debounced write could persist a cache containing *only* the fresh keys — destroying every previously stored key for the card. Hydrate now merges under in-memory values, concurrent hydrates share one round-trip, and the flush waits for hydration before writing.
- **A strict CSP can no longer kill the card at construction.** The refresh-timer worker was built without the try/catch the LK worker already had; under CSPs that block `blob:` workers the constructor threw mid-init. It now falls back to plain `setTimeout` timers (the stale-resume re-init covers background-tab throttling).

## [3.7.0-alpha2] - 2026-06-09

> **Alpha pre-release.** Adds opt-in motion compensation for radar transitions ([#183](https://github.com/jpettitt/weather-radar-card/pull/183)), built on top of [@genericJE](https://github.com/genericJE)'s foundational work in [#156](https://github.com/jpettitt/weather-radar-card/pull/156). Continues the 3.7 pre-release line that started with `3.7.0-alpha1` (per-user state framework). **Not recommended for production dashboards** — install only if you want to exercise the motion-comp pipeline across radar sources and report findings.

### Added

- **Motion compensation for radar transitions** ([#183](https://github.com/jpettitt/weather-radar-card/pull/183)) — opt-in via `motion_compensation: true`. During each crossfade, the new frame slides in from where its rain *would have been* at the previous frame's time, and the outgoing frame slides out toward where its rain *would be* at the new frame's time. The composite reads as one drifting rain field rather than two crossfading frames at separated positions. **Built on top of [@genericJE](https://github.com/genericJE)'s [#156](https://github.com/jpettitt/weather-radar-card/pull/156)** — kept the snapshot-capture infrastructure and the dual-translate animation in `_showSlot`, swapped the SAD block-matcher for pyramidal Lucas-Kanade optical flow with a distance-from-white intensity channel so the feature works for all three radar sources (DWD, RainViewer, NOAA) instead of being effectively DWD-only. LK runs in a Web Worker by default so slow devices stay smooth; falls back to synchronous main-thread execution under strict CSPs. Auto-skipped on frame pairs without enough gradient signal for a confident vector (light rain, clear sky). NOAA-specific: post-load `_dedupFrames()` removes byte-identical frames produced by NOAA's coarser publication cycle so the deduped loop animates only unique frames. Toggle exposed in the editor's Animation section. See [`docs/configuration.md#motion-compensation`](docs/configuration.md#motion-compensation) and the architectural [`docs/motion-compensation-feature-design.md`](docs/motion-compensation-feature-design.md). Default off.

  ```yaml
  type: 'custom:weather-radar-card'
  smooth_animation: true
  smooth_overlap: 0
  motion_compensation: true
  ```

### Changed

- **NOAA frame interval bumped from 5 → 10 min** to match the source's empirical publication cadence (`SOURCE_CAPS.NOAA.intervalMin`). NOAA's eventdriven WMS service has been observed to publish at irregular ~5–9 min intervals (mean ~7), and the server snaps any TIME within a publication window to the same physical frame. Requesting at a finer 5-min stride was returning duplicate frames for every other request — `dist/`-side dedup tolerated that gracefully but the loop bandwidth was wasted. Quantising to 10 min eliminates the duplicates at the source. **Behaviour change for NOAA users**: the same `past_minutes` value now yields half as many frames in the loop, but every frame is unique. Legacy `frame_count: N` configs auto-migrate to the new stride preserving frame count (a `frame_count: 12` config gets `past_minutes: 110` instead of `55`, keeping 12 distinct frames but covering twice the real time span). Tracking a server-side fix upstream at the NOAA / weather.gov API repo — if NOAA exposes a metadata endpoint for actual publication times, we'll drop this conservative quantisation.

### Fixed

- **Stale frames on resume from long-hidden / device-sleep windows.** The existing visibility-visible handler did a single `_updateRadar` to catch the most recent missed publication, which is enough for a few-minute tab switch. After longer hidden periods (device sleep, hours-tabbed-away) the single-frame update left the *rest* of the loop holding hour-old timestamps — the displayed radar would show one fresh frame and N-1 stale ones. Now tracks the wall-clock time of the last frame fetch; on visibility-visible, if more than ~10 min (= 2× the refresh period) has elapsed, scraps the loop entirely and re-fetches every slot from scratch via `_initRadar`. Brief load state on resume from sleep, but the loop content is correct.

## [3.7.0-alpha1] - 2026-06-08

> **Alpha pre-release.** First user-visible consumer of the per-user state framework that shipped dormant in 3.6.5 ([#175](https://github.com/jpettitt/weather-radar-card/pull/175)). Two weeks of feedback expected before promotion through beta / rc / stable, in line with the 3.6.1-rc1 → 3.6.1 cadence. **Not recommended for production dashboards** — install only if you want to exercise the persistence path and report findings.

### Added

- **Adjustable playback speed** ([#157](https://github.com/jpettitt/weather-radar-card/pull/157)) — toolbar button cycles ¼× / ½× / 1× / 2× / 4×, editor dropdown sets the YAML default. Sparse-storage convention: a user's runtime override clears automatically when the chosen value matches the YAML default, so an admin editing the YAML default propagates to every viewer who hasn't explicitly overridden. **Contributed by [@genericJE](https://github.com/genericJE)** — third contribution after [#155](https://github.com/jpettitt/weather-radar-card/pull/155) and [#172](https://github.com/jpettitt/weather-radar-card/pull/172); built on top of the viewer-state framework from #175.

  ```yaml
  type: 'custom:weather-radar-card'
  show_playback: true
  playback_speed: 1            # YAML default; user can override via toolbar
  viewer_layer_control: true   # admin opt-in to persist overrides per-user across browsers/devices
  ```

- **`viewer_layer_control` admin toggle** in the editor's Animation section — opt-in to per-user, per-card preference persistence via Home Assistant's frontend storage. Off by default; when off, the toolbar speed button still works but the value is session-only. The first activation auto-mints a `_layer_state_id` nonce into the card YAML — the per-card storage key that lets a user have different preferences on different cards (e.g. local rain view vs continental forecast view).

### Internal

- First end-to-end exercise of the per-card identity nonce + ViewerState hydrate path introduced in 3.6.5's framework. The hydration WS round-trip races against the toolbar's first paint — on a fresh page load with a non-1× override stored, the speed button label briefly shows the YAML default then snaps to the override once HA's `frontend/get_user_data` resolves (typically one render frame). Documented for awareness; alpha audience can confirm whether this single-frame flicker is acceptable.

## [3.6.5] - 2026-06-03

> Patch release: two small QoL fixes (lightning distance in your HA-preferred unit; broken Blitzortung-integration link in the docs). Plus the per-user state framework lands on `main` as dormant infrastructure for v3.7. **No behaviour change for existing configs.**

### Fixed

- **Lightning strike distance now uses HA's preferred length unit** ([#176](https://github.com/jpettitt/weather-radar-card/pull/176)). The popup that opens when you click a lightning strike was always showing distance in "km" regardless of HA's `unit_system` setting. Imperial users had to mentally convert. Now reads `hass.config.unit_system.length` and formats as "45 km" or "28 mi" accordingly — same signal already used by the Leaflet scale control and range rings. Wildfire / NWS-alert popups don't display distances, so this only affects the lightning popup.
- **Broken Blitzortung-integration link in docs** ([#177](https://github.com/jpettitt/weather-radar-card/pull/177)). README, configuration, overlays, and lightning-feature-design all linked the integration as `home-assistant.io/integrations/blitzortung/`, which is a 404 — there's no native HA Blitzortung integration. Pointed all references at the actual HACS integration at `github.com/mrk-its/homeassistant-blitzortung`. Caught by [@mweinelt](https://github.com/mweinelt). 🙏

### Internal

- **Per-user state framework added on `main`** ([#175](https://github.com/jpettitt/weather-radar-card/pull/175)). New `src/viewer-state.ts` wraps HA's frontend storage WebSocket API to support v3.7's per-user runtime customisation features (layer visibility panel, playback speed override). **Dormant in this release** — no consumer wired up yet, no behaviour change. Documented in [`docs/viewer-state-api.md`](docs/viewer-state-api.md) for contributors.

## [3.6.4] - 2026-05-26

> Patch release: tablet-friendly timeline scrubbing for touchscreen dashboards (opt-in via YAML), a lightning-strike layering fix, and an internal HACS-on-PR ops cleanup. **No breaking changes, drop-in patch over 3.6.3.**

### Added

- **Tablet-friendly timeline scrubbing** ([#172](https://github.com/jpettitt/weather-radar-card/pull/172)). New YAML-only `progress_bar_touch_height` option to enlarge the tappable and draggable progress-bar region upward over the lower map area, while keeping the visible segmented track at 8 px and leaving the bottom chrome unchanged. Set `progress_bar_touch_height: 44` (or whatever touch target size you need) to make timeline scrubbing reliable on touchscreens — the extra touch area overlays the lower edge of the map, so pan/pinch in that strip is consumed by scrubbing. Default unchanged. **Contributed by [@cgjolberg](https://github.com/cgjolberg)**, with real-hardware testing on a landscape touchscreen tablet.

  ```yaml
  type: 'custom:weather-radar-card'
  show_progress_bar: true
  progress_bar_touch_height: 44
  ```

### Fixed

- **Lightning strikes — newest renders on top within each pane** ([#171](https://github.com/jpettitt/weather-radar-card/pull/171)). Leaflet's `L.Marker` defaults to z-index by screen-Y position (southern markers on top), not DOM-insertion order — so when two strikes were close together on screen, the southern one would render on top regardless of arrival time. Added explicit `zIndexOffset` derived from each strike's timestamp so the most recent strike always wins within its pane. Matches Blitzortung's own web map convention.

### Internal

- **HACS validation no longer runs on PRs** ([#173](https://github.com/jpettitt/weather-radar-card/pull/173)). Since #165 untracked the built JS bundle, HACS validation against fork PRs always failed because the fork has no GitHub release with the bundle attached. Validation still runs on push to main and the daily cron; PR code is fully validated by the Build matrix.

## [3.6.3] - 2026-05-23

> Patch release: fixes the GUI editor showing empty/invisible input fields under LOCATION, ANIMATION, APPEARANCE, OVERLAYS, and several marker fields on current HA versions. **The card itself was unaffected** — only the GUI editor was broken; YAML editing always worked. Plus a small cosmetic polish on the marker action buttons.

### Fixed

- **GUI editor inputs invisible on current HA versions** ([#166](https://github.com/jpettitt/weather-radar-card/pull/166)). HA frontend removed `ha-textfield` on 2026-04-01 ([commit "Migrate all from ha-textfield to ha-input #30349"](https://github.com/home-assistant/frontend/pull/30349)), so all 14 of our textfield usages rendered as zero-height invisible elements. Users opening the editor saw section headers (LOCATION, ANIMATION, etc.) with empty space below them — centre coordinates, frame delays, transition time, height/width, wildfire min acres, wildfire radius, and marker positions were uneditable via the GUI. Migrated all usages to the replacement element `ha-input` (1-to-1 API mapping; `helper="..."` renamed to `hint="..."` per the new element's webawesome convention).

### Changed

- **Marker action buttons now use `ha-button`.** The Add Marker, Remove (per marker), and Reset Color (per marker) buttons in the Markers sub-page render with HA's native pill-button style (theme color, white text, ripple) instead of browser-default. Cosmetic only; behaviour unchanged.

### Internal

- Six other bare `<button>` elements (subpage navigation tiles and back links) deliberately stay bare — their custom 3-column / back-link layouts don't fit `ha-button` cleanly.

## [3.6.2] - 2026-05-22

> Patch release: bandwidth optimisation for mobile users (`AbortController` on tile + data fetches), cleanup of phantom dependencies, and a doc-block above the markercluster race workaround. **No new features, no behaviour changes for existing configs.** The 3.6.1 wind-source registry stays Experimental.

### Changed

- **`AbortController` on tile + data fetches** ([#159](https://github.com/jpettitt/weather-radar-card/pull/159)). Radar tiles, wildfire perimeter fetches, NWS alerts (+ per-zone shape fetches), and the RainViewer JSON metadata call now cancel their HTTP requests when superseded by a fresh fetch, when the card tears down, or when Leaflet unloads the tile (pan-out-of-view / zoom). Previously the generation-counter trick discarded stale **responses** but the browser still downloaded the full payload first. On mobile or rate-limited connections a low-zoom continental pan can trigger dozens of tile requests that immediately get superseded — those now show as `(canceled)` in DevTools Network instead of completing. Steady-state playback is unchanged (tiles recycle across frames without unloading → no abort, correct). `src/wind-grid-fetcher.ts` intentionally not instrumented (its request-coalescing makes correct cancellation tricky; the 60 s cache TTL already provides similar bandwidth conservation — revisit when 3.7's layer-control panel adds explicit per-card cancellation).

### Internal

- **Phantom dependencies removed**. `randombytes`, `safe-buffer`, `tslib`, `tsutils` were listed in `dependencies` but not imported anywhere in `src/`, `tests/`, or the rollup config. `tslib` correctly stays as a transitive (via `custom-card-helpers` and `rollup-plugin-typescript2`); the other three drop from `node_modules` entirely. Companion to the `serialize-javascript` security bump that landed in 3.6.1.
- **Markercluster init-race workaround documented**. The `requestAnimationFrame` + try/catch in `_setupResizeObserver` now carries a doc-block explicitly warning future contributors not to "simplify" it. The pattern works around a framework limitation in `leaflet.markercluster` (no lifecycle hook for "cluster tree ready"); replacing it with a synchronous call re-triggers the `_topClusterLevel._bounds` undefined crash from #110 on the resize path.
- **Tests**: 440 → 455. New `tests/fetch-abort.test.ts` pins the `AbortController` / `AbortSignal` contract our error-handler branches depend on, the abort-previous-on-supersession pattern, and `wireAbortLifecycle` + `createFetchTile` integration via minimal layer stubs (consistent with the project's "stub Leaflet, test the helpers" convention).

Three deferred items from the [code review](docs/code-review.md) pass are tracked in [docs/todo.md](docs/todo.md): TypeScript module augmentation for Leaflet (3.8 health pass), Web Worker for the DWD pixel filter (only after profiling shows main-thread spikes), and `WindGridFetcher` cancellation via consumer reference-counting (pair with 3.7 layer-control).

## [3.6.1] - 2026-05-21

> Two stable bug fixes (radar opacity #151, ghost trails on initial load #155), a build-time security bump for `serialize-javascript`, and an **experimental** wind-source registry that adds NDFD over US regions and AICON globally. Promoted from [3.6.1-rc1] (2026-05-16) after a short bake — the wind work keeps its **Experimental** tag for one more release while we gather feedback at viewport boundaries and unusual locales.
>
> **To pin the pre-3.6.1 wind behaviour**: set `wind_source: 'dwd_icon'` in your card YAML (or pick it via the editor's new Wind Data Source dropdown). Existing configs with `dwd_wind` / `dwd_wind_flow` set keep working unchanged; only the wind *data* behind them changes.

### Added — Experimental

- **Wind source registry — pick the forecast model behind the overlay.** New `wind_source` config field selects the data source for the barbs / arrows / streamline overlays. Three options shipping in this release:
  - `'dwd_aicon'` (**new default for non-US**) — DWD's AI-augmented variant of ICON-D2. Same 0.25° global grid (~28 km) and hourly cadence as ICON-D2, served from the same WCS endpoint; visibly better short-range accuracy at zero behaviour cost. Configs without `wind_source` set silently upgrade from ICON to AICON on next reload.
  - `'dwd_icon'` — Raw DWD ICON-D2 numerical model (the previous default). 0.25° global grid, hourly anchor, +48 h forecast, new model run every 3 h. Opt-in for users who prefer the unadjusted model output.
  - `'ndfd_wind'` (**new default for fresh installs in US locations**) — NWS National Digital Forecast Database (forecaster blend of HRRR + RAP + NAM + GFS). **2.5 km over CONUS / AK / HI / PR**, hourly updates, 3-hourly forecast steps out to 7+ days. The same source api.weather.gov gridpoint forecasts come from, but as a raster grid the bulk-fetch pipeline can consume in one WCS call.

  Editor's Wind Overlay subpage has a new Wind Data Source dropdown above the Style picker, and the cadence helper line under it switches per-source. **Fresh installs auto-pick NDFD when HA's location is in NWS coverage** — country code (`hass.config.country === 'US'`) wins outright if set, falls back to a CONUS / AK / HI / PR bbox check on `hass.config.latitude/longitude`. Outside US coverage, fresh installs and existing configs without `wind_source` resolve to AICON (was ICON-D2 in 3.6 — see migration note below). NDFD streamlines render at ~33% of the trail length to compensate for the ~10× finer grid producing visibly longer particle ribbons; ICON / AICON variants render at the full trail length.

  **Silent fallback**: when `wind_source: 'ndfd_wind'` but the viewport centre pans outside NDFD coverage, the fetcher dispatches to AICON for that bbox so US users panning over the Atlantic or Pacific still see real wind data instead of fill values. Configured source is unchanged in the card config; one info log per session announces the auto-switch.

### Changed — Experimental (silent default flip)

- **Default wind source changed from ICON-D2 to AICON for non-US users without an explicit `wind_source` field.** Same provider (DWD), same global 0.25° grid, same hourly cadence, same WCS endpoint — purely an upgrade to the AI-augmented post-processing variant. Set `wind_source: 'dwd_icon'` in YAML (or pick it in the editor dropdown) to revert to the raw numerical model. The wind field will *look* slightly different on first reload after upgrading — that's expected and is the only user-visible effect of the flip.

### Fixed

- **Shadow clouds / flicker at `radar_opacity < 1`** ([#151](https://github.com/jpettitt/weather-radar-card/issues/151)). With per-layer opacity set to `radar_opacity`, two semi-transparent radar layers stacked during the crossfade and the alpha-over composite brightened during the overlap window — visible as "shadow clouds" (rain from both frames showing through where they didn't perfectly align) and as a flicker on every animation tick. Fix moves all radar tile layers into a dedicated `wrcRadar` Leaflet pane (z-index 240, between basemap and wind-flow) and applies `radar_opacity` on the pane. Individual layers now crossfade between 0 and 1, so the composite α inside the pane stays at 1 throughout the overlap; the pane multiplies the whole composite by `radar_opacity` once. DWD coverage mask layer unaffected — already on its own pane, snap-switched, controlled by separate CSS theme vars.
- **Ghost trails of stacked radar frames during initial load** ([#155](https://github.com/jpettitt/weather-radar-card/pull/155)). While the card was still fetching frames on initial load, the playback showed a growing trail of overlapping past frames stacked under the current one — small rain cells looked smeared until the loop completed a full cycle and wrapped back to slot 0. Cause was a missing companion bump: when an older frame finished loading and was prepended to `_loadedSlots`, `_currentSlot` was bumped to keep the same physical frame visible, but `_prev1Slot` (also an index into `_loadedSlots`) was not — so on the next tick `_showSlot` faded out the wrong layer and the actually-visible previous frame stayed orphaned at active opacity until the loop wrapped. Fixed by shifting `_prev1Slot` alongside `_currentSlot`. Contributed by [@genericJE](https://github.com/genericJE).

### Security

- **Bumped `serialize-javascript` 6.0.2 → 7.0.5** to remediate two advisories: [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq) (high, CVSS 8.1 — RCE via crafted `RegExp.flags` / `Date.toISOString`) and [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v) (moderate, CVSS 5.9 — CPU-exhaustion DoS via crafted array-likes). Build-time dependency only (terser/rollup chain); the shipped card bundle never executed `serialize-javascript` so end users were not exposed. Implemented by removing the phantom direct-dependency entry (nothing in `src/` imported it) and adding a `^7.0.5` override that captures the transitive pull through `@rollup/plugin-terser`.

### Known limitations of the experimental wind work

- NDFD's fill-value sentinel (`9999.0` outside coverage) is detected and treated as calm so streamline particles don't teleport, but bilinear sampling within ~1 cell of the coverage boundary may still produce slightly attenuated wind values. Mostly visible at AK / HI coastlines.
- The silent NDFD → AICON fallback uses bbox centre as the decision point. A panning user who half-crosses the coast will see the source flip on the next refetch; transient mid-pan visuals are unaffected.
- 11 locale files have `[en]`-prefixed English fallbacks for the new editor strings (Wind Data Source dropdown label / helper / option labels / per-source cadence notes). Real translations will land in a follow-up; the `[en]` marker is so translators can spot which keys still need attention.

## [3.6.0] - 2026-05-12

> **DWD wind overlay**: barbs, arrows, and animated streamlines sampled from the same ICON-D2 10 m wind layer DWD's WarnWetter app uses. Available regardless of `data_source` (the model is global). Also: bulk WCS fetch architecture (60–290× fewer HTTP requests per refresh vs. the alpha line), edit-mode regression fix, dateline wrap, and a long tuning pass on the streamline visuals.
>
> See the [3.6.0-beta1] entry for the original feature ship and config example, [3.6.0-beta2] for the bulk-fetch rework, and [3.6.0-rc1] / [3.6.0-rc2] / [3.6.0-rc3] / [3.6.0-rc4] for the iterative streamline tuning. This entry is what changed since rc4.

### Fixed

- **Wind streak density and length plateau at z8.** Previously `_zoomDetailMultiplier` ramped from 0.09 at z3 to 1.37 at z12 and `MAX_PX_PER_MPS_PER_FRAME` was 0.30, so city zooms (z9+) ended up ~70% denser AND with ~3× longer streaks than the visually-calibrated z8 reference — the wind field over-painted the basemap at street level. Now the multiplier plateaus at the z8 value (`HIGH_ZOOM_DETAIL_MULT = 0.80`, `REFERENCE_DETAIL_ZOOM = 8` — same z3→z8 slope, just caps above) and `MAX_PX_PER_MPS_PER_FRAME` drops to 0.10 (the z8 reference). z3–z8 look identical; z9+ now match z8 in perceived density and streak length while still resolving finer wind detail (smaller bbox → finer grid samples).

### Cumulative since 3.5.x

A short index of what 3.6.0 actually delivers — full detail in the linked rc / beta entries.

#### New features

- **Lightning overlay** (`show_lightning: true`) — live Blitzortung strikes rendered as bolts that settle into a coloured + sign, ageing white → red over the configured window. Pure renderer; the [Blitzortung integration](https://github.com/mrk-its/homeassistant-blitzortung) does the data plumbing ([3.6.0-alpha1]).
- **DWD wind overlay** — barbs, arrows, animated streamlines (`dwd_wind`, `dwd_wind_flow`); editor subpage; works on RainViewer / NOAA / DWD; per-basemap colour defaults + YAML overrides ([3.6.0-beta1], [3.6.0-beta2], [3.6.0-rc1]).
- **Bulk WCS GetCoverage architecture** — one request per refresh per overlay (was 60–290 per refresh) ([3.6.0-beta2]).
- **Hour-aligned wind refresh** that wakes at HH:00:30 instead of polling on a fixed interval ([3.6.0-beta2]).
- **Static-frame radar mode** (`past_minutes: 0` / "Off (static frame, no animation)" preset) — single-frame view that still refreshes every 5 minutes, no animation loop ([3.6.0-alpha2]).
- **NWS alert paint order** is now lexicographic over (severity, urgency, certainty), so a Tornado Warning Observed correctly paints over a Tornado Warning Radar-Indicated, etc. ([3.6.0-alpha3]).
- **CSS theme variables for the DWD coverage overlay** — `--dwd-coverage-dim-color` and `--dwd-coverage-outline-color` (set either to `transparent` to hide) ([3.6.0-alpha4]).

#### Bug fixes

- **DWD coverage-mask cross-fade pulse** — the grey "no-data" wash and magenta outline that DWD bakes into every tile were stacking during cross-fade, producing a visible pulse on the boundary every animation tick. Fixed by stripping the mask at fetch time and re-rendering the boundary as a snap-switched overlay on a dedicated pane. Contributed by [@genericJE](https://github.com/genericJE) ([3.6.0-alpha4]).
- Edit-mode regression — radar tiles disappearing when entering Lovelace edit mode ([3.6.0-rc1]).
- Dateline wrap on the wind layer ([3.6.0-rc1]).
- Wind streaks render below markers / popups instead of above them ([3.6.0-rc1]).
- Static-frame mode: radar layer no longer disappears on first pan when `past_minutes: 0` ([3.6.0-rc4]).
- Wind streamlines no longer jump as long line segments after the tab returns from being hidden ([3.6.0-rc4]).
- Wind streak density and length cap at z8 (this release).

#### Security

- Defensive `escapeHtml` on all three popup `href` interpolations (NWS, wildfire, lightning). Closes a theoretical attribute-breakout via NWS `props.uri`; wildfire / lightning were safe by construction but hardened against future refactors ([3.6.0-alpha3]).

#### Streamline visual tuning (cumulative)

- Explicit per-particle trail buffer instead of `destination-out` accumulation; 15 fps with motion compensation; cubic ease-in fade-out at end-of-life and at the canvas edge ([3.6.0-rc3]).
- Low-zoom density taper, line-width compensation, sharper trail decay ([3.6.0-rc2]).

## [3.6.0-rc4] - 2026-05-11

> Two bug fixes caught during the rc3 bake — both visible regressions from earlier rc work.

### Fixed

- **Radar layer disappears after first pan in static-frame mode.** When `past_minutes: 0` (one frame, no animation), `_initRadar` showed the static preview but never called `_startLoop` (which requires ≥ 2 loaded slots), so the player's `_prev1Slot` tracker stayed at its initial `-1`. On the first pan/zoom, `onNavPaused` → `_stopLoop` → `_settleVisibility` looped through all loaded radar layers and set `opacity: 0` on every slot whose index didn't match `-1` (i.e., all of them, including the only visible one). The radar precipitation overlay vanished until a full re-init was forced (e.g., a config change). Fixed by initialising `_prev1Slot` to the visible-slot index when the static preview goes up — animated mode unaffected (its `_startLoop` overwrites the value one iteration later).
- **Wind streamlines jump as long line-segments after tab returns from hidden.** Browsers throttle `requestAnimationFrame` to ~1 Hz on background tabs (or pause it entirely). When the tab became visible again, the wind overlay's motion-compensation math (`motionScale = elapsedMs / 33.33`) saw a multi-second gap and scaled per-frame motion by hundreds, producing massive single-frame jumps that drew very long streak segments across the canvas. Fixed by capping the motion-comp `dt` at 2× the target frame interval (~133 ms / motionScale max 4) so any single frame can move at most 4× the per-frame distance (vs. ~2× normal at 15 fps). Particles "lose" the hidden time but resume at a sensible pace on visibility return.

## [3.6.0-rc3] - 2026-05-11

> Continuing rc-line tuning: replaces the `destination-out` accumulation rendering of the wind streamline overlay with explicit per-particle trail buffers, drops the animation rate to 15 fps (with motion compensation) for ~4× lower CPU, and adds a smooth fade-out at end-of-life and at the canvas edge. No new features; pure rendering rework. If nothing surfaces during the rc3 bake, this is what 3.6.0 ships as.

### Changed

- **Wind streamline rendering rewritten**: explicit per-particle ring buffer (60 positions per particle) replaces the previous `destination-out` per-frame alpha decay. Each frame the canvas is cleared and trails are redrawn from each particle's stored history. Eliminates the canvas-accumulation smudge at low zoom (no more opaque ink piling up faster than fade can clear), and gives precise control over when trails appear and disappear.
- **Frame rate throttled to 15 fps** (was uncapped `requestAnimationFrame`, typically 60 Hz on modern displays). Per-second CPU drops by ~4×. Per-frame motion is scaled by actual elapsed-ms vs. a 30 fps reference so wall-clock head speed stays consistent with the previous tuning, and visible streak length doubles (each per-frame segment is now twice as long).
- **Smooth end-of-life fade-out**: the last 15 frames (~1 sec at 15 fps) of every particle's life are rendered at decreasing alpha via a cubic ease-in (`1 - t³`). The cubic keeps early fade frames near full alpha so the transition from "fully alive" to "fading" is imperceptible — earlier linear-fade attempts produced a perceived "flash" at the transition. Particles continue moving during the fade so they "drift away" rather than freezing in place.
- **Smooth fade at canvas edge**: particles drifting off-canvas previously triggered an immediate respawn — the on-canvas portion of the trail vanished in a single frame. Off-canvas detection now bumps the particle's age into the fade window so its visible portion dissipates over the same ~1 sec cubic ease.

### Internal

- Drawing splits into two passes for performance: fully alive particles batched per segment age (cheap, ~60 stroke calls/frame); fading particles drawn per-segment per-particle so each keeps its individual fade alpha (~10k stroke calls/frame at typical density, smooth at 15 fps).
- Removed the destination-out fade infrastructure (`MIN/MAX_FADE_PER_FRAME`, `_fadePerFrame` field, `targetFade` calc).
- New constants: `TRAIL_LENGTH = 60`, `TARGET_FPS = 15`, `MOTION_REFERENCE_FRAME_MS`, `FADE_OUT_FRAMES = 15`.

## [3.6.0-rc2] - 2026-05-11

> Wind streamline tuning pass on top of rc1. Surfaced during rc1 testing: at low zoom (z3-5) the streamlines compounded into a uniform grey band along the wind direction, obscuring the basemap. Fixed by tightening the trail decay, reducing low-zoom particle density, and compensating visually with thicker per-stroke line width. z7 was used as the visual reference (no change to its appearance); the taper applies only at zooms below it.

### Changed

- **Streamline decay sharpened.** Trail fade now targets ~0.5% alpha by particle-lifetime end (was 5%) so the tail visibly ends rather than asymptotically lingering. Particle lifetime cap dropped from 600 frames (20 s) to 120 frames (4 s) so any single slow-moving particle can't deposit ink at the same pixel for an extended window — the dominant contributor to canvas saturation at low zoom.
- **Per-stroke alpha attenuated at low zoom.** New `globalAlpha = pow(detailMultiplier, 1/3)` cube-root scaling: full opacity at z12+, ~0.45 at z3. Cuts ink contribution per stroke without making mid-zoom too faint.
- **Low-zoom density additionally tapered.** Below z7, particle count gets an EXTRA reduction on top of the existing `_zoomDetailMultiplier`: linear ramp from 0.5× at z3 to 1.0× at z7. Z7+ unchanged.
- **Line width inverse-scaled at low zoom.** Strokes are 3 px at z3 → 1 px at z7+ (linear ramp). Compensates visually for the lower density — fewer particles, but each one renders thicker, so the wind field stays readable at continental views.

The cumulative effect: at z3 you get ~50% the particle count, each rendered at 3 px width and ~45% opacity, with trails that crisply fade to invisible by 4 seconds. At z7+ the previous behaviour is unchanged.

## [3.6.0-rc1] - 2026-05-11

> Release candidate for 3.6.0. Both beta2 known issues are resolved (streak layering, dateline wrap), plus an unrelated edit-mode regression caught via live-browser testing. No new features over beta2 beyond per-basemap streamline colour tuning. If nothing surfaces during the rc1 bake, this is what 3.6.0 ships as.

### Added

- **Per-basemap streamline colour defaults + YAML overrides.** The streamline stroke colour was previously a single dark-vs-light branch — satellite shared the dark Carto map's near-white, which got lost on bright terrain. Satellite now has its own brighter pure-white default. Light basemaps also get a deeper default (`rgb(25,30,45)` was `rgb(50,55,75)`) for crisper contrast on OSM / Carto-light tiles. New YAML-only override keys `dwd_wind_flow_color_light`, `_dark`, and `_sat` accept any CSS colour string for theming or custom basemap palettes (editor doesn't expose them).

### Fixed

- **No dateline wrap on the wind layer** (one of the two beta2 known issues). Pacific-centred low-zoom views previously left the wrapped strip on one side of the antimeridian without wind data because `fetchWindGrid` clamped lon to `[-180, 180]`. Now the fetcher detects when the requested bbox extends past ±180° and expands to the full world; the samplers (`sampleWindGridNearest` / `sampleWindGridBilinear`) wrap the queried lon so coords like `-200` correctly resolve to the cell at lon `160`. Costs ~2 MB on the wire (the adaptive-scaling cap), but only triggers on viewports that actually wrap.
- **Wind streaks render above markers and popups** (the second beta2 known issue, now resolved). The streamline canvas now lives in a custom Leaflet pane (z-index 250) — directly above the radar/basemap tile pane and below everything else (wildfire perimeters, NWS polygons, marker shadows, markers, popups). Two earlier in-pane attempts produced a half-viewport offset bug because Leaflet's `mapPane` is intentionally translated to `(W/2, H/2)` to anchor its layer-point coordinate system at the map centre; the fix mirrors what `L.Canvas` does for shape rendering: `L.DomUtil.setPosition(canvas, containerPointToLayerPoint([0, 0]))` cancels that offset so the canvas's `(0, 0)` lands at viewport `(0, 0)`. Side benefit: the manual `_onMove` transform mirror is gone — the pane inherits `mapPane`'s drag transform automatically.
- **Radar tiles disappear when entering edit mode.** HA detaches and re-attaches the card when reorganising the DOM (entering edit mode, sections-grid layout changes). `disconnectedCallback` correctly tore down the Leaflet map; `connectedCallback` didn't re-init it; nothing else triggered a property change so `updated()` never fired and the radar (plus wind, plus all overlays) stayed blank. Fixed by calling `requestUpdate()` in `connectedCallback` when there's a config but no map — the existing `if (!this._map && this._config)` branch in `updated()` then re-initialises the map.

## [3.6.0-beta2] - 2026-05-10

> Wind overlay rework: replaces the per-cell GetFeatureInfo burst with a single bulk WCS GetCoverage call (often **60–290× fewer requests per refresh**), makes the overlay available regardless of `data_source`, and adds substantial visual tuning. No new user-facing config; existing wind YAML keeps working unchanged.

### Added

- **Wind overlay no longer requires `data_source: DWD`.** The ICON-D2 model is global, so the same overlay now stacks usefully on RainViewer / NOAA radar too. Editor's Wind Overlay subpage is shown for all sources. `dwd_time_override` and `forecast_minutes` anchoring is still DWD-only (those concepts don't exist for the other sources).
- **Cadence note in the editor's Wind Overlay subpage** — italic line under the description identifying the source (DWD ICON-D2 forecast, global 0.25°) and refresh cadence (top of each clock hour; new model runs every 3 h). Translated into all 11 supported languages.

### Changed

- **Bulk fetch via WCS instead of N parallel WMS GetFeatureInfo calls.** The wind overlay used to fire one `GetFeatureInfo` request per visual icon position (60–290 per refresh, capped at 400). Now one `GetCoverage` request returns the entire visible bbox as a `text/plain` U/V grid that's parsed locally and indexed by both overlays. **Massive HTTP reduction** with no visual change for the user. When both wind overlays (icons + streamlines) are active on the same map, a request-coalescing cache (60 sec TTL) means they share a single fetch instead of duplicating.
- **Adaptive WCS Scaling for huge bboxes.** Continental and world-scale viewports (z ≤ 4 on wide panels) ask for ~50 000-cell grids via the standard WCS Scaling extension, so the response stays bounded (~2 MB max) instead of exploding to ~25 MB at native resolution. Smaller bboxes still get native 0.25° data. Earlier versions silently rendered nothing at low zoom because the bbox tripped a hard cell cap.
- **Streamline animation: zoom-aware speed + constant on-screen streak length.** Previously the per-frame pixel speed was fixed across zooms — fast at low zoom, crawling at high zoom. Now we compute pixels-per-(m/s) from the map's current centre/zoom (clamped 0.01–0.3 px/(m/s)/frame) so motion is roughly proportional to ground speed at every zoom. Particle lifetime and trail fade auto-recalibrate per refresh to keep the visible ribbon ~40 px regardless of zoom — slower particles live longer and trail more gently.
- **Zoom-detail multiplier** (~0.09 at z3 → ~1.37 at z12, linearly interpolated) drives BOTH particle count AND lifetime. Continental views get fewer, shorter-lived streaks (so the ocean doesn't get painted into a uniform texture); city views get more, longer-lived ones.
- **Hour-aligned refresh** instead of fixed-interval polling. The overlay now self-schedules a refresh at HH:00:30 of each clock hour — exactly when the underlying ICON model's hour bucket changes (or when DWD publishes a fresher run for the same hour). One fetch per hour per overlay, vs. the old 30-min interval that would fetch identical data twice per hour.
- **Streak canvas now lives in Leaflet's `overlayPane`** (z-index 400) instead of being a child of the map container. Two payoffs: marker icons / popups / NWS / wildfire layers now render ABOVE the streaks (was the reverse — wind canvas was overlaying everything because it sat outside `mapPane`'s stacking context); and the canvas inherits Leaflet's per-frame drag transform automatically, so streaks drift smoothly with the cursor instead of "jumping" on moveend.
- **Bilinear sampling consolidated.** Both overlays now share `sampleWindGridBilinear`, with cell-centre-anchored semantics that match the WCS data layout. The streamline overlay was previously using a node-anchored variant that introduced a half-cell systematic offset (~14 km at native).

### Fixed

- **Wind silently rendering nothing at low zoom + wide viewports.** Three independent failure modes resolved: (a) bbox cell count exceeding the previous hard cap → fixed by switching to adaptive WCS Scaling; (b) Leaflet's `getBounds()` returning lat/lon outside `[-90, 90] / [-180, 180]` on wide panels at low zoom → fixed by clamping the WCS subset to layer extent; (c) WCS Scaling returning a grid where lon-step ≠ lat-step but the parser using one step for both axes → fixed by reading `elt_0_0` and `elt_1_1` separately.
- **WCS XML exception bodies in HTTP 200 responses** are now detected explicitly and surfaced with a descriptive error (`WCS returned exception — <text>`). Previously they bubbled up as a useless `parseWcsTextGrid: missing Grid bounds line` message that obscured the real cause.
- **Wind icons (barbs/arrows) waiting behind the radar tile burst on every map move.** The static-icon overlay now debounces moves at 50 ms (down from 250 ms) — the WCS request fires before the radar player's 100 ms post-moveend tile fetch saturates the browser's per-origin connection pool.

### Tests

370 → **399**. Net change after dropping 7 standalone `bilinearUV` tests (the function was deleted and the streamline overlay now shares `sampleWindGridBilinear`'s coverage in `wind-grid-fetcher.test.ts`). New cases pin: the WCS text parser (8 cases — bounds/dimensions, row-flip, band-split, bad-input rejection, single-cell grid, non-square cells under WCS Scaling); `sampleWindGridNearest` and `sampleWindGridBilinear` (10 cases — exact-cell, half-cell-blend, both-axis-blend, bbox-edge clamping, out-of-bbox, empty grid); `fetchWindGrid` URL building (8 cases — multi-subset format, time-quoting, scaleSize add/skip, layer-extent clamp, 5xx error, XML exception detection); `WindGridFetcher` coalescing (7 cases — concurrent share, TTL expiry, key separation by bbox/time, jitter snap, retry-on-failure).

### Known issues

Two visual issues we know about and intend to address before 3.6.0 stable:

- **Wind streaks render above markers and popups.** The streak canvas lives in `map.getContainer()` (outside Leaflet's `mapPane` stacking context), so its z-index puts it above marker/popup panes regardless of value. Putting the canvas inside any `mapPane` child produced a positioning bug — the canvas content offset by ~half the viewport and drifted relative to the map during scroll. The proper fix is to subclass `L.Layer` and participate in Leaflet's renderer-bounds + setPosition lifecycle (mirrors what L.Canvas does for its shape rendering). Marker/popup *clicks* are unaffected — `pointer-events: none` lets them through; this is purely a visual layering issue.
- **No dateline wrap on the wind layer.** When a low-zoom view's bbox crosses the antimeridian (e.g., a Pacific-centred view that shows -200° to +160° lon), the fetcher clamps to `[-180, 180]` and the wrapped strip on one edge renders without wind data. Splitting into two WCS requests at the dateline and stitching the results would fix it; deferred because it complicates the cache key and adds a synchronisation point. Affects the small fraction of users who centre their map at high or low longitude.

## [3.6.0-beta1] - 2026-05-10

> Promotes the 3.6 alpha line to beta and folds in @genericJE's [DWD wind overlay (PR #133)](https://github.com/jpettitt/weather-radar-card/pull/133): wind barbs, arrows, and animated streamlines, all sampled from the same ICON-D2 10 m wind layer DWD's WarnWetter app uses. Beta scope freeze — no new features after this; bugfix-only path to 3.6.0.

### Added

- **DWD wind overlay** — three independent styles, all client-rendered from DWD's `Icon_reg025_fd_sl_UV10M` WMS layer (10 m wind from ICON-D2):
  - `dwd_wind: 'barbs'` — meteorological wind barbs in northern-hemisphere convention (feathers CCW of staff). Calm cells render as open circles.
  - `dwd_wind: 'arrows'` — discrete downwind arrows colour-coded by Beaufort-ish bands (calm grey → light green → fresh teal → orange → storm red).
  - `dwd_wind_flow: true` — animated streamlines à la the DWD WarnWetter app / earth.nullschool.net. Canvas2D with alpha-fade trails, ~1500 particles. Stacks with barbs/arrows.

  Both static modes honour `dwd_time_override` and `forecast_minutes`, so the wind layer follows the radar's current playback anchor. `dwd_wind_density` (0.25–4, default 1) tunes the on-screen grid; `dwd_wind_size` (0.5–2, default 1) is an independent multiplier on icon size — the two parameters used to be coupled (size = base / √density), but that bundled "more arrows" with "smaller arrows" and made one slider do two jobs. Editor exposes a new "Wind Overlay" subpage under MARKERS AND OVERLAYS, only shown when `data_source: DWD`.

  Streamlines respect OS-level `prefers-reduced-motion` (the animation is purely decorative — barbs/arrows still convey direction & speed), with a live matchMedia listener so toggling System Settings takes effect without a card reload.

  Example config:

  ```yaml
  type: custom:weather-radar-card
  data_source: DWD
  dwd_wind: arrows
  dwd_wind_flow: true
  dwd_wind_density: 1.0
  dwd_wind_size: 1.0
  ```

  Contributed by [@genericJE](https://github.com/genericJE).

### Changed

- **Map z-index constants** centralised in `const.ts` (`Z_BASEMAP`, `Z_LABELS`, `Z_RADAR_BASE`) so the layer stack is documented in one place. Wind overlays sit above tilePane (200) and below markerPane (600); the streamline canvas explicitly at z=500.

### Tests

347 → **370**. New: 23 cases for the wind overlay's pure helpers — `speedColour` (all 6 Beaufort band boundaries), `decomposeBarbKnots` (rounding to nearest 5 kt; pennant → full → half decomposition order including the 55-kt = 1 pennant + 1 half edge case), `bilinearUV` (empty grid, out-of-bbox samples, exact corner sampling, single-axis interpolation, full bilinear blend, off-zero origin + non-1 step). Lifted out of class-state methods so the most fragile new code is unit-testable in isolation.

### Cumulative since 3.5.0

This beta consolidates everything from the 3.6 alpha line:

- **DWD as a fully-supported data source** with regional WMS layers, NIFC wildfires, lightning markers, and the new wind overlay (3.6.0-alpha1)
- **NWS alert paint order** is now a lex sort over (severity, urgency, certainty), not single-key severity (3.6.0-alpha3)
- **Static-frame mode** via History Duration "Off" / `past_minutes: 0` (3.6.0-alpha2)
- **DWD coverage-mask cross-fade pulse fix** — strip the server-baked grey wash + magenta outline at fetch time, re-render the boundary as a snap-switched overlay (3.6.0-alpha4)
- **XSS-hardening pass** on three popup `href` interpolations (3.6.0-alpha3)

## [3.6.0-alpha4] - 2026-05-10

> Lands @genericJE's DWD coverage-overlay fix (originally [PR #132](https://github.com/jpettitt/weather-radar-card/pull/132), brought across as [PR #141](https://github.com/jpettitt/weather-radar-card/pull/141)) — the per-frame snap-switched mask that kills the cross-fade pulse on the DWD coverage outline.

### Fixed

- **DWD coverage-mask cross-fade pulse.** The grey "no-data" wash and magenta coverage outline that DWD's WMS bakes into every Niederschlagsradar / Radar_wn tile were stacking during the per-frame cross-fade — two semi-transparent layers compounded the dim and produced a visible pulse on the boundary every animation tick. Two-part fix: strip the mask + outline at fetch time via a new `pixelFilter` option on `FetchTileOptions`, then re-render the boundary as a separate snap-switched overlay on a dedicated Leaflet pane (z-index 350) so it doesn't participate in the cross-fade. Per-frame mask layers (rather than a single static one) so radar-station outages track correctly. Tested in the wild against the Feldberg outage at 08:25 UTC. Contributed by [@genericJE](https://github.com/genericJE).

### Added

- **Two CSS theme variables** for the coverage overlay colours — set either to `transparent` to hide:
  - `--dwd-coverage-dim-color` (default `rgba(0, 0, 0, 1)`)
  - `--dwd-coverage-outline-color` (default `rgba(255, 0, 255, 1)`)

  RGB picks the colour, alpha multiplies the original mask alpha so wash density and outline antialiasing both scale.

### Tests

329 → **347**. New: 18 cases for `classifyDwdPixel` (the heart of the mask-stripping pipeline — opaque palette purples per palette, canonical magenta-outline rule, off-palette purple-shape blends, equal-channel grey, canonical radar palette colours that should pass through, brightness-floor and saturation-shape boundary cases, semi-transparent edges, the 15-unit drift threshold for grey detection) plus 3 cases for `dwdPaletteFor` (layer-name → palette mapping). Pin against DWD palette drift — if their colour ramp ever changes, the strict-match whitelist will silently mis-classify, and these tests catch it.

## [3.6.0-alpha3] - 2026-05-07

> Two NWS-layer improvements: a smarter paint order for overlapping alerts, plus an XSS-hardening pass on every popup `href` interpolation. Same-day fix-and-improvement release for the 3.6 alpha track.

### Security

- **Escape three popup `href` interpolations.** The NWS, wildfire, and lightning popup builders each had a `<a href="${url}">` interpolation that wasn't going through `escapeHtml`. Only the NWS one had a known attack surface (`props.uri` is server-controlled, but the existing scheme check blocks `javascript:` URIs *not* HTML attribute breakouts via `"` or `>`). Wildfire (`linkSlug` is `slugify`-derived) and lightning (`url` is built from clamped numeric inputs) were safe by construction; defensive escape protects against future refactors. No known live exploit at any of the three sites — the fix closes the theoretical gap.

### Changed

- **NWS alert paint order is now lexicographic over (severity, urgency, certainty)** — replaces the prior single-key severity-ascending sort. Severity dominates (matching the `alerts_min_severity` filter), urgency breaks severity ties (`Past < Unknown < Future < Expected < Immediate`), certainty breaks urgency ties (`Unknown < Unlikely < Possible < Likely < Observed`). Result: a Tornado Warning Observed paints over a Tornado Warning Radar-Indicated; both paint over Severe Thunderstorm Warnings; Wind Advisory Observed over Frost Advisory; etc. CAP-standard fields, no event-name regex.

### Tests

316 → **329**. New coverage:

- 8 cases for the three-axis lex sort (severity primary, urgency secondary, certainty tertiary, severity-dominates-other-axes, Past < Unknown urgency, all-defaults vs missing properties, realistic mixed-alerts pin)
- 5 cases for `buildPopupHtml` URL escaping (attribute-breakout escaped, javascript: scheme triggers fallback, normal uri unchanged, `< > &` in uri escaped, null/undefined uri falls back to alerts index)

## [3.6.0-alpha2] - 2026-05-06

> Small follow-up to alpha1: a "no animation" option for users who want a static current-frame view. The animation was always on prior to 3.6 because `getEffectiveTimeRange` floored the frame count at 2 — `past_minutes: 0` silently became a 2-frame loop. Now `0` means 1 frame.

### Added

- **History Duration "Off (static frame, no animation)"** option in the editor's preset dropdown. Selecting it sets `past_minutes: 0`, the player loads exactly one frame and stays on it (no animation loop). The periodic 5-minute refresh still updates the single frame so it doesn't go stale. Helper text under the dropdown switches to "Static frame — no animation, refreshes every 5 min" to confirm the mode.

### Fixed

- **`getEffectiveTimeRange` floor lowered from 2 to 1**, so `past_minutes: 0` actually produces 1 frame instead of being silently rounded up to 2 (which previously made the static-frame mode unreachable from YAML or the editor).

### Tests

314 → **316**. Two new cases pin the new floor behaviour: single-frame for past=0 + no forecast, multi-frame still produced when past=0 + forecast > 0 on DWD.

### Localization

11 languages updated for the two new editor strings (`past_off`, `helper_static`). Coverage parity verified at 100%.

## [3.6.0-alpha1] - 2026-05-06

> First alpha cut of the 3.6 line. New feature: a lightning overlay sourced from the Blitzortung HA integration. No external HTTP from the card — the integration handles all the data plumbing; we just render.
>
> Also includes the tile-active fix and the radar pan/zoom no-teardown perf improvement (PRs [#130](https://github.com/jpettitt/weather-radar-card/pull/130) + [#131](https://github.com/jpettitt/weather-radar-card/pull/131) from [@genericJE](https://github.com/genericJE), already on master) — they're carried through this alpha by virtue of merging master in.
>
> **Coming in 3.6.0-beta1:** the DWD coverage-mask pulse fix ([#132](https://github.com/jpettitt/weather-radar-card/pull/132)) and the wind overlay ([#133](https://github.com/jpettitt/weather-radar-card/pull/133)) — both pending review feedback addressed by [@genericJE](https://github.com/genericJE). 3.6.0 stable will consolidate alpha1 + beta1.

### Added

- **Lightning overlay** (`show_lightning: true`) — live lightning strikes from the [Blitzortung integration](https://github.com/mrk-its/homeassistant-blitzortung), rendered from the integration's `geo_location.lightning_strike_*` entities. Each strike appears as a brief lightning-bolt flash with a one-shot pulse animation (the "happening now!" indicator), and after 30 s settles into a coloured **+** sign. The + sign's fill colour ages through Blitzortung's web-map gradient (white → yellow → orange → coral → red → dark red), mirroring the visual language of [their map](https://map.blitzortung.org/). Newer strikes always paint on top of older ones. Click any strike for a popup with distance / cardinal-bearing from the map centre, relative time, and a deep link into the Blitzortung web map at the strike location.
- **Two-pane outline-vs-fill rendering** for the + sign — outline marker on a pane at z 499, coloured-fill marker on z 500. At low zoom many overlapping strikes don't dissolve into a "black blob" — outlines stack harmlessly underneath, the topmost colour fill stays clean on top. Bolts stay single-marker (they're bigger and only last 30 s, no stacking issue).
- **`lightning_max_age_minutes` config** (default 30) — card-side cap that hides strikes older than N minutes. Distinct from the Blitzortung integration's own max-age setting (the integration's setting is the upper bound; the card's cap is whichever is smaller). Editor field with a helper line making the boundary clear.
- **`lightning_pulse` config** (default `true`) — disable the appearance flash. Honours `prefers-reduced-motion` automatically.
- **`lightning_icon_size` config** (YAML-only, default 14 px) — pixel size for the + sign; the bolt renders at 1.3× this size.
- **Hazard Overlays editor row** — Show Lightning toggle disabled + dimmed when the Blitzortung integration isn't loaded, with a tooltip explaining how to enable it. Same `disabled-row` UX pattern as `square_map` when the height is pinned.
- **Detection helper `isBlitzortungLoaded(hass)`** — checks `hass.config.components` for `'blitzortung'`. Editor and layer both gate on this so a quiet day (no current strikes) doesn't make the toggle disappear.
- **6-stop colour gradient** in `colorForAge()` — driven by a `COLOR_STOPS` table, single `lerpHex` per call regardless of where t lands. Adding a stop is a one-line edit.
- **CSS drop-shadow halo** on every strike marker — gives a 2 px black outline against any basemap or radar overlay colour. Cheaper than nesting concentric SVG shapes.
- **Custom Leaflet panes** `wrc-lightning` (z 500) and `wrc-lightning-outline` (z 499) — between the default `overlayPane` (400) and `markerPane` (600), so lightning sits over radar / wildfire / NWS-alert polygons but the home / person markers stay on top of any strike at the same point.

### Localization

11 language files updated for the new editor strings (Lightning section header / description / integration-required tooltip / max-age field + helper / overlay summary label / Show Lightning toggle) and the popup strings (lightning_strike title, source label, "more info" link, eight cardinal bearings, four relative-time keys). Coverage parity verified at 100% across all 11 languages.

### Tests

314 unit tests (43 new for lightning helpers — `isBlitzortungLoaded` edge cases, `colorForAge` 6-stop endpoints + monotonicity + clamps + zero-maxAge defence, `bearingCardinal` 8-way + same-point + antimeridian, `relativeTime` bucket boundaries + fractional flooring + negative-input clamp, `formatBlitzortungUrl` precision + zoom clamping, plus pins on `BOLT_DURATION_SEC` and `DEFAULT_BLITZORTUNG_MAX_AGE_SEC`).

### Documentation

- New [docs/lightning-feature-design.md](docs/lightning-feature-design.md) marked shipped-in-3.6.0-alpha, with deviations-from-design notes covering the visual-treatment iteration that landed during smoke testing.
- [docs/overlays.md](docs/overlays.md) gains a Lightning section with the knobs table and a NOTE explaining the card-side cap vs the integration's setting.
- [docs/configuration.md](docs/configuration.md) options table gains the four lightning fields.
- [docs/todo.md](docs/todo.md) moves the lightning entry from Open to Shipped.

## [3.5.0] - 2026-05-05

> Stable cut of the 3.5 line. Two big new US-only overlays (wildfires, NWS watches & warnings), a source-agnostic time-range editor that retires `frame_count`, a DWD-outside-coverage banner, animation polish, three quality-of-life contributions from [@genericJE](https://github.com/genericJE), and a full docs sweep. Consolidates the `3.5.0-alpha`, `3.5.0-alpha2`, and `3.5.0-beta1` prereleases.
>
> **US-only data** in the new overlays — see the strong life-safety disclaimers in [docs/overlays.md](docs/overlays.md).

### Added

#### Hazard overlays (US-only)

- **Wildfire perimeter overlay** — `show_wildfires: true` overlays active US wildfire perimeters from NIFC's [WFIGS Current Interagency Fire Perimeters](https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters/about) feed. Active fires draw red, fully-contained ones grey. Small incidents render as a fire icon at the centroid; larger ones as a polygon outline. Click any fire for a popup with name, acreage, containment %, discovery date, and a link to NIFC's InciWeb (gated against InciWeb's RSS index so we don't link to 404s). Adaptive 5/30-minute refresh. Filter knobs: `wildfire_min_acres` (default 10), `wildfire_radius_km`, plus colour / fill / refresh overrides.
- **NWS watches & warnings overlay** — `show_alerts: true` overlays active US National Weather Service watches and warnings from `api.weather.gov/alerts/active`. Alerts render as translucent polygons coloured per [NWS's standard warning palette](https://www.weather.gov/help-map). Both polygon-bearing and zone-based alerts render: zone shapes are fetched on-demand from `api.weather.gov/zones/...` and cached in localStorage (TTL 30 days, versioned key prefix `wrc-zone-v1:`) so they're zero-network on subsequent sessions. Click any alert for a popup with event, headline, severity / certainty / urgency, effective and expiry windows, full description (preserves NWS's line breaks), and a link to weather.gov.
- **Hazard Overlays editor subpage** — new top-level "Markers and Overlays" section in the editor groups two nav rows: **Markers** (the existing list) and **Hazard Overlays** (new). The Hazard Overlays subpage exposes the wildfire and alerts toggles, their per-overlay knobs (min_acres, radius_km, min_severity), and a 2-column grid of NWS alert-category checkboxes (Tornado, Thunderstorm, Flood, Winter, Tropical, Fire Weather, Heat, Wind, Marine, Other; marine off by default).
- **Region-warning utility** — surfaces a banner when any US-only feature (wildfires, alerts, NOAA radar) is enabled with `hass.config.country !== 'US'`. Multiple US-only features collapse into a single combined banner instead of stacking. Adds a separate banner for **DWD selected outside its coverage** (Germany + immediate neighbours: NL, BE, LU, FR, CH, AT, CZ, PL, DK), replacing the developer-facing one-shot `console.warn` from 3.4.0 with a visible UI cue.

#### Time-range editor (replaces `frame_count`)

- **`past_minutes` / `forecast_minutes` config** — source-agnostic time-range fields that work across all radar sources. The editor renders them as preset dropdowns filtered by per-source caps: RainViewer and NOAA show `20 / 40 / 60 / 120 min` (cap 2 h — NOAA's API advertises 4 h but frames > 2 h come back empty in practice); DWD shows up to 12 h (`20 min – 12 h`). YAML can reach the API cap (DWD: 84 h, paired with `frame_stride_minutes` to keep the frame count sane).
- **Forecast Duration field** appears only on sources with a forecast (currently DWD: `Off / 1 h / 2 h`). Hidden in the DOM for RainViewer / NOAA.
- **`frame_stride_minutes`** — YAML-only escape hatch for users who want very large past windows on DWD without the implied frame count.
- **`SOURCE_CAPS` table** in `src/source-caps.ts` is the single source of truth for per-source `intervalMin` / `maxPastMin` / `editorMaxPastMin` / `maxForecastMin` / defaults. Adding a new radar source = adding a row.
- **Auto-migration** — `migrateConfig` silently converts legacy `frame_count` to `past_minutes` (using the source's native interval) and `dwd_forecast_hours` to `forecast_minutes`. Existing configs need no changes; warning logged once. The DWD-only `dwd_past_hours` field proposed in [#121](https://github.com/jpettitt/weather-radar-card/pull/121) by [@genericJE](https://github.com/genericJE) prompted this broader source-agnostic redesign.

#### Animation

- **`smooth_overlap` config knob (0–1)** — tunable crossfade overlap when `smooth_animation: true`. `0` = sequential (no brightness dip; cushion held), `0.5` = 50% overlap, `1` = fully simultaneous (default; brief mid-transition dip). Fade duration auto-calibrates so the full cycle still equals `frame_delay` regardless of overlap. Exposed in the editor as a 0–1 slider with mutual gating against `transition_time`.

#### Other

- **Loading spinner** — a small rotating indicator sits in the centre of the bottom bar while radar tiles are being fetched (initial load, post-pan/zoom reload, periodic 5-minute refresh); hidden when only cached frames are cycling. Honours `prefers-reduced-motion`. `show_loading_spinner: false` suppresses. Contributed by [@genericJE](https://github.com/genericJE) (#124).
- **"Now" marker on the progress bar** — the segment whose timestamp is closest to wall clock now gets a small amber stripe at the top, a `title="Now"` tooltip, and the displayed timestamp gains a `(now)` suffix while playback shows that frame. Mostly useful with DWD forecast frames where "now" sits in the middle of the timeline. The stripe colour follows HA's `--warning-color` theme variable. Contributed by [@genericJE](https://github.com/genericJE) (#125).
- **Build timestamp in console signon** — the card's startup signon now reads `WEATHER-RADAR-CARD Version X.Y.Z (built YYYY-MM-DD HH:MM:SS UTC)` so users can confirm a hard refresh actually loaded the new bundle vs a cached older one.

### Changed

- **WYSIWYG map editing** — when this card's edit dialog is open, every pan/zoom in the live map auto-propagates to the editor's Lat/Long/Zoom fields in real time. The "Save as map center" button is removed entirely. Detection via window-level events from the editor element's connect/disconnect lifecycle, with a global mount counter to handle the dialog mount-order race.
- **Toggle layout standardised** — every `<label>` switch now renders as `[switch] [text]` left-aligned with a gap. Single source of truth.
- **Per-source rate limiters are now module-level singletons** — survive card teardown (config edits no longer reset the count) and are shared across multiple weather-radar-cards on the same dashboard.
- **Pause when hidden** — wildfire and NWS-alerts layers stop their refresh timers when the card scrolls off-screen or the tab is hidden, and refetch on resume if the pause was longer than the visible-refresh interval. Radar player already paused itself.
- **Dynamic radar tile size** — picks 256 / 512 / 1024 / 2048 from `map.getSize()` so panel-view / fullscreen maps load with bigger tiles (fewer requests for the same coverage). All three radar sources support this. **Empirically cuts load time and rate-limit hits on larger maps.**
- **`npm run build` regenerates `.js.gz`** alongside the `.js` so HA can't serve a stale gzipped bundle from a previous build.

### Fixed

- **Trail on first cycle after editing animation settings.** Changing animation settings used to leave stale CSS-transition state on the radar layers, producing a visible trail on the first cycle after the change. `setConfig` now does a full teardown + reinit on any structural config change. Exception: back-propagated `center_latitude` / `center_longitude` / `zoom_level` are diffed and skipped — a teardown there would interrupt the user's active interaction. Direct YAML edits still move the map via `setView`, guarded against re-firing as a back-prop bounce.
- **Editor-open detection race** — a fresh card opened in HA's edit dialog used to silently miss the back-propagation of map pan/zoom into the editor's Lat/Long fields, because the dialog can mount the editor before the preview card. Card now consults a global mount counter on connect to recover from the missed event.
- **`alerts_categories: []` now correctly hides everything.** Previously an explicit empty array fell back to the default category set, so unchecking every category in the editor reverted to "show everything". New `getActiveAlertCategories(configured)` helper distinguishes `undefined` (use defaults) from `[]` (none).
- **Popup `[wildfire]` race during zone resolution.** `_zoneFetches` could be left with stale entries on localStorage cache hits because the function returned synchronously before the caller registered it. Refactored so `_fetchZone` self-registers as its first action.
- **Popup accent colour uses WCAG-style relative luminance** — replaces a hardcoded list of "light" hex values, so any future palette additions get the right text colour automatically.
- **Dark / satellite map scale rendered a faint duplicate label** behind the main "50 km" text. Leaflet's default `.leaflet-control-scale-line` carries a `text-shadow: 1px 1px #fff` for readability on light basemaps; on the dark / satellite styles that shadow rendered as a ghost. The `.map-dark` override now sets `text-shadow: none`. Contributed by [@genericJE](https://github.com/genericJE) (#123).
- **Popup "See README" links scrolled to the top of the README** instead of the relevant safety-disclaimer section. The README split that landed during 3.5 removed the `#wildfires` and `#nws-watches--warnings` headings the popup links anchored against; both wildfire and NWS-alert popup links now target the matching headings in `docs/overlays.md`.
- **Editor toggle markup standardisation regression.** The Loading Spinner row was the lone holdout — text-then-switch with no `<span>`, instead of the canonical `[switch][text]` pattern used everywhere else. Realigned.
- **Markercluster `_bounds`-undefined race in the resize path** ([#110](https://github.com/jpettitt/weather-radar-card/issues/110) re-emergence). The 3.1.3 fix capped cluster zoom at 11 to avoid the same race during `_zoomEnd`; the resize path (`invalidateSize` → `markercluster._zoomEnd`) hits the same trap when a `ResizeObserver` callback fires before the cluster group's first bounds computation completes. Defer to next animation frame and wrap `invalidateSize()` in a `try/catch` to recover on the rare remaining edge case.

### Documentation

- New `docs/wildfire-feature-design.md` and `docs/nws-alerts-feature-design.md` design docs; planning notes moved to `docs/`.
- 495-line README split into a slim landing page plus focused docs under `docs/` (Configuration, Data Sources, Hazard Overlays, Markers, Examples, Animation architecture). Options table moved to [`docs/configuration.md`](docs/configuration.md) and now includes `past_minutes`, `forecast_minutes`, `show_loading_spinner`, `show_wildfires`, `show_alerts`, the DWD-only fields, and all per-overlay knobs.
- `docs/animation.md` rewritten to match the current two-slot + delayed-fade-out model (`_crossfadeTiming()` table, `_settleVisibility()`, dynamic tile size, time-range derivation).

### Localization

11 language files now at **100% key parity**. Pre-release pass added the 5 keys missing from the 10 non-English files (`editor.display.show_loading_spinner`, `editor.map.source_dwd`, `ui.loading_radar_tiles`, `ui.now`, `ui.now_tooltip`), the new `ui.region_warning.dwd_de_only` for the DWD coverage banner, and dropped the stale `editor.animation.frame_count` / `editor.animation.default_5` keys from all 11 files (replaced by the time-range editor in 3.5). Brand acronyms (NWS, NOAA, NIFC, README) and the "Acres" US unit intentionally retained in source form.

### Tests

128 → **268** unit tests (140 added). New coverage: geo helpers (centroid, haversine, bbox), string helpers (escapeHtml XSS injection patterns, slugify, truncate), NWS alert categories, NWS alert colour table, region-warning composition (now including DWD coverage countries, non-coverage countries, case-insensitive matching, US-only + DWD stacking), alert-layer helpers (featureKey, decisionsEqual including zone-arrival diff, severity-sort, luminance, formatDateTime, localStorage zone cache round-trip + TTL eviction + corrupt JSON + quota-exceeded handling), `getEffectiveTimeRange` (defaults, clamps, stride snapping, edge cases), `migrateConfig` time-range migration, `nearestFrameIndex` for the now marker. Pure-helper extraction (`src/geo-utils.ts`, `src/string-utils.ts`, `src/source-caps.ts`) deduplicates code that was previously identical between layers.

## [3.4.0] - 2026-05-04

> Stable cut of the 3.4 line. Two new radar sources, a rebuilt crossfade engine, and a clean editor experience for the animation timing knobs. Pre-releases `3.4.0-beta` (DWD + crossfade fix) and `3.4.0-beta2` (smooth_overlap + setConfig polish) consolidated here.

### Added

- **DWD radar source** — `data_source: DWD` uses Deutscher Wetterdienst's `Niederschlagsradar` WMS at `maps.dwd.de`. 5-minute frame steps (vs. RainViewer's public 10-minute tier), ~3 days of history, +2 hours of forecast available via the `Radar_*-product_*` layers. Coverage is the German radar network footprint (Germany + immediate neighbours). Contributed by [@genericJE](https://github.com/genericJE) (#114).
- **`dwd_layer` config option** — DWD-only WMS layer name override. Default `Niederschlagsradar` (mm/h). Set to `Radar_wn-product_1x1km_ger` for reflectivity (dBZ) with 2-hour nowcast frames included.
- **`dwd_time_override` config option** — DWD-only ISO timestamp to anchor frames at a fixed point in time instead of "now". Useful for verifying the overlay renders when current weather is dry.
- **`dwd_forecast_hours` config option** — DWD-only. Includes this many hours of nowcast forecast in the playback range as if they were "current". When set to a positive value the layer auto-switches from `Niederschlagsradar` to `Radar_wn-product_1x1km_ger` (which carries the +2h nowcast frames) unless `dwd_layer` explicitly overrides it. Matches the DWD WarnWetter app's default behaviour.
- **DWD-coloured colour bar** — `data_source: DWD` shows a horizontal strip using DWD's `Niederschlagsradar` palette (15 bands sampled from DWD's official legend), replacing the misleading universal-blue scale used as a fallback before. Same UI shape as the existing NOAA / RainViewer bars; honours `show_color_bar: false`.
- **DWD coverage check** — `data_source: DWD` emits a one-shot `console.warn` when HA's configured location falls outside the bounding box of Germany and its immediate neighbours, so the inevitable no-data grey wash isn't mistaken for a broken card.
- **`smooth_animation` config option** — when `true`, the crossfade auto-calibrates so the full cycle equals `frame_delay`; the radar appears to flow continuously instead of stepping. Overrides `transition_time`. Contributed by [@genericJE](https://github.com/genericJE) (#113).
- **`smooth_overlap` config knob (0–1)** — tunable crossfade overlap when `smooth_animation: true`. `0` = sequential (no brightness dip; cushion held), `0.5` = 50% overlap, `1` = fully simultaneous (default; brief mid-transition dip). Fade duration auto-calibrates so the full cycle still equals `frame_delay` regardless of overlap. Exposed in the editor as a 0–1 slider.
- **Editor mutual gating for animation timing** — `transition_time` is disabled when Smooth Animation is on (the smooth path computes its own fade); `smooth_overlap` is disabled when Smooth Animation is off. Both fields stay visible so the relationship is obvious.

### Changed

- **DWD rate limiter raised to 500/min** (from the initial conservative 120/min, copied from NOAA). DWD's `maps.dwd.de` is fronted by Akamai with no documented per-IP limit; 120 was visibly throttling pan/zoom bursts (~80 tile requests in one move) without ever seeing 429s from the server. 500/min matches RainViewer.
- **DWD tiles requested at 512×512** instead of the default 256×256 — quarters the request count for the same map coverage. Useful for the same burst case above and reduces total bandwidth slightly since the per-tile overhead is amortised.

### Fixed

- **Crossfade no longer pulses against light basemaps** (#113). The previous symmetric crossfade animated the outgoing layer 1→0 while the incoming layer animated 0→1. At the midpoint both layers sat at opacity 0.5 and alpha-composed to ~0.75 visibility — letting 25% of the basemap show through at every transition. Replaced with a two-slot model: the new current frame gets a higher z-index, snaps to `0`, then fades to `radar_opacity` with `ease-in-out`; the immediately-previous frame (the cushion) stays at full opacity through the fade-in window via CSS `transition-delay`, then begins its own fade-out so old data dissolves smoothly instead of snapping out. Older frames stay hidden throughout. At the loop boundary — when the player wraps from the last frame back to the first after the restart pause — transitions snap instead of fading, since the natural pause makes a smooth fade across the loop read as "time ran backwards". `_settleVisibility()` is called on every pause to leave a known clean state in the layer DOM.
- **Trail on first cycle after editing animation settings.** Changing animation settings used to leave stale CSS-transition state on the radar layers, producing a visible trail on the first cycle after the change. `setConfig` now does a full teardown + reinit on any structural config change. Exception: when the user pans/zooms the live map in editor mode, the back-propagated `center_latitude` / `center_longitude` / `zoom_level` keys are diffed and skipped — a teardown there would interrupt the user's active interaction. Direct YAML edits to those keys still move the map (via `setView`), guarded against re-firing as a back-prop bounce.
- **Internal options no longer leak into WMS GetMap URLs.** `FetchWmsTileLayer` was passing its full options object to Leaflet's `L.TileLayer.WMS.initialize`, which appends any unrecognised option as a query parameter — so requests carried `&rateLimiter=[object%20Object]&on429=...&animationOwnsOpacity=true` tail-end, which were ignored by the server but bloated the URL and confused log inspection. Now strips those internal fields before delegating, then re-attaches them to `this.options` for the rest of the layer code. Affects both NOAA and DWD WMS layers.

### Documentation

- README config table includes `smooth_overlap`; the Animation section now describes the actual two-slot model with `smooth_animation` / `smooth_overlap` semantics, the loop-boundary snap, and the pause-settle behaviour.
- `animation.md` rewritten to match the v3.4.0 architecture (two-slot crossfade, `_crossfadeTiming()` table, `_settleVisibility`, dynamic tile size).

### Localization

11 language files updated for the new editor strings.

## [3.3.0] - 2026-04-30

### Added

- **Editor localization** — every label, helper, dropdown option, and banner string in the editor and runtime UI now resolves through `localize()`. Existing translations updated for Norwegian Bokmål (nb) and Slovak (sk); new translations added for German (de), French (fr), Dutch (nl), Spanish (es), Italian (it), Polish (pl), Swedish (sv), and Portuguese-Brazilian (pt-BR). Translations are best-effort and welcome native-speaker review.

## [3.2.0] - 2026-04-30

### Added

- **`radar_opacity` config option** — adjust the opacity of the active radar frame (0.1–1.0, default `1.0`). Lower values let more of the basemap show through. Editor exposes a slider in the Appearance section.

## [3.1.3] - 2026-05-01

### Fixed

- **Markers disappeared when clustering was on** (#110). The map's `maxZoom` bump from 10 to 16 in 3.1.2 expanded markercluster's internal cluster tree by six zoom levels, exposing a markercluster bug where a cluster's `_bounds` could end up undefined and crash `_zoomEnd` (`Cannot read properties of undefined (reading 'lat')`). The crash left the marker pane completely empty. Setting `disableClusteringAtZoom: 11` on the cluster group caps the cluster tree depth — beyond zoom 11 markers display individually anyway, so there's no behavioural cost.

## [3.1.2] - 2026-04-29

### Changed

- Map `maxZoom` raised from 10 to 16. Basemaps will sharpen up to their native resolution; the radar overlay (capped at `maxNativeZoom: 7`) will upscale and look pixelated past zoom 7. User-requested tradeoff.
- Cluster badge count fix (3.1.1) now applies to **all** `zone.*` markers, not just `zone.home`. A cluster with `zone.work + 3 device_trackers` shows badge `3`. The cluster icon is rendered from the user-configured icon on the representative zone marker (preferring `zone.home` if present, otherwise the first zone in the cluster), falling back to `mdi:home` / `mdi:map-marker-radius` when no icon is set.

## [3.1.1] - 2026-04-27

### Changed (build / release)

- **`dist/weather-radar-card.js.gz` is no longer tracked on feature branches.** Each branch CI was independently rebuilding the gzipped artefact, causing binary merge conflicts on every PR. The `.gz` is now regenerated by CI on push to `master` (so master always has a fresh one matching the served `.js`) **and** by the release workflow on `release: published` (which uploads `.js` + `.gz` as release assets). HACS picks up the assets directly, so existing installs always overwrite their stale `.gz` on update.

### Changed

- Footer / progress bar / links now use HA theme CSS variables (`--card-background-color`, `--primary-text-color`, `--primary-color`) — custom themes are picked up automatically. The previous hard-coded two-tone scheme is gone.
- `map_style: auto` follows `hass.themes.darkMode` (so the map matches HA's dark-mode setting whether the user picks it manually or has HA follow the browser); falls back to OS `prefers-color-scheme` only when HA hasn't exposed a value. The map rebuilds automatically when the flag flips.

### Fixed

- Home cluster badge now counts only non-home markers (e.g. home + 3 others shows `3`, not `4`). Badge is hidden entirely when a cluster contains only home markers.

## [3.1.0] - 2026-04-26

Multi-marker overhaul. **Breaking:** single-marker config fields (`show_marker`, `marker_latitude`, `marker_longitude`, `marker_icon`, `marker_icon_entity`, `mobile_marker_*`) are deprecated. Existing YAML auto-migrates in memory on load with a console warning; the editor only writes the new `markers[]` format.

### Added

- **Multi-marker support** — `markers[]` array replaces the old single-marker fields. Each entry supports `entity`, `latitude`, `longitude`, `icon`, `icon_entity`, `color`, `track`, and `mobile_only`.
- **Live entity tracking** — markers with an `entity` field update their position on every HA state change. Works with `device_tracker.*`, `person.*`, `zone.*`, or any entity with `latitude`/`longitude` attributes.
- **Track resolution** — set `track: entity` or `track: true` on a marker to auto-centre the map. Priority: (1) `track: entity` on a `person.*` whose `user_id` matches the logged-in HA user, (2) `track: entity` on any other entity, (3) `track: true`. The tracking winner always renders on top (`zIndexOffset: 1000`).
- **Default home marker** — when `markers` is absent, the card auto-creates a single `zone.home` marker. `markers: []` opts out.
- **Auto-migration** — old single-marker fields are converted to `markers[]` in memory on load; existing YAML continues to work.
- **Marker clustering** (`cluster_markers`, default `true`) — nearby markers collapse into a count badge; tap/click to spiderfy. The tracked marker always renders outside the cluster. Home clusters render as the home icon with a small superscript count badge.
- **`mobile_only` marker flag** — a marker with `mobile_only: true` only renders on mobile devices (HA Companion app, mobile UA, or screen width ≤ 768 px). Replaces the old `mobile_marker_*` fields.
- **Any MDI icon supported** — markers render via HA's `<ha-icon>` element so any name in HA's icon database works (e.g. `mdi:car-pickup`, `mdi:rocket`). No hardcoded allow-list.
- **Icon picker autocomplete** — the editor's marker icon field uses HA's `ha-icon-picker` with full MDI autocomplete and live preview.
- **Smart icon auto-detect on entity selection** — picking an entity in the editor auto-fills the icon from `attributes.icon` → `device_class` lookup → `source_type` (device_tracker: router / bluetooth / gps) → domain default (`mdi:account`, `mdi:home`, `mdi:map-marker-radius`, `mdi:map-marker`). Person entities default to their photo when one is available.
- **Use entity picture toggle** — person markers get a dedicated switch to choose between the entity photo and an MDI icon.
- **Per-marker `color`** — CSS colour for `mdi:*` and default icons.
- **Theme-aware footer** — the footer / progress-bar chrome now follows HA's theme setting (or OS `prefers-color-scheme`), independent of map style. Re-renders automatically on theme change.
- **NWS colour bar** — `data_source: NOAA` renders the NWS reflectivity scale (`radar-colour-bar-nws.png`) instead of RainViewer's universal-blue scale.
- **Unit test suite** — 128 Vitest tests covering migration, position resolution, track priority, icon rendering, rate limiting, and mobile detection. Runs in CI on every push and PR.
- **CI builds dist for every branch** — feature branches get an auto-built bundle committed back; bundle marked `linguist-generated` so PR diffs hide it.

### Changed

- **Editor Location section** only contains map-center coordinates; marker configuration is in the new Markers section with per-marker rows.
- **Editor Mobile Overrides section removed** — use `mobile_only: true` on a marker instead.
- **Editor map-style default** — selector correctly shows `Auto` when `map_style` is unset (previously showed `Light`).
- **Production build minified** — terser added back. Bundle ~707 kB → ~278 kB; gzip ~143 kB → ~77 kB. Watch mode skipped for fast iteration.

### Removed

- **`mobile_center_*` fields** — undocumented and unused; removed entirely.
- **Editor `card_title` control** — the field was orphaned (never read anywhere).

### Fixed

- `width` config field is now applied to the card.
- `square_map: true` no longer collapses the map to zero height.
- NOAA animation playback direction (was newest → oldest).
- Colour bar `src` and visibility hoisted into the lit template — previously a rate-limit or fetch failure could leave the bar empty with no `src`.
- `map_style: Satellite` home marker now uses the light SVG (was using dark).
- Map z-index isolation, timestamp wrapping, and LitElement rendering carried forward from v3.0.2.

## [3.0.2] - 2026-04-25

### Fixed

- Map floating above HA navigation drawer / sidebar — added `isolation: isolate` to `:host` to cap Leaflet's z-index:1000 controls inside the card's stacking context (#95).
- Locale-aware timestamp wrapping to a second line in the bottom bar — added `white-space: nowrap`.
- Card producing no DOM after the TS target moved to ES2022 — set `useDefineForClassFields: false` so native class field semantics no longer shadow LitElement's `@property()` accessors. `moduleResolution` updated from deprecated `node` to `bundler`.

## [3.0.1] - 2026-04-24

### Added

- `disable_scroll` option — disables map pan/drag (mouse and touch) while keeping pinch-to-zoom active; lets mobile users swipe through the HA dashboard without moving the map

### Fixed

- `show_scale` had no effect — the Leaflet scale control was never added to the map despite the option being present in config and the editor toggle being wired. Now correctly renders the scale bar, respecting the HA instance unit system (metric / imperial).

## [3.0.0] - 2026-04-24

### Added

- NOAA/NWS radar source — US-only experimental mode using MRMS base reflectivity via `mapservices.weather.noaa.gov`
- Show Snow option — includes or excludes snow in RainViewer precipitation tiles
- Rate-limit banner — visible indicator when the API tile quota is temporarily exhausted
- Save map center in edit mode — pan/zoom the card while editing and click the overlay button to write `center_latitude`, `center_longitude`, and `zoom_level` back to config without manually entering coordinates
- Marker icon options — `default`, `entity_picture`, and MDI icon types configurable per device (desktop / mobile)
- `show_color_bar` option — hide the RainViewer radar colour scale bar (default shown)
- `show_progress_bar` option — hide the frame timeline bar (default shown)
- `map_style: Auto` — follows OS dark/light mode via `prefers-color-scheme`; map reinitialises automatically when the system theme changes at runtime
- `double_tap_action` — configurable double-tap/double-click action: built-in shortcuts (`recenter`, `toggle_play`) or any standard HA action object (`navigate`, `call-service`, etc.)
- Scrubbable timeline — click or drag the progress bar to seek to any frame; dragging pauses playback, releasing resumes it
- Locale-aware frame timestamp — uses `Intl.DateTimeFormat` with the browser locale, so 12 h (AM/PM) or 24 h is chosen automatically per the user's regional settings

### Changed

- **Breaking: Leaflet is now bundled.** `leaflet.js`, `leaflet.css`, `leaflet.toolbar.min.js`, and `leaflet.toolbar.min.css` are no longer distributed as separate files — they are compiled into `weather-radar-card.js`. Delete the old files from `www/community/weather-radar-card/` when upgrading.
- **Breaking: iframe removed.** The card is now a native LitElement / Shadow DOM component. No srcdoc, no opaque origin workarounds, proper HA theming integration.
- Leaflet.Toolbar2 replaced by a native `L.Control` implementation — removes the external toolbar dependency entirely.
- Animation engine replaced: frame switching is now driven by JavaScript opacity writes with CSS `transition` for crossfades, replacing the previous CSS `@keyframes` engine. More reliable across all browsers in Shadow DOM context.
- Map auto-selects `Light` (CARTO) for English-language HA instances in light mode and `OSM` for all other languages; `map_style: Auto` extends this with dark-mode awareness.
- Marker defaults to HA home location (`hass.config.latitude/longitude`) rather than the card's `center_latitude` — changing the map center no longer moves the marker.
- Navigation settle delay reduced from 500 ms to 100 ms.

### Fixed

- Animation flash-on-load caused by duplicate `_initRadar` runs sharing the same frame generation counter
- `_updateRadar` crash when the RainViewer API returns an empty frame list
- `_updateRadar` mutations continuing after card teardown (missing generation guard)
- `once('load')` callback in `_updateRadar` running after `clear()` with no teardown guard
- `resolveCoordinate` treating coordinate `0` (equator / Prime Meridian) as falsy and substituting the fallback value
- Mobile marker icon defaulting to `entity_picture` when not explicitly configured
- `visibilitychange` listener accumulating on `document` across card reinitializations (never removed)
- Worker Blob URL never revoked on `clear()`
- Editor direct mutation of `@state` config via `delete` instead of spreading to a new object

## [2.2.0] - 2026-01-05

### Changed

- **CRITICAL**: Replaced deprecated Rollup build plugins with modern @rollup/* equivalents
  - Migrated from rollup-plugin-babel to @rollup/plugin-babel
  - Migrated from rollup-plugin-commonjs to @rollup/plugin-commonjs
  - Migrated from rollup-plugin-node-resolve to @rollup/plugin-node-resolve
- Updated build tooling to latest versions
  - Rollup: 2.79.1 → 4.31.0
  - TypeScript: 4.8.3 → 5.7.3
  - ESLint: 7.32.0 → 8.57.1
  - Prettier: 2.7.1 → 3.4.2
  - @rollup/plugin-json: 4.1.0 → 6.1.0
  - @rollup/plugin-terser: 0.4.4 (replaces rollup-plugin-terser)
  - @typescript-eslint packages: 5.38.1 → 8.19.1
- Updated framework dependencies
  - Lit: 2.2.2 → 3.3.2
  - home-assistant-js-websocket: 5.11.1 → 9.4.0
- Migrated to ES modules (added "type": "module" to package.json)
- Renamed .eslintrc.js to .eslintrc.cjs for CommonJS compatibility

### Fixed

- Performance: Fixed shouldUpdate() to use proper change detection instead of always returning true
- Security: Added JSON.stringify() to all config value injections to prevent potential template injection
- Build: Added proper ES module imports with .js extensions for Rollup 4.x compatibility
- Build: Added createRequire for require.resolve() usage in ES modules

### Security

- Zero vulnerabilities detected after dependency updates
- Improved security with proper escaping of configuration values in iframe templates

## [2.1.1] - 2024

### Added

- Entity attribute support for dynamic coordinate tracking
- Mobile device detection for coordinate overrides
- Configurable height and width options for the card

### Changed

- Updated maintainer information (John Pettitt)

## [2.1.0] - 2022-09-14

### Fixed

- Fixed compatibility with Home Assistant 2022.11 breaking changes
- Updated Leaflet to 1.9.1

## [2.0.4] - 2022

### Added

- Imperial units support - card displays miles in scale when HA is set to imperial
- Extra attribution links in footer
- Card title support

### Fixed

- Map style exception handling
- Attribution links

### Changed

- Updated default location and zoom level
- Removed radar locations and geofence features

## Earlier Versions

For changes in versions prior to 2.0.4, please refer to the git commit history.

[Unreleased]: https://github.com/jpettitt/weather-radar-card/compare/v3.7.0-beta2...HEAD
[3.7.0-beta2]: https://github.com/jpettitt/weather-radar-card/compare/v3.7.0-beta1...v3.7.0-beta2
[3.7.0-beta1]: https://github.com/jpettitt/weather-radar-card/compare/v3.7.0-alpha3...v3.7.0-beta1
[3.7.0-alpha3]: https://github.com/jpettitt/weather-radar-card/compare/v3.7.0-alpha2...v3.7.0-alpha3
[3.7.0-alpha2]: https://github.com/jpettitt/weather-radar-card/compare/v3.7.0-alpha1...v3.7.0-alpha2
[3.7.0-alpha1]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.5...v3.7.0-alpha1
[3.6.5]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.4...v3.6.5
[3.6.4]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.3...v3.6.4
[3.6.3]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.2...v3.6.3
[3.6.2]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.1...v3.6.2
[3.6.1]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.1-rc1...v3.6.1
[3.6.1-rc1]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0...v3.6.1-rc1
[3.6.0]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-rc4...v3.6.0
[3.6.0-rc4]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-rc3...v3.6.0-rc4
[3.6.0-rc3]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-rc2...v3.6.0-rc3
[3.6.0-rc2]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-rc1...v3.6.0-rc2
[3.6.0-rc1]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-beta2...v3.6.0-rc1
[3.6.0-beta2]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-beta1...v3.6.0-beta2
[3.6.0-beta1]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-alpha4...v3.6.0-beta1
[3.6.0-alpha4]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-alpha3...v3.6.0-alpha4
[3.6.0-alpha3]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-alpha2...v3.6.0-alpha3
[3.6.0-alpha2]: https://github.com/jpettitt/weather-radar-card/compare/v3.6.0-alpha1...v3.6.0-alpha2
[3.6.0-alpha1]: https://github.com/jpettitt/weather-radar-card/compare/v3.5.0...v3.6.0-alpha1
[3.5.0]: https://github.com/jpettitt/weather-radar-card/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/jpettitt/weather-radar-card/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/jpettitt/weather-radar-card/compare/v3.2.0-beta...v3.3.0
[3.2.0]: https://github.com/jpettitt/weather-radar-card/compare/v3.1.3-beta...v3.2.0-beta
[3.1.3]: https://github.com/jpettitt/weather-radar-card/compare/v3.1.2...v3.1.3-beta
[3.1.2]: https://github.com/jpettitt/weather-radar-card/compare/v3.1.1...v3.1.2
[3.1.1]: https://github.com/jpettitt/weather-radar-card/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/jpettitt/weather-radar-card/compare/v3.0.2...v3.1.0
[3.0.2]: https://github.com/jpettitt/weather-radar-card/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/jpettitt/weather-radar-card/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/jpettitt/weather-radar-card/compare/v2.2.0...v3.0.0
[2.2.0]: https://github.com/jpettitt/weather-radar-card/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/jpettitt/weather-radar-card/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/jpettitt/weather-radar-card/compare/v2.0.4...v2.1.0
[2.0.4]: https://github.com/jpettitt/weather-radar-card/releases/tag/v2.0.4
