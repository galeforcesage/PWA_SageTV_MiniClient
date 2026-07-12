# NG server changes for the PWA `/msproxy` path

> Audience: the SageTV **NG server** team. Companion to
> `docs/mediaserver-xcode-proxy-spec.md` (the bridge design). This file lists
> ONLY what the NG server needs so the PWA bridge can be a *thin byte proxy*
> and NG stays **server-authoritative** (it decides remux/transcode from the
> client's reported capabilities). Legacy 9.2.16 needs nothing here — it falls
> back to the client-authoritative path in the bridge.

## TL;DR

NG already has ~90% of this. The one real gap: the decision engine treats
`pull` as "raw file only" and routes every REMUX/TRANSCODE decision to
`push`/`hls`. The PWA is **pull-only**, `push` is extender-only, and `hls` is
the 480×272 `iosstream`. So today a browser that needs a transform has **no
first-class NG path** — only the bridge's own ffmpeg. The `:7818` MediaServer
pull protocol *can* serve transformed bytes (`XCODE_SETUP` before `OPEN`); the
bridge proves it. NG just needs to recognize that as a servable delivery mode.

## What NG already has (verified in `SageTV-mine`, no change needed)

| Capability | Where | Status |
|---|---|---|
| `browserhd` fMP4 mode (HwEncoder auto NVENC/libx264) | `MediaServer.buildBrowserHdParams()` | ✅ ships; emits streamable frag-MP4 on NVENC **and** software (confirmed on deployed binary) |
| `mpeg2psremux` (PS copy-remux) | `MediaServer` ctor | ✅ ships |
| `XCODE_SETUP <mode>` on `:7818` (transcoder-per-connection) | `MediaServer.Connection` | ✅ |
| `XCODE_ADJUST <kbps>` live BW feedback (NG-only) | `MediaServer.Connection` | ✅ returns new kbps; `NO_INIT`/`PARAM_ERROR` otherwise |
| Live-edge streaming through the transcoder | `openFile()` → `xcoder.setActiveFile(true)` when `currMF.isRecording()`; `readFile()` wait-loop | ✅ |
| Capability handshake + per-stream verdict | `PlaybackDecisionEngine.evaluateSurfaces()`; emits `CAP_EFFECTIVE_SURFACE` / `CAP_EFFECTIVE_PLAYER` per OPENURL | ✅ surface + delivery + target codecs computed |

## What NG needs to change

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

The engine already knows `chosenDeliveryMode`, `targetVideoCodec`,
`targetAudioCodec`. For `pull-xcode`, resolve the concrete MediaServer mode:

| Engine decision | Target | `:7818` `XCODE_SETUP` mode |
|---|---|---|
| DIRECT_PLAY | — | *(none — plain `pull`)* |
| REMUX (container only, codecs OK) | TS copy | `mpeg2tsremux` |
| AUDIO_TRANSCODE / TRANSCODE (browser) | H.264+AAC fMP4 | `browserhd` |

Then **emit it to the client** alongside `CAP_EFFECTIVE_SURFACE`, e.g. a new
session property per OPENURL:

```
CAP_EFFECTIVE_DELIVERY = "pull:direct"            // direct play
CAP_EFFECTIVE_DELIVERY = "pull-xcode:mpeg2tsremux" // remux
CAP_EFFECTIVE_DELIVERY = "pull-xcode:browserhd"    // transcode
```

The bridge maps this 1:1 to `/msproxy?mode=`:
`direct` → `mode=direct`, `pull-xcode:mpeg2tsremux` → `mode=remux:ts`,
`pull-xcode:browserhd` → `mode=xcode:browserhd`. With this, the PWA **stops
sniffing codecs on NG** and just honors the verdict — the server-authoritative
goal. (Legacy sends no such property, so the bridge sniffs — unchanged.)

### 4. Add `mpeg2tsremux` natively (low priority — bridge injects it)

Only `mpeg2psremux` ships. The bridge self-injects `mpeg2tsremux` =
`-f mpegts -vcodec copy -acodec copy -copyts` via `Sage.put` at startup **only
if absent**, so this works today. Shipping it natively (in the `MediaServer`
ctor next to `mpeg2psremux`) makes it first-class and lets the bridge stop
injecting.

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
