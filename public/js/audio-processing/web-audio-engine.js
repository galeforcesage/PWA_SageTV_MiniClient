/**
 * Web Audio equalizer engine.
 *
 * Manages an AudioContext with a chain of BiquadFilterNodes (peaking)
 * and a DynamicsCompressorNode for night mode. Attaches to the
 * HTMLVideoElement via createMediaElementSource().
 *
 * CRITICAL: createMediaElementSource() is one-shot per element. Once called,
 * audio MUST flow through the AudioContext. "Disable" means setting all gains
 * to 0 (flat pass-through), NOT disconnecting the graph.
 *
 * @module audio-processing/web-audio-engine
 */

import {
  CANONICAL_FREQUENCIES,
  GAIN_MIN,
  GAIN_MAX,
  clampGain,
  NightModeIntensity,
} from './models.js';

/** DynamicsCompressor presets per night mode intensity. */
const COMPRESSOR_PRESETS = Object.freeze({
  LOW:    { threshold: -18, ratio: 4,  knee: 10, attack: 0.01,  release: 0.15 },
  MEDIUM: { threshold: -24, ratio: 8,  knee: 15, attack: 0.005, release: 0.1  },
  HIGH:   { threshold: -30, ratio: 12, knee: 20, attack: 0.003, release: 0.05 },
});

/** Pass-through compressor settings (effectively bypassed). */
const COMPRESSOR_BYPASS = Object.freeze({
  threshold: 0, ratio: 1, knee: 0, attack: 0.003, release: 0.25,
});

/**
 * Convert decibels to linear gain.
 * @param {number} db
 * @returns {number}
 */
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

export class WebAudioEngine extends EventTarget {
  constructor() {
    super();
    /** @type {AudioContext|null} */
    this._audioCtx = null;
    /** @type {MediaElementAudioSourceNode|null} */
    this._source = null;
    /** @type {GainNode|null} */
    this._preamp = null;
    /** @type {BiquadFilterNode[]} */
    this._filters = [];
    /** @type {DynamicsCompressorNode|null} */
    this._compressor = null;
    /** @type {boolean} Whether the graph has been attached to a video element */
    this._attached = false;
    /** @type {boolean} Whether EQ is currently enabled (gains applied) */
    this._eqEnabled = false;
    /** @type {boolean} Whether night mode compressor is active */
    this._nightModeActive = false;
  }

  /**
   * Is the audio graph attached and processing?
   * @returns {boolean}
   */
  isAttached() {
    return this._attached;
  }

  /**
   * Is EQ actively applying non-flat gains?
   * @returns {boolean}
   */
  isActive() {
    return this._attached && this._eqEnabled;
  }

  /**
   * Is night mode compressor active?
   * @returns {boolean}
   */
  isNightModeActive() {
    return this._attached && this._nightModeActive;
  }

  /**
   * Attach the audio graph to a video element.
   * Creates the AudioContext and full signal chain on first call.
   * Subsequent calls are no-ops (one-shot createMediaElementSource).
   *
   * @param {HTMLVideoElement} videoElement
   * @param {import('./models.js').AudioProcessingSettings} settings
   * @returns {boolean} True if successfully attached
   */
  attach(videoElement, settings) {
    if (this._attached) {
      // Already attached — just apply settings
      this.applySettings(settings);
      return true;
    }

    if (!videoElement) {
      console.warn('[WebAudioEngine] No video element provided');
      return false;
    }

    try {
      // Feature detection
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('[WebAudioEngine] Web Audio API not available');
        return false;
      }

      this._audioCtx = new AudioContextClass();

      // Source: video element → AudioContext
      this._source = this._audioCtx.createMediaElementSource(videoElement);

      // Preamp gain node
      this._preamp = this._audioCtx.createGain();
      this._preamp.gain.value = dbToLinear(clampGain(settings.preampDb));

      // 10 peaking EQ filters
      this._filters = CANONICAL_FREQUENCIES.map((freq, i) => {
        const f = this._audioCtx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = freq;
        f.Q.value = settings.bands[i]?.q || 1.0;
        f.gain.value = clampGain(settings.bands[i]?.gain || 0);
        return f;
      });

      // DynamicsCompressor for night mode
      this._compressor = this._audioCtx.createDynamicsCompressor();
      this._applyCompressorSettings(COMPRESSOR_BYPASS);

      // Chain: source → preamp → filters[0..9] → compressor → destination
      this._source.connect(this._preamp);
      let prev = this._preamp;
      for (const f of this._filters) {
        prev.connect(f);
        prev = f;
      }
      prev.connect(this._compressor);
      this._compressor.connect(this._audioCtx.destination);

      this._attached = true;
      this._eqEnabled = settings.enabled;

      // Apply night mode if enabled
      if (settings.nightMode?.enabled && settings.nightMode?.effectiveNow) {
        this._applyNightMode(settings.nightMode.intensity);
      }

      // If EQ is disabled, set flat pass-through
      if (!settings.enabled) {
        this._setFlat();
      }

      console.log('[WebAudioEngine] Audio graph attached successfully');
      this._emitStateChange();
      return true;
    } catch (e) {
      console.error('[WebAudioEngine] Failed to attach:', e);
      this._cleanup();
      return false;
    }
  }

  /**
   * Apply settings to the existing audio graph.
   * @param {import('./models.js').AudioProcessingSettings} settings
   */
  applySettings(settings) {
    if (!this._attached) return;

    this._eqEnabled = settings.enabled;

    if (settings.enabled) {
      // Apply preamp
      if (this._preamp) {
        this._preamp.gain.value = dbToLinear(clampGain(settings.preampDb));
      }
      // Apply band gains
      this._filters.forEach((f, i) => {
        if (settings.bands[i]) {
          f.gain.value = clampGain(settings.bands[i].gain);
          if (settings.bands[i].q > 0) {
            f.Q.value = settings.bands[i].q;
          }
        }
      });
    } else {
      this._setFlat();
    }

    // Night mode
    if (settings.nightMode?.enabled && settings.nightMode?.effectiveNow) {
      this._applyNightMode(settings.nightMode.intensity);
    } else {
      this._bypassNightMode();
    }

    this._emitStateChange();
  }

  /**
   * Update a single band's gain (for real-time slider interaction).
   * @param {number} bandIndex  0-9
   * @param {number} gainDb     ±12 dB
   */
  updateBand(bandIndex, gainDb) {
    if (!this._attached || bandIndex < 0 || bandIndex >= this._filters.length) return;
    this._filters[bandIndex].gain.value = clampGain(gainDb);
  }

  /**
   * Update preamp gain.
   * @param {number} db  ±12 dB
   */
  updatePreamp(db) {
    if (!this._attached || !this._preamp) return;
    this._preamp.gain.value = dbToLinear(clampGain(db));
  }

  /**
   * Suspend the AudioContext (on page hidden).
   * Saves CPU while backgrounded.
   */
  async suspend() {
    if (this._audioCtx && this._audioCtx.state === 'running') {
      try {
        await this._audioCtx.suspend();
        console.log('[WebAudioEngine] AudioContext suspended');
        this._emitStateChange();
      } catch (e) {
        console.warn('[WebAudioEngine] Suspend failed:', e);
      }
    }
  }

  /**
   * Resume the AudioContext (on page visible).
   */
  async resume() {
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      try {
        await this._audioCtx.resume();
        console.log('[WebAudioEngine] AudioContext resumed');
        this._emitStateChange();
      } catch (e) {
        console.warn('[WebAudioEngine] Resume failed:', e);
      }
    }
  }

  /**
   * Get the current AudioContext state.
   * @returns {string|null} 'running', 'suspended', 'closed', or null
   */
  getState() {
    return this._audioCtx ? this._audioCtx.state : null;
  }

  /**
   * Clean up all resources. After this, a new engine instance is needed.
   */
  destroy() {
    this._cleanup();
  }

  // ── Internal ───────────────────────────────────────────────────

  /** Set all gains to 0 (flat pass-through). */
  _setFlat() {
    if (this._preamp) this._preamp.gain.value = 1.0; // 0 dB = unity
    this._filters.forEach(f => { f.gain.value = 0; });
  }

  /** Apply night mode compressor at the given intensity. */
  _applyNightMode(intensity) {
    const preset = COMPRESSOR_PRESETS[intensity] || COMPRESSOR_PRESETS.MEDIUM;
    this._applyCompressorSettings(preset);
    this._nightModeActive = true;
  }

  /** Bypass the compressor (pass-through). */
  _bypassNightMode() {
    this._applyCompressorSettings(COMPRESSOR_BYPASS);
    this._nightModeActive = false;
  }

  /** Apply settings to the DynamicsCompressorNode. */
  _applyCompressorSettings(preset) {
    if (!this._compressor) return;
    const c = this._compressor;
    c.threshold.value = preset.threshold;
    c.ratio.value = preset.ratio;
    c.knee.value = preset.knee;
    c.attack.value = preset.attack;
    c.release.value = preset.release;
  }

  /** Emit a state change event. */
  _emitStateChange() {
    this.dispatchEvent(new CustomEvent('statechange', {
      detail: {
        attached: this._attached,
        eqActive: this.isActive(),
        nightModeActive: this._nightModeActive,
        audioContextState: this.getState(),
      },
    }));
  }

  /** Release all audio resources. */
  _cleanup() {
    if (this._audioCtx) {
      try { this._audioCtx.close(); } catch { /* ignore */ }
    }
    this._audioCtx = null;
    this._source = null;
    this._preamp = null;
    this._filters = [];
    this._compressor = null;
    this._attached = false;
    this._eqEnabled = false;
    this._nightModeActive = false;
  }
}
