# SageTV PWA MiniClient — iOS / iPadOS Optimization Plan

**Target repo:** `galeforcesage/PWA_SageTV_MiniClient` (the `public/` client only — do **not** touch the SageTV binary protocol, crypto, or compression layers)
**Audience:** GitHub Copilot (VS Code) agent mode
**Recommended model:** Claude Sonnet 4.7 / Opus 4.8 (the `renderer.js` and `player.js` tasks need careful, context-aware edits — pick the strongest model in the Copilot model picker for those).

---

## 0. How to use this file

1. Drop this file in the repo root (e.g. `docs/ios-optimization-plan.md`).
2. use **Global Guardrails** in `.github/copilot-instructions.md` so Copilot loads it automatically on every request.
3. Work **one task per branch/PR**, in the order under *Recommended sequence*. In Copilot Chat: *"Implement task D1 from docs/ios-optimization-plan.md. Follow the Global Guardrails."*
4. After each task, run the **Per-PR verification checklist** before merging.

> **Confirm Issue-2 branch first.** Before implementing the media tasks (M1–M4), connect the iPad to a Mac → Safari → Develop → Web Inspector, click Play on a recording, and capture the console line (`MEDIA_SOURCE_UNAVAILABLE`, `Play blocked:`, `SourceBuffer error`, `BRIDGE_TRANSCODE_FAILED`, `PUSH CODEC MISMATCH`, or `mux.js not available`). Paste it into the M1 PR description — it tells the agent which branch is actually firing so it fixes the right one.

---

## 1. Confirmed context (do not re-investigate)

- **Performance:** Identical workload is **fast on Android Chrome (Blink) and PC Chrome/Edge/Firefox (Blink/Gecko)** but **slow only on iPad Safari (WebKit)**. This isolates the problem to **WebKit's Canvas 2D engine**, not the rendering workload or device speed.
- **Playback:** Recordings **don't start when Play is clicked** in the server-served client on iPad, while Android works against the same server (so the server-side transcode path is fine — the fault is in the iPad client media path).
- **Already correct (do not "add" these — they exist):** `playsinline`/`webkit-playsinline`/`muted` on `<video>`; `viewport-fit=cover`; `apple-mobile-web-app-capable`; safe-area CSS vars; `touch-action:none` on canvas; `position:fixed` layout; `ManagedMediaSource` support; autoplay-block overlay; `navigator.standalone` detection; app-level keepalive ping; type-5 session-resume reconnect.

---

## 2. GLOBAL GUARDRAILS  are in .github/copilot-instructions.md

## 3. Recommended sequence

| Order | Task | Why first |
|------|------|-----------|
| 1 | **D1** Platform detection | Foundation: R2, M1, M4, L1, L2 branch on the iOS flag |
| 2 | **R1** ImageBitmap pipeline | Biggest iPad-speed win; helps all engines |
| 3 | **R2** iOS-aware cache cap | Small, depends on D1 |
| 4 | **M1** MediaSource selection | Most likely "won't play" root cause |
| 5 | **M2** Autoplay gesture priming | Second playback suspect |
| 6 | **M3** Vendor mux.js/hls.js | Removes a cross-platform failure mode |
| 7 | **M4** Native HLS on iOS | Cleaner iOS media path |
| 8 | **L1** Wake Lock | Fixes the no-op "Keep Screen On" |
| 9 | **L2** Reconnect-on-resume | The README's Reconnection 🚧 |
| 10 | **A1 / C1 / C2 / I1** | Polish |

---

## 4. Tasks

### D1 — Add real iOS/iPadOS detection  *(P1, do first; enabler)*
**File:** `public/js/platform/platform-detector.js`
**Problem:** `platform` is only `'tizen'` or `'browser'`. iPad/iPhone is undifferentiated `'browser'`, so nothing downstream (cache cap, media path, wake lock, server stream choice) can special-case iOS. iPadOS 13+ also reports as desktop Safari, so UA sniffing alone fails.
**Change:**
- Add detection that handles iPadOS-reports-as-Mac:
  `isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)`.
- Expose `isIOS()` on the class, and **add** (do not rename) fields to the capability payload from `_buildCapabilities()`:
  `isIOS: <bool>`, `iosVersion: <major int|null>`, and `playbackHints.canUseMediaSource: !!(window.MediaSource || window.ManagedMediaSource)`.
- Keep `platform` as-is (`'browser'`/`'tizen'`) so the server handshake parser is unaffected (Guardrail 3).
**Guardrails:** additive only; no change to the `'tizen'`/`'browser'` values; pure function, no side effects.
**Accept:** on iPad/iPhone the payload shows `isIOS:true` and a sane `iosVersion`; on desktop/Android `isIOS:false`; server handshake unchanged.
**Cross-platform impact:** none (adds fields).

---

### R1 — Store `ImageBitmap` instead of CPU canvases  *(P0 — primary iPad-speed fix)*
**File:** `public/js/ui/renderer.js`
**Problem (WebKit-specific):** every cached UI image becomes its own `<canvas>`:
- `loadCompressedImage()` does `createImageBitmap()` → draws into a new canvas → **`bitmap.close()` discards the GPU-friendly bitmap**, keeping the slow canvas.
- `loadImage()` / `_finalizeImage()` build RGBA via `putImageData()` into a `document.createElement('canvas')`.
On WebKit, `putImageData` canvases stay **CPU-backed (unaccelerated)** and `drawImage` from them is slow; Blink/Gecko GPU-accelerate them, which is why only iPad suffers.
**Change:**
- In `loadCompressedImage()`: **keep the `ImageBitmap`** — store `{ bitmap, width, height, loaded:true }` and stop drawing-to-canvas-then-closing.
- In the raw path (`_finalizeImage()`): after composing the `ImageData`, produce an `ImageBitmap` via `createImageBitmap(imageData)` and store that instead of a canvas. This makes finalize async — reuse the existing `_pendingImageLoads` / `onImagesReady` / `_ensureFinalized` scaffolding so a `drawTexture` before the bitmap is ready is handled (don't crash; skip-and-repaint as today).
- In `drawTexture()` and `xfmImage()`: source from `img.bitmap || img.canvas` (bitmaps are valid `drawImage` sources, including the sub-rect/tint paths).
- In `unloadImage()` / `deinit()` / `init()`: call `img.bitmap?.close()` when evicting so bitmap memory is freed (some of this already exists — extend it).
- **Surfaces stay canvases** (`createSurface`) — they are render targets and must remain writable. Do not convert those.
**Guardrails:**
- Keep a fallback: if `createImageBitmap` is unavailable, retain the current canvas path (all four targets support it, but keep the branch for safety — Guardrail 2).
- Verify no double-free (don't `close()` a bitmap still referenced by another handle after `xfmImage`).
- Confirm the tint path (`globalCompositeOperation` multiply/destination-in) still produces identical output with a bitmap source.
**Accept:** iPad UI navigation is materially smoother (Web Inspector Timeline: paint/canvas time drops, canvas count stops climbing); pixel output identical on Chrome/Firefox/Android (diff a few screens).
**Cross-platform impact:** neutral-to-positive everywhere (bitmaps composite at least as fast on Blink/Gecko).

---

### R2 — Lower the image-cache ceiling on iOS  *(P0; depends on D1)*
**File:** `public/js/ui/renderer.js`
**Problem:** `_maxCachePixels = 128*1024*1024/4`. iOS caps total canvas/bitmap memory hard; the SageTV UI's many cached images blow past it and WebKit thrashes. Desktop Safari has the same engine but far more headroom (why PC is fine).
**Change:** when the platform is iOS (pass the `isIOS` flag in from `SessionManager`/constructor — don't import the detector into the renderer directly; inject it), set the budget lower, e.g. `48*1024*1024/4`, and keep eviction aggressive. Leave the 128 MB budget for everyone else.
**Guardrails:** non-iOS budget unchanged; flag passed in (renderer stays platform-agnostic per its own header comment).
**Accept:** iPad memory stays bounded under heavy browsing; no eviction-thrash; desktop/Android cache size unchanged.
**Cross-platform impact:** none for non-iOS.

---

### M1 — Fix MediaSource selection (the "won't play" prime suspect)  *(P0)*
**Files:** `public/js/media/player.js` (`_loadBridgeMode`, `_loadPushMode`, `_flushAndRestart`)
**Problem:** all three sites do `const MSClass = window.ManagedMediaSource || window.MediaSource`, i.e. they **prefer `ManagedMediaSource`** on iPadOS 17+. `ManagedMediaSource` only opens/pulls data while the element is actively streaming and expects the app to honor its `startstreaming`/`endstreaming` events — which this code does not. Plain `MediaSource` (which iPad has had since iPadOS 13, and which Android uses) is the path that already works.
**Change:**
- Flip the preference to match the working Android/desktop path: `const MSClass = window.MediaSource || window.ManagedMediaSource`. (iPhone 17.1+, which has only `ManagedMediaSource`, still gets it.)
- **When `ManagedMediaSource` is the chosen class**, add its required handling: keep `video.srcObject = ms` + `video.disableRemotePlayback = true` (already present), and listen for `ms.addEventListener('startstreaming'/'endstreaming', …)` to gate appends (pause feeding on `endstreaming`, resume on `startstreaming`). Only append while streaming is active.
- Factor the MS-class choice + buffer-append gating into one helper so bridge/push/flush share it (avoid three divergent copies).
**Guardrails:** do not remove `ManagedMediaSource` support (iPhone 17.1+ needs it). Plain-`MediaSource` behavior on Android/desktop must be byte-for-byte unchanged. Feature-detect both; if neither exists, keep the existing `MEDIA_SOURCE_UNAVAILABLE` telemetry path.
**Accept:** recordings start on iPad on click; Android/desktop bridge+push playback unchanged; the captured iPad console error from §0 no longer fires.
**Cross-platform impact:** none for non-iOS (they already use plain `MediaSource`).

---

### M2 — Make iPad playback survive the autoplay/gesture rule  *(P0)*
**Files:** `public/js/media/player.js`, `public/js/app.js` (or wherever the connect/Play tap is handled)
**Problem:** `play()` is invoked from inside the async fetch/stream reader (bridge: after 128 KB; push: after 256 KB), i.e. **detached from the user's tap**. The video starts `muted` (muted autoplay is allowed), but as soon as the server unmutes for audio, WebKit blocks the un-gestured `play()`. The code already dispatches `'playblocked'` → `#play-overlay`; make that bulletproof, and prime the element within the gesture.
**Change:**
- **Unlock within the gesture:** on the user tap that initiates a session/playback, call a one-time `video.play().then(() => video.pause())` (muted) to satisfy WebKit's "activated by user gesture" requirement, so later programmatic `play()` is allowed. Gate to iOS via the D1 flag.
- **Guarantee the overlay path:** verify `'playblocked'` reliably shows `#play-overlay` and that tapping `#btn-play` calls `mediaPlayer.play()` (a real gesture). This is the safety net if priming fails.
**Guardrails:** the priming play/pause must be muted and iOS-only; never auto-trigger audio without a gesture; do not change desktop/Android autoplay behavior (they don't need priming).
**Accept:** on iPad, clicking Play starts the recording without a dead frame; if blocked, the overlay appears and one tap plays. Desktop/Android unchanged.
**Cross-platform impact:** none for non-iOS (gated).

---

### M3 — Vendor `mux.js` and `hls.js` locally  *(P1)*
**Files:** `public/js/lib/` (new files), `public/js/media/player.js` (`_loadScript` call sites), `public/sw.js`
**Problem:** `player.js` loads `mux.js` and `hls.js` from `https://cdn.jsdelivr.net`, and `sw.js` **explicitly skips caching cross-origin** requests. On a SageTV box on a LAN with no/limited internet, those scripts never load → push/HLS playback fails everywhere, not just iOS. `forge`/`pako` are already vendored — do the same.
**Change:** download pinned `mux.js@7.0.3` and `hls.js@1.5.7` into `public/js/lib/`, load them locally, and add both to `STATIC_ASSETS` in `sw.js`. Optionally keep the CDN URL as a fallback if the local file 404s.
**Guardrails:** pin exact versions (match current behavior); no bundler; keep CDN fallback so nothing regresses if a path is wrong.
**Accept:** push/HLS playback works with the network firewalled off the internet; SW precaches both; no console CDN fetch on load.
**Cross-platform impact:** positive everywhere (offline + faster first play + no third-party dependency).

---

### M4 — Prefer native HLS on iOS  *(P1)*
**File:** `public/js/media/player.js` (`_loadHLS`)
**Problem:** order is hls.js first, native fallback. On Apple devices, **native HLS** (`video.canPlayType('application/vnd.apple.mpegurl')`) is hardware-accelerated and more reliable than hls.js-over-MSE.
**Change:** if `isIOS` (D1) **and** native HLS is supported, set `video.src = url` natively first; use hls.js only where native HLS is absent (Chrome/Firefox/Android).
**Guardrails:** non-iOS keeps the hls.js path exactly as today; native path stays `playsinline` (already set in HTML).
**Accept:** iOS HLS uses the native player (no hls.js network fetch on iOS); Chrome/Firefox/Android still use hls.js.
**Cross-platform impact:** none for non-iOS.

---

### L1 — Implement the Wake Lock (the no-op "Keep Screen On")  *(P1)*
**File:** `public/js/app.js`
**Problem:** the `keep_screen_on` setting is saved/loaded (lines ~500/591) but `navigator.wakeLock` is **never called** — the screen sleeps mid-playback on iOS (16.4+) and Android, dropping the connection.
**Change:** when connected and `keep_screen_on` is true, `await navigator.wakeLock.request('screen')`; store the sentinel; **re-acquire on `visibilitychange` → visible** (wake locks auto-release on background); release on disconnect / setting off.
**Guardrails:** feature-detect `'wakeLock' in navigator`; wrap in try/catch (it rejects if not visible/allowed); no-op silently where unsupported.
**Accept:** with the toggle on, iPad/Android screen stays awake during playback; unsupported browsers behave as before.
**Cross-platform impact:** positive everywhere the API exists; neutral elsewhere.

---

### L2 — Reconnect on resume  *(P1 — the README's Reconnection 🚧)*
**Files:** `public/js/protocol/connection.js` (small public helper only), `public/js/app.js` or `session-manager.js` (listener)
**Problem:** there is **no `visibilitychange`/`pageshow` handling anywhere**. iOS freezes the keepalive `setInterval` and tears down the socket on lock/background; on resume the app shows a frozen frame until the next ping fails (up to 15 s) then backs off. Laptops sleeping have the same issue.
**Change:**
- In `connection.js`, add a **public** `resumeIfDead()` that checks `gfxSocket.readyState`; if not `OPEN` and `reconnectAllowed`, restart keepalive and call the existing `_attemptSessionReconnect()`. Guard with a `_reconnecting` flag so it can't race the existing `onclose`-driven reconnect.
- In `app.js`/`session-manager.js`, add `document.addEventListener('visibilitychange', …)` (and `window 'pageshow'`) that calls `connection.resumeIfDead()` when visible. Debounce; only when a session was previously active.
**Guardrails:** **no changes to connection.js binary/protocol/crypto handling** (Guardrail 4) — only the new public helper + reuse of existing reconnect. Must not double-reconnect. Must not fire on first load.
**Accept:** locking/unlocking the iPad (or sleeping/waking a laptop) reconnects within ~1 s instead of stalling; no duplicate reconnect storms.
**Cross-platform impact:** positive everywhere (covers laptop sleep, tab backgrounding).

---

### A1 — Real PNG home-screen icons  *(P2)*
**Files:** `public/index.html`, `public/manifest.json`, `public/icons/` (new PNGs)
**Problem:** `apple-touch-icon` and all manifest icons are **SVG** (`icon-192.svg`, `icon-512.svg`). **iOS ignores SVG** for both, so an installed PWA gets a blurry screenshot instead of an icon.
**Change:** export PNGs from the existing SVGs — `apple-touch-icon` 180×180 (PNG) in the `<head>`, and PNG manifest icons at 192 and 512 (keep the SVGs as additional `rel="icon"` for desktop). *(Image export is outside Copilot's scope — generate the PNGs separately or ask me to produce them from your SVGs.)*
**Guardrails:** keep existing SVG `rel="icon"` entries (desktop uses them fine); additive.
**Accept:** installing to an iOS home screen shows a crisp icon; desktop install/icon unchanged.

---

### C1 — Landscape safe-area (left/right)  *(P2)*
**File:** `public/css/app.css`
**Problem:** only `--safe-top`/`--safe-bottom` are defined/used. The app runs **landscape**, where the notch/home-indicator are on the **left/right** — float buttons at `left:4px`/`right:4px` and the sidebar can sit under the notch on iPhone.
**Change:** add `env(safe-area-inset-left/right)` padding to `#client-screen`, `.server-sidebar`, and the `.float-btn-*` positions.
**Guardrails:** `env(…, 0px)` fallbacks already mean zero effect on non-notched/PC — keep that.
**Accept:** on notched iPhones in landscape nothing is occluded; PC/Android visually identical.

---

### C2 — Block stray pinch-zoom on the client screen  *(P2)*
**Files:** `public/index.html` and/or `public/js/input/input-manager.js`
**Problem:** modern iOS Safari ignores `user-scalable=no`; two-finger gestures over overlays can zoom the whole UI.
**Change:** add `gesturestart`/`gesturechange` `preventDefault` on `#client-screen` (these events are Safari-only and harmless elsewhere).
**Guardrails:** scope to the client screen so pinch still works in scrollable settings if needed; Safari-only events → no effect on Blink/Gecko.
**Accept:** no accidental whole-UI zoom on iPad during playback/navigation.

---

### I1 — iPhone soft-keyboard caveat  *(P2, low)*
**File:** `public/js/input/input-manager.js` (`_showTextInput`)
**Problem:** `_showTextInput()` is driven by a server `MENU_HINT` (a WebSocket message), not a user gesture. iPad tolerates this (README marks iPad ✅), but iPhone often won't raise the keyboard from a non-gesture `focus()`.
**Change:** where a tap/select lands on a text field, focus the hidden input **synchronously inside that pointer handler**; keep the server-hint path as fallback. At minimum, document the iPhone limitation in a comment.
**Guardrails:** don't change iPad behavior (works today); additive focus path.
**Accept:** on iPhone the keyboard appears when entering a text field; iPad unchanged.

---

## 5. Test matrix (run every PR)

| Target | Engine | Must verify |
|--------|--------|-------------|
| Desktop Chrome/Edge | Blink | No regression (perf + playback) |
| Desktop Firefox | Gecko | No regression |
| Android Chrome | Blink | No regression (this is the known-good baseline) |
| iPad Safari | WebKit | The fix works **and** nothing else breaks |
| iPhone Safari | WebKit | Spot-check media + keyboard (where relevant) |

## 6. Per-PR verification checklist

- [ ] Change is feature-detected or behind the D1 `isIOS` flag (Guardrail 1/2).
- [ ] No existing non-iOS code path altered; no protocol/crypto/compression edits (Guardrail 4).
- [ ] No renamed/removed handshake fields (Guardrail 3).
- [ ] Verified on all four engines in the matrix; Android + both desktops show **no regression**.
- [ ] iPad shows the intended improvement (with a Web Inspector Timeline capture for R1/R2).
- [ ] Single, minimal, reviewable diff; one task scope.

## 7. Notes on cross-platform upside

Most of these help Blink/Gecko too, so the guardrails are about *insurance*, not *holding back*:
- **R1/R2** (bitmaps, bounded cache) — at worst neutral on desktop/Android; often a small win.
- **M3** (vendored libs) — faster first play + offline for everyone.
- **L1/L2** (wake lock, reconnect-on-resume) — fix real desktop/Android cases too (laptop sleep, tab backgrounding).
- **M1/M2/M4** — strictly gated to the iOS media path; desktop/Android untouched.
