/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { Marker } from './types';

const ICON_BASE = '/local/community/weather-radar-card/';

// Used only for the default home-circle marker when a custom colour is set,
// and inside cluster badges (where embedding <ha-icon> would race with cluster
// re-renders). Other MDI icons are rendered via <ha-icon> which can resolve
// any name from HA's bundled icon database — no hardcoded path table needed.
export const HOME_CIRCLE_PATH =
  'M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M10,17V13H8L12,7L16,13H14V17H10Z';

// Plain mdi:home (house silhouette, no surrounding circle) — fallback for the
// zone-cluster badge representation when no MDI icon is available on the
// representative marker (e.g. legacy default markers with no entity).
export const HOME_PATH = 'M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z';

// mdi:fire — used by the wildfire overlay for incidents whose pixel-bbox at
// the current zoom is below the polygon-render threshold. Inline so the icon
// renders synchronously alongside polygons instead of waiting for ha-icon to
// upgrade in the wildfire pane.
export const FIRE_PATH = 'M17.66 11.2C17.43 10.9 17.15 10.64 16.89 10.38C16.22 9.78 15.46 9.35 14.82 8.72C13.33 7.26 13 4.85 13.95 3C13 3.23 12.17 3.75 11.46 4.32C8.87 6.4 7.85 10.07 9.07 13.22C9.11 13.32 9.15 13.42 9.15 13.55C9.15 13.77 9 13.97 8.8 14.05C8.57 14.15 8.33 14.09 8.14 13.93C8.08 13.88 8.04 13.83 8 13.76C6.87 12.33 6.69 10.28 7.45 8.64C5.78 10 4.87 12.3 5 14.47C5.06 14.97 5.12 15.47 5.29 15.97C5.43 16.57 5.7 17.17 6 17.7C7.08 19.43 8.95 20.67 10.96 20.92C13.1 21.19 15.39 20.8 17.03 19.32C18.86 17.66 19.5 15 18.56 12.72L18.43 12.46C18.22 12 17.66 11.2 17.66 11.2M14.5 17.5C14.22 17.74 13.76 18 13.4 18.1C12.28 18.5 11.16 17.94 10.5 17.28C11.69 17 12.4 16.12 12.61 15.23C12.78 14.43 12.46 13.77 12.33 13C12.21 12.26 12.23 11.63 12.5 10.94C12.69 11.32 12.89 11.7 13.13 12C13.9 13 15.11 13.44 15.37 14.8C15.41 14.94 15.43 15.08 15.43 15.23C15.46 16.05 15.1 16.95 14.5 17.5H14.5Z';

export function findPersonEntityForDeviceTracker(
  deviceTrackerId: string,
  hass: HomeAssistant,
): string | undefined {
  for (const [entityId, state] of Object.entries(hass?.states || {})) {
    if (!entityId.startsWith('person.')) continue;
    const trackers = state.attributes?.device_trackers;
    if (Array.isArray(trackers) && trackers.includes(deviceTrackerId)) return entityId;
  }
  return undefined;
}

export function resolveToPersonEntity(entityId: string, hass: HomeAssistant): string {
  if (entityId.startsWith('device_tracker.')) {
    return findPersonEntityForDeviceTracker(entityId, hass) ?? entityId;
  }
  return entityId;
}

export function resolveEntityPicture(
  entityId: string | undefined,
  hass: HomeAssistant,
): string | null {
  if (!entityId) return null;
  return hass?.states[entityId]?.attributes?.entity_picture ?? null;
}

export function createMarkerIconForMarker(
  markerCfg: Marker,
  hass: HomeAssistant,
  mapStyle: string,
): L.Icon | L.DivIcon {
  const iconType = markerCfg.icon || 'default';
  const isDarkMap = mapStyle === 'dark' || mapStyle === 'satellite';
  const svgFile = isDarkMap ? 'home-circle-light.svg' : 'home-circle-dark.svg';
  const defaultColour = isDarkMap ? '#EEEEEE' : '#333333';
  const colour = markerCfg.color ?? defaultColour;

  // For default icon: use inline SVG when a custom colour is set, external file otherwise.
  if (iconType === 'default') {
    if (markerCfg.color) {
      return L.divIcon({
        html: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="${colour}" d="${HOME_CIRCLE_PATH}"/></svg>`,
        iconSize: [16, 16],
        className: 'marker-mdi-icon',
      });
    }
    return L.icon({ iconUrl: `${ICON_BASE}${svgFile}`, iconSize: [16, 16] });
  }

  if (iconType === 'entity_picture') {
    const entityId = markerCfg.icon_entity || markerCfg.entity;
    const resolved = entityId ? resolveToPersonEntity(entityId, hass) : undefined;
    const pictureUrl = resolveEntityPicture(resolved, hass);
    if (!pictureUrl) return L.icon({ iconUrl: `${ICON_BASE}${svgFile}`, iconSize: [16, 16] });
    return L.icon({ iconUrl: pictureUrl, iconSize: [32, 32], className: 'marker-entity-picture' });
  }

  if (iconType.startsWith('mdi:') && iconType.length > 4) {
    // <ha-icon> is registered globally by HA frontend and resolves any MDI
    // icon from HA's bundled database — no need to ship our own path table.
    return L.divIcon({
      html: `<ha-icon icon="${iconType}" style="--mdc-icon-size: 24px; color: ${colour};"></ha-icon>`,
      iconSize: [24, 24],
      className: 'marker-mdi-icon',
    });
  }

  return L.icon({ iconUrl: `${ICON_BASE}${svgFile}`, iconSize: [16, 16] });
}

