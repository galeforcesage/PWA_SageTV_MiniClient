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
