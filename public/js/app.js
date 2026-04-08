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
  addServerDialog.hidden = false;
  document.getElementById('dlg-server-name').focus();
}

// ── Initialization ───────────────────────────────────────

async function init() {
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
    _editingServer = null;
    document.getElementById('dlg-server-name').value = 'My Server';
    document.getElementById('dlg-server-host').value = '';
    document.getElementById('dlg-bridge-url').value = '';
    document.getElementById('dlg-save').textContent = 'ADD';
    addServerDialog.hidden = false;
    document.getElementById('dlg-server-host').focus();
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
  });

  // Add/Edit Server dialog — Cancel
  document.getElementById('dlg-cancel')?.addEventListener('click', () => {
    _editingServer = null;
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
      <div class="server-card" data-host="${escapeAttr(s.host)}" data-port="${port}" data-name="${escapeAttr(s.name || '')}" data-bridge-url="${escapeAttr(s.bridgeUrl || '')}">
        <button class="card-edit" title="Edit server">✎</button>
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
      if (e.target.classList.contains('card-delete') || e.target.classList.contains('card-edit')) return;
      const host = card.dataset.host;
      const port = parseInt(card.dataset.port, 10) || 31099;
      handleConnect(host, port);
    });

    // Right-click → edit
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openEditServerDialog(card);
    });

    // Long-press → edit (touch devices)
    let lpTimer = null;
    card.addEventListener('touchstart', (e) => {
      lpTimer = setTimeout(() => { lpTimer = null; openEditServerDialog(card); }, 600);
    }, { passive: true });
    card.addEventListener('touchend', () => { if (lpTimer) clearTimeout(lpTimer); });
    card.addEventListener('touchmove', () => { if (lpTimer) clearTimeout(lpTimer); });
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
  document.getElementById('set-transcode-pref').value = g('fixed_encoding/preference', 'needed');
  document.getElementById('set-transcode-format').value = g('fixed_encoding/format', 'matroska');
  document.getElementById('set-transcode-vbitrate').value = g('fixed_encoding/video_bitrate_kbps', '4000');
  document.getElementById('set-transcode-vres').value = g('fixed_encoding/video_resolution', 'SOURCE');
  document.getElementById('set-transcode-fps').value = g('fixed_encoding/video_fps', 'SOURCE');
  document.getElementById('set-transcode-acodec').value = g('fixed_encoding/audio_codec', 'ac3');
  document.getElementById('set-transcode-abitrate').value = g('fixed_encoding/audio_bitrate_kbps', '128');
  document.getElementById('set-transcode-achannels').value = g('fixed_encoding/audio_channels', '');

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

// ── Start ────────────────────────────────────────────────

init().catch((err) => {
  console.error('[App] Init failed:', err);
});
