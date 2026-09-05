/**
 * Client counterpart to server sage.SegmentTimeline (java/sage/SegmentTimeline.java).
 *
 * Whole-recording virtual timeline over a multi-segment recording — the classic
 * SageTV model (one logical program = N physical files with real gaps between
 * them).  1:1 port so both ends compute the SAME content<->segment mapping.
 *
 * Two timelines (mixing them is the classic bug source):
 *   - content time: continuous, gaps COLLAPSED.  What continuous playback delivers.
 *     Segment i begins at contentBaseMs(i).  comskip marks + caption cues (both
 *     file-relative per physical file) map into content time by adding contentBaseMs(i).
 *     This is the WIRE UNIT — GETMEDIATIME and MEDIACMD_SEEK both use content time.
 *   - wall-clock time: startTimeUtcMs epoch, gaps PRESERVED.  The server applies
 *     contentToWallClockMs() for the OSD clock label so the viewer sees the real
 *     program time (14:59 → jump → 29:00).  The client never sends wall-clock.
 */

/**
 * @typedef {Object} NgSegment
 * @property {number} index          0-based physical segment index
 * @property {number} startTimeUtcMs Wall-clock start (epoch ms)
 * @property {number} durationMs     Content duration of this segment (ms)
 * @property {number} contentBaseMs  Content-time offset (ms) = sum(durationMs[0..i-1])
 * @property {number} gapBeforeMs    Wall-clock gap (ms) before this segment; 0 for index 0
 * @property {number} fileSizeBytes  File size at snapshot time, or 0
 */

/**
 * @typedef {Object} NgSegmentManifest
 * @property {number} count
 * @property {number} totalContentMs
 * @property {boolean} hasGaps
 * @property {NgSegment[]} items
 */

/**
 * @typedef {Object} SegmentPosition
 * @property {number} seg           0-based segment index
 * @property {number} fileRelativeMs File-relative offset (ms) — the ss= the proxy sends
 */

export class SegmentTimeline {
  /**
   * @param {NgSegmentManifest|null|undefined} manifest
   */
  constructor(manifest) {
    /** @type {NgSegment[]} */
    this._items = manifest && manifest.items
      ? [...manifest.items].sort((a, b) => a.index - b.index)
      : [];
    // Trust server-sent contentBaseMs, but recompute defensively so the client
    // never diverges if a field is missing/reordered.
    let acc = 0;
    for (const it of this._items) {
      it.contentBaseMs = acc;
      acc += Math.max(0, it.durationMs);
    }
    /** @type {number} */
    this._totalContentMs = acc;
  }

  /** @returns {number} */
  segmentCount() { return this._items.length; }

  /** @returns {boolean} */
  isMultiSegment() { return this._items.length > 1; }

  /** @returns {number} */
  totalContentMs() { return this._totalContentMs; }

  /** @returns {boolean} */
  _inRange(seg) { return seg >= 0 && seg < this._items.length; }

  /** @returns {number} */
  startEpochMs(seg) { return this._inRange(seg) ? this._items[seg].startTimeUtcMs : 0; }

  /** @returns {number} */
  fileSizeBytes(seg) { return this._inRange(seg) ? this._items[seg].fileSizeBytes : 0; }

  /** @returns {number} */
  durationMs(seg) {
    if (!this._inRange(seg)) return 0;
    const d = this._items[seg].durationMs;
    return d > 0 ? d : 0;
  }

  /** @returns {number} */
  contentBaseMs(seg) { return this._inRange(seg) ? this._items[seg].contentBaseMs : 0; }

  /** Real wall-clock gap (ms) immediately before a segment; 0 for segment 0. */
  gapBeforeMs(seg) {
    if (!this._inRange(seg) || seg === 0) return 0;
    const g = this._items[seg].startTimeUtcMs -
              (this._items[seg - 1].startTimeUtcMs + this.durationMs(seg - 1));
    return g > 0 ? g : 0;
  }

  /** @returns {boolean} */
  hasGaps() {
    for (let i = 1; i < this._items.length; i++) {
      if (this.gapBeforeMs(i) > 0) return true;
    }
    return false;
  }

  /**
   * Map a content-time position (ms) to the containing segment index.
   * Clamps: negative → 0, at/after end → last segment. Mirrors server.
   * @param {number} contentMs
   * @returns {number}
   */
  contentToSegment(contentMs) {
    const n = this._items.length;
    if (n === 0) return -1;
    if (contentMs <= 0) return 0;
    for (let i = 0; i < n; i++) {
      const end = this._items[i].contentBaseMs + this.durationMs(i);
      if (contentMs < end) return i;
    }
    return n - 1;
  }

  /**
   * Map a content-time position (ms) to {seg, fileRelativeMs}.
   * FF/REW/Skip primitive: content target → segment + file-relative ss=.
   * @param {number} contentMs
   * @returns {SegmentPosition}
   */
  contentToPosition(contentMs) {
    const seg = this.contentToSegment(contentMs);
    if (seg < 0) return { seg: -1, fileRelativeMs: 0 };
    const rel = contentMs - this._items[seg].contentBaseMs;
    return { seg, fileRelativeMs: rel > 0 ? rel : 0 };
  }

  /**
   * Inverse: file-relative offset within a segment → whole-recording content time (ms).
   * @param {number} seg
   * @param {number} fileRelativeMs
   * @returns {number}
   */
  fileRelativeToContentMs(seg, fileRelativeMs) {
    if (!this._inRange(seg)) return 0;
    const rel = fileRelativeMs > 0 ? fileRelativeMs : 0;
    return this._items[seg].contentBaseMs + rel;
  }

  // ---- wall-clock mapping (OSD label, gaps preserved) -------------------------

  /**
   * Content time → wall-clock epoch ms.  Server uses this for the OSD clock
   * so the viewer sees the real program time; the jump across a gap is correct.
   * @param {number} contentMs
   * @returns {number}
   */
  contentToWallClockMs(contentMs) {
    const seg = this.contentToSegment(contentMs);
    if (seg < 0) return 0;
    return this._items[seg].startTimeUtcMs + (contentMs - this._items[seg].contentBaseMs);
  }

  /**
   * Wall-clock epoch ms → content time.  If the timestamp lands inside a gap
   * (un-recorded), snaps forward to the start of the next recorded segment —
   * mirrors classic SageTV "jump over the outage".
   * @param {number} epochMs
   * @returns {number}
   */
  wallClockToContentMs(epochMs) {
    const n = this._items.length;
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) {
      const s = this._items[i].startTimeUtcMs;
      const e = s + this.durationMs(i);
      if (epochMs < s) return this._items[i].contentBaseMs;  // inside gap → snap to segment start
      if (epochMs < e) return this._items[i].contentBaseMs + (epochMs - s);
    }
    return this._totalContentMs;
  }
}

/**
 * Map per-segment, file-relative markers (comskip, caption cues) onto the
 * whole-recording content timeline.  For audit verification against server-
 * aggregated marks.
 * @template {Object} T
 * @param {SegmentTimeline} timeline
 * @param {number} segIndex
 * @param {T[]} marks  Each must have startMs and endMs (file-relative ms)
 * @returns {T[]}
 */
export function offsetMarksToContentTime(timeline, segIndex, marks) {
  const base = timeline.contentBaseMs(segIndex);
  return marks.map((m) => ({ ...m, startMs: m.startMs + base, endMs: m.endMs + base }));
}
