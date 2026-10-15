import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateTizenTransportDefaults } from './settings-manager.js';

function createStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

test('migrates the previous Tizen menu transport defaults', () => {
  const storage = createStorage({
    sagetv_tizen_default_left: 'Left',
    sagetv_tizen_default_right: 'Right',
    sagetv_tizen_default_left_long: 'Page Left',
    sagetv_tizen_default_right_long: 'Page Right',
  });

  migrateTizenTransportDefaults(storage);

  assert.equal(storage.getItem('sagetv_tizen_default_left'), 'Skip Bkwd/Page Left');
  assert.equal(storage.getItem('sagetv_tizen_default_right'), 'Skip Fwd/Page Right');
  assert.equal(storage.getItem('sagetv_tizen_default_left_long'), 'Skip Bkwd #2');
  assert.equal(storage.getItem('sagetv_tizen_default_right_long'), 'Skip Fwd #2');
});

test('preserves customized Tizen menu mappings', () => {
  const storage = createStorage({
    sagetv_tizen_default_left: 'Home',
    sagetv_tizen_default_right: 'Guide',
  });

  migrateTizenTransportDefaults(storage);

  assert.equal(storage.getItem('sagetv_tizen_default_left'), 'Home');
  assert.equal(storage.getItem('sagetv_tizen_default_right'), 'Guide');
});
