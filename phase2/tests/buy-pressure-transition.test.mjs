import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuietBasePreExpansion } from '../core/quiet-base-pre-expansion.mjs';

const step = 5 * 60_000;
const start = 1_800_000_000_000;
const endAt = rows => rows.at(-1).openTime + step;

function makeBase() {
  return Array.from({ length: 90 }, (_, i) => {
    const close = 1 + Math.min(i, 76) * 0.00025;
    const range = i < 76 ? 0.004 : 0.0003;
    return {
      openTime: start + i * step,
      closeTime: start + (i + 1) * step - 1,
      open: close - 0.00008,
      high: close + range,
      low: close - range,
      close,
      volume: 1000,
      quoteVolume: close * 1000,
      tradeCount: 100,
      takerBuyBaseVolume: 500,
      takerBuyQuoteVolume: close * 500,
      closed: true
    };
  });
}

function makeTransition({ takerShare = 0.56, volume = 1800, trades = 140 } = {}) {
  const rows = makeBase();
  for (const [index, candle] of rows.slice(-12).entries()) {
    // A modest positive hourly drift, still well below the late-move guard.
    const close = candle.close * (1 + index * 0.0003);
    candle.close = close;
    candle.open = close * 0.9994;
    candle.high = close * 1.001;
    candle.low = close * 0.995;
    candle.volume = volume;
    candle.quoteVolume = close * volume;
    candle.tradeCount = trades;
    candle.takerBuyBaseVolume = volume * takerShare;
    candle.takerBuyQuoteVolume = close * volume * takerShare;
  }
  return rows;
}

function run(rows, daily = 2.1) {
  return assessQuietBasePreExpansion({
    fiveMinute: rows,
    ticker: { symbol: 'TESTUSDT', lastPrice: rows.at(-1).close, priceChange24h: daily },
    now: endAt(rows)
  });
}

test('buy-pressure transition can warn before the strict gradual-ramp pattern completes', () => {
  const result = run(makeTransition());
  const metrics = result.metrics.buy_pressure_transition;
  assert.equal(metrics.available, true, JSON.stringify(metrics));
  assert.equal(metrics.confirmed, true, JSON.stringify(metrics));
  assert.equal(result.classification, 'PRE_EXPANSION', JSON.stringify(result));
  assert.equal(result.reason, 'QUIET_BASE_WITH_BUY_PRESSURE_TRANSITION_BEFORE_EXPANSION');
  assert.equal(result.detected, true);
  assert.ok(metrics.taker_buy_share >= 0.53);
  assert.ok(metrics.volume_median_ratio >= 1.12);
  assert.ok(metrics.trade_median_ratio >= 1.05);
  assert.ok(result.evidence.some(x => x.key === 'buy_pressure_transition_last_closed_hour' && x.passed));
});

test('high volume and trade count do not pass the new lane when taker-buy pressure is weak', () => {
  const result = run(makeTransition({ takerShare: 0.46, volume: 2200, trades: 180 }));
  assert.equal(result.metrics.buy_pressure_transition.available, true);
  assert.equal(result.metrics.buy_pressure_transition.confirmed, false);
  assert.notEqual(result.reason, 'QUIET_BASE_WITH_BUY_PRESSURE_TRANSITION_BEFORE_EXPANSION');
  assert.ok(result.evidence.some(x => x.key === 'buy_pressure_transition_last_closed_hour' && !x.passed));
});

test('medium-mover-sized buy-share improvement can qualify when structure and participation align', () => {
  const rows = makeTransition({ takerShare: 0.5492, volume: 1800, trades: 140 });
  for (const candle of rows.slice(-48, -12)) {
    candle.takerBuyBaseVolume = candle.volume * 0.5367;
    candle.takerBuyQuoteVolume = candle.quoteVolume * 0.5367;
  }
  const result = run(rows);
  const metrics = result.metrics.buy_pressure_transition;
  assert.equal(metrics.available, true, JSON.stringify(metrics));
  assert.ok(metrics.taker_buy_share >= 0.53);
  assert.ok(metrics.taker_buy_share_delta >= 0.01, JSON.stringify(metrics));
  assert.equal(metrics.confirmed, true, JSON.stringify(metrics));
  assert.equal(result.classification, 'PRE_EXPANSION');
  assert.equal(result.reason, 'QUIET_BASE_WITH_BUY_PRESSURE_TRANSITION_BEFORE_EXPANSION');
});

test('high absolute buy share without a fresh increase versus the prior base does not pass', () => {
  const rows = makeTransition({ takerShare: 0.56, volume: 1800, trades: 140 });
  for (const candle of rows.slice(-48, -12)) {
    candle.takerBuyBaseVolume = candle.volume * 0.56;
    candle.takerBuyQuoteVolume = candle.quoteVolume * 0.56;
  }
  const result = run(rows);
  const metrics = result.metrics.buy_pressure_transition;
  assert.equal(metrics.available, true, JSON.stringify(metrics));
  assert.ok(metrics.taker_buy_share >= 0.53);
  assert.ok(metrics.taker_buy_share_delta < 0.02);
  assert.equal(metrics.confirmed, false, JSON.stringify(metrics));
  assert.notEqual(result.reason, 'QUIET_BASE_WITH_BUY_PRESSURE_TRANSITION_BEFORE_EXPANSION');
});

test('the new route cannot bypass the existing anti-chase guard', () => {
  const result = run(makeTransition({ takerShare: 0.60, volume: 2200, trades: 180 }), 12);
  assert.equal(result.classification, 'ALREADY_EXTENDED');
  assert.equal(result.detected, false);
  assert.equal(result.evidence.find(x => x.key === 'anti_chase').passed, false);
});
