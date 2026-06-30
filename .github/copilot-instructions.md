# Copilot guardrails for iOS optimization work

These changes target iOS/iPadOS Safari (WebKit). They MUST NOT regress
Android Chrome, desktop Chrome/Edge, or desktop Firefox.

1. NEVER change the default/existing code path for non-iOS browsers. Any
   iOS-specific behavior must be gated behind a feature check
   (`'wakeLock' in navigator`, `window.ManagedMediaSource`, etc.) or the
   `PlatformDetector` iOS flag — never a UA `else` branch that alters Blink/Gecko.
2. Progressive enhancement only: feature-detect every new API and fall back to
   the CURRENT behavior when it is absent. No hard dependency on an API that
   isn't on all four target engines.
3. Do NOT rename or remove existing capability/handshake fields that the server
   parses (e.g. `platform: 'browser'`/`'tizen'`). ADD new fields instead.
4. Do NOT modify the SageTV protocol layer: `js/protocol/connection.js` parsing/
   crypto/compression, `binary-utils.js`, `crypto.js`, `compression.js`,
   `constants.js`. Connection.js may gain a small PUBLIC reconnect helper, but
   its binary/protocol handling stays byte-for-byte unchanged.
5. Prefer changes that are net-neutral-or-better on Blink/Gecko. If a change
   could theoretically slow desktop/Android, keep the old path for them.
6. One task = one PR = one commit scope. Keep diffs minimal and reviewable.
7. Each PR must be verified on the full matrix before merge: desktop Chrome,
   desktop Firefox, Android Chrome, iPad Safari (and iPhone Safari where noted).
   Regression on ANY non-iOS target blocks the merge.
8. No new build step or bundler. This project ships hand-authored ES modules
   loaded directly; keep it that way. Vendored libs go in `public/js/lib/`.