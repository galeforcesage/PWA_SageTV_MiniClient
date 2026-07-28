/**
 * Audio processing capability reporter.
 *
 * Probes the runtime environment to determine whether client-side DSP
 * (Web Audio) is available for the current playback path.
 *
 * @module audio-processing/capability-reporter
 */

import { Controllability } from './models.js';

export class CapabilityReporter {
  /**
   * @param {Object} options
   * @param {Object} [options.platformDetector]  PlatformDetector instance
   */
  constructor({ platformDetector } = {}) {
    this._platform = platformDetector || null;
    this._cachedCapabilities = null;
  }

  /**
   * Get the current capabilities payload.
   * @param {string} [playbackPath]  Current playback path: 'html5_video', 'html5_mse', 'avplay'
   * @returns {Object}
   */
  getCapabilities(playbackPath) {
    const isTizen = this._isTizen();
    const webAudioAvailable = this._probeWebAudio();
    const isAvplay = playbackPath === 'avplay';

    // AVPlay: cannot do client DSP (audio pipeline outside browser scope)
    const supportsClientDsp = webAudioAvailable && !isAvplay;

    const clientKind = isTizen ? 'PWA_TIZEN' : 'PWA_BROWSER';

    return {
      clientKind,
      supportsClientDsp,
      playbackPath: playbackPath || (isTizen ? 'avplay' : 'html5_video'),
      engineType: supportsClientDsp ? 'WebAudio_BiquadFilter' : 'none',
      needsServerDsp: !supportsClientDsp,
      supportedBands: 10,
      gainRangeDb: [-12, 12],
      supportsPreamp: supportsClientDsp,
      supportsNightMode: supportsClientDsp,
      nightModeControllability: supportsClientDsp
        ? Controllability.APP_SCOPED
        : (isTizen ? Controllability.VENDOR_SCOPED : Controllability.APP_SCOPED),
    };
  }

  /**
   * Probe whether Web Audio API is available in this runtime.
   * @returns {boolean}
   */
  _probeWebAudio() {
    try {
      return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Check if running on Tizen.
   * @returns {boolean}
   */
  _isTizen() {
    if (this._platform && typeof this._platform.isTizen === 'function') {
      return this._platform.isTizen();
    }
    try {
      return typeof window !== 'undefined' && typeof window.tizen !== 'undefined';
    } catch {
      return false;
    }
  }
}
