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
# SageTV plugin deploy / dev-mode rules

Before deploying, modifying, or debugging any SageTV plugin (including this
PWA MiniClient), read [docs/sagetv-plugin-dev-mode.md](../docs/sagetv-plugin-dev-mode.md).
It documents:

- The two dev-catalog paths (`SageTVPluginsDev.xml` vs `SageTVPluginsDev.d/`)
  and why the `.d/` mechanism is broken since 2022 (int-overflow in
  `compareVersions` throwing `NumberFormatException` on `yyMMddHHmm`
  timestamps).
- The recommended dev workflow: **single-file dev XML, manual `<Version>` bump
  per build, no `SageTVPluginsDev.d/`**.
- Classpath duplication trap (`JARs/*` picks any matching jar; always
  `.prev-<ts>` old jars aside).
- The rule that Java class hot-reload does not work — **jar changes require a
  full Sage JVM restart** (`stopsage`/`startsage`). No Plugin Manager Update
  workflow can avoid this.
- Static resources (JS/CSS/HTML/images) served by a plugin from the filesystem
  do NOT need a Sage restart; jar-embedded resources do.
- Which `Sage.properties` keys are Sage-owned (`sagetv_core_plugins/<id>/*`,
  `plugin/hidden/<id>`) and must NEVER be hand-edited.

Any plan involving Plugin Manager Update, `SageTVPluginsDev.d/`, or the phrase
"hot-swap the plugin without stopsage" must be validated against that doc
first.


## Deploying from Windows to Linux (traps)

Windows → Linux deploy pitfalls that have bitten this repo repeatedly. Full
detail in [docs/sagetv-plugin-dev-mode.md](../docs/sagetv-plugin-dev-mode.md)
under "Deploying from Windows: known traps".

- **NEVER use PowerShell `Compress-Archive`** to build a zip that will be
  extracted on Linux. It writes entry names with backslash separators
  (`js\perf\perf-monitor.js`). Linux Python `zipfile.extractall()` treats
  those as literal filename characters — no directory tree, silent
  extraction failure. Use `scp -r <dir>` or `tar | ssh 'tar -xf -'`
  instead, or build the zip on Linux with Python `os.path.relpath(...).replace(os.sep,'/')`.

- **Always sanity-check the deployed file's md5** matches the intended source
  after any Windows→Linux "package + extract" step. If MD5 disagrees, the
  transfer/extraction is broken; do not proceed.

- **PWA MiniClient (and many SageTV plugins) serve web assets from disk**,
  not from jar classpath resources. Deploying a new jar alone is NOT enough
  for JS / CSS / HTML changes: you must also refresh
  `/opt/sagetv/server/<respath>/public/` (either by clicking Plugin Manager
  → Update after refreshing the System zip, or by `scp -r public/` directly).

- **PowerShell mangles nested quoting for `ssh 'bash -c "…"'`**. Write any
  non-trivial bash to a local `.sh` file, `scp` it, run with
  `tr -d '\015' < script.sh > script.clean.sh && bash script.clean.sh`.
  See the persistent user memory `agent-command-style.md` for the full
  rule and the CRLF `\015` vs `\r` gotcha.
