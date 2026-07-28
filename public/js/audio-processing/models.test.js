/**
 * Tests for audio processing models.
 * Run with: node --test public/js/audio-processing/models.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_FREQUENCIES,
  FREQUENCY_LABELS,
  GAIN_MIN,
  GAIN_MAX,
  SCHEMA_VERSION,
  createBand,
  createDefaultBands,
  createDefaultSettings,
  createDefaultNightMode,
  clampGain,
  validateSettings,
  computeSettingsHash,
  toServerPayload,
  isWithinNightWindow,
  computeEffectiveNow,
  AudioProcessingMode,
  NightModeIntensity,
  Controllability,
} from './models.js';

// ── Constants ──────────────────────────────────────────────────────

describe('Constants', () => {
  it('has 10 canonical frequencies', () => {
    assert.equal(CANONICAL_FREQUENCIES.length, 10);
    assert.equal(CANONICAL_FREQUENCIES[0], 31.25);
    assert.equal(CANONICAL_FREQUENCIES[9], 16000);
  });

  it('has matching labels', () => {
    assert.equal(FREQUENCY_LABELS.length, 10);
    assert.equal(FREQUENCY_LABELS[0], '31');
    assert.equal(FREQUENCY_LABELS[5], '1K');
    assert.equal(FREQUENCY_LABELS[9], '16K');
  });

  it('gain range is ±12 dB', () => {
    assert.equal(GAIN_MIN, -12);
    assert.equal(GAIN_MAX, 12);
  });
});

// ── Band Factory ───────────────────────────────────────────────────

describe('createBand', () => {
  it('creates a band with defaults', () => {
    const b = createBand(1000);
    assert.equal(b.frequency, 1000);
    assert.equal(b.gain, 0);
    assert.equal(b.q, 1.0);
  });

  it('clamps gain to ±12', () => {
    assert.equal(createBand(100, 20).gain, 12);
    assert.equal(createBand(100, -20).gain, -12);
  });

  it('handles NaN gain', () => {
    assert.equal(createBand(100, NaN).gain, 0);
  });
});

describe('createDefaultBands', () => {
  it('returns 10 bands at canonical frequencies', () => {
    const bands = createDefaultBands();
    assert.equal(bands.length, 10);
    bands.forEach((b, i) => {
      assert.equal(b.frequency, CANONICAL_FREQUENCIES[i]);
      assert.equal(b.gain, 0);
      assert.equal(b.q, 1.0);
    });
  });
});

// ── Night Mode ─────────────────────────────────────────────────────

describe('createDefaultNightMode', () => {
  it('returns disabled night mode with DRC defaults', () => {
    const nm = createDefaultNightMode();
    assert.equal(nm.enabled, false);
    assert.equal(nm.effectiveNow, false);
    assert.equal(nm.mode, AudioProcessingMode.DYNAMIC_RANGE_COMPRESSION);
    assert.equal(nm.intensity, NightModeIntensity.MEDIUM);
    assert.equal(nm.controllability, Controllability.APP_SCOPED);
    assert.equal(nm.scheduled, false);
    assert.equal(nm.nightStartTime, '22:00');
    assert.equal(nm.nightEndTime, '06:00');
  });
});

// ── Settings Factory ───────────────────────────────────────────────

describe('createDefaultSettings', () => {
  it('creates valid defaults', () => {
    const s = createDefaultSettings();
    assert.equal(s.schemaVersion, SCHEMA_VERSION);
    assert.equal(s.enabled, false);
    assert.equal(s.presetName, 'Flat');
    assert.equal(s.preampDb, 0);
    assert.equal(s.bands.length, 10);
    assert.equal(s.nightMode.enabled, false);
    assert.equal(s.settingsVersion, 0);
    assert.ok(typeof s.settingsHash === 'string');
    assert.ok(s.settingsHash.length > 0);
  });
});

// ── Gain Clamping ──────────────────────────────────────────────────

describe('clampGain', () => {
  it('passes valid values through', () => {
    assert.equal(clampGain(0), 0);
    assert.equal(clampGain(6.5), 6.5);
    assert.equal(clampGain(-6.5), -6.5);
  });

  it('clamps to bounds', () => {
    assert.equal(clampGain(15), 12);
    assert.equal(clampGain(-15), -12);
  });

  it('handles edge cases', () => {
    assert.equal(clampGain(NaN), 0);
    assert.equal(clampGain(undefined), 0);
    assert.equal(clampGain('not a number'), 0);
  });
});

// ── Validation ─────────────────────────────────────────────────────

describe('validateSettings', () => {
  it('returns defaults for null/undefined/garbage input', () => {
    const s1 = validateSettings(null);
    assert.equal(s1.schemaVersion, SCHEMA_VERSION);

    const s2 = validateSettings(undefined);
    assert.equal(s2.bands.length, 10);

    const s3 = validateSettings('garbage');
    assert.equal(s3.presetName, 'Flat');
  });

  it('preserves valid fields', () => {
    const input = {
      enabled: true,
      presetName: 'Rock',
      preampDb: 3.5,
      bands: CANONICAL_FREQUENCIES.map((f, i) => ({ frequency: f, gain: i, q: 1.0 })),
      nightMode: {
        enabled: true,
        effectiveNow: true,
        mode: 'LOUDNESS_LEVELING',
        intensity: 'HIGH',
        controllability: 'APP_SCOPED',
        scheduled: true,
        nightStartTime: '23:00',
        nightEndTime: '05:00',
      },
      settingsVersion: 5,
    };
    const out = validateSettings(input);
    assert.equal(out.enabled, true);
    assert.equal(out.presetName, 'Rock');
    assert.equal(out.preampDb, 3.5);
    assert.equal(out.bands[3].gain, 3);
    assert.equal(out.nightMode.enabled, true);
    assert.equal(out.nightMode.mode, 'LOUDNESS_LEVELING');
    assert.equal(out.nightMode.intensity, 'HIGH');
    assert.equal(out.nightMode.scheduled, true);
    assert.equal(out.nightMode.nightStartTime, '23:00');
    assert.equal(out.settingsVersion, 5);
  });

  it('clamps out-of-range gain', () => {
    const input = {
      preampDb: 99,
      bands: CANONICAL_FREQUENCIES.map(f => ({ frequency: f, gain: 20, q: 1.0 })),
    };
    const out = validateSettings(input);
    assert.equal(out.preampDb, 12);
    assert.equal(out.bands[0].gain, 12);
  });

  it('falls back for unknown enum values', () => {
    const input = {
      nightMode: {
        mode: 'INVALID_MODE',
        intensity: 'EXTREME',
        controllability: 'ALIEN_TECH',
      },
    };
    const out = validateSettings(input);
    assert.equal(out.nightMode.mode, 'DYNAMIC_RANGE_COMPRESSION');
    assert.equal(out.nightMode.intensity, 'MEDIUM');
    assert.equal(out.nightMode.controllability, 'APP_SCOPED');
  });

  it('always sets schemaVersion to current', () => {
    const out = validateSettings({ schemaVersion: 99 });
    assert.equal(out.schemaVersion, SCHEMA_VERSION);
  });
});

// ── Hash ───────────────────────────────────────────────────────────

describe('computeSettingsHash', () => {
  it('is deterministic', () => {
    const s1 = createDefaultSettings();
    const s2 = createDefaultSettings();
    assert.equal(computeSettingsHash(s1), computeSettingsHash(s2));
  });

  it('changes when a band gain changes', () => {
    const s1 = createDefaultSettings();
    const s2 = createDefaultSettings();
    s2.bands[3].gain = 6;
    assert.notEqual(computeSettingsHash(s1), computeSettingsHash(s2));
  });

  it('changes when preamp changes', () => {
    const s1 = createDefaultSettings();
    const s2 = createDefaultSettings();
    s2.preampDb = 3;
    assert.notEqual(computeSettingsHash(s1), computeSettingsHash(s2));
  });

  it('changes when night mode changes', () => {
    const s1 = createDefaultSettings();
    const s2 = createDefaultSettings();
    s2.nightMode.enabled = true;
    assert.notEqual(computeSettingsHash(s1), computeSettingsHash(s2));
  });

  it('returns 8-char hex string', () => {
    const hash = computeSettingsHash(createDefaultSettings());
    assert.match(hash, /^[0-9a-f]{8}$/);
  });
});

// ── Server Payload ─────────────────────────────────────────────────

describe('toServerPayload', () => {
  it('excludes schedule config', () => {
    const settings = createDefaultSettings();
    settings.nightMode.scheduled = true;
    settings.nightMode.nightStartTime = '23:00';
    settings.nightMode.nightEndTime = '05:00';

    const payload = toServerPayload(settings);
    assert.ok(!('scheduled' in payload.nightMode));
    assert.ok(!('nightStartTime' in payload.nightMode));
    assert.ok(!('nightEndTime' in payload.nightMode));
  });

  it('includes effectiveNow', () => {
    const settings = createDefaultSettings();
    settings.nightMode.effectiveNow = true;
    const payload = toServerPayload(settings);
    assert.equal(payload.nightMode.effectiveNow, true);
  });

  it('includes all band data', () => {
    const settings = createDefaultSettings();
    const payload = toServerPayload(settings);
    assert.equal(payload.bands.length, 10);
    assert.ok('frequency' in payload.bands[0]);
    assert.ok('gain' in payload.bands[0]);
  });
});

// ── Night Window ───────────────────────────────────────────────────

describe('isWithinNightWindow', () => {
  it('detects overnight window (22:00 → 06:00)', () => {
    // 23:00 → inside
    assert.equal(isWithinNightWindow('22:00', '06:00', new Date(2024, 0, 1, 23, 0)), true);
    // 01:00 → inside
    assert.equal(isWithinNightWindow('22:00', '06:00', new Date(2024, 0, 1, 1, 0)), true);
    // 12:00 → outside
    assert.equal(isWithinNightWindow('22:00', '06:00', new Date(2024, 0, 1, 12, 0)), false);
    // 06:00 → outside (end is exclusive)
    assert.equal(isWithinNightWindow('22:00', '06:00', new Date(2024, 0, 1, 6, 0)), false);
    // 22:00 → inside (start is inclusive)
    assert.equal(isWithinNightWindow('22:00', '06:00', new Date(2024, 0, 1, 22, 0)), true);
  });

  it('detects same-day window (08:00 → 17:00)', () => {
    assert.equal(isWithinNightWindow('08:00', '17:00', new Date(2024, 0, 1, 12, 0)), true);
    assert.equal(isWithinNightWindow('08:00', '17:00', new Date(2024, 0, 1, 20, 0)), false);
  });
});

describe('computeEffectiveNow', () => {
  it('returns false when disabled', () => {
    const nm = createDefaultNightMode();
    nm.enabled = false;
    assert.equal(computeEffectiveNow(nm), false);
  });

  it('returns true when enabled and not scheduled', () => {
    const nm = createDefaultNightMode();
    nm.enabled = true;
    nm.scheduled = false;
    assert.equal(computeEffectiveNow(nm), true);
  });

  it('returns based on schedule when scheduled', () => {
    const nm = createDefaultNightMode();
    nm.enabled = true;
    nm.scheduled = true;
    nm.nightStartTime = '22:00';
    nm.nightEndTime = '06:00';

    // 23:00 → effective
    assert.equal(computeEffectiveNow(nm, new Date(2024, 0, 1, 23, 0)), true);
    // 12:00 → not effective
    assert.equal(computeEffectiveNow(nm, new Date(2024, 0, 1, 12, 0)), false);
  });
});
