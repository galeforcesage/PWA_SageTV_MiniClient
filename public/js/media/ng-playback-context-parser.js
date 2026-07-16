/**
 * NG Playback Context Parser
 *
 * Parses the canonical pipe-delimited wire format into an NgPlaybackContext
 * object. The wire format is shared between Android and PWA clients.
 *
 * Wire format:
 *   mediaFileId=12345|title=My Show|durationMs=3600000|contentType=recording|...
 *
 * Rules:
 *   - Pipe `|` separates fields
 *   - `=` separates key from value (first `=` only; value may contain `=`)
 *   - Arrays are comma-separated within the value
 *   - Values are URL-encoded if they contain `|` or `=`
 *   - Unknown keys are stored in the extras map
 *
 * Mirrors: core/src/main/java/sagex/miniclient/ngcontext/NgPlaybackContextParser.java
 */

import { NgPlaybackContext } from './ng-playback-context.js';

// Known fields and their types for parsing
const BOOLEAN_FIELDS = new Set([
  'isLive', 'isTimeshifted', 'seekableByClient',
]);

const NUMBER_FIELDS = new Set([
  'durationMs', 'scheduledStartMs', 'scheduledEndMs',
]);

const NUMBER_ARRAY_FIELDS = new Set([
  'chapterMarksMs', 'commercialBreaksMs',
]);

const STRING_FIELDS = new Set([
  'mediaFileId', 'title', 'contentType', 'serverVersion',
  'showId', 'channelName', 'channelNumber',
]);

export class NgPlaybackContextParser {
  /**
   * Parse the canonical pipe-delimited wire format into a context object.
   * @param {string} wireValue — the raw SET_PROPERTY value
   * @param {string|null} [openUrl=null] — the URL from the current MEDIACMD_OPENURL
   * @returns {NgPlaybackContext|null} parsed context, or null if wireValue is empty/invalid
   */
  static parse(wireValue, openUrl = null) {
    if (!wireValue || typeof wireValue !== 'string') return null;

    const map = NgPlaybackContextParser._parseWireToMap(wireValue);
    if (!map || map.size === 0) return null;

    return NgPlaybackContextParser.fromMap(map, openUrl);
  }

  /**
   * Build an NgPlaybackContext from a Map of string key→value pairs.
   * Useful for testing or building context from non-wire sources.
   * @param {Map<string,string>|Object<string,string>} map
   * @param {string|null} [openUrl=null]
   * @returns {NgPlaybackContext}
   */
  static fromMap(map, openUrl = null) {
    // Normalize to a Map if given a plain object
    const m = map instanceof Map ? map : new Map(Object.entries(map));

    const fields = {};
    const extras = {};

    for (const [key, rawValue] of m) {
      if (STRING_FIELDS.has(key)) {
        fields[key] = rawValue;
      } else if (BOOLEAN_FIELDS.has(key)) {
        fields[key] = rawValue === 'true' || rawValue === 'TRUE' || rawValue === '1';
      } else if (NUMBER_FIELDS.has(key)) {
        const n = Number(rawValue);
        fields[key] = Number.isFinite(n) ? n : -1;
      } else if (NUMBER_ARRAY_FIELDS.has(key)) {
        fields[key] = NgPlaybackContextParser._parseNumberArray(rawValue);
      } else {
        // Unknown key → extras
        extras[key] = rawValue;
      }
    }

    fields.extras = extras;
    fields.openUrl = openUrl || '';
    fields.receivedAt = Date.now();

    return new NgPlaybackContext(fields);
  }

  /**
   * Parse the wire string into a Map<string, string>.
   * @param {string} wireValue
   * @returns {Map<string, string>}
   * @private
   */
  static _parseWireToMap(wireValue) {
    const map = new Map();
    const parts = wireValue.split('|');

    for (const part of parts) {
      if (!part) continue;
      const eqIdx = part.indexOf('=');
      if (eqIdx < 0) continue; // malformed pair, skip

      const key = part.substring(0, eqIdx).trim();
      let value = part.substring(eqIdx + 1);

      // URL-decode the value (handles encoded | and = within values)
      try {
        value = decodeURIComponent(value);
      } catch {
        // If decodeURIComponent fails, use raw value
      }

      if (key) {
        map.set(key, value);
      }
    }

    return map;
  }

  /**
   * Parse a comma-separated string of numbers into a number array.
   * @param {string} value
   * @returns {number[]}
   * @private
   */
  static _parseNumberArray(value) {
    if (!value || typeof value !== 'string') return [];
    return value.split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n));
  }
}
