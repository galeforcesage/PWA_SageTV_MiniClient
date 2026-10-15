import test from 'node:test';
import assert from 'node:assert/strict';

import { isHiddenByClosedDetails, nextSettingsVerticalTarget } from './spatial-nav.js';

test('settings Down follows expanded controls in DOM order', () => {
  const summary = {};
  const firstMapping = {};
  const secondMapping = {};
  const save = {};
  const list = [summary, firstMapping, secondMapping];

  assert.equal(nextSettingsVerticalTarget(summary, list, save, null, 'down'), firstMapping);
  assert.equal(nextSettingsVerticalTarget(firstMapping, list, save, null, 'down'), secondMapping);
});

test('settings Down reaches Save after the last scroll control', () => {
  const last = {};
  const save = {};

  assert.equal(nextSettingsVerticalTarget(last, [last], save, null, 'down'), save);
});

test('settings Up returns from the action row to the last scroll control', () => {
  const last = {};
  const save = {};
  const cancel = {};

  assert.equal(nextSettingsVerticalTarget(save, [last], save, cancel, 'up'), last);
  assert.equal(nextSettingsVerticalTarget(cancel, [last], save, cancel, 'up'), last);
});

test('closed settings groups expose only their summary', () => {
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  const summary = { tagName: 'SUMMARY', parentElement: details };
  const select = { tagName: 'SELECT', parentElement: details };

  assert.equal(isHiddenByClosedDetails(summary), false);
  assert.equal(isHiddenByClosedDetails(select), true);
});

test('expanded settings groups expose their controls', () => {
  const details = { tagName: 'DETAILS', open: true, parentElement: null };
  const select = { tagName: 'SELECT', parentElement: details };

  assert.equal(isHiddenByClosedDetails(select), false);
});
