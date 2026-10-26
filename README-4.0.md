# Weather Radar Card

A Home Assistant rain radar card using tiled radar imagery from RainViewer, NOAA/NWS, and DWD (Deutscher Wetterdienst).

[![hacs_badge](https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)
![Maintenance](https://img.shields.io/maintenance/yes/2026?style=for-the-badge)

> **This is the 4.0 branch.** 4.0 is a release candidate. It adds Home Assistant's vector map under the radar, view presets and layer toggles. [3.13.0](https://github.com/jpettitt/weather-radar-card/blob/main/README.md) is the current stable release, on the `main` branch. To try 4.0, turn on **Show beta versions** for this card in HACS. To go back, select 3.13.0 in the same place. [Upgrading to 4.0](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/upgrading-to-4.0.md) lists what changes.

## Description

This card displays animated weather radar loops within Home Assistant. It supports multiple radar data sources and map styles, including Home Assistant's own vector map with place names drawn above the radar, and can be zoomed and panned seamlessly. Markers, view presets, hazard overlays (US wildfires + NWS watches & warnings) with per-user layer toggles, real-time lightning, a forecast nowcast (DWD), opt-in [motion-compensated playback](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/configuration.md#motion-compensation) (rain drifts between frames instead of teleporting), adjustable playback speed with optional per-user persistence, full sections-grid resize support, and 11 languages.

![Weather Radar card](weather-radar-card.gif)

### Video demo

Full-screen capture with every feature enabled — radar with motion compensation, lightning, wind streamlines, hazard overlays, playback controls:

[![Watch the demo on YouTube](https://img.youtube.com/vi/xfbZRElOi0o/maxresdefault.jpg)](https://youtu.be/xfbZRElOi0o)

## What's new in 4.0

### Breaking changes

- **Home Assistant 2026.4 or later.** The editor's text fields use HA's `ha-input`, which HA added in 2026.4. On older Home Assistant, use 3.x: the card works there. From 3.6.3, the 3.x editor's text fields are empty on HA before 2026.4, so set those options in YAML.
- **Re-centre with a tracked marker.** The button now switches between the tracked marker and Default, the configured centre. Default holds, with tracking paused, until the next press or until `preset_timeout` idle minutes (default 5) return the map to the tracked marker. Set `preset_timeout: 0` to hold Default until the next press. Cards without a tracked marker re-centre as before.
- **Manual installs need a second file.** `weather-radar-card-maplibre.js` must sit next to `weather-radar-card.js`. HACS installs it. See [Install](#install).

### Features

- **[`map_style: MapTilesVector`](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/configuration.md#map-style)** (experimental) — Home Assistant 2026.10's vector map under the radar. Place names are drawn above the radar and above every overlay, so they stay readable through rain. Sharp at every zoom, light or dark with HA's theme. Without WebGL2, or in `low_power_mode`, the card shows `MapTiles` instead.
- **`vector_style`** — one of the six styles of HA's map cards, or `classic`: the colours of the classic OpenStreetMap map, with a dark version tuned by hand.
- **`theme_mode: auto | light | dark`** — forces the light or dark version of `MapTilesVector`, `Auto` and `MapTiles`.
- **Satellite labels above the radar** — on HA 2026.10+, `Satellite` draws place and street names from HA's map tiles above the radar. No CARTO key is needed for them.
- **`extra_labels` on the vector map and Satellite** — each label kind appears a zoom level earlier, smaller and packed tighter.
- **[View presets](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/configuration.md#view-presets)** — `presets` turns the re-centre button into a rotation: the tracked marker, Default, then each saved view, a fixed spot or an entity the map follows, each with its own zoom. The map returns on its own after `preset_timeout` idle minutes. The editor's *Presets* page edits them on the preview map.
- **[Layer toggles](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/overlays.md#turning-overlays-on-and-off)** — `show_layer_toggles` adds buttons in the map's top-right corner that hide or show NWS alerts, wind, wildfires and lightning. A hidden overlay stops fetching. With `viewer_layer_control`, each user's choices are saved.
- **Editor** — the Display toggles are in four groups, the map settings show only the fields the chosen style uses, and the preview card has the size it has on the dashboard.
- **Dark tile maps are greyer** — the inverted map keeps less of its colour, so forests and roads no longer compete with the radar.

See [Examples](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/examples.md#40-vector-map-in-the-classic-style-with-labels-above-the-radar) for ready-made 4.0 configurations. For the 3.x history see the [CHANGELOG](https://github.com/jpettitt/weather-radar-card/blob/4.0/CHANGELOG.md).

## Roadmap

Active threads, no specific version commitment. See [docs/todo.md](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/todo.md) for the full backlog with status per item.

- **Additional wind sources** — Open-Meteo for global coverage, ICON pressure levels for upper-air wind, regional finer-than-ICON-D2 sources (AROME, MEPS, HRRR). Tiers and trade-offs documented in [docs/todo.md](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/todo.md).

## Documentation

| Topic | What's there |
| --- | --- |
| [Upgrading to 4.0](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/upgrading-to-4.0.md) | What changes from 3.13, how to try 4.0, how to go back |
| [Configuration](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/configuration.md) | Full options table, Map Style choices (vector map included), Animation knobs, low power mode, View presets, Double-tap action, sections-grid behaviour |
| [Data Sources](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/data-sources.md) | RainViewer / NOAA / DWD specifics, per-source caps, tile caching, NOAA & DWD notes, DWD forecast leading-edge note |
| [Hazard & Layer Overlays](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/overlays.md) | Layer toggles, US wildfire perimeters, NWS watches & warnings, lightning (Blitzortung), and global wind — usage, knobs, **safety disclaimers** |
| [Markers](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/markers.md) | The `markers[]` schema, track-resolution rules, default home marker, migration from the legacy single-marker fields |
| [Examples](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/examples.md) | Sample YAMLs for common setups, and the 4.0 features: vector map, satellite labels, presets, layer toggles |
| [Animation architecture](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/animation.md) | Internal: layer z-stack, two-slot crossfade, opacity ownership, dynamic tile size, pause behaviour, invariants |
| [Layer control design](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/layer-control-design.md) | Internal: the per-user layer toggles and the viewer-state framework behind them |
| [Wildfire feature design](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/wildfire-feature-design.md) | Internal: NIFC WFIGS feed, render decisions, InciWeb gating, refresh cadence |
| [NWS alerts feature design](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/nws-alerts-feature-design.md) | Internal: api.weather.gov polling, zone resolution + caching, severity sort, popup chrome |
| [Wind feature design](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/wind-feature-design.md) | Internal: bulk WCS fetch + adaptive scaling, coalescing cache, zoom-aware streamlines, layering |
| [Motion compensation feature design](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/motion-compensation-feature-design.md) | Internal: pyramidal Lucas-Kanade optical flow, distance-from-white channel, inline-Blob worker pattern, crossfade-time translate |
| [Backlog / TODO](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/todo.md) | Open and shipped features |
| [Contributing](https://github.com/jpettitt/weather-radar-card/blob/4.0/CONTRIBUTING.md) | Local dev setup including the Docker HA testbed (`npm run ha:up`) |

## Install

### HACS

The card is part of the default HACS store. To install the latest stable, search for "Weather Radar Card" in HACS → Frontend → Explore & Add Repositories. To get 4.0 while it is in alpha, turn on **Show beta versions** for the card in HACS. HACS installs both files.

### Manual

Download the files from the [latest release](https://github.com/jpettitt/weather-radar-card/releases) and place them in `www/community/weather-radar-card` in your HA `config` directory:

```text
└── configuration.yaml
└── www
    └── community
        └── weather-radar-card
            └── weather-radar-card.js
            └── weather-radar-card-maplibre.js
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

Copy the `.js.gz` files too if you have them: HA serves the compressed copy when one sits next to the file. `weather-radar-card-maplibre.js` is only loaded for `map_style: MapTilesVector` and for Satellite labels; without it those show `MapTiles` and CARTO labels instead.

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

That's it. The card defaults to RainViewer, your HA instance's location, and a `zone.home` marker. From there, the GUI editor exposes every knob — see [Configuration](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/configuration.md) for the full reference and [Examples](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/examples.md) for common starting points.

For touchscreen dashboards, YAML can enlarge the timeline scrub target upward over the lower map while preserving its slim visual track and original bottom-bar height:

```yaml
show_progress_bar: true
progress_bar_touch_height: 44
```

## Sizing

How tall the card renders depends on where it lives:

- **Masonry / panel views, or a sections cell with `rows: auto`** — the card uses the `height:` config option (default `400px`). This is the normal case.
- **A sections-grid cell with a fixed row count** (you've dragged the resize handle, or `rows:` is a number) — **the grid cell owns the height.** The card fills the cell and the `height:` option is ignored; resize it with the cell's drag handle instead. The editor disables the height box in this case so it's clear which control is in charge.

In other words: `rows: auto` → `height:` applies; `rows: <number>` → the cell's height applies. See [sections-grid behaviour](https://github.com/jpettitt/weather-radar-card/blob/4.0/docs/configuration.md#sections-grid-support) for details.

## Changelog

See [CHANGELOG.md](https://github.com/jpettitt/weather-radar-card/blob/4.0/CHANGELOG.md) for the complete history of changes.

[license-shield]: https://img.shields.io/github/license/jpettitt/weather-radar-card.svg?style=for-the-badge
[releases-shield]: https://img.shields.io/github/release/jpettitt/weather-radar-card.svg?style=for-the-badge
[releases]: https://github.com/jpettitt/weather-radar-card/releases
