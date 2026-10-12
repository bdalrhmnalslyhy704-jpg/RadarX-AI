import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateFiveMinuteCandles, normalizeHistoricalCandles, runHistoricalReplay} from '../core/historical-replay.mjs';

const MINUTE = 60_000;
const ORIGIN = Math.floor((Date.now() - 10 * 60 * MINUTE) / MINUTE) * MINUTE;

function candles(count = 300) {
  const rows = [];
  let price = 1;
  for (let i = 0; i < count; i++) {
    const openTime = ORIGIN + i * MINUTE;
    const open = price;
    const move = i > count - 8 ? 0.12 : 0.0004;
    const close = open * (1 + move);
    rows.push({
      openTime, closeTime: openTime + MINUTE - 1,
      open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998,
      close, volume: 100 + i, quoteVolume: (100 + i) * close, tradeCount: 10 + i,
      takerBuyBaseVolume: (100 + i) * 0.6,
      takerBuyQuoteVolume: (100 + i) * close * 0.6, closed: true
    });
    price = close;
  }
  return rows;
}
function syntheticTrades(rows) {
  const out = [];
  let id = 1;
  for (const c of rows) {
    for (let i = 0; i < 3; i++) out.push({
      a: id++, T: c.openTime + 5_000 + i * 10_000, p: String(c.close), q: '10', m: i === 0
    });
  }
  return out;
}

test('five-minute aggregate requires five contiguous closed one-minute candles', () => {
  const rows = candles(10);
  assert.equal(aggregateFiveMinuteCandles(rows).length, 2);
  assert.equal(aggregateFiveMinuteCandles(rows.filter((_, i) => i !== 2)).length, 1);
  assert.equal(normalizeHistoricalCandles([...rows, {...rows[1], close: 0}]).length, rows.length);
});

test('replay never passes future candles or unfinished 3-second trade windows to evaluator', () => {
  const rows = candles(300);
  const trades = syntheticTrades(rows);
  const start = rows[190].openTime;
  const end = rows[280].closeTime;
  const replay = runHistoricalReplay({
    symbol: 'GTCUSDT', oneMinuteCandles: rows, aggTrades: trades,
    startTime: start, endTime: end, tradeCoverageComplete: true,
    evaluate(input) {
      assert.ok(input.oneMinute.length > 0);
      assert.ok(input.oneMinute.every(c => c.closed === true && c.closeTime <= input.now));
      assert.ok(input.fiveMinute.every(c => c.closed === true && c.closeTime <= input.now));
      assert.ok(input.aggTrades.every(t => t.T < Math.floor(input.now / 3000) * 3000));
      assert.ok(Math.max(...input.oneMinute.map(c => c.closeTime)) <= input.now);
      assert.ok(Math.max(...input.fiveMinute.map(c => c.closeTime), 0) <= input.now);
      return {accepted: false, reason_codes: ['TEST_REJECT'], stage: 'WATCH', score: 50};
    }
  });
  assert.ok(replay.steps.length > 80);
  assert.ok(replay.steps.every(x => x.decision === 'REJECTED'));
  assert.ok(replay.steps.every(x => x.reason_codes.includes('TEST_REJECT')));
  assert.ok(replay.steps.every(x => x.input_max_candle_close_at <= x.timestamp));
  assert.equal(replay.steps[0].outcome.is_future_data_for_scoring, false);
});

test('replay applies alert cooldown deterministically per symbol', () => {
  const rows = candles(260);
  const start = rows[180].openTime;
  const replay = runHistoricalReplay({
    symbol: 'WUSDT', oneMinuteCandles: rows, startTime: start,
    endTime: rows[190].closeTime, alertCooldownMs: 2 * MINUTE,
    evaluate() { return {accepted: true, stage: 'PRE_EXPANSION', score: 90}; }
  });
  assert.equal(replay.steps[0].decision, 'ACCEPTED');
  assert.equal(replay.steps[1].decision, 'REJECTED');
  assert.ok(replay.steps[1].reason_codes.includes('SYMBOL_ALERT_COOLDOWN'));
  assert.equal(replay.steps[2].decision, 'ACCEPTED');
});

test('incomplete aggregate-trade coverage fails closed without scoring', () => {
  const rows = candles(250);
  let called = false;
  const replay = runHistoricalReplay({
    symbol: 'GTCUSDT', oneMinuteCandles: rows, startTime: rows[180].openTime,
    endTime: rows[184].closeTime, tradeCoverageComplete: false,
    evaluate() { called = true; return {accepted: true}; }
  });
  assert.equal(called, false);
  assert.ok(replay.steps.length > 0);
  assert.ok(replay.steps.every(x => x.decision === 'REJECTED' &&
    x.reason_codes.includes('AGG_TRADES_HISTORY_INCOMPLETE')));
});

test('forward +50/+70 percent labels are outcomes, separate from evaluator input', () => {
  const rows = candles(300);
  let sawOutcomeOnlyLeak = false;
  const start = rows[190].openTime;
  const replay = runHistoricalReplay({
    symbol: 'WUSDT', oneMinuteCandles: rows, startTime: start,
    endTime: rows[220].closeTime,
    evaluate(input) {
      if ('outcome' in input || 'forward_max_upside_pct' in input) sawOutcomeOnlyLeak = true;
      return {accepted: false, stage: 'WATCH'};
    }
  });
  assert.equal(sawOutcomeOnlyLeak, false);
  assert.ok(replay.steps.every(x => !('outcome' in x))); 
  assert.ok(replay.steps.every(x => 'outcome' in x && x.outcome.is_future_data_for_scoring === false));
});
