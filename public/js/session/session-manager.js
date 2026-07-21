/**
 * SageTV MiniClient Session Manager
 *
 * Manages the lifecycle of a SageTV session:
 * - Server discovery/selection
 * - Connection establishment
 * - Module wiring (renderer, input, media, settings)
 * - Reconnection
 * - Graceful shutdown
 *
 * This is the main orchestrator that ties all modules together.
 */

import { MiniClientConnection } from '../protocol/connection.js';
import { CanvasRenderer } from '../ui/renderer.js';
import { WebGLRenderer } from '../ui/webgl-renderer.js';
import { MediaPlayer } from '../media/player.js';
import { DownloadManager } from './download-manager.js';
import { InputManager } from '../input/input-manager.js';
import { SettingsManager } from '../settings/settings-manager.js';
import { PlatformDetector } from '../platform/platform-detector.js';

export class SessionManager extends EventTarget {
  constructor() {
    super();
    this.settings = new SettingsManager();
    this.connection = null;
    this.renderer = null;
    this.mediaPlayer = null;
    this.downloadManager = new DownloadManager();
    this.inputManager = null;
    this.platformDetector = new PlatformDetector();
    this.platformCapabilities = null;

    // Session state
    this.connected = false;
    this.sessionId = null;

    // DOM elements (set during init)
    this.canvas = null;
    this.videoElement = null;
    this.container = null;
  }

  /**
   * Initialize the session manager and all sub-modules.
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement} videoElement
   * @param {HTMLElement} container
   */
  async init(canvas, videoElement, container) {
    this.canvas = canvas;
    this.videoElement = videoElement;
    this.container = container;

    // Initialize settings (opens IndexedDB)
    await this.settings.init();

    // Collect runtime capability hints once per app lifecycle.
    this.platformCapabilities = await this.platformDetector.init();
    this.dispatchEvent(new CustomEvent('platformcaps', { detail: this.platformCapabilities }));

    // Adaptive render resolution: snap the panel's device-pixel size to a
    // standard 16:9 tier, auto-upgrading a stored historical default. See
    // _resolveRenderResolution / _detectAdaptiveResolution.
    const { width, height } = this._resolveRenderResolution();

    // Set canvas size
    canvas.width = width;
    canvas.height = height;

    const configuredImageCacheMB = this.settings.getInt('image_cache_size_mb', 96);
    // Tizen TVs have more headroom than iOS but still benefit from a cap to
    // avoid GC pauses on rich menus. 96 MB is enough for a full recordings
    // grid without evicting on every scroll (32 MB was too small — every
    // scroll dropped posters and forced a fresh LOADCOMPRESSED round-trip,
    // which is what made up/down feel like 7-10 s per row).
    const rendererCacheMB = this.platformDetector.isIOS()
      ? Math.min(configuredImageCacheMB, 32)
      : this.platformDetector.isTizen()
        ? Math.min(configuredImageCacheMB, 96)
        : configuredImageCacheMB;

    // Create renderer. Prefer WebGL (drop-in, ~200x faster blits on Tizen/iPad
    // Canvas2D); fall back to Canvas2D if WebGL is unavailable, the context
    // can't be created, or the user forces it via ?renderer=canvas2d /
    // settings 'renderer' = 'canvas2d'.
    const rendererOpts = {
      isIOS: this.platformDetector.isIOS(),
      isTizen: this.platformDetector.isTizen(),
      maxCacheMB: rendererCacheMB,
    };
    let rendererPref = 'auto';
    try {
      const urlPref = new URLSearchParams(window.location?.search || '').get('renderer');
      rendererPref = urlPref || this.settings.get('renderer', 'auto');
    } catch { /* ignore */ }

    // Tear down any prior renderer (e.g. reconnect) so its present loop / GL
    // resources don't leak or fight the new one for the canvas.
    if (this.renderer?.destroy) { try { this.renderer.destroy(); } catch { /* ignore */ } }
    this.renderer = null;
    if (rendererPref !== 'canvas2d' && rendererPref !== 'canvas') {
      try {
        if (WebGLRenderer.isSupported()) {
          this.renderer = new WebGLRenderer(canvas, rendererOpts);
          console.log('[Session] Using WebGL renderer');
        } else if (rendererPref === 'webgl') {
          console.warn('[Session] renderer=webgl forced but WebGL unsupported; using Canvas2D');
        }
      } catch (e) {
        console.warn('[Session] WebGL renderer init failed, falling back to Canvas2D:', e?.message || e);
        if (this.renderer?.destroy) { try { this.renderer.destroy(); } catch { /* ignore */ } }
        this.renderer = null;
      }
    }
    if (!this.renderer) {
      this.renderer = new CanvasRenderer(canvas, rendererOpts);
      console.log('[Session] Using Canvas2D renderer');
    }

    // Create media player. Samsung Tizen TVs use the native AVPlay player
    // (hardware demux+decode of MPEG2-TS/PS, MPEG-2/HEVC/AC-3/AC-4 that the
    // WebView <video> element cannot handle); all other clients use the
    // <video>/MSE MediaPlayer.
    const useAvplay = this.platformDetector.isTizen()
      && !!(window.webapis && window.webapis.avplay);
    if (useAvplay) {
      // Dynamic import: the AVPlay module is fetched ONLY on Tizen, so browser /
      // iPad clients never download it — keeps the web PWA footprint minimal.
      const { AVPlayPlayer } = await import('../media/avplay-player.js');
      this.mediaPlayer = new AVPlayPlayer(videoElement, container, {
        platformDetector: this.platformDetector,
      });
      console.log('[Session] Using AVPlay player (Tizen native)');
    } else {
      this.mediaPlayer = new MediaPlayer(videoElement, container, {
        platformDetector: this.platformDetector,
      });
    }

    // Forward codec errors to session listeners for UI display
    this.mediaPlayer.addEventListener('codecerror', (e) => {
      console.error('[Session] Codec error:', e.detail.message);
      this.dispatchEvent(new CustomEvent('codecerror', { detail: e.detail }));
    });

    this.mediaPlayer.addEventListener('capabilityupdate', (e) => {
      const detail = e.detail || {};
      this.dispatchEvent(new CustomEvent('capabilityupdate', { detail }));
      if (this.connection?.reportCapabilityUpdate) {
        this.connection.reportCapabilityUpdate(detail).catch((err) => {
          console.warn('[Session] reportCapabilityUpdate failed:', err?.message || err);
        });
      }
    });

    this.mediaPlayer.addEventListener('playbackfailure', (e) => {
      const detail = e.detail || {};
      this.dispatchEvent(new CustomEvent('playbackfailure', { detail }));
      if (this.connection?.reportPlaybackFailure) {
        this.connection.reportPlaybackFailure(detail).catch((err) => {
          console.warn('[Session] reportPlaybackFailure failed:', err?.message || err);
        });
      }
    });

    console.log('[Session] Initialized');
  }

  /**
   * Connect to a SageTV server.
   * @param {string} serverHost - Server IP/hostname
   * @param {number} [serverPort=31099] - Server port
   * @param {string} [bridgeUrl] - WebSocket bridge URL (auto-detected if not set)
   */
  async connect(serverHost, serverPort = 31099, bridgeUrl) {
    if (this.connected) {
      this.disconnect();
    }

    // If serverHost contains a port (e.g. "example-host:8099"), strip it
    if (serverHost && serverHost.includes(':')) {
      const parts = serverHost.split(':');
      serverHost = parts[0];
    }

    // Auto-detect bridge URL if not provided. The shipped Java bridge listens
    // on port 8099 (TLS, wss://) and 8100 (plain, ws://). Order the probe by
    // page origin so we don't create mixed-content violations in browsers:
    //   - Page over https: → try wss://:8099 first, ws://:8100 as fallback.
    //   - Page over http:  → try ws://:8100 first, wss://:8099 as fallback.
    //   - Other origins (Tizen wgt file://, packaged installs) → ws first,
    //     since cert-strict WebViews can't accept the self-signed TLS cert.
    if (!bridgeUrl) {
      const proto = location.protocol;
      const httpsFirst = proto === 'https:';
      const wsCandidate  = [`ws://${serverHost}:8100`,  `http://${serverHost}:8100/discover`];
      const wssCandidate = [`wss://${serverHost}:8099`, `https://${serverHost}:8099/discover`];
      const candidates = httpsFirst ? [wssCandidate, wsCandidate] : [wsCandidate, wssCandidate];
      bridgeUrl = candidates[0][0];
      const detected = await this._probeBridgeScheme(candidates);
      if (detected) bridgeUrl = detected;
    }

    // Publish the resolved http(s) bridge base to the media player so
    // /transcode fetches use an absolute URL. Required for clients where the
    // page origin isn't the bridge (Tizen wgt file://, iOS PWA installs).
    const bridgeHttpBase = bridgeUrl
      .replace(/^ws:/i, 'http:')
      .replace(/^wss:/i, 'https:');
    if (this.mediaPlayer && typeof this.mediaPlayer.setBridgeBase === 'function') {
      this.mediaPlayer.setBridgeBase(bridgeHttpBase);
    }

    const { width, height } = this._resolveRenderResolution();

    // Create connection
    this.connection = new MiniClientConnection({
      bridgeUrl,
      serverHost,
      serverPort,
      renderer: this.renderer,
      mediaPlayer: this.mediaPlayer,
      width,
      height,
      settings: this.settings,
      platformDetector: this.platformDetector,
    });

    // Wire up events
    this.connection.addEventListener('connected', () => {
      this.connected = true;
      this.dispatchEvent(new CustomEvent('connected'));
    });

    this.connection.addEventListener('disconnected', (e) => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('disconnected', { detail: e.detail }));
    });

    this.connection.addEventListener('reconnected', () => {
      this.connected = true;
      this.dispatchEvent(new CustomEvent('reconnected'));
    });

    this.connection.addEventListener('firstframe', () => {
      this.dispatchEvent(new CustomEvent('firstframe'));
    });

    this.connection.addEventListener('exit', () => {
      console.log('[Session] Server exit — returning to connect screen');
      this.disconnect();
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: 'exit' } }));
    });

    this.connection.addEventListener('reconnecting', (e) => {
      this.dispatchEvent(new CustomEvent('reconnecting', { detail: e.detail }));
    });

    this.connection.addEventListener('reconnectfailed', (e) => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('reconnectfailed', { detail: e.detail }));
    });

    // Create and start input manager
    this.inputManager = new InputManager(this.container, this.connection, {
      platformDetector: this.platformDetector,
    });
    this.inputManager.updateScale(
      this.canvas.clientWidth, this.canvas.clientHeight,
      width, height
    );
    this.inputManager.start();

    // Handle window resize
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);

    // Handle resolution change from server rendering detection
    this.connection.addEventListener('resolutionchange', () => {
      this._onResize();
    });

    this.connection.addEventListener('downloadrequest', (e) => {
      const detail = e.detail || {};

      // Bubble up for optional UI status handling.
      this.dispatchEvent(new CustomEvent('downloadrequest', { detail }));
    });

    // Handle video bounds from renderer
    this.canvas.addEventListener('videobounds', (e) => {
      this.mediaPlayer.setVideoRectangles(e.detail.src, e.detail.dest);
    });

    // Connect!
    try {
      this.dispatchEvent(new CustomEvent('connecting'));
      await this.connection.connect();

      // Save as recent server
      this.settings.addSavedServer(serverHost, serverPort, serverHost);
    } catch (err) {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('error', { detail: { error: err } }));
      throw err;
    }
  }

  /**
   * Get the NG playback context store from the active connection.
   * Returns null if not connected or connection has no store.
   * @returns {import('../media/ng-playback-context-manager.js').NgPlaybackContextManager|null}
   */
  get playbackContextManager() {
    return this.connection?.playbackContextManager || null;
  }

  /**
   * Disconnect from the current server.
   */
  disconnect() {
    if (this.inputManager) {
      this.inputManager.stop();
      this.inputManager = null;
    }

    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
    }

    if (this.mediaPlayer) {
      this.mediaPlayer.stop();
    }

    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }

    this.connected = false;
    console.log('[Session] Disconnected');
  }

  /**
   * Handle window resize.
   */
  _onResize() {
    if (!this.connection || !this.canvas) return;

    // Update canvas display size (CSS) to fill container while maintaining aspect ratio
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    const serverWidth = this.canvas.width;
    const serverHeight = this.canvas.height;

    // Guard against zero dimensions (canvas hidden or not yet sized)
    if (serverWidth === 0 || serverHeight === 0 || containerWidth === 0 || containerHeight === 0) return;

    const scale = Math.min(containerWidth / serverWidth, containerHeight / serverHeight);
    const displayWidth = Math.round(serverWidth * scale);
    const displayHeight = Math.round(serverHeight * scale);

    // Flex centering on .client-container (justify-content/align-items:center)
    // already places the canvas in the middle — do NOT also set margins here,
    // as flex counts margins against the centered outer box and would shift
    // the canvas off-center. Just set the size; the container centers it.
    this.canvas.style.width = `${displayWidth}px`;
    this.canvas.style.height = `${displayHeight}px`;
    this.canvas.style.marginLeft = '0';
    this.canvas.style.marginTop = '0';

    // Update input scaling
    if (this.inputManager) {
      this.inputManager.updateScale(displayWidth, displayHeight, serverWidth, serverHeight);
    }

    // Re-apply video positioning for new canvas size
    if (this.mediaPlayer && this.mediaPlayer._applyVideoRectangles) {
      this.mediaPlayer._applyVideoRectangles();
    }
  }

  /**
   * Get list of saved servers for the connection UI.
   */
  getSavedServers() {
    return this.settings.getSavedServers();
  }

  getPlatformCapabilities() {
    return this.platformCapabilities || this.platformDetector.getCapabilities();
  }

  /**
   * Send a SageCommand.
   */
  sendCommand(commandId) {
    if (this.connection) {
      this.connection.sendCommand(commandId);
    }
  }

  /**
   * Trigger a browser-native download from a server transfer response.
   * @param {object} sessionAck - Server transfer session data.
   */
  async downloadFromSessionAck(sessionAck) {
    return this.downloadManager.downloadFromSessionAck(sessionAck);
  }

  /**
   * Trigger a browser-native download from a manifest URL.
   * @param {string} manifestUrl
   * @param {string} [downloadUrl]
   * @param {string} [suggestedName]
   */
  async downloadFromManifest(manifestUrl, downloadUrl, suggestedName) {
    return this.downloadManager.downloadFromManifest(manifestUrl, downloadUrl, suggestedName);
  }

  /**
   * Resolve the effective render resolution: the stored setting, or the adaptive
   * default when unset, auto-upgrading a stored value that exactly matches a
   * historical AUTO-default (never an explicit user pick) to the detected tier.
   * Only ever UPGRADES (detected strictly higher), never silently downgrades.
   * Used by both init() (canvas) and connect() (connection) so they never drift.
   */
  _resolveRenderResolution() {
    const adaptiveRes = this._detectAdaptiveResolution();
    const configuredWidth = this.settings.getInt('resolution_width', adaptiveRes.width);
    const configuredHeight = this.settings.getInt('resolution_height', adaptiveRes.height);
    // Historical auto-defaults that were saved WITHOUT user intent. Tizen keeps
    // its original pair (1280x720 / 1920x1080 upscale-on-4K fix); browser/iOS
    // use the flat 1280x720 desktop default and the old 1024x576 iOS default,
    // so an explicit 1080p pick on a desktop/iPad is respected (not bumped).
    const isTizen = this.platformDetector.isTizen();
    const historicalDefaults = isTizen
      ? [[1280, 720], [1920, 1080]]
      : [[1280, 720], [1024, 576]];
    const isHistoricalDefault = historicalDefaults.some(
      ([w, h]) => w === configuredWidth && h === configuredHeight);
    const autoUpgrade = isHistoricalDefault
      && (adaptiveRes.width > configuredWidth || adaptiveRes.height > configuredHeight);
    const width = autoUpgrade ? adaptiveRes.width : configuredWidth;
    const height = autoUpgrade ? adaptiveRes.height : configuredHeight;
    if (autoUpgrade) {
      this.settings.set('resolution_width', String(width));
      this.settings.set('resolution_height', String(height));
      console.log(`[Session] Auto-upgrade render resolution: ${configuredWidth}x${configuredHeight} -> ${width}x${height}`);
    }
    console.log(`[Session] Client render resolution: ${width}x${height} (adaptive=${adaptiveRes.width}x${adaptiveRes.height}, stored=${configuredWidth}x${configuredHeight}, DPR=${window.devicePixelRatio || 1})`);
    return { width, height };
  }

  /**
   * Detect the optimal SERVER-SIDE render resolution for this device by snapping
   * the panel's device-pixel size (CSS px * devicePixelRatio) to a standard
   * 16:9 tier. The STV UI is rendered at this size server-side and streamed as
   * GFX bitmaps, so higher = sharper text/vectors but more transfer +
   * compositing cost. Tiers: 960x540, 1280x720, 1920x1080, 2560x1440, 3840x2160.
   * (Above 1080p only text/vector primitives sharpen — STV bitmap art is authored
   * <=1080p — while 4K ~4x's framebuffer + image-transfer bandwidth, so we cap at 4K.)
   *
   * iOS/iPadOS Safari composites the streamed bitmaps on the main thread and can
   * get input-laggy on deep menus at high targets, so it is capped at 1080p
   * (users can still force higher in Settings -> Connection -> Resolution).
   */
  _detectAdaptiveResolution() {
    const isTizen = this.platformDetector.isTizen();
    const isIOS = this.platformDetector.isIOS();
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    // TVs are always fullscreen and report the panel via screen*DPR; floor at
    // 1080p since a Tizen panel is never a 720p render target.
    const floorW = isTizen ? 1920 : 0;
    const floorH = isTizen ? 1080 : 0;
    const cssW = Math.max(window.screen?.width || 0, window.innerWidth || 0, floorW);
    const cssH = Math.max(window.screen?.height || 0, window.innerHeight || 0, floorH);
    const devPxW = Math.round(cssW * dpr);

    let target;
    if (devPxW >= 3840) target = { width: 3840, height: 2160 };      // 4K UHD
    else if (devPxW >= 2560) target = { width: 2560, height: 1440 }; // QHD
    else if (devPxW >= 1920) target = { width: 1920, height: 1080 }; // FHD
    else if (devPxW >= 1280) target = { width: 1280, height: 720 };  // HD
    else target = { width: 960, height: 540 };                       // qHD floor

    // iOS/iPadOS Safari GFX-compositing lag cap.
    if (isIOS && target.width > 1920) target = { width: 1920, height: 1080 };

    console.log(`[Session] Adaptive resolution detect: screen=${window.screen?.width || 0}x${window.screen?.height || 0} DPR=${dpr} devPx=${devPxW}x${Math.round(cssH * dpr)} tizen=${isTizen} ios=${isIOS} -> ${target.width}x${target.height}`);
    return target;
  }

  /**
   * Probe /discover on each candidate endpoint. Returns the ws(s):// URL of
   * whichever answered first, or null if none did.
   * @param {Array<[string,string]>} candidates - [wsUrl, httpProbeUrl] pairs
   */
  async _probeBridgeScheme(candidates) {
    for (const [wsUrl, httpUrl] of candidates) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const resp = await fetch(httpUrl, { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) return wsUrl;
      } catch (err) {
        // try the next candidate
      }
    }
    return null;
  }
}
