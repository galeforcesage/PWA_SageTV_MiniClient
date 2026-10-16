import test from 'node:test';
import assert from 'node:assert/strict';

import { InputManager } from './input-manager.js';
import { PlayerState, SageCommand } from '../protocol/constants.js';

function createManager({
  tizen = true,
  state = PlayerState.PLAY,
  menuActive = true,
  mediaOpen = true,
  values = {},
} = {}) {
  globalThis.document = {
    getElementById: () => null,
    dispatchEvent: () => true,
  };
  const connection = {
    alive: true,
    isMenuActive: () => menuActive,
    isMediaOpen: () => mediaOpen,
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

test('Tizen falls back to customized default mappings when media ownership closes', () => {
  const manager = createManager({
    state: PlayerState.PLAY,
    mediaOpen: false,
    values: {
      tizen_default_right: 'Home',
      tizen_playing_right: 'Skip Fwd/Page Right',
    },
  });

  assert.equal(manager._tizenRemoteContext(), 'default');
  assert.deepEqual(manager._arrowTransport(SageCommand.RIGHT), {
    tap: SageCommand.HOME.id,
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
