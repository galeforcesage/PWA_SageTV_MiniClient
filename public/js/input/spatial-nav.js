/**
 * Universal D-pad / arrow-key spatial navigation for the chrome
 * (connect screen, dialogs, menus). Active on every surface — TV remotes,
 * keyboard arrows on desktop, gamepads, etc.
 *
 * Inactive while the SageTV playback canvas owns input — the input-manager
 * forwards keys to the server during a live session, and we must not steal
 * them. Detection: when the `#client-screen.active` is present and no modal
 * overlay is visible, we bail.
 *
 * Inactive while typing in a text input/textarea so the caret keys still
 * work normally.
 */

const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([hidden])',
  'a[href]:not([hidden])',
  'input:not([type="hidden"]):not([disabled]):not([hidden])',
  'select:not([disabled]):not([hidden])',
  'textarea:not([disabled]):not([hidden])',
  'summary',
  '[tabindex]:not([tabindex="-1"]):not([hidden])',
  '.server-card',
].join(',');

const BACK_KEYS = new Set(['Escape', 'XF86Back', 'Back', 'BrowserBack', 'GoBack']);
const BACK_KEYCODES = new Set([27, 10009, 461]);
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export class SpatialNavigation {
  constructor(options = {}) {
    this._enabled = false;
    this._debug = !!options.debug;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onFocusIn = this._onFocusIn.bind(this);
    this._lastFocused = null;
  }

  start() {
    if (this._enabled) return;
    this._enabled = true;
    document.addEventListener('keydown', this._onKeyDown, true);
    document.addEventListener('focusin', this._onFocusIn, true);
    // Ensure something is focused so the first arrow press has a starting point.
    queueMicrotask(() => this._ensureFocus());
  }

  stop() {
    if (!this._enabled) return;
    this._enabled = false;
    document.removeEventListener('keydown', this._onKeyDown, true);
    document.removeEventListener('focusin', this._onFocusIn, true);
  }

  /**
   * Move focus to a sensible starting element for the current scope.
   * Call this after dynamically rendering content (e.g., server grid) or
   * when a screen becomes visible.
   */
  refresh() {
    queueMicrotask(() => this._ensureFocus(true));
  }

  _onFocusIn(ev) {
    if (this._isFocusable(ev.target)) this._lastFocused = ev.target;
  }

  _onKeyDown(ev) {
    if (!this._enabled) return;
    if (ev.defaultPrevented) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;

    const scope = this._activeScope();
    if (!scope) return; // playback owns input

    const key = ev.key;
    const code = ev.code;
    const kc = ev.keyCode;

    const isBack = BACK_KEYS.has(key) || BACK_KEYS.has(code) || BACK_KEYCODES.has(kc);
    const isEnter = key === 'Enter' || code === 'Enter' || code === 'NumpadEnter' || kc === 13;
    const dir = this._arrowDir(key, code, kc);

    if (!isBack && !isEnter && !dir) return;

    const active = document.activeElement;
    const inTextField = this._isTextLikeInput(active);

    // Let arrows move the caret in text fields. Up/Down can still escape to
    // the next focusable when at the field boundary, but for simplicity we
    // just yield to native behavior.
    if (dir && inTextField) return;

    // Enter inside a text field should submit / native behavior — but for
    // password-style submit, let buttons handle it. We yield by default.
    if (isEnter && inTextField && active.tagName === 'TEXTAREA') return;

    if (isBack) {
      if (this._closeTopModal(scope)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }

    if (isEnter) {
      const target = active && this._isFocusable(active) ? active : this._firstIn(scope);
      if (!target) return;
      if (target.tagName === 'INPUT' && !TEXT_INPUT_TYPES.has((target.type || '').toLowerCase())) {
        // checkbox/radio/button — native click
        target.click();
      } else if (target.matches('a, button, summary, .server-card, [role="button"]')) {
        target.click();
        ev.preventDefault();
      } else if (inTextField) {
        // text input: let native submit
        return;
      } else {
        target.click();
      }
      ev.stopPropagation();
      return;
    }

    if (dir) {
      const from = active && this._isFocusable(active) && scope.contains(active)
        ? active
        : (this._lastFocused && scope.contains(this._lastFocused) ? this._lastFocused : this._firstIn(scope));
      if (!from) return;
      const next = this._findNeighbor(from, dir, scope);
      if (next) {
        next.focus({ preventScroll: false });
        ev.preventDefault();
        ev.stopPropagation();
        if (this._debug) console.log('[Spatnav]', dir, '->', next);
      }
    }
  }

  _arrowDir(key, code, kc) {
    if (key === 'ArrowLeft' || code === 'ArrowLeft' || kc === 37) return 'left';
    if (key === 'ArrowRight' || code === 'ArrowRight' || kc === 39) return 'right';
    if (key === 'ArrowUp' || code === 'ArrowUp' || kc === 38) return 'up';
    if (key === 'ArrowDown' || code === 'ArrowDown' || kc === 40) return 'down';
    return null;
  }

  _isTextLikeInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return TEXT_INPUT_TYPES.has(t);
    }
    return el.isContentEditable === true;
  }

  /**
   * Find the active navigation scope (a container element). Returns null
   * when playback owns input (no modal visible and #client-screen is active).
   */
  _activeScope() {
    // Highest-priority modal scope first.
    const modals = Array.from(document.querySelectorAll('.modal-overlay'))
      .filter((m) => !m.hidden && m.offsetParent !== null);
    if (modals.length) return modals[modals.length - 1];

    // Drawer/menu panels that mark themselves with aria-hidden="false".
    const drawer = document.querySelector('[data-spatnav-scope]:not([hidden])');
    if (drawer && drawer.offsetParent !== null) return drawer;

    const client = document.getElementById('client-screen');
    if (client && client.classList.contains('active')) return null; // playback owns

    const connect = document.getElementById('connect-screen');
    if (connect && connect.classList.contains('active')) return connect;

    return document.body;
  }

  _isFocusable(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.hidden) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    if (!el.matches(FOCUSABLE_SELECTOR)) return false;
    return true;
  }

  _firstIn(scope) {
    const list = this._focusableIn(scope);
    return list[0] || null;
  }

  _focusableIn(scope) {
    return Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((el) => this._isFocusable(el));
  }

  _ensureFocus(force = false) {
    const scope = this._activeScope();
    if (!scope) return;
    const active = document.activeElement;
    if (!force && active && active !== document.body && this._isFocusable(active) && scope.contains(active)) return;
    const first = this._firstIn(scope);
    if (first) first.focus({ preventScroll: false });
  }

  _closeTopModal(scope) {
    if (!scope || !scope.classList || !scope.classList.contains('modal-overlay')) return false;
    // Prefer an explicit cancel button.
    const cancel = scope.querySelector('[data-spatnav-cancel], #dlg-cancel, .modal-cancel, [data-action="cancel"]');
    if (cancel) { cancel.click(); return true; }
    // Fallback: hide the modal directly.
    scope.hidden = true;
    return true;
  }

  /**
   * Find the nearest focusable in `dir` from `from`, restricted to `scope`.
   * Uses a directional weight: forward-distance dominates, perpendicular
   * offset is a tie-breaker. Avoids picking the current element.
   */
  _findNeighbor(from, dir, scope) {
    const candidates = this._focusableIn(scope).filter((el) => el !== from);
    if (!candidates.length) return null;

    const a = from.getBoundingClientRect();
    const aCx = a.left + a.width / 2;
    const aCy = a.top + a.height / 2;

    let best = null;
    let bestScore = Infinity;

    for (const el of candidates) {
      const b = el.getBoundingClientRect();
      const bCx = b.left + b.width / 2;
      const bCy = b.top + b.height / 2;

      let forward, perpendicular;
      if (dir === 'left')  { forward = aCx - bCx; perpendicular = Math.abs(bCy - aCy); }
      else if (dir === 'right') { forward = bCx - aCx; perpendicular = Math.abs(bCy - aCy); }
      else if (dir === 'up')    { forward = aCy - bCy; perpendicular = Math.abs(bCx - aCx); }
      else                      { forward = bCy - aCy; perpendicular = Math.abs(bCx - aCx); }

      // Must be in the requested direction with at least 1px of separation.
      if (forward <= 1) continue;
      // Strongly prefer candidates whose bounding box overlaps perpendicularly.
      const perpOverlap = (dir === 'left' || dir === 'right')
        ? Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
        : Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const overlapBonus = perpOverlap > 0 ? 0 : 1;
      const score = forward + perpendicular * 2 + overlapBonus * 1000;

      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
}
