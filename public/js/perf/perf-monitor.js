/**
 * SageTV PWA MiniClient — client-side performance monitor (PWA0).
 *
 * Opt-in, zero-cost-when-disabled instrumentation for diagnosing slow menu
 * navigation on constrained clients (iPad Safari/PWA, Samsung Tizen).
 *
 * Enable via any of:
 *   - URL param   ?perf=1        (…&perf=0 forces off)
 *   - localStorage sagetv.perf = "1"
 *   - console      __SAGETV_PERF__.setEnabled(true)   (persists to localStorage)
 *
 * When disabled every method is a cheap early-return, so call sites can invoke
 * these unconditionally without measurable overhead.
 *
 * Latest metrics are mirrored to window.__SAGETV_PERF__ for live inspection.
 */

class PerfMonitor {
  constructor() {
    this._now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? () => performance.now()
      : () => Date.now();

    this._enabled = this._detectEnabled();

    this._frameSeq = 0;
    this._frame = null;          // in-flight frame accumulator
    this._lastFrame = null;      // last completed frame snapshot
    this._pendingInput = null;   // { type, id, t } awaiting next present
    this._lastInput = null;      // last resolved input latency

    // Rolling aggregates
    this._sumFrameMs = 0;
    this._frameCount = 0;
    this._worstFrameMs = 0;
    this._evictionsTotal = 0;

    this._publish();
  }

  _detectEnabled() {
    try {
      const params = new URLSearchParams(globalThis.location?.search || '');
      const q = params.get('perf');
      if (q === '1' || q === 'true') return true;
      if (q === '0' || q === 'false') return false;
    } catch { /* no URL context */ }
    try {
      return globalThis.localStorage?.getItem('sagetv.perf') === '1';
    } catch {
      return false;
    }
  }

  get enabled() {
    return this._enabled;
  }

  now() {
    return this._now();
  }

  /** Persist and apply an enable/disable toggle at runtime. */
  setEnabled(on) {
    this._enabled = !!on;
    try { globalThis.localStorage?.setItem('sagetv.perf', on ? '1' : '0'); } catch { /* ignore */ }
    this._publish();
    return this._enabled;
  }

  /**
   * Record that a navigation input was sent. Resolved on the next present so we
   * can report input→present latency. Later inputs before a present overwrite
   * the pending one (we measure the most recent, matching user perception).
   */
  markInput(type, id) {
    if (!this._enabled) return;
    this._pendingInput = { type, id, t: this._now() };
  }

  /** Begin a frame (SageTV STARTFRAME). */
  startFrame() {
    if (!this._enabled) return;
    this._frame = {
      id: ++this._frameSeq,
      t0: this._now(),
      cmds: Object.create(null),
      cmdCount: 0,
      drawTexture: 0,
      createSurface: 0,
      setTargetSurface: 0,
      loadImage: 0,
      loadCompressed: 0,
      xfmImage: 0,
      wsBufferedStart: 0,
    };
  }

  /** Tally one GFX command by name. */
  countCommand(name) {
    const f = this._frame;
    if (!f) return;
    f.cmds[name] = (f.cmds[name] || 0) + 1;
    f.cmdCount++;
    switch (name) {
      case 'DRAWTEXTURED':
      case 'DRAWTEXTUREDDIFFUSE': f.drawTexture++; break;
      case 'CREATESURFACE': f.createSurface++; break;
      case 'SETTARGETSURFACE': f.setTargetSurface++; break;
      case 'LOADIMAGE':
      case 'LOADIMAGETARGETED': f.loadImage++; break;
      case 'LOADIMAGECOMPRESSED': f.loadCompressed++; break;
      case 'XFMIMAGE': f.xfmImage++; break;
      default: break;
    }
  }

  /** Optional: record the GFX WebSocket backlog at frame start. */
  noteWsBufferedStart(bytes) {
    if (this._frame && Number.isFinite(bytes)) this._frame.wsBufferedStart = bytes;
  }

  /**
   * End a frame (SageTV FLIPBUFFER). Presentation is synchronous today, so
   * present == flip; the schema keeps both so a future rAF-gated present can
   * populate them distinctly.
   *
   * @param {object|null} cacheStats  renderer.getCacheStats() output
   * @param {number} [wsBufferedEnd]  GFX WebSocket bufferedAmount at flip
   */
  endFrame(cacheStats, wsBufferedEnd) {
    const f = this._frame;
    if (!f) return;
    this._frame = null;

    const flip = this._now();
    const frameMs = flip - f.t0;

    let inputToFlipMs = null;
    let inputToPresentMs = null;
    if (this._pendingInput) {
      inputToFlipMs = flip - this._pendingInput.t;
      inputToPresentMs = inputToFlipMs; // sync present
      this._lastInput = {
        type: this._pendingInput.type,
        id: this._pendingInput.id,
        inputToFlipMs,
        inputToPresentMs,
      };
      this._pendingInput = null;
    }

    this._sumFrameMs += frameMs;
    this._frameCount++;
    if (frameMs > this._worstFrameMs) this._worstFrameMs = frameMs;
    if (cacheStats && Number.isFinite(cacheStats.evictionsTotal)) {
      this._evictionsTotal = cacheStats.evictionsTotal;
    }

    this._lastFrame = {
      id: f.id,
      frameMs,
      cmdCount: f.cmdCount,
      cmds: { ...f.cmds },
      drawTexture: f.drawTexture,
      createSurface: f.createSurface,
      setTargetSurface: f.setTargetSurface,
      loadImage: f.loadImage,
      loadCompressed: f.loadCompressed,
      xfmImage: f.xfmImage,
      cache: cacheStats || null,
      inputToFlipMs,
      inputToPresentMs,
      wsBufferedStart: f.wsBufferedStart,
      wsBufferedEnd: Number.isFinite(wsBufferedEnd) ? wsBufferedEnd : null,
    };

    this._publish();
    this._log(this._lastFrame);
  }

  _log(fr) {
    const sev = fr.frameMs > 250 ? 'error' : fr.frameMs > 50 ? 'warn' : 'log';
    const tag = fr.frameMs > 250 ? '[Perf!!]' : fr.frameMs > 50 ? '[Perf!]' : '[Perf]';
    const bits = [
      `f${fr.id}`,
      `${fr.frameMs.toFixed(1)}ms`,
      `cmds=${fr.cmdCount}`,
    ];
    if (fr.drawTexture) bits.push(`tex=${fr.drawTexture}`);
    if (fr.loadImage || fr.loadCompressed) bits.push(`load=${fr.loadImage}/${fr.loadCompressed}c`);
    if (fr.xfmImage) bits.push(`xfm=${fr.xfmImage}`);
    if (fr.inputToPresentMs != null) bits.push(`in→present=${fr.inputToPresentMs.toFixed(1)}ms`);
    if (fr.cache) {
      const usedMiB = (fr.cache.usedBytes / 1048576).toFixed(1);
      const budMiB = (fr.cache.budgetBytes / 1048576).toFixed(0);
      bits.push(`img=${fr.cache.imageCount}/${usedMiB}MiB`);
      bits.push(`surf=${fr.cache.surfaceCount}`);
      if (fr.cache.usedBytes >= fr.cache.budgetBytes) bits.push('CACHE-FULL');
      bits.push(`bud=${budMiB}MiB`);
    }
    if (Number.isFinite(fr.wsBufferedEnd) && fr.wsBufferedEnd > 0) bits.push(`wsBuf=${fr.wsBufferedEnd}`);
    const line = `${tag} ${bits.join(' ')}`;
    if (sev === 'log') console.log(line);
    else if (sev === 'warn') console.warn(`${line}  ${this._cmdBreakdown(fr)}`);
    else console.error(`${line}  ${this._cmdBreakdown(fr)}`);
  }

  _cmdBreakdown(fr) {
    return Object.entries(fr.cmds)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
  }

  _publish() {
    if (typeof globalThis.window === 'undefined') return;
    globalThis.window.__SAGETV_PERF__ = {
      enabled: this._enabled,
      lastFrame: this._lastFrame,
      lastInput: this._lastInput,
      frames: this._frameCount,
      avgFrameMs: this._frameCount ? this._sumFrameMs / this._frameCount : 0,
      worstFrameMs: this._worstFrameMs,
      evictionsTotal: this._evictionsTotal,
      setEnabled: (on) => this.setEnabled(on),
      reset: () => this.reset(),
    };
  }

  reset() {
    this._sumFrameMs = 0;
    this._frameCount = 0;
    this._worstFrameMs = 0;
    this._lastFrame = null;
    this._lastInput = null;
    this._publish();
  }
}

export const perf = new PerfMonitor();
