SagaTV-NG PWA MiniClient for Samsung Tizen — Implementation PRD
Status: Draft implementation PRD
Product: SagaTV-NG PWA MiniClient for Samsung Smart TVs running Tizen OS
________________________________________
1. Problem Statement
SagaTV-NG needs a Samsung TV client that can run on Tizen-based Smart TVs without creating a separate product fork. The implementation should reuse the existing PWA MiniClient, add a thin Tizen deployment wrapper, report Tizen-specific capabilities to the server, and preserve existing behavior for desktop browsers, iPad, Windows, Android, and other non-Tizen clients.
________________________________________
2. Goals and Non-Goals
•	Deliver a Samsung Tizen deploy target for the existing SagaTV-NG PWA MiniClient.
•	Maintain one shared PWA codebase with small platform-specific conditionals only where required.
•	Support Samsung minimal Smart Remotes and fuller/basic Samsung remotes through capability detection.
•	Report platform, display, input, playback, device, and network capability hints to the SagaTV-NG server.
•	Allow the server to refine and persist per-client capability profiles based on observed playback results.
•	Prevent Tizen-specific behavior from changing standard browser, iPad, Windows, Android, or other clients.
Non-goals:
•	Do not invent a separate Tizen-only download/offline capability; reuse the existing SagaTV-NG/PWA capability model.
•	No native Tizen C++ client for MVP.
•	No separate long-term fork of the PWA.
•	No Samsung Store release requirement for MVP.
•	No DRM implementation for MVP.
•	No offline download support on Tizen for MVP.
•	No legacy server requirement; this target is for SagaTV-NG capability negotiation.
if platform-specific tuning is required ensure it doesn’t affect standard windows, ipad and etc) clients aren’t affected.
________________________________________
3. MVP Scope
The MVP SHALL provide a packaged Tizen Web Application that launches the existing PWA MiniClient full-screen, connects to the SagaTV-NG Node bridge over WebSocket, reports capabilities to the server, supports remote navigation, and plays compatible server-provided streams.
Preferred production mode: packaged Tizen Web Application using local app-shell assets and configurable server discovery or server URL entry.
•	Validation mode: load the PWA in the Samsung TV browser to test runtime compatibility before packaging.
•	Packaged mode: deploy as a .wgt package for full-screen launch and TV-home-screen installability during development.
•	Future mode: optional Samsung Store certification after MVP stability is proven.
👉 Therefore:
Mode	Works?	Notes
Load PWA in browser	✅	immediate, changes cannot affect existing PWA clients
Package PWA as Tizen app	✅	required for real UX
Install raw PWA like iPad	❌	no “Add to Home Screen” model
________________________________________
4. Architecture
The Tizen implementation SHALL be a deploy target, not a fork. The shared PWA remains the primary client. Tizen-specific code SHALL be isolated behind platform detection and feature capability checks.
Runtime flow:
1.	Tizen Web Application launches the PWA app shell.
2.	PWA detects platform and runtime capabilities.
3.	PWA connects to the SagaTV-NG Node bridge by WebSocket.
4.	Client sends capability handshake to server.
5.	Server seeds or updates the persistent client capability profile.
6.	Server selects direct-play, remux, or transcode strategy based on the profile.
7.	Client reports playback success, buffering, and failure events so the server can refine the profile.
👉 Implementation model:
if (platform === "tizen") {
  apply Tizen-specific tweaks
}
✅ This does NOT fork your app
✅ Does NOT affect iPad/browser clients
________________________________________
5. Repository and Deployment Layout
The implementation SHOULD add a dedicated deployment folder for Samsung TV without moving core PWA business logic into the deploy target.
•	deploy/tizen/ contains Samsung TV packaging files.
•	deploy/tizen/config.xml defines Tizen app metadata, privileges, launch file, orientation/fullscreen behavior where supported, and network access settings.
•	deploy/tizen/icons/ contains app icons and TV launcher assets.
•	deploy/tizen/index.html either hosts the copied PWA build output or bootstraps the packaged app shell.
•	deploy/tizen/build scripts copy the shared PWA build output into the Tizen package folder.
•	deploy/tizen/README.md documents build, signing, install, and test steps.
Packaging requirements:
•	Output artifact SHALL be a .wgt package.
•	Packaging SHALL require a Tizen signing profile for install on physical TVs.
•	The build process SHALL not duplicate or fork application logic.
•	Any Tizen-only configuration SHALL live under deploy/tizen or a clearly named platform-adapter module.
________________________________________
6. Platform Detection and Capability Handshake
The client SHALL detect whether it is running in a Tizen runtime and explicitly report that platform identity to the server. The server SHALL not rely only on user-agent parsing or app package identity.
Capability model: client-reported hints plus server validation loop.
1.	Client collects platform, display, input, playback, device, and network hints immediately after startup.
2.	Client sends CLIENT_CAPABILITIES after WebSocket connection and pairing/session establishment.
3.	Server seeds or updates clientId → capabilityProfile.
4.	Server selects stream strategy from the profile.
5.	Client sends CAPABILITY_UPDATE or PLAYBACK_FAILURE when observed behavior differs from the reported hints.
6.	Server refines, downgrades, or upgrades the persisted profile.
Node.js Bridge (WebSocket ↔ TCP)
     ↓
PWA MiniClient (JS / Canvas UI)
     ↓
Runs on:
  - Browser (desktop, iPad)
  - Tizen Web Runtime (Samsung TV)
✅ Same protocol
✅ Same rendering model
✅ Same networking layer
________________________________________
7. Capability Protocol
Capability names and field shapes in this PRD are illustrative unless they already exist in the SagaTV-NG/PWA protocol. Implementation SHALL reuse the existing SagaTV-NG capability names and message structures where present. New capability names SHALL NOT be introduced solely for the Tizen client unless the shared NG protocol is intentionally extended for all clients.
Message: CLIENT_CAPABILITIES
{ "type": "CLIENT_CAPABILITIES", "clientId": "stable-client-id", "platform": "tizen", "display": { "width": 3840, "height": 2160, "dpr": 1.5 }, "input": { "remoteProfile": "minimal", "hasArrows": true, "hasEnter": true, "hasBack": true, "hasMediaKeys": true, "hasColorKeys": false, "hasNumericKeys": false }, "playbackHints": { "canPlayMP4": true, "canPlayHLS": true, "canPlayHEVC": "unknown" }, "device": { "model": "optional", "osVersion": "optional" }, "network": { "online": true, "measuredLatencyMs": "optional" } }
  ├── config.xml
  ├── permissions
  ├── app metadata
  └── launches index.html (PWA)
👉 No business logic here
________________________________________
8. Functional Requirements
FR-1: PWA Execution
•	The MiniClient SHALL run inside the Tizen Web runtime as a packaged Web Application.
•	The same PWA application logic SHALL remain usable by non-Tizen clients.
•	The Tizen package SHALL load local packaged assets for MVP unless a remote PWA URL is explicitly configured for testing.
________________________________________
FR-2: Server Connectivity
•	The client SHALL connect via WebSocket to the Node bridge
•	The client SHALL support: 
o	LAN connectivity
o	persistent sessions
________________________________________
FR-3: UI Rendering
•	The client SHALL use existing Canvas rendering pipeline
•	The UI SHALL operate at TV-safe resolutions PWA will detect and report if possible (1080p / 4K / 6k / 8k)
________________________________________
FR-4: Remote Input and Remote Capability Profiles
The client SHALL support both Samsung minimal Smart Remote layouts, including VG-TM2360S-style remotes, and fuller/basic Samsung remotes with dedicated transport, number, channel, color, and function keys. The input layer SHALL normalize all detected Tizen key events into SagaTV-NG actions without requiring a fork of the PWA.
Remote Profile / Key	SagaTV-NG Action	Notes
Minimal Smart Remote: Up/Down/Left/Right	Navigation	Mandatory Tizen keys; no registration required.
Minimal Smart Remote: OK / Enter	Select	Primary selection action.
Minimal Smart Remote: Back / Exit long press	Back / exit UI	Back is mandatory; long-press Exit behavior SHALL be handled where exposed by Tizen.
Minimal Smart Remote: Play/Pause or on-screen virtual media key	Play/Pause	Register if present; otherwise expose equivalent on-screen controls.
Full/Basic Remote: dedicated Play, Pause, Stop, Rewind, Fast Forward	Transport controls	Register supported media keys and map long-press variants where available.
Full/Basic Remote: number keys	Direct channel entry / numeric input	If absent, client SHALL provide an on-screen numeric keypad or virtual-key path.
Full/Basic Remote: Channel Up/Down, Volume Up/Down, color keys	Channel navigation, volume pass-through, shortcut functions	Only advertise actions for keys confirmed by Tizen key support.
FR-4.1: Remote Detection
•	The Tizen client SHALL call the TV input-device API at startup to retrieve supported key names and key codes.
•	The client SHALL classify the active input environment as minimalRemote, fullRemote, or unknownRemote based on the keys actually reported by the TV runtime.
•	The client SHALL NOT rely solely on the physical remote model number because Tizen generally exposes supported keys and key events, not a guaranteed physical remote identifier.
•	VG-TM2360S-style Samsung Smart Remotes SHALL be treated as minimal remotes unless additional dedicated keys are reported.
FR-4.2: NG Capability Reporting to Server
•	The client SHALL report an input capability block during NG client capability negotiation.
•	The capability block SHALL include remoteProfile values of minimal, full, or unknown.
•	The capability block SHALL include booleans for key groups such as hasNumberKeys, hasDedicatedTransportKeys, hasChannelKeys, hasColorKeys, and hasVirtualKeyAccess.
•	The SagaTV-NG server SHALL understand these remote profiles and adapt UI command hints, shortcut availability, and optional server-side menu flows accordingly.
•	The server SHALL never assume full remote support from platform alone; it SHALL use the reported client capability data.
FR-4.3: Platform, Display, Playback, and Device Capability Handshake
The client SHALL report a structured capability payload when it connects to the SagaTV-NG server. If the client detects that it is running in the Tizen runtime, it SHALL explicitly report platform: "tizen" rather than requiring the server to infer the platform from user-agent strings or app packaging.
Capability detection SHALL be treated as client-reported hints plus a server validation loop. The client reports what the runtime exposes immediately, and the server refines the operational profile over time based on playback success, playback failure, stream compatibility, and observed network behavior.
•	Input: collect supported key names and key codes from the Tizen input-device API where available, including arrows, Enter, Back, media keys, color keys, and numeric keys.
•	Display: collect screen width, screen height, and device pixel ratio using standard web APIs.
•	Playback hints: collect browser playback support for MP4, HLS, and HEVC where detectable, but treat HEVC and high-bitrate playback as provisional until validated by real playback.
•	Device: collect model and OS/platform version only when exposed by the runtime and permitted by the deployment context.
•	Network: report online/offline state and optionally report measured latency or connection-quality observations gathered by the client.
Recommended capability schema:
{ "platform": "tizen", "display": { "width": 3840, "height": 2160, "dpr": 1.5 }, "input": { "hasArrows": true, "hasEnter": true, "hasBack": true, "hasMediaKeys": true, "hasColorKeys": false, "hasNumericKeys": false, "remoteProfile": "minimal" }, "playbackHints": { "canPlayMP4": true, "canPlayHLS": true, "canPlayHEVC": "unknown" }, "device": { "model": "optional", "osVersion": "optional" }, "network": { "online": true, "measuredLatencyMs": "optional" } }
FR-4.4: Storage, Download, and Offline Capability Reporting
•	The Tizen client SHALL report the existing SagaTV-NG/PWA download, offline playback, local-save, or persistent-storage capability as unsupported when that capability is not available or not valid in the Tizen runtime.
•	The Tizen client SHALL NOT expose download, offline playback, or local-file-save UI unless the runtime and server profile both confirm that the existing capability is supported.
•	Windows/Desktop PWA, iPad PWA, and other non-Tizen clients SHALL continue to report the existing download/offline capability according to their own runtime validation logic.
•	The server SHALL make download/offline UI and stream-preparation decisions from the reported existing capability, not from platform assumptions alone.
•	If the current PWA protocol already has a capability for downloads, offline use, file save, cache storage, or persistent storage, the implementation SHALL reuse that capability rather than creating a Tizen-specific replacement.
FR-4.5: Server-Refined Persistent Capability Profile
•	The server SHALL persist a capability profile per client identity, such as clientId → capabilityProfile.
•	The initial profile SHALL be seeded from the client-reported handshake payload.
•	The server SHALL refine the profile by testing or observing playback outcomes, including codec support, container support, bitrate tolerance, startup behavior, buffering, and failure modes.
•	The server MAY upgrade, downgrade, or mark capability fields as provisional based on observed behavior.
•	If playback fails, the client SHALL report the failure to the server, and the server SHALL downgrade or adjust the profile and retry with a more compatible stream profile.
________________________________________
FR-5: Media Playback
The client SHALL:
•	Use browser-native video playback capabilities
•	Support: 
o	MP4 (H.264 baseline)
o	HLS (if available)
o	HEVC (if available)
👉 Server must adapt container, bitrate, and codec to the client-reported capability hints, then refine those choices using observed playback success or failure.
________________________________________
FR-6: Deployment Modes
The system SHALL support:
Mode A — Browser
•	Launch via TV browser
•	No packaging required
Mode B — Packaged App
•	Installed as .wgt
•	Launchable from home screen
________________________________________
6. Non-Functional Requirements
NFR-1 — Performance
•	UI must remain responsive on low-power TV hardware
•	Rendering must avoid full-screen redraw where possible
________________________________________
NFR-2 — Compatibility
•	Single codebase must run on: 
o	Chrome/Safari (desktop/mobile)
o	Tizen Web runtime
________________________________________
NFR-3 — Network Stability
•	WebSocket reconnect logic required
•	Must handle TV sleep/resume cycles
________________________________________
NFR-4 — Input Responsiveness
•	Remote input latency must remain low and predictable
________________________________________
7. Tizen Packaging Requirements
7.1 Package Format
•	Output format: .wgt
•	Contains: 
o	HTML/JS/CSS (PWA)
o	config.xml
________________________________________
7.2 Installation Methods
Developer Mode
•	Push app from PC via network
•	Enable Developer Mode on TV
[developer....amsung.com]
USB Sideload
•	Install .wgt via USB
[asavvyweb.com]
App Store
•	Submit packaged app to Samsung store
________________________________________
8. Platform Adaptation Layer (Minimal)
8.1 Required Tweaks
These are expected but small:
A. Input Handling
•	Normalize remote keycodes
•	Map to your existing input system
________________________________________
B. Video Handling
•	Detect supported formats
•	Request compatible streams from server
________________________________________
C. Fullscreen Behavior
•	Force full-screen mode on launch
•	Disable browser UI
________________________________________
D. Performance Safeguards
•	Reduce animation complexity if needed
•	Adjust render loop
________________________________________
8.2 Conditional Platform Detection
Example approach:
const isTizen = typeof window.tizen !== "undefined";
👉 Used only for:
•	input mapping
•	playback tweaks
________________________________________
9. Risks & Constraints
Risk 1 — Codec Variability
•	Different TVs support different formats
Mitigation:
•	Server negotiation + fallback profiles
•	Use a persistent per-client capability profile that starts with client-reported hints and is refined by server-side validation and observed playback results.
________________________________________
Risk 2 — Hardware Performance
•	TVs weaker than tablets/PCs
Mitigation:
•	optimize rendering
•	limit redraw frequency
________________________________________
Risk 3 — Network Dependencies
•	Requires reachable bridge server
Mitigation:
•	retry + reconnect logic
________________________________________
Risk 4 — App Store Validation
•	Samsung requires stability and UX validation
________________________________________
10. Implementation Plan (Concrete)
Phase 1 — Zero Change Validation
•	Load PWA in Samsung browser
•	Verify: 
o	UI
o	input
o	playback
________________________________________
Phase 2 — Tizen Wrapper
•	Create: 
o	config.xml
o	package PWA → .wgt
•	Deploy via dev mode
________________________________________
Phase 3 — Platform Tweaks
•	Add: 
•	Add remote capability detection and NG capability reporting for minimal vs full Samsung remote profiles
o	input mapping
o	codec detection
o	fullscreen behavior
o	capability handshake payload for platform, display, input, playback hints, device info, and network status
o	server-side persistent capability profile with validation and downgrade feedback loop
o	validate existing download/offline capability reporting so Tizen reports unsupported while iPad, Windows, and browser PWAs continue using their runtime-specific capability detection
________________________________________
Phase 4 — Optimization
•	tune rendering
•	test across TV models
________________________________________
Phase 5 — Optional Store Release
•	package final build
•	submit for certification
________________________________________
✅ Final Answer to Your Core Question
Does Samsung need its own version of the PWA?
👉 No separate version.
You should build:
•	✅ One PWA codebase
•	✅ Add small platform-specific conditionals
•	✅ Wrap it as a Tizen app for installability
This:
•	does NOT break iPad
•	does NOT fork your code
•	keeps SagaTV-NG architecture clean

