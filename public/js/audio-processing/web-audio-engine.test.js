/**
 * Tests for Web Audio equalizer engine.
 * Run with: node --test public/js/audio-processing/web-audio-engine.test.js
 *
 * These tests use lightweight mocks for AudioContext and HTMLVideoElement
 * since node:test runs in Node.js (no real Web Audio).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WebAudioEngine } from './web-audio-engine.js';
import { createDefaultSettings, CANONICAL_FREQUENCIES } from './models.js';

// ── Mocks ──────────────────────────────────────────────────────────

class MockAudioParam {
  constructor(defaultValue = 0) { this.value = defaultValue; }
}

class MockGainNode {
  constructor() { this.gain = new MockAudioParam(1); this._connections = []; }
  connect(dest) { this._connections.push(dest); return dest; }
}

class MockBiquadFilterNode {
  constructor() {
    this.type = '';
    this.frequency = new MockAudioParam(0);
    this.Q = new MockAudioParam(1);
    this.gain = new MockAudioParam(0);
    this._connections = [];
  }
  connect(dest) { this._connections.push(dest); return dest; }
}

class MockDynamicsCompressorNode {
  constructor() {
    this.threshold = new MockAudioParam(-24);
    this.ratio = new MockAudioParam(12);
    this.knee = new MockAudioParam(30);
    this.attack = new MockAudioParam(0.003);
    this.release = new MockAudioParam(0.25);
    this._connections = [];
  }
  connect(dest) { this._connections.push(dest); return dest; }
}

class MockMediaElementSourceNode {
  constructor() { this._connections = []; }
  connect(dest) { this._connections.push(dest); return dest; }
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = { __dest: true };
    this._closed = false;
  }
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createMediaElementSource() { return new MockMediaElementSourceNode(); }
  async suspend() { this.state = 'suspended'; }
  async resume() { this.state = 'running'; }
  close() { this.state = 'closed'; this._closed = true; }
}

class MockVideoElement {}

// Install mock AudioContext globally for the engine to find
function installMocks() {
  globalThis.window = globalThis.window || {};
  globalThis.window.AudioContext = MockAudioContext;
}

function cleanupMocks() {
  if (globalThis.window) {
    delete globalThis.window.AudioContext;
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('WebAudioEngine', () => {
  let engine;

  beforeEach(() => {
    installMocks();
    engine = new WebAudioEngine();
  });

  describe('initial state', () => {
    it('starts unattached', () => {
      assert.equal(engine.isAttached(), false);
      assert.equal(engine.isActive(), false);
      assert.equal(engine.isNightModeActive(), false);
      assert.equal(engine.getState(), null);
    });
  });

  describe('attach', () => {
    it('attaches to a video element with default settings', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      const result = engine.attach(video, settings);
      assert.equal(result, true);
      assert.equal(engine.isAttached(), true);
      assert.equal(engine.getState(), 'running');
    });

    it('returns false with no video element', () => {
      const settings = createDefaultSettings();
      assert.equal(engine.attach(null, settings), false);
      assert.equal(engine.isAttached(), false);
    });

    it('returns false when Web Audio is unavailable', () => {
      cleanupMocks();
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      assert.equal(engine.attach(video, settings), false);
      installMocks(); // Restore for other tests
    });

    it('is idempotent (second attach just applies settings)', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      engine.attach(video, settings);

      // Second attach with different settings
      const settings2 = createDefaultSettings();
      settings2.enabled = true;
      settings2.bands[3].gain = 6;
      const result = engine.attach(video, settings2);
      assert.equal(result, true);
      assert.equal(engine.isAttached(), true);
    });
  });

  describe('applySettings', () => {
    it('sets flat pass-through when disabled', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      settings.bands[0].gain = 5;
      engine.attach(video, settings);

      // Now disable
      settings.enabled = false;
      engine.applySettings(settings);
      assert.equal(engine.isActive(), false);
    });

    it('applies gains when enabled', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      settings.preampDb = 3;
      settings.bands[0].gain = 5;
      engine.attach(video, settings);
      assert.equal(engine.isActive(), true);
    });

    it('does nothing when not attached', () => {
      const settings = createDefaultSettings();
      // Should not throw
      engine.applySettings(settings);
      assert.equal(engine.isActive(), false);
    });
  });

  describe('updateBand', () => {
    it('updates a single band gain', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      engine.attach(video, settings);
      // Should not throw
      engine.updateBand(0, 6);
      engine.updateBand(9, -6);
    });

    it('clamps out-of-range gain', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      engine.attach(video, settings);
      engine.updateBand(0, 20); // Should be clamped to 12
    });

    it('ignores invalid index', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      engine.attach(video, settings);
      engine.updateBand(-1, 5); // Should not throw
      engine.updateBand(99, 5); // Should not throw
    });
  });

  describe('updatePreamp', () => {
    it('updates preamp gain', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      engine.attach(video, settings);
      engine.updatePreamp(6);
    });

    it('does nothing when not attached', () => {
      engine.updatePreamp(6); // Should not throw
    });
  });

  describe('night mode', () => {
    it('activates night mode compressor', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      settings.nightMode.enabled = true;
      settings.nightMode.effectiveNow = true;
      settings.nightMode.intensity = 'HIGH';
      engine.attach(video, settings);
      assert.equal(engine.isNightModeActive(), true);
    });

    it('bypasses compressor when night mode disabled', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      settings.nightMode.enabled = false;
      engine.attach(video, settings);
      assert.equal(engine.isNightModeActive(), false);
    });

    it('bypasses compressor when not effectiveNow', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      settings.nightMode.enabled = true;
      settings.nightMode.effectiveNow = false;
      engine.attach(video, settings);
      assert.equal(engine.isNightModeActive(), false);
    });

    it('toggles night mode via applySettings', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      settings.enabled = true;
      engine.attach(video, settings);
      assert.equal(engine.isNightModeActive(), false);

      settings.nightMode.enabled = true;
      settings.nightMode.effectiveNow = true;
      engine.applySettings(settings);
      assert.equal(engine.isNightModeActive(), true);

      settings.nightMode.effectiveNow = false;
      engine.applySettings(settings);
      assert.equal(engine.isNightModeActive(), false);
    });
  });

  describe('suspend / resume', () => {
    it('suspends and resumes the AudioContext', async () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      engine.attach(video, settings);
      assert.equal(engine.getState(), 'running');

      await engine.suspend();
      assert.equal(engine.getState(), 'suspended');

      await engine.resume();
      assert.equal(engine.getState(), 'running');
    });

    it('does nothing when not attached', async () => {
      await engine.suspend(); // Should not throw
      await engine.resume();  // Should not throw
    });
  });

  describe('statechange events', () => {
    it('emits statechange on attach', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      let event = null;
      engine.addEventListener('statechange', e => { event = e; });
      engine.attach(video, settings);
      assert.ok(event);
      assert.equal(event.detail.attached, true);
    });

    it('emits statechange on applySettings', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      engine.attach(video, settings);

      let event = null;
      engine.addEventListener('statechange', e => { event = e; });
      settings.enabled = true;
      engine.applySettings(settings);
      assert.ok(event);
      assert.equal(event.detail.eqActive, true);
    });
  });

  describe('destroy', () => {
    it('cleans up all state', () => {
      const video = new MockVideoElement();
      const settings = createDefaultSettings();
      engine.attach(video, settings);
      assert.equal(engine.isAttached(), true);

      engine.destroy();
      assert.equal(engine.isAttached(), false);
      assert.equal(engine.isActive(), false);
      assert.equal(engine.getState(), null);
    });
  });
});
