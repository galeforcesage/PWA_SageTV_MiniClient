import test from 'node:test';
import assert from 'node:assert/strict';

import { hasInstalledRelatedWebApp } from './install-detection.js';

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
