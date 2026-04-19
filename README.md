# PWA SageTV MiniClient

An HTML5/PWA implementation of the SageTV MiniClient protocol, enabling browser-based access to SageTV media servers from any device — iPad, PC, Android, and more.

## Features

- **Full SageTV protocol support** — Binary protocol, property negotiation, GFX command rendering
- **Encryption** — RSA key exchange + Blowfish event encryption
- **Compression** — ZLIB streaming decompression
- **Canvas 2D rendering** — Surfaces, transforms, textured drawing, font streaming
- **Input support** — Keyboard, mouse, touch gestures, gamepad, soft keyboard for mobile
- **PWA** — Installable, works offline (service worker), responsive design
- **Authentication** — Optional HTTP Basic Auth for securing access
- **Hardware-accelerated transcoding** — GPU encoding via NVENC, QSV, VAAPI, or VideoToolbox

## Architecture

```
Browser (PWA)          Bridge (Jetty, Java)              SageTV Server
┌─────────────┐       ┌──────────────────────┐          ┌─────────────┐
│  Canvas 2D  │──ws──▶│  BridgeServer :8099  │──tcp──▶  │  :31099     │
│  Input Mgr  │       │  (WebSocket relay)   │          │  MiniUI     │
│  Media      │       │  (Transcode)         │          │             │
└─────────────┘       └──────────────────────┘          └─────────────┘
```

The Java bridge runs as a SageTV plugin (shadow JAR in `JARs/`). It embeds Jetty 11 for HTTP serving, WebSocket relay, and ffmpeg-based transcoding — all within the SageTV process.

> **Note:** An earlier Node.js bridge implementation (`bridge/ws-bridge.js`) is preserved in the repository for historical reference. It is no longer maintained — use the Java bridge for all deployments.

## Quick Start (SageTV Plugin)

### Prerequisites
- SageTV 9.x server with Java 11+
- ffmpeg on `PATH` (for media transcoding)

### Install

1. Build the plugin: `cd bridge-java && ./gradlew shadowJar`
2. Copy `build/libs/pwa-miniclient-bridge.jar` to `SageTV/JARs/`
3. Extract PWA static files to `SageTV/pwa-miniclient/public/`
4. Register the plugin in `Sage.properties`:
   ```properties
   sagetv_root_plugin_list/pwa-miniclient=pwa-miniclient
   ```
5. Restart SageTV
6. Open `http://{SageTV-IP}:8099` in your browser

### Plugin Configuration

Configure via the SageTV Plugin Manager UI, or directly in `Sage.properties`:

```properties
pwa_miniclient/port=8099
pwa_miniclient/web_root=                     # blank = auto-detect
pwa_miniclient/ffmpeg_path=                  # blank = 'ffmpeg' on PATH
pwa_miniclient/hwaccel=auto                  # auto|nvenc|qsv|vaapi|videotoolbox|none
pwa_miniclient/username=                     # blank = no auth
pwa_miniclient/password=                     # set both to enable Basic Auth
```

### Authentication

Set a username and password to require HTTP Basic Auth for all PWA endpoints:

1. Open the SageTV Plugin Manager → PWA MiniClient → Settings
2. Set **Username** and **Password**
3. Restart the plugin

When both are set, browsers will prompt for credentials before loading the PWA. Leave either blank to disable authentication (open access).

## Quick Start (Standalone)

The bridge can also run outside SageTV for development:

```bash
cd bridge-java
./gradlew shadowJar
java -jar build/libs/pwa-miniclient-bridge.jar \
  --port 8099 \
  --web-root ../public \
  --username admin \
  --password changeme
```

Open `http://localhost:8099/` and connect to your SageTV server.

## Project Structure

```
├── bridge-java/                   # Java bridge (primary)
│   ├── build.gradle
│   └── src/main/java/sagex/miniclient/pwa/
│       ├── BridgePlugin.java      # SageTV plugin entry point
│       ├── BridgeServer.java      # Jetty HTTP/WS server + auth
│       ├── BridgeWebSocket.java   # WebSocket-to-TCP relay
│       ├── BridgeMain.java        # Standalone entry point
│       ├── TranscodeServlet.java  # FFmpeg transcode endpoint
│       ├── ServerInfoServlet.java # GPU capability probe API
│       └── HwAccel.java           # Hardware acceleration detection
├── bridge/                        # Node.js bridge (legacy, preserved for reference)
│   └── ws-bridge.js
├── public/                        # PWA static files
│   ├── index.html
│   ├── manifest.json
│   ├── sw.js
│   ├── css/app.css
│   └── js/
│       ├── app.js
│       ├── protocol/              # SageTV protocol engine
│       │   ├── connection.js
│       │   ├── constants.js
│       │   ├── crypto.js
│       │   ├── compression.js
│       │   └── binary-utils.js
│       ├── ui/renderer.js         # Canvas 2D renderer
│       ├── input/input-manager.js # Keyboard/mouse/touch/gamepad
│       ├── media/player.js        # HTML5 media player
│       ├── session/session-manager.js
│       ├── settings/settings-manager.js
│       └── lib/                   # Vendored libraries
│           ├── forge.min.js       # node-forge (RSA)
│           ├── pako.esm.js        # pako (zlib)
│           └── blowfish-tables.js
├── plugin/
│   ├── pwa-miniclient.xml         # SageTV plugin manifest
│   └── screenshot.png
├── package.json                   # Node.js deps (legacy bridge only)
└── build-plugin.sh                # Plugin release packaging
```

## Protocol Support

| Feature | Status |
|---------|--------|
| Handshake | ✅ |
| Property negotiation | ✅ |
| ZLIB compression | ✅ |
| RSA/Blowfish encryption | ✅ |
| GFX drawing commands | ✅ |
| Image loading (raw + compressed) | ✅ |
| Surface compositing | ✅ |
| Transform stack | ✅ |
| Font streaming | ✅ |
| Text rendering (DRAWTEXT) | ✅ |
| Keyboard input | ✅ |
| Mouse/touch input | ✅ |
| Gamepad input | ✅ |
| Soft keyboard (iPad) | ✅ |
| MENU_HINT parsing | ✅ |
| Media playback | 🚧 |
| Reconnection | 🚧 |

## Screenshot

![PWA MiniClient Server Selection](plugin/screenshot.png)

## Hardware-Accelerated Transcoding

The bridge uses ffmpeg to transcode media for browser playback. By default (`hwaccel=auto`), it probes for a GPU encoder at startup and falls back to software (libx264) if none is found.

### Supported GPU Backends

| Backend | GPU | OS | ffmpeg Encoder |
|---------|-----|----|----------------|
| `nvenc` | NVIDIA GeForce/Quadro | Linux, Windows | `h264_nvenc` |
| `qsv` | Intel (integrated/Arc) | Linux, Windows | `h264_qsv` |
| `vaapi` | AMD/Intel | Linux only | `h264_vaapi` |
| `videotoolbox` | Apple Silicon/Intel | macOS | `h264_videotoolbox` |
| `none` | — | All | `libx264` (software) |

### Docker: Enabling GPU Access

Docker containers don't have GPU access by default. You must pass through the GPU device.

**NVIDIA GPU (nvenc):**
```bash
docker run --gpus all ...
```

**AMD/Intel GPU (vaapi):**
```bash
docker run --device /dev/dri:/dev/dri ...
```

For docker-compose, add to your SageTV service:
```yaml
services:
  sagetv-server:
    devices:
      - /dev/dri:/dev/dri          # AMD/Intel VAAPI
```

Check the SageTV server log to verify detection:
```
[HwAccel] Auto-detected: vaapi — VA-API (AMD/Intel GPU)
```

## SageTV Plugin Repo Publishing

1. Build release ZIPs: `cd bridge-java && ./gradlew pluginRelease`
2. Create a [GitHub Release](https://github.com/galeforcesage/PWA_SageTV_MiniClient/releases) tagged `vX.Y.Z`
3. Upload both ZIPs to the release
4. Update `plugin/pwa-miniclient.xml` with the new version, MD5 hashes, and download URLs
5. Fork [sagetv-plugin-repo](https://github.com/OpenSageTV/sagetv-plugin-repo)
6. Copy `plugin/pwa-miniclient.xml` into the `plugins/` directory
7. Submit a Pull Request

## License

Apache 2.0 — see [LICENSE](LICENSE)

## Acknowledgments

Based on the [SageTV MiniClient](https://github.com/OpenSageTV/sagetv-miniclient) Android app.
