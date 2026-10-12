import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateFiveMinuteCandles, normalizeHistoricalCandles, runHistoricalReplay} from '../core/historical-replay.mjs';

const MINUTE = 60_000;
const ORIGIN = Math.floor((Date.now() - 400 * MINUTE) / (5 * MINUTE)) * (5 * MINUTE);

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
    symbol: 'WUSDT', oneMinuteCandles: rows, aggTrades: syntheticTrades(rows), startTime: start,
    endTime: rows[190].closeTime, tradeCoverageComplete:true, alertCooldownMs: 2 * MINUTE,
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
  assert.equal(replay.summary.premove_50_status, 'TRADE_COVERAGE_INCOMPLETE');
  assert.equal(replay.summary.first_actual_window_50pct_at, null);
  assert.ok(replay.steps.length > 0);
  assert.ok(replay.steps.every(x => x.decision === 'REJECTED' &&
    x.reason_codes.includes('AGG_TRADES_HISTORY_INCOMPLETE')));
});

test('forward +50/+70 percent labels are outcomes, separate from evaluator input', () => {
  const rows = candles(300);
  let sawOutcomeOnlyLeak = false;
  const start = rows[190].openTime;
  const trades = syntheticTrades(rows);
  const replay = runHistoricalReplay({
    symbol: 'WUSDT', oneMinuteCandles: rows, aggTrades: trades, startTime: start,
    endTime: rows[299].closeTime, tradeCoverageComplete: true,
    evaluate(input) {
      if ('outcome' in input || 'forward_max_upside_pct' in input) sawOutcomeOnlyLeak = true;
      return {accepted: false, stage: 'WATCH'};
    }
  });
  assert.equal(sawOutcomeOnlyLeak, false);
  assert.ok(replay.steps.every(x => 'outcome' in x && x.outcome.is_future_data_for_scoring === false));
  assert.notEqual(replay.summary.first_actual_window_50pct_at, null);
  const baseline = rows.find(x=>x.openTime>=start&&x.closeTime<=rows[299].closeTime).open;
  const expectedCross = trades.find(x=>x.T>=start&&x.T<=rows[299].closeTime&&Number(x.p)>=baseline*1.5).T;
  assert.equal(replay.summary.first_actual_window_50pct_at, expectedCross,
    'target crossing must use the first public aggregate-trade timestamp at or above the threshold');
  assert.equal(replay.summary.actual_window_50pct_timestamp_source, 'BINANCE_PUBLIC_AGG_TRADES');
  assert.equal(replay.summary.actual_window_50pct_alignment, 'BINANCE_AGGTRADE_TIMESTAMP');
  assert.ok(replay.summary.first_actual_window_50pct_at < replay.summary.first_actual_window_50pct_candle_close_at,
    'trade crossing time should be more precise than minute candle close time');
  assert.equal(replay.summary.first_accepted_at, null);
  assert.equal(replay.summary.premove_50_status, 'NO_CORE_TRIGGER_BEFORE_PLUS_50_PERCENT');
});


test('replay reports dynamic early warnings separately from strict acceptances',()=>{
  const rows=candles(260);
  const replay=runHistoricalReplay({
    symbol:'WUSDT',oneMinuteCandles:rows,aggTrades:syntheticTrades(rows),
    startTime:rows[180].openTime,endTime:rows[184].closeTime,tradeCoverageComplete:true,
    evaluate(input){
      return {
        accepted:true,accepted_mode:'DYNAMIC_EARLY_WARNING',
        early_warning:{eligible:true,score:80,soft_failures:['RISK:ADVANCED_CHASE_RISK']},
        score:86,stage:'PRE_EXPANSION_WATCH',reason_codes:[],
        alert:{eligible:true,notification_mode:'DYNAMIC_EARLY_WARNING',early_warning:{eligible:true,score:80}}
      };
    }
  });
  assert.equal(replay.summary.accepted,5);
  assert.equal(replay.summary.first_early_warning_accepted_at,replay.steps[0].timestamp);
  assert.equal(replay.summary.first_strict_accepted_at,null);
  assert.deepEqual(replay.summary.accepted_mode_counts,[{mode:'DYNAMIC_EARLY_WARNING',count:5}]);
  assert.equal(replay.steps[0].accepted_mode,'DYNAMIC_EARLY_WARNING');
  assert.equal(replay.steps[0].early_warning_score,80);
});

test('replay preserves core, elite and notification rejection stages for forensic review', () => {
  const rows = candles(260);
  const replay = runHistoricalReplay({
    symbol: 'GTCUSDT', oneMinuteCandles: rows, aggTrades:syntheticTrades(rows), tradeCoverageComplete:true,
    startTime: rows[180].openTime, endTime: rows[184].closeTime,
    evaluate(input) {
      return {
        accepted: false,
        score: 87.1,
        stage: 'BUILDING',
        reason_codes: ['BASE_ALERT_NOT_ELIGIBLE'],
        alert: {
          eligible: false,
          risk_flags: ['LOW_CONFLUENCE'],
          strong_move: {
            eligible: false, stage: 'BUILDING', score: 87.1,
            reasons: ['liquidity rising', 'price trigger incomplete'],
            metrics: {
              return_1m: 0.18, return_3m: 0.61, acceleration: 0.21,
              volume_ratio: 1.8, trade_ratio: 1.4,
              taker_buy_ratio: 0.68, three_second_taker_buy_ratio: 0.72,
              taker_buy_pressure_confirmed: false, independent_confirmations: 3,
              flash_score: 87.1, flash_confirmations: 3,
              liquidity_acceleration: {three_minute_acceleration: 0.3, score: 79},
              breakout_up: true
            }
          },
          elite_gate: {
            eligible: false, score: 83.2, confirmations: 3, category_hits: 4,
            risk_flags: ['LOW_CONFLUENCE', 'LOW_CATEGORY_DIVERSITY']
          },
          notification_gate: {eligible: false, failures: ['BASE_ALERT_NOT_ELIGIBLE']}
        }
      };
    }
  });
  const row = replay.steps[0];
  assert.equal(row.decision, 'REJECTED');
  assert.equal(row.rejection_group, 'STRONG_MOVE_CORE_GATE');
  assert.equal(row.candidate_eligible, false);
  assert.equal(row.core_trigger_eligible, false);
  assert.equal(row.signal_metrics.taker_buy_ratio_1m_3m, 0.68);
  assert.equal(row.signal_metrics.taker_buy_ratio_3s, 0.72);
  assert.equal(row.signal_metrics.liquidity_acceleration_3m, 0.3);
  assert.ok(row.core_reasons.includes('price trigger incomplete'));
  assert.ok(row.elite_gate.risk_flags.includes('LOW_CATEGORY_DIVERSITY'));
  assert.ok(replay.summary.rejection_groups.some(x => x.group === 'STRONG_MOVE_CORE_GATE'));
});
