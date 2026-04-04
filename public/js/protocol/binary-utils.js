/**
 * Binary read/write utilities for the SageTV protocol.
 * All integers are big-endian. Strings are ISO-8859-1 (Latin-1).
 */

export class BinaryReader {
  constructor(buffer, offset = 0) {
    this.view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
    this.offset = offset;
  }

  readUint8() {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt16() {
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readUint16() {
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt32() {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readUint32() {
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt64() {
    const hi = this.view.getInt32(this.offset, false);
    const lo = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return hi * 0x100000000 + lo;
  }

  readBytes(length) {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return bytes;
  }

  readLatin1String(length) {
    const bytes = this.readBytes(length);
    let str = '';
    for (let i = 0; i < bytes.length; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  remaining() {
    return this.view.byteLength - this.offset;
  }

  skip(n) {
    this.offset += n;
  }
}

export class BinaryWriter {
  constructor(initialSize = 256) {
    this.buffer = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buffer);
    this.offset = 0;
  }

  _ensureCapacity(needed) {
    if (this.offset + needed > this.buffer.byteLength) {
      const newSize = Math.max(this.buffer.byteLength * 2, this.offset + needed);
      const newBuffer = new ArrayBuffer(newSize);
      new Uint8Array(newBuffer).set(new Uint8Array(this.buffer));
      this.buffer = newBuffer;
      this.view = new DataView(this.buffer);
    }
  }

  writeUint8(v) {
    this._ensureCapacity(1);
    this.view.setUint8(this.offset, v);
    this.offset += 1;
    return this;
  }

  writeInt16(v) {
    this._ensureCapacity(2);
    this.view.setInt16(this.offset, v, false);
    this.offset += 2;
    return this;
  }

  writeUint16(v) {
    this._ensureCapacity(2);
    this.view.setUint16(this.offset, v, false);
    this.offset += 2;
    return this;
  }

  writeInt32(v) {
    this._ensureCapacity(4);
    this.view.setInt32(this.offset, v, false);
    this.offset += 4;
    return this;
  }

  writeUint32(v) {
    this._ensureCapacity(4);
    this.view.setUint32(this.offset, v, false);
    this.offset += 4;
    return this;
  }

  writeInt64(v) {
    this._ensureCapacity(8);
    const hi = Math.floor(v / 0x100000000) | 0;
    const lo = (v & 0xFFFFFFFF) >>> 0;
    this.view.setInt32(this.offset, hi, false);
    this.view.setUint32(this.offset + 4, lo, false);
    this.offset += 8;
    return this;
  }

  writeBytes(bytes) {
    this._ensureCapacity(bytes.length);
    new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
    this.offset += bytes.length;
    return this;
  }

  writeLatin1String(str) {
    this._ensureCapacity(str.length);
    for (let i = 0; i < str.length; i++) {
      this.view.setUint8(this.offset + i, str.charCodeAt(i) & 0xFF);
    }
    this.offset += str.length;
    return this;
  }

  toUint8Array() {
    return new Uint8Array(this.buffer, 0, this.offset);
  }

  toArrayBuffer() {
    return this.buffer.slice(0, this.offset);
  }
}

/**
 * Read a big-endian int32 from a Uint8Array at the given offset.
 * Matches Java's readInt(pos, cmddata) which adds a 4-byte header offset.
 */
export function readIntFromCmd(pos, cmddata) {
  const offset = pos + 4; // 4-byte header in the command buffer
  return ((cmddata[offset] & 0xFF) << 24) |
         ((cmddata[offset + 1] & 0xFF) << 16) |
         ((cmddata[offset + 2] & 0xFF) << 8) |
         (cmddata[offset + 3] & 0xFF);
}

/**
 * Read a big-endian int16 from a Uint8Array at the given offset.
 */
export function readShortFromCmd(pos, cmddata) {
  const offset = pos + 4;
  return ((cmddata[offset] & 0xFF) << 8) | (cmddata[offset + 1] & 0xFF);
}

/**
 * Convert ARGB int to CSS rgba() string.
 */
export function argbToRgba(argb) {
  const a = ((argb >>> 24) & 0xFF) / 255;
  const r = (argb >>> 16) & 0xFF;
  const g = (argb >>> 8) & 0xFF;
  const b = argb & 0xFF;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * Extract ARGB components as [a, r, g, b] each 0-255.
 */
export function argbComponents(argb) {
  return [
    (argb >>> 24) & 0xFF,
    (argb >>> 16) & 0xFF,
    (argb >>> 8) & 0xFF,
    argb & 0xFF
  ];
}

/**
 * Generate a pseudo-random MAC address for client identification.
 * Stored in localStorage for session persistence.
 */
export function getOrCreateMacAddress() {
  let mac = localStorage.getItem('sagetv_mac');
  if (!mac) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    bytes[0] = (bytes[0] & 0xFE) | 0x02; // locally administered
    mac = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(':');
    localStorage.setItem('sagetv_mac', mac);
  }
  return mac;
}

/**
 * Parse MAC string "AA:BB:CC:DD:EE:FF" to 6-byte Uint8Array.
 */
export function parseMac(macStr) {
  return new Uint8Array(macStr.split(':').map(h => parseInt(h, 16)));
}
