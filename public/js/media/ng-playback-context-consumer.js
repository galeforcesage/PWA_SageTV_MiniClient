/**
 * NG Playback Context Consumer
 *
 * Bridges the NG context metadata (from the HTTP endpoint) to the MediaPlayer
 * runtime tunables. When the server provides seek hints and flow control via
 * /ng/playback-context/current, this consumer applies those values to the
 * player's configurable knobs — seek coalesce timeout, prebuffer thresholds,
 * initial seek grace, etc.
 *
 * Against a legacy server (no NG support), this module does nothing — the player
 * retains its built-in defaults. All changes are non-destructive: the consumer
 * only WRITES player knobs that the player already reads with ?? fallback.
 *
 * Lifecycle:
 *   1. Created by SessionManager after connection + player are established
 *   2. Fetches context from HTTP endpoint on media open (OPENURL)
 *   3. Applies seek/flow hints to player
 *   4. Re-fetches on context change (SET_PROPERTY push from server)
 *   5. Resets player knobs to defaults on media close
 *
 * Does NOT change:
 *   - Playback start/stop behavior
 *   - FF/REW key handling (input-manager owns that)
 *   - Binary protocol commands
 *   - Push/pull mode selection
 */

const FETCH_TIMEOUT_MS = 3000;

export class NgPlaybackContextConsumer {
  /**
   * @param {import('./player.js').MediaPlayer} player
   * @param {object} options
   * @param {string} [options.bridgeOrigin] - Base URL for /ng/ endpoint
   * @param {import('./ng-playback-context-manager.js').NgPlaybackContextManager} [options.contextManager]
   */
  constructor(player, options = {}) {
    this._player = player;
    this._bridgeOrigin = options.bridgeOrigin || '';
    this._contextManager = options.contextManager || null;
    this._active = false;
    this._lastContext = null;
    this._fetchAbort = null;

    // Listen for context pushes from the binary protocol (SET_PROPERTY)
    this._onContextChange = null;
    if (this._contextManager) {
      this._onContextChange = (e) => this._handleContextPush(e.detail);
      this._contextManager.addEventListener('contextchange', this._onContextChange);
    }
  }

  /**
   * Called when media opens (OPENURL). Fetches the full NG context and applies.
   */
  async onMediaOpen() {
    this._active = true;
    await this._fetchAndApply();
  }

  /**
   * Called when media closes (STOP/DEINIT). Resets player to defaults.
   */
  onMediaClose() {
    this._active = false;
    this._lastContext = null;
    this._abortFetch();
    this._stopLiveRefresh();
    this._resetPlayerDefaults();
  }

  /**
   * Update bridge origin (if it changes after construction).
   * @param {string} origin
   */
  setBridgeOrigin(origin) {
    this._bridgeOrigin = origin || '';
  }

  /**
   * Get the last applied context (or null).
   * @returns {object|null}
   */
  getLastContext() {
    return this._lastContext;
  }

  /** Clean up listeners. */
  destroy() {
    this._active = false;
    this._abortFetch();
    if (this._contextManager && this._onContextChange) {
      this._contextManager.removeEventListener('contextchange', this._onContextChange);
      this._onContextChange = null;
    }
    this._lastContext = null;
  }

  // ── Private ────────────────────────────────────────────────

  /**
   * Handle a context push from the binary protocol. Re-fetch the full HTTP
   * context since the push only carries a subset of fields.
   */
  _handleContextPush(detail) {
    if (!this._active) return;
    // The push confirms playback is live — re-fetch full context for latest
    // seek/flow hints (e.g. duration may have updated for live recordings).
    this._fetchAndApply();
  }

  async _fetchAndApply() {
    if (!this._bridgeOrigin) return;
    this._abortFetch();

    const controller = new AbortController();
    this._fetchAbort = controller;

    try {
      const url = `${this._bridgeOrigin}/ng/playback-context/current`;
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok || !this._active) return;

      const json = await response.json();
      if (json.type !== 'NG_PLAYBACK_CONTEXT' || !json.context) return;

      this._lastContext = json.context;
      this._applyToPlayer(json.context);

      // For live content, start periodic refresh so playableEndMs stays current
      this._manageLiveRefresh(json.context);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.debug('[NgContextConsumer] fetch failed:', err.message);
      }
    } finally {
      if (this._fetchAbort === controller) {
        this._fetchAbort = null;
      }
    }
  }

  _abortFetch() {
    if (this._fetchAbort) {
      this._fetchAbort.abort();
      this._fetchAbort = null;
    }
  }

  /**
   * Start/stop periodic refresh for live content so playableEndMs stays current.
   */
  _manageLiveRefresh(ctx) {
    const isLive = ctx.live && ctx.live.isLive;
    if (isLive && !this._liveRefreshTimer) {
      // Poll at (granularity - 500ms) so playableEndMs stays fresh enough to
      // prevent edge overshoot. Clamp to [1000, 10000] for sanity.
      const gran = (ctx.seek && ctx.seek.preferredGranularityMs) || 5000;
      const interval = Math.max(1000, Math.min(gran - 500, 10000));
      console.debug(`[NgContextConsumer] live refresh every ${interval}ms (granularity=${gran}ms)`);
      this._liveRefreshTimer = setInterval(() => {
        if (this._active) this._fetchAndApply();
      }, interval);
    } else if (!isLive && this._liveRefreshTimer) {
      clearInterval(this._liveRefreshTimer);
      this._liveRefreshTimer = null;
    }
  }

  _stopLiveRefresh() {
    if (this._liveRefreshTimer) {
      clearInterval(this._liveRefreshTimer);
      this._liveRefreshTimer = null;
    }
  }

  /**
   * Apply context values to player tunables.
   * Only sets values that the server provides; player uses ?? defaults for missing.
   */
  _applyToPlayer(ctx) {
    const player = this._player;
    if (!player) return;

    // ── Seek hints ──
    const seek = ctx.seek;
    if (seek) {
      // maxClientCoalesceMs → seek debounce timeout (player hardcodes 300ms).
      // Cap at 500ms: the server advertises the MAX the client is ALLOWED to
      // coalesce, but the PWA's stream-restart architecture (abort immediately,
      // restart after debounce) means long windows leave the user staring at
      // "Loading..." with no video. 500ms is enough to coalesce rapid FF bursts
      // without the UX penalty of 1500ms.
      if (typeof seek.maxClientCoalesceMs === 'number' && seek.maxClientCoalesceMs > 0) {
        player._seekCoalesceMs = Math.min(seek.maxClientCoalesceMs, 500);
        console.debug(`[NgContextConsumer] seekCoalesceMs=${player._seekCoalesceMs} (server max=${seek.maxClientCoalesceMs})`);
      }

      // minSeekIntervalMs → minimum time between seeks (for rate limiting)
      if (typeof seek.minSeekIntervalMs === 'number' && seek.minSeekIntervalMs > 0) {
        player._minSeekIntervalMs = seek.minSeekIntervalMs;
      }

      // preferredGranularityMs → seek step hint (input-manager may read this)
      if (typeof seek.preferredGranularityMs === 'number' && seek.preferredGranularityMs > 0) {
        player._seekGranularityMs = seek.preferredGranularityMs;
      }
    }

    // ── Flow control ──
    const flow = ctx.flow;
    if (flow) {
      // preferredPrebufferBytes → convert to approximate seconds for _prebufferSec
      // Assumption: ~500KB/s average bridge bitrate for transcoded content
      if (typeof flow.preferredPrebufferBytes === 'number' && flow.preferredPrebufferBytes > 0) {
        const estimatedBitrateBytes = player._bwKbps > 0
          ? (player._bwKbps * 1000 / 8)
          : 500000; // fallback ~4Mbps
        const prebufSec = flow.preferredPrebufferBytes / estimatedBitrateBytes;
        // Clamp to reasonable range
        player._prebufferSec = Math.max(0.3, Math.min(prebufSec, 3.0));
        console.debug(`[NgContextConsumer] prebufferSec=${player._prebufferSec.toFixed(2)} (${flow.preferredPrebufferBytes}B @ ${estimatedBitrateBytes}B/s)`);
      }
    }

    // ── Duration ──
    if (typeof ctx.durationMs === 'number' && ctx.durationMs > 0) {
      player._ngDurationMs = ctx.durationMs;
    }

    // ── Live edge ──
    const live = ctx.live;
    if (live && live.isLive) {
      if (typeof live.safeSeekEndMs === 'number' && live.safeSeekEndMs > 0) {
        player._ngLiveSafeSeekEndMs = live.safeSeekEndMs;
      }
      if (typeof live.playableEndMs === 'number' && live.playableEndMs > 0) {
        player._ngLivePlayableEndMs = live.playableEndMs;
      }
      console.debug(`[NgContextConsumer] live: safeSeekEnd=${live.safeSeekEndMs}ms playableEnd=${live.playableEndMs}ms`);
    } else {
      player._ngLiveSafeSeekEndMs = null;
      player._ngLivePlayableEndMs = null;
    }

    console.debug('[NgContextConsumer] Applied context:', {
      seekCoalesceMs: player._seekCoalesceMs,
      prebufferSec: player._prebufferSec,
      seekGranularityMs: player._seekGranularityMs,
      durationMs: player._ngDurationMs,
      livePlayableEndMs: player._ngLivePlayableEndMs,
    });
  }

  /**
   * Reset player knobs to undefined so ?? defaults take over again.
   */
  _resetPlayerDefaults() {
    const player = this._player;
    if (!player) return;
    player._seekCoalesceMs = undefined;
    player._minSeekIntervalMs = undefined;
    player._seekGranularityMs = undefined;
    player._prebufferSec = undefined;
    player._ngDurationMs = undefined;
    player._ngLivePlayableEndMs = null;
    player._ngLiveSafeSeekEndMs = null;
  }
}
