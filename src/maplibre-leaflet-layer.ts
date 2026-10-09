/* eslint-disable @typescript-eslint/no-explicit-any */
// A Leaflet layer that draws a MapLibre GL map, ported from
// @maplibre/maplibre-gl-leaflet 0.1.4 (the adapter HA's frontend uses) so it
// takes Leaflet as an argument instead of importing it. Imported, Leaflet
// made rollup move the card's own code out of weather-radar-card.js into a
// shared file, so the card depended on a second file; this way only the
// on-demand MapLibre file depends on anything. Left out: the adapter's
// attribution juggling (the card shows its own credits).
//
// Copyright (c) 2021 MapLibre contributors
// Copyright (c) 2014, Mapbox
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
import type * as Leaflet from 'leaflet';
import type * as Maplibre from 'maplibre-gl';

export type MaplibreLayer = Leaflet.Layer & { getMaplibreMap(): Maplibre.Map };

export function defineMaplibreLayer(
  L: typeof Leaflet,
  maplibre: typeof Maplibre,
): (options: Record<string, unknown>) => MaplibreLayer {
  const Layer = (L.Layer as any).extend({
    options: { updateInterval: 32, padding: 0.1, interactive: false, pane: 'tilePane' },

    initialize(options: Record<string, unknown>) {
      L.setOptions(this, options);
      this._throttledUpdate = L.Util.throttle(this._update, this.options.updateInterval, this);
    },

    onAdd(map: any) {
      if (!this._container) this._initContainer();
      map.getPane(this.getPaneName()).appendChild(this._container);
      this._initGL();
      this._offset = this._map.containerPointToLayerPoint([0, 0]);
      if (map.options.zoomAnimation) L.DomEvent.on(map._proxy, L.DomUtil.TRANSITION_END, this._transitionEnd, this);
    },

    onRemove(map: any) {
      if (this._map._proxy && this._map.options.zoomAnimation) {
        L.DomEvent.off(this._map._proxy, L.DomUtil.TRANSITION_END, this._transitionEnd, this);
      }
      map.getPane(this.getPaneName()).removeChild(this._container);
      // Frees the WebGL context: browsers keep only about 16.
      this._glMap.remove();
      this._glMap = null;
    },

    getEvents() {
      return {
        move: this._throttledUpdate,
        zoomanim: this._animateZoom,
        zoom: this._pinchZoom,
        zoomstart: this._zoomStart,
        zoomend: this._zoomEnd,
        resize: this._resize,
      };
    },

    getMaplibreMap() {
      return this._glMap;
    },

    getSize() {
      return this._map.getSize().multiplyBy(1 + this.options.padding * 2);
    },

    getPaneName() {
      return this._map.getPane(this.options.pane) ? this.options.pane : 'tilePane';
    },

    _roundPoint(p: { x: number; y: number }) {
      return { x: Math.round(p.x), y: Math.round(p.y) };
    },

    _initContainer() {
      this._container = L.DomUtil.create('div', 'leaflet-gl-layer');
      this._resizeContainer();
      const offset = this._map.getSize().multiplyBy(this.options.padding);
      const topLeft = this._map.containerPointToLayerPoint([0, 0]).subtract(offset);
      L.DomUtil.setPosition(this._container, this._roundPoint(topLeft) as any);
    },

    _resizeContainer() {
      const size = this.getSize();
      this._container.style.width = `${size.x}px`;
      this._container.style.height = `${size.y}px`;
    },

    _initGL() {
      const center = this._map.getCenter();
      const options = L.extend({}, this.options, {
        container: this._container,
        center: [center.lng, center.lat],
        zoom: this._map.getZoom() - 1,
        attributionControl: false,
      });
      this._glMap = new maplibre.Map(options as any);
      // Leaflet allows any latitude; MapLibre's default constraint would
      // clamp the view and drift from the map above it.
      if (this._glMap.setTransformConstrain) {
        this._glMap.setTransformConstrain((c: unknown, zoom: number) => ({ center: c, zoom }));
      } else {
        const transform = this._glMap.transform;
        const proto = Object.getPrototypeOf(transform);
        const latRange = Object.getOwnPropertyDescriptor(proto, 'latRange');
        if (!latRange || latRange.set || latRange.writable) transform.latRange = null;
        const maxLat = Object.getOwnPropertyDescriptor(proto, 'maxValidLatitude');
        if (!maxLat || maxLat.set || maxLat.writable) transform.maxValidLatitude = Infinity;
        if (transform._helper && transform._helper._latRange) transform._helper._latRange = [-Infinity, Infinity];
      }
      this._transformGL(this._glMap);
      this._glMap._actualCanvas = this._glMap._canvas.canvas ?? this._glMap._canvas;
      const canvas = this._glMap._actualCanvas;
      L.DomUtil.addClass(canvas, 'leaflet-image-layer');
      L.DomUtil.addClass(canvas, 'leaflet-zoom-animated');
      if (this.options.interactive) L.DomUtil.addClass(canvas, 'leaflet-interactive');
      if (this.options.className) L.DomUtil.addClass(canvas, this.options.className);
    },

    _update() {
      if (!this._map) return;
      this._offset = this._map.containerPointToLayerPoint([0, 0]);
      if (this._zooming) return;
      const offset = this._map.getSize().multiplyBy(this.options.padding);
      const topLeft = this._map.containerPointToLayerPoint([0, 0]).subtract(offset);
      L.DomUtil.setPosition(this._container, this._roundPoint(topLeft) as any);
      this._transformGL(this._glMap);
    },

    _transformGL(gl: any) {
      const center = this._map.getCenter();
      gl.jumpTo({ center: [center.lng, center.lat], zoom: this._map.getZoom() - 1 });
    },

    _pinchZoom() {
      this._glMap.jumpTo({ zoom: this._map.getZoom() - 1, center: this._map.getCenter() });
    },

    _animateZoom(e: any) {
      const scale = this._map.getZoomScale(e.zoom);
      const padding = this._map.getSize().multiplyBy(this.options.padding * scale);
      const viewHalf = this.getSize()._divideBy(2);
      const topLeft = this._map.project(e.center, e.zoom)._subtract(viewHalf)._add(this._map._getMapPanePos().add(padding))._round();
      const offset = this._map.project(this._map.getBounds().getNorthWest(), e.zoom)._subtract(topLeft);
      L.DomUtil.setTransform(this._glMap._actualCanvas, offset.subtract(this._offset), scale);
    },

    _zoomStart() {
      this._zooming = true;
    },

    _zoomEnd() {
      const scale = this._map.getZoomScale(this._map.getZoom());
      L.DomUtil.setTransform(this._glMap._actualCanvas, null as any, scale);
      this._zooming = false;
      this._update();
    },

    _transitionEnd() {
      L.Util.requestAnimFrame(function (this: any) {
        if (!this._map || !this._glMap) return;
        const zoom = this._map.getZoom();
        const center = this._map.getCenter();
        const offset = this._map.latLngToContainerPoint(this._map.getBounds().getNorthWest());
        this._resizeContainer();
        L.DomUtil.setTransform(this._glMap._actualCanvas, offset, 1);
        this._glMap.once('moveend', L.Util.bind(function (this: any) { this._zoomEnd(); }, this));
        this._glMap.jumpTo({ center, zoom: zoom - 1 });
      }, this);
    },

    _resize() {
      this._transitionEnd();
    },
  });
  return (options) => new Layer(options) as MaplibreLayer;
}
