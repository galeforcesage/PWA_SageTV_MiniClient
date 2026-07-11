/**
 * SageTV PWA MiniClient — client-side performance monitor (PWA0).
 *
 * Opt-in, zero-cost-when-disabled instrumentation for diagnosing slow menu
 * navigation on constrained clients (iPad Safari/PWA, Samsung Tizen).
 *
 * Enable ONLY via the URL param ?perf=1 (…&perf=0 or omitting it = off). This
 * is deliberately not sticky: it is never persisted to localStorage, so perf
 * and its on-screen overlay are off on any normal load and only appear when
 * the operator explicitly appends ?perf=1. __SAGETV_PERF__.setEnabled(true)
 * can still flip it on for the current session (not persisted).
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
    // Strictly URL-gated: on only when ?perf=1 is present. Never sticky.
    // Proactively clear any legacy persisted flag so old sessions that set
    // 'sagetv.perf' can't keep perf/overlay on after this change ships.
    try { globalThis.localStorage?.removeItem('sagetv.perf'); } catch { /* ignore */ }
    try {
      const params = new URLSearchParams(globalThis.location?.search || '');
      const q = params.get('perf');
      return q === '1' || q === 'true';
    } catch {
      return false;
    }
  }

  /**
   * On-screen overlay: pins the last N perf lines to the top-right of the
   * viewport so devices without a devtools console (Tizen TVs, iPad standalone
   * PWA) can still see the diagnostic output. Enabled whenever perf is on,
   * unless localStorage 'sagetv.perfOverlay' === '0' or URL has '?perfoverlay=0'.
   */
  _overlayEnabled() {
    try {
      const params = new URLSearchParams(globalThis.location?.search || '');
      const q = params.get('perfoverlay');
      if (q === '1' || q === 'true') return true;
      if (q === '0' || q === 'false') return false;
    } catch { /* ignore */ }
    try {
      const ls = globalThis.localStorage?.getItem('sagetv.perfOverlay');
      if (ls === '0' || ls === 'false') return false;
    } catch { /* ignore */ }
    return true; // default ON when perf is on
  }

  _ensureOverlay() {
    if (this._overlay || typeof document === 'undefined') return this._overlay || null;
    if (!this._overlayEnabled()) return null;
    // Wait for body if the module loaded before DOMContentLoaded.
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => this._ensureOverlay(), { once: true });
      return null;
    }
    const el = document.createElement('div');
    el.id = 'sagetv-perf-overlay';
    el.style.cssText = [
      'position:fixed',
      'top:4px',
      'right:4px',
      'z-index:2147483647',
      'max-width:760px',
      'max-height:88vh',
      'overflow:hidden',
      'padding:4px 6px',
      'background:rgba(0,0,0,0.72)',
      'color:#0f0',
      'font:10px/1.25 ui-monospace,Consolas,Menlo,monospace',
      'white-space:pre',
      'pointer-events:none',
      'border:1px solid rgba(0,255,0,0.4)',
      'border-radius:4px',
      'text-shadow:0 0 1px #000',
    ].join(';');
    document.body.appendChild(el);
    this._overlay = el;
    this._overlayLines = [];
    return el;
  }

  _appendOverlay(line, sev) {
    const el = this._ensureOverlay();
    if (!el) return;
    // Ring buffer of last N lines. Keep small enough that the overlay
    // stays under ~60vh even on 1280x720 Tizen.
    const MAX = 40;
    // Color-code severity in the overlay.
    const color = sev === 'error' ? '#f66' : sev === 'warn' ? '#fc0' : '#8f8';
    const span = `<span style="color:${color}">${this._escapeHtml(line)}</span>`;
    this._overlayLines.push(span);
    if (this._overlayLines.length > MAX) this._overlayLines.shift();
    el.innerHTML = this._overlayLines.join('\n');
  }

  _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  get enabled() {
    return this._enabled;
  }

  now() {
    return this._now();
  }

  /** Apply an enable/disable toggle for the current session (not persisted). */
  setEnabled(on) {
    this._enabled = !!on;
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
    if (fr.cache && fr.cache.texBlitCount) {
      bits.push(`blit=${fr.cache.texBlitMs.toFixed(0)}ms/${fr.cache.texBlitCount}`);
    }
    if (fr.inputToPresentMs != null) {
      bits.push(`total=${fr.inputToPresentMs.toFixed(0)}ms`);
    } else {
      bits.push(`frame=${fr.frameMs.toFixed(0)}ms`);
    }
    if (fr.cache) {
      const usedMiB = (fr.cache.usedBytes / 1048576).toFixed(1);
      bits.push(`cache=${fr.cache.imageCount}img/${usedMiB}MiB`);
      if (fr.cache.usedBytes >= fr.cache.budgetBytes) bits.push('CACHE-FULL');
      // Frame-cache hit/miss/skipped totals (Phase 2 retained-mode fast path).
      if (fr.cache.frameCacheEnabled) {
        const hits = fr.cache.frameCacheHits | 0;
        const miss = fr.cache.frameCacheMisses | 0;
        const total = hits + miss;
        const hitPct = total ? Math.round((hits * 100) / total) : 0;
        bits.push(`fcache=${hits}h/${miss}m/${hitPct}%`);
        if (fr.cache.frameCacheActive === false) bits.push('fc-off');
        if (fr.cache.frameCacheTopInvalidations) {
          bits.push(`inv=${fr.cache.frameCacheTopInvalidations}`);
        }
      }
    }
    if (Number.isFinite(fr.wsBufferedEnd) && fr.wsBufferedEnd > 0) bits.push(`wsBuf=${fr.wsBufferedEnd}`);
    const line = `${tag} ${bits.join(' ')}`;
    if (sev === 'log') console.log(line);
    else if (sev === 'warn') console.warn(`${line}  ${this._cmdBreakdown(fr)}`);
    else console.error(`${line}  ${this._cmdBreakdown(fr)}`);
    // Also mirror to on-screen overlay for devices without devtools (Tizen, iPad standalone).
    this._appendOverlay(line, sev);
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
