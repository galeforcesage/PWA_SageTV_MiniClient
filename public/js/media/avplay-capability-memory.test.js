/**
 * Tests for the passive AVPlay capability memory (on-device Tizen burn test).
 * Run with: node --test public/js/media/avplay-capability-memory.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AvplayCapabilityMemory,
  videoMimeToCapName,
  audioMimeToCapName,
  containerMimeToCapName,
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

describe('audioMimeToCapName / containerMimeToCapName', () => {
  it('maps known ng_fmt audio MIME strings', () => {
    assert.equal(audioMimeToCapName('audio/mp4a-latm'), 'AAC');
    assert.equal(audioMimeToCapName('audio/ac3'), 'AC3');
    assert.equal(audioMimeToCapName('audio/eac3'), 'EAC3');
    assert.equal(audioMimeToCapName('audio/ac4'), 'AC4');
    assert.equal(audioMimeToCapName('  AUDIO/AC3 '), 'AC3');
  });
  it('maps known ng_fmt container MIME strings', () => {
    assert.equal(containerMimeToCapName('video/mp4'), 'MP4');
    assert.equal(containerMimeToCapName('video/mp2t'), 'MPEG2-TS');
    assert.equal(containerMimeToCapName('video/x-matroska'), 'MATROSKA');
  });
  it('returns null for unknown/ambiguous tokens (fail-safe)', () => {
    assert.equal(audioMimeToCapName('audio/x-weird'), null);
    assert.equal(containerMimeToCapName('video/mpeg'), null); // ambiguous PS/TS
    assert.equal(containerMimeToCapName(''), null);
  });
});

describe('AvplayCapabilityMemory — audio/container attribution', () => {
  let storage;
  let mem;
  // Combo whose video codec is known-safe (H264) so failures fall to audio/container.
  const H264_EAC3_TS = { video: 'video/avc', audio: 'audio/eac3', container: 'video/mp2t' };
  const H264_AC3_TS = { video: 'video/avc', audio: 'audio/ac3', container: 'video/mp2t' };
  beforeEach(() => {
    storage = makeStorage();
    mem = new AvplayCapabilityMemory({ storage, deviceSig: 'ModelX|FW1', failThreshold: 2 });
  });

  it('success immunises all three dimensions of the combo', () => {
    mem.recordSuccess(HEVC); // video/hevc, audio AAC, container MP4
    assert.deepEqual(mem.getProvenBadNativeCaps(), { video: [], audio: [], containers: [] });
    // All three now immune to later failures.
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(HEVC, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadNativeCaps(), { video: [], audio: [], containers: [] });
  });

  it('does NOT attribute to audio/container while two dims are unproven (ambiguous)', () => {
    // video H264 is unproven here → video is blamed, not audio/container.
    mem.recordFailure(H264_EAC3_TS, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(H264_EAC3_TS, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadVideo(), ['H264']);
    assert.deepEqual(mem.getProvenBadNativeCaps().audio, []);
    assert.deepEqual(mem.getProvenBadNativeCaps().containers, []);
  });

  it('blames audio once video AND container are proven-good (unambiguous)', () => {
    // Prove H264 + MPEG2-TS good via an AC3/TS success, leaving EAC3 the lone suspect.
    mem.recordSuccess(H264_AC3_TS); // good: video H264, audio AC3, container MPEG2-TS
    const bl1 = mem.recordFailure(H264_EAC3_TS, 'AVPLAY_PREPARE_ERROR');
    assert.equal(bl1, false);
    const bl2 = mem.recordFailure(H264_EAC3_TS, 'AVPLAY_OPEN_ERROR');
    assert.equal(bl2, true);
    assert.deepEqual(mem.getProvenBadNativeCaps().audio, ['EAC3']);
    // video/container untouched.
    assert.deepEqual(mem.getProvenBadVideo(), []);
    assert.deepEqual(mem.getProvenBadNativeCaps().containers, []);
  });

  it('blames container once video AND audio are proven-good', () => {
    // Prove H264 + AAC good via an MP4 success; then an H264/AAC/TS combo fails →
    // only the container (MPEG2-TS) is the unproven suspect.
    mem.recordSuccess({ video: 'video/avc', audio: 'audio/mp4a-latm', container: 'video/mp4' });
    const combo = { video: 'video/avc', audio: 'audio/mp4a-latm', container: 'video/mp2t' };
    mem.recordFailure(combo, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(combo, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadNativeCaps().containers, ['MPEG2-TS']);
    assert.deepEqual(mem.getProvenBadVideo(), []);
    assert.deepEqual(mem.getProvenBadNativeCaps().audio, []);
  });

  it('does not attribute to audio/container when video codec is unmappable', () => {
    // Unmappable video → fault stays ambiguous even though audio is mappable.
    const combo = { video: 'video/x-ms-wmv', audio: 'audio/eac3', container: 'video/mp2t' };
    mem.recordFailure(combo, 'AVPLAY_PREPARE_ERROR');
    mem.recordFailure(combo, 'AVPLAY_PREPARE_ERROR');
    assert.deepEqual(mem.getProvenBadNativeCaps(), { video: [], audio: [], containers: [] });
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
