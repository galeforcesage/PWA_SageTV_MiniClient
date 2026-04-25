/**
 * SageTV MiniClient Media Player
 *
 * Implements MiniPlayerPlugin interface using HTML5 <video> + MSE + mux.js.
 *
 * Modes:
 * - PULL mode: Client fetches media via HTTP URL → <video src="..."> or hls.js
 * - PUSH mode: Server pushes MPEG-TS data → mux.js transmuxes to fMP4 → MSE
 *
 * Browsers cannot play raw MPEG-TS via MediaSource Extensions (MSE).
 * MSE requires fragmented MP4 (fMP4). We use mux.js to transmux on-the-fly.
 *
 * Port of: core/src/main/java/sagex/miniclient/MiniPlayerPlugin.java
 */

import { PlayerState, DESIRED_VIDEO_PREBUFFER } from '../protocol/constants.js';

export class MediaPlayer extends EventTarget {
  /**
   * @param {HTMLVideoElement} videoElement
   * @param {HTMLElement} container - Container for positioning
   */
  constructor(videoElement, container) {
    super();
    this.video = videoElement;
    this.container = container;

    // Player state
    this.state = PlayerState.NO_STATE;
    this.pushMode = false;
    this.bridgeMode = false;
    this.serverEOS = false;
    this.lastServerStartTime = 0;
    this._bridgeFilePath = null;
    this._bridgeAbortController = null;
    this._bridgeSessionId = 'pwa-' + Date.now();
    this._bridgeTimeOffsetMs = 0;  // offset added to video.currentTime for seek

    // Bandwidth tracking (bytes received per 1-second window)
    this._bwBytesWindow = 0;
    this._bwKbps = 0;
    this._bwTimer = null;

    // MSE for push mode
    this.mediaSource = null;
    this.sourceBuffer = null;
    this._pushQueue = [];
    this._pushBusy = false;
    this._pushBufferSize = DESIRED_VIDEO_PREBUFFER;
    this._totalPushed = 0;

    // mux.js transmuxer for MPEG-TS → fMP4
    this._transmuxer = null;
    this._initSegmentSent = false;

    // Push mode codec detection
    this._pushCodecChecked = false;  // true after PMT parsed
    this._pushStallBytes = 0;        // bytes pushed without mux.js output
    this._pushOutputBytes = 0;       // bytes mux.js produced

    // hls.js instance for HLS streams
    this._hls = null;

    // Subtitle tracks
    this._subtitleTracks = [];
    this._selectedSubtitle = -1;

    // Video dimensions
    this._videoDimensions = { width: 0, height: 0 };

    // Seeking indicator state
    this.seeking = false;

    // Bind video events
    this._setupVideoEvents();
  }

  _setupVideoEvents() {
    this.video.addEventListener('loadedmetadata', () => {
      this._videoDimensions = {
        width: this.video.videoWidth || 0,
        height: this.video.videoHeight || 0,
      };
    });

    this.video.addEventListener('playing', () => {
      this.state = PlayerState.PLAY;
    });

    this.video.addEventListener('pause', () => {
      // In bridge mode, play/pause is controlled by STV protocol commands (MEDIACMD_PLAY/PAUSE).
      // Browser pause events fire during MediaSource teardown/recreation on seek and must be ignored.
      if (this.bridgeMode) return;
      if (this.state === PlayerState.PLAY) {
        this.state = PlayerState.PAUSE;
      }
    });

    this.video.addEventListener('ended', () => {
      this.state = PlayerState.EOS;
      this.dispatchEvent(new CustomEvent('eos'));
    });

    this.video.addEventListener('error', (e) => {
      // In bridge mode, errors during MediaSource recreation on seek are expected and harmless.
      if (this.bridgeMode) {
        console.debug('[MediaPlayer] Ignoring video error during bridge mode:', this.video.error?.message);
        return;
      }
      console.error('[MediaPlayer] Video error:', this.video.error);
      this.state = PlayerState.STOPPED;
    });

    this.video.addEventListener('waiting', () => {
      this.dispatchEvent(new CustomEvent('buffering'));
    });
  }

  // ── MiniPlayerPlugin Interface ────────────────────────────

  /**
   * Load media from URL.
   * @param {number} majorHint - Major type hint
   * @param {number} minorHint - Minor type hint
   * @param {string} encodingHint - Encoding hint string
   * @param {string} url - Media URL (file://, push:, http://, etc.)
   * @param {string} hostname - SageTV server hostname
   * @param {boolean} timeshifted - Whether this is a timeshifted recording
   * @param {number} bufferSize - Buffer size hint
   */
  async load(majorHint, minorHint, encodingHint, url, hostname, timeshifted, bufferSize, bridgeFilePath) {
    this.stop(); // Clean up any previous playback
    this.serverEOS = false;
    this._totalPushed = 0;

    if (bridgeFilePath) {
      console.log(`[MediaPlayer] BRIDGE mode: ${bridgeFilePath}`);
      await this._loadBridgeMode(bridgeFilePath, hostname);
    } else if (url.startsWith('push:')) {
      console.log(`[MediaPlayer] PUSH mode: ${url}`);
      await this._loadPushMode(url, hostname);
    } else {
      await this._loadPullMode(url, hostname);
    }
  }

  /**
   * PULL mode: client fetches media via URL.
   */
  async _loadPullMode(url, hostname) {
    this.pushMode = false;
    let mediaUrl = url;

    // Convert file:// to HTTP stream via SageTV server
    if (url.startsWith('file://')) {
      const path = url.substring(7);
      mediaUrl = `http://${hostname}:7818${path}`;
    } else if (url.startsWith('stv://')) {
      const path = url.substring(6);
      mediaUrl = `http://${hostname}:7818/${path}`;
    }

    console.log(`[MediaPlayer] PULL mode: ${mediaUrl}`);

    // Check if HLS
    if (mediaUrl.includes('.m3u8') || mediaUrl.includes('format=hls')) {
      await this._loadHLS(mediaUrl);
    } else {
      // Direct URL playback
      this.video.src = mediaUrl;
      this.video.load();
    }

    this.state = PlayerState.LOADED;
  }

  /**
   * BRIDGE mode: fetch transcoded H.264+AAC fragmented MP4 from bridge's ffmpeg.
   * Bridge runs on same machine as SageTV, reads file directly, transcodes with system ffmpeg.
   * ffmpeg outputs fMP4 (frag_keyframe+empty_moov) which feeds directly into MSE — no transmuxing.
   */
  async _loadBridgeMode(filePath, hostname) {
    this.pushMode = false;
    this.bridgeMode = true;
    this._bridgeFilePath = filePath;
    this._bridgeSessionId = 'pwa-' + Date.now();

    // Set up MSE
    const MSClass = window.ManagedMediaSource || window.MediaSource;
    if (!MSClass) {
      console.error('[MediaPlayer] MediaSource API not available');
      this.state = PlayerState.STOPPED;
      return;
    }

    this.mediaSource = new MSClass();
    if (window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
      this.video.srcObject = this.mediaSource;
    } else {
      this.video.src = URL.createObjectURL(this.mediaSource);
    }

    await new Promise((resolve) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
    });

    // Create fMP4 source buffer for H.264+AAC
    const mimeType = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    if (!MSClass.isTypeSupported(mimeType)) {
      const videoOnly = 'video/mp4; codecs="avc1.42E01E"';
      if (MSClass.isTypeSupported(videoOnly)) {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(videoOnly);
      } else {
        console.error('[MediaPlayer] No supported fMP4 MIME type');
        this.state = PlayerState.STOPPED;
        return;
      }
    } else {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    }
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.addEventListener('updateend', () => this._processPushQueue());
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('[MediaPlayer] SourceBuffer error:', e);
    });

    this.state = PlayerState.LOADED;

    // Start fetching transcoded stream from bridge
    this._startBridgeStream(filePath, 0);
  }

  /**
   * Start (or restart) fetching the transcoded stream from the bridge.
   */
  async _startBridgeStream(filePath, seekSec) {
    // Abort any previous fetch
    if (this._bridgeAbortController) {
      this._bridgeAbortController.abort();
    }
    this._bridgeAbortController = new AbortController();

    // Build bridge URL — bridge is on same origin (same host:port as PWA)
    const bridgeUrl = `/transcode?file=${encodeURIComponent(filePath)}&seek=${seekSec}&session=${this._bridgeSessionId}`;
    console.log(`[MediaPlayer] Bridge stream: ${bridgeUrl}`);

    try {
      const response = await fetch(bridgeUrl, {
        signal: this._bridgeAbortController.signal,
      });

      if (!response.ok) {
        console.error(`[MediaPlayer] Bridge transcode failed: ${response.status} ${response.statusText}`);
        this.state = PlayerState.STOPPED;
        return;
      }

      const reader = response.body.getReader();
      let totalBytes = 0;
      let autoPlayed = false;
      this._startBandwidthTracking();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[MediaPlayer] Bridge stream ended, total: ${(totalBytes / 1024).toFixed(0)}KB`);
          // Signal EOS
          if (this.mediaSource && this.mediaSource.readyState === 'open') {
            // Wait for all pending appends
            const waitForBuffer = () => new Promise((resolve) => {
              if (!this.sourceBuffer || !this.sourceBuffer.updating) resolve();
              else this.sourceBuffer.addEventListener('updateend', resolve, { once: true });
            });
            await waitForBuffer();
            try { this.mediaSource.endOfStream(); } catch { /* ignore */ }
          }
          break;
        }

        totalBytes += value.length;
        this._bwBytesWindow += value.length;

        // First chunk — log fMP4 header for debugging
        if (totalBytes === value.length) {
          const hdr = Array.from(value.subarray(0, Math.min(16, value.length)))
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log(`[MediaPlayer] Bridge first chunk: ${value.length}B, header=[${hdr}]`);
          if (this.seeking) {
            this.seeking = false;
            this.dispatchEvent(new CustomEvent('seeked'));
          }
        }

        // Feed fMP4 directly to SourceBuffer
        if (this.sourceBuffer && this.mediaSource && this.mediaSource.readyState === 'open') {
          this._pushQueue.push(new Uint8Array(value));
          this._processPushQueue();

          // After seek, reset video.currentTime to start of new buffered data
          if (this._bridgeNeedTimeReset && this.sourceBuffer.buffered.length > 0) {
            this.video.currentTime = this.sourceBuffer.buffered.start(0);
            this._bridgeNeedTimeReset = false;
          }
        }

        // Auto-play after enough data (initial load or after seek)
        if (!autoPlayed && totalBytes > 128 * 1024 &&
            (this.state === PlayerState.LOADED || this._wasPlayingBeforeSeek)) {
          console.log(`[MediaPlayer] Bridge auto-playing after ${(totalBytes / 1024).toFixed(0)}KB`);
          this._wasPlayingBeforeSeek = false;
          this.play();
          autoPlayed = true;
        }

        // Log progress
        if (totalBytes > 0 && (totalBytes % (1024 * 1024)) < value.length) {
          console.log(`[MediaPlayer] Bridge: ${(totalBytes / 1024 / 1024).toFixed(1)}MB total, queue=${this._pushQueue.length}`);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[MediaPlayer] Bridge stream aborted (seek or stop)');
      } else {
        console.error('[MediaPlayer] Bridge stream error:', err);
      }
    }
  }

  /**
   * Load HLS stream using hls.js or native Safari HLS.
   */
  async _loadHLS(url) {
    // Try loading hls.js dynamically
    if (!window.Hls) {
      try {
        await this._loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js');
      } catch {
        console.warn('[MediaPlayer] hls.js not available, trying native HLS');
      }
    }

    if (window.Hls && window.Hls.isSupported()) {
      this._hls = new window.Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        enableWorker: true,
      });
      this._hls.loadSource(url);
      this._hls.attachMedia(this.video);
      this._hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        console.log('[MediaPlayer] HLS manifest loaded');
      });
      this._hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error('[MediaPlayer] HLS fatal error:', data.type, data.details);
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            this._hls.startLoad();
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            this._hls.recoverMediaError();
          }
        }
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari/iPad)
      this.video.src = url;
      this.video.load();
    } else {
      console.error('[MediaPlayer] No HLS support available');
    }
  }

  /**
   * PUSH mode: server transcodes to H.264+AAC in MPEG-TS.
   * Uses mux.js to transmux MPEG-TS → fMP4 → MSE SourceBuffer.
   */
  async _loadPushMode(url, hostname) {
    this.pushMode = true;
    this._initSegmentSent = false;

    // Load mux.js
    await this._loadScript('https://cdn.jsdelivr.net/npm/mux.js@7.0.3/dist/mux.min.js');
    if (!window.muxjs) {
      console.error('[MediaPlayer] mux.js not available');
      this.state = PlayerState.STOPPED;
      return;
    }

    // Set up MediaSource
    const MSClass = window.ManagedMediaSource || window.MediaSource;
    if (!MSClass) {
      console.error('[MediaPlayer] MediaSource API not available');
      this.state = PlayerState.STOPPED;
      return;
    }

    this.mediaSource = new MSClass();

    if (window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
      this.video.srcObject = this.mediaSource;
    } else {
      this.video.src = URL.createObjectURL(this.mediaSource);
    }

    await new Promise((resolve) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
    });

    // Create fMP4 source buffer
    const mimeType = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    if (!MSClass.isTypeSupported(mimeType)) {
      const videoOnly = 'video/mp4; codecs="avc1.42E01E"';
      if (MSClass.isTypeSupported(videoOnly)) {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(videoOnly);
      } else {
        console.error('[MediaPlayer] No supported fMP4 MIME type');
        this.state = PlayerState.STOPPED;
        return;
      }
    } else {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    }
    this.sourceBuffer.mode = 'sequence';
    this.sourceBuffer.addEventListener('updateend', () => this._processPushQueue());
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('[MediaPlayer] SourceBuffer error:', e);
    });

    // Create mux.js transmuxer
    this._transmuxer = new window.muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
      remux: true,
    });

    this._transmuxer.on('data', (segment) => {
      if (!this._initSegmentSent) {
        const initSegment = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
        initSegment.set(segment.initSegment, 0);
        initSegment.set(segment.data, segment.initSegment.byteLength);
        this._pushQueue.push(initSegment);
        this._initSegmentSent = true;
        this._pushOutputBytes += initSegment.byteLength;
        console.log(`[MediaPlayer] Init segment: ${segment.initSegment.byteLength}B + data: ${segment.data.byteLength}B`);
      } else {
        this._pushQueue.push(new Uint8Array(segment.data));
        this._pushOutputBytes += segment.data.byteLength;
      }
    });

    this._transmuxer.on('done', () => {
      this._processPushQueue();
    });

    this.state = PlayerState.LOADED;
    console.log('[MediaPlayer] Push mode ready with mux.js transmuxer (H.264 path)');
  }

  // ── MPEG-TS Codec Detection ───────────────────────────────

  /**
   * MPEG-TS stream_type constants from ISO 13818-1.
   * mux.js only supports H.264 video + AAC/MP3 audio.
   * Anything else will silently fail — detect early and warn.
   */
  static STREAM_TYPES = {
    // Video
    0x1B: 'H.264',      // AVC — supported by mux.js
    0x24: 'HEVC',        // HEVC/H.265 — NOT supported by mux.js
    0x02: 'MPEG2-Video', // NOT supported by mux.js
    0x01: 'MPEG1-Video', // NOT supported by mux.js
    0x10: 'MPEG4-Video', // NOT supported by mux.js
    // Audio
    0x0F: 'AAC',         // ISO 14496-3 — supported
    0x11: 'AAC-LATM',    // supported
    0x03: 'MP3',         // MPEG1 Audio Layer 3 — supported by mux.js
    0x04: 'MP3',         // MPEG2 Audio Layer 3 — supported by mux.js
    0x81: 'AC3',         // Dolby AC-3 — NOT decoded by browser
    0x87: 'EAC3',        // Dolby E-AC-3 — NOT decoded by browser
    0x06: 'PES-Private', // Private data (may contain AC3/DTS via descriptor)
    0x82: 'DTS',         // NOT decoded by browser
    0x86: 'DTS',         // NOT decoded by browser
  };

  static MUXJS_SUPPORTED_VIDEO = new Set([0x1B]);           // H.264 only
  static MUXJS_SUPPORTED_AUDIO = new Set([0x0F, 0x11, 0x03, 0x04]); // AAC, MP3

  /**
   * Parse MPEG-TS PAT + PMT from push data to detect stream codecs.
   * Returns {video: string|null, audio: string|null, supported: boolean}
   * or null if PMT not found in this chunk.
   */
  _detectPushCodecs(data) {
    // MPEG-TS packets are 188 bytes, sync byte 0x47
    if (data.length < 188 || data[0] !== 0x47) return null;

    let pmtPid = -1;
    const result = { video: null, audio: null, videoType: -1, audioType: -1, supported: true };

    // Scan for PAT (PID 0) then PMT
    for (let offset = 0; offset + 188 <= data.length; offset += 188) {
      if (data[offset] !== 0x47) continue; // sync byte

      const pid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
      const payloadStart = (data[offset + 1] & 0x40) !== 0;
      const hasAdaptation = (data[offset + 3] & 0x20) !== 0;
      const hasPayload = (data[offset + 3] & 0x10) !== 0;
      if (!hasPayload) continue;

      let payloadOffset = offset + 4;
      if (hasAdaptation) {
        payloadOffset += 1 + data[offset + 4]; // skip adaptation field
      }
      if (payloadStart) {
        payloadOffset += data[payloadOffset] + 1; // pointer field
      }
      if (payloadOffset >= offset + 188) continue;

      // PAT: PID 0 → extract PMT PID
      if (pid === 0 && pmtPid < 0) {
        const tableId = data[payloadOffset];
        if (tableId !== 0x00) continue;
        const sectionLen = ((data[payloadOffset + 1] & 0x0F) << 8) | data[payloadOffset + 2];
        const progStart = payloadOffset + 8; // skip table header
        const progEnd = payloadOffset + 3 + sectionLen - 4; // exclude CRC
        if (progEnd > offset + 188) continue;
        for (let p = progStart; p + 3 < progEnd; p += 4) {
          const progNum = (data[p] << 8) | data[p + 1];
          if (progNum !== 0) { // skip NIT
            pmtPid = ((data[p + 2] & 0x1F) << 8) | data[p + 3];
            break;
          }
        }
      }

      // PMT: extract stream types
      if (pid === pmtPid && pmtPid > 0) {
        const tableId = data[payloadOffset];
        if (tableId !== 0x02) continue;
        const sectionLen = ((data[payloadOffset + 1] & 0x0F) << 8) | data[payloadOffset + 2];
        const progInfoLen = ((data[payloadOffset + 10] & 0x0F) << 8) | data[payloadOffset + 11];
        let streamOffset = payloadOffset + 12 + progInfoLen;
        const sectionEnd = payloadOffset + 3 + sectionLen - 4;
        if (sectionEnd > offset + 188) continue;

        while (streamOffset + 4 < sectionEnd) {
          const streamType = data[streamOffset];
          const esInfoLen = ((data[streamOffset + 3] & 0x0F) << 8) | data[streamOffset + 4];
          const typeName = MediaPlayer.STREAM_TYPES[streamType] || `unknown(0x${streamType.toString(16)})`;

          // Classify as video or audio
          if (streamType === 0x1B || streamType === 0x24 || streamType === 0x02 ||
              streamType === 0x01 || streamType === 0x10) {
            result.video = typeName;
            result.videoType = streamType;
          } else if (streamType === 0x0F || streamType === 0x11 || streamType === 0x03 ||
                     streamType === 0x04 || streamType === 0x81 || streamType === 0x87 ||
                     streamType === 0x82 || streamType === 0x86 || streamType === 0x06) {
            result.audio = typeName;
            result.audioType = streamType;
          }
          streamOffset += 5 + esInfoLen;
        }

        // Check support
        if (result.videoType >= 0 && !MediaPlayer.MUXJS_SUPPORTED_VIDEO.has(result.videoType)) {
          result.supported = false;
        }
        if (result.audioType >= 0 && !MediaPlayer.MUXJS_SUPPORTED_AUDIO.has(result.audioType)) {
          result.supported = false;
        }

        return result;
      }
    }
    return null; // PMT not found in this chunk
  }

  /**
   * Load a script dynamically.
   */
  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // ── Playback Controls ─────────────────────────────────────

  play() {
    const playPromise = this.video.play();
    if (playPromise) {
      playPromise.catch((err) => {
        // Autoplay blocked - show play button overlay
        console.warn('[MediaPlayer] Play blocked:', err.message);
        this.dispatchEvent(new CustomEvent('playblocked'));
      });
    }
    this.state = PlayerState.PLAY;
  }

  pause() {
    this.video.pause();
    this.state = PlayerState.PAUSE;
  }

  stop() {
    this.video.pause();
    this._stopBandwidthTracking();

    // Clear seeking state
    if (this.seeking) {
      this.seeking = false;
      this.dispatchEvent(new CustomEvent('seeked'));
    }
    if (this._seekDebounceTimer) {
      clearTimeout(this._seekDebounceTimer);
      this._seekDebounceTimer = null;
    }

    // Stop bridge transcode
    if (this._bridgeAbortController) {
      this._bridgeAbortController.abort();
      this._bridgeAbortController = null;
    }
    if (this.bridgeMode && this._bridgeSessionId) {
      // Fire-and-forget stop request to bridge
      fetch(`/transcode/stop?session=${this._bridgeSessionId}`).catch(() => {});
    }
    this.bridgeMode = false;
    this._bridgeFilePath = null;
    this._bridgeTimeOffsetMs = 0;
    this._bridgeNeedTimeReset = false;

    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }

    if (this._transmuxer) {
      this._transmuxer.dispose();
      this._transmuxer = null;
    }
    this._initSegmentSent = false;
    this._pushCodecChecked = false;
    this._pushStallBytes = 0;
    this._pushOutputBytes = 0;
    this._pushStallWarned = false;

    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch {/* ignore */}
      this.mediaSource = null;
      this.sourceBuffer = null;
    }

    // Revoke blob URL BEFORE clearing src (otherwise the URL is lost)
    if (this.video.src && this.video.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.video.src);
    }

    // Fully reset the video element — srcObject is a property, not an attribute
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load(); // Forces video element to release internal decoder state

    this._pushQueue = [];
    this._pushBusy = false;
    this._totalPushed = 0;
    this._appendErrorLogged = false;
    this.state = PlayerState.STOPPED;
  }

  /**
   * Seek to a position in milliseconds.
   */
  seek(timeMS) {
    const timeSec = timeMS / 1000;
    if (!isFinite(timeSec) || timeSec < 0) return;

    if (this.bridgeMode && this._bridgeFilePath) {
      // Debounce rapid seeks — only restart the stream after user stops pressing FF
      console.log(`[MediaPlayer] Bridge seek to ${timeSec.toFixed(1)}s`);
      this.seeking = true;
      this._wasPlayingBeforeSeek = (this.state === PlayerState.PLAY);
      this.dispatchEvent(new CustomEvent('seeking'));
      this._bridgeTimeOffsetMs = timeMS;
      this._bridgeNeedTimeReset = true;

      // Immediately abort any in-flight stream so playback doesn't keep going at the old position
      if (this._bridgeAbortController) {
        this._bridgeAbortController.abort();
        this._bridgeAbortController = null;
      }

      // Debounce: reset timer on each press, only fire after 300ms of no new seeks
      if (this._seekDebounceTimer) clearTimeout(this._seekDebounceTimer);
      this._seekDebounceTimer = setTimeout(() => {
        this._seekDebounceTimer = null;
        this._flushAndRestart(this._bridgeFilePath, timeSec);
      }, 300);
    } else {
      this.video.currentTime = timeSec;
    }
  }

  /**
   * Flush SourceBuffer and wait for removal to complete before restarting bridge stream.
   * Tears down and recreates MediaSource + SourceBuffer to ensure a clean init segment state.
   */
  async _flushAndRestart(filePath, seekSec) {
    // Tag this restart so we can detect if a newer one supersedes us
    const restartId = Symbol();
    this._currentRestartId = restartId;

    // Abort current fetch
    if (this._bridgeAbortController) {
      this._bridgeAbortController.abort();
      this._bridgeAbortController = null;
    }
    this._pushQueue = [];

    // Tear down existing MediaSource completely — a fresh ffmpeg process produces
    // a new moov init segment that can conflict with the old SourceBuffer state.
    if (this.sourceBuffer) {
      try {
        if (this.sourceBuffer.updating) {
          await new Promise(r => this.sourceBuffer.addEventListener('updateend', r, { once: true }));
        }
      } catch { /* ignore */ }
      this.sourceBuffer = null;
    }
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch { /* ignore */ }
      this.mediaSource = null;
    }

    // If a newer seek came in while we were tearing down, bail out
    if (this._currentRestartId !== restartId) return;

    // Recreate MediaSource + SourceBuffer from scratch
    const MSClass = window.ManagedMediaSource || window.MediaSource;
    this.mediaSource = new MSClass();
    if (window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
      this.video.srcObject = this.mediaSource;
    } else {
      this.video.src = URL.createObjectURL(this.mediaSource);
    }

    await new Promise((resolve) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
    });

    // Check again after async wait
    if (this._currentRestartId !== restartId) return;

    const mimeType = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
    if (!MSClass.isTypeSupported(mimeType)) {
      const videoOnly = 'video/mp4; codecs="avc1.42E01E"';
      if (MSClass.isTypeSupported(videoOnly)) {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(videoOnly);
      } else {
        console.error('[MediaPlayer] No supported fMP4 MIME type after seek');
        return;
      }
    } else {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    }
    this.sourceBuffer.mode = 'segments';
    this.sourceBuffer.addEventListener('updateend', () => this._processPushQueue());
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('[MediaPlayer] SourceBuffer error:', e);
    });

    // Now start the new stream
    this._startBridgeStream(filePath, seekSec);
  }

  /**
   * Get current playback position in milliseconds.
   */
  getMediaTimeMillis() {
    if (this.state === PlayerState.NO_STATE || this.state === PlayerState.STOPPED) {
      return 0;
    }
    const rawMs = Math.floor((this.video.currentTime || 0) * 1000);
    // In bridge mode, ffmpeg outputs timestamps starting from 0 after each seek,
    // so we add the seek offset to report the correct file position.
    return this.bridgeMode ? this._bridgeTimeOffsetMs + rawMs : rawMs;
  }

  getState() {
    return this.state;
  }

  setMute(muted) {
    this.video.muted = muted;
  }

  getVolume() {
    return Math.floor(this.video.volume * 65535);
  }

  setVolume(normalized) {
    this.video.volume = Math.max(0, Math.min(1, normalized));
  }

  setServerEOS() {
    this.serverEOS = true;
    console.log(`[MediaPlayer] Server EOS, total pushed: ${(this._totalPushed / 1024).toFixed(0)}KB`);
    if (this.pushMode && this.mediaSource && this.mediaSource.readyState === 'open') {
      if (!this.sourceBuffer || !this.sourceBuffer.updating) {
        try {
          this.mediaSource.endOfStream();
        } catch {/* ignore */}
      }
    }
  }

  // ── Push Mode ─────────────────────────────────────────────

  /**
   * Push media data from the server (H.264+AAC in MPEG-TS, transcoded by server).
   * @param {Uint8Array} data - MPEG-TS data chunk
   * @param {number} flags - Push flags
   */
  pushData(data, flags) {
    if (!this.pushMode || this.state === PlayerState.STOPPED) return;
    this._totalPushed += data.length;

    // Log first push to diagnose format
    if (this._totalPushed === data.length) {
      const hdr = Array.from(data.subarray(0, Math.min(16, data.length)))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[MediaPlayer] First push: ${data.length}B, header=[${hdr}]`);
    }

    // ── Codec detection on early push data ──
    if (!this._pushCodecChecked) {
      const codecs = this._detectPushCodecs(data);
      if (codecs) {
        this._pushCodecChecked = true;
        console.log(`[MediaPlayer] Push stream codecs: video=${codecs.video} (0x${codecs.videoType.toString(16)}), audio=${codecs.audio} (0x${codecs.audioType.toString(16)}), supported=${codecs.supported}`);

        if (!codecs.supported) {
          const problems = [];
          if (codecs.videoType >= 0 && !MediaPlayer.MUXJS_SUPPORTED_VIDEO.has(codecs.videoType)) {
            problems.push(`video codec ${codecs.video} not supported by browser transmuxer (only H.264)`);
          }
          if (codecs.audioType >= 0 && !MediaPlayer.MUXJS_SUPPORTED_AUDIO.has(codecs.audioType)) {
            problems.push(`audio codec ${codecs.audio} not decoded by browser (only AAC/MP3)`);
          }
          console.error(`[MediaPlayer] PUSH CODEC MISMATCH: ${problems.join('; ')}. ` +
            `Server should be transcoding to H.264+AAC but sent raw stream. ` +
            `Check FIXED_PUSH_MEDIA_FORMAT and server FFmpeg availability.`);

          // Dispatch event so UI can show a visible warning
          this.dispatchEvent(new CustomEvent('codecerror', {
            detail: {
              video: codecs.video, audio: codecs.audio,
              message: `Unsupported push codec: ${problems.join('; ')}`,
            }
          }));
        }
      }
    }

    // ── Stall detection: mux.js produces no output ──
    const prevOutput = this._pushOutputBytes;
    this._pushStallBytes += data.length;

    if (!this._transmuxer || !this.mediaSource || this.mediaSource.readyState !== 'open') return;

    this._transmuxer.push(data);
    this._transmuxer.flush();

    // Check if mux.js produced any output from this push
    if (this._pushOutputBytes === prevOutput) {
      // No output produced — mux.js couldn't parse this data
      if (this._pushStallBytes > 512 * 1024 && this._pushOutputBytes === 0) {
        // 512KB pushed with zero output — confirmed stall
        if (!this._pushStallWarned) {
          this._pushStallWarned = true;
          console.error(`[MediaPlayer] PUSH STALL: ${(this._pushStallBytes / 1024).toFixed(0)}KB received, 0B output from transmuxer. ` +
            `Stream likely contains unsupported codecs (HEVC, MPEG2, AC3). ` +
            `Server FFmpeg may not be transcoding to H.264+AAC.`);
          this.dispatchEvent(new CustomEvent('codecerror', {
            detail: { message: 'No playable video: server push stream not in H.264+AAC format' }
          }));
        }
      }
    } else {
      this._pushStallBytes = 0; // Reset stall counter on successful output
    }

    // Auto-play after receiving enough data
    if (this._totalPushed > 256 * 1024 && this.state === PlayerState.LOADED) {
      console.log(`[MediaPlayer] Auto-playing after ${(this._totalPushed / 1024).toFixed(0)}KB pushed`);
      this.play();
    }

    // Log progress periodically
    if (this._totalPushed > 0 && (this._totalPushed % (1024 * 1024)) < data.length) {
      console.log(`[MediaPlayer] Pushed ${(this._totalPushed / 1024 / 1024).toFixed(1)}MB total, queue=${this._pushQueue.length}`);
    }
  }

  _processPushQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this._pushQueue.length === 0) {
      return;
    }
    // Guard against detached SourceBuffer
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
      this._pushQueue = [];
      return;
    }

    // Combine multiple small chunks into one append for efficiency
    const maxChunkSize = 512 * 1024; // 512KB
    let totalSize = 0;
    let count = 0;
    for (let i = 0; i < this._pushQueue.length && totalSize < maxChunkSize; i++) {
      totalSize += this._pushQueue[i].length;
      count++;
    }

    const chunks = this._pushQueue.splice(0, count);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    try {
      this.sourceBuffer.appendBuffer(combined);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        // Remove old data from buffer
        this._evictBuffer();
        this._pushQueue.unshift(combined);
      } else {
        // SourceBuffer removed or other fatal error — stop trying
        if (!this._appendErrorLogged) {
          console.error('[MediaPlayer] appendBuffer error (suppressing further):', e.message);
          this._appendErrorLogged = true;
        }
        this._pushQueue = [];
      }
    }
  }

  /**
   * Evict old data from the source buffer when quota is exceeded.
   */
  _evictBuffer() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;

    const currentTime = this.video.currentTime;
    const buffered = this.sourceBuffer.buffered;
    if (buffered.length > 0 && currentTime > 30) {
      try {
        this.sourceBuffer.remove(0, currentTime - 10);
      } catch {/* ignore */}
    }
  }

  /**
   * Flush all buffered data (on seek).
   */
  flush() {
    this._pushQueue = [];

    if (this.bridgeMode) {
      // Bridge mode: abort current stream, clear SourceBuffer
      if (this._bridgeAbortController) {
        this._bridgeAbortController.abort();
        this._bridgeAbortController = null;
      }
    } else if (this._transmuxer) {
      // Push/transmux mode: reset the transmuxer for fresh data after seek
      this._transmuxer.dispose();
      this._transmuxer = new window.muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: true,
        remux: true,
      });
      this._initSegmentSent = false;
      this._transmuxer.on('data', (segment) => {
        if (!this._initSegmentSent) {
          const initSegment = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
          initSegment.set(segment.initSegment, 0);
          initSegment.set(segment.data, segment.initSegment.byteLength);
          this._pushQueue.push(initSegment);
          this._initSegmentSent = true;
          this._pushOutputBytes += initSegment.byteLength;
        } else {
          this._pushQueue.push(new Uint8Array(segment.data));
          this._pushOutputBytes += segment.data.byteLength;
        }
      });
      this._transmuxer.on('done', () => {
        this._processPushQueue();
      });
    }

    // Clear SourceBuffer so new data starts fresh
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      try {
        const buffered = this.sourceBuffer.buffered;
        if (buffered.length > 0) {
          this.sourceBuffer.remove(0, buffered.end(buffered.length - 1));
        }
      } catch {/* ignore */}
    }
  }

  /** Bandwidth of the media stream in Kbps (updated every second). */
  get bandwidthKbps() { return this._bwKbps; }

  _startBandwidthTracking() {
    this._stopBandwidthTracking();
    this._bwBytesWindow = 0;
    this._bwTimer = setInterval(() => {
      this._bwKbps = Math.round((this._bwBytesWindow * 8) / 1000);
      this._bwBytesWindow = 0;
    }, 1000);
  }

  _stopBandwidthTracking() {
    if (this._bwTimer) {
      clearInterval(this._bwTimer);
      this._bwTimer = null;
    }
    this._bwKbps = 0;
  }

  /**
   * Return seconds of video buffered ahead of current playback position.
   * This is the equivalent of SageTV Placeshifter's buffer gauge.
   */
  getBufferTime() {
    try {
      const buffered = this.video.buffered;
      const currentTime = this.video.currentTime;
      for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
          return buffered.end(i) - currentTime;
        }
      }
    } catch { /* no buffered ranges */ }
    return 0;
  }

  /**
   * Return remaining buffer capacity for push mode.
   */
  getBufferLeft() {
    if (!this.pushMode) return this._pushBufferSize;
    const queued = this._pushQueue.reduce((sum, c) => sum + c.length, 0);
    return Math.max(0, this._pushBufferSize - queued);
  }

  /**
   * Advance one frame (for frame stepping).
   */
  frameStep() {
    // requestVideoFrameCallback is available in modern browsers
    if (this.video.requestVideoFrameCallback) {
      this.video.pause();
      this.video.requestVideoFrameCallback(() => {
        this.video.currentTime += 1 / 30; // Assume 30fps
      });
    } else {
      this.video.currentTime += 1 / 30;
    }
  }

  // ── Audio/Subtitle Tracks ─────────────────────────────────

  setAudioTrack(index) {
    if (this._hls) {
      this._hls.audioTrack = index;
    } else if (this.video.audioTracks) {
      for (let i = 0; i < this.video.audioTracks.length; i++) {
        this.video.audioTracks[i].enabled = (i === index);
      }
    }
  }

  setSubtitleTrack(index) {
    this._selectedSubtitle = index;
    const tracks = this.video.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = (i === index) ? 'showing' : 'hidden';
    }
  }

  getSelectedSubtitleTrack() {
    return this._selectedSubtitle;
  }

  getSubtitleTrackCount() {
    return this.video.textTracks ? this.video.textTracks.length : 0;
  }

  getVideoDimensions() {
    return this._videoDimensions;
  }

  /**
   * Position the video element according to server-specified rectangles.
   * destRect is in server coordinates (e.g. 720x480); we scale to match canvas CSS size.
   */
  setVideoRectangles(srcRect, destRect) {
    this._lastSrcRect = srcRect;
    this._lastDestRect = destRect;
    this._applyVideoRectangles();
  }

  _applyVideoRectangles() {
    const destRect = this._lastDestRect;
    if (!destRect) return;
    const canvas = this.container.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) return;

    const scaleX = canvas.clientWidth / canvas.width;
    const scaleY = canvas.clientHeight / canvas.height;

    // Canvas position within container
    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const offsetX = canvasRect.left - containerRect.left;
    const offsetY = canvasRect.top - containerRect.top;

    this.video.style.left = `${offsetX + destRect.x * scaleX}px`;
    this.video.style.top = `${destRect.y * scaleY + offsetY}px`;
    this.video.style.width = `${destRect.width * scaleX}px`;
    this.video.style.height = `${destRect.height * scaleY}px`;
    this.video.style.objectFit = 'fill';
  }

  setVideoAdvancedAspect(aspectMode) {
    switch (aspectMode) {
      case 'Fill':
        this.video.style.objectFit = 'fill';
        break;
      case '4x3':
      case '16x9':
      case 'Source':
        this.video.style.objectFit = 'contain';
        break;
      default:
        this.video.style.objectFit = 'contain';
    }
  }

  /**
   * Free all resources.
   */
  free() {
    this.stop();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
