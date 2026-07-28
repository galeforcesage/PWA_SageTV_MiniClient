/**
 * Equalizer panel UI component.
 *
 * Renders a modal overlay with:
 * - Enable toggle + preset dropdown + reset button
 * - 10 vertical band sliders + preamp slider
 * - Night mode section (toggle, mode, intensity, schedule)
 * - Status indicator (Client/Server/Off + Night Mode)
 *
 * Supports both pointer/touch and Tizen TV remote (arrow keys).
 *
 * @module audio-processing/equalizer-panel
 */

import { CANONICAL_FREQUENCIES, FREQUENCY_LABELS, GAIN_MIN, GAIN_MAX, GAIN_STEP, clampGain } from './models.js';
import { getPresetNames, applyPreset, detectPreset } from './presets.js';

export class EqualizerPanel extends EventTarget {
  /**
   * @param {Object} options
   * @param {import('./settings-store.js').SettingsStore} options.settingsStore
   * @param {import('./web-audio-engine.js').WebAudioEngine} options.engine
   * @param {boolean} [options.isTizen=false]
   */
  constructor({ settingsStore, engine, isTizen = false }) {
    super();
    this._store = settingsStore;
    this._engine = engine;
    this._isTizen = isTizen;
    this._overlay = null;
    this._sliders = [];
    this._preampSlider = null;
    this._presetSelect = null;
    this._enabledCheckbox = null;
    this._visible = false;

    // Bind handlers for cleanup
    this._onKeyDown = this._handleKeyDown.bind(this);
  }

  /**
   * Initialize the panel by finding DOM elements (already in index.html).
   * Call after DOMContentLoaded.
   */
  init() {
    this._overlay = document.getElementById('eq-overlay');
    if (!this._overlay) {
      console.warn('[EqualizerPanel] #eq-overlay not found in DOM');
      return;
    }

    // Populate preset dropdown
    this._presetSelect = document.getElementById('eq-preset');
    if (this._presetSelect) {
      this._presetSelect.innerHTML = '';
      for (const name of getPresetNames()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        this._presetSelect.appendChild(opt);
      }
      this._presetSelect.addEventListener('change', () => this._onPresetChange());
    }

    // Enable checkbox
    this._enabledCheckbox = document.getElementById('eq-enabled');
    if (this._enabledCheckbox) {
      this._enabledCheckbox.addEventListener('change', () => this._onEnabledChange());
    }

    // Reset button
    const resetBtn = document.getElementById('eq-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this._onReset());
    }

    // Close button
    const closeBtn = document.getElementById('eq-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide());
    }

    // Overlay backdrop click to close
    this._overlay.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.hide();
    });

    // Collect band sliders
    this._sliders = [];
    for (let i = 0; i < CANONICAL_FREQUENCIES.length; i++) {
      const slider = this._overlay.querySelector(`[data-band="${i}"]`);
      if (slider) {
        this._sliders.push(slider);
        slider.addEventListener('input', () => this._onBandChange(i, parseFloat(slider.value)));
      }
    }

    // Preamp slider
    this._preampSlider = this._overlay.querySelector('[data-band="preamp"]');
    if (this._preampSlider) {
      this._preampSlider.addEventListener('input', () =>
        this._onPreampChange(parseFloat(this._preampSlider.value)),
      );
    }

    // Night mode controls
    this._nightEnabled = document.getElementById('eq-night-enabled');
    this._nightMode = document.getElementById('eq-night-mode');
    this._nightIntensity = document.getElementById('eq-night-intensity');
    this._nightScheduled = document.getElementById('eq-night-scheduled');
    this._nightStart = document.getElementById('eq-night-start');
    this._nightEnd = document.getElementById('eq-night-end');

    if (this._nightEnabled) {
      this._nightEnabled.addEventListener('change', () => this._onNightModeChange());
    }
    if (this._nightMode) {
      this._nightMode.addEventListener('change', () => this._onNightModeChange());
    }
    if (this._nightIntensity) {
      this._nightIntensity.addEventListener('change', () => this._onNightModeChange());
    }
    if (this._nightScheduled) {
      this._nightScheduled.addEventListener('change', () => this._onNightModeChange());
    }
    if (this._nightStart) {
      this._nightStart.addEventListener('change', () => this._onNightModeChange());
    }
    if (this._nightEnd) {
      this._nightEnd.addEventListener('change', () => this._onNightModeChange());
    }

    // Tizen remote key handling
    if (this._isTizen && typeof tizen !== 'undefined') {
      try {
        tizen.tvinputdevice.registerKey('MediaPlayPause');
      } catch { /* ignore on non-Tizen */ }
    }

    // Load initial state
    this._syncFromSettings();
  }

  /**
   * Show the equalizer panel.
   */
  show() {
    if (!this._overlay) return;
    this._syncFromSettings();
    this._overlay.hidden = false;
    this._visible = true;
    document.addEventListener('keydown', this._onKeyDown);

    // Focus first slider for Tizen remote
    if (this._isTizen && this._sliders.length > 0) {
      this._sliders[0].focus();
    }

    this.dispatchEvent(new CustomEvent('visibilitychange', { detail: { visible: true } }));
  }

  /**
   * Hide the equalizer panel.
   */
  hide() {
    if (!this._overlay) return;
    this._overlay.hidden = true;
    this._visible = false;
    document.removeEventListener('keydown', this._onKeyDown);
    this.dispatchEvent(new CustomEvent('visibilitychange', { detail: { visible: false } }));
  }

  /**
   * Is the panel currently visible?
   * @returns {boolean}
   */
  isVisible() {
    return this._visible;
  }

  /**
   * Update the status indicator.
   * @param {Object} status
   * @param {boolean} status.eqActive
   * @param {boolean} status.nightModeActive
   * @param {boolean} status.serverProcessing  True when server handles EQ (AVPlay)
   */
  updateStatus({ eqActive = false, nightModeActive = false, serverProcessing = false } = {}) {
    const el = document.getElementById('eq-status');
    if (!el) return;

    let text = '';
    if (serverProcessing) {
      text = '🟡 EQ via Server';
    } else if (eqActive) {
      text = '🟢 EQ Active (Client)';
    } else {
      text = '⚪ EQ Off';
    }

    if (nightModeActive) {
      text += ' · 🌙 Night Mode';
    }

    el.textContent = text;
  }

  // ── Internal: Settings ↔ UI sync ─────────────────────────────

  /** Sync all UI elements from current settings. */
  _syncFromSettings() {
    const settings = this._store.getCurrentSettings();

    if (this._enabledCheckbox) {
      this._enabledCheckbox.checked = settings.enabled;
    }

    if (this._presetSelect) {
      this._presetSelect.value = settings.presetName;
    }

    if (this._preampSlider) {
      this._preampSlider.value = String(settings.preampDb);
    }

    this._sliders.forEach((slider, i) => {
      if (settings.bands[i]) {
        slider.value = String(settings.bands[i].gain);
      }
    });

    // Night mode
    if (this._nightEnabled) this._nightEnabled.checked = settings.nightMode.enabled;
    if (this._nightMode) this._nightMode.value = settings.nightMode.mode;
    if (this._nightIntensity) this._nightIntensity.value = settings.nightMode.intensity;
    if (this._nightScheduled) this._nightScheduled.checked = settings.nightMode.scheduled;
    if (this._nightStart) this._nightStart.value = settings.nightMode.nightStartTime;
    if (this._nightEnd) this._nightEnd.value = settings.nightMode.nightEndTime;

    this.updateStatus({
      eqActive: this._engine.isActive(),
      nightModeActive: this._engine.isNightModeActive(),
    });
  }

  // ── Internal: Event handlers ─────────────────────────────────

  _onEnabledChange() {
    const settings = this._store.getCurrentSettings();
    settings.enabled = this._enabledCheckbox.checked;
    this._saveAndApply(settings);
  }

  _onPresetChange() {
    const presetName = this._presetSelect.value;
    const result = applyPreset(presetName);
    if (!result) return;

    const settings = this._store.getCurrentSettings();
    settings.presetName = presetName;
    settings.bands = result.bands;
    settings.preampDb = result.preamp;

    // Update slider positions
    this._sliders.forEach((slider, i) => {
      slider.value = String(settings.bands[i].gain);
    });
    if (this._preampSlider) {
      this._preampSlider.value = String(settings.preampDb);
    }

    this._saveAndApply(settings);
  }

  _onBandChange(index, gain) {
    const settings = this._store.getCurrentSettings();
    settings.bands[index].gain = clampGain(gain);

    // Detect if it still matches a preset
    settings.presetName = detectPreset(settings.bands, settings.preampDb);
    if (this._presetSelect) {
      this._presetSelect.value = settings.presetName;
    }

    this._engine.updateBand(index, settings.bands[index].gain);
    this._store.save(settings);
    this._emitSettingsChanged(settings);
  }

  _onPreampChange(db) {
    const settings = this._store.getCurrentSettings();
    settings.preampDb = clampGain(db);

    settings.presetName = detectPreset(settings.bands, settings.preampDb);
    if (this._presetSelect) {
      this._presetSelect.value = settings.presetName;
    }

    this._engine.updatePreamp(settings.preampDb);
    this._store.save(settings);
    this._emitSettingsChanged(settings);
  }

  _onNightModeChange() {
    const settings = this._store.getCurrentSettings();
    if (this._nightEnabled) settings.nightMode.enabled = this._nightEnabled.checked;
    if (this._nightMode) settings.nightMode.mode = this._nightMode.value;
    if (this._nightIntensity) settings.nightMode.intensity = this._nightIntensity.value;
    if (this._nightScheduled) settings.nightMode.scheduled = this._nightScheduled.checked;
    if (this._nightStart) settings.nightMode.nightStartTime = this._nightStart.value;
    if (this._nightEnd) settings.nightMode.nightEndTime = this._nightEnd.value;
    this._saveAndApply(settings);
  }

  _onReset() {
    const settings = this._store.reset();
    this._syncFromSettings();
    this._engine.applySettings(settings);
    this._emitSettingsChanged(settings);
  }

  /** Save settings, apply to engine, update status, emit change. */
  _saveAndApply(settings) {
    this._store.save(settings);
    this._engine.applySettings(settings);
    this.updateStatus({
      eqActive: this._engine.isActive(),
      nightModeActive: this._engine.isNightModeActive(),
    });
    this._emitSettingsChanged(settings);
  }

  _emitSettingsChanged(settings) {
    this.dispatchEvent(new CustomEvent('settingschanged', { detail: { settings } }));
  }

  // ── Keyboard / Remote ────────────────────────────────────────

  _handleKeyDown(e) {
    if (!this._visible) return;

    switch (e.key) {
      case 'Escape':
      case 'Back':       // Tizen remote
      case 'XF86Back':   // Tizen remote alt
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        break;

      case 'ArrowLeft':
      case 'ArrowRight':
        if (this._isTizen) {
          e.preventDefault();
          this._moveFocus(e.key === 'ArrowRight' ? 1 : -1);
        }
        break;

      case 'ArrowUp':
      case 'ArrowDown':
        if (this._isTizen && document.activeElement?.type === 'range') {
          e.preventDefault();
          const slider = document.activeElement;
          const delta = e.key === 'ArrowUp' ? GAIN_STEP : -GAIN_STEP;
          slider.value = String(clampGain(parseFloat(slider.value) + delta));
          slider.dispatchEvent(new Event('input'));
        }
        break;
    }
  }

  /** Move focus between sliders (for Tizen remote). */
  _moveFocus(direction) {
    const allFocusable = [this._preampSlider, ...this._sliders].filter(Boolean);
    const current = allFocusable.indexOf(document.activeElement);
    if (current < 0) {
      allFocusable[0]?.focus();
      return;
    }
    const next = current + direction;
    if (next >= 0 && next < allFocusable.length) {
      allFocusable[next].focus();
    }
  }
}
