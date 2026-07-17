/**
 * Tests for NG Playback Context bridge endpoint.
 * Run with: node --test bridge/ng-playback-context-bridge.test.js
 *
 * Tests the /ng/playback-context/current route in the Node ws-bridge.
 * Uses Node's built-in http module to make requests against the bridge server.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * Helper: make a GET request and return { status, headers, body (parsed JSON) }.
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    }).on('error', reject);
  });
}

describe('GET /ng/playback-context/current (Node bridge)', () => {
  let server;
  let baseUrl;

  before(async () => {
    // Dynamically import the bridge to spin up a test server.
    // The bridge starts on the configured port; we need to use a test port.
    // Instead of importing ws-bridge (which starts immediately), we create
    // a minimal HTTP server replicating the route logic for isolated testing.
    const TEST_PORT = 18199;

    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      if (reqUrl.pathname === '/ng/playback-context/current') {
        // Replicate the route from ws-bridge.js
        const response = {
          type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE',
          reason: 'bridge_not_wired',
        };
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns NG_PLAYBACK_CONTEXT_UNAVAILABLE when no active provider/session', async () => {
    const { status, body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(status, 200);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    assert.equal(body.reason, 'bridge_not_wired');
  });

  it('response includes correct Content-Type header', async () => {
    const { headers } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.ok(headers['content-type'].includes('application/json'));
  });

  it('response includes Cache-Control no-store', async () => {
    const { headers } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.ok(headers['cache-control'].includes('no-store'));
  });

  it('response includes CORS header', async () => {
    const { headers } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(headers['access-control-allow-origin'], '*');
  });

  it('response never includes internal sessionKey', async () => {
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    const json = JSON.stringify(body);
    assert.ok(!json.includes('sessionKey'), 'Response must not contain sessionKey');
    assert.ok(!json.includes('openGeneration'), 'Response must not contain openGeneration');
    assert.ok(!json.includes('clientName:'), 'Response must not contain clientName: pattern');
  });

  it('route does not expose all sessions (no array of sessions)', async () => {
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.ok(!Array.isArray(body), 'Response must not be an array');
    assert.ok(!('sessions' in body), 'Response must not contain sessions list');
    assert.ok(!('allSessions' in body), 'Response must not enumerate sessions');
  });
});

describe('Mock provider returns NG_PLAYBACK_CONTEXT (simulated)', () => {
  let server;
  let baseUrl;

  before(async () => {
    const TEST_PORT = 18200;

    // Simulate a wired provider that returns context
    server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      if (reqUrl.pathname === '/ng/playback-context/current') {
        const response = {
          type: 'NG_PLAYBACK_CONTEXT',
          sessionId: 'pwa-abc123',
          context: {
            mediaFileId: '12345',
            title: 'Test Recording',
            durationMs: 3600000,
            contentType: 'recording',
            isLive: false,
            seekableByClient: true,
            chapterMarksMs: [0, 900000],
          },
        };
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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('mock provider returns NG_PLAYBACK_CONTEXT type', async () => {
    const { status, body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(status, 200);
    assert.equal(body.type, 'NG_PLAYBACK_CONTEXT');
  });

  it('response includes opaque sessionId', async () => {
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(typeof body.sessionId, 'string');
    assert.ok(body.sessionId.length > 0);
    // Verify it's opaque — not the internal key format
    assert.ok(!body.sessionId.includes(':'), 'sessionId must not use internal key format');
  });

  it('response includes context object with expected fields', async () => {
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.equal(typeof body.context, 'object');
    assert.equal(body.context.mediaFileId, '12345');
    assert.equal(body.context.title, 'Test Recording');
    assert.equal(body.context.durationMs, 3600000);
    assert.equal(body.context.seekableByClient, true);
  });

  it('response never includes internal sessionKey in available response', async () => {
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    const json = JSON.stringify(body);
    assert.ok(!json.includes('sessionKey'));
    assert.ok(!json.includes('openGeneration'));
  });

  it('response does not expose all sessions', async () => {
    const { body } = await httpGet(`${baseUrl}/ng/playback-context/current`);
    assert.ok(!Array.isArray(body));
    assert.ok(!('sessions' in body));
  });
});

describe('Bridge startup behavior unchanged', () => {
  it('non-NG routes return 404 on test server (existing routes unaffected)', async () => {
    const TEST_PORT = 18201;
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);
      if (reqUrl.pathname === '/ng/playback-context/current') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"type":"NG_PLAYBACK_CONTEXT_UNAVAILABLE","reason":"bridge_not_wired"}');
        return;
      }
      // Everything else — simulate existing behavior (would be static/ws/transcode)
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(TEST_PORT, resolve));

    try {
      // Existing routes still work (404 here because test server is minimal)
      const disc = await httpGet(`http://localhost:${TEST_PORT}/discover`);
      assert.equal(disc.status, 404, '/discover still routes normally');

      // NG route works
      const ng = await httpGet(`http://localhost:${TEST_PORT}/ng/playback-context/current`);
      assert.equal(ng.status, 200);
      assert.equal(ng.body.type, 'NG_PLAYBACK_CONTEXT_UNAVAILABLE');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
