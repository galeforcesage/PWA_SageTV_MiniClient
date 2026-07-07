# Roadmap

## Current Status
- Playback stability and iOS responsiveness improvements are in place and are showing positive results.
- Bridge reconnect storm mitigation and iOS performance profile changes are deployed.

## Known Issue (Open)
- Power button behavior: the top-left power icon currently still triggers SageTV standby behavior instead of a guaranteed client session exit back to the connect screen.

## Next Steps
- Add a dedicated client-only disconnect command path that never maps to SageTV POWER/standby.
- Validate disconnect behavior across Windows Chrome, iPad Safari, and Android Chrome.
- Add lightweight runtime telemetry for power-button action result (disconnect vs standby) to confirm behavior in the field.

## Menu Performance (iPad Safari / Samsung Tizen)

Second-level menus can take multiple seconds per move on iPad and Tizen. The
root cause is decoded-image cache pressure forcing per-draw image re-fetches
from the server, amplified by WebKit/Tizen canvas and console overhead. Work is
tracked below by state. **Always turn on `?perf=1` and measure before and after
any change** — several "obvious" fixes are either already done or unsafe.

### Done
- **PWA0 — Gated performance instrumentation.** New `public/js/perf/perf-monitor.js`
  singleton. Enable via `?perf=1`, `localStorage.sagetv.perf="1"`, or
  `__SAGETV_PERF__.setEnabled(true)`; disabled by default (near-zero overhead
  when off). Reports per-frame elapsed ms, command counts by name,
  draw/scaled-draw counts, image/surface cache usage vs budget, GFX WebSocket
  `bufferedAmount`, and input→present latency for every navigation keypress.
  Warns >50 ms, severe >250 ms. Latest metrics mirrored to `window.__SAGETV_PERF__`.
- **PWA0 — Silenced per-frame console spam.** The unconditional per-frame
  `[Frame] …` summary and the hottest per-command logs (LOADIMAGE,
  LOADIMAGECOMPRESSED, PREPIMAGE, PREPIMAGETARGETED, CREATESURFACE,
  SETTARGETSURFACE) are now gated behind the perf flag. Console I/O during menu
  repaint was itself a measurable Tizen drag.
- **PWA3 (safe subset) — Fixed image-cache accounting leak.** `createSurface()`
  added surface pixels to the shared cache budget but `unloadImage()` never
  subtracted them on delete. Every create/destroy surface cycle (menu
  transitions, animated posters) inflated the counter until `canCacheImage()`
  returned false permanently — after which every poster round-tripped from the
  server. This is the primary driver of the multi-second per-row lag. Surfaces
  are now subtracted on delete in `renderer.js`.
- **PWA5 — Platform-aware canvas smoothing.** `imageSmoothingQuality` was
  globally `'high'` (an expensive per-blit resampler on constrained GPUs).
  Now `'low'` on iOS/Tizen (slow-GPU) and `'high'` on desktop/Android,
  overridable via the renderer `smoothingQuality` option.
- **BRIDGE1 — TCP→WS coalescing in the Java bridge.** `BridgeWebSocket.java`
  previously sent one WebSocket binary frame per TCP read, flooding the browser
  with `onmessage` events during GFX bursts (a main-thread cost on iPad/Tizen).
  The relay now accumulates a burst into fewer, larger frames — flushed at
  `WS_COALESCE_MAX_BYTES` (default 256 KiB) or when the socket drains (end of
  burst), so frame-boundary bytes like FLIPBUFFER are never delayed. Payload and
  byte order are untouched (no SageTV protocol change). Backpressure is inherent
  via the blocking `sendBytes`. Tunable via `WS_COALESCE_MAX_BYTES` env / `-D
  pwa.ws.coalesceMaxBytes` (set `<= 0` to disable); close-log reports
  `tcpReads` vs `wsFrames` so the coalescing ratio is visible.

### Recommended (server-cooperative)
- **PWA3 — Server-cooperative image-cache eviction.** Unilateral client eviction
  is unsafe (see Not Recommended), but with a matching change in the SageTV
  server fork it becomes protocol-correct and is the real fix for bounded memory
  under heavy browsing. Two viable designs:
  - **(a) Client-driven + uncache notice** *(smaller change)* — client LRU-evicts
    handle H under pressure, then sends a new `CLIENT_UNCACHED_IMAGE(H)` event;
    server drops H from its per-client cache model and re-sends it on next draw.
  - **(b) Server-driven LRU from an advertised budget** *(most protocol-faithful)*
    — client advertises its true byte budget at handshake; server tracks cached
    bytes per client and proactively sends UNLOADIMAGE for its own LRU before
    overflow. Eviction stays server-initiated → safe by construction; the client
    already honors UNLOADIMAGE.
  Both require touching the server GFX protocol handler (`MiniClientSageRenderer`).
  Pair with the PWA0 metrics to confirm the accounting-leak fix isn't already
  sufficient before investing. **Blocked where Sage.jar is frozen** (e.g. the
  live `sagetv-mine` image, which only accepts plugin updates): the server-side
  change can't be deployed there, so only the client-side accounting-leak fix
  applies on those hosts. This is the highest-value *future* item once a
  server-writable target is available.

### Not Recommended
- **PWA3 — Unilateral client-side LRU eviction (no server change).** Protocol-
  unsafe. Once the client returns a non-zero handle for LOADIMAGE/PREPIMAGE/
  XFMIMAGE, the SageTV server assumes that image stays cached until *it* sends
  UNLOADIMAGE (confirmed by the reconnect path, which keeps cached images with
  stable handles). Evicting a server-committed handle yields permanent blank
  posters. Only safe with the complementary server change above (see Recommended).
- **PWA2 — Retain ImageBitmap instead of CPU canvases.** Already implemented in
  `renderer.js` (bitmaps are the primary source, closed on release, promotion
  skipped on slow GPUs). No further work needed.
- **PWA7 — Worker/OffscreenCanvas render path.** Speculative, high effort, and a
  probe rather than a fix. Server cooperation cannot unlock it — it targets
  browser main-thread canvas work that no server/bridge change can offload.
  Revisit only if instrumentation proves main-thread render (not image re-fetch)
  is the dominant cost. (The server *can* separately reduce command/surface
  volume per menu, which is a different lever.)

### Outstanding (measure first)
- **PWA1 — Additive platform/render capability detection.** Extend
  `platform-detector.js` with `isSamsungTV`, parsed `tizenVersion`, and
  feature flags (createImageBitmap, OffscreenCanvas, transferControlToOffscreen,
  requestIdleCallback, WebSocket.bufferedAmount), surfaced as an additive
  `renderHints` block. Low risk; enables PWA6.
- **PWA6 — Structured Tizen/iOS render profiles.** Formalize Auto / Quality /
  Balanced / Low-memory profiles (cache budget, scaled-image cache, smoothing,
  preferred logical resolution) instead of the current ad-hoc per-platform caps.
  Depends on PWA1.
- **PWA4 — rAF-gated FLIPBUFFER presentation.** Coalesce presentation through
  `requestAnimationFrame` so paints align with refresh and don't fire mid-burst.
  Medium risk (blank-frame / input-lag if coalescing is wrong); gate behind a
  flag and validate against the PWA0 input→present numbers before enabling.
- **Server-cooperative cache** — see *Recommended → PWA3* above; pursue if PWA0
  metrics still show image re-fetch thrash after the accounting-leak fix.

## Java 8 / Plugin-Repo Conformance — Done (v1.0.0.2)

The plugin targets the OpenSageTV V9 plugin repo, whose entire catalog tops out
at `<JVM/>` MinVersion `1.8` (web, jetty, sagex-api). The plugin previously
declared JVM `11` and used Java 9 APIs, so it neither installed on a stock
Java 8 SageTV V9 server nor conformed to the repo convention. Fixed:

- **Manifest** — `<JVM/>` MinVersion `11` → `1.8` in `plugin/pwa-miniclient.xml`
  and `pwa-miniclient-dev.xml` (Core stays `9.0.0`, matching jetty/web/sagex-api).
- **Code** — replaced `Set.of(...)` in `ServerInfoServlet.java` with a Java 8
  `new HashSet<>(Arrays.asList(...))` form.
- **Build hardening** — `options.release = 8` in `bridge-java/build.gradle`
  rejects Java 9+ APIs at compile time. This immediately caught a *second* slip
  it would otherwise have missed: `Process.pid()` (Java 9) in
  `TranscodeManager.java`, now removed.
- **Verified** — shadow-jar bytecode major version 52 (Java 8).
- **Released** — cut as **v1.0.0.2**: rebuilt release ZIPs uploaded to the
  GitHub release, and `plugin/pwa-miniclient.xml` package URLs + MD5s refreshed
  to point at the v1.0.0.2 assets (was still pointing at v1.0.0.1). The manifest
  is now installable from the repo.

Remaining (repo publishing): open a PR to `OpenSageTV/sagetv-plugin-repo` adding
`plugin/pwa-miniclient.xml` under `plugins/` so it appears in the in-app plugin
browser.
