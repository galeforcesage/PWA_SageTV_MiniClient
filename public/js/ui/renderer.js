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

    // Approximate 4-corner gradient using a diagonal linear gradient
    // Canvas 2D doesn't support 4-corner gradients natively
    const grad = ctx.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, argbToRgba(argbTL));
    grad.addColorStop(0.5, argbToRgba(argbTR)); // approximate
    grad.addColorStop(1, argbToRgba(argbBR));
    ctx.fillStyle = grad;
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
    // Create an ImageData buffer for line-by-line loading
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.images.set(handle, { canvas, ctx, width, height, loaded: false });
    this._currentCachePixels += width * height;
  }

  /**
   * Load a single line of image data (raw ARGB pixels).
   * Server sends big-endian ARGB. With PREMULTIPLY mode, RGB values are
   * pre-multiplied by alpha. Canvas putImageData expects straight (non-premultiplied)
   * RGBA, so we must un-premultiply: R = R_pm * 255 / A, etc.
   */
  loadImageLine(handle, line, len, data) {
    const img = this.images.get(handle);
    if (!img) return;

    const pixelCount = Math.floor(len / 4);
    const imageData = img.ctx.createImageData(pixelCount, 1);
    const pixels = imageData.data;

    // Convert premultiplied ARGB → straight RGBA
    for (let i = 0; i < pixelCount; i++) {
      const srcOff = i * 4;
      const dstOff = i * 4;
      const a = data[srcOff];     // A (premultiplied alpha)
      const rPm = data[srcOff + 1]; // R (premultiplied)
      const gPm = data[srcOff + 2]; // G (premultiplied)
      const bPm = data[srcOff + 3]; // B (premultiplied)
      if (a === 0) {
        pixels[dstOff] = 0;
        pixels[dstOff + 1] = 0;
        pixels[dstOff + 2] = 0;
        pixels[dstOff + 3] = 0;
      } else if (a === 255) {
        pixels[dstOff] = rPm;
        pixels[dstOff + 1] = gPm;
        pixels[dstOff + 2] = bPm;
        pixels[dstOff + 3] = 255;
      } else {
        // Un-premultiply: straight = premultiplied * 255 / alpha
        pixels[dstOff] = Math.min(255, (rPm * 255 / a) | 0);
        pixels[dstOff + 1] = Math.min(255, (gPm * 255 / a) | 0);
        pixels[dstOff + 2] = Math.min(255, (bPm * 255 / a) | 0);
        pixels[dstOff + 3] = a;
      }
    }

    img.ctx.putImageData(imageData, 0, line);
    img.loaded = true;

    // One-shot diagnostic: dump first non-zero pixel from line 0 and a mid-line
    if (!img._diagnosed && (line === 0 || line === Math.floor(img.height / 2))) {
      if (line > 0) img._diagnosed = true; // diagnose after mid-line
      let sample = 'all-zero';
      for (let i = 0; i < pixelCount && i < 400; i++) {
        const a = data[i * 4], r = data[i * 4 + 1], g = data[i * 4 + 2], b = data[i * 4 + 3];
        if (a !== 0 || r !== 0 || g !== 0 || b !== 0) {
          sample = `px${i}:ARGB(${a},${r},${g},${b})`;
          break;
        }
      }
      console.log(`[Renderer] Image h${handle} line${line}: ${sample} (${img.width}x${img.height})`);
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
      ctx.globalCompositeOperation = 'source-over';
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
