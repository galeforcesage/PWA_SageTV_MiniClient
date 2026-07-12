/**
 * AVPlayPlayer — Tizen TV media player backed by webapis.avplay.
 *
 * This is the Samsung-TV counterpart to MediaPlayer (which uses <video>/MSE).
 * The Tizen WebView's <video> element cannot demux MPEG2-TS/PS or decode MPEG-2
 * (Chromium ships no MPEG-2 decoder), but the TV's hardware decoders are reachable
 * through webapis.avplay — the native player (the ExoPlayer analog for "emulate
 * Android playback"). AVPlay demuxes TS/PS/MP4 and hardware-decodes MPEG-2 / H.264
 * / HEVC / AC-3 / E-AC-3 / AC-4 / AAC, so most SageTV content is DIRECT_PLAY with
 * zero transcode — identical against 9.2.16 and NG servers (AVPlay is a client
 * capability, not a server feature).
 *
 * Drop-in contract: exposes the same methods the connection + session layers call
 * on MediaPlayer (load/play/pause/stop/seek/flush/frameStep/pushData/
 * getMediaTimeMillis/getState/getVideoDimensions/getBufferLeft/getVolume/setVolume/
 * setMute/setServerEOS/setAudioTrack/setSubtitleTrack/setVideoRectangles) and
 * dispatches the same lifecycle events (firstframe/buffering/playing/eos) plus
 * capabilityupdate/playbackfailure.
 *
 * COMPOSITING: AVPlay renders on a hardware video plane BEHIND the web/graphics
 * layer. The WebGL renderer already punches a transparent hole at the server's
 * video rectangle (setVideoBounds); we mirror that rect into avplay.setDisplayRect
 * and keep the page background transparent so the plane shows through, with the
 * SageTV UI composited on top.
 */

import { PlayerState } from '../protocol/constants.js';

export class AVPlayPlayer extends EventTarget {
  /**
   * @param {HTMLElement} videoElement - unused (AVPlay owns its own surface); kept
   *   for signature parity with MediaPlayer.
   * @param {HTMLElement} container - element hosting the <object> avplayer surface.
   * @param {object} options
   */
  constructor(videoElement, container, options = {}) {
    super();
    this.container = container || document.body;
    this.platformDetector = options.platformDetector || null;

    this.state = PlayerState.NO_STATE;
    this.serverEOS = false;

    this._bridgeBase = '';
    this._avplay = (window.webapis && window.webapis.avplay) || null;
    this._obj = null;               // <object type="application/avplayer">
    this._positionMs = 0;
    this._durationMs = 0;
    this._videoDimensions = { width: 0, height: 0 };
    this._firstFrameEmitted = false;
    this._userMuted = false;
    this._volume = 1;
    this._telemetrySequence = 0;
    this._reportedFailureKeys = new Set();

    // Server UI coordinate space (advertised UI resolution). setVideoRectangles
    // rects are in this space; we scale to physical display pixels for AVPlay.
    this._displayW = (window.screen && window.screen.width) || 1920;
    this._displayH = (window.screen && window.screen.height) || 1080;
    this._lastDestRect = null;

    // Prior background values to restore on stop (compositing hole-punch).
    this._prevHtmlBg = '';
    this._prevBodyBg = '';
  }

  // ── Setup ────────────────────────────────────────────────

  setBridgeBase(base) {
    if (typeof base !== 'string') { this._bridgeBase = ''; return; }
    this._bridgeBase = base.replace(/\/$/, '');
  }

  _ensureObject() {
    if (this._obj && document.getElementById('av-player') === this._obj) return this._obj;
    let obj = document.getElementById('av-player');
    if (!obj) {
      obj = document.createElement('object');
      obj.id = 'av-player';
      obj.type = 'application/avplayer';
      // Full-frame surface; the hardware plane sits behind the page (z-index:0).
      obj.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:0;';
      this.container.insertBefore(obj, this.container.firstChild);
    }
    this._obj = obj;
    return obj;
  }

  /** Make the web/graphics layer transparent so the hardware video plane shows. */
  _enableVideoPlane() {
    try {
      this._prevHtmlBg = document.documentElement.style.background;
      this._prevBodyBg = document.body.style.background;
      document.documentElement.style.background = 'transparent';
      document.body.style.background = 'transparent';
    } catch { /* best effort */ }
  }

  _disableVideoPlane() {
    try {
      document.documentElement.style.background = this._prevHtmlBg;
      document.body.style.background = this._prevBodyBg;
    } catch { /* best effort */ }
  }

  // ── URL resolution (mirrors MediaPlayer._loadPullMode) ───

  _rawMediaUrl(absPath) {
    const base = (this._bridgeBase || '').replace(/\/$/, '');
    return `${base}/rawmedia?path=${encodeURIComponent(absPath)}`;
  }

  _resolveMediaUrl(url, bridgeFilePath) {
    // Server chose a bridge/transcode surface for this source.
    if (bridgeFilePath) {
      const base = (this._bridgeBase || '').replace(/\/$/, '');
      return `${base}/transcode?file=${encodeURIComponent(bridgeFilePath)}`;
    }
    if (!url) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('file://')) {
      const p = url.substring(7);
      return this._rawMediaUrl(p.startsWith('/') ? p : '/' + p);
    }
    if (url.startsWith('stv://')) {
      const rest = url.substring(6);
      const slash = rest.indexOf('/');
      const p = slash >= 0 ? rest.substring(slash) : '/';
      return this._rawMediaUrl(p.replace(/^\/+/, '/'));
    }
    if (url.startsWith('/')) return this._rawMediaUrl(url);
    return url;
  }

  // ── Load / transport ─────────────────────────────────────

  async load(majorHint, minorHint, encodingHint, url, hostname, timeshifted, bufferSize, bridgeFilePath) {
    this.stop();
    // Token for THIS load. stop()/a newer load() bump _loadSeq, so the async
    // prepareAsync callbacks below are ignored if playback was already exited
    // (otherwise a late "prepared" would set state=PLAY and strand the menu
    // input in playback context — Right→FF, OK→pause instead of nav/select).
    const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
    this.serverEOS = false;
    this._firstFrameEmitted = false;
    this._positionMs = 0;

    if (!this._avplay) {
      this._emitPlaybackFailure('AVPLAY_UNAVAILABLE', { mode: 'avplay' });
      this.state = PlayerState.STOPPED;
      return;
    }

    const mediaUrl = this._resolveMediaUrl(url, bridgeFilePath);
    console.log(`[AVPlay] load: ${mediaUrl}`);

    const obj = this._ensureObject();
    obj.style.display = 'block';
    this._enableVideoPlane();
    this.dispatchEvent(new CustomEvent('buffering'));

    try {
      this._avplay.open(mediaUrl);
      this._applyDisplayRect();
      try { this._avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch { /* ignore */ }
      this._installListener();
      this.state = PlayerState.LOADED;
      this._avplay.prepareAsync(
        () => {
          // Ignore if a stop()/newer load() happened while preparing — otherwise
          // we'd resume a video the user already exited and strand the menu.
          if (seq !== this._loadSeq) return;
          try { this._durationMs = this._avplay.getDuration() || 0; } catch { /* ignore */ }
          this._captureStreamInfo();
          try {
            this._avplay.play();
            this.state = PlayerState.PLAY;
          } catch (e) {
            this._emitPlaybackFailure('AVPLAY_PLAY_ERROR', { mode: 'avplay', message: e && e.message });
          }
        },
        (e) => {
          if (seq !== this._loadSeq) return;
          console.error('[AVPlay] prepareAsync failed:', e);
          this._emitPlaybackFailure('AVPLAY_PREPARE_ERROR', { mode: 'avplay', message: JSON.stringify(e) });
          this.state = PlayerState.STOPPED;
        }
      );
    } catch (e) {
      console.error('[AVPlay] open/prepare threw:', e);
      this._emitPlaybackFailure('AVPLAY_OPEN_ERROR', { mode: 'avplay', message: e && e.message });
      this.state = PlayerState.STOPPED;
    }
  }

  // Option B parity: bridge transcodes a MediaFile id to fMP4/TS AVPlay can open.
  async loadBridgeMfid(mfid, hostname, seekSec = 0) {
    const base = (this._bridgeBase || '').replace(/\/$/, '');
    const url = `${base}/transcode?mfid=${encodeURIComponent(mfid)}${seekSec ? `&seek=${seekSec}` : ''}`;
    return this.load(0, 0, '', url, hostname, false, 0, null);
  }

  /**
   * MSPROXY mode (server-authoritative, NG): play through the bridge's /msproxy
   * thin proxy over MediaServer :7818. AVPlay natively demuxes raw TS/PS
   * (direct/remux) and plays server fMP4 (xcode) — it just needs the HTTP URL.
   * @param {string} absPath  absolute media path on the server
   * @param {string} mode     /msproxy mode token (direct | remux:ts | xcode:<q>)
   * @param {string} hostname SageTV host
   * @param {number} [seekSec=0]
   */
  async loadMsProxy(absPath, mode, hostname, seekSec = 0) {
    const base = (this._bridgeBase || '').replace(/\/$/, '');
    const url = `${base}/msproxy?path=${encodeURIComponent(absPath)}&mode=${encodeURIComponent(mode)}${seekSec ? `&seek=${seekSec}` : ''}`;
    console.log(`[AVPlay] loadMsProxy mode=${mode}: ${url}`);
    return this.load(0, 0, '', url, hostname, false, 0, null);
  }

  _installListener() {
    const av = this._avplay;
    av.setListener({
      onbufferingstart: () => this.dispatchEvent(new CustomEvent('buffering')),
      onbufferingprogress: () => {},
      onbufferingcomplete: () => {
        this._emitFirstFrameOnce();
        this.dispatchEvent(new CustomEvent('playing'));
      },
      oncurrentplaytime: (ms) => {
        this._positionMs = ms | 0;
        this._emitFirstFrameOnce();
      },
      onstreamcompleted: () => {
        this.state = PlayerState.EOS;
        this.dispatchEvent(new CustomEvent('eos'));
      },
      onevent: (type, data) => {
        if (type === 'PLAYER_MSG_RESOLUTION_CHANGED' || type === 'PLAYER_MSG_HD_VIDEO') {
          this._captureStreamInfo();
        }
        void data;
      },
      onerror: (e) => {
        console.error('[AVPlay] error:', e);
        this._emitPlaybackFailure('AVPLAY_RUNTIME_ERROR', { mode: 'avplay', code: String(e) });
      },
    });
  }

  _emitFirstFrameOnce() {
    if (this._firstFrameEmitted) return;
    this._firstFrameEmitted = true;
    this.dispatchEvent(new CustomEvent('firstframe'));
  }

  _captureStreamInfo() {
    try {
      const info = this._avplay.getCurrentStreamInfo();
      for (const s of info || []) {
        if (s.type === 'VIDEO') {
          const extra = JSON.parse(s.extra_info || '{}');
          const w = parseInt(extra.Width, 10);
          const h = parseInt(extra.Height, 10);
          if (w && h) this._videoDimensions = { width: w, height: h };
        }
      }
    } catch { /* stream info not ready */ }
  }

  play() {
    if (!this._avplay) return;
    try {
      if (this.state === PlayerState.PAUSE) this._avplay.play();
      else this._avplay.play();
      this.state = PlayerState.PLAY;
    } catch (e) { console.warn('[AVPlay] play:', e && e.message); }
  }

  pause() {
    if (!this._avplay) return;
    try { this._avplay.pause(); this.state = PlayerState.PAUSE; }
    catch (e) { console.warn('[AVPlay] pause:', e && e.message); }
  }

  stop() {
    // Invalidate any in-flight prepareAsync callback from a prior load() so a
    // late "prepared" success can't flip state back to PLAY after we've stopped.
    this._loadSeq = (this._loadSeq || 0) + 1;
    if (this._avplay) {
      try { this._avplay.stop(); } catch { /* ignore */ }
      try { this._avplay.close(); } catch { /* ignore */ }
    }
    // Remove the hardware video plane entirely (not just display:none) so the
    // last decoded frame can't linger as remnants in any letterbox/pillarbox
    // region after playback exits. Recreated on the next load().
    const obj = document.getElementById('av-player');
    if (obj) obj.remove();
    this._obj = null;
    if (this.state !== PlayerState.NO_STATE) this._disableVideoPlane();
    this.state = PlayerState.STOPPED;
    this._firstFrameEmitted = false;
  }

  /** @param {number} timeMS absolute position in milliseconds. */
  seek(timeMS) {
    if (!this._avplay) return;
    const ms = Math.max(0, timeMS | 0);
    this.dispatchEvent(new CustomEvent('buffering'));
    try {
      this._avplay.seekTo(
        ms,
        () => { this._positionMs = ms; },
        (e) => console.warn('[AVPlay] seek failed:', e)
      );
    } catch (e) {
      // Older AVPlay: seekTo(ms) without callbacks.
      try { this._avplay.seekTo(ms); this._positionMs = ms; }
      catch (e2) { console.warn('[AVPlay] seekTo threw:', e2 && e2.message); }
      void e;
    }
  }

  flush() {
    // AVPlay manages its own pipeline across seeks; nothing to flush client-side.
  }

  frameStep() {
    if (!this._avplay) return;
    try { this._avplay.jumpForward(1000); } catch { /* not supported */ }
  }

  // Push retired for the PWA — AVPlay is pull-only. Discard defensively.
  pushData() {
    if (!this._pushWarned) {
      this._pushWarned = true;
      console.warn('[AVPlay] Ignoring pushed media data — AVPlay is pull-only.');
    }
  }

  setServerEOS() { this.serverEOS = true; }

  // ── Getters / audio ──────────────────────────────────────

  getMediaTimeMillis() {
    if (this.state === PlayerState.NO_STATE || this.state === PlayerState.STOPPED) return 0;
    if (this._avplay) {
      try { return this._avplay.getCurrentTime() | 0; } catch { /* fall through */ }
    }
    return this._positionMs;
  }

  getState() { return this.state; }

  getVideoDimensions() { return this._videoDimensions; }

  getBufferLeft() { return 0x7fffffff; } // pull mode: server-limited, effectively unbounded

  // Parity stubs for the Placeshifter status HUD (hidden on Tizen anyway).
  // AVPlay doesn't surface a per-second transfer rate the way MSE fetch does.
  get bandwidthKbps() { return 0; }
  getBufferTime() { return 0; }

  getVolume() { return Math.floor(this._volume * 65535); }

  // IMPORTANT: does NOT touch the TV's system volume. On a TV the remote owns
  // system volume; hijacking it (e.g. tizen.tvaudiocontrol) blasts the user's
  // ears to whatever value SageTV last stored. AVPlay has no per-stream gain,
  // so the SageTV volume slider is a no-op here — we only track the value so
  // getVolume() stays consistent.
  setVolume(normalized) {
    this._volume = Math.max(0, Math.min(1, normalized));
  }

  setMute(muted) {
    // Tracked only — no system-mute hijack (the remote mutes the TV).
    this._userMuted = !!muted;
  }

  setAudioTrack(index) {
    if (!this._avplay) return;
    try { this._avplay.setSelectTrack('AUDIO', index); }
    catch (e) { console.warn('[AVPlay] setAudioTrack:', e && e.message); }
  }

  setSubtitleTrack(index) {
    if (!this._avplay) return;
    try { this._avplay.setSelectTrack('TEXT', index); }
    catch (e) { console.warn('[AVPlay] setSubtitleTrack:', e && e.message); }
  }

  // ── Video rectangle / compositing ────────────────────────

  setVideoRectangles(srcRect, destRect) {
    this._lastDestRect = destRect;
    this._applyDisplayRect();
  }

  _applyDisplayRect() {
    if (!this._avplay) return;
    const dest = this._lastDestRect;
    // AVPlay.setDisplayRect uses the web VIEWPORT coordinate space (CSS px),
    // NOT screen.width. Using the viewport makes the video truly fill the app
    // window (fullscreen) when no sub-rect is given.
    const vw = window.innerWidth || document.documentElement.clientWidth || 1920;
    const vh = window.innerHeight || document.documentElement.clientHeight || 1080;
    // The server's video rect is in UI/render coords (canvas backing size);
    // scale it into viewport CSS pixels.
    const canvas = this.container.querySelector && this.container.querySelector('canvas');
    const uiW = (canvas && canvas.width) || vw;
    const uiH = (canvas && canvas.height) || vh;
    const sx = vw / uiW;
    const sy = vh / uiH;
    let x = 0, y = 0, w = vw, h = vh;
    if (dest) {
      x = Math.round(dest.x * sx);
      y = Math.round(dest.y * sy);
      w = Math.round(dest.width * sx);
      h = Math.round(dest.height * sy);
    }
    try { this._avplay.setDisplayRect(x, y, w, h); }
    catch (e) { console.warn('[AVPlay] setDisplayRect:', e && e.message); }
  }

  // ── Telemetry (parity with MediaPlayer) ──────────────────

  _emitPlaybackFailure(reason, details = {}) {
    const key = `${reason}|${details.mode || ''}|${details.code || ''}`;
    if (this._reportedFailureKeys.has(key)) return;
    this._reportedFailureKeys.add(key);
    this.dispatchEvent(new CustomEvent('playbackfailure', {
      detail: { reason, sequence: ++this._telemetrySequence, timestamp: Date.now(), ...details },
    }));
  }

  free() {
    this.stop();
    const obj = document.getElementById('av-player');
    if (obj) obj.remove();
    this._obj = null;
  }
}
