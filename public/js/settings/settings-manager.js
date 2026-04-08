/**
 * SageTV MiniClient Settings Manager
 *
 * Manages client preferences using localStorage (simple key-value)
 * and IndexedDB (for larger data like image caches).
 *
 * Port of: core/src/main/java/sagex/miniclient/prefs/PrefStore.java
 */

const LS_PREFIX = 'sagetv_';
const COOKIE_PREFIX = 'sagetv_';
const COOKIE_MAX_AGE_DAYS = 365;
const SERVER_COOKIE_PREFIX = 'stv_srv_'; // one cookie per server

// ── Cookie Helpers ──────────────────────────────────────────

function setCookie(name, value, days = COOKIE_MAX_AGE_DAYS) {
  const maxAge = days * 24 * 60 * 60;
  const encoded = encodeURIComponent(value);
  document.cookie = `${COOKIE_PREFIX}${name}=${encoded}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

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

/**
 * Set a per-server cookie. Cookie name encodes server identity.
 * Value is JSON: { name, host, port, bridgeUrl? }
 */
function setServerCookie(server) {
  const key = _serverCookieKey(server.host, server.port);
  const maxAge = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
  const val = encodeURIComponent(JSON.stringify(server));
  document.cookie = `${key}=${val}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

function deleteServerCookie(host, port) {
  const key = _serverCookieKey(host, port);
  document.cookie = `${key}=; max-age=0; path=/; SameSite=Lax`;
}

/** Read all server cookies and return array of server objects. */
function getAllServerCookies() {
  const servers = [];
  for (const c of document.cookie.split('; ')) {
    const eqIdx = c.indexOf('=');
    if (eqIdx === -1) continue;
    const k = c.substring(0, eqIdx);
    if (!k.startsWith(SERVER_COOKIE_PREFIX)) continue;
    try {
      const val = decodeURIComponent(c.substring(eqIdx + 1));
      const srv = JSON.parse(val);
      if (srv && srv.host) servers.push(srv);
    } catch { /* skip malformed */ }
  }
  return servers;
}

/** Deterministic cookie key for a server (safe chars only). */
function _serverCookieKey(host, port) {
  const safe = (host || '').replace(/[^a-zA-Z0-9]/g, '_');
  return `${SERVER_COOKIE_PREFIX}${safe}_${port || 31099}`;
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

/** Cookie name that indicates defaults have been written */
const SETTINGS_INIT_COOKIE = 'settings_initialized';

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
        this._ensureDefaultCookies();
        resolve();
      };

      request.onerror = (event) => {
        console.warn('[Settings] IndexedDB unavailable, using localStorage only');
        this._ensureDefaultCookies();
        resolve(); // Don't reject, localStorage still works
      };
    });
  }

  /**
   * On first run, write all DEFAULTS into cookies so they persist.
   * Only runs once — sets a marker cookie to avoid repeating.
   */
  _ensureDefaultCookies() {
    if (getCookie(SETTINGS_INIT_COOKIE)) return; // already initialized

    console.log('[Settings] First run — writing default settings to cookies');
    for (const [key, value] of Object.entries(DEFAULTS)) {
      // Only write if neither localStorage nor cookie already has a value
      if (localStorage.getItem(LS_PREFIX + key) === null && getCookie(key) === null) {
        setCookie(key, value);
        localStorage.setItem(LS_PREFIX + key, value);
      }
    }

    // No default server — user adds their own via "Add Server"

    setCookie(SETTINGS_INIT_COOKIE, '1');
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
    // Check localStorage first (fastest), then cookie fallback
    const val = localStorage.getItem(LS_PREFIX + key);
    if (val !== null) return val;
    const cookieVal = getCookie(key);
    if (cookieVal !== null) return cookieVal;
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
    // Mirror all settings to cookies for persistence across sessions
    setCookie(key, value);
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
    const fromCookies = getAllServerCookies();
    if (fromCookies.length > 0) return fromCookies;

    // Migrate old single-JSON cookie / localStorage if present
    try {
      const oldJson = getCookie('saved_servers') ||
                      localStorage.getItem(LS_PREFIX + 'saved_servers');
      if (oldJson) {
        const servers = JSON.parse(oldJson);
        for (const s of servers) {
          setServerCookie(s);
        }
        deleteCookie('saved_servers');
        localStorage.removeItem(LS_PREFIX + 'saved_servers');
        return servers;
      }
    } catch { /* ignore */ }
    return [];
  }

  /**
   * Save a server connection as its own cookie (1-year expiry).
   */
  addSavedServer(host, port, name, bridgeUrl) {
    const server = { name: name || host, host, port: port || 31099 };
    if (bridgeUrl) server.bridgeUrl = bridgeUrl;
    server.lastUsed = Date.now();
    setServerCookie(server);
  }

  /**
   * Remove a saved server cookie.
   */
  removeSavedServer(host, port) {
    deleteServerCookie(host, port || 31099);
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
