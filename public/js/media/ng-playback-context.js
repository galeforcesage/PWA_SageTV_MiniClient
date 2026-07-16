/**
 * NG Playback Context — Immutable Value Object
 *
 * Holds rich metadata about the current playback session, received from the
 * server via SET_PROPERTY "NG_PLAYBACK_CONTEXT". This is a read-only snapshot:
 * each new context replaces the previous one entirely (immutable pattern).
 *
 * Mirrors: core/src/main/java/sagex/miniclient/ngcontext/NgPlaybackContext.java
 *
 * Wire format (canonical, shared with Android client):
 *   mediaFileId=12345|title=My Show|durationMs=3600000|contentType=recording|...
 */

export class NgPlaybackContext {
  /**
   * @param {object} fields — parsed field values
   */
  constructor(fields) {
    // --- canonical fields (agreed with server) ---
    /** @type {string} SageTV MediaFile ID */
    this.mediaFileId = fields.mediaFileId || '';

    /** @type {string} Display title */
    this.title = fields.title || '';

    /** @type {number} Total duration in ms; -1 for live/unknown */
    this.durationMs = typeof fields.durationMs === 'number' ? fields.durationMs : -1;

    /** @type {string} 'recording'|'live'|'import'|'dvd'|'music' */
    this.contentType = fields.contentType || '';

    /** @type {boolean} Is this a live TV stream? */
    this.isLive = !!fields.isLive;

    /** @type {boolean} Is there a timeshift buffer (live TV only)? */
    this.isTimeshifted = !!fields.isTimeshifted;

    /** @type {number} Epoch ms of scheduled start (live TV guide data) */
    this.scheduledStartMs = typeof fields.scheduledStartMs === 'number' ? fields.scheduledStartMs : -1;

    /** @type {number} Epoch ms of scheduled end */
    this.scheduledEndMs = typeof fields.scheduledEndMs === 'number' ? fields.scheduledEndMs : -1;

    // --- trickplay hints ---

    /** @type {number[]} Chapter points in ms (may be empty) */
    this.chapterMarksMs = Array.isArray(fields.chapterMarksMs)
      ? Object.freeze([...fields.chapterMarksMs])
      : Object.freeze([]);

    /** @type {number[]} Commercial break pairs [start,end,...] in ms (may be empty) */
    this.commercialBreaksMs = Array.isArray(fields.commercialBreaksMs)
      ? Object.freeze([...fields.commercialBreaksMs])
      : Object.freeze([]);

    /** @type {boolean} Server grants client permission to seek locally */
    this.seekableByClient = !!fields.seekableByClient;

    // --- extensibility ---

    /** @type {Object<string,string>} Future/custom key-values */
    this.extras = fields.extras && typeof fields.extras === 'object'
      ? Object.freeze({ ...fields.extras })
      : Object.freeze({});

    // --- generated on client ---

    /** @type {string} The URL from MEDIACMD_OPENURL (if known) */
    this.openUrl = fields.openUrl || '';

    /** @type {number} Date.now() when this context was parsed */
    this.receivedAt = typeof fields.receivedAt === 'number' ? fields.receivedAt : Date.now();

    // --- optional metadata fields ---

    /** @type {string} Server version that produced this context */
    this.serverVersion = fields.serverVersion || '';

    /** @type {string} SageTV Show/Airing ID */
    this.showId = fields.showId || '';

    /** @type {string} Channel name (live TV) */
    this.channelName = fields.channelName || '';

    /** @type {string} Channel number (live TV) */
    this.channelNumber = fields.channelNumber || '';

    Object.freeze(this);
  }
}
