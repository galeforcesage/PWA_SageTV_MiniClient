import test from 'node:test';
import assert from 'node:assert/strict';

import { InputManager } from './input-manager.js';
import { PlayerState, SageCommand } from '../protocol/constants.js';

function createManager({ tizen = true, state = PlayerState.PLAY, menuActive = true, values = {} } = {}) {
  globalThis.document = {
    getElementById: () => null,
    dispatchEvent: () => true,
  };
  const connection = {
    alive: true,
    isMenuActive: () => menuActive,
    mediaPlayer: {
      state,
      isVideoFullscreen: () => true,
    },
    sendCommand() {},
  };
  const target = { querySelector: () => null };
  const settings = {
    get(key, fallback) {
      return Object.hasOwn(values, key) ? values[key] : fallback;
    },
  };
  return new InputManager(target, connection, {
    platformDetector: { isTizen: () => tizen },
    settings,
  });
}

test('Tizen playing mappings ignore frequent SageTV-NG graphics flips', () => {
  const manager = createManager({ state: PlayerState.PLAY, menuActive: true });

  assert.deepEqual(manager._arrowTransport(SageCommand.LEFT), {
    tap: SageCommand.REW.id,
    hold: SageCommand.REW_2.id,
  });
  assert.deepEqual(manager._arrowTransport(SageCommand.RIGHT), {
    tap: SageCommand.FF.id,
    hold: SageCommand.FF_2.id,
  });
});

test('Tizen default mappings use transport commands that also page menus', () => {
  const manager = createManager({ state: 'stopped', menuActive: true });

  assert.deepEqual(manager._arrowTransport(SageCommand.LEFT), {
    tap: SageCommand.REW.id,
    hold: SageCommand.REW_2.id,
  });
  assert.deepEqual(manager._arrowTransport(SageCommand.RIGHT), {
    tap: SageCommand.FF.id,
    hold: SageCommand.FF_2.id,
  });
});

test('Tizen paused mappings are independently configurable', () => {
  const manager = createManager({
    state: PlayerState.PAUSE,
    values: {
      tizen_paused_left: 'Page Left',
      tizen_paused_left_long: 'Skip Bkwd/Page Left',
    },
  });

  assert.deepEqual(manager._arrowTransport(SageCommand.LEFT), {
    tap: SageCommand.PAGE_LEFT.id,
    hold: SageCommand.REW.id,
  });
});

test('non-Tizen clients retain the existing menu heuristic', () => {
  const manager = createManager({
    tizen: false,
    state: PlayerState.PLAY,
    menuActive: true,
  });

  assert.deepEqual(manager._arrowTransport(SageCommand.LEFT), {
    tap: SageCommand.LEFT.id,
    hold: SageCommand.PAGE_LEFT.id,
  });
});
