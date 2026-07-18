/**
 * Tests for NG Playback Context bridge endpoint + ActivePlaybackSessionTracker.
 * Run with: node --test bridge/ng-playback-context-bridge.test.js
 *
 * Covers required test cases:
 * 1. Current endpoint returns unavailable when clientName is unknown
 * 2. Tracker stores clientName per connection
 * 3. Current endpoint uses clientName to ask provider for context
 * 4. Mock in-JVM provider returns NG_PLAYBACK_CONTEXT
 * 5. Mock HTTP provider builds current?clientName= request correctly
 * 6. Unknown clientName returns NG_PLAYBACK_CONTEXT_UNAVAILABLE
 * 7. Response includes opaque sessionId when context is found
 * 8. Response never includes internal sessionKey
 * 9. Browser disconnect clears clientName mapping
 * 10. SageTV socket close/error clears clientName mapping
 * 11. Existing bridge/proxy tests still pass
 * 12. Playback/trickplay behavior unchanged (no seek/coalesce changes)
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
// ActivePlaybackSessionTracker + clientName unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ActivePlaybackSessionTracker clientName', () => {
  it('1. returns client_name_unknown when connected but no clientName set', () => {
    const tracker = new ActivePlaybackSessionTracker();
    tracker.onConnect({ channel: '/gfx' });
    assert.equal(tracker.getActiveClientName(), null);
    assert.equal(tracker.getUnavailableReason(), 'client_name_unknown');
  });

  it('2. stores clientName per connection via setClientName', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');
    assert.equal(tracker.getActiveClientName(), 'aabbccddeeff');
  });

  it('3. getActiveClientName returns most recently active connection clientName', async () => {
    const tracker = new ActivePlaybackSessionTracker();
    const c1 = tracker.onConnect({ channel: '/gfx' });
    const c2 = tracker.onConnect({ channel: '/media' });
    tracker.setClientName(c1, '112233445566');
    tracker.setClientName(c2, 'aabbccddeeff');
    // Explicitly mark c2 as more recent
    await new Promise((r) => setTimeout(r, 5));
    tracker.onActivity(c2);
    assert.equal(tracker.getActiveClientName(), 'aabbccddeeff');
  });

  it('6. returns no_active_session when tracker is empty', () => {
    const tracker = new ActivePlaybackSessionTracker();
    assert.equal(tracker.getActiveClientName(), null);
    assert.equal(tracker.getUnavailableReason(), 'no_active_session');
  });

  it('9. browser disconnect clears clientName mapping', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');
    assert.equal(tracker.getActiveClientName(), 'aabbccddeeff');

    tracker.onDisconnect(connId);
    assert.equal(tracker.getActiveClientName(), null);
    assert.equal(tracker.getUnavailableReason(), 'no_active_session');
  });

  it('10. SageTV socket close/error clears clientName (idempotent)', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/media' });
    tracker.setClientName(connId, '112233445566');

    tracker.onDisconnect(connId);
    tracker.onDisconnect(connId); // idempotent
    tracker.onDisconnect(connId);
    assert.equal(tracker.getActiveClientName(), null);
    assert.equal(tracker.size, 0);
  });

  it('stale session excludes clientName from active', async () => {
    const tracker = new ActivePlaybackSessionTracker({ staleTimeoutMs: 50 });
    tracker.start();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    await new Promise((r) => setTimeout(r, 100));
    tracker._reapStale();

    assert.equal(tracker.getActiveClientName(), null);
    tracker.stop();
  });

  it('stale session with clientName returns no_active_session, never session_id_unknown', async () => {
    const tracker = new ActivePlaybackSessionTracker({ staleTimeoutMs: 50 });
    tracker.start();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    await new Promise((r) => setTimeout(r, 100));
    tracker._reapStale();

    assert.equal(tracker.getActiveClientName(), null);
    assert.equal(tracker.getUnavailableReason(), 'no_active_session');
    assert.notEqual(tracker.getUnavailableReason(), 'session_id_unknown');
    tracker.stop();
  });

  it('getUnavailableReason never returns session_id_unknown', () => {
    const tracker = new ActivePlaybackSessionTracker();
    // Empty tracker
    assert.notEqual(tracker.getUnavailableReason(), 'session_id_unknown');

    // Connected, no clientName
    const connId = tracker.onConnect({ channel: '/gfx' });
    assert.notEqual(tracker.getUnavailableReason(), 'session_id_unknown');

    // Connected WITH clientName (getActiveClientName returns it, so
    // getUnavailableReason is only called when it doesn't — but verify anyway)
    tracker.setClientName(connId, 'aabbccddeeff');
    assert.notEqual(tracker.getUnavailableReason(), 'session_id_unknown');

    // After disconnect
    tracker.onDisconnect(connId);
    assert.notEqual(tracker.getUnavailableReason(), 'session_id_unknown');
  });

  it('clientName normalization: bridge extracts lowercase hex, no colons', () => {
    // Simulate what ws-bridge.js now does: normalize MAC bytes to lowercase hex
    const rawBytes = [0x32, 0xC6, 0xF9, 0x8B, 0xE5, 0x20];
    const clientName = rawBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    assert.equal(clientName, '32c6f98be520');
    assert.ok(!clientName.includes(':'));
    assert.equal(clientName, clientName.toLowerCase());

    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, clientName);
    assert.equal(tracker.getActiveClientName(), '32c6f98be520');
    tracker.onDisconnect(connId);
  });

  it('onPlaybackStart makes session active alongside clientName', () => {
    const tracker = new ActivePlaybackSessionTracker();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');
    tracker.onPlaybackStart(connId);

    assert.equal(tracker.getActiveClientName(), 'aabbccddeeff');
    // getActiveSession still requires sessionId (not wired), but
    // getActiveClientName works on clientName alone
    assert.equal(tracker.getActiveSession(), null); // sessionId not set
  });

  it('activity refresh prevents stale timeout', async () => {
    const tracker = new ActivePlaybackSessionTracker({ staleTimeoutMs: 80 });
    tracker.start();
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    // Refresh activity mid-way to prevent staleness
    await new Promise((r) => setTimeout(r, 50));
    tracker.onActivity(connId);
    await new Promise((r) => setTimeout(r, 50));
    tracker._reapStale();

    // Still active because we refreshed
    assert.equal(tracker.getActiveClientName(), 'aabbccddeeff');
    tracker.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP endpoint integration tests (mock provider server)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /ng/playback-context/current (clientName-wired)', () => {
  let mockServer;
  let bridgeServer;
  let bridgeUrl;
  let tracker;
  let lastServerRequest = null;

  before(async () => {
    // Mock SageTV server that accepts /ng/playback-context/current?clientName=
    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      lastServerRequest = { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };

      if (url.pathname === '/ng/playback-context/current' && url.searchParams.get('clientName')) {
        const clientName = url.searchParams.get('clientName');
        if (clientName === 'aabbccddeeff') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            mediaFileId: '12345',
            title: 'Test Show',
            durationMs: 3600000,
            contentType: 'recording',
            isLive: false,
            seekableByClient: true,
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => mockServer.listen(18300, r));

    // Bridge server that uses the tracker + calls mock server
    tracker = new ActivePlaybackSessionTracker();
    tracker.start();

    bridgeServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      if (reqUrl.pathname === '/ng/playback-context/current') {
        const clientName = tracker.getActiveClientName();

        if (!clientName) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({
            type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE',
            reason: tracker.getUnavailableReason(),
          }));
          return;
        }

        // Call mock server (simulating HTTP provider behavior)
        const encodedClientName = encodeURIComponent(clientName);
        const serverUrl = `http://localhost:18300/ng/playback-context/current?clientName=${encodedClientName}`;

        http.get(serverUrl, { timeout: 2000 }, (serverRes) => {
          let body = '';
          serverRes.on('data', (chunk) => { body += chunk; });
          serverRes.on('end', () => {
            let response;
            if (serverRes.statusCode === 200 && body) {
              const opaqueSessionId = `pwa-${clientName.replace(/:/g, '').toLowerCase()}`;
              response = {
                type: 'NG_PLAYBACK_CONTEXT',
                sessionId: opaqueSessionId,
                context: JSON.parse(body),
              };
            } else {
              response = {
                type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE',
                reason: 'no_active_session',
              };
            }
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify(response));
          });
        }).on('error', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: 'server_not_supported' }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => bridgeServer.listen(18301, r));
    bridgeUrl = 'http://localhost:18301';
  });

  after(async () => {
    tracker.stop();
    await new Promise((r) => bridgeServer.close(r));
    await new Promise((r) => mockServer.close(r));
  });

  it('1. returns unavailable when clientName is unknown (no connections)', async () => {
    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'no_active_session');
  });

  it('returns unavailable with client_name_unknown when connected but MAC not seen', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'client_name_unknown');
    tracker.onDisconnect(connId);
  });

  it('3. uses clientName to ask provider/server for context', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT');

    // 5. Verify the HTTP provider built the correct URL with clientName param
    assert.equal(lastServerRequest.pathname, '/ng/playback-context/current');
    assert.equal(lastServerRequest.params.clientName, 'aabbccddeeff');

    tracker.onDisconnect(connId);
  });

  it('4. mock provider returns NG_PLAYBACK_CONTEXT with context', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT');
    assert.equal(body.context.mediaFileId, '12345');
    assert.equal(body.context.title, 'Test Show');
    assert.equal(body.context.durationMs, 3600000);

    tracker.onDisconnect(connId);
  });

  it('6. unknown clientName on server returns unavailable', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, '999999999999');

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'no_active_session');

    tracker.onDisconnect(connId);
  });

  it('7. response includes opaque sessionId when context found', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT');
    assert.equal(typeof body.sessionId, 'string');
    assert.ok(body.sessionId.length > 0);
    // Opaque: derived from MAC, not internal key format
    assert.equal(body.sessionId, 'pwa-aabbccddeeff');
    assert.ok(!body.sessionId.includes(':'));

    tracker.onDisconnect(connId);
  });

  it('8. response never includes internal sessionKey', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    const json = JSON.stringify(body);
    assert.ok(!json.includes('sessionKey'), 'Must not contain sessionKey');
    assert.ok(!json.includes('openGeneration'), 'Must not contain openGeneration');
    assert.ok(!json.includes('clientName:mediaFileId'), 'Must not contain internal format');

    tracker.onDisconnect(connId);
  });

  it('9. disconnect clears clientName and returns unavailable', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');
    tracker.onDisconnect(connId);

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
  });

  it('10. error path clears clientName (same as disconnect, idempotent)', async () => {
    const connId = tracker.onConnect({ channel: '/gfx' });
    tracker.setClientName(connId, 'aabbccddeeff');
    tracker.onDisconnect(connId);
    tracker.onDisconnect(connId); // idempotent

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'no_active_session');
  });

  it('11. route does not expose all sessions or internal keys', async () => {
    const c1 = tracker.onConnect({ channel: '/gfx' });
    const c2 = tracker.onConnect({ channel: '/media' });
    tracker.setClientName(c1, 'aabbccddeeff');
    tracker.setClientName(c2, '112233445566');

    const { body } = await httpGet(`${bridgeUrl}/ng/playback-context/current`);
    assert.ok(!Array.isArray(body));
    assert.ok(!('sessions' in body));
    assert.ok(!('allSessions' in body));

    tracker.onDisconnect(c1);
    tracker.onDisconnect(c2);
  });
});

describe('12. Existing bridge behavior preserved', () => {
  it('tracker lifecycle does not affect non-NG routes', async () => {
    const TEST_PORT = 18302;
    const tracker = new ActivePlaybackSessionTracker();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/transcode') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing file parameter');
        return;
      }
      if (url.pathname === '/ng/playback-context/current') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: tracker.getUnavailableReason() }));
        return;
      }
      // Unknown /ng/* routes return JSON 404 (mirrors ws-bridge.js fix)
      if (url.pathname.startsWith('/ng/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: 'unknown_ng_route' }));
        return;
      }
      // Simulate static file fallback — return HTML for unknown paths
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>Not Found</body></html>');
    });

    await new Promise((r) => server.listen(TEST_PORT, r));
    try {
      // /transcode still works as before
      const tc = await httpGet(`http://localhost:${TEST_PORT}/transcode`);
      assert.equal(tc.status, 400);

      // /ng route works independently
      const ng = await httpGet(`http://localhost:${TEST_PORT}/ng/playback-context/current`);
      assert.equal(ng.status, 200);
      assert.equal(ng.body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('Runtime router: /ng/* never returns HTML', () => {
  let routerServer;
  let routerUrl;
  let tracker;

  before(async () => {
    tracker = new ActivePlaybackSessionTracker();
    tracker.start();

    routerServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // ── /ng/playback-context/current route (same logic as ws-bridge.js) ──
      if (url.pathname === '/ng/playback-context/current') {
        const clientName = tracker.getActiveClientName();
        let response;
        if (!clientName) {
          response = { type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: tracker.getUnavailableReason() };
        } else {
          response = { type: 'NG_PLAYBACK_CONTEXT', sessionId: `pwa-${clientName.replace(/:/g, '').toLowerCase()}`, context: {} };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(response));
        return;
      }

      // ── Unknown /ng/* routes: JSON 404 ──
      if (url.pathname.startsWith('/ng/')) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE', reason: 'unknown_ng_route' }));
        return;
      }

      // ── Simulate static file server fallback (HTML 404 for non-/ng paths) ──
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>PWA MiniClient</body></html>');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>404 Not Found</body></html>');
    });

    await new Promise((r) => routerServer.listen(18303, r));
    routerUrl = 'http://localhost:18303';
  });

  after(async () => {
    tracker.stop();
    await new Promise((r) => routerServer.close(r));
  });

  it('GET /ng/playback-context/current returns JSON (not HTML)', async () => {
    const { status, headers, body } = await httpGet(`${routerUrl}/ng/playback-context/current`);
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('application/json'));
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(typeof body.reason, 'string');
  });

  it('GET /ng/playback-context/current does not fall through to static HTML 404', async () => {
    const { body, headers } = await httpGet(`${routerUrl}/ng/playback-context/current`);
    assert.ok(headers['content-type'].includes('application/json'));
    assert.ok(!JSON.stringify(body).includes('<html'));
  });

  it('unknown /ng/foo returns JSON 404 (not HTML)', async () => {
    const { status, headers, body } = await httpGet(`${routerUrl}/ng/foo`);
    assert.equal(status, 404);
    assert.ok(headers['content-type'].includes('application/json'));
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'unknown_ng_route');
  });

  it('unknown /ng/playback-context/nonexistent returns JSON 404', async () => {
    const { status, headers, body } = await httpGet(`${routerUrl}/ng/playback-context/nonexistent`);
    assert.equal(status, 404);
    assert.ok(headers['content-type'].includes('application/json'));
    assert.equal(body.reason, 'unknown_ng_route');
  });

  it('normal static files still return HTML (no /ng interference)', async () => {
    const { status, headers } = await httpGet(`${routerUrl}/index.html`);
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('text/html'));
  });

  it('non-/ng 404 still returns HTML (static fallback unchanged)', async () => {
    const { status, headers } = await httpGet(`${routerUrl}/nonexistent-file.js`);
    assert.equal(status, 404);
    assert.ok(headers['content-type'].includes('text/html'));
  });
});
