/**
 * Tests for NG Playback Context subsystem.
 * Run with: node --test public/js/media/ng-playback-context.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NgPlaybackContext } from './ng-playback-context.js';
import { NgPlaybackContextParser } from './ng-playback-context-parser.js';
import { NgPlaybackContextManager } from './ng-playback-context-manager.js';

// ---------------------------------------------------------------------------
// NgPlaybackContext (value object)
// ---------------------------------------------------------------------------
describe('NgPlaybackContext', () => {
  it('creates an immutable frozen object with defaults', () => {
    const ctx = new NgPlaybackContext({});
    assert.equal(ctx.mediaFileId, '');
    assert.equal(ctx.title, '');
    assert.equal(ctx.durationMs, -1);
    assert.equal(ctx.contentType, '');
    assert.equal(ctx.isLive, false);
    assert.equal(ctx.seekableByClient, false);
    assert.deepEqual(ctx.chapterMarksMs, []);
    assert.deepEqual(ctx.commercialBreaksMs, []);
    assert.ok(Object.isFrozen(ctx));
  });

  it('stores provided values', () => {
    const ctx = new NgPlaybackContext({
      mediaFileId: '999',
      title: 'Test Title',
      durationMs: 120000,
      contentType: 'recording',
      isLive: false,
      seekableByClient: true,
      chapterMarksMs: [0, 60000],
      commercialBreaksMs: [30000, 35000],
      openUrl: 'stv://localhost/test.mpg',
    });
    assert.equal(ctx.mediaFileId, '999');
    assert.equal(ctx.title, 'Test Title');
    assert.equal(ctx.durationMs, 120000);
    assert.equal(ctx.seekableByClient, true);
    assert.deepEqual(ctx.chapterMarksMs, [0, 60000]);
    assert.equal(ctx.openUrl, 'stv://localhost/test.mpg');
  });

  it('rejects mutation after construction', () => {
    const ctx = new NgPlaybackContext({ title: 'Immutable' });
    assert.throws(() => { ctx.title = 'changed'; }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// NgPlaybackContextParser
// ---------------------------------------------------------------------------
describe('NgPlaybackContextParser', () => {
  it('returns null for null/empty/whitespace input', () => {
    assert.equal(NgPlaybackContextParser.parse(null), null);
    assert.equal(NgPlaybackContextParser.parse(''), null);
    assert.equal(NgPlaybackContextParser.parse('   '), null);
  });

  it('parses a full wire string', () => {
    const wire = 'mediaFileId=12345|title=My%20Show|durationMs=3600000|contentType=recording|isLive=false|seekableByClient=true|chapterMarksMs=0,900000,1800000';
    const ctx = NgPlaybackContextParser.parse(wire, 'stv://host/file.mpg');

    assert.equal(ctx.mediaFileId, '12345');
    assert.equal(ctx.title, 'My Show');
    assert.equal(ctx.durationMs, 3600000);
    assert.equal(ctx.contentType, 'recording');
    assert.equal(ctx.isLive, false);
    assert.equal(ctx.seekableByClient, true);
    assert.deepEqual(ctx.chapterMarksMs, [0, 900000, 1800000]);
    assert.equal(ctx.openUrl, 'stv://host/file.mpg');
    assert.ok(Object.isFrozen(ctx));
  });

  it('handles unencoded titles (no special chars)', () => {
    const wire = 'mediaFileId=1|title=Simple Title';
    const ctx = NgPlaybackContextParser.parse(wire);
    assert.equal(ctx.title, 'Simple Title');
  });

  it('stores unknown keys in extras', () => {
    const wire = 'mediaFileId=1|customField=customValue|anotherKey=123';
    const ctx = NgPlaybackContextParser.parse(wire);
    assert.equal(ctx.extras.customField, 'customValue');
    assert.equal(ctx.extras.anotherKey, '123');
  });

  it('handles commercialBreaksMs array', () => {
    const wire = 'mediaFileId=1|commercialBreaksMs=600000,660000,1200000,1260000';
    const ctx = NgPlaybackContextParser.parse(wire);
    assert.deepEqual(ctx.commercialBreaksMs, [600000, 660000, 1200000, 1260000]);
  });

  it('handles empty array fields gracefully', () => {
    const wire = 'mediaFileId=1|chapterMarksMs=|commercialBreaksMs=';
    const ctx = NgPlaybackContextParser.parse(wire);
    assert.deepEqual(ctx.chapterMarksMs, []);
    assert.deepEqual(ctx.commercialBreaksMs, []);
  });

  it('handles isLive=true and isTimeshifted=true', () => {
    const wire = 'mediaFileId=1|isLive=true|isTimeshifted=true';
    const ctx = NgPlaybackContextParser.parse(wire);
    assert.equal(ctx.isLive, true);
    assert.equal(ctx.isTimeshifted, true);
  });
});

// ---------------------------------------------------------------------------
// NgPlaybackContextManager
// ---------------------------------------------------------------------------
describe('NgPlaybackContextManager', () => {
  it('starts with null context', () => {
    const mgr = new NgPlaybackContextManager();
    assert.equal(mgr.getCurrent(), null);
  });

  it('stores context on onPropertyReceived after onMediaOpen', () => {
    const mgr = new NgPlaybackContextManager();
    mgr.onMediaOpen('stv://host/test.mpg');
    mgr.onPropertyReceived('mediaFileId=42|title=Test|durationMs=5000');

    const ctx = mgr.getCurrent();
    assert.equal(ctx.mediaFileId, '42');
    assert.equal(ctx.title, 'Test');
    assert.equal(ctx.openUrl, 'stv://host/test.mpg');
  });

  it('fires contextchange event on property received', () => {
    const mgr = new NgPlaybackContextManager();
    let eventFired = false;
    let eventDetail = null;

    mgr.addEventListener('contextchange', (e) => {
      eventFired = true;
      eventDetail = e.detail;
    });

    mgr.onMediaOpen('stv://host/test.mpg');
    mgr.onPropertyReceived('mediaFileId=1|title=Fired');

    assert.ok(eventFired);
    assert.equal(eventDetail.previous, null);
    assert.equal(eventDetail.current.title, 'Fired');
  });

  it('fires contextchange event on media close', () => {
    const mgr = new NgPlaybackContextManager();
    const events = [];
    mgr.addEventListener('contextchange', (e) => events.push(e.detail));

    mgr.onMediaOpen('stv://host/test.mpg');
    mgr.onPropertyReceived('mediaFileId=1|title=Active');
    mgr.onMediaClose();

    assert.equal(events.length, 2);
    assert.equal(events[1].previous.title, 'Active');
    assert.equal(events[1].current, null);
    assert.equal(mgr.getCurrent(), null);
  });

  it('does not fire event on close if already null', () => {
    const mgr = new NgPlaybackContextManager();
    let eventCount = 0;
    mgr.addEventListener('contextchange', () => eventCount++);

    mgr.onMediaClose();
    assert.equal(eventCount, 0);
  });

  it('ignores invalid wire values without crashing', () => {
    const mgr = new NgPlaybackContextManager();
    // null and empty should not throw or fire events
    let eventCount = 0;
    mgr.addEventListener('contextchange', () => eventCount++);

    mgr.onPropertyReceived(null);
    mgr.onPropertyReceived('');
    mgr.onPropertyReceived('   ');

    assert.equal(eventCount, 0);
    assert.equal(mgr.getCurrent(), null);
  });

  it('updates context when new property arrives (replaces previous)', () => {
    const mgr = new NgPlaybackContextManager();
    mgr.onMediaOpen('stv://host/a.mpg');
    mgr.onPropertyReceived('mediaFileId=1|title=First');
    mgr.onPropertyReceived('mediaFileId=2|title=Second');

    assert.equal(mgr.getCurrent().title, 'Second');
    assert.equal(mgr.getCurrent().mediaFileId, '2');
  });
});
