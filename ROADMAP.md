# Roadmap

Status labels: **Done**, **Partial**, **Open**, and **Deferred**.

## Current Status

- **Done — Mainline through PR #17.** Current `origin/main` includes PR #17
  (`7756889`) and all earlier changes through PR #16.
- **Done — Client-only disconnect.** The top-left power control calls
  `handleDisconnect()` in `public/js/app.js`. `SessionManager.disconnect()` in
  `public/js/session/session-manager.js` tears down input, the client connection,
  and media playback, then the UI returns to the connect screen. It does not send
  the SageTV POWER command.
- **Deferred — Disconnect field telemetry.** Cross-platform field validation or
  lightweight disconnect-result telemetry may still be useful, but there is no
  known functional power-button bug.
- **Done — Server work-file hygiene (2026-10-19).** Archived 87 inactive PWA
  development/deployment artifacts plus a README/checksum manifest (88 files,
  370 MB total) under
  `/media/sagetv/nextcloud/sagetv-work/pwa-miniclient-server-work-20261019`.
  The active bridge JAR, live public assets, live TLS keystore, active dev
  catalog, and currently referenced v1.0.0.3 JAR package were intentionally
  retained.

## Recent Reliability and PWA Work

- **Done — Tizen remote ownership.** Tizen playback mappings are gated on the
  protocol media-ownership context, so menus/OSD keep navigation ownership while
  fullscreen playback receives transport mappings. Regression coverage includes
  the transition back to default mappings after media ownership closes.
- **Done — Bridge delivery reliability.** The media-session coordinator validates
  delivered goodput/backpressure behavior and evicts stale consumers that fall
  behind the replay window instead of allowing them to block active playback.
- **Done — Install banner eligibility.** The banner is shown only when the app is
  not already installed, the user has not dismissed it, and either a native
  `beforeinstallprompt` or supported iOS/iPadOS Safari manual-install path is
  available. Tizen is excluded.
- **Done — Installed-PWA launch behavior.** `public/manifest.json` uses
  `launch_handler.client_mode: "navigate-new"` so links open in the installed
  PWA without custom browser-window interception.
- **Done — Resumed playback seeks.** First-open and fallback/restart paths retain
  the requested seek offset instead of reopening resumed playback at zero, with
  Java and JavaScript regression tests.

## Platform and Render Capabilities

- **Partial — PWA1 additive platform/capability detection.**
  `public/js/platform/platform-detector.js` already reports `isTizen()`,
  `isIOS()`, the iOS major version, Tizen model/platform version, remote/input
  capabilities, playback hints, display information, and network hints while
  preserving the existing `platform: "browser"` / `"tizen"` handshake field.
  Add:
  - `isSamsungTV`;
  - normalized `tizenVersion`;
  - an additive `renderHints` block feature-detecting `createImageBitmap`,
    `OffscreenCanvas`, `transferControlToOffscreen`, `requestIdleCallback`, and
    WebSocket `bufferedAmount`.
- **Open — PWA6 structured render profiles.** Replace the current ad-hoc
  iOS/Tizen cache, resolution, bitmap-promotion, and smoothing choices with
  explicit Auto / Quality / Balanced / Low-memory profiles. Keep the current
  behavior as the fallback and gate all platform-specific changes through PWA1
  feature detection.
- **Open — PWA4 rAF-gated FLIPBUFFER.**
  `public/js/protocol/connection.js` still calls `renderer.flipBuffer()`
  synchronously. Prototype flag-gated `requestAnimationFrame` presentation,
  measure input-to-present latency, and retain synchronous presentation as the
  fallback until the full browser/TV matrix is clean.

## Menu Performance (iPad Safari / Samsung Tizen)

Second-level menu delay was primarily caused by decoded-image cache pressure and
per-draw image re-fetches, amplified by constrained WebKit/Tizen canvas and
console performance. Enable `?perf=1` and measure before and after further
changes; several intuitive changes are already complete or protocol-unsafe.

### Done

- **PWA0 — Gated performance instrumentation.**
  `public/js/perf/perf-monitor.js` reports frame timing, command and draw counts,
  input-to-present latency, image/surface cache usage, and GFX WebSocket
  `bufferedAmount`. It is disabled by default and can be enabled with `?perf=1`,
  `localStorage.sagetv.perf="1"`, or `window.__SAGETV_PERF__.setEnabled(true)`.
- **PWA0 — Console log gating.** Per-frame summaries and the hottest image and
  surface command logs are behind the performance flag, avoiding console I/O on
  normal Tizen/iOS rendering.
- **PWA3 safe subset — Surface cache accounting.**
  `renderer.unloadImage()` now decrements the shared cache accounting for
  surfaces, preventing create/destroy cycles from permanently exhausting the
  client cache budget.
- **PWA5 — Platform-aware smoothing.** Constrained iOS/Tizen GPUs use low
  smoothing quality while desktop and Android retain high quality; the renderer
  option remains overridable.
- **BRIDGE1 — TCP-to-WebSocket coalescing.** `BridgeWebSocket.java` combines TCP
  read bursts into fewer WebSocket frames, bounded by `WS_COALESCE_MAX_BYTES` or
  socket drain, without changing SageTV protocol payload bytes or ordering.

### Open — Server-Cooperative Image Eviction

Unilateral client eviction remains unsafe. A future SageTV server change could
either accept a client uncache notice or own LRU eviction based on an advertised
client byte budget. In both designs the server must update its per-client cache
model before a handle can be reused or omitted. Pursue this only if PWA0 metrics
still show image re-fetch thrash after the accounting fix and a writable SageTV
server target is available.

### Not Recommended

- **Unilateral client-side LRU eviction.** Once the client returns a non-zero
  image handle, SageTV assumes it remains cached until the server sends
  UNLOADIMAGE. Silent client eviction can therefore produce persistent blank
  images.
- **Retaining ImageBitmap instead of CPU canvases as new work.** This is already
  implemented in `public/js/ui/renderer.js`: bitmaps are retained as the primary
  source, closed on release, and promotion is skipped on slow GPUs.
- **Worker/OffscreenCanvas render path (PWA7).** This is speculative and
  high-effort. Revisit only if instrumentation shows browser main-thread canvas
  work, rather than image re-fetches, is the dominant remaining cost.

## TLS, Packaging, and Publishing

- **Partial/Open — Host-correct TLS provisioning.** The live server was manually
  repaired with a trusted certificate containing the server IP SAN, but
  `BridgeServer.ensureKeystoreExists()` still generates `CN=localhost` with only
  `DNS:localhost`. Make certificate identity/SAN provisioning host-correct and
  configurable while preserving feature detection, existing HTTPS/WSS behavior,
  and the HTTP companion listener for certificate-strict clients.
- **Done — Java 8 conformance.** Both manifests require JVM 1.8, Gradle compiles
  with `options.release = 8`, Java 9 APIs were removed, and the bridge output was
  verified as Java 8 bytecode.
- **Done — Latest published release is v1.0.0.3.**
  `plugin/pwa-miniclient.xml`, `pwa-miniclient-dev.xml`, and the GitHub release
  agree on version 1.0.0.3.
- **Open — Release refresh.** Mainline fixes through PR #17 landed after
  v1.0.0.3. Build, validate, and publish a new version with refreshed JAR/System
  packages, manifest URLs, and checksums.
- **Open — Official catalog submission.** No
  `OpenSageTV/sagetv-plugin-repo` entry or pull request was found. Submit
  `plugin/pwa-miniclient.xml` under that repository's `plugins/` directory after
  the release refresh.
- **Open — Dev catalog/package cleanup.** `pwa-miniclient-dev.xml` and the live
  `SageTVPluginsDev.xml` still reference `SageTVPluginsDev.d/`, contrary to
  `docs/sagetv-plugin-dev-mode.md`; the live catalog also references a
  v1.0.0.3 web ZIP that is absent. Migrate the dev manifest/catalog to
  single-file dev XML inputs outside `.d`, rebuild both current JAR and System
  packages, and use manual int-safe version bumps for each build.

## Required Validation Matrix

Every merge must pass desktop Chrome, desktop Firefox, Android Chrome, and iPad
Safari. Include iPhone Safari where noted by the change. Tizen-specific changes
also require validation on a Samsung TV. Any non-iOS regression blocks an
iOS/iPadOS optimization from merging.
