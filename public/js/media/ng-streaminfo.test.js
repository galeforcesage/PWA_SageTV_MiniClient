/**
 * Tests for the shared NG STREAMINFO parser + format-hint derivation.
 * Run with: node --test public/js/media/ng-streaminfo.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStreamInfo,
  streamInfoToFormatHint,
  primaryTrack,
  STREAMINFO_ACK,
  SAGETV_CODEC_TO_MIME,
} from './ng-streaminfo.js';

const SAMPLE = {
  v: 1,
  container: 'MPEG2-TS',
  duration_ms: 1800000,
  live: false,
  bitrate: 8000000,
  video: [{ codec: 'HEVC', width: 1920, height: 1080, fps: 30, id: 1, primary: true }],
  audio: [
    { codec: 'AC3', channels: 6, sample_rate: 48000, language: 'eng', id: 2, primary: true },
    { codec: 'AAC', channels: 2, sample_rate: 48000, language: 'spa', id: 3, primary: false },
  ],
  subtitle: [{ codec: 'DVBSUB', language: 'eng', id: 4 }],
};

describe('parseStreamInfo', () => {
  it('parses a JSON string into a normalized descriptor', () => {
    const info = parseStreamInfo(JSON.stringify(SAMPLE));
    assert.ok(info);
    assert.equal(info.container, 'MPEG2-TS');
    assert.equal(info.durationMs, 1800000);
    assert.equal(info.live, false);
    assert.equal(info.bitrate, 8000000);
    assert.equal(info.video.length, 1);
    assert.equal(info.audio.length, 2);
    assert.equal(info.subtitle.length, 1);
  });

  it('accepts an already-parsed object', () => {
    const info = parseStreamInfo(SAMPLE);
    assert.ok(info);
    assert.equal(info.video[0].mime, 'video/hevc');
  });

  it('resolves SageTV codec names to MIME on each track', () => {
    const info = parseStreamInfo(SAMPLE);
    assert.equal(info.video[0].mime, SAGETV_CODEC_TO_MIME['HEVC']);
    assert.equal(info.audio[0].mime, SAGETV_CODEC_TO_MIME['AC3']);
    assert.equal(info.audio[1].mime, SAGETV_CODEC_TO_MIME['AAC']);
  });

  it('prefers an explicit track mime over the codec map', () => {
    const info = parseStreamInfo({ video: [{ codec: 'HEVC', mime: 'video/custom' }] });
    assert.equal(info.video[0].mime, 'video/custom');
  });

  it('returns null mime for unknown codecs without throwing', () => {
    const info = parseStreamInfo({ video: [{ codec: 'WHO-KNOWS' }] });
    assert.equal(info.video[0].mime, null);
  });

  it('returns null for malformed JSON', () => {
    assert.equal(parseStreamInfo('{ not valid json'), null);
  });

  it('returns null for non-object / empty inputs', () => {
    assert.equal(parseStreamInfo(''), null);
    assert.equal(parseStreamInfo(null), null);
    assert.equal(parseStreamInfo(undefined), null);
    assert.equal(parseStreamInfo(42), null);
    assert.equal(parseStreamInfo('[1,2,3]'), null);
  });

  it('defaults missing/invalid fields safely', () => {
    const info = parseStreamInfo('{}');
    assert.ok(info);
    assert.equal(info.v, 1);
    assert.equal(info.container, null);
    assert.equal(info.durationMs, null);
    assert.equal(info.live, false);
    assert.equal(info.bitrate, null);
    assert.deepEqual(info.video, []);
    assert.deepEqual(info.audio, []);
  });

  it('treats non-positive duration/bitrate as null', () => {
    const info = parseStreamInfo({ duration_ms: 0, bitrate: -1 });
    assert.equal(info.durationMs, null);
    assert.equal(info.bitrate, null);
  });
});

describe('primaryTrack', () => {
  it('returns the track flagged primary', () => {
    const t = primaryTrack([{ id: 1 }, { id: 2, primary: true }]);
    assert.equal(t.id, 2);
  });
  it('falls back to the first track when none flagged', () => {
    const t = primaryTrack([{ id: 1 }, { id: 2 }]);
    assert.equal(t.id, 1);
  });
  it('returns null for empty/invalid', () => {
    assert.equal(primaryTrack([]), null);
    assert.equal(primaryTrack(null), null);
  });
});

describe('streamInfoToFormatHint', () => {
  it('derives a {container, video, audio} MIME hint from primary tracks', () => {
    const hint = streamInfoToFormatHint(parseStreamInfo(SAMPLE));
    assert.deepEqual(hint, {
      container: 'video/mp2t',
      video: 'video/hevc',
      audio: 'audio/ac3', // the primary audio track, not the AAC alternate
    });
  });

  it('uses the first track when no primary flag is present', () => {
    const info = parseStreamInfo({
      container: 'MP4',
      video: [{ codec: 'H.264' }],
      audio: [{ codec: 'AAC' }],
    });
    assert.deepEqual(streamInfoToFormatHint(info), {
      container: 'video/mp4',
      video: 'video/avc',
      audio: 'audio/mp4a-latm',
    });
  });

  it('yields null container for an unknown container name', () => {
    const info = parseStreamInfo({ container: 'WEIRDBOX', video: [{ codec: 'HEVC' }] });
    const hint = streamInfoToFormatHint(info);
    assert.equal(hint.container, null);
    assert.equal(hint.video, 'video/hevc');
  });

  it('returns null when nothing usable is present', () => {
    assert.equal(streamInfoToFormatHint(parseStreamInfo('{}')), null);
    assert.equal(streamInfoToFormatHint(null), null);
  });
});

describe('STREAMINFO_ACK', () => {
  it('exposes the documented bit values', () => {
    assert.equal(STREAMINFO_ACK.PARSED, 0x01);
    assert.equal(STREAMINFO_ACK.VIDEO, 0x02);
    assert.equal(STREAMINFO_ACK.AUDIO, 0x04);
    assert.equal(STREAMINFO_ACK.WAIT_READY, 0x08);
  });
});
