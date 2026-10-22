# MediaServer XCODE Proxy — thin bridge, server-side transcoding

> Status: **implemented.** This is the piece that (a) deletes the
> bridge's own ffmpeg, (b) gives legacy 9.2.16 clients HD instead of the 480×272
> `iosstream`, (c) lights up NG's bandwidth-adaptive transcode, and (d) makes
> **live (in-progress) recordings** play correctly.

## Goal

Make the PWA bridge a **thin byte proxy**. All remux/transcode is done by the
SageTV server (legacy **and** NG) via its MediaServer `:7818` pull protocol. The
bridge runs **no ffmpeg** — it opens a `:7818` connection per client stream,
tells the server how to condition it, and relays bytes to the browser/TV.

Works identically against a stock 9.2.16 server and an NG server; NG additionally
gets live bandwidth-adaptive bitrate.

## Why the bridge can't just be removed

A browser can't consume SageTV's transcode delivery directly:
- **Push** (extender socket) — PWA is pull-only (no transmuxer).
- **Legacy HTTP** = the HTTPLS `iosstream` HLS, hard-capped at **480×272**.
- **MediaServer `:7818`** (full-res, and NG BW-adaptive) — **raw TCP**, a browser
  can't open it.

So a bridge translation layer is unavoidable. The only choice is whether the
bridge **transcodes** (today) or **proxies** the server's `:7818` transcode
(this design). This design chooses proxy → zero ffmpeg in the bridge.

## Current state (baseline)

- **TV (AVPlay):** direct-play raw via `/rawmedia`. Ideal, keep.
- **Browser (MSE):** bridge `/transcode` (its own fixed-rate ffmpeg). **Replace.**
- **Live recordings:** `/rawmedia` reads the file directly and stops at the
  current size (no live-edge wait). **Broken for in-progress recordings.**
- Discovery is on-demand; push-transcode endpoint removed; no NG BW feedback.

## MediaServer `:7818` protocol (bridge acts as client)

Line-based, `\r\n`-terminated; most replies start `OK\r\n`. No auth handshake
(localhost, in-container). Verified against server source.

- `OPEN <path>` → `OK` (starts the transcoder if `XCODE_SETUP` was sent first)
- `SIZE` → `<avail> <total>\r\n` (ASCII decimal; `avail` grows for live)
- `READ <offset> <length>` → raw bytes (transcoded/remuxed output if conditioned)
- `XCODE_SETUP <mode>` → `OK` — per-connection `FFMPEGTranscoder`
- `XCODE_ADJUST <kbps>` → `<newKbps>` (NG) | `NO_INIT` | `PARAM_ERROR` | error (legacy)
- `CLOSE` → `OK`

**Ordering:** `XCODE_SETUP` **before** `OPEN` (openFile only starts the
transcoder when `xcoder != null`).

**Modes** are `media_server/transcode_quality/*` keys:
- Direct play → no `XCODE_SETUP` (just `OPEN`+`READ`).
- Remux (copy, no re-encode) → `mpeg2psremux` (defined) / `mpeg2tsremux`
  (referenced but **must be added** server-side).
- Transcode → `DVD`, `SVCD`, … or a new **`browserhd`** (see below).

## New bridge endpoint: `MediaServerProxyServlet` (`/msproxy`)

`/msproxy` is **another servlet on the existing bridge Jetty server** (same
`:8099`/`:8100`, same plugin jar) alongside `/gfx`, `/media`, `/rawmedia`,
`/transcode`. To the client it's the same bridge address, one more path — one
plugin, one process. It is NOT a separate proxy server.

`GET /msproxy?path=<file>&mode=<direct|remux:<fmt>|xcode:<qmode>>&seek=<sec>&bw=<kbps>`

Flow:
1. For a session-tagged conditioned stream, acquire a coordinator keyed by
   session id, canonical path, exact xcode mode/parameters, seek, bandwidth
   seed, sink shape, client origin, and adaptive-output mode. Conflicting reuse
   of a live session id returns HTTP 409.
2. The coordinator opens exactly one TCP connection to MediaServer `:7818`.
3. If not `direct`: send `XCODE_SETUP <qmode>;bw=<kbps>` (→ `OK`) when the
   client supplied a valid initial estimate. If absent, the server applies its
   `media_server/wan_coldstart_kbps` default.
4. `OPEN <path>` (→ `OK`).
5. A producer thread issues sequential `READ` commands into a bounded monotonic
   replay ring. Each attached HTTP consumer has its own cursor. Cursor advancement
   is committed only after its servlet write succeeds; a reconnect begins at the
   highest committed delivered watermark and does not create another producer.
6. When the ring is full, producer reads backpressure. Consumers that fall behind
   and stop advancing beyond the stale-consumer deadline are detached proactively,
   without waiting for the ring to fill, so memory and producer progress remain
   bounded. A caught-up consumer waiting for new producer bytes is not stale.
7. For encoded `xcode:*` streams, keep wall-clock delivery rate as telemetry only.
   Send `XCODE_ADJUST <kbps>` only for a single-consumer burst sample measured by
   active socket-write time. Suppress adjustment while a write is pending, the
   replay ring is constrained or at least 75% full, a consumer was evicted, writes
   occupy at least half the sample window, or a write approaches the stale-consumer
   deadline. Client-paced playback and stalled AVPlay reads are therefore not
   reported to SageTV-NG as available network bandwidth.
8. A failed HTTP request detaches only that consumer. The producer remains alive
   through a bounded zero-consumer reconnect grace. When grace expires (or the
   producer reaches EOF/errors), it sends exactly one `CLOSE`, closes its socket,
   and compare-removes its exact coordinator instance.

The playback-surface advertisement includes
`PLAYBACK_SURFACE_<id>_BANDWIDTH_FEEDBACK`. Chromium/Firefox MSE advertises
`xcode_adjust`; Safari and native/AVPlay surfaces advertise `none`. This is a
tie-breaker and telemetry hint only; it does not select the delivery route.
Safari/WebKit's native surface advertises `hls` in addition to its pull modes
when native HLS support is present; Blink, Gecko, and Tizen advertisements are
unchanged.
Tizen normally direct-plays on LAN; if it must use an `xcode:*` proxy mode, the
client supplies a 50 Mbps cold-start seed. Direct and remux modes carry no seed.
Initial zero-offset AVPlay xcode opens wait up to one second for Sage's initial
seek, folding it into the first `/msproxy` request instead of starting competing
zero-offset and seeked producers. Without a seek, playback opens once at zero
when that grace expires. Direct/remux opens and seek restarts do not wait.

Notes:
- Static direct files retain RFC 7233 byte ranges backed by `READ` offsets.
- Live/conditioned xcode responses are HTTP 200 with `Accept-Ranges: none`.
  A client `Range` header does not seek, restart, or create another producer.
- A media-time seek uses a new session id and `XCODE_SETUP ...;ss=<ms>`.

## Live (in-progress) recordings — first-class

The MediaServer protocol already handles this; the bridge just has to not give up
at current-size EOF:
- `SIZE.avail` **grows** while recording; `READ` near the live edge **waits for
  data** server-side (`readFile` retry loop, `MMC.getRecordedBytes`, circular/
  timeshift files).
- Transcode path also follows live: `openFile` sets `xcoder.setActiveFile(true)`
  when `currMF.isRecording()`, so the server transcoder tracks the growing file.

Bridge behavior for live:
- Keep the HTTP response open (chunked); poll `SIZE`, keep `READ`ing as `avail`
  grows; **do not** close at the current size.
- Client treats it as live: AVPlay live mode / MSE growing source; allow
  pause + timeshift within the buffer; clamp seeks to the live edge.

Open item: segmented recordings (multi-file) — client opens successive segment
files (server pull handles this); confirm the boundary handoff for transcode.

## Server-side items (SageTV / NG server team)

> **Legacy needs NO code change.** `XCODE_SETUP` + the `transcode_quality/*` mode
> table are old placeshifter machinery already present in 9.2.16 (modes are read
> from runtime properties: `Sage.get("media_server/transcode_quality/" + mode)`).
> The **bridge plugin runs inside the SageTV JVM on both server types and can
> self-inject the mode definitions at startup via `Sage.put(...)`** — so the
> "add a mode" items below are shipped BY THE BRIDGE, not hand-edited per server.
> The NG team only owns `XCODE_ADJUST` + confirming live-edge streaming.

1. **Add a browser fMP4 mode** so the bridge is a *pure* relay for MSE
   (bridge-injected via `Sage.put` at startup on legacy + NG):
   ```
   media_server/transcode_quality/browserhd=-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof -vcodec libx264 -preset veryfast -pix_fmt yuv420p -profile:v high -level 4.1 -acodec aac -ac 2 -ar 48000 -b:a 128k
   ```
   (video bitrate driven by `XCODE_ADJUST`; validate `-f mp4` frag output streams
   cleanly over `READ` via `sendTranscodeOutputToChannel`).
2. **Add `mpeg2tsremux`** (referenced, undefined) for TS copy-remux clients:
   ```
   media_server/transcode_quality/mpeg2tsremux=-f mpegts -vcodec copy -acodec copy -copyts
   ```
3. Confirm `XCODE_SETUP` streams the **live edge** for in-progress recordings.
4. NG: `XCODE_ADJUST` already added — keep it wired for the transcode path.

## NG vs legacy: server-authoritative vs client-authoritative routing

The single biggest behavioral change in an NG world is **who decides** how each
stream is conditioned. This flips based on whether the connected server is NG
(`SAGETV_NG_SERVER=1`, pushed on connect; corroborated by a numeric reply to
`XCODE_ADJUST` after `XCODE_SETUP`).

- **NG (server-authoritative).** NG computes the per-stream verdict from the
  capabilities the client reported at session setup (its codec/container profile
  + `DISPLAY_RESOLUTION`) and returns it in the `OPENURL` / `CAP_EFFECTIVE_
  SURFACE` decision. The client **honors that verdict verbatim** and the bridge
  relays bytes — no client-side codec sniffing, no bridge-side mode guessing.
  This is the stated goal: *remux/transcode handled by the NG server based on
  client capability reporting.* `/msproxy`'s `mode=` is derived from the server's
  verdict, not re-derived by the client. NG additionally drives `XCODE_ADJUST`
  for live BW adaptation.
- **Legacy (client-authoritative).** 9.2.16's `OPENURL` is not capability-aware
  (it assumes an extender/placeshifter), so the client **cannot trust it** and
  must sniff the codec/container itself and choose the `/msproxy` mode (or the
  `/transcode` fMP4 fallback). This is today's "smart client" logic, kept only as
  the legacy path.

Consequence for the three build steps:
1. **`/msproxy`:** on NG, treat `mode=` as the server's verdict (relay only); on
   legacy, the bridge/client pick the mode. Same servlet, two callers.
2. **Self-injected modes:** on NG, prefer the server's **native** `browserhd` /
   remux modes when present (don't clobber via `Sage.put`); self-inject only when
   a mode key is missing. On legacy, always self-inject (the modes don't exist).
3. **Client routing:** on NG the decision tree collapses to "honor `OPENURL`,
   pick the matching `/msproxy` mode"; on legacy, keep the full codec-sniff tree
   incl. the `/transcode` fallback.

## Client routing (PWA)

On **NG**, honor the server's per-stream verdict verbatim (below is just the
mode mapping). On **legacy**, the client derives the same decision by sniffing.
Map the server's per-stream decision (`CAP_EFFECTIVE_SURFACE` / OPENURL) to a
proxy mode:
- `DIRECT_PLAY` → `/msproxy?mode=direct` (or keep `/rawmedia`).
- `REMUX` → `/msproxy?mode=remux:ts` (AVPlay) — `XCODE_SETUP mpeg2tsremux`.
- `TRANSCODE` → `/msproxy?mode=xcode:browserhd` (browser MSE) or
  `xcode:<mode>` (rare TV case).

Per platform:
- **AVPlay (TV):** point AVPlay at the `/msproxy` URL (TS/raw) — it already
  consumes an HTTP URL.
- **MSE (browser):** fetch `/msproxy` (fMP4) into MSE — replaces `/transcode`.

## Legacy servers (no code change) + the narrow fallback

**Verified against google/SageTV `FFMPEGTranscoder`:** legacy transcode is an
external, custom, ~2010-2012-era ffmpeg (the `SageTVTranscoder` binary, driven by
SageTV-only flags `-stdinctrl`/`-activefile`/`-brokendts`, `libfaac`, old `-b`
syntax). It:
- **streams incrementally** (stdout ring buffer -> `sendTranscodeOutputToChannel`), and
- **handles live** recordings (`-activefile` + `inactivefile` stdin),
- but **cannot emit browser-ready fragmented MP4** — its streaming outputs are
  `-f dvd` (MPEG2-PS) or `-f mpegts` (H.264/AAC TS); `-f mp4` is old moov-at-end
  only. MSE can't consume any of those directly.

=> **The pure thin-bridge fMP4 `:7818` proxy is inherently an NG capability**
(only NG's modern ffmpeg emits fragmented MP4). That's an accepted NG value-add.

**HEVC / AC-4 are NG-only recording types.** So legacy content is only
MPEG-2/H.264 video + AC-3/AAC/MP2 audio, which reshapes the transcode burden:

| Content | Exists on | Browser | TV (AVPlay) |
|---|---|---|---|
| HEVC / AC-4 | **NG only** | NG `:7818` fMP4 proxy | direct-play |
| H.264 / AAC | legacy + NG | **direct-play** | direct-play |
| MPEG-2 / AC-3 (OTA) | legacy + NG | **transcode needed** | direct-play |

Where the bridge's own ffmpeg is still needed (keep `/transcode` as a
capability-gated **fallback**, not the primary path):

| Path | Handling |
|---|---|
| Any TV / AVPlay (incl. MPEG-2/PS, HEVC, AC-4) | direct-play raw, no transcode |
| Browser, H.264/AAC (legacy or NG) | direct-play, no transcode |
| Browser on **NG** (HEVC/AC-4/MPEG-2) | `:7818` `browserhd` proxy (server fMP4) |
| Browser on **legacy**, MPEG-2/AC-3 | **bridge `/transcode` fallback** (legacy ffmpeg can't emit fMP4) |

Client detection: try the `:7818` proxy; if the server can't emit fMP4 (legacy),
fall back to `/transcode`. This is the *only* remaining reason the bridge ffmpeg
exists — a narrow legacy + browser + MPEG-2/AC-3 corner.

## Migration

- Build `/msproxy`; route the browser MSE path to it behind a flag.
- Keep `/transcode` (bridge ffmpeg) as fallback during rollout; **delete it**
  once `/msproxy` is proven on both legacy and NG.
- Bounded `:7818` connection lifecycle also removes the whole class of
  orphaned/leaked background work.

## Open questions to verify before build

- ~~fMP4 (`-f mp4` frag) streaming over `:7818 READ`~~ **RESOLVED:** legacy ffmpeg
  can't emit fragmented MP4 (verified in google/SageTV `FFMPEGTranscoder`); it
  *does* stream stdout incrementally and handle `-activefile` live. So fMP4 proxy
  is NG-only; legacy browsers keep `/transcode`.
- ~~NG: confirm the modern NG ffmpeg build supports `-movflags +frag_keyframe+
  empty_moov` and streams it incrementally over `READ` (the `browserhd` mode).~~
  **RESOLVED:** `browserhd` emits fragmented, streamable MP4 on the deployed NG
  binary, confirmed for **both the NVENC (hardware) and libx264 (software)
  encode paths**, and streams incrementally over `READ`.
- Transcode seek accuracy (rate-estimated) — fine for VOD; for live, seek within
  buffer only.
- Segmented-recording boundary handoff on the transcode path.
- Whether AVPlay tolerates the server's TS remux timestamps as cleanly as it did
  the ffmpeg `-copyts` test (it did in the manual test).
