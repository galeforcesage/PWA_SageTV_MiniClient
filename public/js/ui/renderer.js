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

export class CanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas - The main rendering canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
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
    this.backCtx = this.backCanvas.getContext('2d', { alpha: true });
    this.activeCtx = this.backCtx;

    // Max cache size (128MB equivalent in pixels)
    this._maxCachePixels = 128 * 1024 * 1024 / 4;
    this._currentCachePixels = 0;

    // Pending async image load tracking
    this._pendingImageLoads = 0;
    this.onImagesReady = null; // callback when all pending loads complete
  }

  // ── Lifecycle ─────────────────────────────────────────────

  init() {
    // Clear all cached images, surfaces, and pixel counter — matching Java's
    // GFXCMD2.INIT which resets all state for a fresh rendering session.
    // Without this, stale images from previous connections consume the cache
    // budget and cause new LOADIMAGE calls to return 0 (can't cache).
    this.images.forEach((img) => {
      if (img.bitmap && img.bitmap.close) img.bitmap.close();
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
      if (img.bitmap && img.bitmap.close) img.bitmap.close();
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
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.backCtx = this.backCanvas.getContext('2d', { alpha: true });
    this.activeCtx = this.backCtx;
    console.log(`[Renderer] Resized to ${width}x${height}`);
  }

  startFrame() {
    this._frameStarted = true;
    this.activeCtx = this.backCtx;
    this.targetSurface = 0;
  }

  flipBuffer() {
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
    const ctx = this.activeCtx;
    ctx.lineWidth = thickness;
    this._setGradientStroke(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }

  fillRect(x, y, width, height, argbTL, argbTR, argbBR, argbBL) {
    const ctx = this.activeCtx;
    this._setGradientFill(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillRect(x, y, width, height);
  }

  clearRect(x, y, width, height, argbTL, argbTR, argbBR, argbBL) {
    const ctx = this.activeCtx;
    // Clear to transparent then fill with color
    ctx.clearRect(x, y, width, height);
    if (argbTL !== 0) {
      this._setGradientFill(ctx, x, y, width, height, argbTL, argbTR, argbBR, argbBL);
      ctx.fillRect(x, y, width, height);
    }
  }

  drawOval(x, y, width, height, thickness, argbTL, argbTR, argbBR, argbBL, clipX, clipY, clipW, clipH) {
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
    const ctx = this.activeCtx;
    ctx.save();

    // Apply clip rect
    if (clipW > 0 && clipH > 0) {
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
    }

    // Build CSS font string
    const size = fontInfo ? fontInfo.size : 16;
    const style = fontInfo ? fontInfo.style : 0;
    const name = fontInfo ? fontInfo.name : 'sans-serif';
    const bold = (style & 1) ? 'bold ' : '';
    const italic = (style & 2) ? 'italic ' : '';
    ctx.font = `${italic}${bold}${size}px "${name}", sans-serif`;

    // Set color
    ctx.fillStyle = argbToRgba(argb);
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);

    ctx.restore();
  }

  // ── Textures / Images ─────────────────────────────────────

  /**
   * Allocate an image slot.
   */
  loadImage(handle, width, height) {
    // Create a raw buffer for line-by-line accumulation.
    // Actual Canvas + putImageData is deferred until the image is first used
    // (drawTexture/xfmImage). This avoids expensive per-line putImageData
    // calls and lets the event loop flush WebSocket replies between commands.
    const rawBuffer = new Uint8Array(width * height * 4); // RGBA straight
    this.images.set(handle, {
      canvas: null, ctx: null, width, height, loaded: false,
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

    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(
      new Uint8ClampedArray(buf.buffer, buf.byteOffset, totalPixels * 4),
      img.width, img.height
    );
    ctx.putImageData(imageData, 0, 0);

    img.canvas = canvas;
    img.ctx = ctx;
    img._finalized = true;
    img._rawBuffer = null; // Free the raw buffer
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
    const blob = new Blob([data]);
    return createImageBitmap(blob).then((bitmap) => {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      this.images.set(handle, {
        canvas, ctx, width: canvas.width, height: canvas.height, loaded: true
      });
      this._currentCachePixels += canvas.width * canvas.height;
    }).catch((err) => {
      console.warn(`[Renderer] Failed to decode image handle=${handle}:`, err.message);
      // Leave a transparent placeholder on failure
      if (!this.images.has(handle)) {
        const placeholder = document.createElement('canvas');
        placeholder.width = 1;
        placeholder.height = 1;
        this.images.set(handle, {
          canvas: placeholder,
          ctx: placeholder.getContext('2d'),
          width: 1, height: 1, loaded: false
        });
      }
    });
  }

  /**
   * Unload an image, freeing memory.
   */
  unloadImage(handle) {
    const img = this.images.get(handle);
    if (img) {
      this._currentCachePixels -= img.width * img.height;
      this.images.delete(handle);
    }
    // Also check surfaces
    this.surfaces.delete(handle);
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
    const ctx = this.activeCtx;
    this._ensureFinalized(handle);
    const img = this.images.get(handle) || this.surfaces.get(handle);
    if (!img) return;

    const source = img.canvas || img.bitmap;
    if (!source) return;

    if (srcw === 0 || srch === 0 || width === 0 || height === 0) return;

    // Java: negative height = opaque overwrite (GL_ONE, GL_ZERO)
    // Width/height are always used as absolute values for drawing
    const opaqueOverwrite = height < 0;
    const absW = Math.abs(width);
    const absH = Math.abs(height);

    const blendA = ((blend >>> 24) & 0xFF) / 255;
    const blendR = (blend >>> 16) & 0xFF;
    const blendG = (blend >>> 8) & 0xFF;
    const blendB = blend & 0xFF;

    ctx.save();

    if (opaqueOverwrite) {
      // Equivalent to GL_ONE, GL_ZERO: source replaces destination completely
      ctx.globalCompositeOperation = 'copy';
      ctx.globalAlpha = 1.0;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = blendA;
    }

    try {
      if (blendR === 255 && blendG === 255 && blendB === 255) {
        // No color tint — just apply alpha and draw
        ctx.drawImage(source, srcx, srcy, srcw, srch, x, y, absW, absH);
      } else {
        // Apply color tint via temporary canvas
        if (!this._tintCanvas || this._tintCanvas.width < absW || this._tintCanvas.height < absH) {
          this._tintCanvas = document.createElement('canvas');
          this._tintCanvas.width = Math.max(absW, 256);
          this._tintCanvas.height = Math.max(absH, 256);
          this._tintCtx = this._tintCanvas.getContext('2d');
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
        ctx.drawImage(this._tintCanvas, 0, 0, absW, absH, x, y, absW, absH);
      }
    } catch (e) {
      // Image may not be loaded yet
    }

    ctx.restore();
  }

  // ── Surfaces ──────────────────────────────────────────────

  /**
   * Create an off-screen rendering surface.
   */
  createSurface(handle, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
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
    this._ensureFinalized(srcHandle);
    const srcImg = this.images.get(srcHandle);
    if (!srcImg) return;

    const canvas = document.createElement('canvas');
    canvas.width = destWidth;
    canvas.height = destHeight;
    const ctx = canvas.getContext('2d');

    if (maskCornerArc > 0) {
      // Apply rounded corner mask
      this._roundRectPath(ctx, 0, 0, destWidth, destHeight, maskCornerArc);
      ctx.clip();
    }

    ctx.drawImage(srcImg.canvas, 0, 0, destWidth, destHeight);

    this.images.set(destHandle, {
      canvas, ctx, width: destWidth, height: destHeight, loaded: true
    });
    this._currentCachePixels += destWidth * destHeight;
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
    this.images.set(handle, {
      canvas: cachedData.canvas || cachedData,
      ctx: cachedData.ctx || null,
      width, height, loaded: true
    });
    this._currentCachePixels += width * height;
  }

  registerTexture(img) {
    // No-op for Canvas 2D (needed for OpenGL path)
  }

  /**
   * Get the screen/canvas size.
   */
  getScreenSize() {
    return { width: this.width, height: this.height };
  }
}
