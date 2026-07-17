/**
 * NG Playback Context Client (Debug-only browser consumer)
 *
 * Fetches the NG Playback Context from the bridge/proxy metadata endpoint:
 *   GET /ng/playback-context/current
 *
 * This module is a debug-only consumer. It fetches, parses, stores, and logs
 * metadata. It does NOT change playback, FF/REW, seek, or any media behavior.
 *
 * Usage:
 *   import { NgPlaybackContextClient } from './ng-playback-context-client.js';
 *   const client = new NgPlaybackContextClient({ bridgeOrigin: 'http://localhost:8080' });
 *   client.setDebugEnabled(true);   // enable polling + console output
 *   await client.refreshNow();      // manual one-shot fetch
 *   const ctx = client.getLatestContext();
 *
 * Feature flag: 'ng_playback_context_debug' in SettingsManager (default 'false').
 * When OFF: no polling, no fetches, no visible behavior.
 * When ON: conservative polling (10s interval), console logging.
 */

/** @typedef {{ type: string, sessionId?: string, context?: object, reason?: string }} NgContextResponse */

/**
 * Normalized context snapshot stored in memory.
 * @typedef {object} NormalizedContext
 * @property {string} type - 'NG_PLAYBACK_CONTEXT' or 'NG_PLAYBACK_CONTEXT_UNAVAILABLE'
 * @property {string|null} sessionId
 * @property {number|null} version
 * @property {number|null} streamEpoch
 * @property {number|null} serverMediaTimeMs
 * @property {boolean|null} isLive
 * @property {number|null} safeSeekStartMs
 * @property {number|null} safeSeekEndMs
 * @property {number|null} playableEndMs
 * @property {string|null} unavailableReason
 * @property {number} fetchedAt - timestamp of fetch
 * @property {object|null} rawContext - full context object from server
 */

const DEFAULT_POLL_INTERVAL_MS = 10000; // 10 seconds — conservative
const FETCH_TIMEOUT_MS = 3000;

export class NgPlaybackContextClient {
  /**
   * @param {object} options
   * @param {string} [options.bridgeOrigin] - Bridge base URL (e.g. 'http://localhost:8080')
   * @param {number} [options.pollIntervalMs] - Poll interval when debug enabled (default 10000)
   */
  constructor(options = {}) {
    this._bridgeOrigin = options.bridgeOrigin || '';
    this._pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this._debugEnabled = false;
    this._pollTimer = null;

    /** @type {NormalizedContext|null} */
    this._latest = null;
    this._fetching = false;
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Enable or disable debug mode. When enabled, starts conservative polling.
   * When disabled, stops polling and clears state.
   * @param {boolean} enabled
   */
  setDebugEnabled(enabled) {
    this._debugEnabled = !!enabled;
    if (this._debugEnabled) {
      this._startPolling();
    } else {
      this._stopPolling();
    }
  }

  /** @returns {boolean} Whether debug mode is active. */
  isDebugEnabled() {
    return this._debugEnabled;
  }

  /**
   * Get the latest normalized context, or null if never fetched / unavailable.
   * @returns {NormalizedContext|null}
   */
  getLatestContext() {
    if (!this._latest || this._latest.type !== 'NG_PLAYBACK_CONTEXT') {
      return null;
    }
    return this._latest;
  }

  /**
   * Get the unavailable reason from the latest response, or null if context is available.
   * @returns {string|null}
   */
  getLatestUnavailableReason() {
    if (!this._latest) return null;
    return this._latest.unavailableReason || null;
  }

  /**
   * Get the full latest response (available or unavailable).
   * @returns {NormalizedContext|null}
   */
  getLatestResponse() {
    return this._latest;
  }

  /**
   * Manually trigger a single fetch, regardless of debug flag state.
   * Safe to call at any time — never throws into caller.
   * @returns {Promise<NormalizedContext|null>}
   */
  async refreshNow() {
    return this._fetch();
  }

  /**
   * Set or change the bridge origin URL.
   * @param {string} origin
   */
  setBridgeOrigin(origin) {
    this._bridgeOrigin = origin || '';
  }

  /** Stop polling and clean up. */
  destroy() {
    this._stopPolling();
    this._latest = null;
  }

  // ── Private ────────────────────────────────────────────────

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => {
      this._fetch();
    }, this._pollIntervalMs);
    // Immediate first fetch
    this._fetch();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Fetch from bridge endpoint, parse, store, log.
   * Never throws — all errors are caught and logged.
   * @returns {Promise<NormalizedContext|null>}
   */
  async _fetch() {
    if (this._fetching) return this._latest;
    this._fetching = true;

    try {
      const url = `${this._bridgeOrigin}/ng/playback-context/current`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          cache: 'no-store',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        this._latest = this._makeUnavailable('bridge_not_wired', null);
        this._logDebug('fetch failed', response.status);
        return this._latest;
      }

      const json = await response.json();
      this._latest = this._normalize(json);
      this._logDebug('fetched', this._latest);
      return this._latest;
    } catch (err) {
      // Network error, timeout, JSON parse error — never throw into caller
      this._latest = this._makeUnavailable('bridge_not_wired', null);
      this._logDebug('fetch error', err?.message || err);
      return this._latest;
    } finally {
      this._fetching = false;
    }
  }

  /**
   * Normalize a raw JSON response into a consistent shape.
   * Defensively handles missing/invalid fields.
   * @param {any} json
   * @returns {NormalizedContext}
   */
  _normalize(json) {
    if (!json || typeof json !== 'object') {
      return this._makeUnavailable('bridge_not_wired', null);
    }

    const type = typeof json.type === 'string' ? json.type : '';
    const now = Date.now();

    if (type === 'NG_PLAYBACK_CONTEXT_UNAVAILABLE') {
      return this._makeUnavailable(
        typeof json.reason === 'string' ? json.reason : 'unknown',
        json
      );
    }

    if (type !== 'NG_PLAYBACK_CONTEXT') {
      return this._makeUnavailable('unknown', json);
    }

    // Available context — extract fields defensively
    const sessionId = this._safeString(json.sessionId);
    const ctx = (json.context && typeof json.context === 'object') ? json.context : {};

    // Security: strip any accidentally-included internal keys
    const sanitized = { ...ctx };
    delete sanitized.sessionKey;
    delete sanitized.openGeneration;

    return {
      type: 'NG_PLAYBACK_CONTEXT',
      sessionId,
      version: this._safeNumber(ctx.version),
      streamEpoch: this._safeNumber(ctx.streamEpoch),
      serverMediaTimeMs: this._safeNumber(ctx.serverMediaTimeMs),
      isLive: this._safeBool(ctx.isLive, ctx.live?.isLive),
      safeSeekStartMs: this._safeNumber(ctx.live?.safeSeekStartMs ?? ctx.safeSeekStartMs),
      safeSeekEndMs: this._safeNumber(ctx.live?.safeSeekEndMs ?? ctx.safeSeekEndMs),
      playableEndMs: this._safeNumber(ctx.live?.playableEndMs ?? ctx.playableEndMs),
      unavailableReason: null,
      fetchedAt: now,
      rawContext: sanitized,
    };
  }

  /**
   * @param {string} reason
   * @param {any} _raw
   * @returns {NormalizedContext}
   */
  _makeUnavailable(reason, _raw) {
    return {
      type: 'NG_PLAYBACK_CONTEXT_UNAVAILABLE',
      sessionId: null,
      version: null,
      streamEpoch: null,
      serverMediaTimeMs: null,
      isLive: null,
      safeSeekStartMs: null,
      safeSeekEndMs: null,
      playableEndMs: null,
      unavailableReason: reason,
      fetchedAt: Date.now(),
      rawContext: null,
    };
  }

  /** @returns {string|null} */
  _safeString(val) {
    return (typeof val === 'string' && val.length > 0) ? val : null;
  }

  /** @returns {number|null} */
  _safeNumber(val) {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  }

  /** @returns {boolean|null} */
  _safeBool(...vals) {
    for (const v of vals) {
      if (typeof v === 'boolean') return v;
    }
    return null;
  }

  _logDebug(...args) {
    if (this._debugEnabled) {
      console.log('[NgPlaybackContextClient]', ...args);
    }
  }
}
