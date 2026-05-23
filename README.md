# Weather Radar Card

A Home Assistant rain radar card using tiled radar imagery from RainViewer, NOAA/NWS, and DWD (Deutscher Wetterdienst).

[![hacs_badge](https://img.shields.io/badge/HACS-Default-orange.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)
![Maintenance](https://img.shields.io/maintenance/yes/2026?style=for-the-badge)

## Description

This card displays animated weather radar loops within Home Assistant. It supports multiple radar data sources and map styles, and can be zoomed and panned seamlessly. Markers, hazard overlays (US wildfires + NWS watches & warnings), a forecast nowcast (DWD), full sections-grid resize support, and 11 languages.

![Weather Radar card](weather-radar-card.gif)

## What's new in 3.5

- **Hazard overlays (US-only)** — active wildfire perimeters from [NIFC's WFIGS feed](https://github.com/jpettitt/weather-radar-card/blob/master/docs/overlays.md#wildfires), and active NWS watches & warnings from [api.weather.gov](https://github.com/jpettitt/weather-radar-card/blob/master/docs/overlays.md#nws-watches--warnings). Both with strong life-safety disclaimers — informational only.
- **Source-agnostic time range** — `past_minutes` / `forecast_minutes` (and a YAML-only `frame_stride_minutes`) replace `frame_count`. Editor surfaces preset dropdowns filtered by per-source caps; the forecast row hides on sources without a forecast. Existing `frame_count` configs auto-migrate. See [Configuration](https://github.com/jpettitt/weather-radar-card/blob/master/docs/configuration.md).
- **Sections-grid support** — `getGridOptions()` plus a flex layout that fills any cell, with a responsive bottom row that hides the date prefix on narrow cards.
- **`smooth_overlap`** crossfade knob (0–1) — tune the brightness-dip vs cushion trade-off for your basemap.
- **Loading spinner** + **"Now" marker** + **dark-map scale fix** — three contributions from [@genericJE](https://github.com/genericJE).
- **Card-picker preview** — a static preview image now shows in HA's card-add picker (a live render would just show an empty map when there's no current rain in the user's area).

For the full release history see [CHANGELOG](https://github.com/jpettitt/weather-radar-card/blob/master/CHANGELOG.md).

## Roadmap

- **Real-time lightning strikes** when the [Blitzortung integration](https://www.home-assistant.io/integrations/blitzortung/) is installed — shipped in 3.6.0
- **Wind overlay** — barbs, arrows, animated streamlines from DWD's ICON-D2 model (global 0.25° grid). Shipped in 3.6.0-beta. See [Hazard & Layer Overlays](https://github.com/jpettitt/weather-radar-card/blob/master/docs/overlays.md#wind).
- **Wind source choice** (AICON / BRD-1km / NOAA NCSS) — target 3.7. See [todo.md](https://github.com/jpettitt/weather-radar-card/blob/master/docs/todo.md).
- **Per-user / per-card layer visibility control** — target 3.7

Full backlog: [docs/todo.md](https://github.com/jpettitt/weather-radar-card/blob/master/docs/todo.md).

## Documentation

| Topic | What's there |
| --- | --- |
| [Configuration](https://github.com/jpettitt/weather-radar-card/blob/master/docs/configuration.md) | Full options table, Map Style choices, Animation knobs, Double-tap action, sections-grid behaviour |
| [Data Sources](https://github.com/jpettitt/weather-radar-card/blob/master/docs/data-sources.md) | RainViewer / NOAA / DWD specifics, per-source caps, NOAA & DWD notes, DWD forecast leading-edge note |
| [Hazard & Layer Overlays](https://github.com/jpettitt/weather-radar-card/blob/master/docs/overlays.md) | US wildfire perimeters, NWS watches & warnings, lightning (Blitzortung), and global wind — usage, knobs, **safety disclaimers** |
| [Markers](https://github.com/jpettitt/weather-radar-card/blob/master/docs/markers.md) | The `markers[]` schema, track-resolution rules, default home marker, migration from the legacy single-marker fields |
| [Examples](https://github.com/jpettitt/weather-radar-card/blob/master/docs/examples.md) | Sample YAMLs for common setups (basic, dense DWD loop, NOAA, OSM, mobile-only, person tracking, hazard overlays) |
| [Animation architecture](https://github.com/jpettitt/weather-radar-card/blob/master/docs/animation.md) | Internal: layer z-stack, two-slot crossfade, opacity ownership, dynamic tile size, pause behaviour, invariants |
| [Wildfire feature design](https://github.com/jpettitt/weather-radar-card/blob/master/docs/wildfire-feature-design.md) | Internal: NIFC WFIGS feed, render decisions, InciWeb gating, refresh cadence |
| [NWS alerts feature design](https://github.com/jpettitt/weather-radar-card/blob/master/docs/nws-alerts-feature-design.md) | Internal: api.weather.gov polling, zone resolution + caching, severity sort, popup chrome |
| [Wind feature design](https://github.com/jpettitt/weather-radar-card/blob/master/docs/wind-feature-design.md) | Internal: bulk WCS fetch + adaptive scaling, coalescing cache, zoom-aware streamlines, layering |
| [Backlog / TODO](https://github.com/jpettitt/weather-radar-card/blob/master/docs/todo.md) | Open and shipped features |
| [Contributing](https://github.com/jpettitt/weather-radar-card/blob/master/CONTRIBUTING.md) | Local dev setup including the Docker HA testbed (`npm run ha:up`) |

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

That's it. The card defaults to RainViewer, your HA instance's location, and a `zone.home` marker. From there, the GUI editor exposes every knob — see [Configuration](https://github.com/jpettitt/weather-radar-card/blob/master/docs/configuration.md) for the full reference and [Examples](https://github.com/jpettitt/weather-radar-card/blob/master/docs/examples.md) for common starting points.

## Changelog

See [CHANGELOG.md](https://github.com/jpettitt/weather-radar-card/blob/master/CHANGELOG.md) for the complete history of changes.

[license-shield]: https://img.shields.io/github/license/jpettitt/weather-radar-card.svg?style=for-the-badge
[releases-shield]: https://img.shields.io/github/release/jpettitt/weather-radar-card.svg?style=for-the-badge
[releases]: https://github.com/jpettitt/weather-radar-card/releases
