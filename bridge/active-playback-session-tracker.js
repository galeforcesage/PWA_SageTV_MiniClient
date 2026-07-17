/**
 * Active Playback Session Tracker
 *
 * Tracks per-client active playback sessions for the bridge/proxy.
 * Maps browser connections to opaque session identifiers (when known)
 * and provides lifecycle hooks for connect, media open/close, and disconnect.
 *
 * Security:
 * - Never stores or exposes internal SageTV sessionKey
 * - Never stores clientName:mediaFileId:openGeneration
 * - Never enumerates all server sessions
 * - Only tracks the bridge-assigned opaque connectionId → sessionId mapping
 *
 * Phase 1: The bridge cannot learn sessionId from the SageTV binary protocol
 * (it's a pure byte relay). The tracker stores the lifecycle and will return
 * the mapping once a mechanism is wired (e.g. the PWA client sends its session
 * identity via a text control message, or the server provides it via an HTTP
 * callback).
 */

const STALE_TIMEOUT_MS = 120_000; // 2 minutes without activity → mark stale
const STALE_CHECK_INTERVAL_MS = 30_000;

/**
 * @typedef {Object} TrackedSession
 * @property {string} connectionId - unique bridge connection ID
 * @property {string|null} sessionId - opaque session ID (null until learned)
 * @property {boolean} playbackActive - whether media playback is in progress
 * @property {number} lastActivityAt - epoch ms of last activity
 * @property {string} state - 'connected'|'playing'|'stale'|'disconnected'
 */

export class ActivePlaybackSessionTracker {
  constructor(options = {}) {
    /** @type {Map<string, TrackedSession>} */
    this._sessions = new Map();
    this._staleTimeoutMs = options.staleTimeoutMs || STALE_TIMEOUT_MS;
    this._staleCheckInterval = null;
    this._idCounter = 0;
  }

  /**
   * Start the stale-session reaper. Call once on bridge startup.
   */
  start() {
    if (this._staleCheckInterval) return;
    this._staleCheckInterval = setInterval(() => this._reapStale(), STALE_CHECK_INTERVAL_MS);
    if (this._staleCheckInterval.unref) this._staleCheckInterval.unref();
  }

  /**
   * Stop the reaper. Call on bridge shutdown.
   */
  stop() {
    if (this._staleCheckInterval) {
      clearInterval(this._staleCheckInterval);
      this._staleCheckInterval = null;
    }
    this._sessions.clear();
  }

  /**
   * Register a new browser connection. Returns a unique connectionId.
   * @param {object} [meta] - optional metadata (channel, host, etc.)
   * @returns {string} connectionId
   */
  onConnect(meta = {}) {
    const connectionId = `conn-${++this._idCounter}-${Date.now().toString(36)}`;
    this._sessions.set(connectionId, {
      connectionId,
      sessionId: null,
      playbackActive: false,
      lastActivityAt: Date.now(),
      state: 'connected',
      meta,
    });
    return connectionId;
  }

  /**
   * Set the opaque sessionId for a connection.
   * Called when sessionId is learned (future: from control message or server callback).
   *
   * TODO: Wire this call. The bridge currently cannot learn sessionId because:
   *   1. The binary protocol bytes are opaque (encrypted handshake, no inspection)
   *   2. No query param currently carries session identity from the PWA client
   *   3. No server-side callback mechanism exists yet
   *
   * Possible future sources:
   *   - PWA client sends {"type":"session_identity","sessionId":"..."} text frame
   *   - Server calls bridge HTTP callback on session start
   *   - Bridge inspects the MAC address from the WS query params (if added)
   *
   * @param {string} connectionId
   * @param {string} sessionId - opaque, never the internal sessionKey
   */
  setSessionId(connectionId, sessionId) {
    const entry = this._sessions.get(connectionId);
    if (!entry) return;
    entry.sessionId = sessionId;
    entry.lastActivityAt = Date.now();
  }

  /**
   * Set the clientName (MAC address) for a connection.
   * Extracted from the first binary handshake frame.
   * This is the identity the SageTV server uses to identify this MiniClient.
   *
   * @param {string} connectionId
   * @param {string} clientName - MAC address in XX:XX:XX:XX:XX:XX format
   */
  setClientName(connectionId, clientName) {
    const entry = this._sessions.get(connectionId);
    if (!entry) return;
    entry.clientName = clientName;
    entry.lastActivityAt = Date.now();
  }

  /**
   * Get the clientName for the most recently active connection.
   * Returns null if no connection has a known clientName.
   * @returns {string|null}
   */
  getActiveClientName() {
    let best = null;
    for (const entry of this._sessions.values()) {
      if (entry.state === 'disconnected' || entry.state === 'stale') continue;
      if (!entry.clientName) continue;
      if (!best || entry.lastActivityAt > best.lastActivityAt) {
        best = entry;
      }
    }
    return best ? best.clientName : null;
  }

  /**
   * Mark that playback has started for a connection.
   * @param {string} connectionId
   */
  onPlaybackStart(connectionId) {
    const entry = this._sessions.get(connectionId);
    if (!entry) return;
    entry.playbackActive = true;
    entry.state = 'playing';
    entry.lastActivityAt = Date.now();
  }

  /**
   * Mark that playback has stopped for a connection.
   * @param {string} connectionId
   */
  onPlaybackStop(connectionId) {
    const entry = this._sessions.get(connectionId);
    if (!entry) return;
    entry.playbackActive = false;
    entry.state = 'connected';
    entry.lastActivityAt = Date.now();
  }

  /**
   * Record activity (keeps the session from going stale).
   * @param {string} connectionId
   */
  onActivity(connectionId) {
    const entry = this._sessions.get(connectionId);
    if (!entry) return;
    if (entry.state === 'stale') {
      entry.state = entry.playbackActive ? 'playing' : 'connected';
    }
    entry.lastActivityAt = Date.now();
  }

  /**
   * Handle browser disconnect or SageTV socket close/error.
   * Clears mapping. Idempotent.
   * @param {string} connectionId
   */
  onDisconnect(connectionId) {
    const entry = this._sessions.get(connectionId);
    if (!entry) return; // idempotent
    entry.state = 'disconnected';
    entry.playbackActive = false;
    entry.sessionId = null;
    entry.clientName = null;
    this._sessions.delete(connectionId);
  }

  /**
   * Get the current active session with known sessionId.
   * Returns the most recently active playing session, or null.
   *
   * @returns {{ connectionId: string, sessionId: string, state: string }|null}
   */
  getActiveSession() {
    let best = null;
    for (const entry of this._sessions.values()) {
      if (entry.state === 'disconnected' || entry.state === 'stale') continue;
      if (!entry.sessionId) continue;
      if (!best || entry.lastActivityAt > best.lastActivityAt) {
        best = entry;
      }
    }
    if (!best) return null;
    return {
      connectionId: best.connectionId,
      sessionId: best.sessionId,
      state: best.state,
    };
  }

  /**
   * Get the unavailable reason if no active session is available.
   * @returns {string} reason code
   */
  getUnavailableReason() {
    if (this._sessions.size === 0) return 'no_active_session';
    for (const entry of this._sessions.values()) {
      if (entry.state !== 'disconnected') {
        if (!entry.clientName) return 'client_name_unknown';
        return 'session_id_unknown';
      }
    }
    return 'no_active_session';
  }

  /**
   * Get count of tracked connections (for diagnostics).
   * @returns {number}
   */
  get size() {
    return this._sessions.size;
  }

  /** @private */
  _reapStale() {
    const now = Date.now();
    for (const [id, entry] of this._sessions) {
      if (entry.state === 'disconnected') {
        this._sessions.delete(id);
        continue;
      }
      if (now - entry.lastActivityAt > this._staleTimeoutMs) {
        if (entry.state !== 'stale') {
          console.log(`[SessionTracker] Connection ${id} went stale (${Math.round((now - entry.lastActivityAt) / 1000)}s idle)`);
          entry.state = 'stale';
        }
      }
    }
  }
}
