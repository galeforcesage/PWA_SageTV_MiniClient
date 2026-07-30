/**
 * Settings persistence for audio processing.
 *
 * Reads/writes AudioProcessingSettings to localStorage under a versioned key.
 * Handles schema migration for forward compatibility.
 *
 * @module audio-processing/settings-store
 */

import {
  SCHEMA_VERSION,
  createDefaultSettings,
  validateSettings,
  computeSettingsHash,
  computeEffectiveNow,
} from './models.js';

const STORAGE_KEY = 'sagetvng.audioProcessing.settings.v1';

export class SettingsStore {
  /**
   * @param {Storage} [storage]  Override for testing (defaults to localStorage)
   */
  constructor(storage) {
    this._storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this._settings = null;
  }

  /**
   * Load settings from storage. Returns validated settings (defaults on first use).
   * @returns {import('./models.js').AudioProcessingSettings}
   */
  load() {
    if (this._settings) return this._settings;

    if (!this._storage) {
      this._settings = createDefaultSettings();
      return this._settings;
    }

    try {
      const raw = this._storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this._settings = this._migrate(parsed);
      } else {
        this._settings = createDefaultSettings();
      }
    } catch {
      console.warn('[SettingsStore] Failed to load settings, using defaults');
      this._settings = createDefaultSettings();
    }

    return this._settings;
  }

  /**
   * Save current settings to storage.
   * Increments settingsVersion and recomputes hash.
   * @param {import('./models.js').AudioProcessingSettings} settings
   */
  save(settings) {
    settings.settingsVersion = (settings.settingsVersion || 0) + 1;
    settings.settingsHash = computeSettingsHash(settings);
    this._settings = settings;

    if (!this._storage) return;
    try {
      this._storage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('[SettingsStore] Failed to save settings:', e.message);
    }
  }

  /**
   * Get the current in-memory settings (loads from storage if needed).
   * @returns {import('./models.js').AudioProcessingSettings}
   */
  getCurrentSettings() {
    if (!this._settings) return this.load();
    return this._settings;
  }

  /**
   * Update the effectiveNow field based on current time.
   * Saves if the value changed.
   * @param {Date} [now]
   * @returns {boolean} True if effectiveNow changed
   */
  updateEffectiveNow(now = new Date()) {
    const settings = this.getCurrentSettings();
    const wasEffective = settings.nightMode.effectiveNow;
    settings.nightMode.effectiveNow = computeEffectiveNow(settings.nightMode, now);

    if (wasEffective !== settings.nightMode.effectiveNow) {
      this.save(settings);
      return true;
    }
    return false;
  }

  /**
   * Reset to defaults and save.
   * @returns {import('./models.js').AudioProcessingSettings}
   */
  reset() {
    this._settings = createDefaultSettings();
    this.save(this._settings);
    return this._settings;
  }

  /**
   * Migrate settings from older schema versions.
   * @param {Object} raw
   * @returns {import('./models.js').AudioProcessingSettings}
   */
  _migrate(raw) {
    if (!raw || typeof raw !== 'object') return createDefaultSettings();

    // Future migration hooks:
    // if (raw.schemaVersion < 2) { ... migrate v1 → v2 ... }

    return validateSettings(raw);
  }
}
