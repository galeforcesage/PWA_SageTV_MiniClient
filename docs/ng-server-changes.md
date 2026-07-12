# NG server changes for the PWA `/msproxy` path

> Audience: the SageTV **NG server** team. Companion to
> `docs/mediaserver-xcode-proxy-spec.md` (the bridge design). This file lists
> ONLY what the NG server needs so the PWA bridge can be a *thin byte proxy*
> and NG stays **server-authoritative** (it decides remux/transcode from the
> client's reported capabilities). Legacy 9.2.16 needs nothing here — it falls
> back to the client-authoritative path in the bridge.

## TL;DR

This is the **NG build** — there is no "make it work now" path here (that's
legacy 9.2.16, already fixed via the bridge's existing `/transcode` fallback).
So NG does it right: **NG owns 100% of conditioning; the bridge/proxy stays
thin** — zero transcode config, zero ffmpeg on the `/msproxy` path. The bridge
opens `:7818`, names a *server-native* mode, relays bytes, closes.

Items 1–4 are **one feature**: make NG server-authoritative for the PWA. NG
decides the transform from the client's reported capabilities, ships every
conditioning mode natively, and reports the verdict; the PWA honors it and the
bridge relays.

The gap the feature closes: the decision engine treats `pull` as "raw file
only" and routes every REMUX/TRANSCODE decision to `push`/`hls`. The PWA is
**pull-only**, `push` is extender-only, and `hls` is the 480×272 `iosstream`.
The `:7818` pull protocol *can* serve transformed bytes (`XCODE_SETUP` before
`OPEN`); NG needs to recognize that as a servable delivery mode and report it.

> **Client side is already done.** The PWA honors a `CAP_EFFECTIVE_DELIVERY`
> property verbatim (`pull:direct` / `pull-xcode:browserhd_remux` /
> `pull-xcode:browserhd_copyv` / `pull-xcode:browserhd` / `pull-xcode:mpeg2tsremux`)
> and routes to `/msproxy?mode=` — no client change is needed when NG ships this.
> Until then the PWA uses its existing surface-sniff routing unchanged.

## What NG already has (verified in `SageTV-mine`, no change needed)

| Capability | Where | Status |
|---|---|---|
| `browserhd` fMP4 mode (HwEncoder auto NVENC/libx264) | `MediaServer.buildBrowserHdParams()` | ✅ ships; emits streamable frag-MP4 on NVENC **and** software (confirmed on deployed binary) |
| `mpeg2psremux` (PS copy-remux) | `MediaServer` ctor | ✅ ships |
| `XCODE_SETUP <mode>` on `:7818` (transcoder-per-connection) | `MediaServer.Connection` | ✅ |
| `XCODE_ADJUST <kbps>` live BW feedback (NG-only) | `MediaServer.Connection` | ✅ returns new kbps; `NO_INIT`/`PARAM_ERROR` otherwise |
| Live-edge streaming through the transcoder | `openFile()` → `xcoder.setActiveFile(true)` when `currMF.isRecording()`; `readFile()` wait-loop | ✅ |
| Capability handshake + per-stream verdict | `PlaybackDecisionEngine.evaluateSurfaces()`; emits `CAP_EFFECTIVE_SURFACE` / `CAP_EFFECTIVE_PLAYER` per OPENURL | ✅ surface + delivery + target codecs computed |

## The server-authoritative feature (items 1–4 = one unit)

Do them together — #1 without #3 means NG decides but never tells the PWA, so
nothing routes; #4 ships the modes #3 names. All server-native; the bridge
injects nothing.

### 1. Add a `pull-xcode` delivery mode (the core change)

`PlaybackDecisionEngine.SERVER_SERVABLE_DELIVERY_MODES` is `{pull, push, hls}`,
and `pickDeliveryModeForDecision()` explicitly does:

```
DIRECT_PLAY            -> pull (cheapest), else push, else hls
REMUX/AUDIO_TRANSCODE/TRANSCODE -> push, else hls   // pull refused
```

The refusal comment: *"pull is unusable (raw file bypasses the transform
pipeline)."* That is **not true for `:7818` pull with `XCODE_SETUP`** — the
server transcodes into the pull stream. Change:

- Add `pull-xcode` to `SERVER_SERVABLE_DELIVERY_MODES` (a `:7818` pull
  connection that issues `XCODE_SETUP` before `OPEN`).
- In `pickDeliveryModeForDecision()`, for non-`DIRECT_PLAY` decisions, prefer
  `pull-xcode` when the surface declares it (before `push`/`hls`):
  ```
  REMUX/AUDIO_TRANSCODE/TRANSCODE:
      if declared.contains("pull-xcode") return "pull-xcode";
      else if push ... else hls ...
  ```
- `DIRECT_PLAY` still prefers plain `pull` (no `XCODE_SETUP`).

### 2. Have the `pwa_mse` surface declare `pull-xcode`

The PWA surface descriptor the client advertises (`PLAYBACK_SURFACES`) must list
`pull-xcode` in its `DELIVERY_MODES` so the engine will route transforms to it.
`pwa_mse` (Chromium MSE: H.264 + AAC only, fMP4) and the Tizen AVPlay surface
(raw TS/PS, wide codec support) should both declare:
- AVPlay surface: `pull` (direct) + `pull-xcode` (remux TS for exotic
  containers). Almost everything is DIRECT_PLAY here.
- `pwa_mse` surface: `pull-xcode` (needs `browserhd` for anything not
  H.264/AAC) + `pull` (direct for H.264/AAC MP4).

### 3. Map the decision → a concrete `:7818` `XCODE_SETUP` mode and tell the client

> **Thin-bridge principle:** every conditioning mode lives on NG. The bridge
> carries **zero** transcode config and **zero** ffmpeg on this path — it opens
> `:7818`, sends `XCODE_SETUP <server-native-mode>`, relays bytes, closes. So NG
> ships **all** the modes below; the bridge injects nothing.

The engine already knows `chosenDeliveryMode`, `targetVideoCodec`,
`targetAudioCodec`. The concrete `:7818` mode is **surface-aware** — the browser
(`pwa_mse`) can only consume fragmented MP4; AVPlay consumes raw TS/PS:

| Engine decision | `pwa_mse` (browser → fMP4) | AVPlay (TV → raw) |
|---|---|---|
| DIRECT_PLAY | *(none — plain `pull`)* | *(none — plain `pull`)* |
| REMUX (container only) | `browserhd_remux` (fMP4, copy V+A) | `mpeg2tsremux` (TS, copy V+A) |
| AUDIO_TRANSCODE (V ok, A not) | `browserhd_copyv` (fMP4, copy V, AAC A) | rare — TV direct-plays audio |
| TRANSCODE (V needs re-encode) | `browserhd` (fMP4, full re-encode) | direct-play (AVPlay decodes HEVC/AC-4) |

Why TS-remux can't serve browsers: `mpeg2tsremux` emits MPEG-TS, which MSE
cannot demux. Browser REMUX therefore needs an fMP4 copy-remux (`browserhd_remux`),
and AUDIO_TRANSCODE needs copy-video + AAC (`browserhd_copyv`) — not a full
`browserhd` re-encode of already-good H.264. All three are trivial variants of
`buildBrowserHdParams()` (same container + audio; vary only the video part):

```
browserhd_remux = -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof -c:v copy -c:a copy
browserhd_copyv = -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof -c:v copy -c:a aac -ac 2 -ar 48000 -b:a 128k
```

Then **emit the verdict to the client** alongside `CAP_EFFECTIVE_SURFACE`, e.g. a
new session property per OPENURL:

```
CAP_EFFECTIVE_DELIVERY = "pull:direct"                 // direct play
CAP_EFFECTIVE_DELIVERY = "pull-xcode:browserhd_remux"  // browser remux
CAP_EFFECTIVE_DELIVERY = "pull-xcode:browserhd_copyv"  // browser audio-transcode
CAP_EFFECTIVE_DELIVERY = "pull-xcode:browserhd"        // browser transcode
CAP_EFFECTIVE_DELIVERY = "pull-xcode:mpeg2tsremux"     // AVPlay remux
```

The PWA maps this 1:1 to `/msproxy?mode=`: `pull:direct` → `mode=direct`,
`pull-xcode:mpeg2tsremux` → `mode=remux:ts`, any other `pull-xcode:<q>` →
`mode=xcode:<q>` (fed to MSE as fMP4). **Client wiring is already done** — see
`_deliveryToMsproxy` in `public/js/protocol/connection.js`. With the property
emitted, the PWA stops sniffing on NG and honors the verdict.

### 4. Ship the copy/remux modes natively (part of #3 — bridge injects nothing)

Today only `browserhd` and `mpeg2psremux` ship. Add the rest in the
`MediaServer` ctor next to `mpeg2psremux` so **all** modes are server-native:
`browserhd_remux`, `browserhd_copyv` (both above), and `mpeg2tsremux`
(`-f mpegts -vcodec copy -acodec copy -copyts`). The bridge no longer injects
`mpeg2tsremux` — that self-inject was removed to keep the proxy thin.

## Non-goals / already-fine

- **`XCODE_ADJUST`** — keep as-is; the bridge probes it after `XCODE_SETUP`
  (numeric reply ⇒ NG, adapt live; `NO_INIT`/error ⇒ legacy, fixed rate).
- **Live recordings** — `setActiveFile(true)` + the `readFile` wait-loop already
  follow the growing file; the bridge follows `SIZE.avail`. Please just confirm
  end-to-end for a `browserhd` transcode of an in-progress recording.
- **Auth** — `:7818` is localhost/in-container, no handshake; unchanged.

## Open items to confirm (NG side)

1. `browserhd` frag-MP4 streams incrementally over `READ` for an **in-progress**
   recording (not just completed files).
2. Transcode **seek**: a `READ` at a non-zero output offset on a fresh
   `XCODE_SETUP` connection — rate-estimated seek accuracy for VOD; for live,
   seek-within-buffer only.
3. **Segmented recordings** (multi-file): boundary handoff when a `pull-xcode`
   transcode crosses a segment.
4. Whether `CAP_EFFECTIVE_DELIVERY` (or an existing property) is the right
   channel to carry the verdict to the PWA, vs. annotating the OPENURL itself.
