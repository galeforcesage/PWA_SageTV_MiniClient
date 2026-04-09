# PWA SageTV MiniClient

An HTML5/PWA implementation of the SageTV MiniClient protocol, enabling browser-based access to SageTV media servers from any device — iPad, PC, Android, and more.

## Features

- **Full SageTV protocol support** — Binary protocol, property negotiation, GFX command rendering
- **Encryption** — RSA key exchange + Blowfish event encryption
- **Compression** — ZLIB streaming decompression
- **Canvas 2D rendering** — Surfaces, transforms, textured drawing, font streaming
- **Input support** — Keyboard, mouse, touch gestures, gamepad, soft keyboard for mobile
- **PWA** — Installable, works offline (service worker), responsive design

## Architecture

```
Browser (PWA)          WebSocket Bridge (Node.js)         SageTV Server
┌─────────────┐       ┌──────────────────────┐          ┌─────────────┐
│  Canvas 2D  │──ws──▶│  ws-bridge.js :8099  │──tcp──▶  │  :31099     │
│  Input Mgr  │       │  (binary relay)      │          │  MiniUI     │
│  Media      │       └──────────────────────┘          └─────────────┘
└─────────────┘
```

## Quick Start

### Prerequisites
- Node.js 18+
- A running SageTV server

### Install & Run

```bash
git clone https://github.com/galeforcesage/PWA_SageTV_Miniclient.git
cd PWA_SageTV_Miniclient
npm install
npm run dev -- --sage-host YOUR_SAGETV_IP
```

Open `http://localhost:8099/` in your browser.

### CLI Options

```
--serve-static     Serve PWA files (default in dev mode)
--port 8099        Bridge port
--sage-host IP     Default SageTV server IP
--sage-port 31099  Default SageTV server port
```

## Project Structure

```
├── bridge/
│   └── ws-bridge.js          # WebSocket-to-TCP bridge
├── public/
│   ├── index.html             # PWA shell
│   ├── manifest.json          # PWA manifest
│   ├── sw.js                  # Service worker
│   ├── css/
│   │   └── app.css            # UI styles
│   └── js/
│       ├── app.js             # App entry point
│       ├── protocol/
│       │   ├── connection.js  # SageTV protocol engine
│       │   ├── constants.js   # Protocol constants
│       │   ├── crypto.js      # RSA + Blowfish encryption
│       │   ├── compression.js # ZLIB streaming inflate
│       │   └── binary-utils.js
│       ├── ui/
│       │   └── renderer.js    # Canvas 2D renderer
│       ├── input/
│       │   └── input-manager.js # Keyboard/mouse/touch/gamepad
│       ├── media/
│       │   └── player.js      # HTML5 media player
│       ├── session/
│       │   └── session-manager.js
│       ├── settings/
│       │   └── settings-manager.js
│       └── lib/
│           ├── forge.min.js   # node-forge (RSA)
│           ├── pako.esm.js    # pako (zlib)
│           └── blowfish-tables.js
└── package.json
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

## SageTV Plugin

This project is structured as a standard [SageTV V9 plugin](https://github.com/OpenSageTV/sagetv-plugin-repo) for easy installation via the SageTV Plugin Manager.

### Building the Plugin Package

```bash
./build-plugin.sh          # uses version from package.json
./build-plugin.sh 1.0.0    # or specify a version
```

This creates `pwa-miniclient-X.Y.Z.zip` and prints the MD5 hash.

### Publishing to SageTV Plugin Repo

1. Create a [GitHub Release](https://github.com/galeforcesage/PWA_SageTV_MiniClient/releases) tagged `vX.Y.Z`
2. Upload the zip to the release
3. Update `plugin/pwa-miniclient.xml` with the version, MD5, and download URL
4. Fork [sagetv-plugin-repo](https://github.com/OpenSageTV/sagetv-plugin-repo)
5. Copy `plugin/pwa-miniclient.xml` into the `plugins/` directory
6. Submit a Pull Request

### Local Dev Plugin Testing

To test as a SageTV dev plugin (requires `devmode=true` in `Sage.properties`):

1. Build the zip: `./build-plugin.sh`
2. Copy `pwa-miniclient-X.Y.Z.zip` to `SageTV/SageTVPluginsDev.d/`
3. Copy `plugin/pwa-miniclient.xml` to `SageTV/SageTVPluginsDev.d/`
4. SageTV will auto-detect and list it in the Plugin Manager

### Prerequisites on Server

- Node.js 18+ (for the WebSocket bridge)
- ffmpeg (for media transcoding; usually already on SageTV servers)

After plugin installation, the files are placed in `SageTV/pwa-miniclient/`. Run `start.sh` to launch the bridge.

## License

Apache 2.0 — see [LICENSE](LICENSE)

## Acknowledgments

Based on the [SageTV MiniClient](https://github.com/OpenSageTV/sagetv-miniclient) Android app.
