import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeMetrics } from '../../api/radarx-background.js';

test('reads the native Binance Spot aggTrades m flag', () => {
  const metrics = tradeMetrics([
    { p: '100', q: '2', m: true },  // buyer was maker: seller was taker
    { p: '100', q: '3', m: false }  // buyer was taker
  ]);

  assert.equal(metrics.buyNotional, 300);
  assert.equal(metrics.sellNotional, 200);
  assert.equal(metrics.buyPct, 60);
  assert.equal(metrics.deltaPct, 20);
});

test('preserves the normalized isBuyerMaker compatibility alias', () => {
  const metrics = tradeMetrics([
    { p: '10', q: '1', isBuyerMaker: true },
    { p: '10', q: '3', isBuyerMaker: false }
  ]);

  assert.equal(metrics.buyNotional, 30);
  assert.equal(metrics.sellNotional, 10);
  assert.equal(metrics.buyPct, 75);
  assert.equal(metrics.deltaPct, 50);
});

test('uses neutral flow when the aggregate-trade window is empty', () => {
  assert.deepEqual(tradeMetrics([]), {
    buyNotional: 0,
    sellNotional: 0,
    buyPct: 50,
    deltaPct: 0
  });
});
