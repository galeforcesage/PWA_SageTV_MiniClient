/**
 * Samsung Tizen TV — hardcoded media capability profiles.
 *
 * Why this exists: the Tizen TV WebView's HTMLMediaElement.canPlayType()
 * under-reports the hardware broadcast decoders that every Samsung TV ships
 * (MPEG-2 video, AC-3 / E-AC-3 audio, MPEG2-TS container). The runtime probe
 * in connection.js therefore MISSES capabilities the TV genuinely has, so those
 * sources get pushed onto the bridge-transcode surface (pwa_mse) instead of
 * being played natively. These curated profiles restore the truth for the
 * NATIVE (<video>) surface so the server can DIRECT_PLAY them — no transcode,
 * no A/V drift, instant native seeks, zero CPU.
 *
 * CONTAINER vs CODEC — a decode capability is NOT a demux capability. The TV's
 * hardware MPEG-2 *decoder* is real, but the HTML5 <video> element cannot
 * *demux* the MPEG2-PS (DVD program-stream) container. So we advertise
 * MPEG2-VIDEO (codec) + MPEG2-TS (container) but deliberately NOT MPEG2-PS.
 * When the source is PS, the NG SERVER should REMUX (stream-copy, -c copy)
 * PS -> TS based on this report and deliver TS — no re-encode. Advertising PS
 * here would make the server DIRECT_PLAY raw PS that <video> can't demux ->
 * decode error -> unwanted bridge transcode + A/V drift. (Remux/transcode is
 * the server's job, driven by honest client capability reporting.)
 *
 * Names below are Protocol 2.1 canonical (H264, HEVC, MPEG2-VIDEO, MPEG4-VIDEO,
 * HE-AAC, PCM, MPEG2-TS, MPEG2-PS, MATROSKA, WEBM, ...).
 *
 * SCOPE: only Profile 4 (current, 2023-2026 / Tizen 7.0-10.0) is implemented.
 * Profiles 1-3 are roadmap stubs for older TVs. Until runtime profile detection
 * exists we assume Profile 4 — a safe superset for anything newer, and older
 * TVs degrade gracefully via the player's native->bridge fallback. NOTE: 2023+
 * TVs support OS Upgrade, so model year alone is unreliable; prefer runtime
 * probing (webapis.productinfo / tizen.systeminfo) when profile detection lands.
 *
 * DTS / DTS-HD are deliberately NOT advertised here — Samsung TVs don't decode
 * them; the bridge transcodes DTS sources instead (they stay on pwa_mse only).
 */

// ── Profile 4: current / newer Samsung TVs (2023-2026, Tizen 7.0-10.0) ──
// Native (<video> / AVPLAY hardware) decode capability.
const PROFILE_4 = {
  id: 'tizen-tv-current-2023-2026',
  years: '2023-2026',
  tizen: '7.0-10.0',
  chromium: 'M94-M130',
  video: ['H264', 'HEVC', 'MPEG2-VIDEO', 'MPEG4-VIDEO', 'VP9', 'AV1'],
  // MP2 included alongside MP3 for DVB/broadcast audio (Samsung lists MPEG
  // audio support); PCM = Samsung "LPCM".
  audio: ['AAC', 'HE-AAC', 'AC3', 'EAC3', 'MP3', 'MP2', 'PCM', 'OPUS'],
  // MPEG2-PS included: the Tizen NATIVE surface is webapis.avplay (hardware),
  // which demuxes program streams directly (verified on-device). This is NOT
  // true of the HTML5 <video> element — so these caps are only valid because
  // Tizen playback routes through AVPlay, not <video>.
  containers: ['MP4', 'MPEG2-TS', 'MPEG2-PS', 'MATROSKA', 'WEBM'],
};

/**
 * Roadmap: older Tizen browser-engine profiles. NOT yet used for capability
 * advertising — kept here so profile detection can select them later.
 */
export const TIZEN_PROFILES_ROADMAP = [
  { id: 'legacy-webkit',   years: '2015-2016', tizen: '2.3-2.4', support: 'minimal' },
  { id: 'early-chromium',  years: '2017-2019', tizen: '3.0-5.0', chromium: 'M47-M63', support: 'avplay-first' },
  { id: 'modern-baseline', years: '2020-2022', tizen: '5.5-6.5', chromium: 'M69-M85', support: 'baseline' },
];

/**
 * Resolve the active Tizen capability profile. Currently always Profile 4
 * (current). Runtime detection (webapis.productinfo.getVersion/getModel,
 * tizen.systeminfo) to select an older roadmap profile is a future step.
 * @returns {typeof PROFILE_4}
 */
export function resolveTizenProfile() {
  return PROFILE_4;
}

/**
 * Native (<video>) decode capabilities { video, audio, containers } for the
 * active Tizen profile, as fresh copies (safe to mutate/merge).
 */
export function getTizenNativeCapabilities() {
  const p = resolveTizenProfile();
  return {
    profileId: p.id,
    video: p.video.slice(),
    audio: p.audio.slice(),
    containers: p.containers.slice(),
  };
}

/**
 * Codecs Samsung TVs do NOT decode natively (per Samsung media specs) and that
 * no HTML5 <video> decodes anyway. Applied as a FINAL filter to the NATIVE
 * surface so we never advertise direct-play for them (a false native claim just
 * causes a failed decode + bridge fallback). The bridge surface (pwa_mse) keeps
 * e.g. DTS because it transcodes such sources to AAC.
 *
 * A blacklist removes false POSITIVES; it is complementary to the whitelist,
 * which fixes Tizen's false NEGATIVES. It is NOT a substitute for the whitelist.
 */
export const NATIVE_BLACKLIST = {
  video: [],
  audio: ['DTS', 'DTS-HD', 'DTS-HD-MA', 'WMA-LOSSLESS', 'AMR', 'QCELP'],
  // MPEG2-PS is now advertised (AVPlay demuxes it natively), so it is NOT
  // blacklisted. It would only belong here for a <video>/MSE-only client.
  containers: [],
};

/** Return a copy of `list` with blacklisted entries of `kind` removed. */
export function filterNativeBlacklist(kind, list) {
  const bad = new Set(NATIVE_BLACKLIST[kind] || []);
  return list.filter((v) => !bad.has(v));
}
