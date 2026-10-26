# Upgrading to 4.0

4.0 is a release candidate. This page lists what changes when you move from 3.13 to 4.0, how to try it, and how to go back. 3.13.0 is the current stable release and stays supported with bug fixes while 4.0 is in development.

## What changes

### Home Assistant 2026.4 or later

4.0 needs Home Assistant 2026.4 or later: the editor's text fields use `ha-input`, which HA added in 2026.4. On older Home Assistant, use 3.x. The card works there, but from 3.6.3 the 3.x editor's text fields are empty before HA 2026.4, so set those options in YAML.

### A second file

4.0 ships two files: `weather-radar-card.js` and `weather-radar-card-maplibre.js`. The second file holds the vector map renderer. The card loads it only when a card uses `map_style: MapTilesVector` or `Satellite`. HACS installs both files. A manual install must copy both into `www/community/weather-radar-card/`, next to each other. See [Install](../README-4.0.md#install).

Without the second file, `MapTilesVector` shows `MapTiles` and `Satellite` shows CARTO labels with a key, as 3.13 did.

### Re-centre with a tracked marker

In 3.13, the re-centre button moved the map to the configured centre, and the next position update of the tracked entity moved it back. In 4.0, the button switches between the tracked marker and Default, the configured centre. Default holds, with tracking paused, until the next press or until `preset_timeout` idle minutes (default 5) return the map to the tracked marker.

- To hold Default until the next press, set `preset_timeout: 0`.
- Cards without a tracked marker re-centre as before.
- With `presets`, the button also rotates through each saved view. See [View presets](configuration.md#view-presets).

### Everything else is off until you turn it on

The vector map, the classic style, `theme_mode`, `extra_labels` on the vector map, presets and layer toggles are all options. A 3.13 configuration gives the same picture on 4.0, with two exceptions: `Satellite` draws its labels from HA's map tiles above the radar when it can, and dark tile maps keep less of their colour.

## How to try 4.0

1. In HACS, open the card and turn on **Show beta versions**.
2. Select the 4.0 pre-release and install it.
3. Reload the browser with Ctrl+F5 (Cmd+Shift+R on a Mac) so the new files load.

The card's sign-on line in the browser console shows the version that runs.

## How to go back

In HACS, open the card, select 3.13.0 and install it. The extra file does no harm when it stays. Presets and layer toggles are ignored by 3.13, so a configuration that uses them still loads.

## What is new

| Feature | Where to read |
| --- | --- |
| `map_style: MapTilesVector`, `vector_style`, `theme_mode` | [Map Style](configuration.md#map-style) |
| Satellite labels above the radar | [Map Style](configuration.md#map-style) |
| `extra_labels` on the vector map | [Options table](configuration.md#options-table) |
| View presets and `preset_timeout` | [View presets](configuration.md#view-presets) |
| Layer toggles and `show_layer_toggles` | [Turning overlays on and off](overlays.md#turning-overlays-on-and-off) |
| Ready-made configurations | [Examples](examples.md#40-vector-map-in-the-classic-style-with-labels-above-the-radar) |

## Report a problem

Open an issue at https://github.com/jpettitt/weather-radar-card/issues. Include the card version from the console sign-on line, your Home Assistant version, and the card configuration with the location trimmed.
