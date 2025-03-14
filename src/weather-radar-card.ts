import { LitElement, html, css, CSSResult, TemplateResult } from 'lit';
import { property, customElement } from 'lit/decorators.js';
import { HomeAssistant, LovelaceCardEditor, LovelaceCard } from 'custom-card-helpers';

import './editor';

import { WeatherRadarCardConfig } from './types';
import { CARD_VERSION } from './const';

import { localize } from './localize/localize';

/* eslint no-console: 0 */
console.info(
  `%c  WEATHER-RADAR-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards = (window as any).customCards || [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards.push({
  type: 'weather-radar-card',
  name: 'Weather Radar Card',
  description: 'A rain radar card using the new tiled images from RainViewer',
});

// TODO Name your custom element
@customElement('weather-radar-card')
export class WeatherRadarCard extends LitElement implements LovelaceCard {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('weather-radar-card-editor') as LovelaceCardEditor;
  }

  public static getStubConfig(): Record<string, unknown> {
    return {};
  }

  @property({ type: Boolean, reflect: true })
  public isPanel = false;

  // TODO Add any properities that should cause your element to re-render here
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) private _config!: WeatherRadarCardConfig;
  @property({ attribute: false }) public editMode?: boolean;

  public setConfig(config: WeatherRadarCardConfig): void {
    // TODO Check for required fields and that they are of the proper format
    /*   if (!config || config.show_error) {
      throw new Error(localize('common.invalid_configuration'));
    }

    if (config.test_gui) {
      getLovelace().setEditMode(true);
    }*/

    this._config = config;
  }

  // #####
  // ##### Sets the card size so HA knows how to put in columns
  // #####

  getCardSize(): number {
    return 10;
  }

  protected shouldUpdate(/*changedProps: PropertyValues*/): boolean {
    return true;
    //    return hasConfigOrEntityChanged(this, changedProps, false);
  }

  protected render(): TemplateResult | void {
    // TODO Check for stateObj or other necessary things and render a warning if missing
    if (this._config.show_warning) {
      return this.showWarning(localize('common.show_warning'));
    }

    const doc = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Weather Radar Card</title>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="/local/community/weather-radar-card/leaflet.css"/>
          <link rel="stylesheet" href="/local/community/weather-radar-card/leaflet.toolbar.min.css"/>
          <script src="/local/community/weather-radar-card/leaflet.js"></script>
          <script src="/local/community/weather-radar-card/leaflet.toolbar.min.js"></script>
          <style>
            body {
              margin: 0;
              padding: 0;
            }
            .text-container {
              font: 12px/1.5 'Helvetica Neue', Arial, Helvetica, sans-serif;
              margin: 0px 2.5px 0px 10px;
            }
            .text-container-small {
              font: 10px/1.5 'Helvetica Neue', Arial, Helvetica, sans-serif;
              margin: 0px 10px 0px 2.5px;
            }
            .light-links a {
              color: blue;
            }
            .dark-links a {
              color: steelblue;
            }
            #timestamp {
              font: 14px/1.5 'Helvetica Neue', Arial, Helvetica, sans-serif;
              margin: 0px 0px;
              padding-top: 5px;
            }
            #color-bar {
              margin: 0px 0px;
            }
          </style>
        </head>
        <body onresize="resizeWindow()">
          <span>
            <div id="color-bar" style="height: 8px;">
              <img id="img-color-bar" height="8" style="vertical-align: top" />
            </div>
            <div id="mapid" style="height: ${this.isPanel
        ? this.offsetParent
          ? this.offsetParent.clientHeight - 48 - 2 - (this.editMode === true ? 59 : 0) + `px`
          : `540px`
        : this._config.square_map !== undefined
          ? this._config.square_map
            ? this.getBoundingClientRect().width + 'px'
            : '492px'
          : '492px'
      };"></div>
            <div id="div-progress-bar" style="height: 8px; background-color: white;">
              <div id="progress-bar" style="height:8px;width:0; background-color: #ccf2ff;"></div>
            </div>
            <div id="bottom-container" class="light-links" style="height: 32px; background-color: white;">
              <div id="timestampid" class="text-container" style="width: 120px; height: 32px; float:left; position: absolute;">
                <p id="timestamp"></p>
              </div>
              <div id="attribution" class="text-container-small" style="height: 32px; float:right;">
                <span class="Map__Attribution-LjffR DKiFh" id="attribution"
                  ></span
                >
              </div>
            </div>
            <script>
              const maxZoom = 10;
              const minZoom = 3;
              var radarOpacity = 1.0;
              var zoomLevel = ${this._config.zoom_level !== undefined ? this._config.zoom_level : 7};
              var centerLat = ${this._config.center_latitude !== undefined ? this._config.center_latitude : this.hass.config.latitude};
              var centerLon = ${this._config.center_longitude !== undefined ? this._config.center_longitude : this.hass.config.longitude};
              var markerLat = (${this._config.marker_latitude}) ? ${this._config.marker_latitude} : centerLat;
              var markerLon = (${this._config.marker_longitude}) ? ${this._config.marker_longitude} : centerLon;
              var timeout = ${this._config.frame_delay !== undefined ? this._config.frame_delay : 500};
              var restartDelay = ${this._config.restart_delay !== undefined ? this._config.restart_delay : 1000};
              var frameCount = ${this._config.frame_count != undefined ? this._config.frame_count : 10};
              var tileURL = '${this._config.data_source !== undefined ? this._config.data_source : 'RainViewer-Original'}';
              switch (tileURL) {
                case "RainViewer-Original":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/1/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-original.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-UniversalBlue":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/2/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-universalblue.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-TITAN":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/3/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-titan.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-TWC":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/4/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-twc.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-Meteored":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/5/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-meteored.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-NEXRAD":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/6/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-nexrad.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-Rainbow":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/7/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-rainbow.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
                case "RainViewer-DarkSky":
                  var tileURL = 'https://tilecache.rainviewer.com/v2/radar/{time}/256/{z}/{x}/{y}/8/1_1.png';
                  document.getElementById("img-color-bar").src = "/local/community/weather-radar-card/radar-colour-bar-darksky.png";
                  var framePeriod = 300000;
                  var frameLag = 60000;
                  break;
              }
              resizeWindow();
              var labelSize = ${this._config.extra_labels !== undefined ? (this._config.extra_labels ? 128 : 256) : 256
      };
              var labelZoom = ${this._config.extra_labels !== undefined ? (this._config.extra_labels ? 1 : 0) : 0};
              var map_style = '${this._config.map_style !== undefined && this._config.map_style !== null ? this._config.map_style.toLowerCase() : 'light'
      }';
              switch (map_style) {
                case "dark":
                  var basemap_url = 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png';
                  var basemap_style = 'dark_nolabels';
                  var label_url = 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png';
                  var label_style = 'dark_only_labels';
                  var svg_icon = 'home-circle-light.svg';
                  var attribution = '<a href="https://leafletjs.com" title="A JS library for interactive maps" target="_blank">Leaflet</a> | &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attribution" target="_blank">CARTO</a><br>Radar data by <a href="https://rainviewer.com" target="_blank">RainViewer</a>';
                  break;
                case "voyager":
                  var basemap_url = 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png';
                  var basemap_style = 'rastertiles/voyager_nolabels';
                  var label_url = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png';
                  var label_style = 'rastertiles/voyager_only_labels';
                  var svg_icon = 'home-circle-dark.svg';
                  var attribution = '<a href="https://leafletjs.com" title="A JS library for interactive maps" target="_blank">Leaflet</a> | &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attribution" target="_blank">CARTO</a><br>Radar data by <a href="https://rainviewer.com" target="_blank">RainViewer</a>';
                  break;
                case 'satellite':
                  var basemap_url = 'https://server.arcgisonline.com/ArcGIS/rest/services/{style}/MapServer/tile/{z}/{y}/{x}';
                  var basemap_style = 'World_Imagery';
                  var label_url = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png';
                  var label_style = 'proton_labels_std';
                  var svg_icon = 'home-circle-dark.svg';
                  var attribution = '<a href="https://leafletjs.com" title="A JS library for interactive maps" target="_blank">Leaflet</a> | &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="http://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank">ESRI</a><br>Radar data by <a href="https://rainviewer.com" target="_blank">RainViewer</a>';
                  break;
                case "light":
                default:
                  var basemap_url = 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png';
                  var basemap_style = 'light_nolabels';
                  var label_url = 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png';
                  var label_style = 'light_only_labels';
                  var svg_icon = 'home-circle-dark.svg';
                  var attribution = '<a href="https://leafletjs.com" title="A JS library for interactive maps" target="_blank">Leaflet</a> | &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attribution" target="_blank">CARTO</a><br>Radar data by <a href="https://rainviewer.com" target="_blank">RainViewer</a>';
              }

              var idx = 0;
              var run = true;
              var doRadarUpdate = false;
              var radarMap = L.map('mapid', {
                zoomControl: ${this._config.show_zoom === true && this._config.static_map !== true ? 'true' : 'false'},
                ${this._config.static_map === true
        ? 'scrollWheelZoom: false, \
                doubleClickZoom: false, \
                boxZoom: false, \
                dragging: false, \
                keyboard: false, \
                touchZoom: false,'
        : 'wheelPxPerZoomLevel: 120,'
      }
                attributionControl: false,
                minZoom: minZoom,
                maxZoom: maxZoom,
              }).setView([centerLat, centerLon], zoomLevel);
              var radarImage = [frameCount];
              var radarTime = [frameCount];
              var weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
              var month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              var d = new Date();
              d.setTime(Math.trunc((d.valueOf() - frameLag) / framePeriod) * framePeriod - (frameCount - 1) * framePeriod);

              document.getElementById("progress-bar").style.width = barSize+"px";
              document.getElementById("attribution").innerHTML = attribution;

              var t2actions = [];

              if (${this._config.show_recenter === true && this._config.static_map !== true}) {
                var recenterAction = L.Toolbar2.Action.extend({
                  options: {
                      toolbarIcon: {
                          html: '<img src="/local/community/weather-radar-card/recenter.png" width="24" height="24">',
                          tooltip: 'Re-center'
                      }
                  },

                  addHooks: function () {
                    radarMap.setView([centerLat, centerLon], zoomLevel);
                  }
                });
                t2actions.push(recenterAction);
              }

              if (${this._config.show_playback === true}) {
                var playAction = L.Toolbar2.Action.extend({
                  options: {
                      toolbarIcon: {
                          html: '<img id="playButton" src="/local/community/weather-radar-card/pause.png" width="24" height="24">',
                          tooltip: 'Pause'
                      }
                  },

                  addHooks: function () {
                    run = !run;
                    if (run) {
                      document.getElementById("playButton").src = "/local/community/weather-radar-card/pause.png"
                    } else {
                      document.getElementById("playButton").src = "/local/community/weather-radar-card/play.png"
                    }
                  }
                });
                t2actions.push(playAction);

                var skipbackAction = L.Toolbar2.Action.extend({
                  options: {
                      toolbarIcon: {
                          html: '<img src="/local/community/weather-radar-card/skip-back.png" width="24" height="24">',
                          tooltip: 'Previous Frame'
                      }
                  },

                  addHooks: function () {
                    skipBack();
                  }
                });
                t2actions.push(skipbackAction);

                var skipnextAction = L.Toolbar2.Action.extend({
                  options: {
                      toolbarIcon: {
                          html: '<img src="/local/community/weather-radar-card/skip-next.png" width="24" height="24">',
                          tooltip: 'Next Frame'
                      }
                  },

                  addHooks: function () {
                    skipNext();
                  }
                });
                t2actions.push(skipnextAction);
              }

              if (t2actions.length > 0) {
                new L.Toolbar2.Control({
                  position: 'bottomright',
                  actions: t2actions
                }).addTo(radarMap);
              }

              if (${this._config.show_scale === true}) {
                L.control.scale({
                  position: 'bottomleft',
                  metric: ${this.hass.config.unit_system.length === 'km'},
                  imperial: ${this.hass.config.unit_system.length === 'mi'},
                  maxWidth: 100,
                }).addTo(radarMap);

                if ((map_style === "dark") || (map_style == "satellite")) {
                  var scaleDiv = this.document.getElementsByClassName("leaflet-control-scale-line")[0];
                  scaleDiv.style.color = "#BBB";
                  scaleDiv.style.borderColor = "#BBB";
                  scaleDiv.style.background = "#00000080";
                }
              }

              if ((map_style === "dark") || (map_style == "satellite")) {
                this.document.getElementById("div-progress-bar").style.background = "#1C1C1C";
                this.document.getElementById("progress-bar").style.background = "steelblue";
                this.document.getElementById("bottom-container").style.background = "#1C1C1C";
                this.document.getElementById("bottom-container").style.color = "#DDDDDD";
                this.document.getElementById("bottom-container").className = "dark-links";
              }

              L.tileLayer(
                basemap_url,
                {
                  style: basemap_style,
                  subdomains: 'abcd',
                  detectRetina: true,
                  tileSize: 256,
                  zoomOffset: 0,
                },
              ).addTo(radarMap);

              for (i = 0; i < frameCount; i++) {
                t = d.valueOf()/1000 + i * (framePeriod/1000);
                radarImage[i] = L.tileLayer(
                  tileURL,
                  {
                    time: t,
                    detectRetina: true,
                    tileSize: 256,
                    zoomOffset: 0,
                    opacity: 0,
                    frame: i,
                  },
                );
                radarTime[i] = getRadarTimeString(d.valueOf() + i * framePeriod);
              }

              for (i = 0; i < (frameCount - 1); i++) {
                radarImage[i].on('load', function(e) {
                  radarImage[e.target.options.frame + 1].addTo(radarMap);
                });
              }

              radarImage[0].addTo(radarMap);

              radarImage[idx].setOpacity(radarOpacity);
              document.getElementById('timestamp').innerHTML = radarTime[idx];
              d.setTime(d.valueOf() + (frameCount - 1) * framePeriod);

              townLayer = L.tileLayer(
                label_url,
                {
                  subdomains: 'abcd',
                  detectRetina: false,
                  tileSize: labelSize,
                  zoomOffset: labelZoom,
                },
              ).addTo(radarMap);
              townLayer.setZIndex(2);

              ${this._config.show_marker === true
        ? "var myIcon = L.icon({ \
                       iconUrl: '/local/community/weather-radar-card/'+svg_icon, \
                       iconSize: [16, 16], \
                     }); \
                     L.marker([markerLat, markerLon], { icon: myIcon, interactive: false }).addTo(radarMap);"
        : ''
      }

              ${this._config.show_range === true
        ? this.hass.config.unit_system.length === 'km' ?
          'L.circle([markerLat, markerLon], { radius: 50000, weight: 1, fill: false, opacity: 0.3, interactive: false }).addTo(radarMap); \
          L.circle([markerLat, markerLon], { radius: 100000, weight: 1, fill: false, opacity: 0.3, interactive: false }).addTo(radarMap); \
          L.circle([markerLat, markerLon], { radius: 200000, weight: 1, fill: false, opacity: 0.3, interactive: false }).addTo(radarMap);':
          'L.circle([markerLat, markerLon], { radius: 48280, weight: 1, fill: false, opacity: 0.3, interactive: false }).addTo(radarMap); \
          L.circle([markerLat, markerLon], { radius: 96561, weight: 1, fill: false, opacity: 0.3, interactive: false }).addTo(radarMap); \
          L.circle([markerLat, markerLon], { radius: 193121, weight: 1, fill: false, opacity: 0.3, interactive: false }).addTo(radarMap);'
        : ''
      }

        setTimeout(function() {
          nextFrame();
        }, timeout);
        setUpdateTimeout();

        function setUpdateTimeout() {
          d.setTime(d.valueOf() + framePeriod);
          x = new Date();
          setTimeout(triggerRadarUpdate, d.valueOf() - x.valueOf() + frameLag);
        }

        function triggerRadarUpdate() {
          doRadarUpdate = true;
        }

        function updateRadar() {
          t = d.valueOf()/1000;
          newLayer = L.tileLayer(tileURL, {
            time: t,
            maxZoom: maxZoom,
            tileSize: 256,
            zoomOffset: 0,
            opacity: 0,
          });
          newLayer.addTo(radarMap);
          newTime = getRadarTimeString(d.valueOf());

          radarImage[0].remove();
          for (i = 0; i < frameCount - 1; i++) {
            radarImage[i] = radarImage[i + 1];
            radarTime[i] = radarTime[i + 1];
          }
          radarImage[frameCount - 1] = newLayer;
          radarTime[frameCount - 1] = newTime;
          idx = 0;
          doRadarUpdate = false;

          setUpdateTimeout();
        }

        function getRadarTime(date) {
          x = new Date(date);
          return (
            x.getUTCFullYear().toString() +
            (x.getUTCMonth() + 1).toString().padStart(2, '0') +
            x
              .getUTCDate()
              .toString()
              .padStart(2, '0') +
            x
              .getUTCHours()
              .toString()
              .padStart(2, '0') +
            x
              .getUTCMinutes()
              .toString()
              .padStart(2, '0')
          );
        }

        function getRadarTimeString(date) {
          x = new Date(date);
          return (
            weekday[x.getDay()] +
            ' ' +
            month[x.getMonth()] +
            ' ' +
            x
              .getDate()
              .toString()
              .padStart(2, '0') +
            ' ' +
            x
              .getHours()
              .toString()
              .padStart(2, '0') +
            ':' +
            x
              .getMinutes()
              .toString()
              .padStart(2, '0')
          );
        }

        function nextFrame() {
          if (run) {
            nextImage();
          }
          setTimeout(function() {
            nextFrame();
          }, (idx == frameCount) ? restartDelay : timeout);
        }

        function skipNext() {
          if (idx == frameCount-1) {
            idx += 1;
          }
          nextImage();
        }

        function skipBack() {
          if (idx == frameCount) {
            radarImage[frameCount - 1].setOpacity(0);
            idx -= 1;
          } else if (idx < frameCount) {
            radarImage[idx].setOpacity(0);
          }
          idx -= 1;
          if (doRadarUpdate && idx == 1) {
            updateRadar();
          }
          if (idx < 0) {
            idx = frameCount-1;
          }
          document.getElementById("progress-bar").style.width = (idx+1)*barSize+"px";
          document.getElementById('timestamp').innerHTML = radarTime[idx];
          radarImage[idx].setOpacity(radarOpacity);
        }

        function nextImage() {
          if (idx == frameCount) {
            radarImage[frameCount - 1].setOpacity(0);
          } else if (idx < frameCount - 1) {
            radarImage[idx].setOpacity(0);
          }
          idx += 1;
          if (doRadarUpdate && idx == 1) {
            updateRadar();
          }
          if (idx == frameCount + 1) {
            idx = 0;
          }
          if (idx != frameCount + 1) {
            document.getElementById("progress-bar").style.width = (idx+1)*barSize+"px";
          }
          if (idx < frameCount) {
            document.getElementById('timestamp').innerHTML = radarTime[idx];
            radarImage[idx].setOpacity(radarOpacity);
          }
        }

        function resizeWindow() {
          this.document.getElementById("color-bar").width = this.frameElement.offsetWidth;
          this.document.getElementById("img-color-bar").width = this.frameElement.offsetWidth;
          this.document.getElementById("mapid").width = this.frameElement.offsetWidth;
          this.document.getElementById("mapid").height = ${this.isPanel
        ? this.offsetParent
          ? this.offsetParent.clientHeight - 48 - 2 - (this.editMode === true ? 59 : 0)
          : 492
        : this._config.square_map !== undefined
          ? this._config.square_map
            ? this.getBoundingClientRect().width
            : 492
          : 492
      }
          this.document.getElementById("div-progress-bar").width = this.frameElement.offsetWidth;
          this.document.getElementById("bottom-container").width = this.frameElement.offsetWidth;
          barSize = this.frameElement.offsetWidth/frameCount;
        }
        </script>
            </span>
        </body>
      </html>
    `;

    const padding = this.isPanel
      ? this.offsetParent
        ? this.offsetParent.clientHeight - 2 - (this.editMode === true ? 59 : 0) + `px`
        : `540px`
      : this._config.square_map !== undefined
        ? this._config.square_map
          ? `${this.getBoundingClientRect().width + 48}px`
          : `540px`
        : `540px`;

    const cardTitle = this._config.card_title !== undefined ? html`<div id="card-title">${this._config.card_title}</div>` : ``;

    return html`
      <style>
        ${this.styles}
      </style>
      <ha-card class="type-iframe">
        ${cardTitle}
        <div id="root" style="padding-top: ${padding}">
          <iframe srcdoc=${doc} scrolling="no"></iframe>
        </div>
      </ha-card>
    `;
  }

  private showWarning(warning: string): TemplateResult {
    return html`
      <hui-warning>${warning}</hui-warning>
    `;
  }

  private showError(error: string): TemplateResult {
    const errorCard = document.createElement('hui-error-card') as LovelaceCard;
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this._config,
    });

    return html`
      ${errorCard}
    `;
  }

  get styles(): CSSResult {
    return css`
      .text-container {
        font: 12px/1.5 'Helvetica Neue', Arial, Helvetica, sans-serif;
      }
      #timestamp {
        margin: 2px 0px;
      }
      #color-bar {
        margin: 0px 0px;
      }
      ha-card {
        overflow: hidden;
      }
      #root {
        width: 100%;
        position: relative;
      }
      iframe {
        position: absolute;
        border: none;
        width: 100%;
        height: 100%;
        top: 0;
        left: 0;
      }
      #card-title {
        margin: 8px 0px 4px 8px;
        font-size: 1.5em;
      }
    `;
  }
}
