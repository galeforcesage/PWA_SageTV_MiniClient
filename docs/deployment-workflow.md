# PWA MiniClient: Development → Deployment → Commit Workflow

## Architecture Overview

| Component | Runtime | Deployment Path |
|-----------|---------|-----------------|
| Java bridge (BridgeServer) | Inside SageTV JVM | `/opt/sagetv/server/JARs/pwa-miniclient-bridge-<ver>.jar` |
| PWA static files (JS/CSS/HTML) | Served from disk by bridge Jetty | `/opt/sagetv/server/pwa-miniclient/public/` |
| Node bridge (ws-bridge.js) | Standalone dev only | Not deployed to production |

**Port 8099** (TLS) + **8100** (plain HTTP) are served by the **Java bridge** inside the SageTV JVM.

---

## Step 1: Build (on Windows dev machine)

### Build the shadow JAR (Java bridge)

```powershell
cd bridge-java
.\gradlew.bat shadowJar
# Output: bridge-java\build\libs\pwa-miniclient-bridge-<version>.jar
```

### Build plugin release ZIPs (optional — for Plugin Manager)

```powershell
cd bridge-java
.\gradlew.bat pluginRelease
# Output:
#   bridge-java\build\plugin-release\pwa-miniclient-jar-<ver>.zip   (the shadow JAR)
#   bridge-java\build\plugin-release\pwa-miniclient-web-<ver>.zip   (public/ tree)
```

---

## Step 2: Deploy to SageTV Container/Server

### ⚠️ CRITICAL RULES

1. **NEVER use PowerShell `Compress-Archive`** — backslash paths break Linux extraction.
2. **JAR changes require a full Sage JVM restart** (`stopsage`/`startsage`).
3. **Static file changes (JS/CSS/HTML) do NOT require restart** — just overwrite on disk.
4. **Always verify md5 after transfer.**
5. **Always move old jar aside with `.prev-` suffix** (classpath duplication trap).

---

### Deploy JAR (Java bridge changes)

```powershell
# 1. Build
cd bridge-java
.\gradlew.bat shadowJar

# 2. Transfer JAR to server
scp build\libs\pwa-miniclient-bridge-<ver>.jar user@192.168.0.75:/tmp/

# 3. SSH to server — stop, swap, start
ssh user@192.168.0.75
```

```bash
# On the server:
cd /opt/sagetv/server

# Stop SageTV
sudo /opt/sagetv/server/stopsage

# Move old jar aside (classpath duplication trap)
mv JARs/pwa-miniclient-bridge-*.jar \
   JARs/pwa-miniclient-bridge.jar.prev-$(date +%Y%m%d-%H%M%S)

# Install new jar
cp /tmp/pwa-miniclient-bridge-<ver>.jar JARs/

# Restart SageTV
sudo /opt/sagetv/server/startsage
```

---

### Deploy Static Files (JS/CSS/HTML changes only — NO restart needed)

```powershell
# From repo root on Windows:
scp -r public/* user@192.168.0.75:/opt/sagetv/server/pwa-miniclient/public/
```

Or for a single file:
```powershell
scp public\js\media\ng-playback-context-client.js user@192.168.0.75:/opt/sagetv/server/pwa-miniclient/public/js/media/
```

**Verify the deploy (from Windows):**
```powershell
# Check a file you just deployed has the expected content
ssh user@192.168.0.75 "md5sum /opt/sagetv/server/pwa-miniclient/public/js/media/ng-playback-context-client.js"
# Compare with local:
Get-FileHash public\js\media\ng-playback-context-client.js -Algorithm MD5
```

---

### Deploy Both JAR + Static (full deploy)

```powershell
# 1. Build shadow JAR
cd bridge-java
.\gradlew.bat shadowJar
cd ..

# 2. Transfer everything
scp bridge-java\build\libs\pwa-miniclient-bridge-<ver>.jar user@192.168.0.75:/tmp/
scp -r public user@192.168.0.75:/tmp/pwa-public-deploy/
```

```bash
# On the server:
cd /opt/sagetv/server

# Stop
sudo stopsage

# JAR swap
mv JARs/pwa-miniclient-bridge-*.jar \
   JARs/pwa-miniclient-bridge.jar.prev-$(date +%Y%m%d-%H%M%S)
cp /tmp/pwa-miniclient-bridge-<ver>.jar JARs/

# Static files
cp -r /tmp/pwa-public-deploy/* pwa-miniclient/public/

# Start
sudo startsage

# Cleanup
rm -rf /tmp/pwa-public-deploy /tmp/pwa-miniclient-bridge-*.jar
```

---

## Step 3: Verify After Deploy

### Check SageTV started cleanly
```bash
# Watch logs for bridge startup message
tail -f /opt/sagetv/server/logs/sagetv_0.txt | grep -i "PWA\|Bridge\|8099"
```

Expected: `PWA MiniClient Bridge running on ports 8099 (TLS) and 8100 (plain HTTP)`

### Test the NG endpoint
```bash
# From the server itself (bypass TLS for quick test):
curl -k https://localhost:8099/ng/playback-context/current
# Expected: {"type":"NG_PLAYBACK_CONTEXT_UNAVAILABLE","reason":"no_active_session"}

# Unknown /ng route:
curl -k https://localhost:8099/ng/foo
# Expected: {"type":"NG_PLAYBACK_CONTEXT_UNAVAILABLE","reason":"unknown_ng_route"}

# Static files still work:
curl -k -o /dev/null -w "%{http_code}" https://localhost:8099/index.html
# Expected: 200
```

### From the browser
```
https://192.168.0.75:8099/ng/playback-context/current
→ JSON response (not HTML 404)
```

---

## Step 4: Git Commit Instructions

### Branch workflow
```powershell
# Ensure you're on the feature branch
git branch --show-current
# Should be: galeforcesage-pwa-vs-fork-audit (or your feature branch)

# Stage changes
git add -A

# Commit with descriptive message + co-author trailer
git commit -m "feat(bridge): describe the change concisely

- Bullet points for what changed
- Why it changed
- What the expected behavior is

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"

# Push
git push origin <branch-name>
```

### Commit message format
```
<type>(<scope>): <short description>

<body - what and why>

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`  
Scopes: `bridge`, `client`, `protocol`, `media`, `settings`

### PR workflow
```powershell
gh pr create --title "feat: description" --body "..." --base main
# Or update existing PR:
gh pr edit <number> --body "updated description"
```

---

## Quick Reference: What Needs Restart?

| Change Type | Restart Required? | Deploy Method |
|-------------|-------------------|---------------|
| Java bridge code (*.java) | ✅ YES — stopsage/startsage | Build JAR → scp → swap → restart |
| Static JS/CSS/HTML (public/*) | ❌ NO | scp directly to disk |
| Node bridge (ws-bridge.js) | N/A (dev only) | Not deployed to production |
| Sage.properties changes | ✅ YES (most settings) | Edit file → restart |
| SageTVPluginsDev.xml version bump | ❌ (detected on refresh) | Edit XML → Plugin Manager picks up |

---

## Traps to Avoid

1. **PowerShell `Compress-Archive`** → backslash paths → silent extraction failure on Linux
2. **Old JARs left in JARs/** → classpath duplication → unpredictable class loading
3. **Deploying JAR but not `public/`** → old JS served from disk overrides new embedded resources
4. **PowerShell nested SSH quoting** → write to `.sh` file, scp, run with `tr -d '\015'`
5. **Forgetting CRLF** → use `\015` not `\r` in `tr` argument on Linux
6. **Hot-reload expectations** → Java classes NEVER hot-reload; always restart
