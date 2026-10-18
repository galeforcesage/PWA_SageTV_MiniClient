import test from 'node:test';
import assert from 'node:assert/strict';

import { canOfferAppWindow, openAppWindow } from './app-window.js';

function browserWindow(overrides = {}) {
  return {
    open: () => ({}),
    opener: null,
    name: '',
    navigator: {},
    matchMedia: () => ({ matches: false }),
    ...overrides,
  };
}

test('offers an app window only from an ordinary browser page', () => {
  assert.equal(canOfferAppWindow(browserWindow()), true);
  assert.equal(canOfferAppWindow(browserWindow({ tizen: {} })), false);
  assert.equal(canOfferAppWindow(browserWindow({ opener: {} })), false);
  assert.equal(canOfferAppWindow(browserWindow({ name: 'sagetv-pwa-app' })), false);
  assert.equal(canOfferAppWindow(browserWindow({
    matchMedia: () => ({ matches: true }),
  })), false);
  assert.equal(canOfferAppWindow(browserWindow({
    navigator: { standalone: true },
  })), false);
});

test('opens a full-screen-sized popup and focuses it', () => {
  let openArgs;
  let focused = false;
  const windowObject = browserWindow({
    location: { href: 'https://example.test/' },
    screen: { availWidth: 1920, availHeight: 1040 },
    open: (...args) => {
      openArgs = args;
      return { focus: () => { focused = true; } };
    },
  });

  const popup = openAppWindow(windowObject);

  assert.ok(popup);
  assert.equal(openArgs[0], 'https://example.test/');
  assert.equal(openArgs[1], 'sagetv-pwa-app');
  assert.match(openArgs[2], /popup=yes/);
  assert.match(openArgs[2], /width=1920/);
  assert.match(openArgs[2], /height=1040/);
  assert.equal(focused, true);
});

test('returns null when the browser blocks the popup', () => {
  const windowObject = browserWindow({
    location: { href: 'https://example.test/' },
    open: () => null,
  });

  assert.equal(openAppWindow(windowObject), null);
});
