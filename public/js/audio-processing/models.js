/**
 * Audio Processing canonical models.
 *
 * Defines the shared data types for equalizer settings, night mode,
 * capabilities, and DSP state. These models are the single source of
 * truth for both local persistence and server protocol payloads.
 *
 * @module audio-processing/models
 */

// ── Enums ──────────────────────────────────────────────────────────

/** @enum {string} */
export const AudioProcessingMode = Object.freeze({
  DYNAMIC_RANGE_COMPRESSION: 'DYNAMIC_RANGE_COMPRESSION',
  LOUDNESS_LEVELING: 'LOUDNESS_LEVELING',
  PLATFORM_NIGHT_MODE: 'PLATFORM_NIGHT_MODE',
});

/** @enum {string} */
export const NightModeIntensity = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});

/** @enum {string} */
export const Controllability = Object.freeze({
  APP_SCOPED: 'APP_SCOPED',
  OS_SCOPED: 'OS_SCOPED',
  VENDOR_SCOPED: 'VENDOR_SCOPED',
  EXTERNAL_ADVISORY: 'EXTERNAL_ADVISORY',
});

// ── Canonical Frequencies ──────────────────────────────────────────

/** The 10-band canonical frequency set (Hz), matching af_equalizer.c. */
export const CANONICAL_FREQUENCIES = Object.freeze([
  31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
]);

/** Short display labels for each band. */
export const FREQUENCY_LABELS = Object.freeze([
  '31', '63', '125', '250', '500', '1K', '2K', '4K', '8K', '16K',
]);

/** Gain limits (dB). */
export const GAIN_MIN = -12;
export const GAIN_MAX = 12;
export const GAIN_STEP = 0.5;

/** Current schema version for stored settings. */
export const SCHEMA_VERSION = 1;

// ── Band Factory ───────────────────────────────────────────────────

/**
 * @typedef {Object} EqualizerBand
 * @property {number} frequency  Center frequency in Hz
 * @property {number} gain       Boost/cut in dB (±12)
 * @property {number} q          Quality factor (bandwidth)
 */

/**
 * Create a single band with defaults.
 * @param {number} frequency
 * @param {number} [gain=0]
 * @param {number} [q=1.0]
 * @returns {EqualizerBand}
 */
export function createBand(frequency, gain = 0, q = 1.0) {
  return { frequency, gain: clampGain(gain), q };
}

/**
 * Create the default 10-band set (all gains 0 dB).
 * @returns {EqualizerBand[]}
 */
export function createDefaultBands() {
  return CANONICAL_FREQUENCIES.map(f => createBand(f));
}

// ── Night Mode Factory ─────────────────────────────────────────────

/**
 * @typedef {Object} NightModeSettings
 * @property {boolean}  enabled
 * @property {boolean}  effectiveNow   Computed: is night mode active right now?
 * @property {string}   mode           AudioProcessingMode value
 * @property {string}   intensity      NightModeIntensity value
 * @property {string}   controllability Controllability value
 * @property {boolean}  scheduled      Use time-based auto-enable
 * @property {string}   nightStartTime 24h "HH:MM" format
 * @property {string}   nightEndTime   24h "HH:MM" format
 */

/**
 * Create default night mode settings.
 * @returns {NightModeSettings}
 */
export function createDefaultNightMode() {
  return {
    enabled: false,
    effectiveNow: false,
    mode: AudioProcessingMode.DYNAMIC_RANGE_COMPRESSION,
    intensity: NightModeIntensity.MEDIUM,
    controllability: Controllability.APP_SCOPED,
    scheduled: false,
    nightStartTime: '22:00',
    nightEndTime: '06:00',
  };
}

// ── Settings Factory ───────────────────────────────────────────────

/**
 * @typedef {Object} AudioProcessingSettings
 * @property {number}            schemaVersion
 * @property {boolean}           enabled
 * @property {string}            presetName
 * @property {number}            preampDb
 * @property {EqualizerBand[]}   bands
 * @property {NightModeSettings} nightMode
 * @property {number}            settingsVersion  Increments on every save
 * @property {string}            settingsHash     Deterministic hash of audible state
 */

/**
 * Create default settings (Flat preset, all gains 0, night mode off).
 * @returns {AudioProcessingSettings}
 */
export function createDefaultSettings() {
  const settings = {
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    clientProcessing: true,
    presetName: 'Flat',
    preampDb: 0,
    bands: createDefaultBands(),
    nightMode: createDefaultNightMode(),
    settingsVersion: 0,
    settingsHash: '',
  };
  settings.settingsHash = computeSettingsHash(settings);
  return settings;
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Clamp a gain value to the valid range.
 * @param {number} gain
 * @returns {number}
 */
export function clampGain(gain) {
  if (typeof gain !== 'number' || Number.isNaN(gain)) return 0;
  return Math.max(GAIN_MIN, Math.min(GAIN_MAX, gain));
}

/**
 * Validate and sanitise settings. Returns a clean copy.
 * Unknown fields are dropped; missing fields get defaults.
 * @param {Object} raw
 * @returns {AudioProcessingSettings}
 */
export function validateSettings(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultSettings();

  const defaults = createDefaultSettings();
  const out = { ...defaults };

  out.schemaVersion = SCHEMA_VERSION;
  out.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : false;
  out.clientProcessing = typeof raw.clientProcessing === 'boolean' ? raw.clientProcessing : true;
  out.presetName = typeof raw.presetName === 'string' ? raw.presetName : 'Flat';
  out.preampDb = clampGain(typeof raw.preampDb === 'number' ? raw.preampDb : 0);

  // Bands
  if (Array.isArray(raw.bands) && raw.bands.length === CANONICAL_FREQUENCIES.length) {
    out.bands = CANONICAL_FREQUENCIES.map((freq, i) => {
      const b = raw.bands[i];
      return createBand(
        freq,
        b && typeof b.gain === 'number' ? b.gain : 0,
        b && typeof b.q === 'number' && b.q > 0 ? b.q : 1.0,
      );
    });
  }

  // Night mode
  if (raw.nightMode && typeof raw.nightMode === 'object') {
    const nm = raw.nightMode;
    out.nightMode = {
      enabled: typeof nm.enabled === 'boolean' ? nm.enabled : false,
      effectiveNow: typeof nm.effectiveNow === 'boolean' ? nm.effectiveNow : false,
      mode: Object.values(AudioProcessingMode).includes(nm.mode)
        ? nm.mode
        : AudioProcessingMode.DYNAMIC_RANGE_COMPRESSION,
      intensity: Object.values(NightModeIntensity).includes(nm.intensity)
        ? nm.intensity
        : NightModeIntensity.MEDIUM,
      controllability: Object.values(Controllability).includes(nm.controllability)
        ? nm.controllability
        : Controllability.APP_SCOPED,
      scheduled: typeof nm.scheduled === 'boolean' ? nm.scheduled : false,
      nightStartTime: isValidTime(nm.nightStartTime) ? nm.nightStartTime : '22:00',
      nightEndTime: isValidTime(nm.nightEndTime) ? nm.nightEndTime : '06:00',
    };
  }

  out.settingsVersion = typeof raw.settingsVersion === 'number'
    ? Math.max(0, Math.floor(raw.settingsVersion))
    : 0;

  out.settingsHash = computeSettingsHash(out);
  return out;
}

// ── Hash ───────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash of the audible state (bands, preamp, night mode).
 * Uses a simple string-based hash for change detection, not crypto.
 * @param {AudioProcessingSettings} settings
 * @returns {string} 8-char hex hash
 */
export function computeSettingsHash(settings) {
  const parts = [
    settings.preampDb.toFixed(1),
    ...settings.bands.map(b => `${b.frequency}:${b.gain.toFixed(1)}:${b.q.toFixed(1)}`),
    settings.nightMode.enabled ? '1' : '0',
    settings.nightMode.mode,
    settings.nightMode.intensity,
  ];
  const str = parts.join('|');
  return hashString(str);
}

/**
 * Build the server-facing settings payload (excludes client-only schedule config).
 * @param {AudioProcessingSettings} settings
 * @returns {Object}
 */
export function toServerPayload(settings) {
  return {
    schemaVersion: settings.schemaVersion,
    enabled: settings.enabled,
    clientProcessing: settings.clientProcessing !== false,
    presetName: settings.presetName,
    preampDb: settings.preampDb,
    bands: settings.bands.map(b => ({ frequency: b.frequency, gain: b.gain, q: b.q })),
    nightMode: {
      enabled: settings.nightMode.enabled,
      effectiveNow: settings.nightMode.effectiveNow,
      mode: settings.nightMode.mode,
      intensity: settings.nightMode.intensity,
    },
    settingsVersion: settings.settingsVersion,
    settingsHash: settings.settingsHash,
  };
}

// ── Night Mode Schedule ────────────────────────────────────────────

/**
 * Check if the current local time falls within the night mode window.
 * Handles overnight spans (e.g., 22:00 → 06:00).
 * @param {string} startTime  "HH:MM" format
 * @param {string} endTime    "HH:MM" format
 * @param {Date}   [now]      Override for testing
 * @returns {boolean}
 */
export function isWithinNightWindow(startTime, endTime, now = new Date()) {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);

  if (start <= end) {
    // Same-day window (e.g., 08:00 → 17:00)
    return current >= start && current < end;
  }
  // Overnight window (e.g., 22:00 → 06:00)
  return current >= start || current < end;
}

/**
 * Compute the effectiveNow field based on schedule settings and current time.
 * @param {NightModeSettings} nightMode
 * @param {Date} [now]
 * @returns {boolean}
 */
export function computeEffectiveNow(nightMode, now = new Date()) {
  if (!nightMode.enabled) return false;
  if (!nightMode.scheduled) return true; // Manual mode: always on when enabled
  return isWithinNightWindow(nightMode.nightStartTime, nightMode.nightEndTime, now);
}

// ── Helpers (internal) ─────────────────────────────────────────────

/** Parse "HH:MM" to minutes since midnight. */
function parseTimeToMinutes(time) {
  if (!isValidTime(time)) return 0;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Validate "HH:MM" format. */
function isValidTime(time) {
  if (typeof time !== 'string') return false;
  return /^\d{1,2}:\d{2}$/.test(time);
}

/**
 * Simple non-crypto string hash (djb2 variant).
 * @param {string} str
 * @returns {string} 8-char hex
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
