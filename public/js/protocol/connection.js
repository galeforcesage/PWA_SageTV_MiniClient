/**
 * SageTV MiniClient Connection Engine
 *
 * Manages the WebSocket connection to the bridge server, which proxies to
 * the SageTV server's TCP protocol. Handles:
 * - Connection handshake (7-byte header)
 * - Property negotiation (GET_PROPERTY / SET_PROPERTY)
 * - GFX command stream reading and dispatching
 * - Event sending (keyboard, mouse, IR, SageCommand, resize)
 * - Compression (zlib) and encryption (Blowfish/DES)
 * - Reconnection logic
 *
 * Port of: core/src/main/java/sagex/miniclient/MiniClientConnection.java
 */

import { BinaryReader, BinaryWriter, getOrCreateMacAddress, parseMac } from './binary-utils.js';
import {
  PROTOCOL_VERSION, SERVER_ACCEPTED, DEFAULT_PORT,
  ConnectionType, ServerMsgType, EventType,
  GFXCMD, GFXCMD_NAMES, ClientProperty, CryptoAlgorithm
} from './constants.js';
import { CryptoManager } from './crypto.js';
import { StreamInflater, initCompression } from './compression.js';

/** Accumulates WebSocket binary frames into a parseable buffer. */
class ReceiveBuffer {
  constructor() {
    this.chunks = [];
    this.totalLength = 0;
  }

  append(data) {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  /** Peek at available byte count */
  get length() {
    return this.totalLength;
  }

  /**
   * Consume exactly `n` bytes from the front.
   * @param {number} n
   * @returns {Uint8Array|null} null if insufficient data
   */
  consume(n) {
    if (this.totalLength < n) return null;

    const result = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const needed = n - offset;
      if (chunk.length <= needed) {
        result.set(chunk, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        result.set(chunk.subarray(0, needed), offset);
        this.chunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    this.totalLength -= n;
    return result;
  }

  /** Peek at bytes without consuming */
  peek(n) {
    if (this.totalLength < n) return null;
    const result = new Uint8Array(n);
    let offset = 0;
    let chunkIdx = 0;
    let chunkOffset = 0;
    while (offset < n) {
      const chunk = this.chunks[chunkIdx];
      const available = chunk.length - chunkOffset;
      const needed = n - offset;
      const take = Math.min(available, needed);
      result.set(chunk.subarray(chunkOffset, chunkOffset + take), offset);
      offset += take;
      chunkOffset += take;
      if (chunkOffset >= chunk.length) {
        chunkIdx++;
        chunkOffset = 0;
      }
    }
    return result;
  }

  clear() {
    this.chunks = [];
    this.totalLength = 0;
  }
}

export class MiniClientConnection extends EventTarget {
  /**
   * @param {object} options
   * @param {string} options.bridgeUrl - WebSocket bridge base URL (e.g. ws://localhost:8099)
   * @param {string} options.serverHost - SageTV server hostname/IP
   * @param {number} [options.serverPort=31099] - SageTV server port
   * @param {object} options.renderer - UIRenderer instance
   * @param {object} options.mediaPlayer - MediaPlayer instance
   * @param {number} [options.width=1280]
   * @param {number} [options.height=720]
   */
  constructor(options) {
    super();
    this.bridgeUrl = options.bridgeUrl;
    this.serverHost = options.serverHost;
    this.serverPort = options.serverPort || DEFAULT_PORT;
    this.renderer = options.renderer;
    this.mediaPlayer = options.mediaPlayer;
    this.width = options.width || 1280;
    this.height = options.height || 720;
    this._originalWidth = this.width;
    this._originalHeight = this.height;
    this.settings = options.settings || null;

    // Load cached auth from settings if available (survives fresh connections)
    this._cachedAuthBlock = (this.settings
      ? this.settings.get(`auth_block_${this.serverHost}`, '') || null
      : null);
    if (this._cachedAuthBlock) {
      console.log(`[Connection] Loaded cached auth from settings (${this._cachedAuthBlock.length} chars)`);
    }

    // Connection state
    this.gfxSocket = null;
    this.mediaSocket = null;
    this.alive = false;
    this.firstFrameStarted = false;
    this.reconnectAllowed = false;

    // Protocol state
    this.macAddress = getOrCreateMacAddress();
    this.macBytes = parseMac(this.macAddress);
    this.crypto = new CryptoManager();
    this.inflater = new StreamInflater();
    this.zipMode = false;

    // Receive buffer for GFX stream
    this.gfxBuffer = new ReceiveBuffer();
    this.mediaBuffer = new ReceiveBuffer();

    // Event sending
    this.replyCount = 0;
    this.eventQueue = [];
    this.eventProcessing = false;

    // Image handle counter (matches Java's handleCount)
    this.handleCount = 1;

    // Font handle → { name, style, size } map
    this._fontMap = new Map();

    // Property negotiation state
    this._propertyResolve = null;
    this._pendingPropertyResponse = null;
    this._advancedImageCaching = false;

    // Offline image cache tracking
    this._offlineCacheChanges = [];

    // Server info
    this.serverName = '';
    this.serverProperties = {};

    // Reconnect state
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectTimer = null;
    this._shortSessionCount = 0; // consecutive sessions < 30s
    this._verboseGfxLog = false; // log every GFX cmd for diagnostics

    // Keepalive (ping the WebSocket bridge)
    this._keepaliveInterval = null;
    this._keepaliveTimeout = 15000; // ms between pings
  }

  // ── Connection Lifecycle ──────────────────────────────────

  /**
   * Connect to the SageTV server via the WebSocket bridge.
   */
  async connect() {
    await initCompression();
    this._connectTime = Date.now();

    const params = `?host=${encodeURIComponent(this.serverHost)}&port=${this.serverPort}`;
    console.log(`[Connection] Connecting via ${this.bridgeUrl} to ${this.serverHost}:${this.serverPort}, MAC=${this.macAddress}`);

    // Open GFX WebSocket
    this.gfxSocket = new WebSocket(`${this.bridgeUrl}/gfx${params}`);
    this.gfxSocket.binaryType = 'arraybuffer';

    await this._waitForOpen(this.gfxSocket, 'GFX');
    console.log(`[Connection] GFX WebSocket open at +${Date.now() - this._connectTime}ms`);

    // Perform GFX handshake (may buffer leftover bytes from same TCP chunk)
    await this._handshake(this.gfxSocket, ConnectionType.GFX, this.gfxBuffer);
    console.log(`[Connection] GFX handshake accepted at +${Date.now() - this._connectTime}ms`);

    // Immediately wire up GFX message handler so we don't lose
    // property requests the server sends while we open the Media socket
    this.gfxSocket.onmessage = (event) => this._onGfxData(event.data);
    this.gfxSocket.onclose = () => this._onDisconnect('GFX socket closed');
    this.gfxSocket.onerror = (e) => this._onDisconnect('GFX socket error');
    this._socketClosedWarned = false;

    // Process any leftover bytes that arrived with the handshake response
    if (this.gfxBuffer.length > 0) {
      console.log(`[Connection] Processing ${this.gfxBuffer.length} leftover handshake bytes`);
      this._processGfxBuffer();
    }

    // Open Media WebSocket
    this.mediaSocket = new WebSocket(`${this.bridgeUrl}/media${params}`);
    this.mediaSocket.binaryType = 'arraybuffer';

    await this._waitForOpen(this.mediaSocket, 'Media');
    console.log(`[Connection] Media WebSocket open at +${Date.now() - this._connectTime}ms`);

    // Perform Media handshake
    await this._handshake(this.mediaSocket, ConnectionType.MEDIA, this.mediaBuffer);
    console.log(`[Connection] Media handshake accepted at +${Date.now() - this._connectTime}ms`);

    this.alive = true;
    this.reconnectAllowed = true;

    // Media socket messages
    this.mediaSocket.onmessage = (event) => this._onMediaData(event.data);
    this.mediaSocket.onclose = () => console.warn('[Connection] Media socket closed');
    this.mediaSocket.onerror = () => console.warn('[Connection] Media socket error');

    this.dispatchEvent(new CustomEvent('connected'));
    console.log('[Connection] Connected to SageTV server');

    // Start keepalive pings
    this._startKeepalive();

    // The server will begin sending GET_PROPERTY and SET_PROPERTY,
    // followed by DRAWING_CMD frames. Processing happens in _onGfxData.
  }

  /**
   * Wait for a WebSocket to open.
   */
  _waitForOpen(ws, label) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} connection timeout`)), 10000);
      ws.onopen = () => {
        clearTimeout(timeout);
        console.log(`[Connection] ${label} WebSocket connected`);
        resolve();
      };
      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(new Error(`${label} WebSocket error`));
      };
    });
  }

  /**
   * Perform the SageTV handshake.
   * Send 8 bytes: [0x01] [MAC0] [MAC1] [MAC2] [MAC3] [MAC4] [MAC5] [connType]
   * Server responds with [0x02].
   * @param {WebSocket} ws
   * @param {number} connectionType
   * @param {ReceiveBuffer} [overflowBuffer] - buffer to store extra bytes from handshake response
   */
  async _handshake(ws, connectionType, overflowBuffer) {
    const header = new Uint8Array(8);
    header[0] = PROTOCOL_VERSION;
    // All 6 MAC address bytes
    header[1] = this.macBytes[0];
    header[2] = this.macBytes[1];
    header[3] = this.macBytes[2];
    header[4] = this.macBytes[3];
    header[5] = this.macBytes[4];
    header[6] = this.macBytes[5];
    header[7] = connectionType;

    ws.send(header.buffer);

    // Wait for server acceptance byte (may arrive with extra data in same chunk)
    const response = await this._readFirstByte(ws, overflowBuffer);
    if (response !== SERVER_ACCEPTED) {
      throw new Error(`Server rejected connection (type ${connectionType}), got: 0x${response.toString(16)}`);
    }
    console.log(`[Connection] Handshake accepted for type ${connectionType}`);
  }

  /**
   * Read the first byte from the next WebSocket message.
   * If the message contains more than 1 byte, the remainder is pushed
   * into overflowBuffer so it's not lost.
   * @param {WebSocket} ws
   * @param {ReceiveBuffer} [overflowBuffer]
   * @returns {Promise<number>}
   */
  _readFirstByte(ws, overflowBuffer) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 10000);
      const handler = (event) => {
        clearTimeout(timeout);
        ws.removeEventListener('message', handler);
        const data = new Uint8Array(event.data);
        // If the server sent more data after the acceptance byte, buffer it
        if (data.length > 1 && overflowBuffer) {
          overflowBuffer.append(data.subarray(1));
        }
        resolve(data[0]);
      };
      ws.addEventListener('message', handler);
    });
  }

  // ── GFX Stream Processing ────────────────────────────────

  /**
   * Handle incoming GFX data from WebSocket.
   * Data arrives as ArrayBuffer chunks that we accumulate and parse.
   */
  _onGfxData(data) {
    // Skip text messages (e.g. keepalive pong from bridge)
    if (typeof data === 'string') {
      return;
    }
    let bytes = new Uint8Array(data);

    // If zlib is enabled, decompress the ENTIRE incoming stream
    // (Java wraps the socket with ZInputStream — all bytes are deflated)
    if (this.zipMode && this.inflater.enabled) {
      const compressed = bytes;
      bytes = this.inflater.inflate(bytes);
      if (bytes.length === 0) {
        console.warn(`[GFX] inflate returned 0 from ${compressed.length} bytes`);
        return;
      }
      // Verbose: log data flow after first frame for debugging
      if (this._verboseGfxLog && this.firstFrameStarted) {
        console.log(`[GFX] Data: ${compressed.length}B compressed → ${bytes.length}B (buf=${this.gfxBuffer.length}B)`);
      }
    }

    this.gfxBuffer.append(bytes);
    this._processGfxBuffer();
  }

  /**
   * Process accumulated GFX buffer, extracting complete messages.
   *
   * Server message format:
   *   [1B type] [3B length (MSB)] [NB payload]
   *   - type 0 = GET_PROPERTY
   *   - type 1 = SET_PROPERTY
   *   - type 2 = FS_CMD
   *   - type 16 = DRAWING_CMD (GFX batch)
   */
  _processGfxBuffer() {
    // If an async image decode is in progress, wait for it before
    // processing more messages. This matches Java's synchronous decode:
    // XFMIMAGE must see the fully decoded source, not a placeholder.
    if (this._pendingImageDecode) {
      this._pendingImageDecode.then(() => {
        this._pendingImageDecode = null;
        this._processGfxBuffer();
      });
      return;
    }

    try {
      while (this.gfxBuffer.length >= 4) {
        // Peek at header
        const header = this.gfxBuffer.peek(4);
        if (!header) break;

        const msgType = header[0];
        const msgLen = ((header[1] & 0xFF) << 16) | ((header[2] & 0xFF) << 8) | (header[3] & 0xFF);

        // Sanity check: reject obviously corrupt frames
        if (msgLen > 16 * 1024 * 1024) {
          console.error(`[Connection] Corrupt frame: type=${msgType}, len=${msgLen}. Clearing buffer.`);
          this.gfxBuffer.clear();
          return;
        }

        // Check if full message is available
        if (this.gfxBuffer.length < 4 + msgLen) break;

        // Consume header + payload
        this.gfxBuffer.consume(4);
        const payload = msgLen > 0 ? this.gfxBuffer.consume(msgLen) : new Uint8Array(0);

        // Track whether ZLIB was just enabled by this message
        const wasZip = this.zipMode;

        this._handleServerMessage(msgType, payload);

        // If an image decode was started by this message, pause processing
        // until the decode finishes (so XFMIMAGE sees the real image)
        if (this._pendingImageDecode) {
          this._pendingImageDecode.then(() => {
            this._pendingImageDecode = null;
            this._processGfxBuffer();
          });
          return;
        }

        // If ZLIB was just enabled, any remaining bytes in gfxBuffer are
        // compressed (they arrived in the same TCP chunk as ZLIB_COMM_XFER
        // before _onGfxData knew to inflate). Extract them, inflate, and
        // re-append so they can be parsed as normal frames.
        if (!wasZip && this.zipMode && this.gfxBuffer.length > 0) {
          const compressedTail = this.gfxBuffer.consume(this.gfxBuffer.length);
          this.gfxBuffer.clear();
          const decompressed = this.inflater.inflate(compressedTail);
          if (decompressed.length > 0) {
            console.log(`[Connection] ZLIB transition: inflated ${compressedTail.length} leftover bytes → ${decompressed.length}`);
            this.gfxBuffer.append(decompressed);
            // Continue the while loop to parse the decompressed data
          } else {
            console.warn(`[Connection] ZLIB transition: ${compressedTail.length} leftover bytes inflated to 0`);
          }
        }
      }
    } catch (err) {
      console.error(`[Connection] Error processing GFX buffer: ${err.message} | stack: ${err.stack}`);
    }
  }

  /**
   * Dispatch a server message to the appropriate handler.
   */
  _handleServerMessage(msgType, data) {
    // Verbose: log every server message for debugging
    if (this._verboseGfxLog) {
      const typeName = {0:'GET_PROPERTY',1:'SET_PROPERTY',2:'FS_CMD',16:'DRAWING_CMD'}[msgType]||`TYPE${msgType}`;
      const cmdByte = (msgType === ServerMsgType.DRAWING_CMD && data.length > 0) ? (GFXCMD_NAMES[data[0]&0xFF]||`CMD${data[0]&0xFF}`) : '';
      console.log(`[Msg] ${typeName}${cmdByte?' '+cmdByte:''} (${data.length}B)`);
    }
    switch (msgType) {
      case ServerMsgType.GET_PROPERTY:
        this._handleGetProperty(data);
        break;
      case ServerMsgType.SET_PROPERTY:
        this._handleSetProperty(data);
        break;
      case ServerMsgType.FS_CMD:
        this._handleFSCommand(data);
        break;
      case ServerMsgType.DRAWING_CMD:
        this._handleDrawingCommand(data);
        break;
      default:
        console.warn(`[Connection] Unknown message type: ${msgType}`);
    }
  }

  // ── Property Negotiation ─────────────────────────────────

  /**
   * Handle GET_PROPERTY request from server.
   * Server asks for a client capability/property value.
   * Payload is the raw property name bytes (length comes from outer frame header).
   */
  _handleGetProperty(data) {
    const name = new TextDecoder('iso-8859-1').decode(data);
    this._propCount = (this._propCount || 0) + 1;

    // CRYPTO_SYMMETRIC_KEY needs async RSA — handle separately
    if (name === 'CRYPTO_SYMMETRIC_KEY') {
      console.log(`[Connection] GET_PROPERTY: ${name} → [async RSA key exchange]`);
      this._handleCryptoSymmetricKeyRequest();
      return;
    }

    const value = this._resolveProperty(name);
    console.log(`[Connection] GET_PROPERTY: ${name} → ${value}`);

    this._sendPropertyResponse(value);
  }

  /**
   * Handle SET_PROPERTY from server.
   * Server tells us a configuration value.
   * Payload: [2B name_len] [2B value_len] [name_len B name] [value_len B value]
   * Both lengths come first, then both strings.
   */
  _handleSetProperty(data) {
    const reader = new BinaryReader(data);
    const nameLen = reader.readUint16();
    const valueLen = reader.readUint16();
    const name = reader.readLatin1String(nameLen);

    // For crypto keys, we need raw bytes, not string
    if (name === 'CRYPTO_PUBLIC_KEY') {
      const rawBytes = reader.readBytes(valueLen);
      console.log(`[Connection] SET_PROPERTY: ${name} = [${valueLen} raw bytes]`);
      this._serverPublicKeyBytes = new Uint8Array(rawBytes);
      this._sendSetPropertyReply(0);
      return;
    }

    // SET_CACHED_AUTH: encrypted auth block that needs to be decrypted and stored
    if (name === 'SET_CACHED_AUTH') {
      const encryptedBytes = reader.readBytes(valueLen);
      console.log(`[Connection] SET_PROPERTY: ${name} = [${valueLen} encrypted bytes]`);
      try {
        const decrypted = this.crypto.decryptBlock(new Uint8Array(encryptedBytes));
        const authBlock = new TextDecoder('iso-8859-1').decode(decrypted);
        console.log(`[Connection] Cached auth block stored (${authBlock.length} chars)`);
        // Store in settings keyed by server host
        if (this.settings) {
          this.settings.set(`auth_block_${this.serverHost}`, authBlock);
        }
        // Also keep in memory for this session
        this._cachedAuthBlock = authBlock;
      } catch (err) {
        console.warn('[Connection] Failed to decrypt SET_CACHED_AUTH:', err.message);
      }
      const encryptThisReply = this.crypto.isEnabled();
      this._sendSetPropertyReply(0, encryptThisReply);
      return;
    }

    const value = reader.readLatin1String(valueLen);
    console.log(`[Connection] SET_PROPERTY: ${name} = ${value}`);
    this.serverProperties[name] = value;

    // Snapshot encryption state BEFORE processing (Java client does the same:
    // encryptThisReply = encryptEvents before the handler runs).
    // This ensures the CRYPTO_EVENTS_ENABLE reply itself is sent unencrypted.
    const encryptThisReply = this.crypto.isEnabled();
    const retval = this._processSetProperty(name, value);
    this._sendSetPropertyReply(retval || 0, encryptThisReply);
  }

  /**
   * Resolve a property value for GET_PROPERTY.
   */
  _resolveProperty(name) {
    // Helper to read settings with fallback
    const pref = (key, def) => this.settings ? this.settings.get(key, def) : def;

    switch (name) {
      case 'GFX_TEXTMODE':
        return ClientProperty.GFX_TEXTMODE;
      case 'GFX_BLENDMODE':
        return ClientProperty.GFX_BLENDMODE;
      case 'GFX_COMPOSITE':
        return ClientProperty.GFX_COMPOSITE;
      case 'GFX_SURFACES':
        return ClientProperty.GFX_SURFACES;
      case 'GFX_COLORKEY':
        return ClientProperty.GFX_COLORKEY;
      case 'GFX_SCALING':
        return ClientProperty.GFX_SCALING;
      case 'GFX_RESOLUTION': {
        const res = `${this.width}x${this.height}`;
        console.log(`[Connection] Reporting GFX_RESOLUTION = ${res}`);
        return res;
      }
      case 'GFX_SUPPORTED_RESOLUTIONS':
        return `${this.width}x${this.height}`;
      case 'GFX_OFFLINE_IMAGE_CACHE':
        return ClientProperty.GFX_OFFLINE_IMAGE_CACHE;
      case 'ADVANCED_IMAGE_CACHING':
        return ClientProperty.ADVANCED_IMAGE_CACHING;
      case 'INPUT_DEVICES':
        return ClientProperty.INPUT_DEVICES;
      case 'STREAMING_MODE':
        return pref('streaming_mode', 'fixed');
      case 'STREAMING_PROTOCOLS':
        return ClientProperty.STREAMING_PROTOCOLS;
      case 'VIDEO_CODECS': {
        const base = ClientProperty.VIDEO_CODECS;
        const extra = pref('extra_video_codecs', '');
        return extra ? `${base},${extra}` : base;
      }
      case 'AUDIO_CODECS': {
        const base = ClientProperty.AUDIO_CODECS;
        const extra = pref('extra_audio_codecs', '');
        return extra ? `${base},${extra}` : base;
      }
      case 'PUSH_AV_CONTAINERS':
        return ClientProperty.PUSH_AV_CONTAINERS;
      case 'PULL_AV_CONTAINERS':
        return ClientProperty.PULL_AV_CONTAINERS;
      // Transcoding settings
      case 'FIXED_ENCODING_PREFERENCE':
        return pref('fixed_encoding/preference', 'needed');
      case 'FIXED_ENCODING_FORMAT':
        return pref('fixed_encoding/format', 'matroska');
      case 'FIXED_ENCODING_VIDEO_BITRATE_KBPS':
        return pref('fixed_encoding/video_bitrate_kbps', '4000');
      case 'FIXED_ENCODING_VIDEO_RESOLUTION':
        return pref('fixed_encoding/video_resolution', 'SOURCE');
      case 'FIXED_ENCODING_FPS':
        return pref('fixed_encoding/video_fps', 'SOURCE');
      case 'FIXED_ENCODING_AUDIO_CODEC':
        return pref('fixed_encoding/audio_codec', 'ac3');
      case 'FIXED_ENCODING_AUDIO_BITRATE_KBPS':
        return pref('fixed_encoding/audio_bitrate_kbps', '128');
      // Remuxing settings
      case 'FIXED_REMUXING_PREFERENCE':
        return pref('fixed_remuxing/preference', 'needed');
      case 'FIXED_REMUXING_FORMAT':
        return pref('fixed_remuxing/format', 'matroska');
      case 'CRYPTO_ALGORITHMS':
        return 'RSA,Blowfish';
      case 'ZLIB_COMM':
        return 'TRUE';
      case 'AUTH_CACHE':
        return 'TRUE';
      case 'GET_CACHED_AUTH': {
        // Return cached auth block only if encryption is active
        if (this._encryptEvents && this.crypto.isEnabled()) {
          const cached = this._cachedAuthBlock ||
            (this.settings ? this.settings.get(`auth_block_${this.serverHost}`, '') : '');
          if (cached) {
            this._cachedAuthBlock = cached; // Persist in memory for reconnect checks
            console.log(`[Connection] Returning cached auth (${cached.length} chars)`);
            return cached;
          }
        }
        console.log('[Connection] No cached auth available');
        return '';
      }
      case 'DISPLAY_OVERSCAN':
        return '0;0;1.0;1.0';
      case 'FIRMWARE_VERSION':
        return 'PWA/1.0';
      case 'MEDIA_PLAYER_BUFFER_DELAY':
        return '0';
      case 'FIXED_PUSH_MEDIA_FORMAT':
        return '';
      default:
        console.log(`[Connection] Unknown property requested: ${name}`);
        return '';
    }
  }

  /**
   * Process a SET_PROPERTY from the server.
   */
  _processSetProperty(name, value) {
    switch (name) {
      case 'ZLIB_COMM_XFER':
        if (value === 'TRUE' || value === 'true') {
          this.zipMode = true;
          this.inflater.enable();
          console.log('[Connection] Compression enabled');
        }
        return 0;
      case 'CRYPTO_ALGORITHMS':
        this._currentCrypto = value;
        console.log(`[Connection] Server chose crypto: ${value}`);
        return 0;
      case 'CRYPTO_SYMMETRIC_KEY':
        // Server confirms symmetric key setup
        return 0;
      case 'CRYPTO_EVENTS_ENABLE':
        if (value === 'TRUE') {
          if (this.crypto.isReady()) {
            this.crypto.enable();
            this._encryptEvents = true;
            console.log('[Connection] Event encryption enabled');
            return 0;
          } else {
            this._encryptEvents = false;
            console.warn('[Connection] Event encryption requested but cipher not ready');
            return 1;
          }
        } else {
          this._encryptEvents = false;
          this.crypto.disable();
          console.log('[Connection] Event encryption disabled');
          return 0;
        }
      case 'GFX_RESOLUTION':
        this._handleResolutionChange(value);
        return 0;
      case 'ADVANCED_IMAGE_CACHING':
        this._advancedImageCaching = (value === 'TRUE' || value === 'true');
        console.log(`[Connection] Advanced image caching: ${this._advancedImageCaching}`);
        return 0;
      case 'RECONNECT_SUPPORTED':
        this.reconnectAllowed = (value === 'TRUE' || value === 'true');
        console.log(`[Connection] Reconnect allowed: ${this.reconnectAllowed}`);
        return 0;
      case 'MENU_HINT': {
        // Parse "menuName:X,popupName:Y,hasTextInput:true"
        const hint = { menuName: null, popupName: null, hasTextInput: false };
        if (value) {
          for (const part of value.split(',')) {
            const colonIdx = part.indexOf(':');
            if (colonIdx < 0) continue;
            const k = part.substring(0, colonIdx).trim().toLowerCase();
            const v = part.substring(colonIdx + 1).trim();
            if (k === 'menuname') hint.menuName = v === 'NULL' ? null : v;
            else if (k === 'popupname') hint.popupName = v === 'NULL' ? null : v;
            else if (k === 'hastextinput') hint.hasTextInput = v.toLowerCase() === 'true';
          }
        }
        this.menuHint = hint;
        console.log(`[Connection] MENU_HINT: menu=${hint.menuName}, popup=${hint.popupName}, textInput=${hint.hasTextInput}`);
        this.dispatchEvent(new CustomEvent('menuhint', { detail: hint }));
        return 0;
      }
      default:
        return 0;
    }
  }

  /**
   * Handle the CRYPTO_SYMMETRIC_KEY request.
   * Generate a Blowfish key, encrypt it with the server's RSA public key,
   * and send the encrypted key bytes back.
   */
  async _handleCryptoSymmetricKeyRequest() {
    try {
      if (!this._serverPublicKeyBytes) {
        throw new Error('No server public key received');
      }

      const algo = this._currentCrypto || 'RSA';
      console.log(`[Connection] Crypto key exchange using ${algo}`);

      if (algo.indexOf('RSA') !== -1) {
        const result = await this.crypto.setupRSA(this._serverPublicKeyBytes);
        // Send encrypted symmetric key as raw bytes via property response
        this._sendPropertyResponseBytes(result.encryptedKey);
        console.log(`[Connection] RSA key exchange complete, sent ${result.encryptedKey.length} bytes`);
      } else {
        // DH fallback - not implemented, send empty
        console.warn('[Connection] DH key exchange not implemented');
        this._sendPropertyResponse('');
      }
    } catch (err) {
      console.error('[Connection] Crypto key exchange failed:', err);
      this._sendPropertyResponse('');
    }
  }

  /**
   * Handle resolution change from server.
   */
  _handleResolutionChange(value) {
    const match = value.match(/(\d+)x(\d+)/);
    if (match) {
      const newW = parseInt(match[1], 10);
      const newH = parseInt(match[2], 10);
      console.log(`[Connection] GFX_RESOLUTION changed: ${this.width}x${this.height} → ${newW}x${newH}`);
      this.width = newW;
      this.height = newH;
      this.renderer.setSize(this.width, this.height);
      this.dispatchEvent(new CustomEvent('resolutionchange', { detail: { width: newW, height: newH } }));
    }
  }

  /**
   * Send a property response to the server via event channel.
   * Frame: [1B type=0][3B value_len][4B ts=0][4B counter][4B pad=0][NB value]
   * Header length field is the ORIGINAL data length (Java client behavior).
   * When encrypted, the actual payload is padded to block size.
   */
  _sendPropertyResponse(value) {
    // Encode value as latin-1 bytes
    const valBytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) valBytes[i] = value.charCodeAt(i) & 0xFF;

    // Only encrypt when data is non-empty — server skips decryption when dataLen == 0
    const origLen = valBytes.length;
    const encVal = (origLen > 0 && this.crypto.isEnabled()) ? this.crypto.encrypt(valBytes) : valBytes;
    const frame = new Uint8Array(16 + encVal.length);
    const dv = new DataView(frame.buffer);

    frame[0] = 0; // GET_PROPERTY_CMD_TYPE
    frame[1] = (origLen >> 16) & 0xFF;
    frame[2] = (origLen >> 8) & 0xFF;
    frame[3] = origLen & 0xFF;
    dv.setInt32(4, 0, false);                  // timestamp
    dv.setInt32(8, this.replyCount++, false);   // reply counter
    dv.setInt32(12, 0, false);                 // pad
    if (encVal.length > 0) {
      frame.set(encVal, 16);
    }
    this._sendGfx(frame);
  }

  /**
   * Send raw bytes as a property response (for crypto keys).
   * Same frame format as _sendPropertyResponse but takes Uint8Array directly.
   */
  _sendPropertyResponseBytes(rawBytes) {
    // Only encrypt when data is non-empty — server skips decryption when dataLen == 0
    const origLen = rawBytes.length;
    const encVal = (origLen > 0 && this.crypto.isEnabled()) ? this.crypto.encrypt(rawBytes) : rawBytes;
    const frame = new Uint8Array(16 + encVal.length);
    const dv = new DataView(frame.buffer);

    frame[0] = 0; // GET_PROPERTY_CMD_TYPE
    frame[1] = (origLen >> 16) & 0xFF;
    frame[2] = (origLen >> 8) & 0xFF;
    frame[3] = origLen & 0xFF;
    dv.setInt32(4, 0, false);                  // timestamp
    dv.setInt32(8, this.replyCount++, false);   // reply counter
    dv.setInt32(12, 0, false);                 // pad
    if (encVal.length > 0) {
      frame.set(encVal, 16);
    }
    this._sendGfx(frame);
  }

  /**
   * Send a SET_PROPERTY reply via event channel.
   * Frame: [1B type=1][3B len=4][4B ts=0][4B counter][4B pad=0][4B retval]
   * @param {number} retval - return code (0 = success)
   * @param {boolean} [encrypt] - override encryption state (used to snapshot state before handler runs)
   */
  _sendSetPropertyReply(retval, encrypt) {
    const retbuf = new Uint8Array(4);
    new DataView(retbuf.buffer).setInt32(0, retval, false);

    const shouldEncrypt = encrypt !== undefined ? encrypt : this.crypto.isEnabled();
    // Use forceEncrypt() to bypass the enabled check — the handler may have already
    // called crypto.disable() (e.g. CRYPTO_EVENTS_ENABLE=FALSE), but the reply must
    // still be encrypted based on the snapshot taken before the handler ran.
    const encRet = shouldEncrypt ? this.crypto.forceEncrypt(retbuf) : retbuf;

    // Header length field is always 4 (original data length), matching Java client behavior.
    // When encrypted, actual payload is larger due to PKCS5 padding.
    const frame = new Uint8Array(16 + encRet.length);
    const dv = new DataView(frame.buffer);

    frame[0] = 1; // SET_PROPERTY_CMD_TYPE
    frame[1] = (4 >> 16) & 0xFF;
    frame[2] = (4 >> 8) & 0xFF;
    frame[3] = 4 & 0xFF;
    dv.setInt32(4, 0, false);                  // timestamp
    dv.setInt32(8, this.replyCount++, false);   // reply counter
    dv.setInt32(12, 0, false);                 // pad
    frame.set(encRet, 16);
    this._sendGfx(frame);
  }

  // ── Drawing Commands ────────────────────────────────────

  /**
   * Handle a DRAWING_CMD message containing a single GFX command.
   * Payload: [1B opcode][3B pad][NB args]
   * The opcode is the first byte. readInt(pos) adds 4 for the 4-byte header.
   */
  _handleDrawingCommand(data) {
    if (data.length < 1) return;

    const cmd = data[0] & 0xFF; // GFXCMD opcode is first byte of payload
    const len = data.length;     // Total payload length (including 4-byte header)
    this._gfxCmdCount = (this._gfxCmdCount || 0) + 1;

    try {
      const hasret = [0];
      const retval = this._executeGfxCommand(cmd, len, data, hasret);

      if (hasret[0]) {
        this._sendGfxReturnValue(retval);
      }
    } catch (err) {
      console.error(`[Connection] GFX cmd ${cmd} (${GFXCMD_NAMES[cmd] || '?'}) failed, len=${len}: ${err.message}\n${err.stack}`);
    }
  }

  /**
   * Execute a single GFX command.
   * Port of GFXCMD2.ExecuteGFXCommand()
   */
  _executeGfxCommand(cmd, len, cmddata, hasret) {
    len -= 4; // Subtract header
    hasret[0] = 0;

    // Helper to read big-endian int32 at position (with 4-byte header offset)
    const readInt = (pos) => {
      const off = pos + 4;
      return ((cmddata[off] & 0xFF) << 24) |
             ((cmddata[off + 1] & 0xFF) << 16) |
             ((cmddata[off + 2] & 0xFF) << 8) |
             (cmddata[off + 3] & 0xFF);
    };

    // Track commands per frame for diagnostics
    const cmdName = GFXCMD_NAMES[cmd] || `CMD${cmd}`;
    if (this._frameCmdSummary) {
      this._frameCmdSummary[cmdName] = (this._frameCmdSummary[cmdName] || 0) + 1;
      // Verbose logging: log every command within the frame for debugging
      if (this._verboseGfxLog) {
        console.log(`[GFX] ${cmdName} len=${len}`);
      }
    } else {
      // Log commands outside STARTFRAME..FLIPBUFFER (pre-frame setup)
      if (cmd !== GFXCMD.STARTFRAME) {
        if (!this._preFrameLogged) this._preFrameLogged = new Set();
        if (!this._preFrameLogged.has(cmdName)) {
          this._preFrameLogged.add(cmdName);
          console.log(`[Connection] Pre-frame cmd: ${cmdName} (len=${len})`);
        }
      }
    }

    switch (cmd) {
      case GFXCMD.INIT:
        hasret[0] = 1;
        this.handleCount = 1; // Reset for fresh server session
        this.renderer.init();
        return 1;

      case GFXCMD.DEINIT:
        console.log('[Connection] Server sent GFXCMD_DEINIT — disabling reconnect');
        this.reconnectAllowed = false;
        this.renderer.deinit();
        break;

      case GFXCMD.STARTFRAME:
        this.renderer.startFrame();
        this._frameCmdSummary = {};
        this.firstFrameStarted = true;
        if (!this._firstFrameFired) {
          this._firstFrameFired = true;
          this.dispatchEvent(new CustomEvent('firstframe'));
        }
        break;

      case GFXCMD.FLIPBUFFER: {
        hasret[0] = 1;
        this.renderer.flipBuffer();
        // Log frame command summary
        if (this._frameCmdSummary) {
          const parts = Object.entries(this._frameCmdSummary)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ');
          console.log(`[Frame] ${parts}`);
          // One-shot: log all loaded images on first frame
          if (!this._firstFrameLogged) {
            this._firstFrameLogged = true;
            const imgs = [];
            for (const [h, img] of this.renderer.images) {
              imgs.push(`h${h}:${img.width}x${img.height}${img.loaded?'':'(pending)'}`);
            }
            console.log(`[Frame1] Images: ${imgs.join(', ')}`);
            const surfs = [];
            for (const [h, s] of this.renderer.surfaces) {
              surfs.push(`h${h}:${s.width}x${s.height}`);
            }
            if (surfs.length) console.log(`[Frame1] Surfaces: ${surfs.join(', ')}`);
            // Log DRAWTEXTURED summary for frame 1
            if (this._dtLog) {
              const dtParts = Object.entries(this._dtLog)
                .map(([k, v]) => `${k}(n=${v.count},blend=${v.blend},a=${v.ba},src=${v.sw}x${v.sh},dst=${v.firstDx},${v.firstDy},${v.firstDw}x${v.firstDh},surf=${v.surface})`)
                .join(', ');
              console.log(`[Frame1] DrawTex: ${dtParts}`);
            }
          }
          this._frameCmdSummary = null;
        }
        // Turn off verbose logging after 3 frames
        if (this._verboseGfxLog) {
          this._verboseFrameCount = (this._verboseFrameCount || 0) + 1;
          if (this._verboseFrameCount >= 10) {
            this._verboseGfxLog = false;
            console.log('[Connection] Verbose GFX logging disabled after 3 frames');
          }
        }
        return 0;
      }

      case GFXCMD.DRAWRECT:
        if (len === 36) {
          this.renderer.drawRect(
            readInt(0), readInt(4), readInt(8), readInt(12), // x, y, w, h
            readInt(16), // thickness
            readInt(20), readInt(24), readInt(28), readInt(32) // argb TL, TR, BR, BL
          );
        }
        break;

      case GFXCMD.FILLRECT:
        if (len === 32) {
          this.renderer.fillRect(
            readInt(0), readInt(4), readInt(8), readInt(12), // x, y, w, h
            readInt(16), readInt(20), readInt(24), readInt(28) // argb TL, TR, BR, BL
          );
        }
        break;

      case GFXCMD.CLEARRECT:
        if (len === 32) {
          this.renderer.clearRect(
            readInt(0), readInt(4), readInt(8), readInt(12),
            readInt(16), readInt(20), readInt(24), readInt(28)
          );
        }
        break;

      case GFXCMD.DRAWOVAL:
        if (len === 52) {
          this.renderer.drawOval(
            readInt(0), readInt(4), readInt(8), readInt(12), // x, y, w, h
            readInt(16), // thickness
            readInt(20), readInt(24), readInt(28), readInt(32), // argb
            readInt(36), readInt(40), readInt(44), readInt(48)  // clip x, y, w, h
          );
        }
        break;

      case GFXCMD.FILLOVAL:
        if (len === 48) {
          this.renderer.fillOval(
            readInt(0), readInt(4), readInt(8), readInt(12),
            readInt(16), readInt(20), readInt(24), readInt(28),
            readInt(32), readInt(36), readInt(40), readInt(44)
          );
        }
        break;

      case GFXCMD.DRAWROUNDRECT:
        if (len === 56) {
          this.renderer.drawRoundRect(
            readInt(0), readInt(4), readInt(8), readInt(12),
            readInt(16), readInt(20) * 2, // thickness, arcRadius (*2 per Java code)
            readInt(24), readInt(28), readInt(32), readInt(36),
            readInt(40), readInt(44), readInt(48), readInt(52)
          );
        }
        break;

      case GFXCMD.FILLROUNDRECT:
        if (len === 52) {
          this.renderer.fillRoundRect(
            readInt(0), readInt(4), readInt(8), readInt(12),
            readInt(16) * 2, // arcRadius (*2 per Java code)
            readInt(20), readInt(24), readInt(28), readInt(32),
            readInt(36), readInt(40), readInt(44), readInt(48)
          );
        }
        break;

      case GFXCMD.DRAWLINE:
        if (len === 24) {
          this.renderer.drawLine(
            readInt(0), readInt(4), readInt(8), readInt(12), // x1, y1, x2, y2
            readInt(16), readInt(20) // argb1, argb2
          );
        }
        break;

      case GFXCMD.DRAWTEXT: {
        // x(4) y(4) textlen(4) text(textlen*2 UTF-16BE) fontHandle(4) argb(4) clipX(4) clipY(4) clipW(4) clipH(4)
        if (len >= 36) {
          const x = readInt(0);
          const y = readInt(4);
          const textLen = readInt(8);
          if (len >= 36 + textLen * 2) {
            let text = '';
            for (let i = 0; i < textLen; i++) {
              const off = 16 + i * 2;
              text += String.fromCharCode(((cmddata[off] & 0xFF) << 8) | (cmddata[off + 1] & 0xFF));
            }
            const baseOff = textLen * 2;
            const fontHandle = readInt(12 + baseOff);
            const argb = readInt(16 + baseOff);
            const clipX = readInt(20 + baseOff);
            const clipY = readInt(24 + baseOff);
            const clipW = readInt(28 + baseOff);
            const clipH = readInt(32 + baseOff);
            const fontInfo = this._fontMap.get(fontHandle);
            this.renderer.drawText(x, y, text, fontInfo, argb, clipX, clipY, clipW, clipH);
          }
        }
        break;
      }

      case GFXCMD.DRAWTEXTURED:
        if (len === 40) {
          const handle = readInt(16);
          const dx = readInt(0), dy = readInt(4), dw = readInt(8), dh = readInt(12);
          const sx = readInt(20), sy = readInt(24), sw = readInt(28), sh = readInt(32);
          let blend = readInt(36);
          // One-shot: log first frame's DRAWTEXTURED calls
          if (!this._firstFrameLogged) {
            const ba = (blend >>> 24) & 0xFF;
            if (!this._dtLog) this._dtLog = {};
            const key = `h${handle}`;
            if (!this._dtLog[key]) {
              this._dtLog[key] = { count: 0, blend: `0x${(blend >>> 0).toString(16)}`, ba, sw, sh, firstDx: dx, firstDy: dy, firstDw: dw, firstDh: dh, surface: this.renderer.targetSurface };
            }
            this._dtLog[key].count++;
            // Detect server rendering resolution from the first full-screen background draw
            if (!this._serverResDetected && dx === 0 && dy === 0 && dw > 0 && dh > 0) {
              const absDw = Math.abs(dw);
              const absDh = Math.abs(dh);
              if (absDw !== this.width || absDh !== this.height) {
                console.log(`[Connection] Server renders at ${absDw}x${absDh}, canvas was ${this.width}x${this.height} — resizing`);
                this.width = absDw;
                this.height = absDh;
                this.renderer.setSize(absDw, absDh);
                this.dispatchEvent(new CustomEvent('resolutionchange', { detail: { width: absDw, height: absDh } }));
              }
              this._serverResDetected = true;
            }
          }
          this.renderer.drawTexture(dx, dy, dw, dh, handle, sx, sy, sw, sh, blend);
        }
        break;

      case GFXCMD.DRAWTEXTUREDDIFFUSE:
        if (len >= 48) {
          const handle = readInt(16);
          this.renderer.drawTexture(
            readInt(0), readInt(4), readInt(8), readInt(12),
            handle,
            readInt(20), readInt(24), readInt(28), readInt(32),
            readInt(36) // blend
          );
          // diffuse handle at readInt(40) - simplified for now
        }
        break;

      case GFXCMD.LOADIMAGE: {
        if (len >= 8) {
          const imgHandle = this.handleCount++;
          const width = readInt(0);
          const height = readInt(4);
          const canCache = this.renderer.canCacheImage(width, height);
          console.log(`[GFX] LOADIMAGE: ${width}x${height} canCache=${canCache} handle=${imgHandle} cachePixels=${this.renderer._currentCachePixels}/${this.renderer._maxCachePixels}`);
          if (canCache) {
            this.renderer.loadImage(imgHandle, width, height);
            hasret[0] = 1;
            return imgHandle;
          }
          hasret[0] = 1;
          return 0; // Can't cache
        }
        break;
      }

      case GFXCMD.LOADIMAGETARGETED: {
        if (len >= 12) {
          const imgHandle = readInt(0);
          const width = readInt(4);
          const height = readInt(8);
          this.renderer.loadImage(imgHandle, width, height);
        }
        break;
      }

      case GFXCMD.UNLOADIMAGE: {
        if (len === 4) {
          const handle = readInt(0);
          this.renderer.unloadImage(handle);
        }
        break;
      }

      case GFXCMD.LOADIMAGELINE: {
        if (len >= 12) {
          const handle = readInt(0);
          const line = readInt(4);
          const lineLen = readInt(8);
          if (len >= 12 + lineLen) {
            const lineData = cmddata.subarray(16, 16 + lineLen);
            this.renderer.loadImageLine(handle, line, lineLen, lineData);
          }
        }
        break;
      }

      case GFXCMD.LOADIMAGECOMPRESSED: {
        if (len >= 8) {
          const handle = readInt(0);
          const dataLen = readInt(4);
          console.log(`[GFX] LOADIMAGECOMPRESSED: handle=${handle} dataLen=${dataLen} advCache=${this._advancedImageCaching}`);
          if (len >= 8 + dataLen) {
            const imgData = cmddata.subarray(12, 12 + dataLen);
            let rvHandle;
            if (!this._advancedImageCaching) {
              rvHandle = this.handleCount++;
              hasret[0] = 1;
            } else {
              rvHandle = handle;
              hasret[0] = 0;
            }
            // Store the decode promise so _processGfxBuffer can pause
            // until the image is ready (matching Java's synchronous decode)
            this._pendingImageDecode = this.renderer.loadCompressedImage(rvHandle, imgData);
            return rvHandle;
          }
        }
        break;
      }

      case GFXCMD.PREPIMAGE: {
        if (len >= 8) {
          const width = readInt(0);
          const height = readInt(4);
          console.log(`[GFX] PREPIMAGE: ${width}x${height} canCache=${this.renderer.canCacheImage(width, height)}`);
          let imgHandle = 1;
          if (!this.renderer.canCacheImage(width, height)) {
            imgHandle = 0;
          } else if (len >= 12) {
            const strLen = readInt(8);
            if (strLen > 1) {
              const rezName = new TextDecoder('iso-8859-1').decode(
                cmddata.subarray(16, 16 + strLen - 1)
              );
              imgHandle = Math.abs(hashCode(rezName));
              // Check local cache
              const cached = this.renderer.getCachedImage(rezName);
              if (cached) {
                const rvHandle = this.handleCount++;
                this.renderer.putCachedImage(rvHandle, cached, width, height);
                hasret[0] = 1;
                return -1 * rvHandle; // Negative = cache hit
              }
              this._lastImageResourceID = rezName;
              this._lastImageResourceIDHandle = imgHandle;
            }
          }
          hasret[0] = 1;
          return imgHandle;
        }
        break;
      }

      case GFXCMD.PREPIMAGETARGETED: {
        if (len >= 12) {
          const imgHandle = readInt(0);
          const width = readInt(4);
          const height = readInt(8);
          console.log(`[GFX] PREPIMAGETARGETED: handle=${imgHandle} ${width}x${height}`);
          if (len >= 16) {
            const strLen = readInt(12);
            if (strLen > 1) {
              const rezName = new TextDecoder('iso-8859-1').decode(
                cmddata.subarray(20, 20 + strLen - 1)
              );
              this._lastImageResourceID = rezName;
              this._lastImageResourceIDHandle = imgHandle;
            }
          }
        }
        break;
      }

      case GFXCMD.LOADCACHEDIMAGE: {
        if (len >= 18) {
          const imgHandle = readInt(0);
          const width = readInt(4);
          const height = readInt(8);
          const strLen = readInt(12);
          const rezName = new TextDecoder('iso-8859-1').decode(
            cmddata.subarray(20, 20 + strLen - 1)
          );
          const cached = this.renderer.getCachedImage(rezName);
          if (cached) {
            this.renderer.putCachedImage(imgHandle, cached, width, height);
          } else {
            // Tell server this image isn't loaded
            this.renderer.unloadImage(imgHandle);
            this.postOfflineCacheChange(false, rezName);
          }
        }
        break;
      }

      case GFXCMD.CREATESURFACE: {
        if (len >= 8) {
          const imgHandle = this.handleCount++;
          const width = readInt(0);
          const height = readInt(4);
          console.log(`[Connection] CREATESURFACE: handle=${imgHandle}, ${width}x${height}`);
          this.renderer.createSurface(imgHandle, width, height);
          hasret[0] = 1;
          return imgHandle;
        }
        break;
      }

      case GFXCMD.SETTARGETSURFACE: {
        if (len === 4) {
          const handle = readInt(0);
          console.log(`[Connection] SETTARGETSURFACE: handle=${handle}`);
          this.renderer.setTargetSurface(handle);
        }
        break;
      }

      case GFXCMD.XFMIMAGE: {
        if (len >= 20) {
          const srcHandle = readInt(0);
          const destHandle = readInt(4);
          const destWidth = readInt(8);
          const destHeight = readInt(12);
          const maskCornerArc = readInt(16);
          let rvHandle;
          if (!this._advancedImageCaching) {
            rvHandle = this.handleCount++;
            hasret[0] = 1;
          } else {
            rvHandle = destHandle;
            hasret[0] = 0;
          }
          // Java only checks canCache when hasret=1 (non-advanced mode)
          const srcImg = this.renderer.hasImage(srcHandle);
          if ((hasret[0] === 1 && !this.renderer.canCacheImage(destWidth, destHeight)) || !srcImg) {
            rvHandle = 0;
          } else {
            this.renderer.xfmImage(srcHandle, rvHandle, destWidth, destHeight, maskCornerArc);
          }
          return rvHandle;
        }
        break;
      }

      case GFXCMD.PUSHTRANSFORM: {
        // 12 floats (3x4 matrix) = 48 bytes
        if (len >= 48) {
          const matrix = [];
          for (let i = 0; i < 12; i++) {
            // Read as float using DataView
            const buf = cmddata.buffer || cmddata;
            const off = (cmddata.byteOffset || 0) + 4 + i * 4;
            const dv = new DataView(buf, off, 4);
            matrix.push(dv.getFloat32(0, false));
          }
          this.renderer.pushTransform(matrix);
        }
        break;
      }

      case GFXCMD.POPTRANSFORM:
        this.renderer.popTransform();
        break;

      case GFXCMD.LOADFONT: {
        // Server sends: namelen(4) name(namelen) style(4) size(4)
        // Must return a font handle (server blocks on getIntReply)
        if (len >= 12) {
          const fontHandle = this.handleCount++;
          const nameLen = readInt(0);
          const nameBytes = cmddata.subarray(8, 8 + nameLen - 1); // skip null terminator
          const fontName = new TextDecoder('iso-8859-1').decode(nameBytes);
          const style = readInt(4 + nameLen);
          const size = readInt(8 + nameLen);
          // style: 0=PLAIN, 1=BOLD, 2=ITALIC, 3=BOLD+ITALIC
          this._fontMap.set(fontHandle, { name: fontName, style, size });
          hasret[0] = 1;
          return fontHandle;
        }
        hasret[0] = 1;
        return 0;
      }

      case GFXCMD.UNLOADFONT:
        // Server's unloadFontMini is empty — no reply expected
        break;

      case GFXCMD.LOADFONTSTREAM: {
        if (len >= 8) {
          const nameLen = readInt(0);
          const nameBytes = cmddata.subarray(8, 8 + nameLen - 1);
          const fontName = new TextDecoder('iso-8859-1').decode(nameBytes);
          const dataLen = readInt(4 + nameLen);
          if (len >= 8 + nameLen + dataLen) {
            const fontData = cmddata.subarray(12 + nameLen, 12 + nameLen + dataLen);
            this.renderer.loadFontStream(fontName, fontData);
          }
        }
        break;
      }

      case GFXCMD.SETVIDEOPROP: {
        if (len >= 40) {
          const srcRect = {
            x: readInt(4), y: readInt(8), width: readInt(12), height: readInt(16)
          };
          const destRect = {
            x: readInt(20), y: readInt(24), width: readInt(28), height: readInt(32)
          };
          if (this.mediaPlayer) {
            this.mediaPlayer.setVideoRectangles(srcRect, destRect);
          }
          this.renderer.setVideoBounds(srcRect, destRect);
        }
        break;
      }

      case GFXCMD.TEXTUREBATCH:
        // Batch hint - no action needed
        break;

      default:
        console.warn(`[Connection] Unknown GFX command: ${cmd} (${GFXCMD_NAMES[cmd] || '?'}) len=${len} rawBytes=[${Array.from(cmddata.subarray(0, Math.min(20, cmddata.length))).map(b=>b.toString(16).padStart(2,'0')).join(' ')}]`);
        return -1;
    }
    return 0;
  }

  /**
   * Send a GFX return value to the server via event channel.
   * Frame: [1B type=0x10][3B len=4][4B ts=0][4B counter][4B pad=0][4B retval]
   */
  _sendGfxReturnValue(value) {
    const retbuf = new Uint8Array(4);
    new DataView(retbuf.buffer).setInt32(0, value, false);

    const encRet = this.crypto.isEnabled() ? this.crypto.encrypt(retbuf) : retbuf;
    // Header length field is always 4 (original data length)
    const frame = new Uint8Array(16 + encRet.length);
    const dv = new DataView(frame.buffer);

    frame[0] = 0x10; // DRAWING_CMD_TYPE
    frame[1] = (4 >> 16) & 0xFF;
    frame[2] = (4 >> 8) & 0xFF;
    frame[3] = 4 & 0xFF;
    dv.setInt32(4, 0, false);                  // timestamp
    dv.setInt32(8, this.replyCount++, false);   // reply counter
    dv.setInt32(12, 0, false);                 // pad
    frame.set(encRet, 16);
    this._sendGfx(frame);
  }

  /**
   * Send raw bytes on the GFX socket.
   */
  _sendGfx(data) {
    if (this.gfxSocket && this.gfxSocket.readyState === WebSocket.OPEN) {
      if (this._verboseGfxLog && data.length >= 16) {
        const type = data[0];
        const origLen = ((data[1]&0xFF)<<16)|((data[2]&0xFF)<<8)|(data[3]&0xFF);
        const dv = new DataView(data.buffer || new Uint8Array(data).buffer, data.byteOffset || 0);
        const replyNum = dv.getInt32(8, false);
        const typeName = {0:'GET_PROP',1:'SET_PROP',0x10:'DRAW_CMD'}[type]||`T${type}`;
        console.log(`[Reply] ${typeName} reply#${replyNum} origLen=${origLen} wireLen=${data.length-16} enc=${this.crypto.isEnabled()}`);
      }
      this.gfxSocket.send(data);
    } else {
      if (!this._socketClosedWarned) {
        this._socketClosedWarned = true;
        console.warn(`[Reply] Socket not open, dropping replies (first: ${data.length}B). Suppressing further warnings.`);
      }
    }
  }

  // ── Media Stream Processing ──────────────────────────────

  _onMediaData(data) {
    this.mediaBuffer.append(new Uint8Array(data));
    this._processMediaBuffer();
  }

  _processMediaBuffer() {
    while (this.mediaBuffer.length >= 4) {
      const header = this.mediaBuffer.peek(4);
      if (!header) break;

      const cmd = header[0] & 0xFF;
      const len = ((header[1] & 0xFF) << 16) | ((header[2] & 0xFF) << 8) | (header[3] & 0xFF);

      if (this.mediaBuffer.length < 4 + len) break;

      this.mediaBuffer.consume(4);
      const payload = len > 0 ? this.mediaBuffer.consume(len) : new Uint8Array(0);

      if (cmd !== 23 && cmd !== 17 && cmd !== 0) console.log(`[Media] cmd=${cmd} len=${len}`);
      this._handleMediaCommand(cmd, len, payload);
    }
  }

  /**
   * Handle a media command from the server.
   * Port of MediaCmd.java
   */
  _handleMediaCommand(cmd, len, data) {
    const readInt = (pos) => {
      return ((data[pos] & 0xFF) << 24) | ((data[pos + 1] & 0xFF) << 16) |
             ((data[pos + 2] & 0xFF) << 8) | (data[pos + 3] & 0xFF);
    };

    const readLong = (pos) => {
      const hi = readInt(pos);
      const lo = readInt(pos + 4);
      return hi * 0x100000000 + (lo >>> 0);
    };

    if (!this.mediaPlayer) return;

    switch (cmd) {
      case 0: // MEDIACMD_INIT
        console.log('[Media] INIT');
        this._sendMediaReturn(1);
        break;

      case 1: // MEDIACMD_DEINIT
        console.log('[Media] DEINIT');
        this.mediaPlayer.stop();
        this._sendMediaReturn(1);
        break;

      case 16: { // MEDIACMD_OPENURL
        if (len >= 4) {
          const strLen = readInt(0);
          let urlString = '';
          if (strLen > 1) {
            urlString = new TextDecoder('iso-8859-1').decode(data.subarray(4, 4 + strLen - 1));
          }
          const isPush = urlString.startsWith('push:');
          console.log(`[Media] OPENURL: ${urlString} (push=${isPush})`);
          this.mediaPlayer.load(0, 0, '', urlString, this.serverHost, isPush, 0);
        }
        this._sendMediaReturn(1);
        break;
      }

      case 17: { // MEDIACMD_GETMEDIATIME
        const time = this.mediaPlayer.getMediaTimeMillis();
        this._sendMediaReturn(time & 0x7FFFFFFF);
        break;
      }

      case 18: // MEDIACMD_SETMUTE
        if (len >= 4) {
          this.mediaPlayer.setMute(readInt(0) !== 0);
        }
        this._sendMediaReturn(1);
        break;

      case 19: // MEDIACMD_STOP
        this.mediaPlayer.stop();
        this._sendMediaReturn(1);
        break;

      case 20: // MEDIACMD_PAUSE
        this.mediaPlayer.pause();
        this._sendMediaReturn(1);
        break;

      case 21: // MEDIACMD_PLAY
        this.mediaPlayer.play();
        this._sendMediaReturn(1);
        break;

      case 22: // MEDIACMD_FLUSH
        this.mediaPlayer.flush();
        this._sendMediaReturn(1);
        break;

      case 23: { // MEDIACMD_PUSHBUFFER
        if (len >= 8) {
          const bufSize = readInt(0);
          const flags = readInt(4);
          const bufDataOffset = 8;
          if (bufSize > 0 && len >= bufDataOffset + bufSize) {
            const bufData = data.subarray(bufDataOffset, bufDataOffset + bufSize);
            this.mediaPlayer.pushData(bufData, flags);
          }
          if (flags === 0x80) {
            this.mediaPlayer.setServerEOS();
          }
        }
        const bufLeft = this.mediaPlayer.getBufferLeft();
        this._sendMediaReturn(bufLeft);
        break;
      }

      case 24: { // MEDIACMD_GETVIDEORECT
        const dim = this.mediaPlayer.getVideoDimensions();
        this._sendMediaReturn((dim.width << 16) | dim.height);
        break;
      }

      case 25: { // MEDIACMD_SETVIDEORECT
        if (len >= 32) {
          const srcRect = { x: readInt(0), y: readInt(4), width: readInt(8), height: readInt(12) };
          const destRect = { x: readInt(16), y: readInt(20), width: readInt(24), height: readInt(28) };
          this.mediaPlayer.setVideoRectangles(srcRect, destRect);
        }
        this._sendMediaReturn(0);
        break;
      }

      case 26: { // MEDIACMD_GETVOLUME
        const vol = this.mediaPlayer.getVolume();
        this._sendMediaReturn(vol);
        break;
      }

      case 27: { // MEDIACMD_SETVOLUME
        if (len >= 4) {
          const vol = readInt(0);
          this.mediaPlayer.setVolume(vol / 65535);
        }
        this._sendMediaReturn(Math.round(this.mediaPlayer.getVolume()));
        break;
      }

      case 28: // MEDIACMD_FRAMESTEP
        this.mediaPlayer.frameStep();
        this._sendMediaReturn(0);
        break;

      case 29: { // MEDIACMD_SEEK — no reply per Java client
        if (len >= 8) {
          const timeMS = readLong(0);
          console.log(`[Media] SEEK: ${timeMS}ms`);
          this.mediaPlayer.seek(timeMS);
        }
        // Java returns 0 bytes (no reply)
        break;
      }

      case 36: { // MEDIACMD_DVD_STREAMS
        if (len >= 8) {
          const streamType = readInt(0); // 0=audio, 1=subtitle
          const streamPos = readInt(4);
          if (streamType === 0) {
            this.mediaPlayer.setAudioTrack(streamPos);
          } else {
            this.mediaPlayer.setSubtitleTrack(streamPos);
          }
        }
        this._sendMediaReturn(0);
        break;
      }

      default:
        console.warn(`[Media] Unknown media command: ${cmd}`);
        this._sendMediaReturn(0);
    }
  }

  _sendMediaReturn(value) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, value, false);
    this._sendMedia(buf);
  }

  _sendMediaReturnLong(value) {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, Math.floor(value / 0x100000000) | 0, false);
    dv.setUint32(4, (value & 0xFFFFFFFF) >>> 0, false);
    this._sendMedia(buf);
  }

  _sendMedia(data) {
    if (this.mediaSocket && this.mediaSocket.readyState === WebSocket.OPEN) {
      this.mediaSocket.send(data.buffer || data);
    } else {
      console.warn(`[Media] Cannot send ${data.length}B — media socket not open`);
    }
  }

  // ── Event Sending (Client → Server) ──────────────────────

  /**
   * Build and send an event frame.
   *
   * Event frame structure (16B header + payload):
   *   [1B event_type] [3B payload_length (big-endian)]
   *   [4B timestamp=0] [4B reply_counter] [4B pad=0]
   *   [NB payload - optionally encrypted]
   */
  _sendEvent(eventType, payload) {
    const encPayload = this.crypto.isEnabled() ? this.crypto.encrypt(payload) : payload;
    const origLen = payload.length; // header uses original length
    const frame = new Uint8Array(16 + encPayload.length);
    const dv = new DataView(frame.buffer);

    frame[0] = eventType;
    // 3-byte big-endian payload length (original, not encrypted)
    frame[1] = (origLen >> 16) & 0xFF;
    frame[2] = (origLen >> 8) & 0xFF;
    frame[3] = origLen & 0xFF;
    dv.setInt32(4, 0, false);                  // timestamp
    dv.setInt32(8, this.replyCount++, false);   // reply counter
    dv.setInt32(12, 0, false);                 // pad

    frame.set(encPayload, 16);

    this._sendGfx(frame);
  }

  /**
   * Send a SageCommand event.
   * @param {number} commandId - SageCommand.id value
   */
  sendCommand(commandId) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, commandId, false);
    this._sendEvent(EventType.SAGECOMMAND, payload);
  }

  /**
   * Send a keyboard event.
   * @param {number} keyCode - Java KeyEvent keyCode
   * @param {number} keyChar - Character code
   * @param {number} modifiers - Java InputEvent modifier flags
   */
  sendKeystroke(keyCode, keyChar, modifiers) {
    const payload = new Uint8Array(10);
    const dv = new DataView(payload.buffer);
    dv.setInt32(0, keyCode, false);
    dv.setUint16(4, keyChar, false);
    dv.setInt32(6, modifiers, false);
    this._sendEvent(EventType.KB_EVENT, payload);
  }

  /**
   * Send an IR event.
   * @param {number} irCode
   */
  sendIR(irCode) {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, irCode, false);
    this._sendEvent(EventType.IR_EVENT, payload);
  }

  /**
   * Send a mouse event.
   * @param {number} eventType - MOUSE_PRESSED, MOUSE_RELEASED, etc.
   * @param {number} x
   * @param {number} y
   * @param {number} modifiers
   * @param {number} button - 1=left, 2=middle, 3=right
   * @param {number} clickCount
   */
  sendMouseEvent(eventType, x, y, modifiers, button, clickCount) {
    const payload = new Uint8Array(14);
    const dv = new DataView(payload.buffer);
    dv.setInt32(0, x, false);
    dv.setInt32(4, y, false);
    dv.setInt32(8, modifiers, false);
    payload[12] = clickCount || 1;
    payload[13] = button || 1;
    this._sendEvent(eventType, payload);
  }

  /**
   * Send a UI resize event.
   * @param {number} width
   * @param {number} height
   */
  sendResize(width, height) {
    this.width = width;
    this.height = height;
    const payload = new Uint8Array(8);
    const dv = new DataView(payload.buffer);
    dv.setInt32(0, width, false);
    dv.setInt32(4, height, false);
    this._sendEvent(EventType.UI_RESIZE, payload);
  }

  /**
   * Send a UI repaint event.
   */
  sendRepaint(x = 0, y = 0, w = this.width, h = this.height) {
    const payload = new Uint8Array(16);
    const dv = new DataView(payload.buffer);
    dv.setInt32(0, x, false);
    dv.setInt32(4, y, false);
    dv.setInt32(8, w, false);
    dv.setInt32(12, h, false);
    this._sendEvent(EventType.UI_REPAINT, payload);
  }

  // ── FS Commands ─────────────────────────────────────────

  _handleFSCommand(data) {
    // FS commands are not commonly used in the MiniClient PWA
    // Respond with error for security
    const readInt = (pos) => {
      return ((data[pos] & 0xFF) << 24) | ((data[pos + 1] & 0xFF) << 16) |
             ((data[pos + 2] & 0xFF) << 8) | (data[pos + 3] & 0xFF);
    };
    const cmd = data.length >= 4 ? readInt(0) : 0;
    console.log(`[Connection] FS command: ${cmd} (denied for security)`);
    // Return NO_PERMISSIONS
    this._sendGfxReturnValue(2);
  }

  // ── Offline Cache ───────────────────────────────────────

  postOfflineCacheChange(added, resourceId) {
    this._offlineCacheChanges.push({ added, resourceId });
    // Will be processed next frame cycle
  }

  doesUseAdvancedImageCaching() {
    return this._advancedImageCaching;
  }

  // ── Disconnect / Reconnect / Keepalive ──────────────────

  /**
   * Start periodic keepalive pings to detect dead connections.
   */
  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveInterval = setInterval(() => {
      if (this.gfxSocket && this.gfxSocket.readyState === WebSocket.OPEN) {
        try {
          // Send a JSON text ping to the bridge (bridge replies with pong)
          this.gfxSocket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Socket write failed — trigger disconnect
          this._onDisconnect('keepalive send failed');
        }
      }
    }, this._keepaliveTimeout);
  }

  _stopKeepalive() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }

  _onDisconnect(reason) {
    const elapsed = this._connectTime ? Date.now() - this._connectTime : 0;
    const elapsedStr = this._connectTime ? `${elapsed}ms after connect` : '?';
    console.warn(`[Connection] Disconnected: ${reason} (${elapsedStr}, cmds=${this._gfxCmdCount||0}, props=${this._propCount||0})`);
    this._stopKeepalive();

    // Track consecutive short-lived sessions to prevent infinite reconnect loops
    if (elapsed < 30000) {
      this._shortSessionCount++;
    } else {
      this._shortSessionCount = 0;
    }

    // After login: server sends CRYPTO_EVENTS_ENABLE=FALSE then closes socket.
    // Reconnect using type 5 (session resume by MAC) — matching Java client.
    // Java condition: reconnectAllowed && alive && firstFrameStarted && !encryptEvents
    // (no cached auth requirement — type 5 resumes existing server session)
    if (this.reconnectAllowed && this.firstFrameStarted && !this._encryptEvents) {
      if (this._shortSessionCount >= 10) {
        console.warn(`[Connection] Stopping reconnect — ${this._shortSessionCount} consecutive short sessions`);
        this.alive = false;
        this._shortSessionCount = 0;
        this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: 'Server keeps disconnecting after auth' } }));
      } else {
        console.log(`[Connection] Post-login disconnect (short#${this._shortSessionCount}) — attempting type-5 session resume`);
        this.alive = false;
        this._attemptSessionReconnect();
      }
    } else {
      this.alive = false;
      console.log(`[Connection] No reconnect: allowed=${this.reconnectAllowed}, frames=${this.firstFrameStarted}, encrypted=${this._encryptEvents}, hasAuth=${!!this._cachedAuthBlock}`);
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason } }));
    }
  }

  /**
   * Schedule a reconnect attempt with exponential backoff.
   */
  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error('[Connection] Max reconnect attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectfailed', {
        detail: { error: new Error('Max reconnect attempts reached') }
      }));
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 16000);
    this._reconnectAttempts++;
    console.log(`[Connection] Reconnect attempt ${this._reconnectAttempts} in ${delay}ms`);

    this.dispatchEvent(new CustomEvent('reconnecting', {
      detail: { attempt: this._reconnectAttempts, delay }
    }));

    this._reconnectTimer = setTimeout(() => this._attemptFullReconnect(), delay);
  }

  /**
   * Attempt type-5 session-resume reconnect (matching Java client behavior).
   * Type 5 tells the server to resume the existing session by MAC address.
   * No property renegotiation needed — server continues sending GFX commands.
   * Falls back to type 0 (fresh) with cached auth if type 5 fails.
   */
  async _attemptSessionReconnect() {
    console.log('[Connection] Attempting type-5 session resume reconnect...');
    try {
      // Close existing sockets cleanly
      if (this.gfxSocket) {
        this.gfxSocket.onclose = null;
        this.gfxSocket.onerror = null;
        try { this.gfxSocket.close(); } catch (e) { /* ignore */ }
      }
      if (this.mediaSocket) {
        this.mediaSocket.onclose = null;
        this.mediaSocket.onerror = null;
        try { this.mediaSocket.close(); } catch (e) { /* ignore */ }
      }

      // Reset stream state but keep images and crypto state
      this.gfxBuffer.clear();
      this.mediaBuffer.clear();
      this.zipMode = false;
      this.inflater.reset();
      this._encryptEvents = false;
      this.crypto.disable();
      this._pendingImageDecode = null;
      this._preFrameLogged = null;
      this.replyCount = 0;
      this._gfxCmdCount = 0;
      this._propCount = 0;
      this._connectTime = Date.now();

      const params = `?host=${encodeURIComponent(this.serverHost)}&port=${this.serverPort}`;

      // Open GFX WebSocket with type 5 (session resume by MAC)
      this.gfxSocket = new WebSocket(`${this.bridgeUrl}/gfx${params}`);
      this.gfxSocket.binaryType = 'arraybuffer';
      await this._waitForOpen(this.gfxSocket, 'GFX-Reconnect');

      try {
        await this._handshake(this.gfxSocket, ConnectionType.GFX_RECONNECT, this.gfxBuffer);
        console.log('[Connection] Type-5 session resume accepted');
      } catch (handshakeErr) {
        console.warn(`[Connection] Type-5 rejected: ${handshakeErr.message}`);
        // Close the failed socket
        try { this.gfxSocket.close(); } catch (e) { /* ignore */ }
        this.gfxSocket = null;

        // Fall back to type-0 fresh reconnect if we have cached auth
        if (this._cachedAuthBlock) {
          console.log('[Connection] Falling back to type-0 fresh reconnect with cached auth');
          return this._attemptFullReconnect();
        } else {
          throw new Error('Type-5 rejected and no cached auth for type-0 fallback');
        }
      }

      this.gfxSocket.onmessage = (event) => this._onGfxData(event.data);
      this.gfxSocket.onclose = () => this._onDisconnect('GFX socket closed');
      this.gfxSocket.onerror = () => this._onDisconnect('GFX socket error');
      this._socketClosedWarned = false;

      // Process any leftover handshake bytes
      if (this.gfxBuffer.length > 0) {
        this._processGfxBuffer();
      }

      // Open fresh Media WebSocket (type 1)
      this.mediaSocket = new WebSocket(`${this.bridgeUrl}/media${params}`);
      this.mediaSocket.binaryType = 'arraybuffer';
      await this._waitForOpen(this.mediaSocket, 'Media-Reconnect');
      await this._handshake(this.mediaSocket, ConnectionType.MEDIA, this.mediaBuffer);

      this.alive = true;
      this.reconnectAllowed = true;
      this._reconnectAttempts = 0;

      this.mediaSocket.onmessage = (event) => this._onMediaData(event.data);
      this.mediaSocket.onclose = () => console.warn('[Connection] Media socket closed');
      this.mediaSocket.onerror = () => console.warn('[Connection] Media socket error');

      this._startKeepalive();
      this.dispatchEvent(new CustomEvent('reconnected'));
      console.log('[Connection] Session resume successful — server will continue rendering');
    } catch (err) {
      console.error('[Connection] Session reconnect failed:', err);
      this._scheduleReconnect();
    }
  }

  /**
   * Perform a full fresh reconnect (type 0) using cached auth to skip login.
   * Used as fallback when type-5 session resume is rejected by the server.
   */
  async _attemptFullReconnect() {
    console.log('[Connection] Attempting full reconnect (fresh connection with cached auth)...');
    try {
      // Close existing sockets cleanly
      if (this.gfxSocket) {
        this.gfxSocket.onclose = null;
        this.gfxSocket.onerror = null;
        try { this.gfxSocket.close(); } catch (e) { /* ignore */ }
      }
      if (this.mediaSocket) {
        this.mediaSocket.onclose = null;
        this.mediaSocket.onerror = null;
        try { this.mediaSocket.close(); } catch (e) { /* ignore */ }
      }

      // Reset all connection state for fresh start
      this.gfxBuffer.clear();
      this.mediaBuffer.clear();
      this.zipMode = false;
      this.inflater.reset();
      this._encryptEvents = false;
      this.crypto.disable();
      this._serverResDetected = false;
      this._firstFrameLogged = false;
      this._firstFrameFired = false;
      this.firstFrameStarted = false;
      this._frameCmdSummary = null;
      this._dtLog = null;
      this._pendingImageDecode = null;
      this._preFrameLogged = null;
      this.replyCount = 0;
      // Do NOT reset handleCount — with ADVANCED_IMAGE_CACHING, the server
      // assumes client images persist. Keeping handleCount avoids collisions
      // between old cached images and new LOADIMAGE assignments.
      this._gfxCmdCount = 0;
      this._propCount = 0;
      this._connectTime = Date.now();

      // Do NOT call renderer.deinit() — with ADVANCED_IMAGE_CACHING=TRUE,
      // the server won't re-send images it already sent in the previous session.
      // Keeping images in memory lets the server reference them by handle.
      console.log(`[Connection] Reconnect: keeping ${this.renderer.images.size} cached images, handleCount=${this.handleCount}`);

      // Restore original canvas dimensions (not auto-detected 720x480)
      this.width = this._originalWidth;
      this.height = this._originalHeight;
      this.renderer.setSize(this.width, this.height);

      const params = `?host=${encodeURIComponent(this.serverHost)}&port=${this.serverPort}`;

      // Open fresh GFX WebSocket (type 0, not type 5)
      this.gfxSocket = new WebSocket(`${this.bridgeUrl}/gfx${params}`);
      this.gfxSocket.binaryType = 'arraybuffer';
      await this._waitForOpen(this.gfxSocket, 'GFX-Reconnect');
      await this._handshake(this.gfxSocket, ConnectionType.GFX, this.gfxBuffer);

      this.gfxSocket.onmessage = (event) => this._onGfxData(event.data);
      this.gfxSocket.onclose = () => this._onDisconnect('GFX socket closed');
      this.gfxSocket.onerror = () => this._onDisconnect('GFX socket error');
      this._socketClosedWarned = false;

      // Process any leftover handshake bytes
      if (this.gfxBuffer.length > 0) {
        this._processGfxBuffer();
      }

      // Open fresh Media WebSocket
      this.mediaSocket = new WebSocket(`${this.bridgeUrl}/media${params}`);
      this.mediaSocket.binaryType = 'arraybuffer';
      await this._waitForOpen(this.mediaSocket, 'Media-Reconnect');
      await this._handshake(this.mediaSocket, ConnectionType.MEDIA, this.mediaBuffer);

      this.alive = true;
      this.reconnectAllowed = true;
      this._reconnectAttempts = 0;

      this.mediaSocket.onmessage = (event) => this._onMediaData(event.data);
      this.mediaSocket.onclose = () => console.warn('[Connection] Media socket closed');
      this.mediaSocket.onerror = () => console.warn('[Connection] Media socket error');

      this._startKeepalive();
      this.dispatchEvent(new CustomEvent('reconnected'));
      console.log('[Connection] Full reconnect successful — server will negotiate properties');

      // The server will now send GET_PROPERTY/SET_PROPERTY again.
      // GET_CACHED_AUTH will return our stored auth block → auto-login.
    } catch (err) {
      console.error('[Connection] Full reconnect failed:', err);
      this._scheduleReconnect();
    }
  }

  async _attemptReconnect() {
    // Delegate to full reconnect
    return this._attemptFullReconnect();
  }

  /**
   * Disconnect both sockets cleanly.
   */
  disconnect() {
    this.alive = false;
    this.reconnectAllowed = false;
    this._stopKeepalive();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.gfxSocket) {
      this.gfxSocket.onclose = null;
      this.gfxSocket.close();
      this.gfxSocket = null;
    }
    if (this.mediaSocket) {
      this.mediaSocket.onclose = null;
      this.mediaSocket.close();
      this.mediaSocket = null;
    }
    this.gfxBuffer.clear();
    this.mediaBuffer.clear();
    this.crypto.reset();
    this.inflater.dispose();
    this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason: 'user' } }));
  }
}

// ── Utility ──────────────────────────────────────────────

/** Java String.hashCode() equivalent */
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}
