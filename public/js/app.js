/**
 * SageTV MiniClient PWA - Application Entry Point
 *
 * Wires up the UI, session management, and PWA functionality.
 */

import { SessionManager } from './session/session-manager.js';
import { SageCommand } from './protocol/constants.js';
import { SpatialNavigation } from './input/spatial-nav.js';

// ── Globals ──────────────────────────────────────────────

const session = new SessionManager();
let touchNavVisible = false;
let wakeLockSentinel = null;
let hadActiveSession = false;
let resumeCheckTimer = null;
let _spatnav = null;

// ── DOM References ───────────────────────────────────────

const connectScreen = document.getElementById('connect-screen');
const clientScreen = document.getElementById('client-screen');
const canvas = document.getElementById('sage-canvas');
const video = document.getElementById('sage-video');
const container = document.getElementById('client-container');
const statusBar = document.getElementById('status-bar');
const statusBitrate = document.getElementById('status-bitrate');
const statusSignal = document.getElementById('status-signal');
const touchNav = document.getElementById('touch-nav');
const playOverlay = document.getElementById('play-overlay');
const seekingOverlay = document.getElementById('seeking-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const startupOverlay = document.getElementById('startup-overlay');
const reconnectBanner = document.getElementById('reconnect-banner');
const reconnectText = document.getElementById('reconnect-text');

// Server grid
const serverGrid = document.getElementById('server-grid');
const connectError = document.getElementById('connect-error');
const connectStatus = document.getElementById('connect-status');

// Dialogs
const addServerDialog = document.getElementById('add-server-dialog');
const settingsDialog = document.getElementById('settings-dialog');

// Tracks server being edited (null = adding new)
let _editingServer = null;

// Discovered (LAN scan) servers — IP-keyed, merged into the grid alongside
// saved entries. Cleared on each scan.
let _discoveredServers = [];
let _discoverInflight = false;

/**
 * Open the Add Server dialog pre-filled for editing an existing server card.
 */
function openEditServerDialog(card) {
  const host = card.dataset.host;
  const port = parseInt(card.dataset.port, 10) || 31099;
  const name = card.dataset.name || host;
  const bridgeUrl = card.dataset.bridgeUrl || '';
  _editingServer = { host, port };
  document.getElementById('dlg-server-name').value = name;
  document.getElementById('dlg-server-host').value = host;
  document.getElementById('dlg-bridge-url').value = bridgeUrl;
  document.getElementById('dlg-save').textContent = 'SAVE';
  document.getElementById('dlg-delete').hidden = false;
  document.getElementById('dlg-delete-confirm').hidden = true;
  addServerDialog.hidden = false;
  // Wait for layout after unhiding before focusing
  requestAnimationFrame(() => {
    const nameInput = document.getElementById('dlg-server-name');
    nameInput.focus();
    nameInput.setSelectionRange(0, nameInput.value.length);
  });
}

/**
 * Open the Add Server dialog pre-filled from a discovered (LAN-scan) card so
 * the user can name + save it. We don't auto-save: the user may want to set
 * a friendly name or a custom bridge URL.
 */
function openAddServerDialogForDiscovered(card) {
  const host = card.dataset.host;
  const name = card.dataset.name || host;
  const bridgeUrl = card.dataset.bridgeUrl || '';
  _editingServer = null;
  document.getElementById('dlg-server-name').value = name;
  document.getElementById('dlg-server-host').value = host;
  document.getElementById('dlg-bridge-url').value = bridgeUrl;
  document.getElementById('dlg-save').textContent = 'ADD';
  document.getElementById('dlg-delete').hidden = true;
  document.getElementById('dlg-delete-confirm').hidden = true;
  addServerDialog.hidden = false;
  requestAnimationFrame(() => {
    const nameInput = document.getElementById('dlg-server-name');
    nameInput.focus();
    nameInput.setSelectionRange(0, nameInput.value.length);
  });
}

/**
 * Build the ordered list of bridge base URLs to try for /discover.
 *
 * Priority:
 *   1. Every saved server's explicit bridgeUrl (ws:// → http://) — user
 *      intent trumps everything.
 *   2. window.location.origin if served over http(s) (i.e. running from a
 *      bridge in --serve-static mode).
 *   3. Each saved server's host on the default bridge ports, ordered so we
 *      try the scheme that matches the page origin first (avoids
 *      mixed-content blocks in browsers). For non-http origins (Tizen wgt,
 *      packaged installs), http://:8100 comes first because cert-strict
 *      WebViews can't accept the shipped self-signed cert on https://:8099.
 *
 * De-duplicated in priority order.
 */
function _resolveBridgeHttpBases() {
  const bases = [];
  const seen = new Set();
  const add = (u) => {
    if (!u) return;
    const clean = u.replace(/\/$/, '');
    if (seen.has(clean)) return;
    seen.add(clean);
    bases.push(clean);
  };

  const saved = session.getSavedServers() || [];
  for (const s of saved) {
    if (s.bridgeUrl) {
      add(s.bridgeUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
    }
  }
  const origin = window.location?.origin || '';
  if (/^https?:/i.test(origin) && !/^https?:\/\/(?:null|localhost\.local)/i.test(origin)) {
    add(origin);
  }
  const pageIsHttps = window.location?.protocol === 'https:';
  for (const s of saved) {
    if (!s.host) continue;
    if (pageIsHttps) {
      // Same-scheme first — plain http would be blocked by mixed content.
      add(`https://${s.host}:8099`);
      add(`http://${s.host}:8100`);
    } else {
      // Plain HTTP first — works in cert-strict WebViews (Tizen wgt, iOS
      // PWAs without our CA) and in dev-mode Node bridge over plain http.
      add(`http://${s.host}:8100`);
      add(`https://${s.host}:8099`);
    }
  }
  return bases;
}

/** @deprecated use _resolveBridgeHttpBases; kept for callers that want a single hint. */
function _resolveBridgeHttpBase() {
  return _resolveBridgeHttpBases()[0] || null;
}

// ── First-run LAN bootstrap (Tizen) ─────────────────────────
//
// Chicken-and-egg: on a freshly installed Tizen wgt there is no saved server
// and no http(s) origin (the app loads from the local package), so
// runDiscovery() has no bridge base to hit and no-ops. SageTV's own discovery
// is a UDP broadcast the browser can't send. We break the deadlock using the
// one platform capability a Tizen web app *does* have: tizen.systeminfo tells
// us the TV's own LAN IP. From that we derive the /24 and probe each host's
// cheap http://<host>:8100/api/server-info (the bridge's plain-HTTP port, no
// TLS cert needed) until one answers. That host is a bridge; we then ask it
// to run the real SageTV UDP discovery via /discover. LAN-scoped by design.

function _isUsableIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  if (ip === '0.0.0.0' || ip.startsWith('127.')) return false;
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Resolve the TV's own LAN IPv4 via tizen.systeminfo (ethernet first, then Wi-Fi). */
function _getTizenLanIp() {
  return new Promise((resolve) => {
    let tzsi = null;
    try { tzsi = window.tizen && tizen.systeminfo; } catch { tzsi = null; }
    if (!tzsi || typeof tzsi.getPropertyValue !== 'function') {
      resolve(null);
      return;
    }
    const tryProp = (prop) => new Promise((res) => {
      try {
        tzsi.getPropertyValue(prop,
          (data) => res(_isUsableIp(data?.ipAddress) ? data.ipAddress : null),
          () => res(null));
      } catch { res(null); }
    });
    // TVs are usually wired; try ethernet first, then Wi-Fi.
    tryProp('ETHERNET_NETWORK').then((eth) => {
      if (eth) { resolve(eth); return; }
      tryProp('WIFI_NETWORK').then((wifi) => resolve(wifi || null));
    });
  });
}

/**
 * Scan the local /24 for a PWA bridge and, if found, run its SageTV discovery.
 * Only meaningful when we have no bridge base yet (fresh Tizen install).
 * Returns true if a bridge was found and discovery populated the grid.
 */
async function bootstrapLanDiscovery({ silent = true } = {}) {
  if (_discoverInflight) return false;
  if (_resolveBridgeHttpBases().length > 0) return false; // already have a base

  const ip = await _getTizenLanIp();
  if (!ip) return false;
  const parts = ip.split('.');
  const base = parts.slice(0, 3).join('.');
  const ownLast = parseInt(parts[3], 10);

  // Probe order: gateway (.1) first, then ascending, skipping our own address.
  const order = [];
  const push = (n) => {
    if (n >= 1 && n <= 254 && n !== ownLast && !order.includes(n)) order.push(n);
  };
  push(1);
  for (let n = 1; n <= 254; n++) push(n);

  _discoverInflight = true;
  const btn = document.getElementById('btn-discover');
  const prevLabel = btn?.textContent;
  if (!silent && btn) { btn.textContent = 'Scanning…'; btn.disabled = true; }
  if (!silent) {
    connectStatus.textContent = `Scanning ${base}.0/24 for a SageTV bridge…`;
    connectStatus.hidden = false;
    connectError.hidden = true;
  }

  const CONCURRENCY = 20;
  const PROBE_TIMEOUT_MS = 900;
  let foundBase = null;
  let idx = 0;
  const controllers = new Set();

  const worker = async () => {
    while (foundBase === null && idx < order.length) {
      const n = order[idx++];
      const host = `${base}.${n}`;
      const ctrl = new AbortController();
      controllers.add(ctrl);
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const resp = await fetch(`http://${host}:8100/api/server-info`,
          { cache: 'no-store', signal: ctrl.signal });
        if (resp.ok && foundBase === null) foundBase = `http://${host}:8100`;
      } catch { /* refused / timeout / not a bridge */ }
      finally { clearTimeout(timer); controllers.delete(ctrl); }
    }
  };

  try {
    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
  } finally {
    for (const c of controllers) { try { c.abort(); } catch { /* ignore */ } }
  }

  if (!foundBase) {
    _discoverInflight = false;
    if (!silent && btn) { btn.textContent = prevLabel || 'Find on LAN'; btn.disabled = false; }
    if (!silent) {
      connectStatus.hidden = true;
      connectError.textContent = 'No SageTV bridge found on the local network.';
      connectError.hidden = false;
    }
    return false;
  }

  // Bridge found — ask it to run the real SageTV UDP discovery.
  let ok = false;
  try {
    const resp = await fetch(`${foundBase}/discover?force=1`, { cache: 'no-store' });
    const body = await resp.json();
    const rawServers = Array.isArray(body?.servers) ? body.servers : [];
    const bridgeWsUrl = foundBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    _discoveredServers = rawServers.map((s) => ({ ...s, _bridgeUrl: bridgeWsUrl }));
    if (!silent) {
      connectStatus.textContent = _discoveredServers.length
        ? `Found ${_discoveredServers.length} SageTV server${_discoveredServers.length === 1 ? '' : 's'}.`
        : 'Bridge found, but no SageTV servers responded.';
    }
    renderServerGrid();
    ok = _discoveredServers.length > 0;
  } catch (err) {
    if (!silent) {
      connectStatus.hidden = true;
      connectError.textContent = `Bridge found but discovery failed: ${err?.message || err}`;
      connectError.hidden = false;
    }
  } finally {
    _discoverInflight = false;
    if (!silent && btn) { btn.textContent = prevLabel || 'Find on LAN'; btn.disabled = false; }
  }
  return ok;
}

async function runDiscovery({ force = false, silent = false } = {}) {
  if (_discoverInflight) return;
  const bases = _resolveBridgeHttpBases();
  if (bases.length === 0) {
    if (!silent) {
      connectError.textContent = 'Add a server (or open this PWA from a bridge) before scanning the LAN.';
      connectError.hidden = false;
    }
    return;
  }
  _discoverInflight = true;
  const btn = document.getElementById('btn-discover');
  const prevLabel = btn?.textContent;
  if (!silent && btn) { btn.textContent = 'Scanning…'; btn.disabled = true; }
  if (!silent) {
    connectStatus.textContent = 'Scanning the LAN for SageTV servers…';
    connectStatus.hidden = false;
    connectError.hidden = true;
  }
  let firstErr = null;
  let usedBase = null;
  let rawServers = null;
  try {
    for (const base of bases) {
      try {
        const url = `${base}/discover${force ? '?force=1' : ''}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const body = await resp.json();
        rawServers = Array.isArray(body?.servers) ? body.servers : [];
        usedBase = base;
        break;
      } catch (err) {
        if (!firstErr) firstErr = err;
        console.debug('[Discovery]', base, 'failed:', err?.message || err);
      }
    }
    if (!usedBase) throw firstErr || new Error('no bridge reachable');
    // Convert the bridge's http(s) base into the ws(s) equivalent so a
    // discovered card can be saved with a working bridgeUrl without the
    // user having to type one.
    const bridgeWsUrl = usedBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    _discoveredServers = rawServers.map((s) => ({ ...s, _bridgeUrl: bridgeWsUrl }));
    if (!silent) {
      if (_discoveredServers.length === 0) {
        connectStatus.textContent = 'No SageTV servers found on this LAN.';
      } else {
        connectStatus.textContent = `Found ${_discoveredServers.length} server${_discoveredServers.length === 1 ? '' : 's'} on the LAN.`;
      }
    }
    renderServerGrid();
  } catch (err) {
    console.warn('[Discovery] failed:', err);
    if (!silent) {
      connectStatus.hidden = true;
      connectError.textContent = `LAN scan failed: ${err?.message || err}`;
      connectError.hidden = false;
    }
  } finally {
    _discoverInflight = false;
    if (!silent && btn) { btn.textContent = prevLabel || 'Find on LAN'; btn.disabled = false; }
    if (!silent) {
      setTimeout(() => { if (!connectError.hidden === false) connectStatus.hidden = true; }, 4000);
    }
  }
}

// ── Initialization ───────────────────────────────────────

async function init() {
  // Register service worker. Skip on Tizen TV: it's a packaged local app
  // (no offline benefit) and aggressive SW caching defeats reinstall-based
  // updates of the wgt.
  const _isTizen = typeof window !== 'undefined' && typeof window.tizen !== 'undefined';
  if ('serviceWorker' in navigator && !_isTizen) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      console.warn('Service worker registration failed:', e);
    }
  } else if (_isTizen && 'serviceWorker' in navigator) {
    // If a SW was registered by a previous build, unregister it and purge caches
    // so the freshly-installed wgt assets are actually served.
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { try { await r.unregister(); } catch { /* ignore */ } }
      if (typeof caches !== 'undefined' && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {
      console.warn('[Tizen] SW cleanup failed:', e?.message || e);
    }
  }

  // Initialize session (opens IndexedDB etc)
  await session.init(canvas, video, container);

  // Apply log level immediately on startup so high-volume debug logs do not
  // stall touch handling on iOS Safari or Tizen TV WebViews (both serialize
  // console output even without an attached inspector, and the per-frame
  // [GFX]/[Frame] chatter is enough to visibly slow menu navigation).
  const isIOS = /iPhone|iPad/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const slowConsole = isIOS || _isTizen;
  const configuredLogLevel = session.settings.get('log_level', slowConsole ? 'warn' : 'info');
  _applyLogLevel(slowConsole && configuredLogLevel === 'debug' ? 'warn' : configuredLogLevel);

  // Render server cards from cookies
  renderServerGrid();

  // Universal D-pad / arrow-key navigation for connect screen and dialogs.
  // Inactive during playback (input-manager forwards keys to SageTV then).
  _spatnav = new SpatialNavigation();
  _spatnav.start();

  // Silently pull the bridge's warm LAN-scan cache and merge discovered
  // servers into the grid. No-op if we don't yet know any bridge URL.
  runDiscovery({ silent: true });

  // Fresh Tizen install: no saved server + no http origin means runDiscovery()
  // above has nothing to hit. Bootstrap by scanning the LAN for a bridge using
  // the TV's own IP (LAN-only; SageTV discovery is LAN-scoped). Runs silently
  // in the background so the connect screen stays responsive.
  if (_isTizen && (session.getSavedServers() || []).length === 0) {
    bootstrapLanDiscovery({ silent: true });
  }

  // Tizen TV hardware back/exit key.
  // Without this listener the WebView exits the app on Back. Route Back to
  // the client screen (SageTV BACK command) or to dialog/drawer close on
  // the connect screen. Fall through to app exit only when nothing is open.
  if (_isTizen) {
    // On a TV the floating buttons are unreachable by the D-pad remote, and
    // every one of their functions is available elsewhere on Tizen:
    //   ⛶ fullscreen — useless (the app is always full-screen)
    //   ☰ nav-menu   — opens the popup, which long-press OK already does
    //   ⏻ power      — disconnect, now in the popup's "Session" section
    // Hide all three so the TV UI only shows remote-reachable controls.
    for (const id of ['btn-fullscreen', 'btn-nav-menu', 'btn-disconnect']) {
      document.getElementById(id)?.setAttribute('hidden', '');
    }

    document.addEventListener('tizenhwkey', (e) => {
      const name = String(e.keyName || '').toLowerCase();
      if (name !== 'back') return;
      e.preventDefault();
      e.stopPropagation();
      // handleTizenBack unwinds open UI (drawer, dialogs) or sends BACK to
      // SageTV. When it returns false there is nothing left to unwind — we're
      // at the connect screen with no dialogs — so quit the app. With
      // hwkey-event="enable" the WebView does NOT auto-exit on Back, so we must
      // call exit() explicitly or the user is stranded with no way out.
      if (!handleTizenBack()) {
        exitTizenApp();
      }
    });
  }

  // Check for iPad Safari install prompt
  checkInstallPrompt();

  // Wire up events
  setupEventHandlers();

  console.log('[App] SageTV MiniClient PWA initialized');
}

async function refreshWakeLock(forceRelease = false) {
  const wantsWakeLock = session.settings.get('keep_screen_on', 'true') === 'true';
  const canWakeLock = 'wakeLock' in navigator;
  // Tizen power API — Samsung TVs don't expose navigator.wakeLock, so use
  // the native tizen.power.request('SCREEN', 'SCREEN_NORMAL') fallback so
  // the setting is actually honored on-device.
  const tizenPower = (typeof window !== 'undefined' && window.tizen && window.tizen.power) || null;

  if (forceRelease || !session.connected || !wantsWakeLock || document.visibilityState !== 'visible') {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch {
        // ignore release failures
      }
      wakeLockSentinel = null;
    }
    if (tizenPower) {
      try { tizenPower.release('SCREEN'); } catch { /* ignore */ }
    }
    return;
  }

  if (tizenPower) {
    try {
      tizenPower.request('SCREEN', 'SCREEN_NORMAL');
    } catch (err) {
      console.debug('[App] tizen.power.request failed:', err?.message || err);
    }
  }

  if (!canWakeLock) return;
  if (wakeLockSentinel) return;

  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    }, { once: true });
  } catch (err) {
    console.debug('[App] Wake lock unavailable:', err?.message || err);
  }
}

function scheduleResumeCheck() {
  if (!hadActiveSession || !session.connection?.resumeIfDead) {
    return;
  }
  clearTimeout(resumeCheckTimer);
  resumeCheckTimer = setTimeout(() => {
    resumeCheckTimer = null;
    session.connection?.resumeIfDead?.().catch((err) => {
      console.warn('[App] resumeIfDead failed:', err?.message || err);
    });
  }, 150);
}

// ── Event Handlers ───────────────────────────────────────

function setupEventHandlers() {
  // Add Server button
  document.getElementById('btn-add-server').addEventListener('click', () => {
    _editingServer = null;
    document.getElementById('dlg-server-name').value = 'My Server';
    document.getElementById('dlg-server-host').value = '';
    document.getElementById('dlg-bridge-url').value = '';
    document.getElementById('dlg-save').textContent = 'ADD';
    document.getElementById('dlg-delete').hidden = true;
    document.getElementById('dlg-delete-confirm').hidden = true;
    addServerDialog.hidden = false;
    // Wait for layout after unhiding before focusing
    requestAnimationFrame(() => {
      document.getElementById('dlg-server-host').focus();
    });
  });

  // Find on LAN button — asks the bridge to broadcast SageTV locator probes
  // and renders any replies as discovered cards next to the saved ones.
  // If we have no bridge base yet (fresh Tizen install), first scan the LAN
  // for a bridge using the TV's own IP, then run discovery on it.
  document.getElementById('btn-discover')?.addEventListener('click', () => {
    if (_resolveBridgeHttpBases().length === 0) {
      bootstrapLanDiscovery({ silent: false });
    } else {
      runDiscovery({ force: true });
    }
  });

  // Add/Edit Server dialog — Save
  document.getElementById('dlg-save').addEventListener('click', () => {
    const name = document.getElementById('dlg-server-name').value.trim();
    const host = document.getElementById('dlg-server-host').value.trim();
    if (!host) {
      document.getElementById('dlg-server-host').focus();
      return;
    }
    if (!name) {
      document.getElementById('dlg-server-name').focus();
      return;
    }
    const bridgeUrl = document.getElementById('dlg-bridge-url').value.trim() || undefined;

    // If editing an existing server with a changed host, remove the old entry first
    if (_editingServer && (_editingServer.host !== host || _editingServer.port !== 31099)) {
      session.settings.removeSavedServer(_editingServer.host, _editingServer.port);
    }

    session.settings.addSavedServer(host, 31099, name, bridgeUrl);
    _editingServer = null;
    addServerDialog.hidden = true;
    renderServerGrid();
    // Newly-added server may include a bridgeUrl we didn't have before,
    // giving us a base to hit /discover on. Try it silently.
    runDiscovery({ silent: true });
  });

  // Add/Edit Server dialog — Cancel
  document.getElementById('dlg-cancel')?.addEventListener('click', () => {
    _editingServer = null;
    addServerDialog.hidden = true;
  });

  // Keyboard shortcuts for the Add/Edit Server dialog
  addServerDialog.addEventListener('keydown', (e) => {
    // Do NOT intercept Enter on text inputs. On Tizen TV, pressing OK while
    // an <input> is focused is what invokes the on-screen keyboard (IME).
    // If we swallow it and click Save, the empty-required-field validator
    // re-focuses the same input in a loop, and the user can never type.
    if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('dlg-save').click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      _editingServer = null;
      addServerDialog.hidden = true;
    }
  });

  // Add/Edit Server dialog — Delete (show confirmation)
  document.getElementById('dlg-delete')?.addEventListener('click', () => {
    document.getElementById('dlg-delete-confirm').hidden = false;
  });

  // Delete confirmation — OK
  document.getElementById('dlg-delete-ok')?.addEventListener('click', () => {
    if (_editingServer) {
      session.settings.removeSavedServer(_editingServer.host, _editingServer.port);
      _editingServer = null;
      document.getElementById('dlg-delete-confirm').hidden = true;
      addServerDialog.hidden = true;
      renderServerGrid();
    }
  });

  // Delete confirmation — Cancel
  document.getElementById('dlg-delete-no')?.addEventListener('click', () => {
    document.getElementById('dlg-delete-confirm').hidden = true;
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-configure').addEventListener('click', (e) => {
    e.preventDefault();
    openSettings();
  });

  // Settings dialog — Save
  document.getElementById('set-save').addEventListener('click', saveSettings);

  // Settings dialog — direct D-pad/keyboard routing for Save/Cancel.
  // Spatial-nav's geometric neighbor search sometimes prefers an in-scroll
  // candidate over the action row (especially when the last scroll item is
  // a `<summary>` at the top of the last group and Save is far below).
  // Belt-and-suspenders: when D-pad Down is pressed and the current focus
  // is the last focusable inside .settings-scroll, jump to Save. When Up
  // is pressed on Save/Cancel, jump back to that last focusable.
  const scrollFocusableSelector = 'button:not([disabled]):not([hidden]),a[href],'
    + 'input:not([type="hidden"]):not([disabled]):not([hidden]),'
    + 'select:not([disabled]),textarea,summary,[tabindex]:not([tabindex="-1"])';
  settingsDialog.addEventListener('keydown', (e) => {
    if (settingsDialog.hidden) return;
    const key = e.key || e.code;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const scroll = settingsDialog.querySelector('.settings-scroll');
    if (!scroll) return;
    const saveBtn = document.getElementById('set-save');
    const cancelBtn = document.getElementById('set-cancel');
    const active = document.activeElement;
    const list = Array.from(scroll.querySelectorAll(scrollFocusableSelector))
      .filter((el) => el.offsetParent !== null);
    const last = list[list.length - 1];
    if (key === 'ArrowDown' && active === last && saveBtn) {
      saveBtn.focus();
      e.preventDefault();
      e.stopPropagation();
    } else if (key === 'ArrowUp' && (active === saveBtn || active === cancelBtn) && last) {
      last.focus();
      try { last.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    }
  }, true); // capture so we win before spatial-nav

  // Settings dialog — Cancel
  document.getElementById('set-cancel').addEventListener('click', () => {
    settingsDialog.hidden = true;
  });

  // Power button — gracefully closes session and returns to connect screen.
  // Some touch browsers intermittently miss click on floating overlays, so
  // handle pointer/touch/click explicitly and block passthrough to canvas.
  const btnDisconnect = document.getElementById('btn-disconnect');
  const onDisconnectPress = (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDisconnect();
  };
  if (btnDisconnect) {
    btnDisconnect.addEventListener('pointerup', onDisconnectPress);
    btnDisconnect.addEventListener('touchend', onDisconnectPress, { passive: false });
    btnDisconnect.addEventListener('click', onDisconnectPress);
  }

  // Fullscreen
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    // Hide status bar in fullscreen, show when windowed
    if (statusBar) statusBar.hidden = !!document.fullscreenElement;
    // Trigger resize after fullscreen transition settles
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 200);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 500);
  });

  // Touch nav toggle (button removed)
  const btnTouchNav = document.getElementById('btn-touch-nav');
  if (btnTouchNav) btnTouchNav.addEventListener('click', () => {
    touchNavVisible = !touchNavVisible;
    touchNav.hidden = !touchNavVisible;
  });

  // Touch nav buttons
  touchNav.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmdId = parseInt(btn.dataset.cmd, 10);
      if (!isNaN(cmdId)) session.sendCommand(cmdId);
    });
  });

  // ── Navigation Drawer (swipe from left edge or mouse drag) ──
  initNavDrawer();

  // Play overlay (autoplay unblock)
  document.getElementById('btn-play').addEventListener('click', () => {
    video.muted = false;
    session.mediaPlayer?.play();
    playOverlay.hidden = true;
  });

  // Status bar update interval
  let statusBarInterval = null;
  function startStatusBar() {
    initStatusBarGauge();
    if (statusBar) statusBar.hidden = !!document.fullscreenElement;
    statusBarInterval = setInterval(updateStatusBar, 1000);
  }
  function stopStatusBar() {
    if (statusBarInterval) { clearInterval(statusBarInterval); statusBarInterval = null; }
    if (statusBar) statusBar.hidden = true;
  }

  // Session events
  session.addEventListener('connecting', () => {
    connectStatus.hidden = false;
    connectStatus.innerHTML = '<span class="spinner"></span> Connecting...';
    connectError.hidden = true;
  });

  session.addEventListener('connected', () => {
    hadActiveSession = true;
    showScreen('client');
    // Cover the black canvas with a branded loading screen until the server
    // sends its first frame. connect-status lives on the (now hidden) connect
    // screen, so without this the user would see pure black for several
    // seconds while SageTV builds the menu server-side.
    startupOverlay.hidden = false;
    canvas.focus();
    startStatusBar();
    refreshWakeLock().catch(() => {});
    clientScreen.addEventListener('pointerdown', () => {
      session.mediaPlayer?.primePlayback?.().catch?.(() => {});
    }, { capture: true, once: true });
  });

  session.addEventListener('firstframe', () => {
    connectStatus.hidden = true;
    startupOverlay.hidden = true;
    session._onResize();
  });

  session.addEventListener('disconnected', (e) => {
    stopStatusBar();
    refreshWakeLock(true).catch(() => {});
    startupOverlay.hidden = true;
    const reason = e.detail?.reason;
    if (reason === 'user' || reason === 'exit') {
      // User clicked disconnect or SageTV exit — return to connect screen cleanly
      showScreen('connect');
    } else if (reason) {
      showScreen('connect');
      connectError.textContent = `Disconnected: ${reason}`;
      connectError.hidden = false;
    }
    connectStatus.hidden = true;
  });

  session.addEventListener('error', (e) => {
    showScreen('connect');
    startupOverlay.hidden = true;
    connectError.textContent = `Connection failed: ${e.detail?.error?.message || 'unknown error'}`;
    connectError.hidden = false;
    connectStatus.hidden = true;
  });

  session.addEventListener('reconnecting', (e) => {
    reconnectBanner.hidden = false;
    reconnectText.textContent = `Reconnecting (attempt ${e.detail?.attempt || '?'})...`;
  });

  session.addEventListener('reconnected', () => {
    reconnectBanner.hidden = true;
  });

  session.addEventListener('reconnectfailed', () => {
    reconnectBanner.hidden = true;
    refreshWakeLock(true).catch(() => {});
    showScreen('connect');
    connectError.textContent = 'Lost connection to server.';
    connectError.hidden = false;
  });

  const showWarningToast = (message, timeoutMs = 10000) => {
    let toast = document.getElementById('codec-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'codec-toast';
      toast.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
        'background:rgba(200,40,40,0.92);color:#fff;padding:10px 20px;border-radius:8px;' +
        'font-size:14px;z-index:9999;max-width:80vw;text-align:center;pointer-events:none;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.4);';
      document.body.appendChild(toast);
    }
    toast.textContent = `⚠ ${message}`;
    toast.hidden = false;
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.hidden = true; }, timeoutMs);
  };

  // Push mode codec mismatch warning
  session.addEventListener('codecerror', (e) => {
    const msg = e.detail.message || 'Unsupported media codec in push stream';
    console.warn('[App] Codec error:', msg);
    showWarningToast(msg, 10000);
  });

  session.addEventListener('playbackfailure', (e) => {
    const reason = e.detail?.reason || 'Playback failed';
    console.warn('[App] Playback failure:', reason, e.detail || {});
    showWarningToast(`Playback fallback engaged (${reason})`, 7000);
  });

  session.addEventListener('capabilityupdate', (e) => {
    const reason = e.detail?.reason || 'runtime-observation';
    console.log('[App] Capability update:', reason, e.detail?.patch || e.detail || {});
  });

  // Media player autoplay blocked
  if (session.mediaPlayer) {
    session.mediaPlayer.addEventListener('playblocked', () => {
      playOverlay.hidden = false;
    });
    // Auto-dismiss the overlay if playback actually starts (Tizen retry path,
    // or the user tapping through the block on desktop). Without this, the
    // big blue play button can linger over live video on TV remotes.
    if (session.mediaPlayer.video) {
      session.mediaPlayer.video.addEventListener('playing', () => {
        playOverlay.hidden = true;
        loadingOverlay.hidden = true;
      });
    }
    // Show a deliberate loading spinner while the opening of a stream buffers
    // (or during a mid-stream rebuffer), so the user never sees the frozen
    // first frame. Cleared by 'playing' above.
    session.mediaPlayer.addEventListener('buffering', () => {
      loadingOverlay.hidden = false;
    });
    session.mediaPlayer.addEventListener('seeking', () => {
      seekingOverlay.hidden = false;
    });
    session.mediaPlayer.addEventListener('seeked', () => {
      seekingOverlay.hidden = true;
    });
    // Safety: ensure the loading spinner is cleared when playback ends/stops.
    session.mediaPlayer.addEventListener('eos', () => { loadingOverlay.hidden = true; });
    session.mediaPlayer.addEventListener('stopped', () => { loadingOverlay.hidden = true; });
  }

  // Window beforeunload
  window.addEventListener('beforeunload', () => {
    if (session.connected) session.disconnect();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshWakeLock().catch(() => {});
      scheduleResumeCheck();
    } else {
      refreshWakeLock(true).catch(() => {});
    }
  });

  window.addEventListener('pageshow', () => {
    refreshWakeLock().catch(() => {});
    scheduleResumeCheck();
  });

  clientScreen.addEventListener('gesturestart', (e) => e.preventDefault());
  clientScreen.addEventListener('gesturechange', (e) => e.preventDefault());

  // Triple-tap on canvas to show toolbar (touch devices like iPad)
  let tapCount = 0, tapTimer = null;
  clientScreen.addEventListener('touchstart', (e) => {
    if (e.touches.length === 3) {
      handleDisconnect();
    }
  }, { passive: true });

  // Close modals on overlay click
  for (const overlay of [addServerDialog, settingsDialog]) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
  }
}

// ── Server Grid ──────────────────────────────────────────

function renderServerGrid() {
  const servers = session.getSavedServers();
  const savedKeys = new Set(servers.map((s) => `${s.host}:${s.port || 31099}`));
  const lanOnly = _discoveredServers.filter(
    (d) => !savedKeys.has(`${d.host}:${d.port || 31099}`)
  );

  if (servers.length === 0 && lanOnly.length === 0) {
    serverGrid.innerHTML = '<p style="color:rgba(255,255,255,0.4); font-size:14px;">No servers. Click <b>Add Server</b> or <b>Find on LAN</b> to get started.</p>';
    return;
  }

  let html = '';
  for (const s of servers) {
    const name = escapeHtml(s.name || s.host);
    const host = escapeHtml(s.host);
    const port = s.port || 31099;
    html += `
      <div class="server-card" tabindex="0" data-host="${escapeAttr(s.host)}" data-port="${port}" data-name="${escapeAttr(s.name || '')}" data-bridge-url="${escapeAttr(s.bridgeUrl || '')}">
        <button class="card-edit" title="Edit server">✎</button>
        <button class="card-delete" title="Remove server">✕</button>
        <div class="card-icon"></div>
        <div class="card-name">${name}</div>
        <div class="card-host">${host}${port !== 31099 ? ':' + port : ''}</div>
      </div>`;
  }
  for (const d of lanOnly) {
    const name = escapeHtml(d.name || d.host);
    const host = escapeHtml(d.host);
    const port = d.port || 31099;
    html += `
      <div class="server-card server-card-discovered" tabindex="0" data-host="${escapeAttr(d.host)}" data-port="${port}" data-name="${escapeAttr(d.name || '')}" data-bridge-url="${escapeAttr(d._bridgeUrl || '')}" data-discovered="1">
        <div class="card-badge">LAN</div>
        <div class="card-icon"></div>
        <div class="card-name">${name}</div>
        <div class="card-host">${host}${port !== 31099 ? ':' + port : ''}</div>
      </div>`;
  }
  serverGrid.innerHTML = html;
  if (_spatnav) _spatnav.refresh();

  // Click card → connect (saved) or open Add dialog pre-filled (discovered).
  // Long-press (touch or remote OK) opens edit mode for saved cards.
  serverGrid.querySelectorAll('.server-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('card-delete') || e.target.classList.contains('card-edit')) return;
      // Suppress the connect action if the click was synthesized after a
      // long-press (touch or remote OK-hold) that opened edit mode.
      if (card.dataset.longPressFired === '1') {
        delete card.dataset.longPressFired;
        return;
      }
      if (card.dataset.discovered === '1') {
        openAddServerDialogForDiscovered(card);
        return;
      }
      const host = card.dataset.host;
      const port = parseInt(card.dataset.port, 10) || 31099;
      handleConnect(host, port);
    });

    // Right-click → edit (only for saved cards)
    card.addEventListener('contextmenu', (e) => {
      if (card.dataset.discovered === '1') return;
      e.preventDefault();
      openEditServerDialog(card);
    });

    // Long-press → edit (touch devices, saved only)
    let lpTimer = null;
    card.addEventListener('touchstart', () => {
      if (card.dataset.discovered === '1') return;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        card.dataset.longPressFired = '1';
        openEditServerDialog(card);
      }, 600);
    }, { passive: true });
    card.addEventListener('touchend', () => { if (lpTimer) clearTimeout(lpTimer); });
    card.addEventListener('touchmove', () => { if (lpTimer) clearTimeout(lpTimer); });

    // Long-press → edit (TV remote OK-hold, saved only). Tizen and other TV
    // remotes lack right-click and touch; holding OK is the accepted TV
    // equivalent for "contextual action". Uses the same 600ms threshold.
    let kbLpTimer = null;
    card.addEventListener('keydown', (e) => {
      if (card.dataset.discovered === '1') return;
      if (e.key !== 'Enter' || e.repeat || kbLpTimer) return;
      kbLpTimer = setTimeout(() => {
        kbLpTimer = null;
        card.dataset.longPressFired = '1';
        openEditServerDialog(card);
      }, 600);
    });
    card.addEventListener('keyup', (e) => {
      if (e.key !== 'Enter') return;
      if (kbLpTimer) { clearTimeout(kbLpTimer); kbLpTimer = null; }
    });
  });

  // Edit button
  serverGrid.querySelectorAll('.card-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditServerDialog(btn.closest('.server-card'));
    });
  });

  // Delete button
  serverGrid.querySelectorAll('.card-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.server-card');
      session.settings.removeSavedServer(card.dataset.host, parseInt(card.dataset.port, 10));
      renderServerGrid();
    });
  });
}

// ── Connect / Disconnect ─────────────────────────────────

async function handleConnect(host, port) {
  if (!host) return;
  connectError.hidden = true;

  session.mediaPlayer?.primePlayback?.().catch?.(() => {});

  // Find bridge URL from the per-server config
  const servers = session.getSavedServers();
  const srv = servers.find(s => s.host === host && s.port === port);
  const bridgeUrl = srv?.bridgeUrl || undefined;

  try {
    await session.connect(host, port, bridgeUrl);
    // Update lastUsed on the server cookie
    if (srv) session.settings.addSavedServer(srv.host, srv.port, srv.name, srv.bridgeUrl);
  } catch (err) {
    console.error('[App] Connect failed:', err);
  }
}

function handleDisconnect() {
  session.disconnect();
  showScreen('connect');
}

/**
 * Quit the Tizen app to the TV home. Requires no special privilege. No-op off
 * Tizen (browsers close via their own chrome).
 */
function exitTizenApp() {
  try {
    if (typeof tizen !== 'undefined' && tizen.application) {
      console.log('[App] Exiting Tizen application');
      tizen.application.getCurrentApplication().exit();
    }
  } catch (e) {
    console.warn('[App] tizen.application exit failed:', e?.message || e);
  }
}

/**
 * Handle Tizen Back/Exit hardware key. Returns true when handled so caller
 * can preventDefault(). Priority: dismiss modal overlays first, then the
 * nav drawer, then send BACK to SageTV (client screen), then close the
 * add-server/settings dialogs (connect screen). Only when nothing is open
 * do we return false and let the WebView exit the app.
 */
function handleTizenBack() {
  // Close nav drawer if open.
  const drawer = document.getElementById('nav-drawer');
  if (drawer && !drawer.hidden && drawer.classList.contains('open')) {
    document.dispatchEvent(new CustomEvent('sagetv:close-nav-drawer'));
    return true;
  }
  // Close touch-nav overlay if visible.
  if (touchNav && !touchNav.hidden) {
    touchNavVisible = false;
    touchNav.hidden = true;
    return true;
  }
  // On the client screen, forward to SageTV as BACK so the STV can unwind.
  if (clientScreen && !clientScreen.hidden && clientScreen.classList.contains('active')) {
    if (session.connected) {
      session.sendCommand(SageCommand.BACK.id);
      return true;
    }
  }
  // On the connect screen, close dialogs if open.
  if (addServerDialog && !addServerDialog.hidden) {
    addServerDialog.hidden = true;
    return true;
  }
  if (settingsDialog && !settingsDialog.hidden) {
    settingsDialog.hidden = true;
    return true;
  }
  return false;
}

// ── Settings Dialog ──────────────────────────────────────

/** Populate a <select> with SageCommand options */
function populateCmdSelect(select, selectedName) {
  if (select.options.length > 0) {
    // Already populated, just set value
    select.value = selectedName || 'None';
    return;
  }
  const cmds = [
    'None', 'Left', 'Right', 'Up', 'Down', 'Select', 'Back', 'Options', 'Menu',
    'Home', 'Guide', 'Info', 'Search', 'Play/Pause', 'Play', 'Pause', 'Stop',
    'Skip Fwd/Page Right', 'Skip Bkwd/Page Left', 'Page Up', 'Page Down',
    'Channel Up/Page Up', 'Channel Down/Page Down', 'Volume Up', 'Volume Down', 'Mute',
    'Full Screen', 'Record', 'Delete', 'Favorite',
  ];
  for (const name of cmds) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = selectedName || 'None';
}

function openSettings() {
  const g = (k, d) => session.settings.get(k, d);

  // General
  document.getElementById('set-auto-connect').checked = g('auto_connect', 'false') === 'true';
  document.getElementById('set-auto-connect-delay').value = g('auto_connect_delay', '10');
  document.getElementById('set-keep-screen-on').checked = g('keep_screen_on', 'true') === 'true';
  document.getElementById('set-exit-on-standby').checked = g('exit_on_standby', 'true') === 'true';
  document.getElementById('set-image-cache').value = g('image_cache_size_mb', '96');
  document.getElementById('set-log-level').value = g('log_level', 'debug');

  // Connection
  const w = g('resolution_width', '1280');
  const h = g('resolution_height', '720');
  document.getElementById('set-resolution').value = `${w}x${h}`;

  // Streaming
  document.getElementById('set-streaming-mode').value = g('streaming_mode', 'fixed');

  // Transcoding
  document.getElementById('set-transcode-vcodec').value = g('fixed_encoding/video_codec', 'H.264');
  document.getElementById('set-transcode-pref').value = g('fixed_encoding/preference', 'needed');
  document.getElementById('set-transcode-format').value = g('fixed_encoding/format', 'matroska');
  document.getElementById('set-transcode-vbitrate').value = g('fixed_encoding/video_bitrate_kbps', '4000');
  document.getElementById('set-transcode-vres').value = g('fixed_encoding/video_resolution', 'SOURCE');
  document.getElementById('set-transcode-fps').value = g('fixed_encoding/video_fps', 'SOURCE');
  document.getElementById('set-transcode-acodec').value = g('fixed_encoding/audio_codec', 'ac3');
  document.getElementById('set-transcode-abitrate').value = g('fixed_encoding/audio_bitrate_kbps', '128');
  document.getElementById('set-transcode-achannels').value = g('fixed_encoding/audio_channels', '');

  // Update server profile display and show/hide codec options based on
  // BOTH server encoder availability AND client decode capability. An option
  // is only useful if the server can produce it AND the client can play it.
  const profile = session.connection?.serverProfile;
  const clientCaps = session.connection?.getProbedCapabilities?.() || { video: '', audio: '', pull: '' };
  const clientVideoCodecs = new Set(clientCaps.video.split(',').filter(Boolean));
  const clientAudioCodecs = new Set(clientCaps.audio.split(',').filter(Boolean));
  const clientPullContainers = new Set(clientCaps.pull.split(',').filter(Boolean));
  const profileEl = document.getElementById('set-server-profile');
  if (profile && profile.serverFfmpeg) {
    const ver = profile.serverFfmpeg.version || 'unknown';
    const type = profile.serverType === 'modern'
      ? `SageTVffmpeg ${ver} (HEVC capable)`
      : `Legacy SageTVffmpeg (${ver})`;
    profileEl.textContent = type;
    profileEl.style.color = profile.serverType === 'modern' ? '#4caf50' : '#aaa';
  } else {
    profileEl.textContent = 'Not connected';
    profileEl.style.color = '#aaa';
  }
  // HEVC: needs server encoder AND client decoder.
  const showHevc = !!profile?.hasHevc && clientVideoCodecs.has('HEVC');
  document.querySelectorAll('.opt-hevc').forEach(el => {
    el.style.display = showHevc ? '' : 'none';
  });
  // Opus: needs server encoder AND client decoder.
  const showOpus = !!profile?.hasOpus && clientAudioCodecs.has('OPUS');
  document.querySelectorAll('.opt-opus').forEach(el => {
    el.style.display = showOpus ? '' : 'none';
  });
  // EAC3 / E-AC-3: server-side "eac3" encoder is standard in modern ffmpeg;
  // Tizen and most current TVs decode it natively. Client probes for
  // audio/eac3 (or codecs="ec-3") and adds EAC3 to the audio codec list.
  const serverHasEac3 = !!(profile?.serverFfmpeg?.encoders && (
    profile.serverFfmpeg.encoders.includes('eac3') ||
    profile.serverFfmpeg.encoders.includes('e-ac-3')
  ));
  const showEac3 = serverHasEac3 && clientAudioCodecs.has('EAC3');
  document.querySelectorAll('.opt-eac3').forEach(el => {
    el.style.display = showEac3 ? '' : 'none';
  });
  // Container formats: hide those the client can't consume via pull mode
  // (transcoded output is delivered via HTTP progressive, so the container
  //  must be one the browser's native player can parse).
  //   MPEG-TS  -> MPEG2-TS       (advertised when client has native MP2T)
  //   MKV      -> MATROSKA       (mkv containers)
  //   DVD (PS) -> MPEG2-PS       (only Tizen advertises this today)
  const transcodeFormatOpts = {
    mpegts: clientPullContainers.has('MPEG2-TS'),
    matroska: clientPullContainers.has('MATROSKA'),
    dvd: clientPullContainers.has('MPEG2-PS'),
  };
  document.querySelectorAll('#set-transcode-format option').forEach(opt => {
    const supported = transcodeFormatOpts[opt.value];
    // Always leave the default (mpegts) visible so the field is never empty;
    // hide only clearly unsupported containers.
    if (supported === false && opt.value !== 'mpegts') {
      opt.style.display = 'none';
    } else {
      opt.style.display = '';
    }
  });

  // Remuxing
  document.getElementById('set-remux-pref').value = g('fixed_remuxing/preference', 'needed');
  document.getElementById('set-remux-format').value = g('fixed_remuxing/format', 'matroska');

  // Key Mappings
  document.getElementById('set-key-repeat').value = g('key_repeat_ms', '100');
  document.getElementById('set-key-repeat-delay').value = g('key_repeat_delay_ms', '1000');

  // Touch/Mouse Mappings
  const touchFields = ['swipe-left', 'swipe-right', 'swipe-up', 'swipe-down',
                        'double-tap', 'long-press', 'edge-swipe-top', 'edge-swipe-bottom'];
  const touchKeys = ['swipe_left', 'swipe_right', 'swipe_up', 'swipe_down',
                      'double_tap', 'long_press', 'edge_swipe_top', 'edge_swipe_bottom'];
  const touchDefaults = ['Left', 'Right', 'Up', 'Down', 'Select', 'Options', 'Menu', 'Options'];
  for (let i = 0; i < touchFields.length; i++) {
    populateCmdSelect(document.getElementById(`set-${touchFields[i]}`), g(touchKeys[i], touchDefaults[i]));
  }

  // Codecs
  document.getElementById('set-extra-vcodecs').value = g('extra_video_codecs', '');
  document.getElementById('set-extra-acodecs').value = g('extra_audio_codecs', '');

  // About
  document.getElementById('set-client-id').textContent =
    localStorage.getItem('sagetv_mac') || '(not set)';

  // Available memory
  const memInfo = navigator.deviceMemory
    ? `${navigator.deviceMemory} GB device memory`
    : 'Not available';
  const jsHeap = performance.memory
    ? `${(performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} MB heap limit, ${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB used`
    : memInfo;
  document.getElementById('set-available-memory').textContent = jsHeap;

  // Expand every collapsible group. On TV/D-pad the user can't reach items
  // inside a closed <details> (they render with offsetParent=null, so the
  // spatial navigator skips them); expanding on open makes every option
  // reachable via arrow keys.
  for (const d of settingsDialog.querySelectorAll('details.settings-group')) {
    d.open = true;
  }

  settingsDialog.hidden = false;
}

function saveSettings() {
  const s = (k, v) => session.settings.set(k, v);

  // General
  s('auto_connect', document.getElementById('set-auto-connect').checked ? 'true' : 'false');
  s('auto_connect_delay', document.getElementById('set-auto-connect-delay').value);
  s('keep_screen_on', document.getElementById('set-keep-screen-on').checked ? 'true' : 'false');
  s('exit_on_standby', document.getElementById('set-exit-on-standby').checked ? 'true' : 'false');
  s('image_cache_size_mb', document.getElementById('set-image-cache').value);
  s('log_level', document.getElementById('set-log-level').value);

  // Connection
  const [rw, rh] = document.getElementById('set-resolution').value.split('x');
  s('resolution_width', rw);
  s('resolution_height', rh);

  // Streaming
  s('streaming_mode', document.getElementById('set-streaming-mode').value);

  // Transcoding
  s('fixed_encoding/video_codec', document.getElementById('set-transcode-vcodec').value);
  s('fixed_encoding/preference', document.getElementById('set-transcode-pref').value);
  s('fixed_encoding/format', document.getElementById('set-transcode-format').value);
  s('fixed_encoding/video_bitrate_kbps', document.getElementById('set-transcode-vbitrate').value);
  s('fixed_encoding/video_resolution', document.getElementById('set-transcode-vres').value);
  s('fixed_encoding/video_fps', document.getElementById('set-transcode-fps').value);
  s('fixed_encoding/audio_codec', document.getElementById('set-transcode-acodec').value);
  s('fixed_encoding/audio_bitrate_kbps', document.getElementById('set-transcode-abitrate').value);
  s('fixed_encoding/audio_channels', document.getElementById('set-transcode-achannels').value);

  // Remuxing
  s('fixed_remuxing/preference', document.getElementById('set-remux-pref').value);
  s('fixed_remuxing/format', document.getElementById('set-remux-format').value);

  // Key Mappings
  s('key_repeat_ms', document.getElementById('set-key-repeat').value);
  s('key_repeat_delay_ms', document.getElementById('set-key-repeat-delay').value);

  // Touch/Mouse Mappings
  const touchFields = ['swipe-left', 'swipe-right', 'swipe-up', 'swipe-down',
                        'double-tap', 'long-press', 'edge-swipe-top', 'edge-swipe-bottom'];
  const touchKeys = ['swipe_left', 'swipe_right', 'swipe_up', 'swipe_down',
                      'double_tap', 'long_press', 'edge_swipe_top', 'edge_swipe_bottom'];
  for (let i = 0; i < touchFields.length; i++) {
    s(touchKeys[i], document.getElementById(`set-${touchFields[i]}`).value);
  }

  // Codecs
  s('extra_video_codecs', document.getElementById('set-extra-vcodecs').value.trim());
  s('extra_audio_codecs', document.getElementById('set-extra-acodecs').value.trim());

  // Apply log level immediately
  _applyLogLevel(document.getElementById('set-log-level').value);

  refreshWakeLock().catch(() => {});

  settingsDialog.hidden = true;
}

/** Apply log level — suppress console methods below the chosen level */
function _applyLogLevel(level) {
  const noop = () => {};
  const levels = ['debug', 'info', 'warn', 'error'];
  const idx = levels.indexOf(level);
  // Restore all first (in case level was raised then lowered)
  if (window._origConsole) {
    console.log = window._origConsole.log;
    console.info = window._origConsole.info;
    console.warn = window._origConsole.warn;
    console.error = window._origConsole.error;
  } else {
    window._origConsole = {
      log: console.log, info: console.info, warn: console.warn, error: console.error,
    };
  }
  if (idx > 0) console.log = noop;
  if (idx > 1) console.info = noop;
  if (idx > 2) console.warn = noop;
  // Never suppress console.error
}

// ── Screen Navigation ────────────────────────────────────

function showScreen(name) {
  connectScreen.classList.toggle('active', name === 'connect');
  clientScreen.classList.toggle('active', name === 'client');
  if (_spatnav && name === 'connect') _spatnav.refresh();
}

// ── Fullscreen ───────────────────────────────────────────

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    (clientScreen.requestFullscreen || clientScreen.webkitRequestFullscreen)
      .call(clientScreen)
      .catch(() => {});
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen)
      .call(document)
      .catch(() => {});
  }
}

// ── Status Bar ───────────────────────────────────────────

const STATUS_BAR_DIVS = 15; // matches SageTV Placeshifter's 15-bar gauge
const STATUS_BAR_MAX_BUFFER = 15; // max buffer seconds for full gauge (matches SageTV's maxBufferTime=15000ms)

function initStatusBarGauge() {
  if (!statusSignal) return;
  statusSignal.innerHTML = '';
  for (let i = 0; i < STATUS_BAR_DIVS; i++) {
    const bar = document.createElement('span');
    bar.className = 'bar';
    statusSignal.appendChild(bar);
  }
}

function updateStatusBar() {
  const conn = session.connection;
  if (!conn || !statusBitrate) return;

  const mp = session.mediaPlayer;
  const kbps = mp ? mp.bandwidthKbps : 0;
  statusBitrate.textContent = kbps >= 1000
    ? `${(kbps / 1000).toFixed(1)} Mbps`
    : `${kbps} Kbps`;

  // Fill bars based on buffer time (like SageTV's buffer gauge)
  if (!statusSignal) return;
  const bars = statusSignal.querySelectorAll('.bar');
  const bufferSec = mp ? mp.getBufferTime() : 0;
  const fill = Math.min(1.0, bufferSec / STATUS_BAR_MAX_BUFFER);
  const activeBars = Math.round(fill * STATUS_BAR_DIVS);
  bars.forEach((bar, i) => {
    bar.classList.toggle('active', i < activeBars);
  });

  // Keep play/pause button icon in sync with player state
  const playPauseBtn = document.getElementById('btn-play-pause');
  if (playPauseBtn && mp) {
    const isPlaying = mp.state === 2; // PlayerState.PLAY
    playPauseBtn.textContent = isPlaying ? '⏸' : '▶';
    playPauseBtn.title = isPlaying ? 'Pause' : 'Play';
  }
}

// ── Navigation Drawer ────────────────────────────────────

function initNavDrawer() {
  const drawer = document.getElementById('nav-drawer');
  const backdrop = document.getElementById('nav-drawer-backdrop');
  const closeBtn = document.getElementById('nav-drawer-close');
  const container = document.getElementById('client-container');

  if (!drawer || !backdrop || !container) return;

  const EDGE_ZONE = 30; // px from left edge to detect swipe start
  const SWIPE_THRESHOLD = 60; // px of horizontal movement to trigger open

  let drawerOpen = false;

  function openDrawer() {
    if (drawerOpen) return;
    drawerOpen = true;
    drawer.hidden = false;
    backdrop.hidden = false;
    // Force reflow then animate
    drawer.offsetHeight;
    drawer.classList.add('open');
    // Give SpatialNavigation a starting point inside the drawer so remote
    // arrows/enter operate on drawer buttons instead of leaking to SageTV.
    queueMicrotask(() => {
      const first = drawer.querySelector('.nav-drawer-btn:not([hidden]):not([disabled])');
      if (first) first.focus({ preventScroll: true });
    });
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    drawer.classList.remove('open');
    setTimeout(() => {
      drawer.hidden = true;
      backdrop.hidden = true;
    }, 250);
    // Return focus to the playback canvas so subsequent keys reach SageTV.
    const cvs = document.getElementById('sage-canvas');
    if (cvs) { try { cvs.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  // Close on backdrop click
  backdrop.addEventListener('click', closeDrawer);
  closeBtn.addEventListener('click', closeDrawer);

  // Wire drawer buttons to SageCommands.
  // Use `click` so both pointer taps and remote/keyboard Enter (via
  // SpatialNavigation .click() on the focused button) trigger the action.
  const playPauseBtn = document.getElementById('btn-play-pause');
  const disconnectBtn = document.getElementById('nav-drawer-disconnect');
  drawer.querySelectorAll('.nav-drawer-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (btn === disconnectBtn) {
        // Client action, NOT a SageCommand: leave the server and return to the
        // connect screen. This is the remote-reachable equivalent of the
        // floating power button, which a D-pad cannot focus.
        closeDrawer();
        handleDisconnect();
        return;
      }
      if (btn === playPauseBtn) {
        // Toggle play/pause based on current media state
        const mp = session.mediaPlayer;
        const isPlaying = mp && (mp.state === 2); // PlayerState.PLAY === 2
        const cmdId = isPlaying ? 6 : 7; // 6=PAUSE, 7=PLAY
        if (session.connected) session.sendCommand(cmdId);
        // Update button icon
        playPauseBtn.textContent = isPlaying ? '▶' : '⏸';
        playPauseBtn.title = isPlaying ? 'Play' : 'Pause';
      } else {
        const cmdId = parseInt(btn.dataset.cmd, 10);
        if (!isNaN(cmdId) && session.connected) {
          console.log(`[Drawer] Sending command ${cmdId}`);
          session.sendCommand(cmdId);
        }
      }
    });
  });

  // ── Touch swipe from left edge ──\n  let touchStartX = 0;\n  let touchStartY = 0;\n  let isSwiping = false;\n\n  document.addEventListener('touchstart', (e) => {\n    if (drawerOpen) return;\n    const touch = e.touches[0];\n    if (touch.clientX <= EDGE_ZONE) {\n      touchStartX = touch.clientX;\n      touchStartY = touch.clientY;\n      isSwiping = true;\n    }\n  }, { passive: true });\n\n  document.addEventListener('touchmove', (e) => {\n    if (!isSwiping) return;\n    const touch = e.touches[0];\n    const dx = touch.clientX - touchStartX;\n    const dy = Math.abs(touch.clientY - touchStartY);\n    if (dx > SWIPE_THRESHOLD && dx > dy * 1.5) {\n      isSwiping = false;\n      openDrawer();\n    }\n  }, { passive: true });\n\n  document.addEventListener('touchend', () => {\n    isSwiping = false;\n  }, { passive: true });


  // ── Pointer drag from left edge (works with mouse + touch + pen) ──
  // Using pointer events because the canvas calls preventDefault() on
  // pointerdown which suppresses mousedown, but pointerdown still bubbles.
  let ptrStartX = 0;
  let ptrStartY = 0;
  let isPtrSwiping = false;

  document.addEventListener('pointerdown', (e) => {
    if (drawerOpen) return;
    // Only detect edges when the client screen is active
    if (clientScreen.classList.contains('active') || !clientScreen.hidden) {
      if (e.clientX <= EDGE_ZONE) {
        ptrStartX = e.clientX;
        ptrStartY = e.clientY;
        isPtrSwiping = true;
      }
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (!isPtrSwiping) return;
    const dx = e.clientX - ptrStartX;
    const dy = Math.abs(e.clientY - ptrStartY);
    if (dx > SWIPE_THRESHOLD && dx > dy * 1.5) {
      isPtrSwiping = false;
      openDrawer();
    }
  });

  document.addEventListener('pointerup', () => {
    isPtrSwiping = false;
  });

  // Menu button to open drawer
  const menuBtn = document.getElementById('btn-nav-menu');
  if (menuBtn) menuBtn.addEventListener('click', openDrawer);

  // External openers (e.g., Tizen long-press OK from input-manager).
  document.addEventListener('sagetv:open-nav-drawer', () => openDrawer());
  document.addEventListener('sagetv:close-nav-drawer', () => closeDrawer());

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) {
      closeDrawer();
      e.preventDefault();
    }
  });
}

// ── PWA Install Prompt ───────────────────────────────────

let _deferredInstallPrompt = null;

function checkInstallPrompt() {
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches ||
                      window.navigator.standalone === true;

  if (isInstalled) return;
  // Tizen (Samsung TV) apps are installed via .wgt — the "add to home screen"
  // flow is a browser concept that doesn't apply. Skip the banner entirely.
  if (typeof window !== 'undefined' && typeof window.tizen !== 'undefined') return;
  if (session.settings.getBool('install_prompted')) return;

  const banner = document.getElementById('install-banner');
  const installBtn = document.getElementById('btn-install');
  const installText = document.getElementById('install-text');

  document.getElementById('btn-dismiss-install').addEventListener('click', () => {
    banner.hidden = true;
    session.settings.set('install_prompted', 'true');
  });

  // Detect browser type for appropriate instructions
  const isIPad = /iPad/.test(navigator.userAgent) ||
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIOS = /iPhone/.test(navigator.userAgent) || isIPad;
  const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
  const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent);
  const isEdge = /Edg/.test(navigator.userAgent);
  const isFirefox = /Firefox/.test(navigator.userAgent);

  // Show banner immediately for all browsers
  if (isIOS && isSafari) {
    installText.innerHTML = 'Install this app: tap <strong>Share</strong> → <strong>Add to Home Screen</strong>';
  } else if (isChrome) {
    installText.innerHTML = 'Install as app: <strong>⋮ Menu</strong> → <strong>Install SageTV PWA-MiniClient</strong> (requires HTTPS)';
  } else if (isEdge) {
    installText.innerHTML = 'Install as app: <strong>⋯ Menu</strong> → <strong>Apps</strong> → <strong>Install this site as an app</strong>';
  } else if (isFirefox) {
    installText.innerHTML = 'Add to Home Screen from your browser menu for app-like experience';
  } else {
    installText.innerHTML = '<strong>SageTV PWA-MiniClient</strong> — use your browser menu to install as an app';
  }
  banner.hidden = false;

  // Chrome/Edge/Samsung: beforeinstallprompt fires when eligible (HTTPS only)
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    console.log('[App] Native install prompt available');
    installText.innerHTML = '<strong>SageTV PWA-MiniClient</strong> can be installed as an app';
    installBtn.hidden = false;

    installBtn.addEventListener('click', async () => {
      if (!_deferredInstallPrompt) return;
      _deferredInstallPrompt.prompt();
      const result = await _deferredInstallPrompt.userChoice;
      console.log('[App] Install result:', result.outcome);
      _deferredInstallPrompt = null;
      banner.hidden = true;
      session.settings.set('install_prompted', 'true');
    }, { once: true });
  });

  // Auto-hide if user installs via browser UI
  window.addEventListener('appinstalled', () => {
    console.log('[App] App installed');
    banner.hidden = true;
    session.settings.set('install_prompted', 'true');
  });
}

// ── Utility ──────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ── Start ────────────────────────────────────────────────

init().catch((err) => {
  console.error('[App] Init failed:', err);
});
