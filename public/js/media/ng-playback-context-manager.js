/**
 * NG Playback Context Manager
 *
 * Per-connection holder for the current NgPlaybackContext. Receives context
 * data from the server via SET_PROPERTY "NG_PLAYBACK_CONTEXT", stores it, and
 * fires change events for subscribers.
 *
 * Lifecycle:
 *   - Created when a connection is established
 *   - Receives context via onPropertyReceived() when server sends SET_PROPERTY
 *   - Tracks media open/close via onMediaOpen() / onMediaClose()
 *   - Destroyed when the connection closes
 *
 * Against a legacy server (9.2.16 or earlier), this store is created but
 * getCurrent() always returns null — no new code paths activate.
 *
 * Mirrors: core/src/main/java/sagex/miniclient/ngcontext/NgPlaybackContextManager.java
 * (uses EventTarget instead of IBus for event dispatch)
 */

import { NgPlaybackContextParser } from './ng-playback-context-parser.js';

export class NgPlaybackContextManager extends EventTarget {
  constructor() {
    super();
    /** @type {import('./ng-playback-context.js').NgPlaybackContext|null} */
    this._current = null;
    /** @type {string|null} URL from the most recent MEDIACMD_OPENURL */
    this._lastOpenUrl = null;
  }

  /**
   * Get the current playback context, or null if no playback / legacy server.
   * @returns {import('./ng-playback-context.js').NgPlaybackContext|null}
   */
  getCurrent() {
    return this._current;
  }

  /**
   * Called when SET_PROPERTY "NG_PLAYBACK_CONTEXT" arrives from the server.
   * Parses the wire value and updates the stored context.
   * @param {string} wireValue — the pipe-delimited context string
   */
  onPropertyReceived(wireValue) {
    const previous = this._current;
    const parsed = NgPlaybackContextParser.parse(wireValue, this._lastOpenUrl);

    if (!parsed) {
      console.warn('[NgPlaybackContextManager] Failed to parse context:', wireValue?.substring(0, 100));
      return;
    }

    this._current = parsed;
    console.log(`[NgPlaybackContextManager] Context updated: "${parsed.title}" (${parsed.contentType}, ${parsed.durationMs}ms, seekable=${parsed.seekableByClient})`);

    this._fireChange(previous, this._current);
  }

  /**
   * Called on MEDIACMD_OPENURL — stores the URL so that a subsequently
   * received context can reference it.
   * @param {string} urlString — the URL from the OPENURL command
   */
  onMediaOpen(urlString) {
    this._lastOpenUrl = urlString || null;
  }

  /**
   * Called on MEDIACMD_STOP / MEDIACMD_DEINIT — clears the current context.
   */
  onMediaClose() {
    const previous = this._current;
    this._current = null;
    this._lastOpenUrl = null;

    if (previous) {
      console.log('[NgPlaybackContextManager] Context cleared (media closed)');
      this._fireChange(previous, null);
    }
  }

  /**
   * Dispatch a contextchange event with previous and current values.
   * @param {import('./ng-playback-context.js').NgPlaybackContext|null} previous
   * @param {import('./ng-playback-context.js').NgPlaybackContext|null} current
   * @private
   */
  _fireChange(previous, current) {
    this.dispatchEvent(new CustomEvent('contextchange', {
      detail: { previous, current },
    }));
  }
}
