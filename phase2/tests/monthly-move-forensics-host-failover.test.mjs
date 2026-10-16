import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedHostIndexes } from '../core/binance-host-order.mjs';

test('provider fallback order tries every host exactly once per attempt', () => {
  for (let requestCount = 0; requestCount < 40; requestCount++) {
    const order = orderedHostIndexes(requestCount, 2);
    assert.equal(order.length, 2);
    assert.equal(new Set(order).size, 2);
    assert.deepEqual([...order].sort((a, b) => a - b), [0, 1]);
  }
});

test('fallback starting host rotates without changing within an attempt', () => {
  assert.deepEqual(orderedHostIndexes(0, 2), [0, 1]);
  assert.deepEqual(orderedHostIndexes(1, 2), [1, 0]);
  assert.deepEqual(orderedHostIndexes(4, 3), [1, 2, 0]);
});

test('provider order rejects invalid counters and empty host lists', () => {
  assert.throws(() => orderedHostIndexes(-1, 2), /requestCount/);
  assert.throws(() => orderedHostIndexes(0, 0), /hostCount/);
});
