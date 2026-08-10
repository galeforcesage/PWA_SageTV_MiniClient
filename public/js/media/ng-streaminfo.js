/**
 * NG STREAMINFO — shared parser + format-hint derivation.
 *
 * MEDIACMD_STREAMINFO (command 40) is a pre-stream metadata announcement the
 * SageTV-NG server sends to clients that advertise the `STREAMINFO` capability,
 * BEFORE MEDIACMD_OPENURL. It carries full container/codec/track/timing metadata
 * so the client can pre-configure its decoder pipeline with ZERO probing/sniffing.
 * See docs: NG_STREAMINFO_PROTOCOL.md.
 *
 * This module is platform-agnostic (shared browser + Tizen). It does NOT touch
 * the binary/protocol framing — connection.js decodes the length-prefixed string
 * and hands the JSON text (or object) here. Legacy servers never send command 40,
 * so nothing here runs on a legacy path.
 */

/** Client ACK bitmask replied to MEDIACMD_STREAMINFO (see protocol doc §"Client ACK"). */
export const STREAMINFO_ACK = Object.freeze({
  PARSED: 0x01,      // JSON parsed successfully
  VIDEO: 0x02,       // video decoder pipeline pre-configured (no probe needed)
  AUDIO: 0x04,       // audio decoder pipeline pre-configured (no probe needed)
  WAIT_READY: 0x08,  // advisory: ask server to hold openURL until stream-ready
});

/**
 * SageTV canonical codec name → MIME. Mirrors the authoritative table in the
 * protocol doc and the audio tokens already used by player.js (`_ngFmtToMseCodecs`).
 * A track's explicit `mime` field always wins over this mapping.
 */
export const SAGETV_CODEC_TO_MIME = Object.freeze({
  // video
  'H.264': 'video/avc',
  'HEVC': 'video/hevc',
  'MPEG2-Video': 'video/mpeg2',
  'MPEG4-Video': 'video/mp4v-es',
  'AV1': 'video/av01',
  // audio
  'AC3': 'audio/ac3',
  'EAC3': 'audio/eac3',
  'AC4': 'audio/ac4',
  'AAC': 'audio/mp4a-latm',
  'MP2': 'audio/mpeg-L2',
  'MP3': 'audio/mpeg',
  'DTS': 'audio/vnd.dts',
  'FLAC': 'audio/flac',
  'PCM': 'audio/raw',
});

/**
 * SageTV canonical container name → MIME, so the derived hint's `container`
 * field matches the MIME shape the ng_fmt fast-path already uses. Not required
 * for codec decisions (player mappers only read video/audio), so an unknown
 * container yields null harmlessly.
 */
export const SAGETV_CONTAINER_TO_MIME = Object.freeze({
  'MPEG2-TS': 'video/mp2t',
  'MPEG2-PS': 'video/mpeg',
  'MP4': 'video/mp4',
  'MATROSKA': 'video/x-matroska',
  'AVI': 'video/x-msvideo',
  'FLV': 'video/x-flv',
});

function codecToMime(codec, explicitMime) {
  if (explicitMime && typeof explicitMime === 'string') return explicitMime;
  if (!codec) return null;
  return SAGETV_CODEC_TO_MIME[codec] || null;
}

/**
 * Parse a STREAMINFO payload (JSON string or already-parsed object) into a
 * normalized, forward-compatible descriptor. Unknown fields are preserved on
 * `raw`. Returns null when the input can't be parsed or isn't an object.
 */
export function parseStreamInfo(input) {
  let obj;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { return null; }
  } else if (input && typeof input === 'object') {
    obj = input;
  } else {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const video = Array.isArray(obj.video) ? obj.video : [];
  const audio = Array.isArray(obj.audio) ? obj.audio : [];
  const subtitle = Array.isArray(obj.subtitle) ? obj.subtitle : [];

  return {
    v: Number.isFinite(obj.v) ? obj.v : 1,
    container: (typeof obj.container === 'string' && obj.container) ? obj.container : null,
    durationMs: (typeof obj.duration_ms === 'number' && obj.duration_ms > 0) ? obj.duration_ms : null,
    live: obj.live === true,
    bitrate: (typeof obj.bitrate === 'number' && obj.bitrate > 0) ? obj.bitrate : null,
    video: video.map((v) => ({ ...v, mime: codecToMime(v && v.codec, v && v.mime) })),
    audio: audio.map((a) => ({ ...a, mime: codecToMime(a && a.codec, a && a.mime) })),
    subtitle,
    raw: obj,
  };
}

/** Pick the `primary` track, else the first, else null. */
export function primaryTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return tracks.find((t) => t && t.primary) || tracks[0];
}

/**
 * Derive a `{container, video, audio}` MIME hint (the same shape the ng_fmt
 * fast-path produces) from a normalized STREAMINFO. Returns null when nothing
 * usable is present. This lets STREAMINFO feed the EXISTING setFormatHint path
 * with no duplicated decode logic.
 */
export function streamInfoToFormatHint(info) {
  if (!info) return null;
  const pv = primaryTrack(info.video);
  const pa = primaryTrack(info.audio);
  const hint = {
    container: (info.container && SAGETV_CONTAINER_TO_MIME[info.container]) || null,
    video: pv ? (pv.mime || null) : null,
    audio: pa ? (pa.mime || null) : null,
  };
  if (!hint.container && !hint.video && !hint.audio) return null;
  return hint;
}
