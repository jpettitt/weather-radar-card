// Inverse Web Mercator (EPSG:3857) for a point in Leaflet's world pixel
// space divided by the zoom scale, so 0..1 spans the world on each axis.
// The same maths as L.CRS.EPSG3857.pointToLatLng, without the Point and
// LatLng objects Leaflet allocates on every call: the streamline tick
// converts every particle every frame (3,500 x 15 fps), and that garbage
// fed a full collection every ten seconds that took 543 ms on an iPhone
// with the alerts layer's heap live (2026-10-17).
export function webMercatorPixelToLatLng(
  nx: number,
  ny: number,
  out: { lat: number; lng: number },
): { lat: number; lng: number } {
  out.lng = (nx - 0.5) * 360;
  out.lat = (2 * Math.atan(Math.exp((0.5 - ny) * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  return out;
}
