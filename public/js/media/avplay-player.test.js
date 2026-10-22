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

test('long paused restartable stream reopens at the paused rendered position', () => {
  const originalNow = Date.now;
  Date.now = () => 20_000;
  try {
    let nativePlayCalls = 0;
    let drainCalls = 0;
    const player = Object.create(AVPlayPlayer.prototype);
    player._avplay = { play: () => { nativePlayCalls++; } };
    player.state = PlayerState.PAUSE;
    player._restartableStream = { kind: 'msproxy' };
    player._pausedAtMs = 10_000;
    player._pausedMediaTimeMs = 123_096;
    player._streamOffsetMs = 118_642;
    player._lastRenderedMediaTimeMs = 123_096;
    player._positionMs = 123_096;
    player._restartSeekGeneration = 7;
    player._lastDestRect = { x: 0, y: 0, width: 1920, height: 1080 };
    player._phoneHome = () => {};
    player.dispatchEvent = () => true;
    player._drainRestartSeek = () => { drainCalls++; };

    player.play();

    assert.equal(nativePlayCalls, 0);
    assert.equal(drainCalls, 1);
    assert.equal(player.state, PlayerState.PLAY);
    assert.equal(player._restartSeekTargetMs, 123_096);
    assert.equal(player._restartSeekGeneration, 8);
    assert.equal(player._restartSeekResumePaused, false);
    assert.equal(player._buffering, true);
  } finally {
    Date.now = originalNow;
  }
});

test('short pause resumes AVPlay without reopening the stream', () => {
  const originalNow = Date.now;
  Date.now = () => 12_000;
  try {
    let nativePlayCalls = 0;
    let drainCalls = 0;
    const player = Object.create(AVPlayPlayer.prototype);
    player._avplay = { play: () => { nativePlayCalls++; } };
    player.state = PlayerState.PAUSE;
    player._restartableStream = { kind: 'msproxy' };
    player._pausedAtMs = 10_000;
    player._pausedMediaTimeMs = 123_096;
    player._drainRestartSeek = () => { drainCalls++; };

    player.play();

    assert.equal(nativePlayCalls, 1);
    assert.equal(drainCalls, 0);
    assert.equal(player.state, PlayerState.PLAY);
    assert.equal(player._pausedAtMs, 0);
    assert.equal(player._pausedMediaTimeMs, 0);
  } finally {
    Date.now = originalNow;
  }
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

test('AVPlay diagnostics report buffering lifecycle and native clock state', () => {
  let listener;
  const reports = [];
  const avplay = {
    setListener(value) { listener = value; },
    getCurrentTime: () => 2_250,
    getState: () => 'PLAYING',
  };
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _avplay: avplay,
    _loadSeq: 3,
    _streamOffsetMs: 25_500,
    _positionMs: 27_750,
    _lastRenderedMediaTimeMs: 27_750,
    _buffering: false,
    _lastBufferingProgressBucket: -1,
    state: PlayerState.PLAY,
    dispatchEvent() {},
    _phoneHome(reason, details) { reports.push([reason, details]); },
    _emitPlaybackFailure() {},
    _emitFirstFrameOnce() {},
    _captureStreamInfo() {},
  });

  player._installListener(3);
  listener.onbufferingstart();
  listener.onbufferingprogress(10);
  listener.onbufferingprogress(20);
  listener.onbufferingprogress(30);
  listener.onbufferingcomplete();

  assert.deepEqual(reports.map(([reason]) => reason), [
    'BUFFERING_START',
    'BUFFERING_PROGRESS',
    'BUFFERING_PROGRESS',
    'BUFFERING_COMPLETE',
  ]);
  assert.equal(reports[0][1].nativeState, 'PLAYING');
  assert.equal(reports[0][1].localPositionMs, 2_250);
  assert.equal(reports[0][1].absolutePositionMs, 27_750);
  assert.equal(reports[0][1].buffering, true);
  assert.equal(reports[3][1].buffering, false);
});

test('AVPlay diagnostic snapshot tolerates unavailable native state', () => {
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _avplay: {
      getCurrentTime() { throw new Error('not ready'); },
      getState() { throw new Error('not ready'); },
    },
    _loadSeq: 2,
    _streamOffsetMs: 10_000,
    _positionMs: 12_000,
    _lastRenderedMediaTimeMs: 11_500,
    _buffering: true,
  });

  assert.deepEqual(player._snapshotPlaybackDiagnostics(), {
    nativeState: null,
    localPositionMs: null,
    absolutePositionMs: 12_000,
    callbackPositionMs: 12_000,
    renderedPositionMs: 11_500,
    streamOffsetMs: 10_000,
    buffering: true,
    loadSequence: 2,
  });
});

test('AVPlay heartbeat is generation-fenced and clears after load supersession', () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let tick;
  let clearedTimer = null;
  const reports = [];
  globalThis.setInterval = (callback, intervalMs) => {
    assert.equal(intervalMs, 5_000);
    tick = callback;
    return 77;
  };
  globalThis.clearInterval = (timer) => { clearedTimer = timer; };

  try {
    const avplay = {
      getCurrentTime: () => 1_500,
      getState: () => 'PLAYING',
    };
    const player = Object.create(AVPlayPlayer.prototype);
    Object.assign(player, {
      _avplay: avplay,
      _loadSeq: 4,
      _streamOffsetMs: 8_000,
      _positionMs: 9_500,
      _lastRenderedMediaTimeMs: 9_500,
      _buffering: false,
      _playbackDiagnosticTimer: null,
      _phoneHome(reason, details) { reports.push([reason, details]); },
    });

    player._startPlaybackDiagnostics(4);
    tick();
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], 'PLAYBACK_HEARTBEAT');
    assert.equal(reports[0][1].absolutePositionMs, 9_500);

    player._loadSeq = 5;
    tick();
    assert.equal(clearedTimer, 77);
    assert.equal(player._playbackDiagnosticTimer, null);
    assert.equal(reports.length, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
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
  player._restartSeekGeneration = 0;

  let loadArgs;
  player.load = (...received) => {
    loadArgs = received;
    return Promise.resolve();
  };

  await player._openMsProxy('/recording.mpg', 'xcode:browserhd', 'server', 12.5);

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

test('initial xcode resume seek is folded into the first msproxy open', async () => {
  const player = Object.create(AVPlayPlayer.prototype);
  player._avplay = {};
  player._restartSeekGeneration = 0;
  player._initialLoadTimer = null;
  player._pendingInitialLoad = null;
  player._positionMs = 0;
  player._lastRenderedMediaTimeMs = 0;
  player._buffering = false;

  const opens = [];
  player._openMsProxy = (...args) => {
    opens.push(args);
    return Promise.resolve(true);
  };

  await player.loadMsProxy(
    '/recording.mpg',
    'xcode:audioonly:enhance;tier=2160p',
    'server',
    0
  );
  assert.equal(opens.length, 0);

  player.seek(105_240);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(opens, [[
    '/recording.mpg',
    'xcode:audioonly:enhance;tier=2160p',
    'server',
    105.24,
    null,
  ]]);
  assert.equal(player._positionMs, 105_240);
  assert.equal(player._lastRenderedMediaTimeMs, 105_240);
  assert.equal(player._pendingInitialLoad, null);
  assert.equal(player._initialLoadTimer, null);
});

test('initial xcode seek after 250ms cancels the zero-offset producer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _avplay: {},
    _bridgeBase: 'http://bridge',
    _restartSeekGeneration: 0,
    _initialLoadTimer: null,
    _pendingInitialLoad: null,
  });
  const loads = [];
  player.load = async (...args) => { loads.push(args); return true; };

  await player.loadMsProxy(
    '/BestMedicine.mpg',
    'xcode:audioonly:enhance;tier=2160p',
    'server'
  );
  t.mock.timers.tick(333);
  assert.equal(loads.length, 0);

  player.seek(7_210);
  assert.equal(loads.length, 1);
  const url = new URL(loads[0][3]);
  assert.equal(url.pathname, '/msproxy');
  assert.equal(url.searchParams.get('seek'), '7.21');
  assert.equal(loads[0][9].offsetMs, 7_210);
  assert.equal(player._pendingInitialLoad, null);
  assert.equal(player._initialLoadTimer, null);

  t.mock.timers.tick(2_000);
  assert.equal(loads.length, 1);
});

test('initial xcode true-zero playback opens exactly once after one second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = Object.create(AVPlayPlayer.prototype);
  Object.assign(player, {
    _bridgeBase: 'http://bridge',
    _restartSeekGeneration: 0,
    _initialLoadTimer: null,
    _pendingInitialLoad: null,
  });
  const loads = [];
  player.load = async (...args) => { loads.push(args); return true; };

  await player.loadMsProxy('/recording.mpg', 'xcode:browserhd', 'server');
  t.mock.timers.tick(999);
  assert.equal(loads.length, 0);
  t.mock.timers.tick(1);
  assert.equal(loads.length, 1);
  assert.equal(new URL(loads[0][3]).searchParams.has('seek'), false);
  assert.equal(loads[0][9].offsetMs, 0);
  assert.equal(player._pendingInitialLoad, null);
  assert.equal(player._initialLoadTimer, null);

  t.mock.timers.tick(2_000);
  assert.equal(loads.length, 1);
});

test('zero-offset xcode restart bypasses initial seek grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = Object.create(AVPlayPlayer.prototype);
  player._bridgeBase = 'http://bridge';
  player._restartSeekGeneration = 8;
  const loads = [];
  player.load = async (...args) => { loads.push(args); return true; };

  await player.loadMsProxy(
    '/recording.mpg', 'xcode:browserhd', 'server', 0, { restartGeneration: 8 }
  );

  assert.equal(loads.length, 1);
  assert.equal(loads[0][9].restartGeneration, 8);
  t.mock.timers.tick(2_000);
  assert.equal(loads.length, 1);
});

for (const mode of ['direct', 'remux:ts']) {
  test(`Tizen ${mode} msproxy opens immediately without a transcode bandwidth seed`, async () => {
    const player = Object.create(AVPlayPlayer.prototype);
    player._bridgeBase = 'http://bridge';

    let loadArgs;
    player.load = (...received) => {
      loadArgs = received;
      return Promise.resolve();
    };

    await player.loadMsProxy('/recording.mpg', mode, 'server');

    assert.doesNotMatch(loadArgs[3], /[?&]bw=/);
  });
}
