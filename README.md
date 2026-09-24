# Weather Radar Card

A Home Assistant rain radar card using tiled radar imagery from RainViewer, NOAA/NWS, and DWD (Deutscher Wetterdienst).

[![hacs_badge](https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)
![Maintenance](https://img.shields.io/maintenance/yes/2026?style=for-the-badge)

## Description

This card displays animated weather radar loops within Home Assistant. It supports multiple radar data sources and map styles, and can be zoomed and panned seamlessly. Markers, hazard overlays (US wildfires + NWS watches & warnings), real-time lightning, a forecast nowcast (DWD), opt-in [motion-compensated playback](https://github.com/jpettitt/weather-radar-card/blob/main/docs/configuration.md#motion-compensation) (rain drifts between frames instead of teleporting), adjustable playback speed with optional per-user persistence, full sections-grid resize support, and 11 languages.

![Weather Radar card](weather-radar-card.gif)

### Video demo

Full-screen capture with every feature enabled — radar with motion compensation, lightning, wind streamlines, hazard overlays, playback controls:

[![Watch the demo on YouTube](https://img.youtube.com/vi/xfbZRElOi0o/maxresdefault.jpg)](https://youtu.be/xfbZRElOi0o)

## What's new in 3.10 (current stable)

The wind overlays no longer show a stale wind field outside the US, and there's a new option to stop the mouse wheel hijacking dashboard scrolling.

- **Fixed wind arrows/barbs/flow showing a day-old wind field** (sometimes looking reversed) outside the US — DWD's server returns its oldest slice for a missing or off-step time, and the card now always requests the current one. ([3.9.1-beta1](https://github.com/jpettitt/weather-radar-card/releases/tag/v3.9.1-beta1))
- **`disable_wheel_zoom` option (YAML-only)** — the mouse wheel scrolls the dashboard instead of zooming the map, while the +/- buttons, pinch and drag keep working (unlike `static_map`). ([3.10.0-beta1](https://github.com/jpettitt/weather-radar-card/releases/tag/v3.10.0-beta1))

For the full release history see [CHANGELOG](https://github.com/jpettitt/weather-radar-card/blob/main/CHANGELOG.md).

## What's new in 3.9

CARTO began requiring an API key to avoid a watermark on their free basemap tiles (Light/Voyager/Dark/Satellite) — this release adds an option to remove it, plus two new basemap styles that never need a key at all.

- **`carto_api_key` config option** — free CARTO API key (no account needed — [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/)) removes the watermark. Set it in the editor's Map section or via YAML; leaving it unset keeps the previous (watermarked but working) tiles.
- **Two new no-key map styles: `Grey` and `GreyDark`** — Esri Light/Dark Grey Canvas basemaps, for anyone who'd rather not sign up for a CARTO key at all.

## Roadmap

Active threads, no specific version commitment — with 3.10 shipped, these target 3.11 or later. See [docs/todo.md](https://github.com/jpettitt/weather-radar-card/blob/main/docs/todo.md) for the full backlog with status per item.

- **Real-time per-user layer visibility control panel** — UI for toggling individual overlays in real time. Persistence framework already shipped (3.6.5); first consumer shipped (playback speed in 3.7.0-alpha1); the on-map panel itself is the remaining piece. Full design in [docs/layer-control-design.md](https://github.com/jpettitt/weather-radar-card/blob/main/docs/layer-control-design.md).
- **Additional wind sources** — Open-Meteo for global coverage, ICON pressure levels for upper-air wind, regional finer-than-ICON-D2 sources (AROME, MEPS, HRRR). Tiers and trade-offs documented in [docs/todo.md](https://github.com/jpettitt/weather-radar-card/blob/main/docs/todo.md).

## Documentation

| Topic | What's there |
| --- | --- |
| [Configuration](https://github.com/jpettitt/weather-radar-card/blob/main/docs/configuration.md) | Full options table, Map Style choices, Animation knobs, Double-tap action, sections-grid behaviour |
| [Data Sources](https://github.com/jpettitt/weather-radar-card/blob/main/docs/data-sources.md) | RainViewer / NOAA / DWD specifics, per-source caps, NOAA & DWD notes, DWD forecast leading-edge note |
| [Hazard & Layer Overlays](https://github.com/jpettitt/weather-radar-card/blob/main/docs/overlays.md) | US wildfire perimeters, NWS watches & warnings, lightning (Blitzortung), and global wind — usage, knobs, **safety disclaimers** |
| [Markers](https://github.com/jpettitt/weather-radar-card/blob/main/docs/markers.md) | The `markers[]` schema, track-resolution rules, default home marker, migration from the legacy single-marker fields |
| [Examples](https://github.com/jpettitt/weather-radar-card/blob/main/docs/examples.md) | Sample YAMLs for common setups (basic, dense DWD loop, NOAA, OSM, mobile-only, person tracking, hazard overlays) |
| [Animation architecture](https://github.com/jpettitt/weather-radar-card/blob/main/docs/animation.md) | Internal: layer z-stack, two-slot crossfade, opacity ownership, dynamic tile size, pause behaviour, invariants |
| [Wildfire feature design](https://github.com/jpettitt/weather-radar-card/blob/main/docs/wildfire-feature-design.md) | Internal: NIFC WFIGS feed, render decisions, InciWeb gating, refresh cadence |
| [NWS alerts feature design](https://github.com/jpettitt/weather-radar-card/blob/main/docs/nws-alerts-feature-design.md) | Internal: api.weather.gov polling, zone resolution + caching, severity sort, popup chrome |
| [Wind feature design](https://github.com/jpettitt/weather-radar-card/blob/main/docs/wind-feature-design.md) | Internal: bulk WCS fetch + adaptive scaling, coalescing cache, zoom-aware streamlines, layering |
| [Motion compensation feature design](https://github.com/jpettitt/weather-radar-card/blob/main/docs/motion-compensation-feature-design.md) | Internal: pyramidal Lucas-Kanade optical flow, distance-from-white channel, inline-Blob worker pattern, crossfade-time translate |
| [Backlog / TODO](https://github.com/jpettitt/weather-radar-card/blob/main/docs/todo.md) | Open and shipped features |
| [Contributing](https://github.com/jpettitt/weather-radar-card/blob/main/CONTRIBUTING.md) | Local dev setup including the Docker HA testbed (`npm run ha:up`) |

## Install

### HACS

The card is part of the default HACS store. To install the latest stable, search for "Weather Radar Card" in HACS → Frontend → Explore & Add Repositories. Toggle **Show beta versions** in HACS to opt into prereleases.

### Manual

Download the files from the [latest release](https://github.com/jpettitt/weather-radar-card/releases) and place them in `www/community/weather-radar-card` in your HA `config` directory:

```text
└── configuration.yaml
└── www
    └── community
        └── weather-radar-card
            └── weather-radar-card.js
            └── home-circle-dark.svg
            └── home-circle-light.svg
            └── pause.png
            └── play.png
            └── preview.jpg
            └── radar-colour-bar-dwd.png
            └── radar-colour-bar-nws.png
            └── radar-colour-bar-universalblue.png
            └── recenter.png
            └── skip-back.png
            └── skip-next.png
```

> **Upgrading from v2?** Delete `leaflet.js`, `leaflet.css`, `leaflet.toolbar.min.js`, and `leaflet.toolbar.min.css` from `www/community/weather-radar-card/` — they are bundled into `weather-radar-card.js` in v3 and the old files are no longer used.

Then add the following to your Lovelace resources:

```yaml
resources:
  - url: /local/community/weather-radar-card/weather-radar-card.js
    type: module
```

## Minimal config

```yaml
type: 'custom:weather-radar-card'
```

That's it. The card defaults to RainViewer, your HA instance's location, and a `zone.home` marker. From there, the GUI editor exposes every knob — see [Configuration](https://github.com/jpettitt/weather-radar-card/blob/main/docs/configuration.md) for the full reference and [Examples](https://github.com/jpettitt/weather-radar-card/blob/main/docs/examples.md) for common starting points.

For touchscreen dashboards, YAML can enlarge the timeline scrub target upward over the lower map while preserving its slim visual track and original bottom-bar height:

```yaml
show_progress_bar: true
progress_bar_touch_height: 44
```

## Sizing

How tall the card renders depends on where it lives:

- **Masonry / panel views, or a sections cell with `rows: auto`** — the card uses the `height:` config option (default `400px`). This is the normal case.
- **A sections-grid cell with a fixed row count** (you've dragged the resize handle, or `rows:` is a number) — **the grid cell owns the height.** The card fills the cell and the `height:` option is ignored; resize it with the cell's drag handle instead. The editor disables the height box in this case so it's clear which control is in charge.

In other words: `rows: auto` → `height:` applies; `rows: <number>` → the cell's height applies. See [sections-grid behaviour](https://github.com/jpettitt/weather-radar-card/blob/main/docs/configuration.md#sections-grid-support) for details.

## Changelog

See [CHANGELOG.md](https://github.com/jpettitt/weather-radar-card/blob/main/CHANGELOG.md) for the complete history of changes.

[license-shield]: https://img.shields.io/github/license/jpettitt/weather-radar-card.svg?style=for-the-badge
[releases-shield]: https://img.shields.io/github/release/jpettitt/weather-radar-card.svg?style=for-the-badge
[releases]: https://github.com/jpettitt/weather-radar-card/releases
