/**
 * Tests for the passive AVPlay capability memory (on-device Tizen burn test).
 * Run with: node --test public/js/media/avplay-capability-memory.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AvplayCapabilityMemory,
  videoMimeToCapName,
  isCodecFailureReason,
} from './avplay-capability-memory.js';

/** In-memory localStorage stand-in. */
function makeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _dump: () => Object.fromEntries(map),
  };
}

const HEVC = { video: 'video/hevc', audio: 'audio/mp4a-latm', container: 'video/mp4' };
const H264 = { video: 'video/avc', audio: 'audio/mp4a-latm', container: 'video/mp4' };

describe('videoMimeToCapName', () => {
  it('maps known ng_fmt video MIME strings', () => {
    assert.equal(videoMimeToCapName('video/hevc'), 'HEVC');
    assert.equal(videoMimeToCapName('video/avc'), 'H264');
    assert.equal(videoMimeToCapName('video/mpeg2'), 'MPEG2-VIDEO');
    assert.equal(videoMimeToCapName('video/mp4v-es'), 'MPEG4-VIDEO');
  });
  it('is case-insensitive and trims', () => {
    assert.equal(videoMimeToCapName('  VIDEO/HEVC '), 'HEVC');
  });
  it('returns null for unknown/empty', () => {
    assert.equal(videoMimeToCapName('video/x-ms-wmv'), null);
    assert.equal(videoMimeToCapName(''), null);
    assert.equal(videoMimeToCapName(null), null);
  });
});

describe('isCodecFailureReason', () => {
  it('accepts only unambiguous AVPlay format rejections', () => {
    assert.equal(isCodecFailureReason('AVPLAY_PREPARE_ERROR'), true);
    assert.equal(isCodecFailureReason('AVPLAY_OPEN_ERROR'), true);
    // Runtime / mid-stream errors are ambiguous (transport) — excluded.
    assert.equal(isCodecFailureReason('AVPLAY_RUNTIME_ERROR'), false);
    assert.equal(isCodecFailureReason('AVPLAY_PLAY_ERROR'), false);
    assert.equal(isCodecFailureReason(undefined), false);
  });
});

describe('AvplayCapabilityMemory', () => {
  let storage;
  let mem;
  beforeEach(() => {
    storage = makeStorage();
    mem = new AvplayCapabilityMemory({ storage, deviceSig: 'ModelX|FW1', failThreshold: 2 });
  });

  it('does not blacklist before the fail threshold', () => {
    assert.equal(mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR'), false);
    assert.deepEqual(mem.getProvenBadVideo(), []);
  });

  it('blacklists a video codec after threshold failures', () => {
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    const blacklisted = mem.recordFailure(HEVC, 'AVPLAY_OPEN_ERROR');
    assert.equal(blacklisted, true);
    assert.deepEqual(mem.getProvenBadVideo(), ['HEVC']);
    assert.deepEqual(mem.getProvenBadNativeCaps(), { video: ['HEVC'], audio: [], containers: [] });
  });

  it('ignores non-codec failure reasons', () => {
    mem.recordFailure(HEVC, 'AVPLAY_RUNTIME_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_RUNTIME_ERROR');
    assert.deepEqual(mem.getProvenBadVideo(), []);
  });

  it('ignores failures for unmappable codecs (fail-safe)', () => {
    const wmv = { video: 'video/x-ms-wmv' };
    mem.recordFailure(wmv, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(wmv, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadVideo(), []);
  });

  it('success immunises a codec permanently against later failures', () => {
    mem.recordSuccess(HEVC);
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadVideo(), []);
  });

  it('success clears an existing blacklist (self-correcting)', () => {
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadVideo(), ['HEVC']);
    mem.recordSuccess(HEVC);
    assert.deepEqual(mem.getProvenBadVideo(), []);
  });

  it('never lets one codec affect another', () => {
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordSuccess(H264);
    assert.deepEqual(mem.getProvenBadVideo(), ['HEVC']);
  });

  it('persists across instances on the same device', () => {
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    const mem2 = new AvplayCapabilityMemory({ storage, deviceSig: 'ModelX|FW1', failThreshold: 2 });
    assert.deepEqual(mem2.getProvenBadVideo(), ['HEVC']);
  });

  it('resets learned state when the device signature changes (firmware upgrade)', () => {
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadVideo(), ['HEVC']);
    const upgraded = new AvplayCapabilityMemory({ storage, deviceSig: 'ModelX|FW2', failThreshold: 2 });
    assert.deepEqual(upgraded.getProvenBadVideo(), []);
  });

  it('reset() wipes state', () => {
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.reset();
    assert.deepEqual(mem.getProvenBadVideo(), []);
  });

  it('works with no storage (in-memory only, no throw)', () => {
    const nomem = new AvplayCapabilityMemory({ deviceSig: 'x', failThreshold: 1 });
    assert.equal(nomem.recordFailure(HEVC, 'AVPLAY_OPEN_ERROR'), true);
    assert.deepEqual(nomem.getProvenBadVideo(), ['HEVC']);
  });
});
