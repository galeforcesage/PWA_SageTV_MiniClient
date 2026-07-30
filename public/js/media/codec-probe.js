/**
 * SageTV MiniClient — Codec Smoke Test
 *
 * Runs during app init (while connect screen loads) to build a truthful
 * capability matrix. Two phases:
 *   Phase 1 (sync, <5ms)  — canPlayType + isTypeSupported for every format.
 *   Phase 2 (async, ~200ms) — mediaCapabilities.decodingInfo() for codecs
 *                             that Phase 1 claims are supported. Catches
 *                             canPlayType lies (HEVC returning 'probably'
 *                             but producing videoWidth=0 in practice).
 *
 * Results feed directly into connection.js _probePlaybackSurfaces() so the
 * surfaces declared to the server are truthful.
 *
 * Backward-compatible: if the probe hasn't finished by the time the server
 * asks for surfaces, _probePlaybackSurfaces() falls back to its own inline
 * canPlayType checks (existing behavior).
 */

// ── Format catalog ──────────────────────────────────────────────────────
// Every container, video codec, and audio codec the SageTV ecosystem uses.
// MIME strings match the ng_fmt MIME table; MSE codec strings are what
// addSourceBuffer() / isTypeSupported() need.

const VIDEO_CODECS = [
  { name: 'H264',        nativeMime: 'video/mp4; codecs="avc1.640028"',      mseMime: 'video/mp4; codecs="avc1.640028"',      decodingCfg: { contentType: 'video/mp4; codecs="avc1.640028"',      width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30 } },
  { name: 'H264-baseline', nativeMime: 'video/mp4; codecs="avc1.42E01E"',    mseMime: 'video/mp4; codecs="avc1.42E01E"',      decodingCfg: { contentType: 'video/mp4; codecs="avc1.42E01E"',      width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30 } },
  { name: 'HEVC',         nativeMime: 'video/mp4; codecs="hvc1.1.6.L120.90"', mseMime: 'video/mp4; codecs="hvc1.1.6.L120.90"', decodingCfg: { contentType: 'video/mp4; codecs="hvc1.1.6.L120.90"', width: 1920, height: 1080, bitrate: 20_000_000, framerate: 30 } },
  { name: 'HEVC-Main10',  nativeMime: 'video/mp4; codecs="hvc1.2.4.L120.90"', mseMime: 'video/mp4; codecs="hvc1.2.4.L120.90"', decodingCfg: { contentType: 'video/mp4; codecs="hvc1.2.4.L120.90"', width: 1920, height: 1080, bitrate: 20_000_000, framerate: 30 } },
  { name: 'HEVC-hev1',    nativeMime: 'video/mp4; codecs="hev1.1.6.L120.90"', mseMime: 'video/mp4; codecs="hev1.1.6.L120.90"', decodingCfg: { contentType: 'video/mp4; codecs="hev1.1.6.L120.90"', width: 1920, height: 1080, bitrate: 20_000_000, framerate: 30 } },
  { name: 'VP9',          nativeMime: 'video/mp4; codecs="vp09.00.10.08"',    mseMime: 'video/mp4; codecs="vp09.00.10.08"',    decodingCfg: { contentType: 'video/mp4; codecs="vp09.00.10.08"',    width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30 } },
  { name: 'AV1',          nativeMime: 'video/mp4; codecs="av01.0.08M.08"',    mseMime: 'video/mp4; codecs="av01.0.08M.08"',    decodingCfg: { contentType: 'video/mp4; codecs="av01.0.08M.08"',    width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30 } },
  { name: 'MPEG4-VIDEO',  nativeMime: 'video/mp4; codecs="mp4v.20.8"',        mseMime: null,                                    decodingCfg: null },
  { name: 'MPEG2-VIDEO',  nativeMime: 'video/mpeg',                           mseMime: null,                                    decodingCfg: null },
];

const AUDIO_CODECS = [
  { name: 'AAC',     nativeMime: 'audio/mp4; codecs="mp4a.40.2"',  mseMime: 'audio/mp4; codecs="mp4a.40.2"',  decodingCfg: { contentType: 'audio/mp4; codecs="mp4a.40.2"',  channels: 2, bitrate: 192_000, samplerate: 48000 } },
  { name: 'HE-AAC',  nativeMime: 'audio/mp4; codecs="mp4a.40.5"',  mseMime: 'audio/mp4; codecs="mp4a.40.5"',  decodingCfg: { contentType: 'audio/mp4; codecs="mp4a.40.5"',  channels: 2, bitrate: 128_000, samplerate: 48000 } },
  { name: 'AC3',     nativeMime: 'audio/mp4; codecs="ac-3"',       mseMime: 'audio/mp4; codecs="ac-3"',       decodingCfg: { contentType: 'audio/mp4; codecs="ac-3"',       channels: 6, bitrate: 640_000, samplerate: 48000 } },
  { name: 'EAC3',    nativeMime: 'audio/mp4; codecs="ec-3"',       mseMime: 'audio/mp4; codecs="ec-3"',       decodingCfg: { contentType: 'audio/mp4; codecs="ec-3"',       channels: 6, bitrate: 640_000, samplerate: 48000 } },
  { name: 'MP3',     nativeMime: 'audio/mpeg',                     mseMime: null,                              decodingCfg: null },
  { name: 'OPUS',    nativeMime: 'audio/mp4; codecs="opus"',       mseMime: 'audio/mp4; codecs="opus"',       decodingCfg: { contentType: 'audio/mp4; codecs="opus"',       channels: 2, bitrate: 128_000, samplerate: 48000 } },
  { name: 'FLAC',    nativeMime: 'audio/flac',                     mseMime: null,                              decodingCfg: null },
  { name: 'MP2',     nativeMime: 'audio/mp2',                      mseMime: null,                              decodingCfg: null },
  { name: 'DTS',     nativeMime: 'audio/vnd.dts',                  mseMime: null,                              decodingCfg: null },
];

const CONTAINERS = [
  { name: 'MP4',       nativeMime: 'video/mp4',          mseMime: 'video/mp4; codecs="avc1.42E01E"' },
  { name: 'MPEG2-TS',  nativeMime: 'video/mp2t',         mseMime: null },
  { name: 'MPEG2-PS',  nativeMime: 'video/mpeg',         mseMime: null },
  { name: 'MATROSKA',  nativeMime: 'video/x-matroska',   mseMime: null },
  { name: 'WebM',      nativeMime: 'video/webm',         mseMime: 'video/webm; codecs="vp9"' },
  { name: 'AVI',       nativeMime: 'video/x-msvideo',    mseMime: null },
  { name: 'MOV',       nativeMime: 'video/quicktime',    mseMime: null },
];


// ── Confidence levels ───────────────────────────────────────────────────
// Used to grade each codec result.
const Confidence = Object.freeze({
  CONFIRMED:   'confirmed',    // canPlayType + decodingInfo both agree
  PROBABLE:    'probable',     // canPlayType yes, decodingInfo unavailable
  SUSPICIOUS:  'suspicious',  // canPlayType yes, decodingInfo says no
  UNSUPPORTED: 'unsupported', // canPlayType says no
});


/**
 * @typedef {Object} CodecResult
 * @property {string} name           - SageTV format name (e.g. 'HEVC')
 * @property {boolean} native        - canPlayType returned truthy
 * @property {string|null} nativeVal - raw canPlayType value ('probably'/'maybe'/'')
 * @property {boolean} mse           - isTypeSupported returned true
 * @property {boolean|null} hwDecode - decodingInfo().supported (null = not tested)
 * @property {boolean|null} hwPowerEff - decodingInfo().powerEfficient (null = not tested)
 * @property {string} confidence     - Confidence level
 */

/**
 * @typedef {Object} ProbeResults
 * @property {CodecResult[]} video      - Video codec results
 * @property {CodecResult[]} audio      - Audio codec results
 * @property {CodecResult[]} containers - Container results
 * @property {number} phase1Ms          - Phase 1 duration (sync)
 * @property {number} phase2Ms          - Phase 2 duration (async)
 * @property {boolean} complete         - True when Phase 2 is done
 */


/** Singleton probe results, available globally after runCodecProbe(). */
let _probeResults = null;
let _probePromise = null;

/**
 * Run the codec probe. Safe to call multiple times — returns the cached
 * promise on subsequent calls. Results are available synchronously via
 * getProbeResults() once complete.
 * @returns {Promise<ProbeResults>}
 */
export function runCodecProbe() {
  if (_probePromise) return _probePromise;
  _probePromise = _runProbe();
  return _probePromise;
}

/**
 * Get the probe results synchronously. Returns null if the probe hasn't
 * completed yet. _probePlaybackSurfaces() uses this to avoid re-probing.
 * @returns {ProbeResults|null}
 */
export function getProbeResults() {
  return _probeResults;
}


async function _runProbe() {
  const v = document.createElement('video');
  const MS = window.MediaSource || window.ManagedMediaSource || null;

  // ── Phase 1: sync probes ──────────────────────────────────────────
  const t0 = performance.now();

  const canPlay = (mime) => {
    try { return v.canPlayType(mime) || ''; } catch { return ''; }
  };
  const canMse = (mime) => {
    try { return !!(MS && MS.isTypeSupported && MS.isTypeSupported(mime)); } catch { return false; }
  };

  const videoResults = VIDEO_CODECS.map((c) => ({
    name: c.name,
    native: !!canPlay(c.nativeMime),
    nativeVal: canPlay(c.nativeMime),
    mse: c.mseMime ? canMse(c.mseMime) : false,
    hwDecode: null,
    hwPowerEff: null,
    confidence: !!canPlay(c.nativeMime) ? Confidence.PROBABLE : Confidence.UNSUPPORTED,
    _decodingCfg: c.decodingCfg,
  }));

  const audioResults = AUDIO_CODECS.map((c) => ({
    name: c.name,
    native: !!canPlay(c.nativeMime),
    nativeVal: canPlay(c.nativeMime),
    mse: c.mseMime ? canMse(c.mseMime) : false,
    hwDecode: null,
    hwPowerEff: null,
    confidence: !!canPlay(c.nativeMime) ? Confidence.PROBABLE : Confidence.UNSUPPORTED,
    _decodingCfg: c.decodingCfg,
  }));

  const containerResults = CONTAINERS.map((c) => ({
    name: c.name,
    native: !!canPlay(c.nativeMime),
    nativeVal: canPlay(c.nativeMime),
    mse: c.mseMime ? canMse(c.mseMime) : false,
    hwDecode: null,
    hwPowerEff: null,
    confidence: !!canPlay(c.nativeMime) ? Confidence.PROBABLE : Confidence.UNSUPPORTED,
  }));

  const phase1Ms = performance.now() - t0;

  // Build intermediate results so Phase 1 is immediately usable
  _probeResults = {
    video: videoResults,
    audio: audioResults,
    containers: containerResults,
    phase1Ms,
    phase2Ms: 0,
    complete: false,
  };

  _logTable('Phase 1 (sync)', _probeResults);

  // ── Phase 2: async decodingInfo validation ────────────────────────
  const t1 = performance.now();
  const mc = navigator.mediaCapabilities;

  if (mc && mc.decodingInfo) {
    // Collect all codecs that Phase 1 claims are supported AND have a
    // decodingInfo config. Run them in parallel with a timeout cap.
    const tasks = [];

    const addTask = (result, type) => {
      if (!result._decodingCfg || result.confidence === Confidence.UNSUPPORTED) return;
      const cfg = { type: 'file' };
      cfg[type] = result._decodingCfg;
      tasks.push(
        mc.decodingInfo(cfg)
          .then((info) => {
            result.hwDecode = info.supported;
            result.hwPowerEff = info.powerEfficient;
            if (info.supported) {
              result.confidence = Confidence.CONFIRMED;
            } else if (result.native || result.mse) {
              result.confidence = Confidence.SUSPICIOUS;
            }
          })
          .catch(() => {
            // decodingInfo failed — keep Phase 1 result
          })
      );
    };

    for (const r of videoResults) addTask(r, 'video');
    for (const r of audioResults) addTask(r, 'audio');

    // Race all tasks against a 250ms deadline
    if (tasks.length) {
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  }

  const phase2Ms = performance.now() - t1;

  // Clean up internal fields
  for (const r of videoResults) delete r._decodingCfg;
  for (const r of audioResults) delete r._decodingCfg;

  _probeResults.phase2Ms = phase2Ms;
  _probeResults.complete = true;

  _logTable('Phase 2 (async decode)', _probeResults);
  console.log(`[CodecProbe] Complete: phase1=${phase1Ms.toFixed(1)}ms phase2=${phase2Ms.toFixed(1)}ms total=${(phase1Ms + phase2Ms).toFixed(1)}ms`);

  return _probeResults;
}


/**
 * Extract confirmed + probable codec/container names from probe results.
 * Used by _probePlaybackSurfaces() to build truthful surface declarations.
 *
 * @param {'native'|'mse'} route - Which route to check support for
 * @returns {{ video: string[], audio: string[], containers: string[] }}
 */
export function getSupportedFormats(route) {
  if (!_probeResults) return null;
  const ok = (r) => {
    if (route === 'mse') return r.mse && r.confidence !== Confidence.UNSUPPORTED;
    // Native: confirmed or probable (not suspicious if decodingInfo explicitly failed)
    // SUSPICIOUS means canPlayType said yes but decodingInfo said no.
    // For native route, we trust canPlayType as authoritative (decodingInfo lies
    // on some platforms, e.g. HEVC on Windows Edge). But we flag it so the
    // caller can decide.
    return r.native;
  };

  return {
    video: _probeResults.video.filter(ok).map((r) => _normalizeName(r.name)),
    audio: _probeResults.audio.filter(ok).map((r) => _normalizeName(r.name)),
    containers: _probeResults.containers.filter(ok).map((r) => _normalizeName(r.name)),
  };
}

/**
 * Check if a specific codec was flagged as SUSPICIOUS (canPlayType yes,
 * decodingInfo no). The caller can use this to add extra runtime guards.
 */
export function isCodecSuspicious(name) {
  if (!_probeResults) return false;
  const all = [..._probeResults.video, ..._probeResults.audio];
  const r = all.find((c) => c.name === name || _normalizeName(c.name) === name);
  return r ? r.confidence === Confidence.SUSPICIOUS : false;
}

/**
 * Normalize probe names to SageTV surface format names.
 * Probe uses more granular names (HEVC-Main10, H264-baseline);
 * surfaces use the canonical family name.
 */
function _normalizeName(name) {
  if (name.startsWith('HEVC')) return 'HEVC';
  if (name.startsWith('H264')) return 'H264';
  return name;
}


function _logTable(phase, results) {
  const rows = [];
  const add = (category, list) => {
    for (const r of list) {
      rows.push({
        category,
        codec: r.name,
        native: r.nativeVal || '—',
        mse: r.mse ? '✓' : '—',
        hwDecode: r.hwDecode === null ? '…' : (r.hwDecode ? '✓' : '✗'),
        powerEff: r.hwPowerEff === null ? '…' : (r.hwPowerEff ? '✓' : '✗'),
        confidence: r.confidence,
      });
    }
  };
  add('Video', results.video);
  add('Audio', results.audio);
  add('Container', results.containers);

  console.log(`[CodecProbe] ${phase}:`);
  try {
    console.table(rows);
  } catch {
    // Fallback for environments without console.table
    for (const r of rows) {
      console.log(`  ${r.category.padEnd(10)} ${r.codec.padEnd(14)} native=${String(r.native).padEnd(8)} mse=${r.mse} hw=${r.hwDecode} conf=${r.confidence}`);
    }
  }
}
