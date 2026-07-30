/**
 * Tests for audio processing settings store.
 * Run with: node --test public/js/audio-processing/settings-store.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SettingsStore } from './settings-store.js';
import {
  createDefaultSettings,
  SCHEMA_VERSION,
  CANONICAL_FREQUENCIES,
} from './models.js';

/**
 * In-memory localStorage mock for Node.js testing.
 */
class MockStorage {
  constructor() { this._data = new Map(); }
  getItem(key) { return this._data.get(key) ?? null; }
  setItem(key, value) { this._data.set(key, value); }
  removeItem(key) { this._data.delete(key); }
  clear() { this._data.clear(); }
}

// ── Load / Save ────────────────────────────────────────────────────

describe('SettingsStore', () => {
  let storage;
  let store;

  beforeEach(() => {
    storage = new MockStorage();
    store = new SettingsStore(storage);
  });

  describe('load', () => {
    it('returns defaults when storage is empty', () => {
      const s = store.load();
      assert.equal(s.schemaVersion, SCHEMA_VERSION);
      assert.equal(s.enabled, false);
      assert.equal(s.presetName, 'Flat');
      assert.equal(s.bands.length, 10);
    });

    it('loads previously saved settings', () => {
      const settings = createDefaultSettings();
      settings.enabled = true;
      settings.presetName = 'Rock';
      settings.preampDb = 3;
      settings.bands[0].gain = 5;
      store.save(settings);

      // Create new store to test loading from storage
      const store2 = new SettingsStore(storage);
      const loaded = store2.load();
      assert.equal(loaded.enabled, true);
      assert.equal(loaded.presetName, 'Rock');
      assert.equal(loaded.preampDb, 3);
      assert.equal(loaded.bands[0].gain, 5);
    });

    it('returns defaults for corrupted JSON', () => {
      storage.setItem('sagetvng.audioProcessing.settings.v1', '{bad json');
      const s = store.load();
      assert.equal(s.schemaVersion, SCHEMA_VERSION);
      assert.equal(s.bands.length, 10);
    });

    it('caches after first load', () => {
      const s1 = store.load();
      const s2 = store.load();
      assert.equal(s1, s2); // Same reference
    });
  });

  describe('save', () => {
    it('increments settingsVersion', () => {
      const s = store.load();
      assert.equal(s.settingsVersion, 0);
      store.save(s);
      assert.equal(s.settingsVersion, 1);
      store.save(s);
      assert.equal(s.settingsVersion, 2);
    });

    it('recomputes hash on save', () => {
      const s = store.load();
      const hash1 = s.settingsHash;
      s.bands[3].gain = 6;
      store.save(s);
      assert.notEqual(s.settingsHash, hash1);
    });

    it('persists to storage', () => {
      const s = store.load();
      s.presetName = 'Jazz';
      store.save(s);

      const raw = storage.getItem('sagetvng.audioProcessing.settings.v1');
      assert.ok(raw);
      const parsed = JSON.parse(raw);
      assert.equal(parsed.presetName, 'Jazz');
    });
  });

  describe('getCurrentSettings', () => {
    it('loads if not yet loaded', () => {
      const s = store.getCurrentSettings();
      assert.equal(s.schemaVersion, SCHEMA_VERSION);
    });

    it('returns cached settings after load', () => {
      const s1 = store.load();
      const s2 = store.getCurrentSettings();
      assert.equal(s1, s2);
    });
  });

  describe('reset', () => {
    it('resets to defaults and saves', () => {
      const s = store.load();
      s.enabled = true;
      s.presetName = 'Rock';
      s.bands[0].gain = 5;
      store.save(s);

      const reset = store.reset();
      assert.equal(reset.enabled, false);
      assert.equal(reset.presetName, 'Flat');
      assert.equal(reset.bands[0].gain, 0);
      // Check it was persisted
      assert.equal(reset.settingsVersion, 1); // Was incremented by save in reset
    });
  });

  describe('updateEffectiveNow', () => {
    it('returns false when nothing changed', () => {
      const s = store.load();
      s.nightMode.enabled = false;
      const changed = store.updateEffectiveNow();
      assert.equal(changed, false);
    });

    it('returns true when effectiveNow changes', () => {
      const s = store.load();
      s.nightMode.enabled = true;
      s.nightMode.scheduled = true;
      s.nightMode.nightStartTime = '22:00';
      s.nightMode.nightEndTime = '06:00';
      s.nightMode.effectiveNow = false;

      // 23:00 should make it effective
      const changed = store.updateEffectiveNow(new Date(2024, 0, 1, 23, 0));
      assert.equal(changed, true);
      assert.equal(s.nightMode.effectiveNow, true);
    });

    it('saves when changed', () => {
      const s = store.load();
      s.nightMode.enabled = true;
      s.nightMode.scheduled = true;
      s.nightMode.nightStartTime = '22:00';
      s.nightMode.nightEndTime = '06:00';
      s.nightMode.effectiveNow = false;
      store.save(s);
      const v1 = s.settingsVersion;

      store.updateEffectiveNow(new Date(2024, 0, 1, 23, 0));
      assert.ok(s.settingsVersion > v1);
    });
  });

  describe('migration', () => {
    it('migrates from partial settings', () => {
      // Simulate old format missing nightMode
      storage.setItem('sagetvng.audioProcessing.settings.v1', JSON.stringify({
        enabled: true,
        presetName: 'Rock',
        preampDb: 2,
        bands: CANONICAL_FREQUENCIES.map(f => ({ frequency: f, gain: 3, q: 1 })),
        settingsVersion: 5,
      }));

      const s = store.load();
      assert.equal(s.enabled, true);
      assert.equal(s.presetName, 'Rock');
      // Night mode should have been filled with defaults
      assert.equal(s.nightMode.enabled, false);
      assert.equal(s.nightMode.mode, 'DYNAMIC_RANGE_COMPRESSION');
      assert.equal(s.schemaVersion, SCHEMA_VERSION);
    });
  });

  describe('no storage available', () => {
    it('works without localStorage', () => {
      const noStore = new SettingsStore(null);
      const s = noStore.load();
      assert.equal(s.schemaVersion, SCHEMA_VERSION);
      // save should not throw
      s.enabled = true;
      noStore.save(s);
      assert.equal(s.settingsVersion, 1);
    });
  });
});
