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
 *   1. Learns all three surface dimensions (video codec, audio codec, container)
 *      but attributes a failure to at most ONE of them, and only when that
 *      attribution is UNAMBIGUOUS:
 *        - VIDEO is the primary suspect (the most likely real capability gap and
 *          the exact thing the server's decision engine over-advertises). While
 *          the video codec is not yet proven-good on this device, a failure is
 *          blamed on video.
 *        - Once the video codec IS proven-good, the failure must be the audio
 *          codec or the container. It is attributed ONLY when exactly one of
 *          those two is still unproven (the other being proven-good), so we never
 *          guess between two unknowns and never risk blacklisting MP4/AAC while
 *          the real fault is elsewhere.
 *      A success immunises every mappable dimension of the played combo at once.
 *   2. Only DIRECT_PLAY (native, server-unconditioned) attempts feed learning.
 *      Server-conditioned remux/xcode outcomes describe the transcode pipeline,
 *      not the native decoder, so they are excluded by the caller.
 *   3. A dimension value is blacklisted only after FAIL_THRESHOLD (default 2)
 *      confirmed decode/demux errors with ZERO successes. Any success clears the
 *      fail counter and permanently immunises the value. This prevents a one-off
 *      transient (a bad file, a transport hiccup) from poisoning the caps.
 *
 * A pure logic module: storage and the device signature are injectable so it is
 * unit-testable under Node with no DOM. The default singleton (getAvplayCap...)
 * binds window.localStorage + webapis.productinfo.
 */

const STORAGE_KEY = 'avplay_cap_memory_v2';
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

/**
 * ng_fmt audio MIME -> Protocol 2.1 canonical native audio capability name
 * (see tizen-capabilities.js Profile-4 audio list + player.js _ngFmtToMseCodecs
 * audioMap, which is the authoritative set of tokens the server emits). Only
 * confidently-named codecs are listed; anything else returns null and is never
 * learned (fail-safe: we never blacklist an audio dimension we can't name).
 */
const AUDIO_MIME_TO_CAP = {
  'audio/mp4a-latm': 'AAC',
  'audio/aac': 'AAC',
  'audio/ac3': 'AC3',
  'audio/eac3': 'EAC3',
  'audio/ac4': 'AC4',
  'audio/mpeg': 'MP3',
  'audio/mpeg-l2': 'MP2',
  'audio/flac': 'FLAC',
  'audio/opus': 'OPUS',
  'audio/vorbis': 'VORBIS',
  'audio/alac': 'ALAC',
};

/**
 * ng_fmt container MIME -> Protocol 2.1 canonical container capability name.
 * Deliberately conservative: ambiguous tokens (e.g. bare "video/mpeg", which
 * could be program- or transport-stream) are intentionally omitted so they map
 * to null and are never learned — mis-blacklisting a container would break every
 * title in it.
 */
const CONTAINER_MIME_TO_CAP = {
  'video/mp4': 'MP4',
  'video/mp2t': 'MPEG2-TS',
  'video/x-matroska': 'MATROSKA',
  'video/quicktime': 'MOV',
  'video/x-msvideo': 'AVI',
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

/**
 * Map an ng_fmt audio MIME string to a canonical capability name.
 * @param {string|null|undefined} mime
 * @returns {string|null}
 */
export function audioMimeToCapName(mime) {
  if (!mime) return null;
  const key = String(mime).trim().toLowerCase();
  return AUDIO_MIME_TO_CAP[key] || null;
}

/**
 * Map an ng_fmt container MIME string to a canonical capability name.
 * @param {string|null|undefined} mime
 * @returns {string|null}
 */
export function containerMimeToCapName(mime) {
  if (!mime) return null;
  const key = String(mime).trim().toLowerCase();
  return CONTAINER_MIME_TO_CAP[key] || null;
}

/** @returns {boolean} whether `reason` is a real codec-level failure. */
export function isCodecFailureReason(reason) {
  return CODEC_FAILURE_REASONS.has(String(reason || ''));
}

/**
 * @typedef {object} DimState
 * @property {Object<string, number>} fails  capName -> consecutive fails
 * @property {string[]} good  capNames proven good (immunised)
 * @property {string[]} bad   capNames proven bad (blacklisted)
 */

/**
 * @typedef {object} MemoryState
 * @property {string} sig     device signature this state was learned on
 * @property {DimState} video
 * @property {DimState} audio
 * @property {DimState} containers
 */

/** Surface dimensions learned, in attribution-priority order. */
const DIMS = ['video', 'audio', 'containers'];

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

  _blankDim() {
    return { fails: {}, good: [], bad: [] };
  }

  _blankState() {
    return { sig: this._sig, video: this._blankDim(), audio: this._blankDim(), containers: this._blankDim() };
  }

  _sanitizeDim(d) {
    const blank = this._blankDim();
    if (!d || typeof d !== 'object') return blank;
    return {
      fails: (d.fails && typeof d.fails === 'object') ? d.fails : {},
      good: Array.isArray(d.good) ? d.good.slice() : [],
      bad: Array.isArray(d.bad) ? d.bad.slice() : [],
    };
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
        video: this._sanitizeDim(parsed.video),
        audio: this._sanitizeDim(parsed.audio),
        containers: this._sanitizeDim(parsed.containers),
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

  /** @returns {{video: string|null, audio: string|null, containers: string|null}} */
  _capsForHint(hint) {
    return {
      video: videoMimeToCapName(hint && hint.video),
      audio: audioMimeToCapName(hint && hint.audio),
      containers: containerMimeToCapName(hint && hint.container),
    };
  }

  _isGood(dim, cap) {
    return !!cap && this._state[dim].good.includes(cap);
  }

  /** Immunise one dimension value: clear fails, drop blacklist, mark good. */
  _immunise(dim, cap) {
    if (!cap) return false;
    const d = this._state[dim];
    let changed = false;
    if (d.fails[cap]) { delete d.fails[cap]; changed = true; }
    if (d.bad.includes(cap)) { d.bad = d.bad.filter((c) => c !== cap); changed = true; }
    if (!d.good.includes(cap)) { d.good.push(cap); changed = true; }
    return changed;
  }

  /**
   * Increment a dimension value's fail counter and blacklist it at threshold.
   * Assumes the caller already decided this dim is the unambiguous culprit.
   * @returns {boolean} true if newly blacklisted
   */
  _failDim(dim, cap, reason) {
    const d = this._state[dim];
    if (d.good.includes(cap) || d.bad.includes(cap)) return false;
    d.fails[cap] = (d.fails[cap] || 0) + 1;
    if (d.fails[cap] >= this._failThreshold) {
      d.bad.push(cap);
      console.warn(`[AVCapMemory] ${dim} ${cap} failed ${d.fails[cap]}x (reason=${reason})`
        + ` — removing from native surface (device ${this._sig})`);
      return true;
    }
    console.warn(`[AVCapMemory] ${dim} ${cap} native failure ${d.fails[cap]}/${this._failThreshold} (reason=${reason})`);
    return false;
  }

  /**
   * Record that a native DIRECT_PLAY attempt reached first frame. Proves the
   * device handled every mappable dimension of this combo — immunise them all
   * (clear fails, drop any prior blacklist entry, mark proven-good).
   * @param {{video?: string|null, audio?: string|null, container?: string|null}|null} hint
   * @returns {boolean} true if state changed
   */
  recordSuccess(hint) {
    const caps = this._capsForHint(hint);
    let changed = false;
    for (const dim of DIMS) {
      if (this._immunise(dim, caps[dim])) {
        console.log(`[AVCapMemory] proven-good ${dim}: ${caps[dim]} (device ${this._sig})`);
        changed = true;
      }
    }
    if (changed) this._persist();
    return changed;
  }

  /**
   * Record a native DIRECT_PLAY decode/demux failure. Ignored unless the reason
   * is a real codec rejection. Attributes the failure to exactly one dimension:
   * video while it is still unproven, else the single unproven audio/container
   * dimension. Ambiguous cases (two unknowns, or an unmappable video) are left
   * un-learned so MP4/AAC can never be wrongly blacklisted.
   * @param {{video?: string|null, audio?: string|null, container?: string|null}|null} hint
   * @param {string} reason  AVPLAY_* failure reason
   * @returns {boolean} true if a dimension value became newly blacklisted
   */
  recordFailure(hint, reason) {
    if (!isCodecFailureReason(reason)) return false;
    const caps = this._capsForHint(hint);

    // Video-first: while the video codec is mappable but not yet proven-good it
    // is the prime suspect.
    if (caps.video && !this._isGood('video', caps.video)) {
      const bl = this._failDim('video', caps.video, reason);
      this._persist();
      return bl;
    }

    // The failure is only attributable elsewhere once video is KNOWN good (an
    // unmappable/absent video codec leaves the fault ambiguous — bail out).
    if (!this._isGood('video', caps.video)) return false;

    const suspects = [];
    if (caps.audio && !this._isGood('audio', caps.audio)) suspects.push(['audio', caps.audio]);
    if (caps.containers && !this._isGood('containers', caps.containers)) suspects.push(['containers', caps.containers]);
    if (suspects.length !== 1) return false; // 0 or 2 unknowns — ambiguous

    const [dim, cap] = suspects[0];
    const bl = this._failDim(dim, cap, reason);
    this._persist();
    return bl;
  }

  /**
   * Video capability names proven bad on this device. The caller subtracts
   * these from the pwa_native video list.
   * @returns {string[]}
   */
  getProvenBadVideo() {
    return this._state.video.bad.slice();
  }

  /**
   * Proven-bad capabilities per surface dimension. The caller subtracts each
   * list from the matching pwa_native array.
   * @returns {{video: string[], audio: string[], containers: string[]}}
   */
  getProvenBadNativeCaps() {
    return {
      video: this._state.video.bad.slice(),
      audio: this._state.audio.bad.slice(),
      containers: this._state.containers.bad.slice(),
    };
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
