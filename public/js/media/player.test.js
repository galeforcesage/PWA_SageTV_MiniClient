import test from 'node:test';
import assert from 'node:assert/strict';

import { MediaPlayer } from './player.js';

test('fatal CMAF network error falls back once at the current playhead', async () => {
  const player = Object.create(MediaPlayer.prototype);
  player._hlsFatalFallbackTried = false;
  player.getMediaTimeMillis = () => 123_456;
  player._emitPlaybackFailure = () => {};

  const calls = [];
  player.loadMsProxyMfid = (...args) => {
    calls.push(args);
    return Promise.resolve();
  };

  assert.equal(player._fallbackFromCmafHls(14467360, 'server', 'fragLoadError'), true);
  assert.equal(player._fallbackFromCmafHls(14467360, 'server', 'fragLoadError'), false);
  assert.deepEqual(calls, [[14467360, 'xcode:browserhd', 'server', 123.456]]);
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
  player._cmafFallback = { mfid: 14362029, hostname: 'server' };

  let received;
  player._fallbackFromCmafHls = (...args) => {
    received = args;
    return true;
  };

  player._setupVideoEvents();
  listeners.error({});

  assert.deepEqual(received, [
    14362029,
    'server',
    'DEMUXER_ERROR_COULD_NOT_PARSE',
  ]);
});
