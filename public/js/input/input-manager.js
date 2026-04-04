/**
 * SageTV MiniClient Input Manager
 *
 * Maps keyboard, gamepad, pointer/touch events to SageTV protocol events.
 * Handles:
 * - Keyboard → SageCommand or raw keystroke events
 * - Gamepad API → SageCommand (DPAD navigation)
 * - Pointer/Touch → Mouse events (scaled to server coordinates)
 *
 * Port of: android-shared input handling + SageCommand.java mappings
 */

import { SageCommand, EventType } from '../protocol/constants.js';

// ── Keyboard → SageCommand mapping ─────────────────────────
// Only non-typeable keys that should trigger direct SageTV actions.
// Printable characters (letters, numbers, space, symbols) are sent as
// raw keystrokes (KB_EVENT) so the SageTV text components can process them.

const KEY_TO_COMMAND = {
  'ArrowLeft':    SageCommand.LEFT,
  'ArrowRight':   SageCommand.RIGHT,
  'ArrowUp':      SageCommand.UP,
  'ArrowDown':    SageCommand.DOWN,
  'Enter':        SageCommand.SELECT,
  'Escape':       SageCommand.BACK,
  'Home':         SageCommand.HOME,
  'End':          SageCommand.OPTIONS,
  'PageUp':       SageCommand.PAGE_UP,
  'PageDown':     SageCommand.PAGE_DOWN,
  'F1':           SageCommand.INFO,
  'F2':           SageCommand.OPTIONS,
  'F3':           SageCommand.SEARCH,
  'F4':           SageCommand.GUIDE,
  'F10':          SageCommand.POWER,
  'F11':          SageCommand.FULL_SCREEN,
  'MediaPlayPause': SageCommand.PLAY_PAUSE,
  'MediaPlay':    SageCommand.PLAY,
  'MediaPause':   SageCommand.PAUSE,
  'MediaStop':    SageCommand.STOP,
  'MediaFastForward': SageCommand.FF,
  'MediaRewind':  SageCommand.REW,
  'MediaTrackNext':   SageCommand.FF_2,
  'MediaTrackPrevious': SageCommand.REW_2,
  'AudioVolumeUp':   SageCommand.VOLUME_UP,
  'AudioVolumeDown': SageCommand.VOLUME_DOWN,
  'AudioVolumeMute': SageCommand.MUTE,
};

// ── Keyboard KeyCode → Java KeyEvent mapping ───────────────
// Maps DOM event.code to java.awt.event.KeyEvent constants

const DOM_TO_JAVA_KEYCODE = {
  'ArrowLeft':  37,   // VK_LEFT
  'ArrowRight': 39,   // VK_RIGHT
  'ArrowUp':    38,   // VK_UP
  'ArrowDown':  40,   // VK_DOWN
  'Enter':      10,   // VK_ENTER
  'Escape':     27,   // VK_ESCAPE
  'Backspace':  8,    // VK_BACK_SPACE
  'Tab':        9,    // VK_TAB
  'Space':      32,   // VK_SPACE
  'Delete':     127,  // VK_DELETE
  'Home':       36,   // VK_HOME
  'End':        35,   // VK_END
  'PageUp':     33,   // VK_PAGE_UP
  'PageDown':   34,   // VK_PAGE_DOWN
  'F1':         112,  'F2':  113, 'F3':  114, 'F4':  115,
  'F5':         116,  'F6':  117, 'F7':  118, 'F8':  119,
  'F9':         120,  'F10': 121, 'F11': 122, 'F12': 123,
  'ShiftLeft':  16,   'ShiftRight': 16,
  'ControlLeft': 17,  'ControlRight': 17,
  'AltLeft':    18,   'AltRight': 18,
  'MetaLeft':   157,  'MetaRight': 157,
};

// A-Z keys
for (let i = 65; i <= 90; i++) {
  const letter = String.fromCharCode(i);
  DOM_TO_JAVA_KEYCODE[`Key${letter}`] = i;
}

// 0-9 keys
for (let i = 0; i <= 9; i++) {
  DOM_TO_JAVA_KEYCODE[`Digit${i}`] = 48 + i;
}

// ── Java InputEvent modifier flags ─────────────────────────
const SHIFT_DOWN_MASK   = 0x0040;
const CTRL_DOWN_MASK    = 0x0080;
const ALT_DOWN_MASK     = 0x0200;
const META_DOWN_MASK    = 0x0100;
const BUTTON1_DOWN_MASK = 0x0400;
const BUTTON2_DOWN_MASK = 0x0800;
const BUTTON3_DOWN_MASK = 0x1000;

function domModsToJava(event) {
  let mods = 0;
  if (event.shiftKey) mods |= SHIFT_DOWN_MASK;
  if (event.ctrlKey)  mods |= CTRL_DOWN_MASK;
  if (event.altKey)   mods |= ALT_DOWN_MASK;
  if (event.metaKey)  mods |= META_DOWN_MASK;
  return mods;
}

// ── Gamepad → SageCommand mapping ──────────────────────────
// Standard Gamepad API button indices
const GAMEPAD_BUTTON_MAP = {
  0:  SageCommand.SELECT,       // A / Cross
  1:  SageCommand.BACK,         // B / Circle
  2:  SageCommand.OPTIONS,      // X / Square
  3:  SageCommand.INFO,         // Y / Triangle
  4:  SageCommand.REW,          // L1
  5:  SageCommand.FF,           // R1
  8:  SageCommand.BACK,         // Select/Share
  9:  SageCommand.OPTIONS,      // Start/Options
  12: SageCommand.UP,           // D-pad Up
  13: SageCommand.DOWN,         // D-pad Down
  14: SageCommand.LEFT,         // D-pad Left
  15: SageCommand.RIGHT,        // D-pad Right
  16: SageCommand.HOME,         // Guide/Home
};

export class InputManager {
  /**
   * @param {HTMLElement} target - Element to listen on (usually the canvas container)
   * @param {MiniClientConnection} connection - Protocol connection for sending events
   */
  constructor(target, connection) {
    this.target = target;
    this.connection = connection;

    // Scale factors for pointer events (canvas coords vs server coords)
    this.scaleX = 1;
    this.scaleY = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // Gamepad polling
    this._gamepadInterval = null;
    this._gamepadPrevButtons = {};

    // Touch state
    this._lastTouchX = 0;
    this._lastTouchY = 0;

    // Keyboard long-press repeat handling
    this._heldKeys = new Set();

    // Hidden text input for soft keyboard on mobile/iPad
    this._textInput = document.getElementById('sage-text-input');
    this._hasTextInput = false;
  }

  /**
   * Start listening for all input events.
   */
  start() {
    // Keyboard
    document.addEventListener('keydown', this._onKeyDown.bind(this));
    document.addEventListener('keyup', this._onKeyUp.bind(this));

    // Pointer (mouse + touch unified)
    this.target.addEventListener('pointerdown', this._onPointerDown.bind(this));
    this.target.addEventListener('pointerup', this._onPointerUp.bind(this));
    this.target.addEventListener('pointermove', this._onPointerMove.bind(this));
    this.target.addEventListener('wheel', this._onWheel.bind(this), { passive: false });

    // Touch gestures for navigation (swipe)
    this.target.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: false });
    this.target.addEventListener('touchend', this._onTouchEnd.bind(this), { passive: false });

    // Context menu prevention
    this.target.addEventListener('contextmenu', (e) => e.preventDefault());

    // Hidden text input for soft keyboard — capture input events
    if (this._textInput) {
      this._onTextInputHandler = this._onTextInput.bind(this);
      this._onTextInputKeyHandler = this._onTextInputKey.bind(this);
      this._textInput.addEventListener('input', this._onTextInputHandler);
      this._textInput.addEventListener('keydown', this._onTextInputKeyHandler);
    }

    // Listen for MENU_HINT from connection to show/hide soft keyboard
    this._onMenuHintHandler = (e) => this._onMenuHint(e.detail);
    this.connection.addEventListener('menuhint', this._onMenuHintHandler);

    // Gamepad polling
    this._startGamepadPolling();

    console.log('[InputManager] Started');
  }

  /**
   * Stop all input listeners.
   */
  stop() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    if (this._textInput && this._onTextInputHandler) {
      this._textInput.removeEventListener('input', this._onTextInputHandler);
      this._textInput.removeEventListener('keydown', this._onTextInputKeyHandler);
    }
    if (this._onMenuHintHandler) {
      this.connection.removeEventListener('menuhint', this._onMenuHintHandler);
    }
    this._hideTextInput();
    this._stopGamepadPolling();
    console.log('[InputManager] Stopped');
  }

  /**
   * Update coordinate scale (call when canvas resizes).
   * @param {number} canvasWidth - Display width of canvas element
   * @param {number} canvasHeight - Display height of canvas element
   * @param {number} serverWidth - Server-side resolution width
   * @param {number} serverHeight - Server-side resolution height
   */
  updateScale(canvasWidth, canvasHeight, serverWidth, serverHeight) {
    this.scaleX = serverWidth / canvasWidth;
    this.scaleY = serverHeight / canvasHeight;
  }

  /**
   * Convert DOM pointer coordinates to server coordinates.
   */
  _toServerCoords(clientX, clientY) {
    const rect = this.target.getBoundingClientRect();
    const x = Math.round((clientX - rect.left) * this.scaleX);
    const y = Math.round((clientY - rect.top) * this.scaleY);
    return { x, y };
  }

  // ── Keyboard ──────────────────────────────────────────────

  _onKeyDown(event) {
    // Let browser handle its own shortcuts
    if (event.key === 'F12' || event.key === 'F5') return;
    if ((event.ctrlKey || event.metaKey) &&
        'rRlLiIjJtTwWnN'.includes(event.key)) return;

    const keyChar = event.key.length === 1 ? event.key.charCodeAt(0) : 0;

    // ── 1. Printable characters → raw keystroke (typing) ──
    // This includes letters, numbers, space, and all symbols.
    // The SageTV TextComponent processes these for text input.
    if (keyChar && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const javaKeyCode = DOM_TO_JAVA_KEYCODE[event.code] || 0;
      const mods = domModsToJava(event);
      this.connection.sendKeystroke(javaKeyCode, keyChar, mods);
      return;
    }

    // ── 2. Text-editing keys → raw keystroke ──
    // Backspace, Delete, Tab: sent as raw keystrokes so the SageTV
    // TextComponent can handle them (delete char, move fields).
    // When no text field is focused, the STVi key table maps them
    // to navigation (Backspace → Back, etc.).
    if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
      event.preventDefault();
      const javaKeyCode = DOM_TO_JAVA_KEYCODE[event.code] || 0;
      const mods = domModsToJava(event);
      this.connection.sendKeystroke(javaKeyCode, 0, mods);
      return;
    }

    // ── 3. Navigation/control keys → SageCommand ──
    // Arrows, Enter, Escape, F-keys, media keys: send as SageCommand
    // for reliable navigation. Block repeats to prevent flooding.
    const cmd = KEY_TO_COMMAND[event.key] || KEY_TO_COMMAND[event.code];
    if (cmd) {
      event.preventDefault();
      if (this._heldKeys.has(event.code)) return;
      this._heldKeys.add(event.code);
      this.connection.sendCommand(cmd.id);
      return;
    }

    // ── 4. Ctrl/Alt combos → raw keystroke ──
    const javaKeyCode = DOM_TO_JAVA_KEYCODE[event.code] || 0;
    const mods = domModsToJava(event);
    if (javaKeyCode || keyChar) {
      event.preventDefault();
      this.connection.sendKeystroke(javaKeyCode, keyChar, mods);
    }
  }

  _onKeyUp(event) {
    this._heldKeys.delete(event.code);
  }

  // ── Pointer (Mouse/Touch) ────────────────────────────────

  _onPointerDown(event) {
    event.preventDefault();
    const { x, y } = this._toServerCoords(event.clientX, event.clientY);
    const mods = domModsToJava(event);
    const button = event.button === 0 ? 1 : event.button === 2 ? 3 : 2;

    this.connection.sendMouseEvent(EventType.MOUSE_PRESSED, x, y, mods, button, 1);
  }

  _onPointerUp(event) {
    event.preventDefault();
    const { x, y } = this._toServerCoords(event.clientX, event.clientY);
    const mods = domModsToJava(event);
    const button = event.button === 0 ? 1 : event.button === 2 ? 3 : 2;

    this.connection.sendMouseEvent(EventType.MOUSE_RELEASED, x, y, mods, button, 1);
    this.connection.sendMouseEvent(EventType.MOUSE_CLICKED, x, y, mods, button, 1);
  }

  _onPointerMove(event) {
    // Only send move events occasionally to avoid flooding
    if (event.movementX === 0 && event.movementY === 0) return;
    const { x, y } = this._toServerCoords(event.clientX, event.clientY);
    const mods = domModsToJava(event);
    const eventType = event.buttons ? EventType.MOUSE_DRAGGED : EventType.MOUSE_MOVED;
    this.connection.sendMouseEvent(eventType, x, y, mods, 0, 0);
  }

  _onWheel(event) {
    event.preventDefault();
    const { x, y } = this._toServerCoords(event.clientX, event.clientY);
    const mods = domModsToJava(event);

    // Scroll wheel → channel up/down or page up/down
    if (event.deltaY < 0) {
      this.connection.sendCommand(SageCommand.PAGE_UP.id);
    } else if (event.deltaY > 0) {
      this.connection.sendCommand(SageCommand.PAGE_DOWN.id);
    }
  }

  // ── Touch Gestures (for iPad/phone) ──────────────────────

  _onTouchStart(event) {
    if (event.touches.length === 1) {
      this._lastTouchX = event.touches[0].clientX;
      this._lastTouchY = event.touches[0].clientY;
    }
  }

  _onTouchEnd(event) {
    if (event.changedTouches.length === 1) {
      const touch = event.changedTouches[0];
      const dx = touch.clientX - this._lastTouchX;
      const dy = touch.clientY - this._lastTouchY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Swipe detection (minimum 50px)
      if (dist > 50) {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angle > -45 && angle < 45) {
          this.connection.sendCommand(SageCommand.RIGHT.id);
        } else if (angle > 135 || angle < -135) {
          this.connection.sendCommand(SageCommand.LEFT.id);
        } else if (angle < -45 && angle > -135) {
          this.connection.sendCommand(SageCommand.UP.id);
        } else {
          this.connection.sendCommand(SageCommand.DOWN.id);
        }
        event.preventDefault();
      }
      // Short taps are handled by pointer events
    }
  }

  // ── Soft Keyboard / Hidden Text Input ────────────────────

  /**
   * Respond to MENU_HINT from the server.
   * When hasTextInput is true, focus the hidden input to trigger soft keyboard.
   */
  _onMenuHint(hint) {
    this._hasTextInput = hint.hasTextInput;
    if (hint.hasTextInput) {
      this._showTextInput();
    } else {
      this._hideTextInput();
    }
  }

  /**
   * Focus a hidden <input> element so mobile/iPad soft keyboards appear.
   * On iOS Safari, focusing an input is the ONLY way to show the keyboard.
   */
  _showTextInput() {
    if (!this._textInput) return;
    // Move on-screen briefly for iOS (must be "visible" at focus time)
    this._textInput.style.left = '0';
    this._textInput.style.opacity = '0.01';
    this._textInput.style.pointerEvents = 'auto';
    this._textInput.value = '';
    this._textInput.focus({ preventScroll: true });
    // Move offscreen again after keyboard opens
    setTimeout(() => {
      if (this._textInput) {
        this._textInput.style.left = '-9999px';
        this._textInput.style.opacity = '0';
        this._textInput.style.pointerEvents = 'none';
      }
    }, 300);
    console.log('[InputManager] Soft keyboard requested (hasTextInput=true)');
  }

  _hideTextInput() {
    if (!this._textInput) return;
    this._textInput.blur();
    this._textInput.style.left = '-9999px';
    this._textInput.style.opacity = '0';
    this._textInput.style.pointerEvents = 'none';
  }

  /**
   * Handle typed characters from the hidden input (mobile soft keyboard).
   * Each character inserted is sent as a keystroke to the server.
   */
  _onTextInput(event) {
    const text = event.data;
    if (!text) return;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      // Use uppercase char as keyCode (matching Android miniclient)
      const upper = text[i].toUpperCase().charCodeAt(0);
      const javaKeyCode = (upper >= 65 && upper <= 90) ? upper : (upper >= 48 && upper <= 57) ? upper : 0;
      this.connection.sendKeystroke(javaKeyCode, ch, 0);
    }
    // Clear input so next character triggers another event
    this._textInput.value = '';
  }

  /**
   * Handle special keys (Backspace, Enter, Tab) on the hidden input.
   */
  _onTextInputKey(event) {
    if (event.key === 'Backspace') {
      event.preventDefault();
      this.connection.sendKeystroke(8, 0, 0); // VK_BACK_SPACE
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this._hideTextInput();
      this.connection.sendCommand(SageCommand.SELECT.id);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.connection.sendKeystroke(9, 0, 0); // VK_TAB
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this._hideTextInput();
      this.connection.sendCommand(SageCommand.BACK.id);
    }
  }

  // ── Gamepad ──────────────────────────────────────────────

  _startGamepadPolling() {
    window.addEventListener('gamepadconnected', (e) => {
      console.log(`[InputManager] Gamepad connected: ${e.gamepad.id}`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      console.log(`[InputManager] Gamepad disconnected: ${e.gamepad.id}`);
    });

    this._gamepadInterval = setInterval(() => this._pollGamepads(), 50);
  }

  _stopGamepadPolling() {
    if (this._gamepadInterval) {
      clearInterval(this._gamepadInterval);
      this._gamepadInterval = null;
    }
  }

  _pollGamepads() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (const gp of gamepads) {
      if (!gp) continue;

      const prevButtons = this._gamepadPrevButtons[gp.index] || {};

      // Check buttons
      for (const [btnIdx, cmd] of Object.entries(GAMEPAD_BUTTON_MAP)) {
        const pressed = gp.buttons[btnIdx] && gp.buttons[btnIdx].pressed;
        const wasPressed = prevButtons[btnIdx] || false;

        if (pressed && !wasPressed) {
          this.connection.sendCommand(cmd.id);
        }
      }

      // Check analog sticks (axes) for navigation
      // Left stick: axes[0] = horizontal, axes[1] = vertical
      const DEADZONE = 0.5;
      const leftX = gp.axes[0] || 0;
      const leftY = gp.axes[1] || 0;
      const prevLeftX = (prevButtons._axisX) || 0;
      const prevLeftY = (prevButtons._axisY) || 0;

      if (leftX > DEADZONE && !(prevLeftX > DEADZONE)) {
        this.connection.sendCommand(SageCommand.RIGHT.id);
      } else if (leftX < -DEADZONE && !(prevLeftX < -DEADZONE)) {
        this.connection.sendCommand(SageCommand.LEFT.id);
      }
      if (leftY > DEADZONE && !(prevLeftY > DEADZONE)) {
        this.connection.sendCommand(SageCommand.DOWN.id);
      } else if (leftY < -DEADZONE && !(prevLeftY < -DEADZONE)) {
        this.connection.sendCommand(SageCommand.UP.id);
      }

      // Save state
      const newState = {};
      for (let i = 0; i < gp.buttons.length; i++) {
        newState[i] = gp.buttons[i] && gp.buttons[i].pressed;
      }
      newState._axisX = leftX;
      newState._axisY = leftY;
      this._gamepadPrevButtons[gp.index] = newState;
    }
  }
}
