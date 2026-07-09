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
    this._pendingInput = { type, id, t: this._now(), serverRttMs: null };
  }

  /**
   * Called by connection layer whenever bytes arrive from the server. First
   * call after markInput() resolves serverRTT (input→first server byte).
   */
  noteServerBytes(_n) {
    if (!this._enabled) return;
    const p = this._pendingInput;
    if (p && p.serverRttMs == null) {
      p.serverRttMs = this._now() - p.t;
    }
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
      // Phase 1 breakdown accumulators (ms)
      outerMs: 0,        // total wall time in _processGfxBuffer while-loop
      execMs: 0,         // wall time inside _executeGfxCommand for this frame
      flipMs: 0,         // wall time of renderer.flipBuffer()
      imageDecodeMs: 0,  // async createImageBitmap resolution time (this frame window)
      imageDecodeCount: 0,
      textDraws: 0,
      fullClear: false,  // set if fillRect covered the whole canvas
    };
  }

  /** Accumulate outer buffer-parse wall time (includes exec time; subtract to get pure parse). */
  addOuterMs(ms) {
    if (this._frame && Number.isFinite(ms)) this._frame.outerMs += ms;
  }

  /** Accumulate time spent inside _executeGfxCommand (draw + flip + image handling). */
  addExecMs(ms) {
    if (this._frame && Number.isFinite(ms)) this._frame.execMs += ms;
  }

  /** Record the wall time of the FLIPBUFFER canvas blit. */
  noteFlipMs(ms) {
    if (this._frame && Number.isFinite(ms)) this._frame.flipMs = ms;
  }

  /** Tally a text-drawing operation (DRAWTEXT / DRAWTEXTEX). */
  bumpText() {
    if (this._frame) this._frame.textDraws++;
  }

  /** Record an image decode (createImageBitmap resolution) that completed. */
  addImageDecodeMs(ms) {
    if (this._frame && Number.isFinite(ms)) {
      this._frame.imageDecodeMs += ms;
      this._frame.imageDecodeCount++;
    }
  }

  /** Hint from renderer: this frame did a full-canvas clear/fill. */
  noteFullClear() {
    if (this._frame) this._frame.fullClear = true;
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
    let inputType = null;
    let inputId = null;
    let serverRttMs = null;
    if (this._pendingInput) {
      inputToFlipMs = flip - this._pendingInput.t;
      inputToPresentMs = inputToFlipMs; // sync present
      inputType = this._pendingInput.type;
      inputId = this._pendingInput.id;
      serverRttMs = this._pendingInput.serverRttMs;
      this._lastInput = {
        type: inputType,
        id: inputId,
        inputToFlipMs,
        inputToPresentMs,
        serverRttMs,
      };
      this._pendingInput = null;
    }

    this._sumFrameMs += frameMs;
    this._frameCount++;
    if (frameMs > this._worstFrameMs) this._worstFrameMs = frameMs;
    if (cacheStats && Number.isFinite(cacheStats.evictionsTotal)) {
      this._evictionsTotal = cacheStats.evictionsTotal;
    }

    // Derived breakdowns
    const execMs = f.execMs;
    const flipMs = f.flipMs;
    const drawMs = Math.max(0, execMs - flipMs);   // exec minus flip = pure draw/img work
    const parseMs = Math.max(0, f.outerMs - execMs); // outer minus exec = pure parse/decompress

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
      inputType,
      inputId,
      inputToFlipMs,
      inputToPresentMs,
      serverRttMs,
      parseMs,
      drawMs,
      flipMs,
      imageDecodeMs: f.imageDecodeMs,
      imageDecodeCount: f.imageDecodeCount,
      textDraws: f.textDraws,
      dirty: f.fullClear ? 'full' : 'partial',
      wsBufferedStart: f.wsBufferedStart,
      wsBufferedEnd: Number.isFinite(wsBufferedEnd) ? wsBufferedEnd : null,
    };

    this._publish();
    this._log(this._lastFrame);
  }

  _log(fr) {
    const sev = fr.frameMs > 250 ? 'error' : fr.frameMs > 50 ? 'warn' : 'log';
    const tag = fr.frameMs > 250 ? '[perf!!]' : fr.frameMs > 50 ? '[perf!]' : '[perf]';
    const bits = [];
    if (fr.inputType != null) {
      bits.push(`${fr.inputType}=${fr.inputId}`);
    } else {
      bits.push(`f${fr.id}`);
    }
    if (fr.serverRttMs != null) bits.push(`serverRTT=${fr.serverRttMs.toFixed(0)}ms`);
    bits.push(`cmds=${fr.cmdCount}`);
    bits.push(`parse=${fr.parseMs.toFixed(0)}ms`);
    bits.push(`draw=${fr.drawMs.toFixed(0)}ms`);
    if (fr.imageDecodeCount) {
      bits.push(`imagesDecoded=${fr.imageDecodeCount}/${fr.imageDecodeMs.toFixed(0)}ms`);
    } else if (fr.loadImage || fr.loadCompressed) {
      bits.push(`images=${fr.loadImage + fr.loadCompressed}`);
    }
    if (fr.textDraws) bits.push(`text=${fr.textDraws}`);
    bits.push(`dirty=${fr.dirty}`);
    bits.push(`flip=${fr.flipMs.toFixed(0)}ms`);
    if (fr.inputToPresentMs != null) {
      bits.push(`total=${fr.inputToPresentMs.toFixed(0)}ms`);
    } else {
      bits.push(`frame=${fr.frameMs.toFixed(0)}ms`);
    }
    if (fr.cache) {
      const usedMiB = (fr.cache.usedBytes / 1048576).toFixed(1);
      bits.push(`cache=${fr.cache.imageCount}img/${usedMiB}MiB`);
      if (fr.cache.usedBytes >= fr.cache.budgetBytes) bits.push('CACHE-FULL');
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
