import test from 'node:test';
import assert from 'node:assert/strict';

import { AVPlayPlayer } from './avplay-player.js';
import { PlayerState } from '../protocol/constants.js';

test('one seek on a settled msproxy stream stops and reopens once at the target', async () => {
  const calls = [];
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _avplay: {},
    _loadSeq: 4,
    _restartSeekGeneration: 1,
    _restartSeekRequested: false,
    _restartSeekRunning: false,
    _restartSeekResumePaused: false,
    _lastDestRect: null,
    _streamOffsetMs: 0,
    _restartableStream: {
      kind: 'msproxy',
      absPath: '/live-growing.mpg',
      mode: 'xcode:audioonly:enhance;tier=2160p',
      hostname: 'server',
    },
    state: PlayerState.PLAY,
  });
  player._closeForRestart = async (generation) => {
    calls.push(['close', generation]);
  };
  player.loadMsProxy = async (...args) => {
    calls.push(['open', ...args]);
    player._streamOffsetMs = args[3] * 1000;
    return true;
  };

  player.seek(35_660);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ['close', 2],
    [
      'open',
      '/live-growing.mpg',
      'xcode:audioonly:enhance;tier=2160p',
      'server',
      35.66,
      { startPaused: false, destRect: null, restartGeneration: 2 },
    ],
  ]);
  assert.equal(player._restartSeekRequested, false);
  assert.equal(player._restartSeekRunning, false);
  assert.equal(player._streamOffsetMs, 35_660);
});

test('seek opens msproxy once at the latest target when teardown is in flight', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player._avplay = { stop() {}, close() {} };
  player.state = PlayerState.PLAY;
  player._loadSeq = 0;
  player._restartSeekGeneration = 0;
  player._restartSeekRequested = false;
  player._restartSeekRunning = false;
  player._restartSeekResumePaused = false;
  player._lastDestRect = { x: 0, y: 0, width: 1920, height: 1080 };
  player._restartableStream = {
    kind: 'msproxy',
    absPath: '/recording.mpg',
    mode: 'xcode:browserhd',
    hostname: 'server',
  };

  let finishTeardown;
  const teardown = new Promise((resolve) => { finishTeardown = resolve; });
  player._closeForRestart = () => teardown;
  const calls = [];
  player.loadMsProxy = (...received) => {
    calls.push(received);
    player._streamOffsetMs = received[3] * 1000;
    return true;
  };

  player.seek(422_824);
  player.seek(452_824);
  player.seek(482_824);
  player.seek(512_824);
  assert.equal(calls.length, 0);
  finishTeardown();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    '/recording.mpg',
    'xcode:browserhd',
    'server',
    512.824,
    {
      startPaused: false,
      destRect: { x: 0, y: 0, width: 1920, height: 1080 },
      restartGeneration: 4,
    },
  ]);
});

test('superseded restart generation cannot construct an msproxy URL', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _bridgeBase: 'http://bridge',
    _restartSeekGeneration: 8,
  });
  let loadCalled = false;
  player.load = () => { loadCalled = true; };

  const opened = await player.loadMsProxy(
    '/recording.mpg',
    'xcode:browserhd',
    'server',
    417.824,
    { restartGeneration: 7 }
  );

  assert.equal(opened, false);
  assert.equal(loadCalled, false);
});

test('media time includes the offset of a reopened stream', () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player.state = PlayerState.PLAY;
  player._streamOffsetMs = 25_500;
  player._positionMs = 25_500;
  player._avplay = { getCurrentTime: () => 2_250 };

  assert.equal(player.getMediaTimeMillis(), 27_750);
});

test('rendered media time includes the reopened stream offset', () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player.state = PlayerState.PLAY;
  player._streamOffsetMs = 25_500;
  player._lastRenderedMediaTimeMs = 0;
  player._buffering = false;
  player._avplay = { getCurrentTime: () => 2_250 };

  assert.equal(player.getRenderedMediaTimeMillis(), 27_750);
});

test('rendered media time freezes while buffering or paused', () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player._lastRenderedMediaTimeMs = 2_250;
  player._streamOffsetMs = 0;
  player._buffering = true;
  player.state = PlayerState.PLAY;
  player._avplay = { getCurrentTime: () => 9_000 };

  assert.equal(player.getRenderedMediaTimeMillis(), 2_250);
  player._buffering = false;
  player.state = PlayerState.PAUSE;
  assert.equal(player.getRenderedMediaTimeMillis(), 2_250);
});

test('superseded AVPlay callbacks cannot overwrite the active timeline', async () => {
  const listeners = [];
  const avplay = {
    setListener(listener) { listeners.push(listener); },
    getCurrentTime: () => 0,
  };
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _avplay: avplay,
    _loadSeq: 1,
    _streamOffsetMs: 500_000,
    _positionMs: 500_000,
    _lastRenderedMediaTimeMs: 0,
    _buffering: false,
    state: PlayerState.PLAY,
    dispatchEvent() {},
    _phoneHome() {},
    _emitPlaybackFailure() {},
    _emitFirstFrameOnce() {},
  });

  player._installListener(1);
  player._loadSeq = 2;
  player._streamOffsetMs = 120_000;
  player._positionMs = 120_000;
  player._installListener(2);
  listeners[0].oncurrentplaytime(9_000);
  assert.equal(player._positionMs, 120_000);
  listeners[1].oncurrentplaytime(4_000);
  assert.equal(player._positionMs, 124_000);
  assert.equal(player.getRenderedMediaTimeMillis(), 120_000);
});

test('full recording duration wins when AVPlay returns zero after seek reopen', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _streamInfo: { durationMs: 1_920_625 },
    _streamOffsetMs: 504_839,
  });

  assert.equal(player._resolveDurationMs(0), 1_920_625);
  assert.equal(player._resolveDurationMs(100_000), 1_920_625);
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
  assert.match(url, /bw=50000/);
  assert.equal(options.offsetMs, 12_500);
});

test('Tizen direct msproxy playback does not send a transcode bandwidth seed', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player._bridgeBase = 'http://bridge';

  let loadArgs;
  player.load = (...received) => {
    loadArgs = received;
    return Promise.resolve();
  };

  await player.loadMsProxy('/recording.mpg', 'direct', 'server');

  assert.doesNotMatch(loadArgs[3], /[?&]bw=/);
});
