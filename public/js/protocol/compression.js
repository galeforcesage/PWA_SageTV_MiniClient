/**
 * Compression module wrapping pako.js for zlib inflate/deflate.
 *
 * The SageTV protocol optionally compresses the GFX command stream using
 * zlib (Z_SYNC_FLUSH). This module provides a streaming inflater that
 * matches the Java jzlib ZInputStream behavior.
 */

let pako = null;
let Z_SYNC_FLUSH = 2; // default value in case constants aren't accessible

/**
 * Load pako (local copy in js/lib/).
 * Called once during initialization.
 */
export async function initCompression() {
  if (pako) return;
  try {
    const module = await import('../lib/pako.esm.js');
    pako = module;
    Z_SYNC_FLUSH = (pako.constants && pako.constants.Z_SYNC_FLUSH) || 2;
    console.log(`[Compression] pako loaded, Z_SYNC_FLUSH=${Z_SYNC_FLUSH}`);
  } catch (e) {
    console.error('[Compression] Failed to load pako:', e);
  }
}

/**
 * Streaming zlib inflater that matches Java's ZInputStream(raw=true, Z_SYNC_FLUSH).
 * Wraps the entire TCP stream — all incoming bytes are deflated.
 */
export class StreamInflater {
  constructor() {
    this._inflator = null;
    this._pendingChunks = [];
    this.enabled = false;
  }

  /**
   * Enable compression and initialize the inflater.
   * Uses raw deflate (no zlib header) to match jzlib ZInputStream(true).
   */
  enable() {
    if (!pako) {
      console.error('[StreamInflater] pako not loaded, cannot enable compression');
      return;
    }
    // raw: true = raw deflate (no zlib header), matching Java's nowrap=true
    this._inflator = new pako.Inflate({ raw: true, chunkSize: 64 * 1024 });
    this._pendingChunks = [];
    // Override onData to collect output chunks reliably
    this._inflator.onData = (chunk) => {
      // Copy the chunk since pako may reuse the underlying buffer
      this._pendingChunks.push(new Uint8Array(chunk));
    };
    this.enabled = true;
    console.log('[StreamInflater] Enabled with raw deflate mode');
  }

  /**
   * Feed compressed data and return decompressed output.
   * This is a streaming inflater — call repeatedly with chunks.
   *
   * With Z_SYNC_FLUSH, pako only calls onData when the output buffer is
   * completely full (avail_out === 0) or at Z_STREAM_END. For normal small
   * outputs the data just sits in strm.output without triggering onData.
   *
   * Strategy: reset strm.next_out/avail_out before each push so output
   * always starts at offset 0. Collect onData chunks for overflow cases
   * (output > chunkSize), then also grab any remaining data in strm.output.
   */
  inflate(data) {
    if (!this.enabled || !this._inflator) return data;

    const strm = this._inflator.strm;

    // Reset output position so decompressed data starts at offset 0.
    // On the first call, strm.output is not yet allocated (pako initializes
    // avail_out=0 and allocates lazily). Let pako handle allocation in that case.
    if (strm.output) {
      strm.next_out = 0;
      strm.avail_out = strm.output.length;
    }

    // Clear overflow collection
    this._pendingChunks = [];

    this._inflator.push(data, Z_SYNC_FLUSH);

    if (this._inflator.err && this._inflator.err !== 0) {
      console.error(`[StreamInflater] Inflate error: ${this._inflator.err} ${this._inflator.msg}`);
      this.enable(); // re-initialize cleanly
      return new Uint8Array(0);
    }

    // Collect overflow chunks (from onData when buffer filled mid-push)
    const chunks = this._pendingChunks;
    this._pendingChunks = [];

    // Also grab any data remaining in the current output buffer
    // (the normal case for Z_SYNC_FLUSH with small output)
    if (strm.next_out > 0) {
      chunks.push(new Uint8Array(strm.output.subarray(0, strm.next_out)));
    }

    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    // Concatenate multiple chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Reset the inflater state.
   */
  reset() {
    if (this.enabled) {
      this.enable(); // re-initialize with onData handler
    }
  }

  dispose() {
    this._inflator = null;
    this._pendingChunks = [];
    this.enabled = false;
  }
}

/**
 * One-shot deflate for sending compressed data.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function deflate(data) {
  if (!pako) return data;
  return pako.deflate(data);
}

/**
 * One-shot inflate for receiving compressed data.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function inflate(data) {
  if (!pako) return data;
  return pako.inflate(data);
}
