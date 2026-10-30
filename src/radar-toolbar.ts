/* eslint-disable @typescript-eslint/no-unused-vars */
import * as L from 'leaflet';
import { localize } from './localize/localize';

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
  /** URL of a toolbar icon file; default page-relative under ICON_BASE. */
  assetUrl?: (file: string) => string;
  /** Initial playing state. When false the toolbar starts with a play
   *  icon instead of a pause icon. Default true (playing). */
  initialPlaying?: boolean;
  /** Initial playback speed multiplier. The card owns persistence (via
   * ViewerState); the toolbar just renders and cycles the value. */
  initialSpeed?: number;
  /** Notified when the user clicks the speed button to cycle to the next preset. */
  onSpeedChange?: (multiplier: number) => void;
  /** Tap on a view preset's chip beside the re-centre button. */
  onClearStop?: () => void;
}

/** How long Default or the tracked marker's name shows beside the re-centre button. */
export const STOP_LABEL_MS = 5000;

/**
 * Simple Leaflet control that replaces Leaflet.Toolbar2 for v3.
 * Renders skip-back, play/pause, skip-next, speed and re-centre buttons as a
 * standard Leaflet bar control positioned at bottom-right.
 */
export class RadarToolbar extends L.Control {
  private _opts: RadarToolbarOptions;
  private _playBtn: HTMLImageElement | null = null;
  private _speedBtn: HTMLAnchorElement | null = null;
  private _recenterBtn: HTMLAnchorElement | null = null;
  private _stopLabel: HTMLButtonElement | null = null;
  private _stopLabelTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopSticky = false;
  private _playing = true;
  private _speed = 1;

  private _asset(file: string): string {
    return this._opts.assetUrl ? this._opts.assetUrl(file) : `${ICON_BASE}${file}`;
  }

  constructor(opts: RadarToolbarOptions) {
    super({ position: 'bottomright' });
    this._opts = opts;
    this._playing = opts.initialPlaying !== false;
  }

  onAdd(_map: L.Map): HTMLElement {
    const bar = L.DomUtil.create('div', 'radar-toolbar leaflet-bar');
    L.DomEvent.disableClickPropagation(bar);

    if (this._opts.showPlayback) {
      this._addBtn(bar, this._asset('skip-back.png'), 'Previous frame', () => this._opts.onSkipBack?.());

      const playImg = this._addBtn(bar, this._asset(this._playing ? 'pause.png' : 'play.png'), 'Play / Pause', () => {
        this._playing = !this._playing;
        playImg.src = this._asset(this._playing ? 'pause.png' : 'play.png');
        this._opts.onPlay?.();
      });
      this._playBtn = playImg;

      this._addBtn(bar, this._asset('skip-next.png'), 'Next frame', () => this._opts.onSkipNext?.());

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

    // Last, so the button and the stop label beside it sit in the map's
    // bottom-right corner, where they cover the least of the map.
    if (this._opts.showRecenter) {
      const img = this._addBtn(bar, this._asset('recenter.png'), localize('ui.recenter'), () => this._opts.onRecenter?.());
      this._recenterBtn = img.parentElement as HTMLAnchorElement;
      // The title becomes the next stop's name; keep the button's name.
      this._recenterBtn.setAttribute('aria-label', localize('ui.recenter'));
      this._addStopLabel(bar);
    }

    return bar;
  }

  /** The re-centre button's tooltip: where the next press goes. */
  setRecenterTitle(title: string): void {
    if (this._recenterBtn) this._recenterBtn.title = title;
  }

  /**
   * Show the stop the rotation moved to beside the re-centre button. A
   * sticky label (a preset) stays as a chip that clears the preset when
   * tapped; any other label shows for STOP_LABEL_MS. null hides it.
   */
  showStopLabel(text: string | null, sticky: boolean): void {
    const chip = this._stopLabel;
    if (!chip) return;
    if (this._stopLabelTimer) clearTimeout(this._stopLabelTimer);
    this._stopLabelTimer = null;
    this._stopSticky = text !== null && sticky;
    chip.hidden = text === null;
    if (text === null) return;
    (chip.firstChild as HTMLElement).textContent = text;
    chip.classList.toggle('sticky', sticky);
    chip.tabIndex = sticky ? 0 : -1;
    chip.title = sticky ? localize('ui.preset_clear') : '';
    chip.setAttribute('aria-label', sticky ? `${localize('ui.preset_clear')}: ${text}` : text);
    if (!sticky) {
      this._stopLabelTimer = setTimeout(() => {
        this._stopLabelTimer = null;
        chip.hidden = true;
      }, STOP_LABEL_MS);
    }
  }

  private _addStopLabel(bar: HTMLElement): void {
    const chip = L.DomUtil.create('button', 'radar-stop-label', bar) as HTMLButtonElement;
    chip.type = 'button';
    chip.hidden = true;
    chip.setAttribute('aria-live', 'polite');
    L.DomUtil.create('span', 'radar-stop-name', chip);
    const x = L.DomUtil.create('span', 'radar-stop-clear', chip);
    x.textContent = '×';
    x.setAttribute('aria-hidden', 'true');
    L.DomEvent.on(chip, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      if (this._stopSticky) this._opts.onClearStop?.();
    });
    this._stopLabel = chip;
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
    // Snap to the nearest preset, mirroring onAdd's initialSpeed
    // handling. A raw non-preset value (e.g. YAML playback_speed: 1.5)
    // made SPEED_STEPS.indexOf return -1 in the cycle handler, so the
    // first click jumped to ¼× instead of the next step up.
    this._speed = SPEED_STEPS.reduce(
      (best, st) => (Math.abs(st - multiplier) < Math.abs(best - multiplier) ? st : best),
      SPEED_STEPS[0],
    );
    if (this._speedBtn) {
      this._speedBtn.textContent = formatSpeed(this._speed);
    }
  }

  /** Called by the card when playback state changes externally (e.g. skip-step). */
  setPlaying(playing: boolean): void {
    this._playing = playing;
    if (this._playBtn) {
      this._playBtn.src = this._asset(playing ? 'pause.png' : 'play.png');
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
