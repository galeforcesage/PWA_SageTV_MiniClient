import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasInstalledRelatedWebApp,
  supportsManualInstallInstructions,
} from './install-detection.js';

test('returns false when installed-related-app detection is unavailable', async () => {
  assert.equal(await hasInstalledRelatedWebApp({}), false);
});

test('detects an installed related web app', async () => {
  const installed = await hasInstalledRelatedWebApp({
    getInstalledRelatedApps: async () => [
      { platform: 'play', id: 'example.native' },
      { platform: 'webapp', id: '/' },
    ],
  });

  assert.equal(installed, true);
});

test('does not treat a related native app as the installed PWA', async () => {
  const installed = await hasInstalledRelatedWebApp({
    getInstalledRelatedApps: async () => [
      { platform: 'play', id: 'example.native' },
    ],
  });

  assert.equal(installed, false);
});

test('propagates detection failures so the caller can preserve fallback behavior', async () => {
  await assert.rejects(
    hasInstalledRelatedWebApp({
      getInstalledRelatedApps: async () => {
        throw new Error('not allowed');
      },
    }),
    /not allowed/,
  );
});

test('iOS Safari supports manual install instructions', () => {
  assert.equal(supportsManualInstallInstructions({
    userAgent: 'Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
  }), true);
  assert.equal(supportsManualInstallInstructions({
    userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }), true);
});

test('desktop and unsupported browsers do not get manual install instructions', () => {
  assert.equal(supportsManualInstallInstructions({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    platform: 'Win32',
    maxTouchPoints: 0,
  }), false);
  assert.equal(supportsManualInstallInstructions({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/143.0',
    platform: 'Win32',
    maxTouchPoints: 0,
  }), false);
  assert.equal(supportsManualInstallInstructions({
    userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  }), false);
});
