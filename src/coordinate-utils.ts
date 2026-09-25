import { HomeAssistant } from 'custom-card-helpers';
import { CoordinateConfig } from './types';

export function isMobileDevice(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return (
    ua.includes('home assistant') ||
    window.innerWidth <= 768 ||
    /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua)
  );
}

export function getCurrentUserInfo(
  hass: HomeAssistant | undefined,
): { personEntity: string; deviceTracker?: string } | null {
  const userId = hass?.user?.id;
  if (!userId) return null;
  // Stryker disable next-line OptionalChaining: hass is provably defined here (userId is truthy)
  for (const [entityId, state] of Object.entries(hass?.states || {})) {
    if (entityId.startsWith('person.') && state.attributes?.user_id === userId) {
      // Stryker disable next-line OptionalChaining: attributes is provably defined (user_id matched above)
      const trackers = state.attributes?.device_trackers;
      const deviceTracker = Array.isArray(trackers)
        ? trackers[0]
        : typeof trackers === 'string'
          ? trackers.split(',')[0].trim()
          : undefined;
      return { personEntity: entityId, deviceTracker };
    }
  }
  return null;
}

export function getCoordinateConfig(
  baseConfig: CoordinateConfig | undefined,
  mobileConfig: CoordinateConfig | undefined,
  isMobile: boolean,
  userDeviceTracker?: string,
): CoordinateConfig | undefined {
  if (isMobile && mobileConfig !== undefined) return mobileConfig;
  if (isMobile && !baseConfig && userDeviceTracker) return userDeviceTracker;
  return baseConfig;
}

export function resolveCoordinate(
  config: CoordinateConfig | undefined,
  coordType: 'latitude' | 'longitude',
  fallback: number,
  hass: HomeAssistant | undefined,
): number {
  // Stryker disable next-line ConditionalExpression: undefined would fall through every typeof check to the same fallback
  if (config === undefined || config === null) return fallback;
  if (typeof config === 'number') return config;
  if (typeof config === 'string') {
    const val = hass?.states[config]?.attributes?.[coordType];
    // Stryker disable next-line ConditionalExpression: parseFloat(undefined) is NaN, which returns the same fallback below
    if (val === undefined) return fallback;
    const num = parseFloat(val);
    return !isNaN(num) ? num : fallback;
  }
  if (typeof config === 'object' && 'entity' in config) {
    const attr =
      coordType === 'latitude'
        ? config.latitude_attribute || 'latitude'
        : config.longitude_attribute || 'longitude';
    const val = hass?.states[config.entity]?.attributes?.[attr];
    // Stryker disable next-line ConditionalExpression: parseFloat(undefined) is NaN, which returns the same fallback below
    if (val === undefined) return fallback;
    const num = parseFloat(val);
    return !isNaN(num) ? num : fallback;
  }
  return fallback;
}

export function resolveCoordinatePair(
  latConfig: CoordinateConfig | undefined,
  lonConfig: CoordinateConfig | undefined,
  fallbackLat: number,
  fallbackLon: number,
  hass: HomeAssistant | undefined,
): { lat: number; lon: number } {
  // Single-entity fast path (one lookup instead of two). Its result always equals the
  // per-axis path below, so the mutants that merely skip or widen it are equivalent.
  // Stryker disable BlockStatement: emptying the fast path or its inner check falls through to the same result
  if (
    // Stryker disable next-line ConditionalExpression: the === below already implies latConfig is a string
    typeof latConfig === 'string' &&
    // Stryker disable next-line ConditionalExpression: the === below already implies lonConfig is a string
    typeof lonConfig === 'string' &&
    latConfig === lonConfig
  ) {
    const entity = hass?.states[latConfig];
    // Stryker disable next-line OptionalChaining,LogicalOperator: the 2nd ?. can't run without the 1st check passing; `||` is caught by the NaN check below
    if (entity?.attributes?.latitude && entity?.attributes?.longitude) {
      const lat = parseFloat(entity.attributes.latitude);
      const lon = parseFloat(entity.attributes.longitude);
      // Stryker disable next-line ConditionalExpression: `false` falls through to the same per-axis result
      if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
    }
  }
  // Stryker restore BlockStatement
  return {
    lat: resolveCoordinate(latConfig, 'latitude', fallbackLat, hass),
    lon: resolveCoordinate(lonConfig, 'longitude', fallbackLon, hass),
  };
}
