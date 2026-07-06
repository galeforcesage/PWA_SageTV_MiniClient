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

    // Get resolution from settings, with adaptive default for weak devices
    const adaptiveRes = this._detectAdaptiveResolution();
    const configuredWidth = this.settings.getInt('resolution_width', adaptiveRes.width);
    const configuredHeight = this.settings.getInt('resolution_height', adaptiveRes.height);
    const useIOSPerfProfile = this.platformDetector.isIOS() && configuredWidth === 1280 && configuredHeight === 720;
    // Legacy Tizen installs may have `resolution_width=1280x720` (very old
    // default) or `1920x1080` (previous default) stored. On a 4K panel both
    // force the TV to upscale and produce fuzzy menus. If the detected panel
    // supports a higher tier AND the stored value matches one of the two
    // historical defaults, auto-upgrade to the detected tier. Explicit user
    // picks that aren't 1280x720 or 1920x1080 are left alone.
    const isTizen = this.platformDetector.isTizen();
    const legacyTizenDefault =
      (configuredWidth === 1280 && configuredHeight === 720) ||
      (configuredWidth === 1920 && configuredHeight === 1080);
    const useTizenUpgrade = isTizen
      && legacyTizenDefault
      && (adaptiveRes.width > configuredWidth || adaptiveRes.height > configuredHeight);
    const width = (useIOSPerfProfile || useTizenUpgrade) ? adaptiveRes.width : configuredWidth;
    const height = (useIOSPerfProfile || useTizenUpgrade) ? adaptiveRes.height : configuredHeight;
    if (useIOSPerfProfile) {
      console.log(`[Session] iOS perf profile enabled: ${configuredWidth}x${configuredHeight} -> ${width}x${height}`);
    }
    if (useTizenUpgrade) {
      console.log(`[Session] Tizen auto-upgrade: ${configuredWidth}x${configuredHeight} -> ${width}x${height}`);
      this.settings.set('resolution_width', String(width));
      this.settings.set('resolution_height', String(height));
    }
    console.log(`[Session] Client render resolution: ${width}x${height} (adaptive=${adaptiveRes.width}x${adaptiveRes.height}, stored=${configuredWidth}x${configuredHeight}, DPR=${window.devicePixelRatio || 1})`);

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

    // Create renderer
    this.renderer = new CanvasRenderer(canvas, {
      isIOS: this.platformDetector.isIOS(),
      isTizen: this.platformDetector.isTizen(),
      maxCacheMB: rendererCacheMB,
    });

    // Create media player
    this.mediaPlayer = new MediaPlayer(videoElement, container, {
      platformDetector: this.platformDetector,
    });

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

    const adaptiveRes = this._detectAdaptiveResolution();
    const configuredWidth = this.settings.getInt('resolution_width', adaptiveRes.width);
    const configuredHeight = this.settings.getInt('resolution_height', adaptiveRes.height);
    const useIOSPerfProfile = this.platformDetector.isIOS() && configuredWidth === 1280 && configuredHeight === 720;
    const legacyTizenDefault =
      (configuredWidth === 1280 && configuredHeight === 720) ||
      (configuredWidth === 1920 && configuredHeight === 1080);
    const useTizenUpgrade = this.platformDetector.isTizen()
      && legacyTizenDefault
      && (adaptiveRes.width > configuredWidth || adaptiveRes.height > configuredHeight);
    const width = (useIOSPerfProfile || useTizenUpgrade) ? adaptiveRes.width : configuredWidth;
    const height = (useIOSPerfProfile || useTizenUpgrade) ? adaptiveRes.height : configuredHeight;

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
   * Detect optimal resolution based on device capabilities.
   * Weak devices (low core count, touch-only, small memory) get 960x540
   * to reduce pixel throughput and image transfer volume.
   */
  _detectAdaptiveResolution() {
    // iOS Safari can become input-laggy on deep, image-heavy STV screens at 720p.
    // Use a lighter runtime profile unless the user explicitly picked another size.
    if (this.platformDetector.isIOS()) {
      return { width: 1024, height: 576 };
    }
    // Tizen TVs are typically 4K panels. `window.screen.width/height` and
    // `devicePixelRatio` together describe the actual device-pixel count of
    // the panel (Samsung's Tizen browser variously reports 1920 with DPR=1.5
    // or DPR=2, or 3840 with DPR=1 — the product is what matters).
    // Snap to standard tiers so the server has a sensible render target:
    //   >= 3840  -> 3840x2160 (4K)   sharpest text/vectors, ~4x pixel volume
    //   >= 2560  -> 2560x1440 (QHD)  intermediate step
    //   else     -> 1920x1080 (1080p) safe default; integer 2x upscale on 4K
    // Reasoning for capping at 3840: STV bitmap assets are authored at
    // 720p/1080p, so above 1080p only text/vector primitives gain sharpness;
    // 4K quadruples framebuffer + image-transfer bandwidth for a modest
    // visual gain. Users who want to force 4K can pick it explicitly in
    // Settings -> Connection -> Resolution.
    if (this.platformDetector.isTizen()) {
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
      const scrW = Math.max(window.screen?.width || 0, window.innerWidth || 0, 1920);
      const scrH = Math.max(window.screen?.height || 0, window.innerHeight || 0, 1080);
      const devPxW = Math.round(scrW * dpr);
      let target;
      if (devPxW >= 3840) target = { width: 3840, height: 2160 };
      else if (devPxW >= 2560) target = { width: 2560, height: 1440 };
      else target = { width: 1920, height: 1080 };
      console.log(`[Session] Tizen panel detect: screen=${scrW}x${scrH} DPR=${dpr} devPx=${devPxW}x${Math.round(scrH * dpr)} -> ${target.width}x${target.height}`);
      return target;
    }
    return { width: 1280, height: 720 };
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
