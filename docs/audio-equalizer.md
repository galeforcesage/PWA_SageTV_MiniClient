# Audio Equalizer / AudioProcessing (v1)

A 10-band graphical equalizer with client-side Web Audio DSP, presets, a
night-sound mode (dynamic range compression), a preamp/volume boost, and an
honest CLIENT/SERVER/NONE capability contract. It is shared browser/Tizen code
and never touches the classic MiniClient binary/GFX/input protocol.

> **Status:** Client-side DSP is fully implemented and working in the browser
> and on Tizen HTML5_MSE. The **server-side `AudioProcessingPlan` is not
> implemented yet** — see [Client vs. server processing](#client-vs-server-processing).
> Per the repo guardrail, the UI never claims DSP it cannot actually perform.

---

## Where the code lives

```
public/js/audio-processing/
  models.js               Canonical types, validation, hashing, night-mode schedule
  presets.js              10 built-in EQ presets + preset detection
  settings-store.js       localStorage persistence + schema migration
  web-audio-engine.js     AudioContext signal chain (preamp → 10× biquad → compressor)
  capability-reporter.js  Runtime Web Audio / Tizen / playback-path probing
  equalizer-panel.js      Modal overlay UI (sliders, presets, toggles, status badge)
  *.test.js               node:test suites (models, settings-store, web-audio-engine)
```

Wiring / integration points:

| File | Role |
| --- | --- |
| `public/js/app.js` | Subsystem init, engine attach, live settings apply, visibility handling, night-mode schedule timer, connection delegate |
| `public/js/media/player.js` | `getVideoElement()` accessor; emits one-time `firstframe` on first native `playing` |
| `public/js/protocol/connection.js` | `setAudioProcessingDelegate()` + `pushAudioProcessingUpdate()` (feedback channel only — no binary/protocol changes) |
| `public/index.html` | EQ button in the nav drawer + full panel overlay markup |
| `public/css/app.css` | Vertical slider styling, light-blue preamp, night-mode section, focus rings, nav drawer |
| `public/sw.js` | Caches the audio-processing files; cache name bumped every deploy |

---

## Architecture

```
localStorage ──► SettingsStore ──► AudioProcessingSettings ──► EqualizerPanel (UI)
                                          │
                                          ▼
                                   WebAudioEngine
        HTMLVideoElement ─► MediaElementSource ─► Preamp(Gain)
                                          ─► 10× BiquadFilter(peaking)
                                          ─► DynamicsCompressor (night mode)
                                          ─► AudioContext.destination

CapabilityReporter ──► connection.pushAudioProcessingUpdate(...) ──► server (advisory)
```

- **`SettingsStore`** is the single source of truth for persisted state.
- **`EqualizerPanel`** owns the UI, writes to the store, and applies changes to
  the engine; it emits `settingschanged` so `app.js` can push to the server.
- **`WebAudioEngine`** owns the live audio graph.
- **`CapabilityReporter`** reports what this client can honestly do.

---

## Canonical model (`models.js`)

- **10 fixed bands** (matching `af_equalizer.c`): `31.25, 62.5, 125, 250, 500,
  1000, 2000, 4000, 8000, 16000` Hz — displayed as `31 63 125 250 500 1K 2K 4K 8K 16K`.
- **Gain range:** `-12 … +12 dB`, step `0.5`. `clampGain()` enforces it everywhere.
- **`AudioProcessingSettings`** fields: `schemaVersion`, `enabled`,
  `clientProcessing`, `presetName`, `preampDb`, `bands[]`, `nightMode`,
  `settingsVersion` (increments on every save), `settingsHash` (deterministic
  8-char djb2 hash of the audible state, for cheap change detection).
- **`toServerPayload()`** builds the server-facing subset (drops client-only
  schedule config like `nightStartTime`/`nightEndTime`).
- **Night mode** supports manual or scheduled activation with overnight windows
  (e.g. `22:00 → 06:00`); `computeEffectiveNow()` decides if it is active now.

### Persistence

- Key: **`sagetvng.audioProcessing.settings.v1`** (localStorage).
- `validateSettings()` sanitises every load: unknown fields dropped, missing
  fields defaulted, gains clamped, enums checked.
- `_migrate()` has a forward-compatible hook for future schema versions.

---

## Presets (`presets.js`)

`Flat, Rock, Pop, Jazz, Classical, Bass Boost, Treble Boost, Vocal, Loudness,
Custom`. Each is a 10-element dB array. Notable tuned curves:

- **Vocal** `[-4,-3,-1,1,2,3,4,3,1,-2]` — cuts sub-bass rumble, adds body at
  250 Hz, peaks presence at 1–4 kHz (consonant clarity), tames sibilant top.
- **Pop** `[-1,0,2,3,2,0,1,3,4,3]` — warm low-mids, forward vocals, airy top.
- **Classical** `[3,2,1,0,0,0,1,2,3,3]` — natural balance, smooth high extension.

`detectPreset()` reverse-maps current gains back to a preset name (or `Custom`).

---

## Web Audio engine (`web-audio-engine.js`)

Signal chain: **source → preamp (GainNode) → 10 peaking BiquadFilters →
DynamicsCompressor → destination**.

- **Preamp = volume boost.** `preampDb` is converted with `dbToLinear()` and
  applied to the GainNode, so it can exceed the native `<video>.volume` cap of
  1.0 (+6 dB ≈ 2×, +12 dB ≈ 4×). This is how SageTV's comparatively quiet audio
  gets amplified. It only works while audio is routed through Web Audio.
- **Night mode = DynamicsCompressorNode** with `LOW/MEDIUM/HIGH` presets;
  bypassed via unity/pass-through settings when inactive.
- **One-shot attach.** `createMediaElementSource()` can only be called **once**
  per media element. Therefore:
  - "Disable" / "hand off to server" does **not** disconnect the graph — it sets
    a **flat pass-through** (`_setFlat()`: preamp unity, all band gains 0). This
    guarantees no double-processing without killing audio.
  - `suspend()`/`resume()` are used for Page Visibility, not detach.
- Emits a `statechange` event carrying `{ attached, eqActive, nightModeActive,
  audioContextState }`.

---

## Playback attachment (the "why wasn't it working" fix)

The engine attaches to the video element lazily, only when playback actually
starts, via the player's `firstframe` event. Originally **only** the Tizen
AVPlay player dispatched `firstframe`; the browser MSE player did not, so
`attachEqEngine()` never ran in the browser and Web Audio silently never
attached. `player.js` now dispatches a one-time `firstframe` on the first native
`playing` event, so both paths attach correctly.

`attachEqEngine()` (in `app.js`) is intentionally gated:

```js
if (!settings.enabled || settings.clientProcessing === false) return;
```

> **Guardrail — net-neutral:** audio is only routed through Web Audio when the
> user has genuinely enabled client-side EQ. Everyone who never turns the EQ on
> keeps the default direct-audio path byte-for-byte unchanged.

Live changes (`settingschanged`) attach/adjust/bypass the graph immediately so
edits are audible without restarting playback.

---

## Client vs. server processing

The panel has a **"process on this device" (client)** toggle backed by
`settings.clientProcessing`:

- **Client (checked):** local Web Audio DSP. Only client-capable night mode
  (DRC) is offered.
- **Server (unchecked):** settings are pushed to the server and the client graph
  is made flat (transparent) so it never double-processes. Server-only night
  modes (Loudness Leveling, Platform Night Mode) become relevant.
  - ⚠️ **The server EQ is not implemented yet**, so unchecking currently
    produces *no audible processing*. The panel shows an honest
    "Server EQ not available yet" note rather than pretending.
- **Hidden entirely on Tizen AVPlay**, where client DSP is impossible.

---

## Capability & DSP reporting (`capability-reporter.js`)

`CapabilityReporter.getCapabilities(playbackPath)` returns an honest capability
object:

- `clientKind`: `PWA_TIZEN` or `PWA_BROWSER`.
- `supportsClientDsp = webAudioAvailable && playbackPath !== 'avplay'`.
  **AVPlay never advertises client DSP** (audio pipeline is outside browser
  scope). HTML5_MSE / HTML5 video may, when Web Audio is present.
- `supportsPreamp`, `supportsNightMode`, `nightModeControllability`,
  `supportedBands: 10`, `gainRangeDb: [-12, 12]`, `needsServerDsp`.

`app.js` registers a delegate on the connection and pushes updates over the
existing **client-feedback channel** (no protocol/binary changes):

| Push | When |
| --- | --- |
| `AUDIO_PROCESSING_CAPABILITIES` | On init (`wireEqToConnection`) |
| `AUDIO_PROCESSING_SETTINGS` | On every `settingschanged` and night-mode schedule flip |
| `AUDIO_PROCESSING_DSP_ACTIVE` | On attach, and on Page Visibility hidden/visible |

These are fire-and-forget; the server safely ignores them until it implements
the plan.

---

## Page Visibility handling

On `visibilitychange`:

- **hidden →** `engine.suspend()` + push `DSP_ACTIVE {active:false, reason:'page_hidden'}`.
- **visible →** `engine.resume()`; if attached, push
  `DSP_ACTIVE {active:true, reason:'page_visible'}`.

A 60 s timer re-evaluates the night-mode schedule and re-applies/pushes when
`effectiveNow` flips.

---

## UI notes

- Sliders are **vertical** (`writing-mode: vertical-lr; direction: rtl;`), each
  with a live dB readout.
- **Preamp / "Pre"** slider and its label/value are styled light-blue with a
  horizontal-line fader thumb, to mark it as the volume boost rather than a band.
- **Status badge** shows `CLIENT`, `SERVER`, or `NONE`, reflecting what is
  actually happening (never an aspirational claim).
- Tizen remote focus navigation is supported in the panel (arrow keys move
  focus, Enter toggles/edits, Back closes); pointer-only controls are avoided.

---

## Platform matrix

| Platform / path | Client DSP? | Preamp / night mode? | Notes |
| --- | --- | --- | --- |
| Desktop/Android browser (HTML5 video/MSE) | ✅ (Web Audio) | ✅ | Primary path |
| Tizen HTML5_MSE | ✅ (after verified attach) | ✅ | Reuses browser code |
| Tizen AVPlay | ❌ | ❌ | Client toggle hidden; reports `supportsClientDsp=false` |
| Any path, EQ off | — | — | Direct audio path, untouched (net-neutral) |

---

## Testing

```
node --test public/js/audio-processing/*.test.js
```

Covers persistence/load/migration, slider → `settingsVersion`/hash updates,
feature detection, DSP-active reporting, plan obedience / double-processing
prevention, and Page Visibility behavior. Session tests mock `AudioContext`.

---

## Change history

| Commit | Summary |
| --- | --- |
| `aa1f8b0` | Initial Audio Equalizer / AudioProcessing v1 (all modules, tests, protocol wiring) |
| `dd54b89` | Visible vertical sliders, honest status badge, clearer night mode |
| `7ec4d48` | Live dB readouts, preamp as light-blue volume boost, refined presets |
| `59d6d8b` | Fix engine never attaching in browser (`firstframe`) + Client/Server toggle |
| `3d5beef` | Nav drawer buttons shrunk ~60% to fit without scrolling |
| `6bfb2cb` | Nav drawer Back arrow flipped vertically |
| `9c72452` | Gate Web Audio attach on client processing (net-neutral) |

---

## Known constraints / future work

- **Server `AudioProcessingPlan` unimplemented** — "server mode" is inert today.
- **No true engine detach** — `createMediaElementSource` is one-shot; bypass is
  flat pass-through, not disconnect.
- **AVPlay client DSP** intentionally unsupported in v1; would require a verified,
  controllable app-scoped DSP path that does not exist yet.
