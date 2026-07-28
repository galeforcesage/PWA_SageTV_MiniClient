/**
 * Built-in equalizer presets.
 *
 * Each preset returns a 10-element gain array (dB) matching the canonical
 * frequency set in models.js. Preamp is always 0 for presets (user adjusts).
 *
 * @module audio-processing/presets
 */

import { CANONICAL_FREQUENCIES, createBand } from './models.js';

/**
 * @typedef {Object} Preset
 * @property {string}   name    Display name
 * @property {number[]} gains   10-element array of gain values (dB)
 * @property {number}   preamp  Preamp dB (always 0 for built-in presets)
 */

/** @type {Preset[]} */
export const PRESETS = Object.freeze([
  {
    name: 'Flat',
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preamp: 0,
  },
  {
    name: 'Rock',
    gains: [5, 4, 3, -1, -2, -1, 2, 3, 4, 4],
    preamp: 0,
  },
  {
    name: 'Pop',
    gains: [1, 2, 3, 2, 0, -1, 0, 2, 3, 3],
    preamp: 0,
  },
  {
    name: 'Jazz',
    gains: [3, 2, 1, 2, 3, 2, 1, 0, -1, -2],
    preamp: 0,
  },
  {
    name: 'Classical',
    gains: [4, 3, 1, 0, 0, 0, 1, 2, 3, 4],
    preamp: 0,
  },
  {
    name: 'Bass Boost',
    gains: [8, 6, 4, 2, 0, 0, 0, 0, 0, 0],
    preamp: 0,
  },
  {
    name: 'Treble Boost',
    gains: [0, 0, 0, 0, 0, 1, 2, 4, 6, 8],
    preamp: 0,
  },
  {
    name: 'Vocal',
    gains: [-2, -1, 1, 3, 4, 4, 3, 1, -1, -2],
    preamp: 0,
  },
  {
    name: 'Loudness',
    gains: [6, 4, 1, -1, -2, -1, 1, 3, 5, 6],
    preamp: 0,
  },
  {
    name: 'Custom',
    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preamp: 0,
  },
]);

/**
 * Get a preset by name (case-insensitive).
 * @param {string} name
 * @returns {Preset|null}
 */
export function getPreset(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return PRESETS.find(p => p.name.toLowerCase() === lower) || null;
}

/**
 * Get all preset names (for UI dropdown).
 * @returns {string[]}
 */
export function getPresetNames() {
  return PRESETS.map(p => p.name);
}

/**
 * Apply a preset's gains to a bands array, returning new bands.
 * @param {string} presetName
 * @returns {{ bands: import('./models.js').EqualizerBand[], preamp: number }|null}
 */
export function applyPreset(presetName) {
  const preset = getPreset(presetName);
  if (!preset) return null;
  const bands = CANONICAL_FREQUENCIES.map((freq, i) =>
    createBand(freq, preset.gains[i]),
  );
  return { bands, preamp: preset.preamp };
}

/**
 * Detect which preset (if any) matches the current band gains.
 * Returns 'Custom' if no built-in preset matches.
 * @param {import('./models.js').EqualizerBand[]} bands
 * @param {number} preampDb
 * @returns {string}
 */
export function detectPreset(bands, preampDb) {
  if (!bands || bands.length !== CANONICAL_FREQUENCIES.length) return 'Custom';

  for (const preset of PRESETS) {
    if (preset.name === 'Custom') continue;
    let match = true;
    for (let i = 0; i < bands.length; i++) {
      if (Math.abs(bands[i].gain - preset.gains[i]) > 0.01) {
        match = false;
        break;
      }
    }
    if (match && Math.abs(preampDb - preset.preamp) < 0.01) {
      return preset.name;
    }
  }
  return 'Custom';
}
