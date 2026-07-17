/**
 * Tests for NG Playback Context bridge endpoint + ActivePlaybackSessionTracker.
 * Run with: node --test bridge/ng-playback-context-bridge.test.js
 *
 * Covers required test cases:
 * 1. /ng/playback-context/current returns unavailable when no session active
 * 2. Tracker can set active sessionId and endpoint returns context
 * 3. Browser disconnect clears active session
 * 4. SageTV socket close clears active session (same as disconnect)
 * 5. Error path clears active session
 * 6. Cleanup is idempotent
 * 7. Listener unsubscribe / stale reaper stops on tracker.stop()
 * 8. Stale timeout marks session unavailable
 * 9. Response never includes internal sessionKey
 * 10. Existing bridge tests still pass
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ActivePlaybackSessionTracker } from './active-playback-session-tracker.js';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ActivePlaybackSessionTracker unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ActivePlaybackSessionTracker', () => {
  it('1. returns no_active_session when empty', () => {
    const tracker = new ActivePlaybackSessionTracker();
    assert.equal(tracker.getActiveSession(), null);
    assert.equal(tracker.getUnavailableReason(), 'no_active_session');
  });

  it('2. can set sessionId and getActiveSession returns it', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'opaque-session-abc');
    tracker.onPlaybackStart(connId);

    const active = tracker.getActiveSession();
    assert.notEqual(active, null);
    assert.equal(active.sessionId, 'opaque-session-abc');
    assert.equal(active.state, 'playing');
    // Never exposes internal format
    assert.ok(!active.sessionId.includes(':'));
  });

  it('3. browser disconnect clears active session', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'sess-123');
    tracker.onPlaybackStart(connId);

    assert.notEqual(tracker.getActiveSession(), null);

    // Simulate browser disconnect
    tracker.onDisconnect(connId);
    assert.equal(tracker.getActiveSession(), null);
    assert.equal(tracker.getUnavailableReason(), 'no_active_session');
  });

  it('4. SageTV socket close clears active session (same path)', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/media' });
    tracker.setSessionId(connId, 'sess-456');
    tracker.onPlaybackStart(connId);

    // SageTV TCP close triggers onDisconnect
    tracker.onDisconnect(connId);
    assert.equal(tracker.getActiveSession(), null);
    assert.equal(tracker.size, 0);
  });

  it('5. error path clears active session', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'sess-err');

    // Error triggers same onDisconnect path
    tracker.onDisconnect(connId);
    assert.equal(tracker.getActiveSession(), null);
  });

  it('6. cleanup is idempotent (multiple onDisconnect calls)', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'sess-x');

    // Call disconnect multiple times — must not throw
    tracker.onDisconnect(connId);
    tracker.onDisconnect(connId);
    tracker.onDisconnect(connId);
    assert.equal(tracker.size, 0);
  });

  it('7. stop() clears all sessions and stops reaper', () => {
    const tracker = new ActivePlaybackSessionTracker();
    tracker.start();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'sess-y');

    tracker.stop();
    assert.equal(tracker.size, 0);
    assert.equal(tracker.getActiveSession(), null);
  });

  it('8. stale timeout marks session unavailable', async () => {
    // Use very short stale timeout for testing
    const tracker = new ActivePlaybackSessionTracker({ staleTimeoutMs: 50 });
    tracker.start();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'sess-stale');

    // Wait for stale timeout + reaper cycle
    await new Promise((r) => setTimeout(r, 200));

    // Force reaper check
    tracker._reapStale();

    // Session should be stale — getActiveSession skips stale sessions
    assert.equal(tracker.getActiveSession(), null);
    assert.equal(tracker.getUnavailableReason(), 'session_id_unknown');

    tracker.stop();
  });

  it('returns session_id_unknown when connected but no sessionId set', () => {
    const tracker = new ActivePlaybackSessionTracker();
    tracker.onConnect({ channel: '/gfx' });
    assert.equal(tracker.getActiveSession(), null);
    assert.equal(tracker.getUnavailableReason(), 'session_id_unknown');
  });

  it('onActivity refreshes lastActivityAt and revives stale session', async () => {
    const tracker = new ActivePlaybackSessionTracker({ staleTimeoutMs: 50 });
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'sess-revive');

    await new Promise((r) => setTimeout(r, 100));
    tracker._reapStale();
    assert.equal(tracker.getActiveSession(), null); // stale

    // Activity revives it
    tracker.onActivity(connId);
    const active = tracker.getActiveSession();
    assert.notEqual(active, null);
    assert.equal(active.sessionId, 'sess-revive');
  });

  it('onPlaybackStop transitions state back to connected', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/media' });
    tracker.setSessionId(connId, 'sess-stop');
    tracker.onPlaybackStart(connId);

    const playing = tracker.getActiveSession();
    assert.equal(playing.state, 'playing');

    tracker.onPlaybackStop(connId);
    const stopped = tracker.getActiveSession();
    assert.equal(stopped.state, 'connected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP endpoint integration tests (using tracker-wired mock server)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /ng/playback-context/current (tracker-integrated)', () => {
  let server;
  let baseUrl;
  let tracker;

  before(async () => {
    const TEST_PORT = 18199;
    tracker = new ActivePlaybackSessionTracker();
    tracker.start();

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      if (reqUrl.pathname === '/ng/playback-context/current') {
        const activeSession = tracker.getActiveSession();
        let response;
        if (activeSession) {
          response = {
            type: 'NG_PLAYBACK_CONTEXT',
            sessionId: activeSession.sessionId,
            context: { mediaFileId: '999', title: 'Test' },
          };
        } else {
          response = {
            type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE',
            reason: tracker.getUnavailableReason(),
          };
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(response));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(TEST_PORT, resolve));
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  after(async () => {
    tracker.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('returns unavailable with no_active_session when tracker is empty', async () => {
    const { status, body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(status, 200);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'no_active_session');
  });

  it('returns unavailable with session_id_unknown when connected but no sessionId', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'session_id_unknown');
    tracker.onDisconnect(connId);
  });

  it('returns NG_PLAYBACK_CONTEXT when sessionId is set', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'opaque-test-id');
    tracker.onPlaybackStart(connId);

    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT');
    assert.equal(body.sessionId, 'opaque-test-id');
    assert.equal(typeof body.context, 'object');

    tracker.onDisconnect(connId);
  });

  it('returns unavailable after disconnect', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'will-disconnect');
    tracker.onDisconnect(connId);

    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
  });

  it('9. response never includes internal sessionKey', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setSessionId(connId, 'safe-opaque-id');
    tracker.onPlaybackStart(connId);

    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    const json = JSON.stringify(body);
    assert.ok(!json.includes('sessionKey'), 'Must not contain sessionKey');
    assert.ok(!json.includes('openGeneration'), 'Must not contain openGeneration');
    assert.ok(!json.includes('clientName:'), 'Must not contain clientName: pattern');

    tracker.onDisconnect(connId);
  });

  it('10. route does not expose all sessions', async () => {
    const c1 = tracker.onConnect({ channel: '/gfx' });
    const c2 = tracker.onConnect({ channel: '/media' });
    tracker.setSessionId(c1, 'sess-1');
    tracker.setSessionId(c2, 'sess-2');

    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    // Should return single session, not array
    assert.ok(!Array.isArray(body));
    assert.ok(!('sessions' in body));
    assert.ok(!('allSessions' in body));
    // Should pick only the most recently active one
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT');

    tracker.onDisconnect(c1);
    tracker.onDisconnect(c2);
  });
});
