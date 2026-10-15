import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniClientConnection } from './connection.js';

function withNavigatorVendor(vendor, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { vendor },
  });
  try {
    callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'navigator', descriptor);
    } else {
      delete globalThis.navigator;
    }
  }
}

test('native HLS delivery is advertised only for supported Apple WebKit surfaces', () => {
  const connection = Object.create(MiniClientConnection.prototype);
  const nativeHlsVideo = {
    canPlayType: (mime) => mime === 'application/vnd.apple.mpegurl' ? 'maybe' : '',
  };

  connection.platformDetector = { isTizen: () => false, isIOS: () => false };
  withNavigatorVendor('Apple Computer, Inc.', () => {
    assert.equal(connection._getNativeDeliveryModes(nativeHlsVideo), 'pull,pull-xcode,hls');
  });

  withNavigatorVendor('Google Inc.', () => {
    assert.equal(connection._getNativeDeliveryModes(nativeHlsVideo), 'pull,pull-xcode');
  });

  connection.platformDetector = { isTizen: () => true, isIOS: () => false };
  withNavigatorVendor('Apple Computer, Inc.', () => {
    assert.equal(connection._getNativeDeliveryModes(nativeHlsVideo), 'pull,pull-xcode');
  });
});

test('effective routing decision preserves values before clearing session state', () => {
  const connection = Object.create(MiniClientConnection.prototype);
  connection._effectiveDelivery = 'pull-xcode:browserhd';
  connection._effectiveSurface = 'pwa_native';

  assert.deepEqual(connection._consumeEffectiveRoutingDecision(), {
    delivery: 'pull-xcode:browserhd',
    surface: 'pwa_native',
  });
  assert.equal(connection._effectiveDelivery, '');
  assert.equal(connection._effectiveSurface, '');
});

test('trick-play capabilities omit the reserved seek epoch token', () => {
  const connection = Object.create(MiniClientConnection.prototype);
  connection.platformDetector = { getNgDownloadCapabilities: () => [] };

  const capabilities = connection._buildDownloadCapabilities().split(',');
  assert.ok(capabilities.includes('TRICKPLAY_POSITION_V1'));
  assert.ok(capabilities.includes('DVR_WINDOW_V1'));
  assert.ok(!capabilities.includes('SEEK_EPOCH_V1'));
  assert.equal(connection._resolveProperty('SEEK_EPOCH_V1'), '');
});
