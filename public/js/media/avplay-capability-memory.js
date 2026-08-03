/**
 * AVPlay capability memory — passive, on-device "burn test" for Tizen.
 *
 * WHY: the Tizen native surface (pwa_native) is advertised from the curated
 * Profile-4 whitelist in tizen-capabilities.js (because <video>.canPlayType and
 * mediaCapabilities.decodingInfo reflect the browser HTML5 pipeline, NOT the
 * AVPlay hardware decoders). That whitelist is a curated ASSUMPTION about what
 * every 2023-2026 Samsung panel decodes. It is right the vast majority of the
 * time, but it is not PROOF for the specific panel + firmware in the room.
 *
 * This module turns real playbacks into that proof, passively and for free:
 *   - AVPlay reaching first frame on a native DIRECT_PLAY attempt PROVES the
 *     device decodes that video codec  -> record it proven-good (immunised).
 *   - AVPlay rejecting the stream at open/prepare (an explicit error, not a
 *     hang) is EVIDENCE the advertised native codec is wrong -> after a small
 *     number of failures with no success, record it proven-bad and stop
 *     advertising it, so the server transcodes/remuxes it instead.
 *
 * SCOPE — deliberately conservative to be safe:
 *   1. VIDEO codec dimension only. A single failed combo (container+video+audio)
 *      cannot be attributed to one dimension, and wrongly blacklisting a
 *      container (MP4) or audio codec (AAC) would break ALL playback. The video
 *      codec is both the most likely real capability gap AND the exact thing the
 *      server's decision engine over-advertises (HEVC / MPEG2-VIDEO / AV1), so
 *      learning just the video dimension targets the real risk with zero chance
 *      of killing MP4/AAC. Audio/container learning is a future step.
 *   2. Only DIRECT_PLAY (native, server-unconditioned) attempts feed learning.
 *      Server-conditioned remux/xcode outcomes describe the transcode pipeline,
 *      not the native decoder, so they are excluded by the caller.
 *   3. A codec is blacklisted only after FAIL_THRESHOLD (default 2) confirmed
 *      decode/demux errors with ZERO successes. Any success clears the fail
 *      counter and permanently immunises the codec. This prevents a one-off
 *      transient (a bad file, a transport hiccup) from poisoning the caps.
 *
 * A pure logic module: storage and the device signature are injectable so it is
 * unit-testable under Node with no DOM. The default singleton (getAvplayCap...)
 * binds window.localStorage + webapis.productinfo.
 */

const STORAGE_KEY = 'avplay_cap_memory_v1';
const DEFAULT_FAIL_THRESHOLD = 2;

/**
 * ng_fmt video MIME (see connection.js _parseNgFmt + player.js _ngFmtToMseCodecs)
 * -> Protocol 2.1 canonical capability name used in the pwa_native surface
 * arrays (H264, HEVC, MPEG2-VIDEO, ...). Anything not mapped returns null and is
 * simply not learned (fail-safe: never blacklist a dimension we can't name).
 */
const VIDEO_MIME_TO_CAP = {
  'video/hevc': 'HEVC',
  'video/h265': 'HEVC',
  'video/avc': 'H264',
  'video/h264': 'H264',
  'video/mpeg2': 'MPEG2-VIDEO',
  'video/mp2v': 'MPEG2-VIDEO',
  'video/mp4v-es': 'MPEG4-VIDEO',
  'video/mp4v': 'MPEG4-VIDEO',
  'video/vp9': 'VP9',
  'video/x-vp9': 'VP9',
  'video/av01': 'AV1',
  'video/av1': 'AV1',
};

/** Reasons that constitute a real native decode/demux rejection (not a hang). */
const CODEC_FAILURE_REASONS = new Set([
  'AVPLAY_PREPARE_ERROR',
  'AVPLAY_OPEN_ERROR',
]);

/**
 * Map an ng_fmt video MIME string to a canonical capability name.
 * @param {string|null|undefined} mime
 * @returns {string|null}
 */
export function videoMimeToCapName(mime) {
  if (!mime) return null;
  const key = String(mime).trim().toLowerCase();
  return VIDEO_MIME_TO_CAP[key] || null;
}

/** @returns {boolean} whether `reason` is a real codec-level failure. */
export function isCodecFailureReason(reason) {
  return CODEC_FAILURE_REASONS.has(String(reason || ''));
}

/**
 * @typedef {object} MemoryState
 * @property {string} sig     device signature this state was learned on
 * @property {Object<string, number>} fails  video capName -> consecutive fails
 * @property {string[]} good  video capNames proven good (immunised)
 * @property {string[]} bad   video capNames proven bad (blacklisted)
 */

export class AvplayCapabilityMemory {
  /**
   * @param {object} [opts]
   * @param {Storage}  [opts.storage]  localStorage-like { getItem, setItem }
   * @param {string}   [opts.deviceSig] stable per-device signature
   * @param {number}   [opts.failThreshold]
   */
  constructor(opts = {}) {
    this._storage = opts.storage || null;
    this._sig = opts.deviceSig || 'unknown';
    this._failThreshold = opts.failThreshold || DEFAULT_FAIL_THRESHOLD;
    /** @type {MemoryState} */
    this._state = this._load();
  }

  _blankState() {
    return { sig: this._sig, fails: {}, good: [], bad: [] };
  }

  _load() {
    const blank = this._blankState();
    if (!this._storage) return blank;
    try {
      const raw = this._storage.getItem(STORAGE_KEY);
      if (!raw) return blank;
      const parsed = JSON.parse(raw);
      // Reset when the panel/firmware changed: prior proof no longer applies.
      if (!parsed || parsed.sig !== this._sig) return blank;
      return {
        sig: this._sig,
        fails: (parsed.fails && typeof parsed.fails === 'object') ? parsed.fails : {},
        good: Array.isArray(parsed.good) ? parsed.good.slice() : [],
        bad: Array.isArray(parsed.bad) ? parsed.bad.slice() : [],
      };
    } catch {
      return blank;
    }
  }

  _persist() {
    if (!this._storage) return;
    try {
      this._storage.setItem(STORAGE_KEY, JSON.stringify(this._state));
    } catch {
      /* storage full / unavailable — memory still works for this session */
    }
  }

  /**
   * Record that a native DIRECT_PLAY attempt reached first frame. Proves the
   * device decodes this video codec: immunise it (clear fails, drop any prior
   * blacklist entry, mark proven-good).
   * @param {{video?: string|null}|null} hint  ng_fmt hint (MIME strings)
   * @returns {boolean} true if state changed
   */
  recordSuccess(hint) {
    const cap = videoMimeToCapName(hint && hint.video);
    if (!cap) return false;
    let changed = false;
    if (this._state.fails[cap]) { delete this._state.fails[cap]; changed = true; }
    if (this._state.bad.includes(cap)) {
      this._state.bad = this._state.bad.filter((c) => c !== cap);
      changed = true;
    }
    if (!this._state.good.includes(cap)) { this._state.good.push(cap); changed = true; }
    if (changed) {
      console.log(`[AVCapMemory] proven-good video codec: ${cap} (device ${this._sig})`);
      this._persist();
    }
    return changed;
  }

  /**
   * Record a native DIRECT_PLAY decode/demux failure. Ignored unless the reason
   * is a real codec rejection and the codec has never succeeded. Blacklists the
   * codec once it reaches the fail threshold.
   * @param {{video?: string|null}|null} hint
   * @param {string} reason  AVPLAY_* failure reason
   * @returns {boolean} true if the codec became newly blacklisted
   */
  recordFailure(hint, reason) {
    if (!isCodecFailureReason(reason)) return false;
    const cap = videoMimeToCapName(hint && hint.video);
    if (!cap) return false;
    // A codec proven good on this device is immune — never blacklist it.
    if (this._state.good.includes(cap)) return false;
    if (this._state.bad.includes(cap)) return false;

    this._state.fails[cap] = (this._state.fails[cap] || 0) + 1;
    let blacklisted = false;
    if (this._state.fails[cap] >= this._failThreshold) {
      this._state.bad.push(cap);
      blacklisted = true;
      console.warn(`[AVCapMemory] video codec ${cap} failed ${this._state.fails[cap]}x`
        + ` (reason=${reason}) — removing from native surface (device ${this._sig})`);
    } else {
      console.warn(`[AVCapMemory] video codec ${cap} native failure ${this._state.fails[cap]}/`
        + `${this._failThreshold} (reason=${reason})`);
    }
    this._persist();
    return blacklisted;
  }

  /**
   * Video capability names proven bad on this device. The caller subtracts
   * these from the pwa_native video list.
   * @returns {string[]}
   */
  getProvenBadVideo() {
    return this._state.bad.slice();
  }

  /**
   * Proven-bad capabilities per surface dimension. Only `video` is learned in
   * this MVP; audio/containers are always empty (reserved for a future step) so
   * the caller's subtraction is uniform and forward-compatible.
   * @returns {{video: string[], audio: string[], containers: string[]}}
   */
  getProvenBadNativeCaps() {
    return { video: this._state.bad.slice(), audio: [], containers: [] };
  }

  /** Wipe all learned state (manual reset / diagnostics). */
  reset() {
    this._state = this._blankState();
    this._persist();
  }
}

/**
 * Best-effort stable device signature for a Tizen panel: model + firmware, so a
 * firmware upgrade (which can change decoder support) re-learns from scratch.
 * Falls back to a UA-derived tag, then 'unknown'.
 * @returns {string}
 */
export function computeTizenDeviceSignature() {
  try {
    const pi = (typeof window !== 'undefined' && window.webapis && window.webapis.productinfo) || null;
    if (pi) {
      const model = (pi.getRealModel && pi.getRealModel()) || (pi.getModel && pi.getModel()) || '';
      const fw = (pi.getFirmware && pi.getFirmware()) || (pi.getVersion && pi.getVersion()) || '';
      const sig = `${model}|${fw}`.trim();
      if (sig && sig !== '|') return sig;
    }
  } catch {
    /* productinfo not available (not a real TV) — fall through */
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      return 'ua:' + navigator.userAgent.replace(/\s+/g, '').slice(0, 64);
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

let _singleton = null;

/**
 * Default singleton bound to window.localStorage + the Tizen device signature.
 * Safe to call anywhere; returns the same instance.
 * @returns {AvplayCapabilityMemory}
 */
export function getAvplayCapabilityMemory() {
  if (_singleton) return _singleton;
  const storage = (typeof window !== 'undefined' && window.localStorage) || null;
  _singleton = new AvplayCapabilityMemory({
    storage,
    deviceSig: computeTizenDeviceSignature(),
  });
  return _singleton;
}
