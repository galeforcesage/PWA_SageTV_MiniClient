# Tizen Deployment (Samsung TV)

This folder is the Samsung TV packaging target for the shared PWA client.
App logic stays in `public/`; this folder only contains Tizen wrapper/config files.

## What You Get

- A `.wgt` package you can sideload to a Samsung TV in Developer Mode
- Full-screen launcher entry on the TV home screen
- Shared codebase with browser/iPad/desktop clients (no fork)

## Prerequisites

1. Samsung TV on the same LAN as your dev machine
2. TV Developer Mode enabled
3. Tizen Studio CLI tools installed (`tizen`, `sdb`)
4. A Samsung certificate profile configured in Tizen Studio
5. Node.js installed (for prepare script)

## 1) Enable Developer Mode On The TV

1. Open Apps on the TV.
2. On the remote, enter `12345`.
3. In Developer Mode:
	- Set Developer Mode = On
	- Enter your PC IP address as Developer IP
4. Reboot the TV.

## 2) Prepare The Tizen App Payload

From repo root:

```powershell
npm run tizen:prepare
```

This copies shared app assets to `deploy/tizen/public`.

## 3) Ensure Required Icon Exists

`deploy/tizen/config.xml` references `icons/icon-512.png`.

Before packaging, place your launcher icon at:

- `deploy/tizen/icons/icon-512.png`

If this file is missing, packaging can fail.

## 4) Package A Signed .wgt

From repo root:

```powershell
tizen package -t wgt -s <YOUR_CERT_PROFILE> -- deploy/tizen
```

Expected output is a `.wgt` under `deploy/tizen`.

## 5) Connect To TV With SDB

Find your TV IP, then:

```powershell
sdb connect <TV_IP>:26101
sdb devices
```

You should see the TV listed as `device`.

## 6) Install The App On TV

From repo root:

```powershell
tizen install -n <PACKAGE_FILE.wgt> -t <TV_IP>
```

Example:

```powershell
tizen install -n SageTVMiniClient.wgt -t 192.0.2.10
```

## 7) Launch The App

Either launch from the TV home screen, or from CLI:

```powershell
tizen run -p org.sagetv.pwaminiclient -t <TV_IP>
```

The app ID comes from `deploy/tizen/config.xml`:

- `org.sagetv.pwaminiclient`

## 8) First Connection In App

When the app opens:

1. Add your SageTV bridge host
2. Use your bridge port (default `8099`)
3. Connect and verify remote navigation

## Updating After Code Changes

For each new build:

1. `npm run tizen:prepare`
2. `tizen package -t wgt -s <YOUR_CERT_PROFILE> -- deploy/tizen`
3. `tizen install -n <PACKAGE_FILE.wgt> -t <TV_IP>`

## Troubleshooting

### Packaging fails

- Confirm `deploy/tizen/icons/icon-512.png` exists
- Confirm certificate profile name is correct
- Confirm Tizen CLI can see your profile:

```powershell
tizen security-profiles list
```

### TV not found by CLI

- Re-check TV Developer Mode and Developer IP
- Reboot TV after toggling Developer Mode
- Re-run `sdb connect <TV_IP>:26101`

### Install fails with certificate or signature errors

- Rebuild package with the same cert profile used for that TV
- Ensure TV date/time is correct

### App opens but cannot connect

- Ensure bridge server is running and reachable from TV
- Ensure firewall allows TV -> bridge traffic on the configured port
- If using HTTPS/WSS, ensure your certificate chain is accepted by TV runtime

## Notes

- Keep Tizen-specific artifacts under `deploy/tizen/`
- Do not fork core app logic for Tizen
- Tizen MVP reports download/offline as unsupported in capability negotiation
