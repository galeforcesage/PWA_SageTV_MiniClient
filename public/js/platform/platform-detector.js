/**
 * Platform detection and capability collection.
 *
 * Keeps runtime checks in one place so the rest of the app can stay platform-agnostic.
 */

export class PlatformDetector {
  constructor() {
    this._initialized = false;
    this._isTizen = false;
    this._remoteProfile = 'unknown';
    this._remoteKeys = new Set();
    this._capabilities = null;
  }

  async init() {
    if (this._initialized) {
      return this._capabilities;
    }

    this._isTizen = typeof window !== 'undefined' && typeof window.tizen !== 'undefined';
    if (this._isTizen) {
      this._collectTizenRemoteKeys();
    }

    this._capabilities = this._buildCapabilities();
    this._initialized = true;
    return this._capabilities;
  }

  isTizen() {
    return this._isTizen;
  }

  getCapabilities() {
    if (!this._initialized) {
      return this._buildCapabilities();
    }
    return this._capabilities;
  }

  getNgDownloadCapabilities() {
    // Tizen MVP explicitly does not expose local/offline download support.
    if (this._isTizen) {
      return [];
    }

    return [
      'DOWNLOAD',
      'OFFLINE_DOWNLOAD',
      'DOWNLOAD_REFRESH',
      'OFFLINE_METADATA',
      'OFFLINE_ARTWORK',
      'OFFLINE_CAPTIONS',
      'OFFLINE_COMSKIP',
      'OFFLINE_TRANSCRIPT',
      'OFFLINE_GUIDE',
      'GUIDE_SNAPSHOT',
      'OFFLINE_SCHEDULED',
      'SCHEDULED_SNAPSHOT',
      'OFFLINE_FAVORITES',
      'FAVORITES_SNAPSHOT',
    ];
  }

  _collectTizenRemoteKeys() {
    try {
      const api = window.tizen?.tvinputdevice;
      if (!api || typeof api.getSupportedKeys !== 'function') {
        this._remoteProfile = 'unknown';
        return;
      }

      const supported = api.getSupportedKeys() || [];
      for (const entry of supported) {
        const keyName = String(entry?.name || '').trim();
        if (keyName) {
          this._remoteKeys.add(keyName);
        }
      }
    } catch (err) {
      console.warn('[PlatformDetector] Tizen remote key detection failed:', err);
    }

    const hasNumeric = this._hasAny(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    const hasMedia = this._hasAny(['MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'MediaPlayPause']);
    const hasColor = this._hasAny(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']);

    if (hasNumeric || hasMedia || hasColor) {
      this._remoteProfile = 'full';
    } else if (this._remoteKeys.size > 0) {
      this._remoteProfile = 'minimal';
    } else {
      this._remoteProfile = 'unknown';
    }
  }

  _hasAny(names) {
    for (const name of names) {
      if (this._remoteKeys.has(name)) {
        return true;
      }
    }
    return false;
  }

  _buildCapabilities() {
    const video = document.createElement('video');
    const canPlay = (mime) => {
      try {
        const rv = video.canPlayType?.(mime) || '';
        return rv === 'probably' || rv === 'maybe';
      } catch {
        return false;
      }
    };

    const width = window.screen?.width || window.innerWidth || 0;
    const height = window.screen?.height || window.innerHeight || 0;
    const dpr = Number(window.devicePixelRatio || 1);

    let model = '';
    let osVersion = '';
    if (this._isTizen) {
      try {
        model = String(window.tizen?.systeminfo?.getCapability?.('http://tizen.org/system/model_name') || '');
      } catch {
        model = '';
      }
      try {
        osVersion = String(window.tizen?.systeminfo?.getCapability?.('http://tizen.org/feature/platform.version') || '');
      } catch {
        osVersion = '';
      }
    }

    const hasNumeric = this._isTizen ? this._hasAny(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) : true;
    const hasMediaKeys = this._isTizen ? this._hasAny(['MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'MediaPlayPause']) : true;
    const hasColorKeys = this._isTizen ? this._hasAny(['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']) : false;

    return {
      clientId: localStorage.getItem('sagetv_mac') || '',
      platform: this._isTizen ? 'tizen' : 'browser',
      display: {
        width,
        height,
        dpr,
      },
      input: {
        remoteProfile: this._isTizen ? this._remoteProfile : 'browser',
        hasArrows: true,
        hasEnter: true,
        hasBack: true,
        hasMediaKeys,
        hasColorKeys,
        hasNumericKeys: hasNumeric,
      },
      playbackHints: {
        canPlayMP4: canPlay('video/mp4; codecs="avc1.42E01E"'),
        canPlayHLS: canPlay('application/vnd.apple.mpegURL') || canPlay('application/x-mpegURL'),
        canPlayHEVC: canPlay('video/mp4; codecs="hvc1"') || canPlay('video/mp4; codecs="hev1"') || 'unknown',
      },
      device: {
        model,
        osVersion,
      },
      network: {
        online: navigator.onLine !== false,
        measuredLatencyMs: Number.isFinite(navigator.connection?.rtt) ? navigator.connection.rtt : null,
      },
    };
  }
}
