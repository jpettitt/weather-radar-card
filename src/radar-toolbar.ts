/* eslint-disable @typescript-eslint/no-unused-vars */
import * as L from 'leaflet';

const ICON_BASE = '/local/community/weather-radar-card/';

// Playback speed multipliers cycled by the speed button. 1× is the config's
// frame_delay; lower values slow the playback (longer delay between frames),
// higher values speed it up. The set covers the practical range: ¼× for
// inspecting an individual front's evolution frame by frame, 4× for watching
// a long forecast loop quickly.
export const SPEED_STEPS = [0.25, 0.5, 1, 2, 4] as const;

export interface RadarToolbarOptions {
  showRecenter: boolean;
  showPlayback: boolean;
  onRecenter?: () => void;
  onPlay?: () => void;
  onSkipBack?: () => void;
  onSkipNext?: () => void;
  /** Initial playback speed multiplier. The card owns persistence (via
   * ViewerState); the toolbar just renders and cycles the value. */
  initialSpeed?: number;
  /** Notified when the user clicks the speed button to cycle to the next preset. */
  onSpeedChange?: (multiplier: number) => void;
}

/**
 * Simple Leaflet control that replaces Leaflet.Toolbar2 for v3.
 * Renders recenter, play/pause, skip-back, skip-next buttons as a standard
 * Leaflet bar control positioned at bottom-right.
 */
export class RadarToolbar extends L.Control {
  private _opts: RadarToolbarOptions;
  private _playBtn: HTMLImageElement | null = null;
  private _speedBtn: HTMLAnchorElement | null = null;
  private _playing = true;
  private _speed = 1;

  constructor(opts: RadarToolbarOptions) {
    super({ position: 'bottomright' });
    this._opts = opts;
  }

  onAdd(_map: L.Map): HTMLElement {
    const bar = L.DomUtil.create('div', 'radar-toolbar leaflet-bar');
    L.DomEvent.disableClickPropagation(bar);

    if (this._opts.showRecenter) {
      this._addBtn(bar, `${ICON_BASE}recenter.png`, 'Re-centre', () => this._opts.onRecenter?.());
    }

    if (this._opts.showPlayback) {
      this._addBtn(bar, `${ICON_BASE}skip-back.png`, 'Previous frame', () => this._opts.onSkipBack?.());

      const playImg = this._addBtn(bar, `${ICON_BASE}pause.png`, 'Play / Pause', () => {
        this._playing = !this._playing;
        playImg.src = `${ICON_BASE}${this._playing ? 'pause' : 'play'}.png`;
        this._opts.onPlay?.();
      });
      this._playBtn = playImg;

      this._addBtn(bar, `${ICON_BASE}skip-next.png`, 'Next frame', () => this._opts.onSkipNext?.());

      // Speed button cycles through SPEED_STEPS. Snap the initial value to
      // the nearest preset so a stored override from an older SPEED_STEPS
      // set doesn't leave the button stuck between presets.
      const initial = this._opts.initialSpeed ?? 1;
      this._speed = SPEED_STEPS.reduce(
        (best, s) => Math.abs(s - initial) < Math.abs(best - initial) ? s : best,
        SPEED_STEPS[0],
      );
      this._speedBtn = this._addSpeedBtn(bar);
    }

    return bar;
  }

  /** Current speed multiplier; persisted by the card. */
  get speed(): number {
    return this._speed;
  }

  /**
   * Called by the card when the playback-speed multiplier changes
   * outside the button's cycle handler — typically because the user
   * picked a new preset in the editor. Updates the button label so it
   * stays in sync with the player's active speed.
   */
  setSpeed(multiplier: number): void {
    this._speed = multiplier;
    if (this._speedBtn) {
      this._speedBtn.textContent = formatSpeed(multiplier);
    }
  }

  /** Called by the card when playback state changes externally (e.g. skip-step). */
  setPlaying(playing: boolean): void {
    this._playing = playing;
    if (this._playBtn) {
      this._playBtn.src = `${ICON_BASE}${playing ? 'pause' : 'play'}.png`;
    }
  }

  private _addBtn(container: HTMLElement, iconSrc: string, title: string, handler: () => void): HTMLImageElement {
    const li = L.DomUtil.create('li', '', container);
    const a = L.DomUtil.create('a', 'leaflet-bar-part', li) as HTMLAnchorElement;
    a.href = '#';
    a.title = title;
    a.style.cssText = 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;';
    const img = L.DomUtil.create('img', '', a) as HTMLImageElement;
    img.src = iconSrc;
    img.width = 24;
    img.height = 24;
    L.DomEvent.on(a, 'click', (e) => { L.DomEvent.preventDefault(e); handler(); });
    return img;
  }

  // Text-only button rather than an image so we can show the active speed
  // multiplier inline. Click cycles to the next preset in SPEED_STEPS and
  // calls onSpeedChange with the new value.
  private _addSpeedBtn(container: HTMLElement): HTMLAnchorElement {
    const li = L.DomUtil.create('li', '', container);
    const a = L.DomUtil.create('a', 'leaflet-bar-part', li) as HTMLAnchorElement;
    a.href = '#';
    a.title = 'Playback speed';
    a.style.cssText = 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;font:bold 12px/1 sans-serif;color:#444;text-decoration:none;';
    a.textContent = formatSpeed(this._speed);
    L.DomEvent.on(a, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      const idx = SPEED_STEPS.indexOf(this._speed as typeof SPEED_STEPS[number]);
      this._speed = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
      a.textContent = formatSpeed(this._speed);
      this._opts.onSpeedChange?.(this._speed);
    });
    return a;
  }
}

// Compact label for a speed multiplier. Uses Unicode fractions for the
// sub-1× presets so the button stays narrow enough to fit in the existing
// 30px Leaflet bar slot.
export function formatSpeed(s: number): string {
  if (s === 0.25) return '¼×';
  if (s === 0.5) return '½×';
  if (Number.isInteger(s)) return `${s}×`;
  return `${s.toFixed(2)}×`;
}
