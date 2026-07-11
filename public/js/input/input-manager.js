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

import { SageCommand, EventType, PlayerState } from '../protocol/constants.js';
import { TizenInputAdapter } from './tizen-input-adapter.js';

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
  constructor(target, connection, options = {}) {
    this.target = target;
    this.connection = connection;
    this.platformDetector = options.platformDetector || null;
    // The canvas element for accurate coordinate mapping
    this._canvas = target.querySelector('canvas') || target;

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
    // Tizen long-press-OK state: defers SELECT until keyup so a hold can
    // instead open the on-screen nav overlay. Non-Tizen keeps the immediate
    // SELECT on keydown.
    this._tizenSelectTimer = null;
    this._tizenSelectSuppress = false;
    this._TIZEN_LONGPRESS_MS = 550;
    // Context-aware arrow tap/hold: hold threshold (ms) + active-hold state.
    this._ARROW_HOLD_MS = 450;
    this._arrowHold = null;
    this._arrowHoldTimer = null;

    // Hidden text input for soft keyboard on mobile/iPad
    this._textInput = document.getElementById('sage-text-input');
    this._hasTextInput = false;
    this._tizenAdapter = new TizenInputAdapter(this.platformDetector);
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
    this.scaleX = canvasWidth > 0 ? serverWidth / canvasWidth : 1;
    this.scaleY = canvasHeight > 0 ? serverHeight / canvasHeight : 1;
  }

  /**
   * Convert DOM pointer coordinates to server coordinates.
   */
  _toServerCoords(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    const x = Math.round((clientX - rect.left) * this.scaleX);
    const y = Math.round((clientY - rect.top) * this.scaleY);
    return { x, y };
  }

  // ── Keyboard ──────────────────────────────────────────────

  _onKeyDown(event) {
    const tizenNorm = this._tizenAdapter.normalize(event);
    const effectiveKey = tizenNorm?.key || event.key;
    const effectiveCode = tizenNorm?.code || event.code;

    // Let browser handle its own shortcuts
    if (event.key === 'F12' || event.key === 'F5') return;
    if ((event.ctrlKey || event.metaKey) &&
        'rRlLiIjJtTwWnN'.includes(event.key)) return;

    // Tizen: never intercept volume keys — let the TV control its own volume.
    // Registration was already dropped in the platform detector; this guard
    // covers models that deliver these anyway (or if a stale install still
    // has them registered when the fresh code first runs).
    if (this._tizenAdapter.isEnabled()) {
      const rawKey = String(event.key || '');
      if (rawKey === 'VolumeUp' || rawKey === 'VolumeDown' || rawKey === 'VolumeMute' ||
          rawKey === 'AudioVolumeUp' || rawKey === 'AudioVolumeDown' || rawKey === 'AudioVolumeMute') {
        return;
      }
    }

    const keyChar = effectiveKey.length === 1 ? effectiveKey.charCodeAt(0) : 0;

    // ── 1. Printable characters → raw keystroke (typing) ──
    // This includes letters, numbers, space, and all symbols.
    // The SageTV TextComponent processes these for text input.
    if (keyChar && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const javaKeyCode = DOM_TO_JAVA_KEYCODE[effectiveCode] || 0;
      const mods = domModsToJava(event);
      this.connection.sendKeystroke(javaKeyCode, keyChar, mods);
      return;
    }

    // ── 2. Text-editing keys → raw keystroke ──
    // Backspace, Delete, Tab: sent as raw keystrokes so the SageTV
    // TextComponent can handle them (delete char, move fields).
    // When no text field is focused, the STVi key table maps them
    // to navigation (Backspace → Back, etc.).
    if (effectiveKey === 'Backspace' || effectiveKey === 'Delete' || effectiveKey === 'Tab') {
      event.preventDefault();
      const javaKeyCode = DOM_TO_JAVA_KEYCODE[effectiveCode] || 0;
      const mods = domModsToJava(event);
      this.connection.sendKeystroke(javaKeyCode, 0, mods);
      return;
    }

    // ── 3. Navigation/control keys → SageCommand ──
    // Arrows, Enter, Escape, F-keys, media keys: send as SageCommand
    // for reliable navigation. Block repeats to prevent flooding.
    const cmd = KEY_TO_COMMAND[effectiveKey] || KEY_TO_COMMAND[effectiveCode];
    if (cmd) {
      event.preventDefault();
      if (this._heldKeys.has(effectiveCode)) return;
      this._heldKeys.add(effectiveCode);

      // Tizen: for OK/Enter, defer SELECT to keyup so a long-press can
      // instead surface the on-screen nav drawer (dpad + playback controls).
      // Short tap (< _TIZEN_LONGPRESS_MS) fires SELECT on release.
      if (this._tizenAdapter.isEnabled() && effectiveKey === 'Enter') {
        this._tizenSelectSuppress = false;
        if (this._tizenSelectTimer) clearTimeout(this._tizenSelectTimer);
        this._tizenSelectTimer = setTimeout(() => {
          this._tizenSelectTimer = null;
          this._tizenSelectSuppress = true;
          try {
            document.dispatchEvent(new CustomEvent('sagetv:open-nav-drawer'));
          } catch { /* ignore */ }
        }, this._TIZEN_LONGPRESS_MS);
        return;
      }

      // Context-aware arrow keys (all platforms, in-session): TAP = one step,
      // HOLD = a bigger step. In menus HOLD pages in that direction; during
      // video playback Left/Right become REW/FF (tap) and boundary jumps
      // REW_2/FF_2 (hold). Resolved on keyup / the hold timer so we never send
      // both the tap and the hold action.
      const arrowSpec = (this.connection && this.connection.alive)
        ? this._arrowTransport(cmd) : null;
      if (arrowSpec) {
        this._arrowHold = { key: effectiveCode, tap: arrowSpec.tap, hold: arrowSpec.hold, fired: false };
        if (this._arrowHoldTimer) clearTimeout(this._arrowHoldTimer);
        this._arrowHoldTimer = setTimeout(() => {
          this._arrowHoldTimer = null;
          if (this._arrowHold) {
            this._arrowHold.fired = true;
            this.connection.sendCommand(this._arrowHold.hold);
          }
        }, this._ARROW_HOLD_MS);
        return;
      }

      this.connection.sendCommand(cmd.id);
      return;
    }

    // ── 4. Ctrl/Alt combos → raw keystroke ──
    const javaKeyCode = DOM_TO_JAVA_KEYCODE[effectiveCode] || 0;
    const mods = domModsToJava(event);
    if (javaKeyCode || keyChar) {
      event.preventDefault();
      this.connection.sendKeystroke(javaKeyCode, keyChar, mods);
    }
  }

  _onKeyUp(event) {
    const tizenNorm = this._tizenAdapter.isEnabled() ? this._tizenAdapter.normalize(event) : null;
    const effectiveCode = tizenNorm?.code || event.code;
    const effectiveKey = tizenNorm?.key || event.key;
    this._heldKeys.delete(event.code);
    this._heldKeys.delete(effectiveCode);

    // Context-aware arrow tap/hold release: if the hold timer is still pending
    // this was a short TAP → send the tap command. If the hold already fired we
    // did the bigger action (page / boundary jump) and must not also tap.
    if (this._arrowHold &&
        (this._arrowHold.key === effectiveCode || this._arrowHold.key === event.code)) {
      if (this._arrowHoldTimer) { clearTimeout(this._arrowHoldTimer); this._arrowHoldTimer = null; }
      if (!this._arrowHold.fired) this.connection.sendCommand(this._arrowHold.tap);
      this._arrowHold = null;
    }

    // Tizen deferred-SELECT: fire SELECT on release if the long-press timer is
    // still pending (short tap); otherwise the timer already opened the nav
    // drawer and we suppress the SELECT.
    if (this._tizenAdapter.isEnabled() && effectiveKey === 'Enter') {
      if (this._tizenSelectTimer) {
        clearTimeout(this._tizenSelectTimer);
        this._tizenSelectTimer = null;
        if (!this._tizenSelectSuppress) {
          this.connection.sendCommand(SageCommand.SELECT.id);
        }
      }
      this._tizenSelectSuppress = false;
    }
  }

  /** True when a media file is actively loaded/playing/paused (video context). */
  _inPlayback() {
    const mp = this.connection && this.connection.mediaPlayer;
    if (!mp) return false;
    const s = mp.state;
    return s === PlayerState.LOADED || s === PlayerState.PLAY || s === PlayerState.PAUSE;
  }

  /**
   * Map an arrow SageCommand to its { tap, hold } command ids for the current
   * context, or null for non-arrow commands (which send immediately).
   *   Menu:     Up/Down/Left/Right  → tap = step,   hold = Page in that direction
   *   Playback: Left/Right          → tap = REW/FF, hold = REW_2/FF_2 (jump)
   *   Playback: Up/Down             → same as menu (step / page)
   */
  _arrowTransport(cmd) {
    switch (cmd) {
      case SageCommand.UP:
        return { tap: SageCommand.UP.id, hold: SageCommand.PAGE_UP.id };
      case SageCommand.DOWN:
        return { tap: SageCommand.DOWN.id, hold: SageCommand.PAGE_DOWN.id };
      case SageCommand.LEFT:
        return this._inPlayback()
          ? { tap: SageCommand.REW.id, hold: SageCommand.REW_2.id }
          : { tap: SageCommand.LEFT.id, hold: SageCommand.PAGE_LEFT.id };
      case SageCommand.RIGHT:
        return this._inPlayback()
          ? { tap: SageCommand.FF.id, hold: SageCommand.FF_2.id }
          : { tap: SageCommand.RIGHT.id, hold: SageCommand.PAGE_RIGHT.id };
      default:
        return null;
    }
  }

  // ── Pointer (Mouse/Touch) ────────────────────────────────

  _onPointerDown(event) {
    if (this._hasTextInput && this.platformDetector?.isIOS?.() && event.pointerType !== 'mouse') {
      this._showTextInput();
    }

    event.preventDefault();
    const { x, y } = this._toServerCoords(event.clientX, event.clientY);
    const mods = domModsToJava(event);
    const button = event.button === 0 ? 1 : event.button === 2 ? 3 : 2;
    console.log(`[Input] Click: client(${event.clientX},${event.clientY}) → server(${x},${y}), scale(${this.scaleX.toFixed(3)},${this.scaleY.toFixed(3)}), rect=${JSON.stringify(this.target.getBoundingClientRect())}`);
    // Send MOUSE_MOVED first so the STV updates focus/hover to the target
    // position before the click. Without this, list items don't get
    // selected because the STV's hit-test uses the last known cursor pos.
    this.connection.sendMouseEvent(EventType.MOUSE_MOVED, x, y, 0, 0, 0);
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
    // Throttle moves to ~30/sec to avoid flooding the server
    const now = performance.now();
    if (now - (this._lastMoveTime || 0) < 33) return;
    this._lastMoveTime = now;
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
