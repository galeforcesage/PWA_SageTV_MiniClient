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

    // TV remote focus model (Tizen): a flat, ordered list of every focusable
    // control plus the index of the one currently highlighted.
    this._focusables = [];
    this._focusIndex = 0;
    this._lastSlider = null;

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

    // Client-vs-server processing toggle
    this._clientProcessingCheckbox = document.getElementById('eq-client-processing');
    this._clientToggleWrap = document.getElementById('eq-client-toggle');
    this._serverNote = document.getElementById('eq-server-note');
    if (this._clientProcessingCheckbox) {
      this._clientProcessingCheckbox.addEventListener('change', () => this._onClientProcessingChange());
    }
    // On Tizen the client can't run Web Audio DSP for the AVPlay path, so the
    // choice is meaningless — hide the toggle and keep client-capable UI only.
    if (this._isTizen && this._clientToggleWrap) {
      this._clientToggleWrap.hidden = true;
    }

    // Tizen remote key handling
    if (this._isTizen && typeof tizen !== 'undefined') {
      try {
        tizen.tvinputdevice.registerKey('MediaPlayPause');
      } catch { /* ignore on non-Tizen */ }
    }

    // On a TV, scale the panel up and enable the remote focus model.
    if (this._isTizen) {
      const card = this._overlay.querySelector('.modal-card');
      if (card) card.classList.add('eq-tizen');
    }

    // Load initial state (also applies the client/server processing-mode UI).
    this._syncFromSettings();
  }

  /**
   * Disable night-mode techniques the client can't actually perform yet.
   * Only DRC (DynamicsCompressorNode) is implemented client-side; Loudness
   * leveling and platform night mode are placeholders. Disabling them keeps
   * the UI honest (we never claim DSP we can't do).
   */
  _disableUnimplementedNightModes() {
    if (!this._nightMode) return;
    for (const opt of this._nightMode.options) {
      if (opt.value !== 'DYNAMIC_RANGE_COMPRESSION') {
        opt.disabled = true;
      }
    }
    // Force any stale persisted selection back to the working mode.
    if (this._nightMode.value !== 'DYNAMIC_RANGE_COMPRESSION') {
      this._nightMode.value = 'DYNAMIC_RANGE_COMPRESSION';
    }
  }

  /**
   * Apply UI state that depends on where processing happens (client vs server).
   *
   * - Client mode: only the client-capable night-mode technique (DRC) is
   *   offered; the "server not available" note is hidden.
   * - Server mode: the two server-only techniques (loudness leveling, platform
   *   night mode) become selectable, and an honest note explains that the
   *   server EQ isn't wired up yet so nothing is audible until it is.
   */
  _applyProcessingModeUI() {
    const settings = this._store.getCurrentSettings();
    const client = settings.clientProcessing !== false;

    if (this._nightMode) {
      if (client) {
        this._disableUnimplementedNightModes();
      } else {
        for (const opt of this._nightMode.options) opt.disabled = false;
      }
    }
    if (this._serverNote) {
      // Only nag when EQ is actually on but pointed at the (absent) server.
      this._serverNote.hidden = client || !settings.enabled;
    }
  }

  /**
   * Show the equalizer panel.
   */
  show() {
    if (!this._overlay) return;
    this._syncFromSettings();
    this._overlay.hidden = false;
    this._visible = true;
    // Capture on window so the modal intercepts remote keys before the SageTV
    // spatial-nav (document capture) and input-manager (document bubble) can
    // forward them to the server.
    window.addEventListener('keydown', this._onKeyDown, true);

    // Tizen remote: take over volume keys, build the focus ring, focus the top.
    if (this._isTizen) {
      this._registerTvKeys();
      this._buildFocusList();
      this._setFocus(0);
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
    window.removeEventListener('keydown', this._onKeyDown, true);
    if (this._isTizen) {
      this._unregisterTvKeys();
      this._clearFocusHighlight();
    }
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
  /**
   * Update the status indicator. Derives the displayed state from the user's
   * intent (persisted settings) plus the engine's real state, so the badge is
   * honest: "on but waiting for playback" is distinct from "actively
   * processing" and from "off".
   *
   * @param {Object} [opts]
   * @param {boolean} [opts.serverProcessing]  True when the server handles EQ
   *   (e.g. Tizen AVPlay, where the browser can't attach Web Audio).
   */
  updateStatus({ serverProcessing = false } = {}) {
    const el = document.getElementById('eq-status');
    if (!el) return;

    const settings = this._store.getCurrentSettings();
    const enabled = !!settings.enabled;
    const clientProcessing = settings.clientProcessing !== false;
    const attached = this._engine.isAttached();

    let text;
    if (!clientProcessing) {
      // User handed processing to the server (which isn't wired up yet).
      text = enabled
        ? '🔵 Set to Server EQ · server EQ not available yet'
        : '⚪ EQ Off';
    } else if (serverProcessing) {
      // Client can't run DSP for this playback path; server applies it.
      text = enabled ? '🟡 EQ via Server' : '⚪ EQ Off';
    } else if (!enabled) {
      text = '⚪ EQ Off';
    } else if (attached) {
      text = '🟢 EQ Active (Client)';
    } else {
      // Enabled, but no media graph yet — Web Audio attaches when video plays.
      text = '🟡 EQ On · starts when video plays';
    }

    // Night-mode suffix (client mode only). When attached use the engine's real
    // state; otherwise reflect the user's intent as pending.
    const nightOn = clientProcessing && !serverProcessing && (attached
      ? this._engine.isNightModeActive()
      : (enabled && settings.nightMode && settings.nightMode.enabled));
    if (nightOn) {
      text += ' · 🌙 Night Mode';
    }

    el.textContent = text;
  }

  // ── Internal: Settings ↔ UI sync ─────────────────────────────

  /** Format a dB value for display, e.g. "+3", "0", "-2.5". */
  _formatDb(v) {
    const n = Math.round(v * 10) / 10;
    if (n === 0) return '0';
    return (n > 0 ? '+' : '') + n;
  }

  /**
   * Update the numeric label above a slider.
   * @param {number|'preamp'} key  Band index or 'preamp'
   * @param {number} value  Gain in dB
   */
  _updateValueLabel(key, value) {
    const span = this._overlay?.querySelector(`[data-value-for="${key}"]`);
    if (span) span.textContent = this._formatDb(value);
  }

  /** Refresh every numeric label (preamp + all bands) from current settings. */
  _refreshAllValueLabels(settings) {
    this._updateValueLabel('preamp', settings.preampDb);
    settings.bands.forEach((band, i) => this._updateValueLabel(i, band.gain));
  }

  /** Sync all UI elements from current settings. */
  _syncFromSettings() {
    const settings = this._store.getCurrentSettings();

    if (this._enabledCheckbox) {
      this._enabledCheckbox.checked = settings.enabled;
    }

    if (this._clientProcessingCheckbox) {
      this._clientProcessingCheckbox.checked = settings.clientProcessing !== false;
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

    this._refreshAllValueLabels(settings);

    // Night mode
    if (this._nightEnabled) this._nightEnabled.checked = settings.nightMode.enabled;
    if (this._nightMode) this._nightMode.value = settings.nightMode.mode;
    if (this._nightIntensity) this._nightIntensity.value = settings.nightMode.intensity;
    if (this._nightScheduled) this._nightScheduled.checked = settings.nightMode.scheduled;
    if (this._nightStart) this._nightStart.value = settings.nightMode.nightStartTime;
    if (this._nightEnd) this._nightEnd.value = settings.nightMode.nightEndTime;

    this._applyProcessingModeUI();
    this.updateStatus();
  }

  // ── Internal: Event handlers ─────────────────────────────────

  _onEnabledChange() {
    const settings = this._store.getCurrentSettings();
    settings.enabled = this._enabledCheckbox.checked;
    this._saveAndApply(settings);
    // Enabling/disabling can change whether the server note should show.
    this._applyProcessingModeUI();
  }

  _onClientProcessingChange() {
    const settings = this._store.getCurrentSettings();
    settings.clientProcessing = !!this._clientProcessingCheckbox.checked;
    this._store.save(settings);
    this._applyProcessingModeUI();
    this.updateStatus();
    // app.js listens for this to attach (client) or bypass (server) the engine.
    this._emitSettingsChanged(settings);
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
    this._refreshAllValueLabels(settings);

    this._saveAndApply(settings);
  }

  _onBandChange(index, gain) {
    const settings = this._store.getCurrentSettings();
    settings.bands[index].gain = clampGain(gain);
    this._updateValueLabel(index, settings.bands[index].gain);

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
    this._updateValueLabel('preamp', settings.preampDb);

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
    this.updateStatus();
    this._emitSettingsChanged(settings);
  }

  _emitSettingsChanged(settings) {
    this.dispatchEvent(new CustomEvent('settingschanged', { detail: { settings } }));
  }

  // ── Keyboard / Remote ────────────────────────────────────────

  _handleKeyDown(e) {
    if (!this._visible) return;

    const code = e.keyCode;

    // Close: Esc, Tizen Back (10009), or the remote Back/Return keys.
    if (e.key === 'Escape' || e.key === 'Back' || e.key === 'XF86Back' || code === 10009) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.hide();
      return;
    }

    // Desktop/browser keeps native Tab/focus behaviour; only Esc is intercepted.
    if (!this._isTizen) return;

    // Volume keys are temporarily taken over while the panel is open: they nudge
    // the focused slider (or the last one used). keyCodes: VolumeUp 447, Down 448.
    if (e.key === 'VolumeUp' || e.key === 'AudioVolumeUp' || code === 447) {
      e.preventDefault(); e.stopImmediatePropagation();
      this._nudgeSlider(this._activeSlider(), GAIN_STEP);
      return;
    }
    if (e.key === 'VolumeDown' || e.key === 'AudioVolumeDown' || code === 448) {
      e.preventDefault(); e.stopImmediatePropagation();
      this._nudgeSlider(this._activeSlider(), -GAIN_STEP);
      return;
    }

    const el = this._focusables[this._focusIndex];
    const isSlider = !!el && el.type === 'range';
    const isSelect = !!el && el.tagName === 'SELECT';

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault(); e.stopImmediatePropagation();
        this._setFocus(this._focusIndex - 1);
        break;
      case 'ArrowRight':
        e.preventDefault(); e.stopImmediatePropagation();
        this._setFocus(this._focusIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault(); e.stopImmediatePropagation();
        if (isSlider) this._nudgeSlider(el, GAIN_STEP);
        else if (isSelect) this._cycleSelect(el, -1);
        else this._setFocus(this._focusIndex - 1);
        break;
      case 'ArrowDown':
        e.preventDefault(); e.stopImmediatePropagation();
        if (isSlider) this._nudgeSlider(el, -GAIN_STEP);
        else if (isSelect) this._cycleSelect(el, 1);
        else this._setFocus(this._focusIndex + 1);
        break;
      case 'Enter':
        e.preventDefault(); e.stopImmediatePropagation();
        this._activate(el);
        break;
    }
  }

  /** Build the ordered list of focusable controls (visible + enabled only). */
  _buildFocusList() {
    const top = ['eq-enabled', 'eq-client-processing', 'eq-preset', 'eq-reset', 'eq-close']
      .map((id) => document.getElementById(id));
    const sliders = [this._preampSlider, ...this._sliders];
    const night = [
      'eq-night-enabled', 'eq-night-mode', 'eq-night-intensity',
      'eq-night-scheduled', 'eq-night-start', 'eq-night-end',
    ].map((id) => document.getElementById(id));

    // offsetParent === null filters out anything hidden (e.g. the client-EQ
    // toggle, which is hidden on Tizen).
    this._focusables = [...top, ...sliders, ...night].filter(
      (el) => el && !el.disabled && el.offsetParent !== null,
    );
    this._focusIndex = 0;
  }

  /** Focus the control at index i (clamped) and give it a visible highlight. */
  _setFocus(i) {
    if (!this._focusables.length) return;
    this._focusIndex = Math.max(0, Math.min(this._focusables.length - 1, i));
    this._clearFocusHighlight();
    const el = this._focusables[this._focusIndex];
    if (!el) return;
    el.classList.add('eq-focused');
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (el.type === 'range') this._lastSlider = el;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  }

  /** Remove the highlight class from every focusable. */
  _clearFocusHighlight() {
    for (const el of this._focusables) el.classList.remove('eq-focused');
  }

  /** The slider volume keys should drive: current focus if a slider, else last used. */
  _activeSlider() {
    const el = this._focusables[this._focusIndex];
    if (el && el.type === 'range') return el;
    return this._lastSlider || this._preampSlider || this._sliders[0] || null;
  }

  /** Nudge a range slider by delta dB and fire its input handler. */
  _nudgeSlider(slider, delta) {
    if (!slider) return;
    slider.value = String(clampGain(parseFloat(slider.value) + delta));
    slider.dispatchEvent(new Event('input'));
    this._lastSlider = slider;
  }

  /** Move a <select> to the next non-disabled option and fire change. */
  _cycleSelect(select, dir) {
    if (!select) return;
    let i = select.selectedIndex;
    for (let step = 0; step < select.options.length; step++) {
      i += dir;
      if (i < 0 || i >= select.options.length) return;
      if (!select.options[i].disabled) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change'));
        return;
      }
    }
  }

  /** Activate the focused control (Enter/OK). Sliders/selects use Up/Down. */
  _activate(el) {
    if (!el) return;
    if (el.type === 'checkbox') {
      el.checked = !el.checked;
      el.dispatchEvent(new Event('change'));
    } else if (el.tagName === 'BUTTON') {
      el.click();
    }
  }

  /** Temporarily take over the TV keys we drive while the panel is open. */
  _registerTvKeys() {
    if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
    for (const k of ['VolumeUp', 'VolumeDown']) {
      try { tizen.tvinputdevice.registerKey(k); } catch { /* ignore */ }
    }
  }

  /** Give the TV keys back when the panel closes. */
  _unregisterTvKeys() {
    if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
    for (const k of ['VolumeUp', 'VolumeDown']) {
      try { tizen.tvinputdevice.unregisterKey(k); } catch { /* ignore */ }
    }
  }
}
