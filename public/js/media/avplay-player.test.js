import test from 'node:test';
import assert from 'node:assert/strict';

import { AVPlayPlayer } from './avplay-player.js';
import { PlayerState } from '../protocol/constants.js';

test('seek coalesces msproxy restarts at the latest requested offset', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player._avplay = {};
  player.state = PlayerState.PLAY;
  player._lastDestRect = { x: 0, y: 0, width: 1920, height: 1080 };
  player._restartableStream = {
    kind: 'msproxy',
    absPath: '/recording.mpg',
    mode: 'xcode:browserhd',
    hostname: 'server',
  };

  const calls = [];
  player.loadMsProxy = (...received) => { calls.push(received); };

  player.seek(10_000);
  player.seek(25_500);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    '/recording.mpg',
    'xcode:browserhd',
    'server',
    25.5,
    {
      startPaused: false,
      destRect: { x: 0, y: 0, width: 1920, height: 1080 },
    },
  ]);
});

test('media time includes the offset of a reopened stream', () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player.state = PlayerState.PLAY;
  player._streamOffsetMs = 25_500;
  player._positionMs = 25_500;
  player._avplay = { getCurrentTime: () => 2_250 };

  assert.equal(player.getMediaTimeMillis(), 27_750);
});

test('msproxy URL and player state share one session id', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player._bridgeBase = 'http://bridge';

  let loadArgs;
  player.load = (...received) => {
    loadArgs = received;
    return Promise.resolve();
  };

  await player.loadMsProxy('/recording.mpg', 'xcode:browserhd', 'server', 12.5);

  const url = loadArgs[3];
  const fallbackUrl = loadArgs[8];
  const options = loadArgs[9];
  assert.ok(options.sessionId);
  assert.match(url, new RegExp(`session=${options.sessionId}`));
  assert.match(fallbackUrl, new RegExp(`session=${options.sessionId}`));
  assert.match(url, /seek=12\.5/);
  assert.equal(options.offsetMs, 12_500);
});
