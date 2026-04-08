/**
 * SageTV MiniClient Settings Manager
 *
 * Manages client preferences using localStorage (simple key-value)
 * and IndexedDB (for larger data like image caches).
 *
 * Port of: core/src/main/java/sagex/miniclient/prefs/PrefStore.java
 */

const LS_PREFIX = 'sagetv_';
const LS_SERVERS_KEY = LS_PREFIX + 'servers'; // JSON array of server objects
const MAX_SERVERS = 10;

// ── Legacy Cookie Helpers (for migration only) ──────────────

const COOKIE_PREFIX = 'sagetv_';
const SERVER_COOKIE_PREFIX = 'stv_srv_';

function getCookie(name) {
  const fullName = COOKIE_PREFIX + name;
  const cookies = document.cookie.split('; ');
  for (const c of cookies) {
    const [k, ...vParts] = c.split('=');
    if (k === fullName) {
      return decodeURIComponent(vParts.join('='));
    }
  }
  return null;
}

function deleteCookie(name) {
  document.cookie = `${COOKIE_PREFIX}${name}=; max-age=0; path=/; SameSite=Lax`;
}

/** Delete all legacy cookies (settings + servers) so they stop bloating headers. */
function _purgeAllLegacyCookies() {
  for (const c of document.cookie.split('; ')) {
    const eqIdx = c.indexOf('=');
    if (eqIdx === -1) continue;
    const k = c.substring(0, eqIdx);
    if (k.startsWith(COOKIE_PREFIX) || k.startsWith(SERVER_COOKIE_PREFIX)) {
      document.cookie = `${k}=; max-age=0; path=/; SameSite=Lax`;
    }
  }
}

// ── Server List (localStorage) ──────────────────────────────

function _getServerList() {
  try {
    const json = localStorage.getItem(LS_SERVERS_KEY);
    if (json) return JSON.parse(json);
  } catch { /* ignore */ }
  return [];
}

function _saveServerList(servers) {
  localStorage.setItem(LS_SERVERS_KEY, JSON.stringify(servers.slice(0, MAX_SERVERS)));
}

/** Migrate any legacy server cookies into the localStorage list. */
function _migrateLegacyServers() {
  let migrated = false;
  const existing = _getServerList();

  // Migrate per-server cookies (stv_srv_*)
  for (const c of document.cookie.split('; ')) {
    const eqIdx = c.indexOf('=');
    if (eqIdx === -1) continue;
    const k = c.substring(0, eqIdx);
    if (!k.startsWith(SERVER_COOKIE_PREFIX)) continue;
    try {
      const srv = JSON.parse(decodeURIComponent(c.substring(eqIdx + 1)));
      if (srv && srv.host && !existing.some(e => e.host === srv.host && e.port === srv.port)) {
        existing.push(srv);
        migrated = true;
      }
    } catch { /* skip */ }
  }

  // Migrate old single-JSON cookie / localStorage array
  try {
    const oldJson = getCookie('saved_servers') ||
                    localStorage.getItem(LS_PREFIX + 'saved_servers');
    if (oldJson) {
      const old = JSON.parse(oldJson);
      for (const s of old) {
        if (s && s.host && !existing.some(e => e.host === s.host && e.port === s.port)) {
          existing.push(s);
          migrated = true;
        }
      }
    }
  } catch { /* ignore */ }

  if (migrated || existing.length > 0) _saveServerList(existing);
  return existing;
}

/** Default preference values matching PrefStore.java / AndroidPrefStore.java */
const DEFAULTS = {
  // General
  'auto_connect': 'false',
  'auto_connect_delay': '10',
  'keep_screen_on': 'true',
  'exit_on_standby': 'true',
  'image_cache_size_mb': '96',
  'log_level': 'debug',

  // Connection
  // Streaming
  'streaming_mode': 'fixed',

  // Fixed Transcoding (AndroidPrefStore keys)
  'fixed_encoding/preference': 'off',
  'fixed_encoding/format': 'matroska',
  'fixed_encoding/video_bitrate_kbps': '4000',
  'fixed_encoding/video_resolution': 'SOURCE',
  'fixed_encoding/video_fps': 'SOURCE',
  'fixed_encoding/audio_codec': 'ac3',
  'fixed_encoding/audio_bitrate_kbps': '128',
  'fixed_encoding/audio_channels': '',

  // Fixed Remuxing
  'fixed_remuxing/preference': 'off',
  'fixed_remuxing/format': 'matroska',

  // Rendering
  'resolution_width': '1280',
  'resolution_height': '720',

  // Key Mappings
  'key_repeat_ms': '100',
  'key_repeat_delay_ms': '1000',

  // Touch/Mouse Mappings
  'swipe_left': 'Left',
  'swipe_right': 'Right',
  'swipe_up': 'Up',
  'swipe_down': 'Down',
  'double_tap': 'Select',
  'long_press': 'Options',
  'edge_swipe_top': 'Menu',
  'edge_swipe_bottom': 'Options',

  // Codecs
  'extra_video_codecs': '',
  'extra_audio_codecs': '',

  // Buffers
  'video_buffer_size': String(16 * 1024 * 1024),
  'audio_buffer_size': String(2 * 1024 * 1024),

  // Other
  'disk_image_cache_size_mb': '512',
  'cache_images_on_disk': 'true',
  'install_prompted': 'false',
  'debug_sage_commands': 'false',
};

/** Key that indicates defaults have been written */
const SETTINGS_INIT_KEY = LS_PREFIX + 'settings_initialized';

export class SettingsManager {
  constructor() {
    this._db = null;
    this._dbReady = false;
  }

  /**
   * Initialize IndexedDB for larger data storage.
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('SageTVMiniClient', 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('imageCache')) {
          db.createObjectStore('imageCache', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('fontCache')) {
          db.createObjectStore('fontCache', { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains('serverInfo')) {
          db.createObjectStore('serverInfo', { keyPath: 'host' });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        this._dbReady = true;
        this._ensureDefaults();
        resolve();
      };

      request.onerror = (event) => {
        console.warn('[Settings] IndexedDB unavailable, using localStorage only');
        this._ensureDefaults();
        resolve(); // Don't reject, localStorage still works
      };
    });
  }

  /**
   * On first run, write all DEFAULTS into localStorage.
   * Migrates legacy cookies to localStorage and purges them.
   */
  _ensureDefaults() {
    // Migrate legacy server cookies to localStorage
    _migrateLegacyServers();

    if (localStorage.getItem(SETTINGS_INIT_KEY)) {
      // Already initialized — just purge any leftover cookies
      _purgeAllLegacyCookies();
      return;
    }

    console.log('[Settings] First run — writing default settings to localStorage');
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (localStorage.getItem(LS_PREFIX + key) === null) {
        // Migrate from cookie if present
        const cookieVal = getCookie(key);
        localStorage.setItem(LS_PREFIX + key, cookieVal !== null ? cookieVal : value);
      }
    }

    // Purge all legacy cookies now that everything is in localStorage
    _purgeAllLegacyCookies();
    localStorage.setItem(SETTINGS_INIT_KEY, '1');
  }

  // ── localStorage preferences ──────────────────────────────

  /**
   * Get a preference value.
   * For server connection keys, checks cookie first for cross-session persistence.
   * @param {string} key
   * @param {string} [defaultValue]
   * @returns {string}
   */
  get(key, defaultValue) {
    const val = localStorage.getItem(LS_PREFIX + key);
    if (val !== null) return val;
    if (defaultValue !== undefined) return defaultValue;
    return DEFAULTS[key] || '';
  }

  /**
   * Set a preference value.
   * Persists server connection keys to a 1-year cookie as well as localStorage.
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    localStorage.setItem(LS_PREFIX + key, value);
  }

  /**
   * Remove a preference.
   * @param {string} key
   */
  remove(key) {
    localStorage.removeItem(LS_PREFIX + key);
  }

  /**
   * Get a boolean preference.
   */
  getBool(key, defaultValue = false) {
    const val = this.get(key);
    if (val === '') return defaultValue;
    return val === 'true';
  }

  /**
   * Get an integer preference.
   */
  getInt(key, defaultValue = 0) {
    const val = this.get(key);
    const num = parseInt(val, 10);
    return isNaN(num) ? defaultValue : num;
  }

  /**
   * Get all saved server connections from cookies (one cookie per server).
   * @returns {Array<{name: string, host: string, port: number, bridgeUrl?: string}>}
   */
  getSavedServers() {
    return _getServerList();
  }

  /**
   * Save a server connection (up to 10 servers in localStorage).
   */
  addSavedServer(host, port, name, bridgeUrl) {
    const servers = _getServerList();
    const idx = servers.findIndex(s => s.host === host && s.port === (port || 31099));
    const server = { name: name || host, host, port: port || 31099, lastUsed: Date.now() };
    if (bridgeUrl) server.bridgeUrl = bridgeUrl;
    if (idx >= 0) {
      servers[idx] = server;
    } else {
      if (servers.length >= MAX_SERVERS) {
        // Drop the oldest (least recently used) to make room
        servers.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
        servers.shift();
      }
      servers.push(server);
    }
    _saveServerList(servers);
  }

  /**
   * Remove a saved server.
   */
  removeSavedServer(host, port) {
    const servers = _getServerList().filter(s => !(s.host === host && s.port === (port || 31099)));
    _saveServerList(servers);
  }

  // ── IndexedDB operations ──────────────────────────────────

  /**
   * Store image data in IndexedDB cache.
   * @param {string} resourceId
   * @param {ArrayBuffer} data
   * @param {number} width
   * @param {number} height
   */
  async cacheImage(resourceId, data, width, height) {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('imageCache', 'readwrite');
      const store = tx.objectStore('imageCache');
      store.put({ id: resourceId, data, width, height, timestamp: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieve cached image data.
   * @param {string} resourceId
   * @returns {Promise<{data: ArrayBuffer, width: number, height: number}|null>}
   */
  async getCachedImage(resourceId) {
    if (!this._db) return null;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('imageCache', 'readonly');
      const store = tx.objectStore('imageCache');
      const request = store.get(resourceId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Remove a cached image.
   * @param {string} resourceId
   */
  async removeCachedImage(resourceId) {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('imageCache', 'readwrite');
      const store = tx.objectStore('imageCache');
      store.delete(resourceId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Cache a font file.
   */
  async cacheFont(name, data) {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('fontCache', 'readwrite');
      const store = tx.objectStore('fontCache');
      store.put({ name, data, timestamp: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Store server auth cache data.
   */
  async setAuthCache(host, authBlock) {
    if (!this._db) return;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('serverInfo', 'readwrite');
      const store = tx.objectStore('serverInfo');
      store.put({ host, authBlock, timestamp: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieve server auth cache data.
   */
  async getAuthCache(host) {
    if (!this._db) return null;
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('serverInfo', 'readonly');
      const store = tx.objectStore('serverInfo');
      const request = store.get(host);
      request.onsuccess = () => resolve(request.result?.authBlock || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all caches (image + font + server).
   */
  async clearAllCaches() {
    if (!this._db) return;
    const stores = ['imageCache', 'fontCache', 'serverInfo'];
    for (const storeName of stores) {
      await new Promise((resolve) => {
        const tx = this._db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    }
  }
}
