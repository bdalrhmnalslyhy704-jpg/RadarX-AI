import test from 'node:test';
import assert from 'node:assert/strict';
import {finiteNumberOr} from '../core/finite-number.mjs';

test('missing market-data numbers stay missing instead of being coerced to zero', () => {
  assert.equal(finiteNumberOr(null), null);
  assert.equal(finiteNumberOr(undefined), null);
  assert.equal(finiteNumberOr(''), null);
  assert.equal(finiteNumberOr('   '), null);
  assert.equal(finiteNumberOr(false), null);
  assert.equal(finiteNumberOr({}), null);
});

test('finite numeric values including an actual zero are preserved', () => {
  assert.equal(finiteNumberOr(0), 0);
  assert.equal(finiteNumberOr('0'), 0);
  assert.equal(finiteNumberOr('1.25'), 1.25);
  assert.equal(finiteNumberOr(-4), -4);
});

test('non-finite values use the caller fallback', () => {
  assert.equal(finiteNumberOr(Number.NaN), null);
  assert.equal(finiteNumberOr(Number.POSITIVE_INFINITY, 'unknown'), 'unknown');
  assert.equal(finiteNumberOr('not-a-number', -1), -1);
});
