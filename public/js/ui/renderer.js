/**
 * SageTV MiniClient Canvas 2D UIRenderer
 *
 * Implements the UIRenderer interface using HTML5 Canvas 2D.
 * All 46 GFX commands from the SageTV protocol are handled here.
 *
 * Architecture:
 * - Main canvas: primary rendering target
 * - Surface canvases: off-screen OffscreenCanvas or hidden <canvas> for CREATESURFACE
 * - Image cache: Map<handle, ImageBitmap|ImageData>
 * - Transform stack: CSS matrix transforms via save()/restore()
 *
 * Port of: core/src/main/java/sagex/miniclient/uibridge/UIRenderer.java
 *          android-shared OpenGL renderer concepts → Canvas 2D
 */

import { argbToRgba, argbComponents } from '../protocol/binary-utils.js';
import { perf } from '../perf/perf-monitor.js';

export class CanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - The main rendering canvas
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this._isIOS = !!options.isIOS;
    this._isTizen = !!options.isTizen;
    // Tizen TV WebViews share iOS's weakness with concurrent ImageBitmap
    // promotions during menu paint bursts. Group both under one flag.
    this._slowGpu = this._isIOS || this._isTizen;
    // PWA5: constrained WebKit/Tizen GPUs pay a real per-blit cost for the
    // 'high' resampler when SageTV downscales large source art. Default those
    // targets to 'low'; desktop/Android keep 'high' for sharper downscales.
    // Overridable via options.smoothingQuality ('low'|'medium'|'high').
    this._smoothingQuality = options.smoothingQuality
      || (this._slowGpu ? 'low' : 'high');

    this.ctx = this._configureCtx(canvas.getContext('2d', { alpha: true }));
    this.width = canvas.width;
    this.height = canvas.height;

    // Image cache: handle → { bitmap: ImageBitmap|HTMLCanvasElement, width, height }
    this.images = new Map();

    // Surface cache: handle → { canvas: OffscreenCanvas|HTMLCanvasElement, ctx }
    this.surfaces = new Map();

    // Current target surface (0 = main canvas)
    this.targetSurface = 0;
    this.activeCtx = this.ctx;

    // Transform stack
    this.transformStack = [];

    // Offline image cache (IndexedDB backed)
    this._offlineCache = new Map();

    // Video overlay bounds
    this.videoBounds = null;

    // Frame state
    this._frameStarted = false;
    this._firstFrameRendered = false;

    // Back buffer for double-buffering
    this.backCanvas = document.createElement('canvas');
    this.backCanvas.width = this.width;
    this.backCanvas.height = this.height;
    this.backCtx = this._configureCtx(this.backCanvas.getContext('2d', { alpha: true }));
    this.activeCtx = this.backCtx;

    // Max cache size in pixels. iOS gets a tighter cap to avoid WebKit cache thrash.
    const cacheMB = Number.isFinite(options.maxCacheMB) ? options.maxCacheMB : 128;
    this._maxCachePixels = Math.max(8, cacheMB) * 1024 * 1024 / 4;
    this._currentCachePixels = 0;

    // Per-frame draw counters (populated only when perf instrumentation reads
    // them via getCacheStats(); reset each startFrame()).
    this._frameDrawImage = 0;
    this._frameScaledDraw = 0;

    // Pending async image load tracking
    this._pendingImageLoads = 0;
    this.onImagesReady = null; // callback when all pending loads complete

    // ── Frame-cache fast path ────────────────────────────────────────────
    // On constrained GPUs (iPad, Tizen), each DRAWTEXTURED costs ~2 ms even
    // for tiny quads. A typical SageTV menu frame issues 700-1200 of them,
    // so a single arrow-key repaint takes 1.5-2.5 s. But most of those
    // frames are BYTE-IDENTICAL to the previous one — SageTV re-sends the
    // entire scene even when nothing visible changed (background scroller
    // ticks, focus-rect fade animation, etc.).
    //
    // Strategy: intercept draw commands during startFrame..flipBuffer.
    // Build a running hash of the (name, args) sequence AND queue them
    // without executing. On flipBuffer, if the hash matches the previous
    // frame's hash AND nothing invalidated the cache (image loads, surface
    // changes), blit the previous frame's snapshot instead of replaying.
    // Otherwise, replay from the queue and re-snapshot.
    //
    // Snapshot lives on a hidden canvas (~ 3.5 MB at 1280x720). Works per
    // browser session — no bridge state, so it's safe for multiple
    // simultaneous clients.
    //
    // Enabled everywhere by default: on Chromium the per-hit saving is only
    // ~10 ms but that's still ~500 fewer drawImage calls per animation-tick
    // frame, which cuts CPU / battery on laptops and reduces main-thread
    // burn during menu bursts. Break-even is roughly 15% hit rate; typical
    // idle repaints (background scrollers, focus fades) blow past that.
    // Set options.frameCache = false to disable per instance.
    this._frameCacheEnabled = options.frameCache !== undefined
      ? !!options.frameCache
      : true;
    this._frameOps = null;
    this._frameHash = 0;
    this._frameInvalidated = false;
    this._prevFrameHash = 0;
    this._snapshotValid = false;
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._cacheSkipped = 0;   // draws we would have queued had cache stayed valid
    this._recording = false;  // true only between startFrame and flipBuffer
    this._replaying = false;  // true while _executeOp replays queued ops
    this._invalidateReasons = Object.create(null); // {reason: count}
    if (this._frameCacheEnabled) {
      this._snapshotCanvas = document.createElement('canvas');
      this._snapshotCanvas.width = this.width;
      this._snapshotCanvas.height = this.height;
      this._snapshotCtx = this._configureCtx(this._snapshotCanvas.getContext('2d', { alpha: true }));
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────

  init() {
    // Clear all cached images, surfaces, and pixel counter — matching Java's
    // GFXCMD2.INIT which resets all state for a fresh rendering session.
    // Without this, stale images from previous connections consume the cache
    // budget and cause new LOADIMAGE calls to return 0 (can't cache).
    this.images.forEach((img) => {
      this._releaseImageResources(img);
    });
    this.images.clear();
    this.surfaces.clear();
    this._currentCachePixels = 0;

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.backCtx.fillStyle = '#000';
    this.backCtx.fillRect(0, 0, this.width, this.height);
    console.log(`[Renderer] Initialized ${this.width}x${this.height}`);
  }

  deinit() {
    this.images.forEach((img) => {
      this._releaseImageResources(img);
    });
    this.images.clear();
    this.surfaces.forEach((s) => {
      // nothing to close for regular canvases
    });
    this.surfaces.clear();
    this._currentCachePixels = 0;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.backCanvas.width = width;
    this.backCanvas.height = height;
    this.ctx = this._configureCtx(this.canvas.getContext('2d', { alpha: true }));
    this.backCtx = this._configureCtx(this.backCanvas.getContext('2d', { alpha: true }));
    this.activeCtx = this.backCtx;
    if (this._frameCacheEnabled && this._snapshotCanvas) {
      this._snapshotCanvas.width = width;
      this._snapshotCanvas.height = height;
      this._snapshotCtx = this._configureCtx(this._snapshotCanvas.getContext('2d', { alpha: true }));
      this._snapshotValid = false; // invalidate on resize
    }
    console.log(`[Renderer] Resized to ${width}x${height}`);
  }

  startFrame() {
    this._frameStarted = true;
    this.activeCtx = this.backCtx;
    this.targetSurface = 0;
    this._frameDrawImage = 0;
    this._frameScaledDraw = 0;
    this._texBlitMs = 0;      // isolated drawImage wall time this frame (perf only)
    this._texBlitCount = 0;   // number of timed blits this frame

    // Frame-cache: begin recording draws for this frame.
    if (this._frameCacheEnabled) {
      this._frameOps = [];
      this._frameHash = 0;
      this._frameInvalidated = false;
      this._recording = true;
      // Track handles that get modified this frame. drawTexture(handle) that
      // references a dirty handle triggers invalidation. This avoids
      // pessimistic "any load busts the cache" from the previous logic —
      // if the freshly loaded handle isn't drawn, its content change is
      // invisible to the composed frame and we can still cache.
      if (this._dirtyHandles) this._dirtyHandles.clear();
      else this._dirtyHandles = new Set();
    }
  }

  flipBuffer() {
    // Frame-cache fast path: decide hit or miss before touching the front canvas.
    if (this._frameCacheEnabled && this._recording) {
      this._recording = false;
      const hit = !this._frameInvalidated
        && this._snapshotValid
        && this._frameOps.length > 0
        && this._frameHash === this._prevFrameHash;

      if (hit) {
        // Skip ALL queued draws. Just blit the previous snapshot.
        this.backCtx.globalCompositeOperation = 'copy';
        this.backCtx.drawImage(this._snapshotCanvas, 0, 0);
        this.backCtx.globalCompositeOperation = 'source-over';
        this._cacheHits++;
        this._cacheSkipped += this._frameOps.length;
      } else {
        // Miss. Two sub-cases:
        //  (a) invalidation happened mid-frame — queued main draws were
        //      already flushed inside _invalidateFrameCache to preserve
        //      order, and any subsequent draws executed immediately. Nothing
        //      to replay here.
        //  (b) no invalidation, but hash differs (or no prior snapshot yet)
        //      — replay queued ops now.
        if (!this._frameInvalidated && this._frameOps.length > 0) {
          this._replaying = true;
          try {
            for (let i = 0; i < this._frameOps.length; i++) {
              const op = this._frameOps[i];
              this._executeOp(op.m, op.a);
            }
          } finally {
            this._replaying = false;
          }
        }
        // Snapshot back-canvas for the next frame's potential hit.
        this._snapshotCtx.globalCompositeOperation = 'copy';
        this._snapshotCtx.drawImage(this.backCanvas, 0, 0);
        this._snapshotCtx.globalCompositeOperation = 'source-over';
        this._snapshotValid = true;
        this._cacheMisses++;
      }
      this._prevFrameHash = this._frameHash;
      this._frameOps = null; // release memory
    }

    // Use 'copy' compositing so transparent areas (video window) pass through
    // to the front canvas, allowing the <video> element to show beneath.
    this.ctx.globalCompositeOperation = 'copy';
    this.ctx.drawImage(this.backCanvas, 0, 0);
    this.ctx.globalCompositeOperation = 'source-over';
    this._firstFrameRendered = true;
  }

  isFirstFrameRendered() {
    return this._firstFrameRendered;
  }

  // ── Frame-cache helpers ─────────────────────────────────────

  /**
   * If frame-cache is active AND currently recording, hash this draw and
   * queue it. Returns true if the caller should skip its own execution.
   * Non-main-surface draws force execution (surfaces have persistent state
   * across frames that we can't easily snapshot).
   */
  _recordOp(name, args) {
    if (this._replaying) return false;              // replay path executes normally
    if (!this._frameCacheEnabled) return false;
    if (!this._recording) return false;             // outside startFrame..flipBuffer
    if (this._frameInvalidated) return false;
    if (this.targetSurface !== 0) {
      // Non-main-surface draws can't be safely cached: their persistent
      // pixels are needed by later drawTexture(handle=surface) calls.
      // Invalidate this frame and let the caller execute normally.
      this._invalidateFrameCache('non-main-surface-draw');
      return false;
    }
    // Smart dirty-handle check: drawTexture(handle) with a handle that got
    // modified earlier this frame cannot be cached — a cache hit would
    // produce stale pixels for that texture. Only drawTexture takes a
    // handle argument (arg[4]).
    if (name === 'drawTexture' && this._dirtyHandles && this._dirtyHandles.size > 0) {
      const h = args[4];
      if (this._dirtyHandles.has(h)) {
        this._invalidateFrameCache('draw-of-dirty-handle');
        return false;
      }
    }
    this._hashOp(name, args);
    this._frameOps.push({ m: name, a: args });
    return true;
  }

  /** Cheap 32-bit rolling hash of (name, args). */
  _hashOp(name, args) {
    let h = this._frameHash | 0;
    const M = Math.imul;
    // Mix in the method name
    for (let i = 0; i < name.length; i++) h = M(h, 31) + name.charCodeAt(i) | 0;
    for (let i = 0; i < args.length; i++) {
      const v = args[i];
      const t = typeof v;
      if (t === 'number') {
        // Fold 32-bit int and fractional bits
        h = M(h, 31) + (v | 0) | 0;
        h = M(h, 31) + ((v * 65536) | 0) | 0;
      } else if (t === 'string') {
        h = M(h, 31) + v.length | 0;
        for (let j = 0; j < v.length; j++) h = M(h, 31) + v.charCodeAt(j) | 0;
      } else if (v && t === 'object') {
        // fontInfo etc. — cache the JSON per identity so we don't restringify per frame
        let s = v.__perfHashJson;
        if (!s) {
          try { s = JSON.stringify(v); } catch { s = '?'; }
          try { Object.defineProperty(v, '__perfHashJson', { value: s, enumerable: false }); }
          catch { /* frozen object; fall through, will restringify next time */ }
        }
        for (let j = 0; j < s.length; j++) h = M(h, 31) + s.charCodeAt(j) | 0;
      } else if (v === true) {
        h = M(h, 31) + 1 | 0;
      } else if (v === null || v === undefined || v === false) {
        h = M(h, 31) + 0 | 0;
      }
    }
    this._frameHash = h;
  }

  /**
   * Mark the current frame's cache as invalid so its ops must be replayed
   * on the flip. IMPORTANT: also flush any already-queued main-canvas draws
   * to the back canvas RIGHT NOW so that any immediate-mode draws that
   * follow (e.g. off-screen surface renders) happen AFTER the earlier main
   * draws — same execution order as if caching had never been active.
   * Without this flush, mid-frame invalidations produce out-of-order
   * rendering (queued main draws replay LAST, after off-screen work,
   * causing visibly blank/wrong menus).
   */
  _invalidateFrameCache(reason) {
    if (!this._recording || this._replaying) return;
    if (!this._frameInvalidated) {
      // Flush queued ops NOW to preserve execution order.
      if (this._frameOps && this._frameOps.length > 0) {
        this._replaying = true;
        try {
          for (let i = 0; i < this._frameOps.length; i++) {
            this._executeOp(this._frameOps[i].m, this._frameOps[i].a);
          }
        } finally {
          this._replaying = false;
        }
        this._frameOps.length = 0;
      }
      this._frameInvalidated = true;
      // NOTE: do NOT clear _snapshotValid here. The previous frame's snapshot
      // is still a valid reference for FUTURE frames to compare against.
      // Snapshot only becomes invalid on resize / init / deinit / setSize.
    }
    this._invalidateReasons[reason] = (this._invalidateReasons[reason] || 0) + 1;
  }

  /**
   * Mark an image / surface handle as modified in this frame. Later, when a
   * drawTexture references this handle, it will trigger _invalidateFrameCache
   * because caching a frame whose pixels depend on newly-changed handle
   * content would produce stale output on a hit.
   *
   * This replaces the previous blanket "any load/xfm invalidates" logic —
   * SageTV's LOADIMAGELINE bursts stream ~288 lines per poster on scroll,
   * and only a small subset of those loads are actually referenced by
   * drawTexture in the same frame. Waiting to invalidate until we see the
   * draw dramatically improves cache hit rate for idle animation frames
   * that happen to overlap with a background image load.
   */
  _markHandleDirty(handle) {
    if (!this._recording || this._replaying) return;
    if (this._dirtyHandles) this._dirtyHandles.add(handle);
  }

  /** Replay one recorded op with the cache path bypassed. */
  _executeOp(name, args) {
    // Dispatch by name. Kept explicit (not this[name](...)) so we don't
    // accidentally expose a non-drawing method to the queue.
    switch (name) {
      case 'drawRect':      return this.drawRect(...args);
      case 'fillRect':      return this.fillRect(...args);
      case 'clearRect':     return this.clearRect(...args);
      case 'drawOval':      return this.drawOval(...args);
      case 'fillOval':      return this.fillOval(...args);
      case 'drawRoundRect': return this.drawRoundRect(...args);
      case 'fillRoundRect': return this.fillRoundRect(...args);
      case 'drawLine':      return this.drawLine(...args);
      case 'drawText':      return this.drawText(...args);
      case 'drawTexture':   return this.drawTexture(...args);
    }
  }

  // ── Primitives ────────────────────────────────────────────

  /**
   * Set fill style from ARGB corner colors.
   * If all 4 corners are the same, use solid fill.
   * Otherwise, create a gradient.
   */
  _setGradientFill(ctx, x, y, w, h, argbTL, argbTR, argbBR, argbBL) {
    if (argbTL === argbTR && argbTR === argbBR && argbBR === argbBL) {
      ctx.fillStyle = argbToRgba(argbTL);
      return;
    }

    // Canvas 2D can't do true bilinear 4-corner interpolation like OpenGL.
    // Average all 4 corner colors into a single solid fill — this avoids
    // visible gradient artifacts on thin elements like progress bars.
    const a = (((argbTL >>> 24) & 0xFF) + ((argbTR >>> 24) & 0xFF) +
               ((argbBR >>> 24) & 0xFF) + ((argbBL >>> 24) & 0xFF)) >>> 2;
    const r = (((argbTL >>> 16) & 0xFF) + ((argbTR >>> 16) & 0xFF) +
               ((argbBR >>> 16) & 0xFF) + ((argbBL >>> 16) & 0xFF)) >>> 2;
    const g = (((argbTL >>> 8) & 0xFF) + ((argbTR >>> 8) & 0xFF) +
               ((argbBR >>> 8) & 0xFF) + ((argbBL >>> 8) & 0xFF)) >>> 2;
    const b = ((argbTL & 0xFF) + (argbTR & 0xFF) +
               (argbBR & 0xFF) + (argbBL & 0xFF)) >>> 2;
    ctx.fillStyle = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }

  _setGradientStroke(ctx, x, y, w, h, argbTL, argbTR, argbBR, argbBL) {
    if (argbTL === argbTR && argbTR === argbBR && argbBR === argbBL) {
      ctx.strokeStyle = argbToRgba(argbTL);
      return;
    }
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, argbToRgba(argbTL));
    grad.addColorStop(1, argbToRgba(argbBR));
    ctx.strokeStyle = grad;
  }

  drawRect(x, y, width, height, thickness, argbTL, argbTR, argbBR, argbBL) {
    if (this._recordOp('drawRect', arguments)) return;
    const ctx = this.activeCtx;
    ctx.lineWidth = thickness;
    this._setGradientStroke(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }

  fillRect(x, y, width, height, argbTL, argbTR, argbBR, argbBL) {
    // dirty-full hint runs at record time so cache-hit frames still get the metric
    if (perf.enabled && !this._replaying &&
        x <= 0 && y <= 0 &&
        (x + width) >= this.width && (y + height) >= this.height) {
      perf.noteFullClear();
    }
    if (this._recordOp('fillRect', arguments)) return;
    const ctx = this.activeCtx;
    this._setGradientFill(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillRect(x, y, width, height);
  }

  clearRect(x, y, width, height, argbTL, argbTR, argbBR, argbBL) {
    if (this._recordOp('clearRect', arguments)) return;
    const ctx = this.activeCtx;
    // Clear to transparent then fill with color
    ctx.clearRect(x, y, width, height);
    if (argbTL !== 0) {
      this._setGradientFill(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
      ctx.fillRect(x, y, width, height);
    }
  }

  drawOval(x, y, width, height, thickness, argbTL, argbTR, argbBR, argbBL, clipX, clipY, clipW, clipH) {
    if (this._recordOp('drawOval', arguments)) return;
    const ctx = this.activeCtx;
    ctx.save();
    if (clipW > 0 && clipH > 0) {
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
    }
    ctx.lineWidth = thickness;
    this._setGradientStroke(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  fillOval(x, y, width, height, argbTL, argbTR, argbBR, argbBL, clipX, clipY, clipW, clipH) {
    if (this._recordOp('fillOval', arguments)) return;
    const ctx = this.activeCtx;
    ctx.save();
    if (clipW > 0 && clipH > 0) {
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
    }
    this._setGradientFill(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    ctx.beginPath();
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawRoundRect(x, y, width, height, thickness, arcRadius, argbTL, argbTR, argbBR, argbBL, clipX, clipY, clipW, clipH) {
    if (this._recordOp('drawRoundRect', arguments)) return;
    const ctx = this.activeCtx;
    ctx.save();
    if (clipW > 0 && clipH > 0) {
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
    }
    ctx.lineWidth = thickness;
    this._setGradientStroke(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    this._roundRectPath(ctx, x, y, width, height, arcRadius / 2);
    ctx.stroke();
    ctx.restore();
  }

  fillRoundRect(x, y, width, height, arcRadius, argbTL, argbTR, argbBR, argbBL, clipX, clipY, clipW, clipH) {
    if (this._recordOp('fillRoundRect', arguments)) return;
    const ctx = this.activeCtx;
    ctx.save();
    if (clipW > 0 && clipH > 0) {
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
    }
    this._setGradientFill(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    this._roundRectPath(ctx, x, y, width, height, arcRadius / 2);
    ctx.fill();
    ctx.restore();
  }

  _roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  drawLine(x1, y1, x2, y2, argb1, argb2) {
    if (this._recordOp('drawLine', arguments)) return;
    const ctx = this.activeCtx;
    if (argb1 === argb2) {
      ctx.strokeStyle = argbToRgba(argb1);
    } else {
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, argbToRgba(argb1));
      grad.addColorStop(1, argbToRgba(argb2));
      ctx.strokeStyle = grad;
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1 + 0.5, y1 + 0.5);
    ctx.lineTo(x2 + 0.5, y2 + 0.5);
    ctx.stroke();
  }

  /**
   * Draw text string at (x, y) with clipping.
   * @param {number} x
   * @param {number} y - baseline Y position
   * @param {string} text
   * @param {{ name: string, style: number, size: number }|undefined} fontInfo
   * @param {number} argb - text color
   * @param {number} clipX
   * @param {number} clipY
   * @param {number} clipW
   * @param {number} clipH
   */
  drawText(x, y, text, fontInfo, argb, clipX, clipY, clipW, clipH) {
    if (perf.enabled && !this._replaying) perf.bumpText();
    if (this._recordOp('drawText', arguments)) return;
    const ctx = this.activeCtx;
    const hasClip = clipW > 0 && clipH > 0;

    if (hasClip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
    }

    // WebKit re-parses ctx.font on every assignment — cache per-context so
    // a run of same-font draws (the common menu case) avoids the reparse.
    const size = fontInfo ? fontInfo.size : 16;
    const style = fontInfo ? fontInfo.style : 0;
    const name = fontInfo ? fontInfo.name : 'sans-serif';
    const bold = (style & 1) ? 'bold ' : '';
    const italic = (style & 2) ? 'italic ' : '';
    const fontStr = `${italic}${bold}${size}px "${name}", sans-serif`;
    if (ctx._lastFont !== fontStr) {
      ctx.font = fontStr;
      ctx._lastFont = fontStr;
    }

    ctx.fillStyle = argbToRgba(argb);
    ctx.fillText(text, x, y);

    if (hasClip) {
      ctx.restore();
    }
  }

  // ── Textures / Images ─────────────────────────────────────

  /**
   * Allocate an image slot.
   */
  loadImage(handle, width, height) {
    this._markHandleDirty(handle);
    // Create a raw buffer for line-by-line accumulation.
    // Actual Canvas + putImageData is deferred until the image is first used
    // (drawTexture/xfmImage). This avoids expensive per-line putImageData
    // calls and lets the event loop flush WebSocket replies between commands.
    const rawBuffer = new Uint8Array(width * height * 4); // RGBA straight
    this.images.set(handle, {
      bitmap: null, canvas: null, ctx: null, width, height, loaded: false,
      _rawBuffer: rawBuffer,
      _linesReceived: 0,
      _finalized: false
    });
    this._currentCachePixels += width * height;
  }

  /**
   * Load a single line of image data (raw ARGB pixels).
   * Copies data into a backing buffer immediately — no Canvas work.
   * Raw bytes are stored as-is (zero conversion) — the ARGB→RGBA swap
   * happens in bulk during _finalizeImage() using Uint32Array.
   */
  loadImageLine(handle, line, len, data) {
    this._markHandleDirty(handle);
    const img = this.images.get(handle);
    if (!img || !img._rawBuffer) return;

    // Pure memcpy — no per-pixel conversion. TypedArray.set() is native C++.
    const dstOffset = line * img.width * 4;
    img._rawBuffer.set(data.subarray(0, img.width * 4), dstOffset);

    img._linesReceived++;
    img.loaded = true;

    // Auto-finalize when all lines received
    if (img._linesReceived >= img.height) {
      this._finalizeImage(handle);
    }
  }

  /**
   * Finalize a buffered image: bulk ARGB→RGBA conversion + single putImageData.
   * Called automatically when all lines are received, or lazily before first use.
   *
   * Uses Uint32Array for the conversion — one read+write per pixel instead of
   * 4-8 byte operations. On little-endian (all modern devices):
   *   Source bytes [A,R,G,B] → LE uint32: 0xBGRA
   *   Dest   bytes [R,G,B,A] → LE uint32: 0xABGR
   * Opaque: dest = ((src >>> 8) & 0x00FFFFFF) | 0xFF000000  (two ops!)
   */
  _finalizeImage(handle) {
    const img = this.images.get(handle);
    if (!img || img._finalized || !img._rawBuffer) return;

    const buf = img._rawBuffer;
    const totalPixels = img.width * img.height;
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, totalPixels);

    for (let i = 0; i < totalPixels; i++) {
      const px = u32[i];
      if (px === 0) continue; // fully transparent
      const a = px & 0xFF;    // alpha is LSB on LE
      if (a === 255) {
        // Fully opaque (most UI pixels): rotate BGRA → ABGR
        u32[i] = ((px >>> 8) & 0x00FFFFFF) | 0xFF000000;
      } else if (a === 0) {
        u32[i] = 0;
      } else {
        // Semi-transparent — un-premultiply + swap (rare)
        const invA = 255 / a;
        const r = Math.min(255, (((px >>> 8) & 0xFF) * invA) | 0);
        const g = Math.min(255, (((px >>> 16) & 0xFF) * invA) | 0);
        const b = Math.min(255, ((px >>> 24) * invA) | 0);
        u32[i] = r | (g << 8) | (b << 16) | (a << 24);
      }
    }

    const imageData = new ImageData(
      new Uint8ClampedArray(buf.buffer, buf.byteOffset, totalPixels * 4),
      img.width, img.height
    );

    img.bitmap = null;
    img.canvas = null;
    img.ctx = null;
    img._finalized = true;
    img._rawBuffer = null;
    img._imageData = imageData; // sync fallback if drawTexture beats bitmap promise

    // Single GPU upload: ImageData → ImageBitmap. Skips the intermediate
    // putImageData(canvas) + createImageBitmap(canvas) double conversion.
    if (typeof createImageBitmap === 'function') {
      this._pendingImageLoads++;
      const _decT0 = perf.enabled ? perf.now() : 0;
      createImageBitmap(imageData).then((bitmap) => {
        if (perf.enabled) perf.addImageDecodeMs(perf.now() - _decT0);
        const current = this.images.get(handle);
        if (!current) { bitmap.close?.(); return; }
        if (current.bitmap && current.bitmap !== bitmap && current.bitmap.close) {
          try { current.bitmap.close(); } catch { /* ignore */ }
        }
        current.bitmap = bitmap;
        current.canvas = null;
        current.ctx = null;
        current._imageData = null;
      }).catch((err) => {
        console.warn(`[Renderer] createImageBitmap(ImageData) failed for ${handle}, using canvas fallback:`, err?.message || err);
        this._materializeCanvas(handle);
      }).finally(() => {
        this._completePendingImageLoad();
      });
      return;
    }

    this._materializeCanvas(handle);
  }

  /**
   * Synchronously realize a canvas from a pending ImageData fallback.
   * Used when createImageBitmap is unsupported or fails, and when
   * drawTexture fires before the async bitmap promise resolves.
   */
  _materializeCanvas(handle) {
    const img = this.images.get(handle);
    if (!img || img.canvas || img.bitmap || !img._imageData) return;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = this._configureCtx(canvas.getContext('2d'));
    ctx.putImageData(img._imageData, 0, 0);
    img.canvas = canvas;
    img.ctx = ctx;
  }

  /**
   * Ensure an image is finalized before use (lazy finalization).
   */
  _ensureFinalized(handle) {
    const img = this.images.get(handle);
    if (img && !img._finalized && img._rawBuffer) {
      this._finalizeImage(handle);
    }
  }

  /**
   * Load a compressed image (JPEG, PNG, GIF, BMP).
   * Returns a Promise that resolves when the image is decoded and stored.
   * This allows the GFX pipeline to pause until the image is ready,
   * matching Java's synchronous decode behavior.
   */
  loadCompressedImage(handle, data) {
    this._markHandleDirty(handle);
    const blob = new Blob([data]);
    if (typeof createImageBitmap === 'function') {
      this._pendingImageLoads++;
      const _decT0 = perf.enabled ? perf.now() : 0;
      return createImageBitmap(blob).then((bitmap) => {
        if (perf.enabled) perf.addImageDecodeMs(perf.now() - _decT0);
        this.images.set(handle, {
          bitmap,
          canvas: null,
          ctx: null,
          width: bitmap.width,
          height: bitmap.height,
          loaded: true,
          _finalized: true,
        });
        this._currentCachePixels += bitmap.width * bitmap.height;
      }).catch((err) => {
        console.warn(`[Renderer] Failed to decode image handle=${handle}:`, err.message);
        return this._loadCompressedImageFallback(handle, blob);
      }).finally(() => {
        this._completePendingImageLoad();
      });
    }

    return this._loadCompressedImageFallback(handle, blob);
  }

  /**
   * Unload an image, freeing memory.
   */
  unloadImage(handle) {
    this._markHandleDirty(handle);
    const img = this.images.get(handle);
    if (img) {
      this._releaseImageResources(img);
      this._currentCachePixels -= img.width * img.height;
      this.images.delete(handle);
    }
    // Surfaces also consume the shared pixel budget (added in createSurface).
    // Previously their pixels were never subtracted here, so every
    // create/destroy surface cycle (menu transitions, animated posters) leaked
    // the counter upward until canCacheImage() returned false permanently —
    // after which every poster round-tripped from the server (the multi-second
    // per-row menu lag). Subtract them on delete to keep the budget honest.
    const surf = this.surfaces.get(handle);
    if (surf) {
      this._currentCachePixels -= surf.width * surf.height;
      this.surfaces.delete(handle);
    }
    if (this._currentCachePixels < 0) this._currentCachePixels = 0;
  }

  /**
   * Check if we can cache an image of the given size.
   */
  canCacheImage(width, height) {
    return this._currentCachePixels + (width * height) < this._maxCachePixels;
  }

  /**
   * Check if an image handle exists (even if still loading).
   */
  hasImage(handle) {
    return this.images.has(handle);
  }

  /**
   * Draw a textured rectangle (blit from image cache).
   */
  drawTexture(x, y, width, height, handle, srcx, srcy, srcw, srch, blend) {
    if (this._recordOp('drawTexture', arguments)) return;
    const ctx = this.activeCtx;
    this._ensureFinalized(handle);
    const img = this.images.get(handle) || this.surfaces.get(handle);
    if (!img) return;

    let source = img.bitmap || img.canvas;
    if (!source && img._imageData) {
      this._materializeCanvas(handle);
      source = img.canvas;
    }
    if (!source) return;

    if (srcw === 0 || srch === 0 || width === 0 || height === 0) return;

    // Java: negative height = opaque overwrite (GL_ONE, GL_ZERO)
    // Width/height are always used as absolute values for drawing
    const opaqueOverwrite = height < 0;
    const absW = Math.abs(width);
    const absH = Math.abs(height);

    // Per-frame draw accounting for perf instrumentation (cheap int adds).
    this._frameDrawImage++;
    if (srcw !== absW || srch !== absH) this._frameScaledDraw++;

    const blendA = ((blend >>> 24) & 0xFF) / 255;
    const blendR = (blend >>> 16) & 0xFF;
    const blendG = (blend >>> 8) & 0xFF;
    const blendB = blend & 0xFF;

    const wantComposite = opaqueOverwrite ? 'copy' : 'source-over';
    const wantAlpha = opaqueOverwrite ? 1.0 : blendA;
    const _timing = perf.enabled;

    if (blendR === 255 && blendG === 255 && blendB === 255) {
      // ── Hot path: no color tint. Avoid ctx.save()/restore() entirely.
      // save/restore push/pop the FULL graphics state and are dispro-
      // portionately expensive on WebKit/Tizen. We only change two fields
      // (globalCompositeOperation, globalAlpha), so track them per-ctx and
      // reset to defaults after, which is far cheaper than a state stack op.
      if (ctx._curComposite !== wantComposite) {
        ctx.globalCompositeOperation = wantComposite;
        ctx._curComposite = wantComposite;
      }
      if (ctx._curAlpha !== wantAlpha) {
        ctx.globalAlpha = wantAlpha;
        ctx._curAlpha = wantAlpha;
      }
      try {
        if (_timing) {
          const _b0 = perf.now();
          ctx.drawImage(source, srcx, srcy, srcw, srch, x, y, absW, absH);
          this._texBlitMs += perf.now() - _b0;
          this._texBlitCount++;
        } else {
          ctx.drawImage(source, srcx, srcy, srcw, srch, x, y, absW, absH);
        }
      } catch (e) { /* image may not be loaded yet */ }
      // Reset to the defaults every other draw method assumes.
      if (ctx._curComposite !== 'source-over') {
        ctx.globalCompositeOperation = 'source-over';
        ctx._curComposite = 'source-over';
      }
      if (ctx._curAlpha !== 1) {
        ctx.globalAlpha = 1;
        ctx._curAlpha = 1;
      }
      return;
    }

    // ── Tint path (rare): needs a temp canvas + multiple composite ops.
    // Keep save/restore here since it's infrequent and juggles more state.
    ctx.save();
    ctx.globalCompositeOperation = wantComposite;
    ctx.globalAlpha = wantAlpha;
    try {
      // Apply color tint via temporary canvas
      if (!this._tintCanvas || this._tintCanvas.width < absW || this._tintCanvas.height < absH) {
        this._tintCanvas = document.createElement('canvas');
        this._tintCanvas.width = Math.max(absW, 256);
        this._tintCanvas.height = Math.max(absH, 256);
        this._tintCtx = this._configureCtx(this._tintCanvas.getContext('2d'));
      }
      const tc = this._tintCtx;
      tc.globalCompositeOperation = 'source-over';
      tc.clearRect(0, 0, absW, absH);
      tc.drawImage(source, srcx, srcy, srcw, srch, 0, 0, absW, absH);
      // Multiply RGB with tint color
      tc.globalCompositeOperation = 'multiply';
      tc.fillStyle = `rgb(${blendR},${blendG},${blendB})`;
      tc.fillRect(0, 0, absW, absH);
      // Restore original alpha (multiply destroys it for translucent pixels)
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(source, srcx, srcy, srcw, srch, 0, 0, absW, absH);
      // Draw tinted result onto target
      const _b0 = _timing ? perf.now() : 0;
      ctx.drawImage(this._tintCanvas, 0, 0, absW, absH, x, y, absW, absH);
      if (_timing) { this._texBlitMs += perf.now() - _b0; this._texBlitCount++; }
    } catch (e) {
      // Image may not be loaded yet
    }
    ctx.restore();
    // save/restore reset the tracked state; clear our shadow so the next
    // fast-path draw re-asserts it.
    ctx._curComposite = undefined;
    ctx._curAlpha = undefined;
  }

  // ── Surfaces ──────────────────────────────────────────────

  /**
   * Create an off-screen rendering surface.
   */
  createSurface(handle, width, height) {
    this._markHandleDirty(handle);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = this._configureCtx(canvas.getContext('2d', { alpha: true }));
    // Clear to transparent
    ctx.clearRect(0, 0, width, height);
    this.surfaces.set(handle, { canvas, ctx, width, height });
    this._currentCachePixels += width * height;
  }

  /**
   * Set the current rendering target.
   * handle=0 means the main (back) canvas.
   */
  setTargetSurface(handle) {
    // Note: we don't invalidate the frame cache here just because the target
    // changed. If the frame only SWITCHES targets without drawing to non-main,
    // there's nothing to cache-bust. _recordOp handles the actual bust when
    // a draw is issued to non-main.
    this.targetSurface = handle;
    if (handle === 0) {
      this.activeCtx = this.backCtx;
    } else {
      const surface = this.surfaces.get(handle);
      if (surface) {
        this.activeCtx = surface.ctx;
      } else {
        console.warn(`[Renderer] Target surface ${handle} not found`);
        this.activeCtx = this.backCtx;
      }
    }
  }

  // ── Image Transforms ──────────────────────────────────────

  /**
   * Transform an image (resize + optional corner mask).
   */
  xfmImage(srcHandle, destHandle, destWidth, destHeight, maskCornerArc) {
    // Only destHandle content changes; srcHandle is read-only.
    this._markHandleDirty(destHandle);
    this._ensureFinalized(srcHandle);
    const srcImg = this.images.get(srcHandle);
    if (!srcImg) return;
    const source = srcImg.bitmap || srcImg.canvas;
    if (!source) return;

    const canvas = document.createElement('canvas');
    canvas.width = destWidth;
    canvas.height = destHeight;
    const ctx = this._configureCtx(canvas.getContext('2d'));

    if (maskCornerArc > 0) {
      // Apply rounded corner mask
      this._roundRectPath(ctx, 0, 0, destWidth, destHeight, maskCornerArc);
      ctx.clip();
    }

    ctx.drawImage(source, 0, 0, destWidth, destHeight);

    this.images.set(destHandle, {
      bitmap: null, canvas, ctx, width: destWidth, height: destHeight, loaded: true, _finalized: true
    });
    this._currentCachePixels += destWidth * destHeight;
    // Skip async ImageBitmap promotion on slow-GPU targets (iOS, Tizen TV).
    // These are transient scaled posters and the concurrent burst stalls menu
    // paint. Canvas works fine as a drawImage source.
    if (!this._slowGpu) {
      this._promoteCanvasToBitmap(destHandle, canvas);
    }
  }

  // ── Transform Stack ───────────────────────────────────────

  /**
   * Push a 3x4 affine transform matrix.
   * Matrix layout (row-major):
   *   [m0  m1  m2  m3 ]   (m3  = translateX)
   *   [m4  m5  m6  m7 ]   (m7  = translateY)
   *   [m8  m9  m10 m11]   (m11 = translateZ, ignored in 2D)
   */
  pushTransform(matrix) {
    const ctx = this.activeCtx;
    ctx.save();
    this.transformStack.push(true);

    // Canvas 2D transform: (a, b, c, d, e, f)
    // Maps to: a=m0, b=m4, c=m1, d=m5, e=m3, f=m7
    ctx.transform(
      matrix[0],  // a (scaleX)
      matrix[4],  // b (skewY)
      matrix[1],  // c (skewX)
      matrix[5],  // d (scaleY)
      matrix[3],  // e (translateX)
      matrix[7]   // f (translateY)
    );
  }

  popTransform() {
    if (this.transformStack.length > 0) {
      this.transformStack.pop();
      this.activeCtx.restore();
    }
  }

  // ── Font Stream ───────────────────────────────────────────

  loadFontStream(name, data) {
    try {
      const blob = new Blob([data]);
      const url = URL.createObjectURL(blob);
      const font = new FontFace(name, `url(${url})`);
      font.load().then((loaded) => {
        document.fonts.add(loaded);
        console.log(`[Renderer] Font loaded: ${name}`);
      }).catch((err) => {
        console.warn(`[Renderer] Font load failed: ${name}`, err);
      });
    } catch (e) {
      console.warn(`[Renderer] Font stream error: ${name}`, e);
    }
  }

  // ── Video Bounds ──────────────────────────────────────────

  setVideoBounds(srcRect, destRect) {
    this.videoBounds = { src: srcRect, dest: destRect };
    // Dispatch event so the media player can position the <video> element
    this.canvas.dispatchEvent(new CustomEvent('videobounds', {
      detail: { src: srcRect, dest: destRect }
    }));
  }

  // ── Offline Image Cache ───────────────────────────────────

  getCachedImage(resourceId) {
    return this._offlineCache.get(resourceId) || null;
  }

  putCachedImage(handle, cachedData, width, height) {
    // cachedData is a canvas or ImageBitmap from the offline cache
    const bitmap = cachedData.bitmap ||
      ((typeof ImageBitmap !== 'undefined' && cachedData instanceof ImageBitmap) ? cachedData : null);
    this.images.set(handle, {
      bitmap,
      canvas: cachedData.canvas || (bitmap ? null : cachedData),
      ctx: cachedData.ctx || null,
      width, height, loaded: true
    });
    this._currentCachePixels += width * height;
  }

  _releaseImageResources(img) {
    if (!img) return;
    if (img.bitmap && img.bitmap.close) {
      try { img.bitmap.close(); } catch { /* ignore */ }
    }
    img.bitmap = null;
    img.canvas = null;
    img.ctx = null;
    img._rawBuffer = null;
  }

  _completePendingImageLoad() {
    if (this._pendingImageLoads > 0) {
      this._pendingImageLoads--;
    }
    if (this._pendingImageLoads === 0 && typeof this.onImagesReady === 'function') {
      try {
        this.onImagesReady();
      } catch (err) {
        console.warn('[Renderer] onImagesReady failed:', err?.message || err);
      }
    }
  }

  _promoteCanvasToBitmap(handle, canvas) {
    if (typeof createImageBitmap !== 'function' || !canvas) {
      return;
    }

    const img = this.images.get(handle);
    if (!img) {
      return;
    }

    this._pendingImageLoads++;
    createImageBitmap(canvas).then((bitmap) => {
      const current = this.images.get(handle);
      if (!current) {
        bitmap.close?.();
        return;
      }

      if (current.bitmap && current.bitmap !== bitmap && current.bitmap.close) {
        try { current.bitmap.close(); } catch { /* ignore */ }
      }

      current.bitmap = bitmap;
      current.canvas = null;
      current.ctx = null;
    }).catch((err) => {
      console.warn(`[Renderer] Failed to promote image ${handle} to ImageBitmap:`, err?.message || err);
    }).finally(() => {
      this._completePendingImageLoad();
    });
  }

  _loadCompressedImageFallback(handle, blob) {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    return new Promise((resolve) => {
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = this._configureCtx(canvas.getContext('2d'));
        ctx.drawImage(image, 0, 0);
        URL.revokeObjectURL(objectUrl);

        this.images.set(handle, {
          bitmap: null,
          canvas,
          ctx,
          width: canvas.width,
          height: canvas.height,
          loaded: true,
          _finalized: true,
        });
        this._currentCachePixels += canvas.width * canvas.height;
        resolve();
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        console.warn(`[Renderer] Failed to decode image handle=${handle}`);
        if (!this.images.has(handle)) {
          const placeholder = document.createElement('canvas');
          placeholder.width = 1;
          placeholder.height = 1;
          this.images.set(handle, {
            bitmap: null,
            canvas: placeholder,
            ctx: this._configureCtx(placeholder.getContext('2d')),
            width: 1,
            height: 1,
            loaded: false,
            _finalized: true,
          });
        }
        resolve();
      };
      image.src = objectUrl;
    });
  }

  registerTexture(img) {
    // No-op for Canvas 2D (needed for OpenGL path)
  }

  /**
   * Apply uniform per-context defaults: low-quality smoothing (avoids
   * WebKit's expensive default resampler on scaled blits) and a stable
   * text baseline so drawText doesn't need to reset it per call.
   */
  _configureCtx(ctx) {
    if (!ctx) return ctx;
    try {
      ctx.imageSmoothingEnabled = true;
      // PWA5: 'high' produces sharper downscales on desktop/Android where the
      // GPU resampler is cheap. On WebKit (iPad) and Tizen TVs the 'high'
      // resampler is a measurable per-blit cost during menu paint bursts, so
      // those targets default to 'low' (set via this._smoothingQuality in the
      // constructor). Overridable with options.smoothingQuality.
      ctx.imageSmoothingQuality = this._smoothingQuality || 'high';
    } catch { /* older browsers */ }
    try { ctx.textBaseline = 'top'; } catch { /* ignore */ }
    return ctx;
  }

  /**
   * Get the screen/canvas size.
   */
  getScreenSize() {
    return { width: this.width, height: this.height };
  }

  /**
   * Snapshot of image/surface cache state for perf instrumentation (PWA0).
   * Computed on demand (only called once per frame when perf is enabled), so
   * it does not add hot-path overhead. Pixel→byte uses 4 bytes/pixel (RGBA).
   *
   * evictionsThisFrame/evictionsTotal are always 0: this client never evicts
   * cached images unilaterally, because the SageTV server owns handle
   * lifecycle (it assumes any handle it received stays cached until it sends
   * UNLOADIMAGE). The fields are kept for schema stability.
   */
  getCacheStats() {
    let imagePixels = 0;
    for (const img of this.images.values()) imagePixels += img.width * img.height;
    let surfacePixels = 0;
    for (const s of this.surfaces.values()) surfacePixels += s.width * s.height;
    const usedPixels = imagePixels + surfacePixels;
    return {
      imageCount: this.images.size,
      surfaceCount: this.surfaces.size,
      imagePixels,
      surfacePixels,
      usedPixels,
      budgetPixels: this._maxCachePixels,
      usedBytes: usedPixels * 4,
      imageBytes: imagePixels * 4,
      surfaceBytes: surfacePixels * 4,
      budgetBytes: this._maxCachePixels * 4,
      accountedPixels: this._currentCachePixels,
      pendingImageLoads: this._pendingImageLoads,
      drawImageThisFrame: this._frameDrawImage,
      scaledDrawsThisFrame: this._frameScaledDraw,
      evictionsThisFrame: 0,
      evictionsTotal: 0,
      // Frame-cache stats (0 if disabled)
      frameCacheEnabled: this._frameCacheEnabled,
      frameCacheHits: this._cacheHits,
      frameCacheMisses: this._cacheMisses,
      frameCacheSkipped: this._cacheSkipped,
      // Top-2 invalidation reasons — helps explain "why is hit rate low?"
      frameCacheTopInvalidations: this._topInvalidationReasons(2),
      // Isolated drawImage (blit) wall time this frame — tells us whether the
      // per-texture blit itself dominates vs surrounding state/queue overhead.
      texBlitMs: this._texBlitMs || 0,
      texBlitCount: this._texBlitCount || 0,
    };
  }

  /** Return the top-N invalidation reasons as a "reason:count,reason:count" string. */
  _topInvalidationReasons(n) {
    const entries = Object.entries(this._invalidateReasons);
    if (!entries.length) return '';
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, n).map(([k, v]) => `${k}:${v}`).join(',');
  }
}
