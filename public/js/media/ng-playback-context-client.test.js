/**
 * Tests for NgPlaybackContextClient (debug-only browser consumer).
 * Run with: node --test public/js/media/ng-playback-context-client.test.js
 *
 * Covers:
 * 1. Debug flag off does not fetch automatically.
 * 2. Manual refresh fetches /ng/playback-context/current.
 * 3. Successful response is parsed and stored.
 * 4. Unavailable response is parsed and stored.
 * 5. Missing/invalid fields do not throw.
 * 6. getLatestContext() returns null when unavailable.
 * 7. Internal sessionKey is ignored if accidentally present.
 * 8. No FF/REW/skip behavior is changed.
 * 9. Existing client and bridge tests still pass (run separately).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NgPlaybackContextClient } from './ng-playback-context-client.js';

// ── Mock server ──────────────────────────────────────────────────────────────

let mockServer;
let mockPort;
let lastRequestPath = null;
let mockResponse = null;

async function startMockServer() {
  mockServer = http.createServer((req, res) => {
    lastRequestPath = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockResponse));
  });
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  mockPort = mockServer.address().port;
}

async function stopMockServer() {
  if (mockServer) await new Promise((r) => mockServer.close(r));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('NgPlaybackContextClient', () => {
  let client;

  beforeEach(async () => {
    await startMockServer();
    client = new NgPlaybackContextClient({
      bridgeOrigin: `http://127.0.0.1:${mockPort}`,
      pollIntervalMs: 60000, // long interval so polls don't fire during tests
    });
    lastRequestPath = null;
    mockResponse = { type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: 'no_active_session' };
  });

  afterEach(async () => {
    client.destroy();
    await stopMockServer();
  });

  it('1. debug flag off does not fetch automatically', async () => {
    // Client created with debug off by default
    assert.equal(client.isDebugEnabled(), false);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lastRequestPath, null, 'No fetch should occur when debug is off');
  });

  it('2. manual refreshNow() fetches /ng/playback-context/current', async () => {
    await client.refreshNow();
    assert.equal(lastRequestPath, '/ng/playback-context/current');
  });

  it('3. successful response is parsed and stored', async () => {
    mockResponse = {
      type: 'NG_PLAYBACK_CONTEXT',
      sessionId: 'pwa-aabbccddeeff',
      context: {
        version: 1,
        streamEpoch: 1720000000000,
        serverMediaTimeMs: 5000,
        mediaFileId: '12345',
        title: 'Test Show',
        durationMs: 3600000,
        contentType: 'recording',
        isLive: false,
        seekableByClient: true,
      },
    };

    await client.refreshNow();
    const ctx = client.getLatestContext();
    assert.notEqual(ctx, null);
    assert.equal(ctx.type, 'NG_PLAYBACK_CONTEXT');
    assert.equal(ctx.sessionId, 'pwa-aabbccddeeff');
    assert.equal(ctx.version, 1);
    assert.equal(ctx.streamEpoch, 1720000000000);
    assert.equal(ctx.serverMediaTimeMs, 5000);
    assert.equal(ctx.isLive, false);
    assert.equal(ctx.unavailableReason, null);
    assert.ok(ctx.fetchedAt > 0);
  });

  it('4. unavailable response is parsed and stored', async () => {
    mockResponse = { type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: 'client_name_unknown' };
    await client.refreshNow();

    assert.equal(client.getLatestContext(), null);
    assert.equal(client.getLatestUnavailableReason(), 'client_name_unknown');

    const resp = client.getLatestResponse();
    assert.equal(resp.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(resp.unavailableReason, 'client_name_unknown');
  });

  it('5. missing/invalid fields do not throw', async () => {
    // Empty object
    mockResponse = {};
    await client.refreshNow();
    assert.equal(client.getLatestContext(), null);

    // Null-ish
    mockResponse = null;
    await client.refreshNow();
    assert.equal(client.getLatestContext(), null);

    // NG_PLAYBACK_CONTEXT with no context field
    mockResponse = { type: 'NG_PLAYBACK_CONTEXT', sessionId: 'x' };
    await client.refreshNow();
    const ctx = client.getLatestContext();
    assert.notEqual(ctx, null);
    assert.equal(ctx.sessionId, 'x');
    assert.equal(ctx.version, null);
    assert.equal(ctx.isLive, null);
    assert.equal(ctx.safeSeekStartMs, null);

    // Context with non-numeric values
    mockResponse = {
      type: 'NG_PLAYBACK_CONTEXT',
      sessionId: 'y',
      context: { version: 'abc', streamEpoch: NaN, isLive: 'yes' },
    };
    await client.refreshNow();
    const ctx2 = client.getLatestContext();
    assert.equal(ctx2.version, null);
    assert.equal(ctx2.streamEpoch, null);
    assert.equal(ctx2.isLive, null);
  });

  it('6. getLatestContext() returns null when unavailable', async () => {
    mockResponse = { type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: 'no_active_session' };
    await client.refreshNow();
    assert.equal(client.getLatestContext(), null);
  });

  it('7. internal sessionKey is stripped if accidentally present in context', async () => {
    mockResponse = {
      type: 'NG_PLAYBACK_CONTEXT',
      sessionId: 'pwa-aabbccddeeff',
      context: {
        version: 1,
        sessionKey: 'AA:BB:CC:DD:EE:FF:12345:3',
        openGeneration: 3,
        mediaFileId: '12345',
      },
    };

    await client.refreshNow();
    const ctx = client.getLatestContext();
    assert.notEqual(ctx, null);
    // rawContext should NOT contain sessionKey or openGeneration
    assert.equal(ctx.rawContext.sessionKey, undefined);
    assert.equal(ctx.rawContext.openGeneration, undefined);
    // mediaFileId is fine
    assert.equal(ctx.rawContext.mediaFileId, '12345');
  });

  it('8. no FF/REW/skip behavior is changed (module has no media control)', () => {
    // Structural assertion: NgPlaybackContextClient has no methods that send
    // any media commands, seek, or input events.
    const proto = Object.getOwnPropertyNames(NgPlaybackContextClient.prototype);
    const forbidden = ['seek', 'fastForward', 'rewind', 'skip', 'sendCommand', 'sendKey'];
    for (const name of forbidden) {
      assert.ok(!proto.includes(name), `Must not expose ${name} method`);
    }
  });

  it('fetch error does not throw', async () => {
    // Point to a port that's not listening
    client.setBridgeOrigin('http://127.0.0.1:1');
    const result = await client.refreshNow();
    assert.notEqual(result, null);
    assert.equal(result.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(result.unavailableReason, 'bridge_not_wired');
  });

  it('setDebugEnabled(true) triggers immediate fetch', async () => {
    client.setDebugEnabled(true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(lastRequestPath, '/ng/playback-context/current');
    client.setDebugEnabled(false);
  });

  it('live context fields are extracted correctly', async () => {
    mockResponse = {
      type: 'NG_PLAYBACK_CONTEXT',
      sessionId: 'pwa-112233445566',
      context: {
        version: 2,
        isLive: true,
        live: {
          isLive: true,
          safeSeekStartMs: 1000,
          safeSeekEndMs: 50000,
          playableEndMs: 55000,
        },
        streamEpoch: 1720000000000,
        serverMediaTimeMs: 45000,
      },
    };

    await client.refreshNow();
    const ctx = client.getLatestContext();
    assert.equal(ctx.isLive, true);
    assert.equal(ctx.safeSeekStartMs, 1000);
    assert.equal(ctx.safeSeekEndMs, 50000);
    assert.equal(ctx.playableEndMs, 55000);
    assert.equal(ctx.streamEpoch, 1720000000000);
    assert.equal(ctx.serverMediaTimeMs, 45000);
  });
});
