# Agent Instructions

## Tizen TV Deployment

### Build & Install (the ONLY correct way)

```bash
cd <repo-root>

# 1. Sync all public/ files into deploy/tizen/public/
node deploy/tizen/prepare-tizen-package.mjs

# 2. Package (signs with SageTV_PWA cert), install to TV, and launch
node deploy/tizen/build-tizen.mjs --install --run
```

**DO NOT** manually copy individual JS files, run `tizen.bat package` by hand,
or use `sdb push`. The build scripts handle signing, file sync, wgt naming
(spaces break installs), sdb connect, uninstall/install, and app launch.

### Configuration

- **`deploy/tizen/tizen.local.json`** — TV IP, cert profile, app ID, CLI paths
- **`deploy/tizen/config.xml`** — Tizen app manifest (privileges, content src)
- TV IP changes frequently (DHCP) — update `serial` in `tizen.local.json`

### Prerequisites

- TV must have **Developer Mode enabled**: Apps → gear icon → Developer Mode ON
- Developer mode **auto-disables after TV reboot** — re-enable before deploying
- sdb must be connected: `sdb connect <ip>:26101`

### Key Facts

- The Tizen app is a **packaged web app** — JS is bundled in the .wgt, NOT
  loaded from the server. Every JS change requires a full rebuild + reinstall.
- The signing profile is `SageTV_PWA` (certs in `~/SamsungCertificate/SageTV_PWA/`; not committed)
- The packaged app loads `public/index.html` locally (not from server)
- `prepare-tizen-package.mjs` copies `public/` → `deploy/tizen/public/`

---

## Bridge JAR Deployment

```bash
# Build
cd bridge-java
.\gradlew.bat shadowJar   # outputs to build/libs/pwa-miniclient-bridge-*.jar

# Deploy to container
scp bridge-java/build/libs/pwa-miniclient-bridge-*.jar <SSH_USER>@<SERVER_IP>:/tmp/pwa-bridge.jar
ssh <SSH_USER>@<SERVER_IP> "docker cp /tmp/pwa-bridge.jar <CONTAINER>:/opt/sagetv/server/JARs/pwa-miniclient-bridge-1.0.0.3.jar"

# Restart SageTV PROCESS (not the container!)
ssh <SSH_USER>@<SERVER_IP> "docker exec <CONTAINER> /opt/sagetv/server/stopsage"
# wait a few seconds
ssh <SSH_USER>@<SERVER_IP> "docker exec <CONTAINER> /opt/sagetv/server/startsage"
```

**NEVER** `docker restart` the container — only restart the SageTV process.

---

## PWA JS Deployment (server-side, for browser/Shield clients)

JS changes for non-Tizen clients are served from the server filesystem:

```bash
scp public/js/media/avplay-player.js <SSH_USER>@<SERVER_IP>:/tmp/
ssh <SSH_USER>@<SERVER_IP> "docker cp /tmp/avplay-player.js <CONTAINER>:/opt/sagetv/server/pwa-miniclient/public/js/media/avplay-player.js"
```

Server path is `/opt/sagetv/server/pwa-miniclient/public/` — note the `public/` subdirectory.
Static JS changes do NOT require a SageTV restart (served directly from disk).

---

## Server Access

- SSH: `<SSH_USER>@<SERVER_IP>` (passwordless cert)
- Container: `<CONTAINER>` (Docker, `--network host`)
- Bridge ports: 8099 (TLS), 8100 (plain HTTP)
- MediaServer port: 7818 (inside container, localhost only)
- Logs: `/opt/sagetv/server/sagetv_0.txt` (logback, rolling `_1`, `_2`, etc.)
- Bridge SLF4J logs appear in `sagetv_0.txt` via `sage.stderr` at ERROR level
  (not actually errors — just the routing path)

## TV Info

- Samsung TV (4K, 120Hz) — update model in `tizen.local.json` as needed
- TV IP changes — check `tizen.local.json` and update `serial` field
- AVPlay: supports HEVC 80Mbps, H.264 60Mbps, VP9 80Mbps, AV1 40Mbps
- `setDisplayRect` uses 1920×1080 coordinate space regardless of panel resolution
