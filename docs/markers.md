# Markers

The `markers` option accepts a list. Each entry can have:

| Field         | Type          | Description                                                                                                                                                                                                                                                                                      |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entity`      | string        | Entity ID (`device_tracker.*`, `person.*`, `zone.*`). Position is read from the entity's `latitude` / `longitude` attributes and updated live on every HA state change.                                                                                                                          |
| `latitude`    | number        | Static latitude (used when `entity` is not set or unavailable)                                                                                                                                                                                                                                   |
| `longitude`   | number        | Static longitude                                                                                                                                                                                                                                                                                 |
| `icon`        | string        | Any `mdi:*` icon name (autocomplete in the editor) or `'entity_picture'` to use the entity's photo. If blank, auto-detected from the entity (HA `attributes.icon`, then `device_class` / `source_type`, then a domain default). When unset and there is no entity, the default home SVG is used. |
| `icon_entity` | string        | Entity ID to read the photo from when `icon: entity_picture`. Defaults to `entity` if blank.                                                                                                                                                                                                     |
| `color`       | string        | CSS colour for `mdi:*` and default icons (e.g. `#ff0000`, `red`). Ignored for `entity_picture`.                                                                                                                                                                                                  |
| `track`       | string / bool | `'entity'` — pan the map to follow this marker; `true` — lowest-priority always-on fallback                                                                                                                                                                                                      |
| `mobile_only` | boolean       | Only show this marker on mobile devices                                                                                                                                                                                                                                                          |

## Track resolution

When multiple markers have `track` set, the card picks one to centre the map on using this priority order (evaluated on every HA update):

1. **`track: entity` on a `person.*` entity whose `user_id` matches the currently logged-in HA user** — highest priority. "I am this person, follow me."
2. **`track: entity` on any other entity** — viewer-independent tracking.
3. **`track: true`** — lowest always-on fallback; overridden by any `track: entity` match.

Multiple markers at the same priority level use the first one in the list, and log a console warning once per page load.

The re-centre button switches between the tracked marker and the configured centre (*Default*), then any [view presets](configuration.md#view-presets). Tracking pauses while Default or a preset is showing, and resumes after `preset_timeout` idle minutes or a tap on the preset's name. *Add as preset* in the editor copies a marker into `presets`.

## Default marker

If `markers` is not set in the config, the card automatically creates a single `zone.home` marker so the map always shows your home location. To opt out entirely, set `markers: []` (an explicit empty array).

## Migration from single-marker config

If you have the old `marker_latitude` / `marker_longitude` / `show_marker` fields, the card automatically converts them to a `markers[]` entry in memory on load. Your existing YAML continues to work — no changes required. A deprecation warning is logged to the browser console.

## Examples

Static home marker:

```yaml
markers:
  - latitude: -33.86
    longitude: 151.21
    icon: mdi:home
```

Track a person (centres map on them when they are the logged-in user):

```yaml
markers:
  - entity: person.john
    icon: entity_picture
    track: entity
```

Multiple markers — person takes priority over van for John, van tracks for everyone else. For other viewers `person.john` has the same priority as the van, so the van must come first in the list:

```yaml
markers:
  - entity: device_tracker.van
    icon: mdi:car
    track: entity

  - entity: person.john
    icon: entity_picture
    track: entity

  - latitude: -33.86
    longitude: 151.21
    icon: mdi:home
```

Desktop shows home marker; mobile shows current device location:

```yaml
markers:
  - latitude: -33.86
    longitude: 151.21
    icon: mdi:home

  - entity: device_tracker.my_phone
    icon: entity_picture
    mobile_only: true
```
