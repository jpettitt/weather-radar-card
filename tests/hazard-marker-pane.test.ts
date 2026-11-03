// Place names over every weather and hazard layer, under the user's own
// markers: the pane stack in const.ts, and the wind/fire icon pane, on a
// real Leaflet map.

import { describe, it, expect, vi } from 'vitest';
import * as L from 'leaflet';
import { hazardMarkerPane } from '../src/hazard-marker-pane';
import { MAP_QUIET_MS } from '../src/map-quiet';
import { HAZARD_MARKER_PANE, Z_HAZARD_MARKERS, Z_LIGHTNING, Z_PLACE_LABELS } from '../src/const';

// Leaflet's own pane z-indexes (leaflet.css).
const OVERLAY_PANE_Z = 400;
const MARKER_PANE_Z = 600;

describe('pane stack', () => {
  it('puts the place names over lightning and the wind and fire icons, under the markers', () => {
    expect(OVERLAY_PANE_Z).toBeLessThan(Z_LIGHTNING);
    expect(Z_LIGHTNING).toBeLessThan(Z_HAZARD_MARKERS);
    expect(Z_HAZARD_MARKERS).toBeLessThan(Z_PLACE_LABELS);
    expect(Z_PLACE_LABELS).toBeLessThan(MARKER_PANE_Z);
  });
});

describe('hazardMarkerPane', () => {
  it('creates the pane once, at its place in the stack', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const map = L.map(el).setView([0, 0], 3);
    expect(hazardMarkerPane(map)).toBe(HAZARD_MARKER_PANE);
    const pane = map.getPane(HAZARD_MARKER_PANE)!;
    expect(pane.style.zIndex).toBe(String(Z_HAZARD_MARKERS));
    expect(hazardMarkerPane(map)).toBe(HAZARD_MARKER_PANE);
    expect(map.getPanes()[HAZARD_MARKER_PANE]).toBe(pane);
    expect(el.querySelectorAll(`.leaflet-${HAZARD_MARKER_PANE}-pane`)).toHaveLength(1);
    map.remove();
  });

  it('leaves the page from zoomstart until the map has been still for MAP_QUIET_MS, so Leaflet never animates its icons on a zoom', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const map = L.map(el).setView([0, 0], 3);
    hazardMarkerPane(map);
    const pane = map.getPane(HAZARD_MARKER_PANE)!;
    map.fire('zoomstart');
    expect(pane.style.display).toBe('none');
    map.fire('zoomend');
    map.fire('moveend');
    expect(pane.style.display).toBe('none');
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(pane.style.display).toBe('');
    // A plain pan does not touch it.
    map.fire('movestart');
    map.fire('moveend');
    vi.advanceTimersByTime(MAP_QUIET_MS);
    expect(pane.style.display).toBe('');
    map.remove();
    vi.useRealTimers();
  });
});
