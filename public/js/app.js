/**
 * SageTV MiniClient PWA - Application Entry Point
 *
 * Wires up the UI, session management, and PWA functionality.
 */

import { SessionManager } from './session/session-manager.js';
import { SageCommand } from './protocol/constants.js';

// ── Globals ──────────────────────────────────────────────

const session = new SessionManager();
let touchNavVisible = false;

// ── DOM References ───────────────────────────────────────

const connectScreen = document.getElementById('connect-screen');
const clientScreen = document.getElementById('client-screen');
const canvas = document.getElementById('sage-canvas');
const video = document.getElementById('sage-video');
const container = document.getElementById('client-container');
const toolbar = document.getElementById('toolbar');
const touchNav = document.getElementById('touch-nav');
const playOverlay = document.getElementById('play-overlay');
const debugOverlay = document.getElementById('debug-overlay');
const debugLog = document.getElementById('debug-log');
const reconnectBanner = document.getElementById('reconnect-banner');
const reconnectText = document.getElementById('reconnect-text');

// Server grid
const serverGrid = document.getElementById('server-grid');
const connectError = document.getElementById('connect-error');
const connectStatus = document.getElementById('connect-status');

// Dialogs
const addServerDialog = document.getElementById('add-server-dialog');
const settingsDialog = document.getElementById('settings-dialog');

// ── Initialization ───────────────────────────────────────

async function init() {
  // Debug: Shift+F12 opens debug popup window. Overlay is always hidden now.
  debugOverlay.hidden = true;
  const debugEnabled = session.settings ? session.settings.get('debug_overlay', 'true') : 'true';
  if (debugEnabled === 'true') {
    _openDebugWindow();
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      console.warn('Service worker registration failed:', e);
    }
  }

  // Initialize session (opens IndexedDB etc)
  await session.init(canvas, video, container);

  // Render server cards from cookies
  renderServerGrid();

  // Check for iPad Safari install prompt
  checkInstallPrompt();

  // Wire up events
  setupEventHandlers();

  console.log('[App] SageTV MiniClient PWA initialized');
}

// ── Event Handlers ───────────────────────────────────────

function setupEventHandlers() {
  // Add Server button
  document.getElementById('btn-add-server').addEventListener('click', () => {
    document.getElementById('dlg-server-name').value = 'My Server';
    document.getElementById('dlg-server-host').value = '';
    addServerDialog.hidden = false;
    document.getElementById('dlg-server-host').focus();
  });

  // Add Server dialog — Save
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
    session.settings.addSavedServer(host, 31099, name);
    addServerDialog.hidden = true;
    renderServerGrid();
  });

  // Add Server dialog — Cancel on overlay click handled generically below
  document.getElementById('dlg-cancel')?.addEventListener('click', () => {
    addServerDialog.hidden = true;
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-configure').addEventListener('click', (e) => {
    e.preventDefault();
    openSettings();
  });

  // Settings dialog — Save
  document.getElementById('set-save').addEventListener('click', saveSettings);

  // Settings dialog — Cancel
  document.getElementById('set-cancel').addEventListener('click', () => {
    settingsDialog.hidden = true;
  });

  // Disconnect
  const btnDisconnect = document.getElementById('btn-disconnect');
  if (btnDisconnect) btnDisconnect.addEventListener('click', handleDisconnect);

  // Fullscreen
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
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

  // Play overlay (autoplay unblock)
  document.getElementById('btn-play').addEventListener('click', () => {
    video.muted = false;
    video.play().catch(() => {});
    playOverlay.hidden = true;
  });

  // Toolbar show on mouse move (desktop)
  let toolbarTimeout;
  clientScreen.addEventListener('mousemove', () => {
    toolbar.classList.add('visible');
    clearTimeout(toolbarTimeout);
    toolbarTimeout = setTimeout(() => toolbar.classList.remove('visible'), 3000);
  });

  // Session events
  session.addEventListener('connecting', () => {
    connectStatus.hidden = false;
    connectStatus.innerHTML = '<span class="spinner"></span> Connecting...';
    connectError.hidden = true;
  });

  session.addEventListener('connected', () => {
    showScreen('client');
    canvas.focus();
  });

  session.addEventListener('firstframe', () => {
    connectStatus.hidden = true;
    session._onResize();
  });

  session.addEventListener('disconnected', (e) => {
    if (e.detail?.reason !== 'user') {
      showScreen('connect');
      connectError.textContent = `Disconnected: ${e.detail?.reason || 'unknown'}`;
      connectError.hidden = false;
    }
    connectStatus.hidden = true;
  });

  session.addEventListener('error', (e) => {
    showScreen('connect');
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
    showScreen('connect');
    connectError.textContent = 'Lost connection to server.';
    connectError.hidden = false;
  });

  // Media player autoplay blocked
  if (session.mediaPlayer) {
    session.mediaPlayer.addEventListener('playblocked', () => {
      playOverlay.hidden = false;
    });
  }

  // Window beforeunload
  window.addEventListener('beforeunload', () => {
    if (session.connected) session.disconnect();
  });

  // Keyboard shortcut: Shift+F12 = debug popup
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12' && e.shiftKey) {
      _openDebugWindow();
      e.preventDefault();
    }
  });

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
  if (servers.length === 0) {
    serverGrid.innerHTML = '<p style="color:rgba(255,255,255,0.4); font-size:14px;">No servers. Click <b>Add Server</b> to get started.</p>';
    return;
  }

  let html = '';
  for (const s of servers) {
    const name = escapeHtml(s.name || s.host);
    const host = escapeHtml(s.host);
    const port = s.port || 31099;
    html += `
      <div class="server-card" data-host="${escapeAttr(s.host)}" data-port="${port}" data-name="${escapeAttr(s.name || '')}">
        <button class="card-delete" title="Remove server">✕</button>
        <div class="card-icon"></div>
        <div class="card-name">${name}</div>
        <div class="card-host">${host}${port !== 31099 ? ':' + port : ''}</div>
      </div>`;
  }
  serverGrid.innerHTML = html;

  // Click card → connect
  serverGrid.querySelectorAll('.server-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('card-delete')) return;
      const host = card.dataset.host;
      const port = parseInt(card.dataset.port, 10) || 31099;
      handleConnect(host, port);
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

  const bridgeUrl = session.settings.get('bridge_url', '') || undefined;

  try {
    await session.connect(host, port, bridgeUrl);
    // Update lastUsed on the server cookie
    const servers = session.getSavedServers();
    const srv = servers.find(s => s.host === host && s.port === port);
    if (srv) session.settings.addSavedServer(srv.host, srv.port, srv.name);
  } catch (err) {
    console.error('[App] Connect failed:', err);
  }
}

function handleDisconnect() {
  session.disconnect();
  showScreen('connect');
}

// ── Settings Dialog ──────────────────────────────────────

function openSettings() {
  const g = (k, d) => session.settings.get(k, d);

  // Connection
  document.getElementById('set-bridge-url').value = g('bridge_url', '');
  const w = g('resolution_width', '1280');
  const h = g('resolution_height', '720');
  document.getElementById('set-resolution').value = `${w}x${h}`;

  // Streaming
  document.getElementById('set-streaming-mode').value = g('streaming_mode', 'fixed');

  // Transcoding
  document.getElementById('set-transcode-pref').value = g('fixed_encoding/preference', 'needed');
  document.getElementById('set-transcode-format').value = g('fixed_encoding/format', 'matroska');
  document.getElementById('set-transcode-vbitrate').value = g('fixed_encoding/video_bitrate_kbps', '4000');
  document.getElementById('set-transcode-vres').value = g('fixed_encoding/video_resolution', 'SOURCE');
  document.getElementById('set-transcode-fps').value = g('fixed_encoding/video_fps', 'SOURCE');
  document.getElementById('set-transcode-acodec').value = g('fixed_encoding/audio_codec', 'ac3');
  document.getElementById('set-transcode-abitrate').value = g('fixed_encoding/audio_bitrate_kbps', '128');

  // Remuxing
  document.getElementById('set-remux-pref').value = g('fixed_remuxing/preference', 'needed');
  document.getElementById('set-remux-format').value = g('fixed_remuxing/format', 'matroska');

  // Codecs
  document.getElementById('set-extra-vcodecs').value = g('extra_video_codecs', '');
  document.getElementById('set-extra-acodecs').value = g('extra_audio_codecs', '');

  // About
  document.getElementById('set-client-id').textContent =
    localStorage.getItem('sagetv_mac') || '(not set)';

  settingsDialog.hidden = false;
}

function saveSettings() {
  const s = (k, v) => session.settings.set(k, v);

  // Connection
  s('bridge_url', document.getElementById('set-bridge-url').value.trim());
  const [rw, rh] = document.getElementById('set-resolution').value.split('x');
  s('resolution_width', rw);
  s('resolution_height', rh);

  // Streaming
  s('streaming_mode', document.getElementById('set-streaming-mode').value);

  // Transcoding
  s('fixed_encoding/preference', document.getElementById('set-transcode-pref').value);
  s('fixed_encoding/format', document.getElementById('set-transcode-format').value);
  s('fixed_encoding/video_bitrate_kbps', document.getElementById('set-transcode-vbitrate').value);
  s('fixed_encoding/video_resolution', document.getElementById('set-transcode-vres').value);
  s('fixed_encoding/video_fps', document.getElementById('set-transcode-fps').value);
  s('fixed_encoding/audio_codec', document.getElementById('set-transcode-acodec').value);
  s('fixed_encoding/audio_bitrate_kbps', document.getElementById('set-transcode-abitrate').value);

  // Remuxing
  s('fixed_remuxing/preference', document.getElementById('set-remux-pref').value);
  s('fixed_remuxing/format', document.getElementById('set-remux-format').value);

  // Codecs
  s('extra_video_codecs', document.getElementById('set-extra-vcodecs').value.trim());
  s('extra_audio_codecs', document.getElementById('set-extra-acodecs').value.trim());

  settingsDialog.hidden = true;
}

// ── Screen Navigation ────────────────────────────────────

function showScreen(name) {
  connectScreen.classList.toggle('active', name === 'connect');
  clientScreen.classList.toggle('active', name === 'client');
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

// ── PWA Install Prompt ───────────────────────────────────

function checkInstallPrompt() {
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches ||
                      window.navigator.standalone === true;

  if (isInstalled) return;

  const isIPad = /iPad/.test(navigator.userAgent) ||
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

  if (isIPad && isSafari && !session.settings.getBool('install_prompted')) {
    const banner = document.getElementById('install-banner');
    banner.hidden = false;

    document.getElementById('btn-dismiss-install').addEventListener('click', () => {
      banner.hidden = true;
      session.settings.set('install_prompted', 'true');
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    console.log('[App] Install prompt available');
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

// ── Debug Logging (popup window) ─────────────────────────

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

let _debugWin = null;
let _debugDoc = null;
let _debugPre = null;

function _openDebugWindow() {
  if (_debugWin && !_debugWin.closed) return;
  _debugWin = window.open('', 'sage_debug', 'width=600,height=500,scrollbars=yes,resizable=yes');
  if (!_debugWin) return; // popup blocked
  _debugDoc = _debugWin.document;
  _debugDoc.title = 'SageTV Debug Log';
  _debugDoc.body.style.cssText = 'background:#111;color:#0f0;font:11px Consolas,Menlo,monospace;margin:0;padding:8px;';
  _debugPre = _debugDoc.createElement('pre');
  _debugPre.style.cssText = 'white-space:pre-wrap;word-break:break-all;margin:0;';
  _debugDoc.body.appendChild(_debugPre);
}

function appendDebug(level, args) {
  // Always write to the in-page hidden log too
  const line = `[${level}] ${Array.from(args).join(' ')}\n`;
  debugLog.appendChild(document.createTextNode(line));
  while (debugLog.childNodes.length > 500) {
    debugLog.removeChild(debugLog.firstChild);
  }

  // Write to popup window if open
  if (_debugPre && _debugWin && !_debugWin.closed) {
    _debugPre.appendChild(_debugDoc.createTextNode(line));
    while (_debugPre.childNodes.length > 500) {
      _debugPre.removeChild(_debugPre.firstChild);
    }
    const atBottom = _debugWin.innerHeight + _debugWin.scrollY >= _debugDoc.body.scrollHeight - 30;
    if (atBottom) {
      _debugWin.scrollTo(0, _debugDoc.body.scrollHeight);
    }
  }
}

console.log = function(...args) { origLog.apply(console, args); appendDebug('LOG', args); };
console.warn = function(...args) { origWarn.apply(console, args); appendDebug('WRN', args); };
console.error = function(...args) { origError.apply(console, args); appendDebug('ERR', args); };

// ── Start ────────────────────────────────────────────────

init().catch((err) => {
  console.error('[App] Init failed:', err);
});
