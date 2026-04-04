/**
 * SageTV MiniClient Media Player
 *
 * Implements MiniPlayerPlugin interface using HTML5 <video> + MSE + hls.js.
 *
 * Modes:
 * - PULL mode: Client fetches media via HTTP URL → <video src="..."> or hls.js
 * - PUSH mode: Server pushes MPEG-TS data → MediaSource Extensions (MSE)
 *
 * Safari/iPad strategy:
 * - hls.js handles HLS streams (uses MSE internally on Safari 17+)
 * - For PUSH mode, uses ManagedMediaSource on Safari when ManagedMediaSource is available
 * - Falls back to native HLS for older iPads
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
    this.serverEOS = false;
    this.lastServerStartTime = 0;

    // MSE for push mode
    this.mediaSource = null;
    this.sourceBuffer = null;
    this._pushQueue = [];
    this._pushBusy = false;
    this._pushBufferSize = DESIRED_VIDEO_PREBUFFER;
    this._totalPushed = 0;

    // hls.js instance for HLS streams
    this._hls = null;

    // Subtitle tracks
    this._subtitleTracks = [];
    this._selectedSubtitle = -1;

    // Video dimensions
    this._videoDimensions = { width: 0, height: 0 };

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
      if (this.state === PlayerState.PLAY) {
        this.state = PlayerState.PAUSE;
      }
    });

    this.video.addEventListener('ended', () => {
      this.state = PlayerState.EOS;
      this.dispatchEvent(new CustomEvent('eos'));
    });

    this.video.addEventListener('error', (e) => {
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
  async load(majorHint, minorHint, encodingHint, url, hostname, timeshifted, bufferSize) {
    this.stop(); // Clean up any previous playback
    this.serverEOS = false;
    this._totalPushed = 0;

    if (url.startsWith('push:')) {
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
   * PUSH mode: server sends MPEG-TS data via pushData().
   * Set up MediaSource Extensions.
   */
  async _loadPushMode(url, hostname) {
    this.pushMode = true;
    console.log(`[MediaPlayer] PUSH mode: ${url}`);

    // Use ManagedMediaSource for Safari, MediaSource elsewhere
    const MSClass = window.ManagedMediaSource || window.MediaSource;
    if (!MSClass) {
      console.error('[MediaPlayer] MediaSource API not available');
      this.state = PlayerState.STOPPED;
      return;
    }

    this.mediaSource = new MSClass();

    // For ManagedMediaSource (Safari), use the streaming attribute
    if (window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
      this.video.srcObject = this.mediaSource;
    } else {
      this.video.src = URL.createObjectURL(this.mediaSource);
    }

    await new Promise((resolve) => {
      this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
    });

    // Determine MIME type from push URL
    // push: URLs are typically MPEG2-TS
    const mimeType = this._detectPushMimeType(url);
    console.log(`[MediaPlayer] Push MIME: ${mimeType}`);

    if (!MSClass.isTypeSupported(mimeType)) {
      // Try alternative MIME types
      const alternatives = [
        'video/mp2t',
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4',
      ];
      let supported = null;
      for (const alt of alternatives) {
        if (MSClass.isTypeSupported(alt)) {
          supported = alt;
          break;
        }
      }
      if (!supported) {
        console.error('[MediaPlayer] No supported MIME type for push mode');
        this.state = PlayerState.STOPPED;
        return;
      }
      this.sourceBuffer = this.mediaSource.addSourceBuffer(supported);
    } else {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
    }

    this.sourceBuffer.mode = 'sequence';
    this.sourceBuffer.addEventListener('updateend', () => this._processPushQueue());
    this.sourceBuffer.addEventListener('error', (e) => {
      console.error('[MediaPlayer] SourceBuffer error:', e);
    });

    this.state = PlayerState.LOADED;
  }

  _detectPushMimeType(url) {
    if (url.includes('MPEG2-TS') || url.includes('mpegts')) {
      return 'video/mp2t';
    }
    if (url.includes('MPEG2-PS')) {
      return 'video/mpeg';
    }
    // Default to MPEG-TS
    return 'video/mp2t';
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
    this.video.removeAttribute('src');

    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }

    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      } catch {/* ignore */}
      this.mediaSource = null;
      this.sourceBuffer = null;
    }

    this._pushQueue = [];
    this._pushBusy = false;
    this.state = PlayerState.STOPPED;
  }

  /**
   * Seek to a position in milliseconds.
   */
  seek(timeMS) {
    const timeSec = timeMS / 1000;
    if (isFinite(timeSec) && timeSec >= 0) {
      this.video.currentTime = timeSec;
    }
  }

  /**
   * Get current playback position in milliseconds.
   */
  getMediaTimeMillis() {
    if (this.state === PlayerState.NO_STATE || this.state === PlayerState.STOPPED) {
      return 0;
    }
    return Math.floor((this.video.currentTime || 0) * 1000);
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
    if (this.pushMode && this.mediaSource && this.mediaSource.readyState === 'open') {
      // Wait for pending appends, then end stream
      if (!this.sourceBuffer || !this.sourceBuffer.updating) {
        try {
          this.mediaSource.endOfStream();
        } catch {/* ignore */}
      }
    }
  }

  // ── Push Mode ─────────────────────────────────────────────

  /**
   * Push media data from the server.
   * @param {Uint8Array} data - MPEG-TS data chunk
   * @param {number} flags - Push flags
   */
  pushData(data, flags) {
    if (!this.pushMode || !this.sourceBuffer) return;
    this._pushQueue.push(data.slice()); // Clone to avoid detached buffer issues
    this._totalPushed += data.length;
    this._processPushQueue();
  }

  _processPushQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating || this._pushQueue.length === 0) {
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
        console.error('[MediaPlayer] appendBuffer error:', e);
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
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      try {
        const buffered = this.sourceBuffer.buffered;
        if (buffered.length > 0) {
          this.sourceBuffer.remove(0, buffered.end(buffered.length - 1));
        }
      } catch {/* ignore */}
    }
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
   */
  setVideoRectangles(srcRect, destRect) {
    // Position the <video> element to match destRect
    this.video.style.position = 'absolute';
    this.video.style.left = `${destRect.x}px`;
    this.video.style.top = `${destRect.y}px`;
    this.video.style.width = `${destRect.width}px`;
    this.video.style.height = `${destRect.height}px`;
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
