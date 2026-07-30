/**
 * Tests for NgPlaybackContextConsumer
 *
 * Verifies that the consumer correctly:
 * 1. Fetches context from bridge on media open
 * 2. Applies seek/flow hints to player tunables
 * 3. Resets player tunables on media close
 * 4. Re-fetches on context push (SET_PROPERTY)
 * 5. Handles unavailable/error responses gracefully
 * 6. Does not change playback behavior (no start/stop/seek calls)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NgPlaybackContextConsumer } from './ng-playback-context-consumer.js';

// ── Mock player (records what was set, no real media behavior) ──
function createMockPlayer() {
  return {
    _seekCoalesceMs: undefined,
    _minSeekIntervalMs: undefined,
    _seekGranularityMs: undefined,
    _prebufferSec: undefined,
    _ngDurationMs: undefined,
    _bwKbps: 0,
  };
}

// ── Mock context manager (EventTarget) ──
class MockContextManager extends EventTarget {}

// ── Mock server ──
let mockServer;
let mockPort;
let lastRequest = null;
let mockResponse = null;

before(async () => {
  mockServer = http.createServer((req, res) => {
    lastRequest = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockResponse));
  });
  await new Promise((r) => mockServer.listen(0, r));
  mockPort = mockServer.address().port;
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
});

describe('NgPlaybackContextConsumer', () => {
  let player;
  let ctxManager;
  let consumer;

  beforeEach(() => {
    player = createMockPlayer();
    ctxManager = new MockContextManager();
    lastRequest = null;
    mockResponse = {
      type: 'NG_PLAYBACK_CONTEXT',
      sessionId: 'test-123',
      context: {
        seek: {
          preferredGranularityMs: 5000,
          minSeekIntervalMs: 250,
          maxClientCoalesceMs: 1500,
          requiresServerSeek: true,
          clientMayPredictOsd: true,
        },
        flow: {
          preferredPrebufferBytes: 262144,
          lowWatermarkBytes: 131072,
          highWatermarkBytes: 4194304,
        },
        durationMs: 3600000,
      },
    };
  });

  it('fetches context on media open and applies seek hints', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();

    assert.equal(lastRequest, '/ng/playback-context/current');
    assert.equal(player._seekCoalesceMs, 500); // capped from server's 1500
    assert.equal(player._minSeekIntervalMs, 250);
    assert.equal(player._seekGranularityMs, 5000);
    assert.equal(player._ngDurationMs, 3600000);

    consumer.destroy();
  });

  it('applies flow control (prebufferSec) based on preferredPrebufferBytes', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();

    // 262144 bytes / 500000 bytes/sec (default) ≈ 0.524s, clamped to [0.3, 3.0]
    assert.ok(player._prebufferSec >= 0.3);
    assert.ok(player._prebufferSec <= 3.0);
    assert.ok(Math.abs(player._prebufferSec - 0.524) < 0.01);

    consumer.destroy();
  });

  it('resets player tunables on media close', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();
    assert.equal(player._seekCoalesceMs, 500); // capped from 1500

    consumer.onMediaClose();
    assert.equal(player._seekCoalesceMs, undefined);
    assert.equal(player._minSeekIntervalMs, undefined);
    assert.equal(player._seekGranularityMs, undefined);
    assert.equal(player._prebufferSec, undefined);
    assert.equal(player._ngDurationMs, undefined);

    consumer.destroy();
  });

  it('re-fetches on context push from binary protocol', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();
    lastRequest = null;

    // Simulate SET_PROPERTY push
    ctxManager.dispatchEvent(new CustomEvent('contextchange', {
      detail: { previous: null, current: {} },
    }));

    // Give the async fetch time to complete
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lastRequest, '/ng/playback-context/current');

    consumer.destroy();
  });

  it('does nothing when bridge returns unavailable', async () => {
    mockResponse = {
      type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE',
      reason: 'server_not_supported',
    };

    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();

    // Player tunables remain at defaults
    assert.equal(player._seekCoalesceMs, undefined);
    assert.equal(player._prebufferSec, undefined);

    consumer.destroy();
  });

  it('does nothing when bridgeOrigin is empty (legacy / no bridge)', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: '',
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();

    assert.equal(lastRequest, null);
    assert.equal(player._seekCoalesceMs, undefined);

    consumer.destroy();
  });

  it('does not call player start/stop/seek (no playback behavior change)', async () => {
    // Player has no start/stop/seek methods in mock — verify consumer only sets knobs
    const calls = [];
    const proxy = new Proxy(player, {
      set(target, prop, value) {
        calls.push({ prop, value });
        target[prop] = value;
        return true;
      },
    });

    consumer = new NgPlaybackContextConsumer(proxy, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    await consumer.onMediaOpen();

    // Only _seekCoalesceMs, _minSeekIntervalMs, _seekGranularityMs, _prebufferSec, _ngDurationMs
    const setProps = calls.map((c) => c.prop);
    assert.ok(!setProps.includes('play'));
    assert.ok(!setProps.includes('stop'));
    assert.ok(!setProps.includes('seek'));
    assert.ok(!setProps.includes('pause'));
    assert.ok(setProps.includes('_seekCoalesceMs'));
    assert.ok(setProps.includes('_prebufferSec'));

    consumer.destroy();
  });

  it('getLastContext returns applied context', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    assert.equal(consumer.getLastContext(), null);
    await consumer.onMediaOpen();
    assert.ok(consumer.getLastContext());
    assert.equal(consumer.getLastContext().durationMs, 3600000);

    consumer.onMediaClose();
    assert.equal(consumer.getLastContext(), null);

    consumer.destroy();
  });

  it('ignores context push when not active (before media open)', async () => {
    consumer = new NgPlaybackContextConsumer(player, {
      bridgeOrigin: `http://localhost:${mockPort}`,
      contextManager: ctxManager,
    });

    ctxManager.dispatchEvent(new CustomEvent('contextchange', {
      detail: { previous: null, current: {} },
    }));

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lastRequest, null);

    consumer.destroy();
  });
});
