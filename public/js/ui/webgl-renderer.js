/**
 * SageTV MiniClient WebGL UIRenderer (Phase 2.5)
 *
 * Drop-in replacement for CanvasRenderer that draws the SageTV GFX command
 * stream with WebGL 1.0 instead of Canvas2D. Motivation: on Tizen/iPad the
 * Canvas2D drawImage (blit) costs ~2ms each; a menu frame issues ~1000 of
 * them = ~2s. The same 1000 textured quads in WebGL run in single-digit ms
 * because that's exactly what GPUs do natively.
 *
 * Public interface matches CanvasRenderer exactly so SessionManager /
 * MiniClientConnection can use either interchangeably. If a WebGL context
 * can't be created, callers should fall back to CanvasRenderer (see
 * WebGLRenderer.isSupported()).
 *
 * Architecture:
 *  - Two shader programs: a textured-quad program (images, text, rasterized
 *    primitives) and a solid/gradient-color program (fillRect with true
 *    4-corner bilinear gradients).
 *  - Images: SageTV streams raw ARGB lines -> converted to RGBA -> uploaded
 *    as a GL texture per handle. Compressed images decode via createImageBitmap.
 *  - Text + complex vector primitives (oval, round-rect, line, rect stroke)
 *    are rasterized to a small offscreen 2D canvas, uploaded as a texture, and
 *    CACHED by content key. SageTV redraws the same labels / focus box every
 *    frame, so the cache hit rate is very high and the raster cost amortizes.
 *  - Surfaces (CREATESURFACE / SETTARGETSURFACE) map to WebGL framebuffer
 *    objects (render-to-texture). XFMIMAGE renders a scaled + optionally
 *    rounded-masked copy into a new texture.
 *  - Draw order is preserved: every op emits its quad in sequence to the same
 *    target framebuffer (no layer separation), matching Canvas2D semantics.
 *
 * Coordinate convention: top-left origin, pixel units. One projection for all
 * passes; textures rendered into FBOs sample with a flipped V (GL's bottom-
 * left texture origin), tracked per-source via a flipV flag.
 */

import { perf } from '../perf/perf-monitor.js';

// ── Shader sources ────────────────────────────────────────────

const VS_TEX = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec2 uRes;
varying vec2 vUV;
void main() {
  vec2 ndc = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aUV;
}`;

const FS_TEX = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uSampler;
uniform vec4 uTint; // rgba, multiplied against the sampled texel
void main() {
  vec4 t = texture2D(uSampler, vUV);
  gl_FragColor = t * uTint;
}`;

const VS_COL = `
attribute vec2 aPos;
attribute vec4 aCol;
uniform vec2 uRes;
varying vec4 vCol;
void main() {
  vec2 ndc = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vCol = aCol;
}`;

const FS_COL = `
precision mediump float;
varying vec4 vCol;
void main() { gl_FragColor = vCol; }`;

export class WebGLRenderer {
  /** Feature-detect: can we create a usable WebGL context on this canvas type? */
  static isSupported() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      return !!gl;
    } catch {
      return false;
    }
  }

  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this._isIOS = !!options.isIOS;
    this._isTizen = !!options.isTizen;

    const attrs = {
      alpha: true,
      premultipliedAlpha: false, // straight-alpha, matches Canvas2D source-over
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // keep last frame between composites (no inter-frame flash)
      powerPreference: 'high-performance',
    };
    const gl = canvas.getContext('webgl', attrs) ||
               canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('WebGL context creation failed');
    this.gl = gl;

    this.width = canvas.width;
    this.height = canvas.height;

    // Handle maps (connection.js reads .width/.height/.loaded off these).
    this.images = new Map();    // handle -> { glTex, width, height, loaded, flipV, _bytes }
    this.surfaces = new Map();  // handle -> { glTex, fbo, width, height, flipV, _bytes }

    // Current render target: 0 = default framebuffer (screen).
    this.targetSurface = 0;
    this._targetW = this.width;
    this._targetH = this.height;

    // Transform stack (affine [a,b,c,d,e,f]).
    this._matrix = [1, 0, 0, 1, 0, 0];
    this._matrixStack = [];

    this.videoBounds = null;
    this._firstFrameRendered = false;

    // Cache budget (pixels). Mirrors CanvasRenderer semantics.
    const cacheMB = Number.isFinite(options.maxCacheMB) ? options.maxCacheMB : 128;
    this._maxCachePixels = Math.max(8, cacheMB) * 1024 * 1024 / 4;
    this._currentCachePixels = 0;

    // Text / vector-primitive raster-texture cache (content-keyed, LRU).
    this._rasterCache = new Map(); // key -> { glTex, w, h, bytes }
    this._rasterCacheBytes = 0;
    this._rasterCacheBudget = (this._isIOS ? 24 : 48) * 1024 * 1024; // bytes
    this._rasterCanvas = document.createElement('canvas');
    this._rasterCtx = this._rasterCanvas.getContext('2d', { willReadFrequently: false });

    // Per-frame perf counters.
    this._frameDrawImage = 0;
    this._frameScaledDraw = 0;
    this._texBlitMs = 0;
    this._texBlitCount = 0;
    this._pendingImageLoads = 0;
    this.onImagesReady = null;

    this._offlineCache = new Map();

    this._initGL();

    // Restore-after-context-loss support: callers may listen and rebuild.
    this._contextLost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      console.error('[WebGL] context lost');
    }, false);

    console.log(`[WebGL] Renderer initialized ${this.width}x${this.height}`);
  }

  // ── GL setup ────────────────────────────────────────────────

  _initGL() {
    const gl = this.gl;
    this._texProg = this._buildProgram(VS_TEX, FS_TEX);
    this._colProg = this._buildProgram(VS_COL, FS_COL);

    this._texLoc = {
      aPos: gl.getAttribLocation(this._texProg, 'aPos'),
      aUV: gl.getAttribLocation(this._texProg, 'aUV'),
      uRes: gl.getUniformLocation(this._texProg, 'uRes'),
      uSampler: gl.getUniformLocation(this._texProg, 'uSampler'),
      uTint: gl.getUniformLocation(this._texProg, 'uTint'),
    };
    this._colLoc = {
      aPos: gl.getAttribLocation(this._colProg, 'aPos'),
      aCol: gl.getAttribLocation(this._colProg, 'aCol'),
      uRes: gl.getUniformLocation(this._colProg, 'uRes'),
    };

    // Dynamic vertex buffers.
    this._texBuf = gl.createBuffer();   // interleaved [x,y,u,v] * 6
    this._colBuf = gl.createBuffer();   // interleaved [x,y,r,g,b,a] * 6
    this._texArr = new Float32Array(6 * 4);
    this._colArr = new Float32Array(6 * 6);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.clearColor(0, 0, 0, 0);
    gl.viewport(0, 0, this.width, this.height);

    // Offscreen "scene" framebuffer. All frame draws target this FBO, then we
    // blit it to the visible canvas atomically in flipBuffer. This replicates
    // the Canvas2D back-buffer: because GFX processing yields mid-frame, the
    // compositor must never see a partially-drawn default framebuffer (that
    // caused the flash-to-empty). The visible canvas only updates on flip.
    this._createSceneFBO(this.width, this.height);
  }

  _createSceneFBO(w, h) {
    const gl = this.gl;
    if (this._sceneTex) gl.deleteTexture(this._sceneTex);
    if (this._sceneFBO) gl.deleteFramebuffer(this._sceneFBO);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._sceneTex = tex;
    this._sceneFBO = fbo;
  }

  _buildProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this._compile(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('[WebGL] program link failed: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('[WebGL] shader compile failed: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  init() {
    this._releaseAllTextures();
    this.images.clear();
    this.surfaces.clear();
    this._currentCachePixels = 0;
    this._bindTarget(0);
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.clearColor(0, 0, 0, 0);
    console.log(`[WebGL] init ${this.width}x${this.height}`);
  }

  deinit() {
    this._releaseAllTextures();
    this.images.clear();
    this.surfaces.clear();
    this._currentCachePixels = 0;
  }

  _releaseAllTextures() {
    const gl = this.gl;
    for (const img of this.images.values()) if (img.glTex) gl.deleteTexture(img.glTex);
    for (const s of this.surfaces.values()) {
      if (s.glTex) gl.deleteTexture(s.glTex);
      if (s.fbo) gl.deleteFramebuffer(s.fbo);
    }
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this._createSceneFBO(width, height);
    if (this.targetSurface === 0) {
      this._targetW = width;
      this._targetH = height;
      this.gl.viewport(0, 0, width, height);
    }
    console.log(`[WebGL] resized to ${width}x${height}`);
  }

  startFrame() {
    this.targetSurface = 0;
    this._matrix = [1, 0, 0, 1, 0, 0];
    this._matrixStack.length = 0;
    this._frameDrawImage = 0;
    this._frameScaledDraw = 0;
    this._texBlitMs = 0;
    this._texBlitCount = 0;
    this._bindTarget(0);
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT); // transparent -> video shows through unpainted regions
  }

  flipBuffer() {
    const gl = this.gl;
    // Present the completed scene FBO to the visible default framebuffer in a
    // single atomic blit. The screen therefore only ever shows a fully-drawn
    // frame, never a mid-frame partial (which caused the flashing).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._targetW = this.width;
    this._targetH = this.height;
    gl.viewport(0, 0, this.width, this.height);
    this._matrix = [1, 0, 0, 1, 0, 0];
    // Opaque copy (ONE,ZERO) preserves the scene's alpha exactly so the
    // <video> still shows through transparent regions. flipV=true because the
    // scene FBO texture has GL's bottom-left origin.
    this._drawTexQuad(this._sceneTex, 0, 0, this.width, this.height,
      0, 0, this.width, this.height, this.width, this.height, [1, 1, 1, 1], true, true);
    gl.flush();
    // Re-bind the scene FBO so the next frame's early draws (before startFrame)
    // don't accidentally hit the default buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO);
    this._firstFrameRendered = true;
  }

  isFirstFrameRendered() {
    return this._firstFrameRendered;
  }

  // ── Target / projection ─────────────────────────────────────

  _bindTarget(handle) {
    const gl = this.gl;
    if (handle === 0) {
      // Target 0 = the offscreen scene FBO (not the visible default buffer).
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO);
      this._targetW = this.width;
      this._targetH = this.height;
      gl.viewport(0, 0, this.width, this.height);
    } else {
      const s = this.surfaces.get(handle);
      if (!s) { gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO); return; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      this._targetW = s.width;
      this._targetH = s.height;
      gl.viewport(0, 0, s.width, s.height);
    }
  }

  setTargetSurface(handle) {
    this.targetSurface = handle;
    this._bindTarget(handle);
  }

  // ── Transform ───────────────────────────────────────────────

  pushTransform(matrix) {
    this._matrixStack.push(this._matrix.slice());
    // SageTV 4x4 row-major: a=m0 b=m4 c=m1 d=m5 e=m3 f=m7
    const a = matrix[0], b = matrix[4], c = matrix[1], d = matrix[5], e = matrix[3], f = matrix[7];
    const m = this._matrix;
    // compose current * incoming (affine)
    this._matrix = [
      m[0] * a + m[2] * b,
      m[1] * a + m[3] * b,
      m[0] * c + m[2] * d,
      m[1] * c + m[3] * d,
      m[0] * e + m[2] * f + m[4],
      m[1] * e + m[3] * f + m[5],
    ];
  }

  popTransform() {
    if (this._matrixStack.length) this._matrix = this._matrixStack.pop();
  }

  _tx(x, y) {
    const m = this._matrix;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // ── Color helpers ───────────────────────────────────────────

  _rgba(argb) {
    return [
      ((argb >>> 16) & 0xFF) / 255,
      ((argb >>> 8) & 0xFF) / 255,
      (argb & 0xFF) / 255,
      ((argb >>> 24) & 0xFF) / 255,
    ];
  }

  // ── Core quad draws ─────────────────────────────────────────

  /** Draw a textured quad. dst/src in pixels; src normalized against texW/H. */
  _drawTexQuad(glTex, dx, dy, dw, dh, sx, sy, sw, sh, texW, texH, tint, opaque, flipV) {
    const gl = this.gl;
    // Corners (with transform), CCW: TL, TR, BR, BL.
    const [x0, y0] = this._tx(dx, dy);
    const [x1, y1] = this._tx(dx + dw, dy);
    const [x2, y2] = this._tx(dx + dw, dy + dh);
    const [x3, y3] = this._tx(dx, dy + dh);
    let u0 = sx / texW, u1 = (sx + sw) / texW;
    let v0 = sy / texH, v1 = (sy + sh) / texH;
    if (flipV) { const t = v0; v0 = 1 - v1; v1 = 1 - t; }

    const a = this._texArr;
    // tri 1: TL, TR, BR
    a[0] = x0; a[1] = y0; a[2] = u0; a[3] = v0;
    a[4] = x1; a[5] = y1; a[6] = u1; a[7] = v0;
    a[8] = x2; a[9] = y2; a[10] = u1; a[11] = v1;
    // tri 2: TL, BR, BL
    a[12] = x0; a[13] = y0; a[14] = u0; a[15] = v0;
    a[16] = x2; a[17] = y2; a[18] = u1; a[19] = v1;
    a[20] = x3; a[21] = y3; a[22] = u0; a[23] = v1;

    gl.useProgram(this._texProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this._texLoc.aPos);
    gl.vertexAttribPointer(this._texLoc.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this._texLoc.aUV);
    gl.vertexAttribPointer(this._texLoc.aUV, 2, gl.FLOAT, false, 16, 8);
    gl.uniform2f(this._texLoc.uRes, this._targetW, this._targetH);
    gl.uniform4f(this._texLoc.uTint, tint[0], tint[1], tint[2], tint[3]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.uniform1i(this._texLoc.uSampler, 0);

    if (opaque) gl.blendFunc(gl.ONE, gl.ZERO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (opaque) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Draw a solid/gradient quad. Colors are [r,g,b,a] 0-1 for TL,TR,BR,BL. */
  _drawColorQuad(dx, dy, dw, dh, cTL, cTR, cBR, cBL) {
    const gl = this.gl;
    const [x0, y0] = this._tx(dx, dy);
    const [x1, y1] = this._tx(dx + dw, dy);
    const [x2, y2] = this._tx(dx + dw, dy + dh);
    const [x3, y3] = this._tx(dx, dy + dh);
    const a = this._colArr;
    const put = (o, x, y, c) => {
      a[o] = x; a[o + 1] = y; a[o + 2] = c[0]; a[o + 3] = c[1]; a[o + 4] = c[2]; a[o + 5] = c[3];
    };
    put(0, x0, y0, cTL);
    put(6, x1, y1, cTR);
    put(12, x2, y2, cBR);
    put(18, x0, y0, cTL);
    put(24, x2, y2, cBR);
    put(30, x3, y3, cBL);

    gl.useProgram(this._colProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this._colLoc.aPos);
    gl.vertexAttribPointer(this._colLoc.aPos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(this._colLoc.aCol);
    gl.vertexAttribPointer(this._colLoc.aCol, 4, gl.FLOAT, false, 24, 8);
    gl.uniform2f(this._colLoc.uRes, this._targetW, this._targetH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ── Primitives ──────────────────────────────────────────────

  fillRect(x, y, width, height, argbTL, argbTR, argbBR, argbBL) {
    this._drawColorQuad(
      x, y, width, height,
      this._rgba(argbTL), this._rgba(argbTR), this._rgba(argbBR), this._rgba(argbBL)
    );
  }

  clearRect(x, y, width, height, argbTL) {
    const gl = this.gl;
    // Clear the sub-rect to transparent using scissor (GL y is bottom-left).
    const gy = this._targetH - y - height;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(x), Math.round(gy), Math.round(width), Math.round(height));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    if (argbTL !== 0 && argbTL !== undefined) {
      const c = this._rgba(argbTL);
      this._drawColorQuad(x, y, width, height, c, c, c, c);
    }
  }

  // Stroked / curved primitives are rasterized to a cached texture. They are
  // rare and reused frame-to-frame (focus box, dividers), so this amortizes.

  drawRect(x, y, width, height, thickness, argbTL) {
    if (width <= 0 || height <= 0) return;
    const key = `R|${width}x${height}|${thickness}|${argbTL}`;
    const tex = this._rasterPrimitive(key, width, height, (ctx) => {
      ctx.lineWidth = thickness;
      ctx.strokeStyle = this._css(argbTL);
      ctx.strokeRect(thickness / 2, thickness / 2, width - thickness, height - thickness);
    });
    if (tex) this._drawTexQuad(tex.glTex, x, y, width, height, 0, 0, width, height, width, height, [1, 1, 1, 1], false, false);
  }

  drawOval(x, y, width, height, thickness, argbTL) {
    if (width <= 0 || height <= 0) return;
    const key = `O|${width}x${height}|${thickness}|${argbTL}`;
    const tex = this._rasterPrimitive(key, width, height, (ctx) => {
      ctx.lineWidth = thickness;
      ctx.strokeStyle = this._css(argbTL);
      ctx.beginPath();
      ctx.ellipse(width / 2, height / 2, (width - thickness) / 2, (height - thickness) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
    if (tex) this._drawTexQuad(tex.glTex, x, y, width, height, 0, 0, width, height, width, height, [1, 1, 1, 1], false, false);
  }

  fillOval(x, y, width, height, argbTL) {
    if (width <= 0 || height <= 0) return;
    const key = `FO|${width}x${height}|${argbTL}`;
    const tex = this._rasterPrimitive(key, width, height, (ctx) => {
      ctx.fillStyle = this._css(argbTL);
      ctx.beginPath();
      ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    if (tex) this._drawTexQuad(tex.glTex, x, y, width, height, 0, 0, width, height, width, height, [1, 1, 1, 1], false, false);
  }

  drawRoundRect(x, y, width, height, thickness, arcRadius, argbTL) {
    if (width <= 0 || height <= 0) return;
    const key = `RR|${width}x${height}|${thickness}|${arcRadius}|${argbTL}`;
    const tex = this._rasterPrimitive(key, width, height, (ctx) => {
      ctx.lineWidth = thickness;
      ctx.strokeStyle = this._css(argbTL);
      this._roundRectPath(ctx, thickness / 2, thickness / 2, width - thickness, height - thickness, arcRadius / 2);
      ctx.stroke();
    });
    if (tex) this._drawTexQuad(tex.glTex, x, y, width, height, 0, 0, width, height, width, height, [1, 1, 1, 1], false, false);
  }

  fillRoundRect(x, y, width, height, arcRadius, argbTL) {
    if (width <= 0 || height <= 0) return;
    const key = `FRR|${width}x${height}|${arcRadius}|${argbTL}`;
    const tex = this._rasterPrimitive(key, width, height, (ctx) => {
      ctx.fillStyle = this._css(argbTL);
      this._roundRectPath(ctx, 0, 0, width, height, arcRadius / 2);
      ctx.fill();
    });
    if (tex) this._drawTexQuad(tex.glTex, x, y, width, height, 0, 0, width, height, width, height, [1, 1, 1, 1], false, false);
  }

  drawLine(x1, y1, x2, y2, argb1) {
    const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
    const w = Math.max(1, Math.abs(x2 - x1) + 2);
    const h = Math.max(1, Math.abs(y2 - y1) + 2);
    const key = `L|${w}x${h}|${x1 - minX},${y1 - minY},${x2 - minX},${y2 - minY}|${argb1}`;
    const tex = this._rasterPrimitive(key, w, h, (ctx) => {
      ctx.strokeStyle = this._css(argb1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1 - minX + 0.5, y1 - minY + 0.5);
      ctx.lineTo(x2 - minX + 0.5, y2 - minY + 0.5);
      ctx.stroke();
    });
    if (tex) this._drawTexQuad(tex.glTex, minX, minY, w, h, 0, 0, w, h, w, h, [1, 1, 1, 1], false, false);
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

  _css(argb) {
    const r = (argb >>> 16) & 0xFF, g = (argb >>> 8) & 0xFF, b = argb & 0xFF, a = (argb >>> 24) & 0xFF;
    return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }

  // ── Text ────────────────────────────────────────────────────

  drawText(x, y, text, fontInfo, argb, clipX, clipY, clipW, clipH) {
    if (perf.enabled) perf.bumpText();
    if (!text) return;
    const size = fontInfo ? fontInfo.size : 16;
    const style = fontInfo ? fontInfo.style : 0;
    const name = fontInfo ? fontInfo.name : 'sans-serif';
    const bold = (style & 1) ? 'bold ' : '';
    const italic = (style & 2) ? 'italic ' : '';
    const fontStr = `${italic}${bold}${size}px "${name}", sans-serif`;
    const key = `T|${fontStr}|${argb}|${text}`;

    let entry = this._rasterCacheGet(key);
    if (!entry) {
      const ctx = this._rasterCtx;
      ctx.font = fontStr;
      const metrics = ctx.measureText(text);
      const ascent = Math.ceil(metrics.actualBoundingBoxAscent || size * 0.8);
      const descent = Math.ceil(metrics.actualBoundingBoxDescent || size * 0.25);
      const w = Math.max(1, Math.ceil(metrics.width) + 2);
      const h = Math.max(1, ascent + descent + 2);
      entry = this._rasterUpload(key, w, h, (c) => {
        c.font = fontStr;
        c.textBaseline = 'alphabetic';
        c.fillStyle = this._css(argb);
        c.fillText(text, 1, ascent + 1);
      });
      if (entry) entry._ascent = ascent + 1;
    }
    if (!entry) return;
    // SageTV clips text to its cell to prevent overflow. Honor it with the
    // GL scissor test (axis-aligned, matching the clip rect semantics).
    const clipped = clipW > 0 && clipH > 0;
    if (clipped) this._setClip(clipX, clipY, clipW, clipH);
    this._drawTexQuad(entry.glTex, x, y - entry._ascent, entry.w, entry.h,
      0, 0, entry.w, entry.h, entry.w, entry.h, [1, 1, 1, 1], false, false);
    if (clipped) this._clearClip();
  }

  /** Enable the GL scissor test for an axis-aligned clip rect (top-left coords). */
  _setClip(cx, cy, cw, ch) {
    const gl = this.gl;
    const gy = this._targetH - cy - ch; // GL scissor is bottom-left origin
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(cx), Math.round(gy), Math.max(0, Math.round(cw)), Math.max(0, Math.round(ch)));
  }

  _clearClip() {
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  // ── Raster-primitive cache ──────────────────────────────────

  _rasterPrimitive(key, w, h, drawFn) {
    const hit = this._rasterCacheGet(key);
    if (hit) return hit;
    return this._rasterUpload(key, Math.ceil(w), Math.ceil(h), drawFn);
  }

  _rasterCacheGet(key) {
    const e = this._rasterCache.get(key);
    if (e) { // refresh LRU order
      this._rasterCache.delete(key);
      this._rasterCache.set(key, e);
    }
    return e;
  }

  _rasterUpload(key, w, h, drawFn) {
    const gl = this.gl;
    const rc = this._rasterCanvas;
    if (rc.width < w) rc.width = w;
    if (rc.height < h) rc.height = h;
    const ctx = this._rasterCtx;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    try { drawFn(ctx); } catch { /* ignore */ }
    ctx.restore();

    const glTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    let imgData;
    try { imgData = ctx.getImageData(0, 0, w, h); }
    catch { return null; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgData.data);

    const bytes = w * h * 4;
    const entry = { glTex, w, h, bytes };
    this._rasterCache.set(key, entry);
    this._rasterCacheBytes += bytes;
    this._evictRasterIfNeeded();
    return entry;
  }

  _evictRasterIfNeeded() {
    const gl = this.gl;
    while (this._rasterCacheBytes > this._rasterCacheBudget && this._rasterCache.size > 1) {
      const oldestKey = this._rasterCache.keys().next().value;
      const e = this._rasterCache.get(oldestKey);
      this._rasterCache.delete(oldestKey);
      if (e) { this._rasterCacheBytes -= e.bytes; if (e.glTex) gl.deleteTexture(e.glTex); }
    }
  }

  // ── Images ──────────────────────────────────────────────────

  loadImage(handle, width, height) {
    const existing = this.images.get(handle);
    if (existing?.glTex) this.gl.deleteTexture(existing.glTex);
    this.images.set(handle, {
      glTex: null, width, height, loaded: false, flipV: false,
      _rawBuffer: new Uint8Array(width * height * 4),
      _lines: 0, _finalized: false, _bytes: width * height * 4,
    });
    this._currentCachePixels += width * height;
  }

  loadImageLine(handle, line, len, data) {
    const img = this.images.get(handle);
    if (!img || !img._rawBuffer) return;
    img._rawBuffer.set(data.subarray(0, img.width * 4), line * img.width * 4);
    img._lines++;
    img.loaded = true;
    if (img._lines >= img.height) this._finalizeImage(handle);
  }

  /** Convert accumulated ARGB -> RGBA and upload as a GL texture. */
  _finalizeImage(handle) {
    const img = this.images.get(handle);
    if (!img || img._finalized || !img._rawBuffer) return;
    const buf = img._rawBuffer;
    const n = img.width * img.height;
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, n);
    // LE: source uint32 = 0xBGRA (bytes A,R,G,B). Dest RGBA bytes = 0xABGR.
    for (let i = 0; i < n; i++) {
      const px = u32[i];
      if (px === 0) continue;
      const a = px & 0xFF;
      if (a === 255) {
        u32[i] = ((px >>> 8) & 0x00FFFFFF) | 0xFF000000;
      } else if (a === 0) {
        u32[i] = 0;
      } else {
        const invA = 255 / a;
        const r = Math.min(255, (((px >>> 8) & 0xFF) * invA) | 0);
        const g = Math.min(255, (((px >>> 16) & 0xFF) * invA) | 0);
        const b = Math.min(255, ((px >>> 24) * invA) | 0);
        u32[i] = r | (g << 8) | (b << 16) | (a << 24);
      }
    }
    this._uploadImageTexture(img, buf);
    img._finalized = true;
    img._rawBuffer = null;
  }

  _uploadImageTexture(img, rgbaBytes) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, rgbaBytes);
    if (img.glTex) gl.deleteTexture(img.glTex);
    img.glTex = tex;
    img.flipV = false;
    img.loaded = true;
  }

  loadCompressedImage(handle, data) {
    const gl = this.gl;
    const blob = new Blob([data]);
    if (typeof createImageBitmap === 'function') {
      this._pendingImageLoads++;
      const t0 = perf.enabled ? perf.now() : 0;
      return createImageBitmap(blob).then((bitmap) => {
        if (perf.enabled) perf.addImageDecodeMs(perf.now() - t0);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        const prev = this.images.get(handle);
        if (prev?.glTex) gl.deleteTexture(prev.glTex);
        this.images.set(handle, {
          glTex: tex, width: bitmap.width, height: bitmap.height,
          loaded: true, flipV: false, _finalized: true, _bytes: bitmap.width * bitmap.height * 4,
        });
        this._currentCachePixels += bitmap.width * bitmap.height;
        bitmap.close?.();
      }).catch((err) => {
        console.warn(`[WebGL] compressed decode failed h=${handle}:`, err?.message || err);
      }).finally(() => {
        this._pendingImageLoads--;
        if (this._pendingImageLoads === 0 && this.onImagesReady) this.onImagesReady();
      });
    }
    return Promise.resolve();
  }

  unloadImage(handle) {
    const img = this.images.get(handle);
    if (img) {
      if (img.glTex) this.gl.deleteTexture(img.glTex);
      this._currentCachePixels -= img.width * img.height;
      this.images.delete(handle);
    }
    const s = this.surfaces.get(handle);
    if (s) {
      if (s.glTex) this.gl.deleteTexture(s.glTex);
      if (s.fbo) this.gl.deleteFramebuffer(s.fbo);
      this._currentCachePixels -= s.width * s.height;
      this.surfaces.delete(handle);
    }
    if (this._currentCachePixels < 0) this._currentCachePixels = 0;
  }

  _ensureImageUploaded(img) {
    if (img && !img.glTex && img._rawBuffer && !img._finalized) {
      // drawTexture arrived before all lines; finalize what we have.
      this._finalizeImage(img._handleForFinalize);
    }
  }

  drawTexture(x, y, width, height, handle, srcx, srcy, srcw, srch, blend) {
    const img = this.images.get(handle) || this.surfaces.get(handle);
    if (!img || !img.glTex) return;
    if (srcw === 0 || srch === 0 || width === 0 || height === 0) return;

    const opaque = height < 0;
    const absW = Math.abs(width);
    const absH = Math.abs(height);
    this._frameDrawImage++;
    if (srcw !== absW || srch !== absH) this._frameScaledDraw++;

    const tint = [
      ((blend >>> 16) & 0xFF) / 255,
      ((blend >>> 8) & 0xFF) / 255,
      (blend & 0xFF) / 255,
      opaque ? 1.0 : ((blend >>> 24) & 0xFF) / 255,
    ];

    const t0 = perf.enabled ? perf.now() : 0;
    this._drawTexQuad(img.glTex, x, y, absW, absH, srcx, srcy, srcw, srch,
      img.width, img.height, tint, opaque, img.flipV);
    if (perf.enabled) { this._texBlitMs += perf.now() - t0; this._texBlitCount++; }
  }

  // ── Surfaces (render-to-texture) ────────────────────────────

  createSurface(handle, width, height) {
    const gl = this.gl;
    const prev = this.surfaces.get(handle);
    if (prev) { if (prev.glTex) gl.deleteTexture(prev.glTex); if (prev.fbo) gl.deleteFramebuffer(prev.fbo); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Content rendered into an FBO samples with V flipped (GL bottom-left origin).
    this.surfaces.set(handle, { glTex: tex, fbo, width, height, flipV: true, _bytes: width * height * 4 });
    this._currentCachePixels += width * height;
  }

  xfmImage(srcHandle, destHandle, destWidth, destHeight, maskCornerArc) {
    const gl = this.gl;
    const src = this.images.get(srcHandle) || this.surfaces.get(srcHandle);
    if (!src || !src.glTex) return;

    // Create dest texture + fbo.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, destWidth, destHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Render src scaled into dest fbo. Save/restore target state.
    const savedTarget = this.targetSurface, savedW = this._targetW, savedH = this._targetH;
    const savedMatrix = this._matrix; this._matrix = [1, 0, 0, 1, 0, 0];
    this._targetW = destWidth; this._targetH = destHeight;
    gl.viewport(0, 0, destWidth, destHeight);
    this._drawTexQuad(src.glTex, 0, 0, destWidth, destHeight, 0, 0, src.width, src.height,
      src.width, src.height, [1, 1, 1, 1], true, src.flipV);

    // Optional rounded-corner mask: multiply dest alpha by a rounded mask.
    if (maskCornerArc > 0) {
      const maskKey = `MASK|${destWidth}x${destHeight}|${maskCornerArc}`;
      const mask = this._rasterPrimitive(maskKey, destWidth, destHeight, (ctx) => {
        ctx.fillStyle = '#fff';
        this._roundRectPath(ctx, 0, 0, destWidth, destHeight, maskCornerArc);
        ctx.fill();
      });
      if (mask) {
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA); // dst *= mask.a
        this._drawTexQuad(mask.glTex, 0, 0, destWidth, destHeight, 0, 0, destWidth, destHeight,
          destWidth, destHeight, [1, 1, 1, 1], false, false);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
    }

    // Restore.
    this._matrix = savedMatrix;
    this.targetSurface = savedTarget; this._targetW = savedW; this._targetH = savedH;
    this._bindTarget(savedTarget);

    const prev = this.images.get(destHandle);
    if (prev?.glTex) gl.deleteTexture(prev.glTex);
    this.images.set(destHandle, {
      glTex: tex, width: destWidth, height: destHeight, loaded: true,
      flipV: true, _finalized: true, _fbo: fbo, _bytes: destWidth * destHeight * 4,
    });
    this._currentCachePixels += destWidth * destHeight;
  }

  // ── Fonts / video / caches ──────────────────────────────────

  loadFontStream(name, data) {
    try {
      const url = URL.createObjectURL(new Blob([data]));
      const font = new FontFace(name, `url(${url})`);
      font.load().then((f) => { document.fonts.add(f); console.log(`[WebGL] font loaded: ${name}`); })
        .catch((err) => console.warn(`[WebGL] font load failed: ${name}`, err));
    } catch (e) {
      console.warn(`[WebGL] font stream error: ${name}`, e);
    }
  }

  setVideoBounds(srcRect, destRect) {
    this.videoBounds = { src: srcRect, dest: destRect };
    this.canvas.dispatchEvent(new CustomEvent('videobounds', { detail: { src: srcRect, dest: destRect } }));
  }

  getCachedImage(resourceId) { return this._offlineCache.get(resourceId) || null; }
  putCachedImage(handle, cachedData, width, height) { /* offline-cache optimization: no-op on GL path */ }
  registerTexture() { /* not used on GL path */ }

  hasImage(handle) { return this.images.has(handle); }

  canCacheImage(width, height) {
    return (this._currentCachePixels + width * height) <= this._maxCachePixels * 1.5;
  }

  getCacheStats() {
    let imagePixels = 0;
    for (const img of this.images.values()) imagePixels += img.width * img.height;
    let surfacePixels = 0;
    for (const s of this.surfaces.values()) surfacePixels += s.width * s.height;
    const usedPixels = imagePixels + surfacePixels;
    return {
      imageCount: this.images.size,
      surfaceCount: this.surfaces.size,
      imagePixels, surfacePixels, usedPixels,
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
      // Frame cache is unnecessary on the GL path (blits are cheap).
      frameCacheEnabled: false,
      frameCacheActive: false,
      frameCacheHits: 0,
      frameCacheMisses: 0,
      frameCacheSkipped: 0,
      // Isolated blit timing (drawArrays of textured quads).
      texBlitMs: this._texBlitMs || 0,
      texBlitCount: this._texBlitCount || 0,
      // Raster texture cache (text + primitives).
      rasterCacheEntries: this._rasterCache.size,
      rasterCacheBytes: this._rasterCacheBytes,
      renderer: 'webgl',
    };
  }
}
