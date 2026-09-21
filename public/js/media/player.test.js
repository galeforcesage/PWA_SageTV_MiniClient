import test from 'node:test';
import assert from 'node:assert/strict';

import { MediaPlayer } from './player.js';
import { PlayerState } from '../protocol/constants.js';

test('fatal CMAF network error falls back once near the current playhead', async () => {
  const player = Object.create(MediaPlayer.prototype);
  player._hlsFatalFallbackTried = false;
  player.getMediaTimeMillis = () => 123_456;
  player._emitPlaybackFailure = () => {};

  const calls = [];
  player.loadMsProxyMfid = (...args) => {
    calls.push(args);
    return Promise.resolve();
  };

  assert.equal(player._fallbackFromCmafHls(42, 'server', 'fragLoadError'), true);
  assert.equal(player._fallbackFromCmafHls(42, 'server', 'fragLoadError'), false);
  assert.deepEqual(calls, [[42, 'xcode:browserhd', 'server', 115]]);
});

test('CMAF fallback requires a valid media file and server', () => {
  const player = Object.create(MediaPlayer.prototype);
  player._hlsFatalFallbackTried = false;

  assert.equal(player._fallbackFromCmafHls(0, 'server', 'fragLoadError'), false);
  assert.equal(player._fallbackFromCmafHls(123, '', 'fragLoadError'), false);
});

test('CMAF video element error uses the stored fallback context', () => {
  const listeners = {};
  const player = Object.create(MediaPlayer.prototype);
  player.video = {
    addEventListener: (name, handler) => { listeners[name] = handler; },
    error: { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_PARSE' },
  };
  player._cmafHlsMode = true;
  player._cmafFallback = { mfid: 42, hostname: 'server' };

  let received;
  player._fallbackFromCmafHls = (...args) => {
    received = args;
    return true;
  };

  player._setupVideoEvents();
  listeners.error({});

  assert.deepEqual(received, [
    42,
    'server',
    'DEMUXER_ERROR_COULD_NOT_PARSE',
  ]);
});

test('CMAF progress watchdog falls back after five seconds without media progress', () => {
  const player = Object.create(MediaPlayer.prototype);
  player._cmafHlsMode = true;
  player._firstFrameEmitted = true;
  player.seeking = false;
  player.state = PlayerState.BUFFERING;
  player.video = { paused: false, ended: false, currentTime: 12 };
  player._cmafLastMediaTime = 12;
  player._cmafLastProgressAt = 10_000;
  player._cmafFallback = { mfid: 42, hostname: 'server' };

  let received;
  player._fallbackFromCmafHls = (...args) => {
    received = args;
    return true;
  };

  assert.equal(player._checkCmafProgress(14_999), false);
  assert.equal(player._checkCmafProgress(15_000), true);
  assert.deepEqual(received, [42, 'server', 'fragment-progress-timeout']);
});

test('CMAF progress watchdog does not interrupt playing video', () => {
  const player = Object.create(MediaPlayer.prototype);
  player._cmafHlsMode = true;
  player._firstFrameEmitted = true;
  player.seeking = false;
  player.state = PlayerState.PLAY;
  player.video = { paused: false, ended: false, currentTime: 12 };
  player._cmafLastMediaTime = 11;
  player._cmafLastProgressAt = 10_000;
  player._fallbackFromCmafHls = () => {
    throw new Error('fallback should not run while playback is progressing');
  };

  assert.equal(player._checkCmafProgress(60_000), false);
  assert.equal(player._cmafLastProgressAt, 60_000);
});

test('CMAF progress watchdog does not interrupt paused video', () => {
  const player = Object.create(MediaPlayer.prototype);
  player._cmafHlsMode = true;
  player._firstFrameEmitted = true;
  player.seeking = false;
  player.video = { paused: true, ended: false, currentTime: 12 };
  player._cmafLastMediaTime = 12;
  player._cmafLastProgressAt = 10_000;
  player._fallbackFromCmafHls = () => {
    throw new Error('fallback should not run while paused');
  };

  assert.equal(player._checkCmafProgress(60_000), false);
});

test('CMAF progress watchdog waits for first frame and active seek', () => {
  const player = Object.create(MediaPlayer.prototype);
  player._cmafHlsMode = true;
  player._firstFrameEmitted = false;
  player.seeking = false;
  player.video = { paused: false, ended: false, currentTime: 0 };
  player._cmafLastMediaTime = 0;
  player._cmafLastProgressAt = 10_000;
  player._fallbackFromCmafHls = () => {
    throw new Error('fallback should not run before playback starts or during seek');
  };

  assert.equal(player._checkCmafProgress(60_000), false);
  player._firstFrameEmitted = true;
  player.seeking = true;
  assert.equal(player._checkCmafProgress(60_000), false);
});

test('msproxy bandwidth seed query validates and caps the estimate', () => {
  const player = Object.create(MediaPlayer.prototype);

  player.setBandwidthSeedProvider(() => 4876.4);
  assert.equal(player._getBandwidthSeedQuery(), '&bw=4876');

  player.setBandwidthSeedProvider(() => 2_000_000);
  assert.equal(player._getBandwidthSeedQuery(), '&bw=1000000');

  player.setBandwidthSeedProvider(() => 0);
  assert.equal(player._getBandwidthSeedQuery(), '');
});
