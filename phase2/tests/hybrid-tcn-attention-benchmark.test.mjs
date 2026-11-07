import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HYBRID_FEATURE_NAMES,
  HYBRID_SEQUENCE_CHANNELS,
  HYBRID_SEQUENCE_STEPS,
  HYBRID_TCN_ARCHITECTURE,
  HYBRID_TCN_CONFIGURATION,
  HYBRID_TCN_RECEPTIVE_FIELD,
  buildHybridSequence,
  buildPurgedWalkForwardFolds,
  calculateVolumeProfile,
  predictHybridTcnAttention,
  prepareHybridBenchmarkEvent,
  profitDrawdownObjective,
  resolveBarrierTrade,
  runFixedShaBenchmark,
  sha256Canonical,
  simulatePaperTrades,
  trainHybridTcnAttention
} from '../core/hybrid-tcn-attention-benchmark.mjs';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const SOURCE_SHA = '52d0ba535e4c983fa5113bbde8061277555f87a6';

function makeSequence(direction = 1, seed = 0) {
  return Array.from({ length: HYBRID_SEQUENCE_STEPS }, (_, time) =>
    Array.from({ length: HYBRID_SEQUENCE_CHANNELS }, (_, feature) => {
      if (feature === 19) return 0; // no historical depth snapshot
      if (feature === 20 || feature === 21 || feature === 22) return 1; // controlled fixture: flow, profile and BTC reference available
      const trend = direction * (feature === 0 ? 0.7 : feature === 10 ? 0.4 : 0.12);
      const wave = Math.sin((time + 1) * (feature + 1) * 0.13 + seed) * 0.08;
      return Math.max(-3, Math.min(3, trend + wave));
    }));
}

function makeRows(count = 700) {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const positive = index % 3 !== 0;
    const at = start + index * FIFTEEN_MINUTES;
    return {
      id: 'event-' + index,
      symbol: 'COIN' + String(index).padStart(4, '0') + 'USDT',
      market: 'BINANCE_SPOT_USDT',
      outcome_source: 'BINANCE_SPOT_CLOSED_15M',
      outcome_definition: 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_CLOSED_SPOT_V1',
      market_regime: ['BULL_TREND','BEAR_TREND','SIDEWAYS'][index % 3],
      historical_window_id: ['bull-window','bear-window','sideways-window'][index % 3],
      at,
      latest_input_at: at,
      resolved_at: at + FOUR_HOURS,
      gross_return_pct: positive ? 3 : -2,
      max_adverse_excursion_pct: positive ? -0.4 : -2.1,
      max_adverse_excursion_at: at + FIFTEEN_MINUTES,
      max_favorable_excursion_pct: positive ? 2.8 : 0.8,
      max_favorable_excursion_at: at + 2 * FIFTEEN_MINUTES,
      classic_score: positive ? 0.92 : 0.08,
      sequence: makeSequence(1, index % 13),
      feature_snapshot_sha: 'unit-fixture-v1'
    };
  });
}

function makeCandles(count = 40) {
  const start = Date.UTC(2026, 2, 1);
  return Array.from({ length: count }, (_, index) => {
    const close = 10 + index * 0.03 + Math.sin(index / 3) * 0.05;
    return {
      openTime: start + index * FIFTEEN_MINUTES - FIFTEEN_MINUTES,
      closeTime: start + index * FIFTEEN_MINUTES,
      closed: true,
      open: close - 0.015,
      high: close + 0.06,
      low: close - 0.06,
      close,
      volume: 1000 + index * 3,
      quoteVolume: (1000 + index * 3) * close,
      numberOfTrades: 100 + index,
      takerBuyQuoteVolume: (1000 + index * 3) * close * 0.56,
      orderBook: {
        bidPrice: close - 0.005,
        askPrice: close + 0.005,
        bids: [[close - 0.005, 500], [close - 0.01, 300]],
        asks: [[close + 0.005, 250], [close + 0.01, 200]]
      },
      aggTradeBuyQuote: 1200,
      aggTradeSellQuote: 800,
      aggTrades: [
        { price: close - 0.002, quoteQty: 700, isBuyerMaker: false },
        { price: close + 0.002, quoteQty: 300, isBuyerMaker: true }
      ]
    };
  });
}

test('hybrid feature contract includes order flow, depth, volume profile and adaptive volatility', () => {
  assert.equal(HYBRID_FEATURE_NAMES.length, 23);
  assert.equal(HYBRID_SEQUENCE_CHANNELS, 23);
  for (const name of [
    'taker_buy_imbalance', 'agg_trade_imbalance', 'depth_imbalance',
    'volume_profile_poc_distance', 'volume_profile_value_area_position',
    'volume_profile_trade_level_available', 'adaptive_volatility_ratio', 'relative_btc_available'
  ]) assert.ok(HYBRID_FEATURE_NAMES.includes(name), name);

  const candles = makeCandles();
  const asOf = candles.at(-1).closeTime;
  const built = buildHybridSequence({ candles, benchmarkCandles: candles, asOf, sequenceSteps: 24 });
  assert.equal(built.ready, true);
  assert.equal(built.sequence.length, 24);
  assert.equal(built.sequence[0].length, 23);
  assert.ok(built.latest_input_at <= asOf);
  assert.ok(built.sequence.every(row => row.every(Number.isFinite)));
  assert.ok(built.sequence.at(-1)[10] > 0, 'taker buying pressure should be represented');
  assert.ok(built.sequence.at(-1)[11] > 0, 'aggregate trade buy imbalance should be represented');
  assert.ok(built.sequence.at(-1)[12] > 0, 'bid depth imbalance should be represented');
  assert.equal(built.sequence.at(-1)[19], 1, 'book feature availability mask should be set');
  assert.equal(built.sequence.at(-1)[20], 1, 'aggregate trade availability mask should be set');
  assert.equal(built.sequence.at(-1)[21], 1, 'trade-level volume profile mask should be set');
  const sparse = buildHybridSequence({
    candles: candles.map((row, index) => index < 5 ? row : { ...row, aggTrades: [] }),
    benchmarkCandles: candles, asOf, sequenceSteps: 24
  });
  assert.equal(sparse.sequence.at(-1)[21], 0, 'partial volume profile must be unavailable to the model');
  assert.equal(built.sequence.at(-1)[22], 1, 'relative BTC reference mask should be set');
  const misalignedBenchmark = candles.slice(0, -1);
  const missingBtc = buildHybridSequence({
    candles, benchmarkCandles: misalignedBenchmark, asOf, sequenceSteps: 24
  });
  assert.equal(missingBtc.sequence.at(-1)[22], 0,
    'relative BTC feature must be unavailable without an exact matching close and contiguous prior candle');

  const future = { ...candles.at(-1), closeTime: asOf + FIFTEEN_MINUTES };
  const beforeFuture = buildHybridSequence({ candles: [...candles, future], benchmarkCandles: candles, asOf, sequenceSteps: 24 });
  assert.equal(beforeFuture.latest_input_at, asOf, 'future closed candles must not enter the tensor');
  assert.deepEqual(beforeFuture.sequence, built.sequence);
});

test('volume profile is derived only from the supplied completed candles', () => {
  const candles = makeCandles(24);
  const profile = calculateVolumeProfile(candles);
  assert.equal(profile.available, true);
  assert.equal(profile.source, 'AGG_TRADE_PRICE_LEVELS');
  const proxy = calculateVolumeProfile(candles.map(({ aggTrades, ...row }) => row));
  assert.equal(proxy.source, 'CANDLE_TYPICAL_PRICE_PROXY');
  const sparseTrades = calculateVolumeProfile(candles.map((row, index) =>
    index < 5 ? row : { ...row, aggTrades: [] }));
  assert.equal(sparseTrades.source, 'CANDLE_TYPICAL_PRICE_PROXY',
    'partial AggTrades must not be mislabeled as a complete executed-price profile');
  assert.ok(sparseTrades.trade_candle_coverage_pct < 80);
  assert.ok(profile.trade_candle_coverage_pct >= 80);
  assert.ok(profile.poc > 0);
  assert.ok(profile.value_area_low <= profile.poc);
  assert.ok(profile.value_area_high >= profile.poc);
});

test('benchmark event adapter rejects immature forward paths and emits only closed-candle Spot rows', () => {
  const candles = makeCandles(40);
  const at = candles.at(-1).closeTime;
  const noBarrier = [{
    closeTime: at + FIFTEEN_MINUTES, closed: true,
    open: 10, high: 10.2, low: 9.9, close: 10.1
  }];
  const incomplete = prepareHybridBenchmarkEvent({
    id: 'incomplete', symbol: 'ETHUSDT', decisionAt: at,
    candles, benchmarkCandles: candles, entryPrice: 10, classicScore: 0.7, futureCandles: noBarrier
  });
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.reason, 'INCOMPLETE_FORWARD_HORIZON');

  const completedPath = [{
    closeTime: at + FOUR_HOURS, closed: true,
    open: 10, high: 10.4, low: 9.99, close: 10.2
  }];
  const prepared = prepareHybridBenchmarkEvent({
    id: 'prepared', symbol: 'ETHUSDT', decisionAt: at,
    candles, benchmarkCandles: candles, entryPrice: 10, classicScore: 0.7, futureCandles: completedPath
  });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.row.market, 'BINANCE_SPOT_USDT');
  assert.equal(prepared.row.outcome_source, 'BINANCE_SPOT_CLOSED_15M');
  assert.equal(prepared.row.outcome_definition, 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_CLOSED_SPOT_V1');
  assert.equal(prepared.row.latest_input_at, at);
  assert.equal(prepared.row.resolved_at, at + FOUR_HOURS);
  assert.equal(prepared.row.gross_return_pct, 3);
  assert.equal(prepared.row.max_favorable_excursion_pct, 3);
  assert.equal(prepared.row.max_favorable_excursion_at, at + FOUR_HOURS);
});

test('barrier resolver chooses the stop when the same candle touches take-profit and stop-loss', () => {
  const at = Date.UTC(2026, 1, 1);
  const trade = resolveBarrierTrade({
    entryPrice: 100,
    decisionAt: at,
    futureCandles: [{
      closeTime: at + FIFTEEN_MINUTES, closed: true,
      open: 100, high: 104, low: 97, close: 101
    }]
  });
  assert.equal(trade.resolved, true);
  assert.equal(trade.exit_reason, 'STOP_FIRST_SAME_CANDLE_AMBIGUITY');
  assert.equal(trade.gross_return_pct, -2);
  assert.equal(trade.net_return_pct, -2.3);
  assert.ok(trade.max_adverse_excursion_pct <= -2);
  assert.equal(trade.max_adverse_excursion_at, at + FIFTEEN_MINUTES);
  assert.equal(trade.max_favorable_excursion_pct, 0);
  assert.equal(trade.max_favorable_excursion_at, at);
});

test('profit-loss logit gradients match a central finite-difference check', () => {
  const rows = [
    { at: 1, symbol: 'AUSDT', gross_return_pct: 3,
      max_adverse_excursion_pct: -1.2, max_favorable_excursion_pct: 4.5 },
    { at: 2, symbol: 'BUSDT', gross_return_pct: -2,
      max_adverse_excursion_pct: -2.1, max_favorable_excursion_pct: 0.8 },
    { at: 3, symbol: 'CUSDT', gross_return_pct: 2.2,
      max_adverse_excursion_pct: -0.5, max_favorable_excursion_pct: 3.4 }
  ];
  const probabilities = [0.57, 0.63, 0.48];
  const options = { temperature: 0.2, threshold: 0.55, roundTripCostBps: 30 };
  const base = profitDrawdownObjective(probabilities, rows, options);
  const epsilon = 1e-3;
  const logit = Math.log(probabilities[0] / (1 - probabilities[0]));
  const sigmoid = value => 1 / (1 + Math.exp(-value));
  const evaluate = value => profitDrawdownObjective([
    sigmoid(value), probabilities[1], probabilities[2]
  ], rows, options).loss;
  const numerical = (evaluate(logit + epsilon) - evaluate(logit - epsilon)) / (2 * epsilon);
  assert.ok(Math.abs(base.logit_gradients[0] - numerical) < 2e-4,
    'analytical gradient must match central finite difference: ' +
    base.logit_gradients[0] + ' vs ' + numerical);
});

test('profit objective explicitly penalizes measured peak-to-trough excursion', () => {
  const rows = [
    { at: 1, symbol: 'AUSDT', gross_return_pct: 3,
      max_adverse_excursion_pct: -1, max_favorable_excursion_pct: 5 },
    { at: 2, symbol: 'BUSDT', gross_return_pct: 2,
      max_adverse_excursion_pct: -0.2, max_favorable_excursion_pct: 0.5 }
  ];
  const low = profitDrawdownObjective([0.6, 0.6], rows, { excursionDrawdownWeight: 0.04 });
  const high = profitDrawdownObjective([0.6, 0.6], rows.map(row => ({
    ...row, max_favorable_excursion_pct: row.max_favorable_excursion_pct + 5
  })), { excursionDrawdownWeight: 0.04 });
  assert.ok(high.intratrade_excursion_drawdown_penalty > low.intratrade_excursion_drawdown_penalty);
  assert.ok(low.logit_gradients.every(Number.isFinite));
});

test('profit/drawdown objective is finite and produces probability gradients', () => {
  const rows = [
    { at: 1, symbol: 'AUSDT', gross_return_pct: 3 },
    { at: 2, symbol: 'BUSDT', gross_return_pct: -2 },
    { at: 3, symbol: 'CUSDT', gross_return_pct: 2 },
    { at: 4, symbol: 'DUSDT', gross_return_pct: -1.5 }
  ];
  const objective = profitDrawdownObjective([0.8, 0.3, 0.7, 0.2], rows);
  assert.ok(Number.isFinite(objective.loss));
  assert.ok(Number.isFinite(objective.sharpe_per_decision));
  assert.equal(objective.logit_gradients.length, 4);
  assert.ok(objective.logit_gradients.every(Number.isFinite));
  assert.ok(objective.max_additive_drawdown_pct >= 0);
  assert.equal(objective.round_trip_cost_bps, 30);
  assert.ok(objective.positions.every(value => value >= 0 && value <= 1));
});

test('purged expanding walk-forward blocks do not share test timestamps or unresolved labels', () => {
  const rows = makeRows();
  const wf = buildPurgedWalkForwardFolds(rows, {
    folds: 5,
    minimumTrainTimes: 160,
    minimumTrainRows: 80,
    minimumValidationRows: 50,
    minimumTestRows: 50,
    embargoMs: FOUR_HOURS
  });
  assert.equal(wf.status, 'READY', JSON.stringify(wf.folds.map(row => ({
    fold: row.fold, train: row.train_count, validation: row.validation_count, test: row.test_count
  }))));
  assert.equal(wf.fold_count, 5);
  assert.equal(wf.test_blocks_non_overlapping, true);
  for (const fold of wf.folds) {
    assert.ok(fold.max_training_outcome_resolved_at < fold.boundaries.validation_start);
    assert.ok(fold.max_validation_outcome_resolved_at < fold.boundaries.test_start);
    assert.ok(fold.train.every(row => row.latest_input_at <= row.at));
    assert.ok(fold.validation.every(row => row.latest_input_at <= row.at));
    assert.ok(fold.test.every(row => row.latest_input_at <= row.at));
  }
});

test('hybrid TCN actually uses temporal attention and returns a normalized attention distribution', () => {
  const rows = makeRows(60);
  const fitted = trainHybridTcnAttention(rows, { epochs: 1 });
  assert.equal(fitted.architecture, HYBRID_TCN_ARCHITECTURE);
  assert.equal(fitted.receptive_field_steps, 31);
  assert.deepEqual(fitted.architecture_config, HYBRID_TCN_CONFIGURATION);
  assert.equal(fitted.training_objective,
    'NET_PROFIT_PLUS_SHARPE_MINUS_DOWNSIDE_MAE_MFE_DRAWDOWN_V2');
  const predicted = predictHybridTcnAttention(rows.at(-1).sequence, fitted);
  assert.ok(predicted);
  assert.ok(predicted.probability >= 0 && predicted.probability <= 1);
  assert.equal(predicted.attention_weights.length, 24);
  assert.ok(Math.abs(predicted.attention_weights.reduce((sum, value) => sum + value, 0) - 1) < 1e-5);
  assert.ok(predicted.attention_weights.every(value => value >= 0 && value <= 1));
});

test('same fixed dataset produces a deterministic SHA-256 manifest', () => {
  const rows = makeRows(30);
  assert.equal(sha256Canonical(rows), sha256Canonical(rows));
  assert.notEqual(sha256Canonical(rows), sha256Canonical([...rows].reverse()));
  assert.equal(sha256Canonical({ a: 1, b: 2 }), sha256Canonical({ b: 2, a: 1 }));
});

test('paper simulator charges round-trip costs, enforces a single open position, and measures drawdown', () => {
  const base = Date.UTC(2026, 0, 1);
  const report = simulatePaperTrades([
    { id: '1', symbol: 'AUSDT', at: base, resolved_at: base + FOUR_HOURS,
      max_adverse_excursion_at: base + FIFTEEN_MINUTES, max_adverse_excursion_pct: -0.5,
      max_favorable_excursion_at: base + 10 * 60 * 1000, max_favorable_excursion_pct: 1.1,
      max_favorable_excursion_pct: 1.1, max_favorable_excursion_at: base + 10 * 60 * 1000,
      score: 0.9, threshold: 0.5, gross_return_pct: 3 },
    { id: '2', symbol: 'BUSDT', at: base + FIFTEEN_MINUTES, resolved_at: base + FOUR_HOURS,
      max_adverse_excursion_at: base + 2 * FIFTEEN_MINUTES, max_adverse_excursion_pct: -2.1,
      max_favorable_excursion_at: base + 2 * FIFTEEN_MINUTES, max_favorable_excursion_pct: 0.2,
      max_favorable_excursion_pct: 0.2, max_favorable_excursion_at: base + 2 * FIFTEEN_MINUTES,
      score: 0.95, threshold: 0.5, gross_return_pct: -2 },
    { id: '3', symbol: 'CUSDT', at: base + FOUR_HOURS, resolved_at: base + 2 * FOUR_HOURS,
      max_adverse_excursion_at: base + FOUR_HOURS + FIFTEEN_MINUTES, max_adverse_excursion_pct: -2.1,
      max_favorable_excursion_at: base + FOUR_HOURS + 10 * 60 * 1000, max_favorable_excursion_pct: 0.3,
      score: 0.9, threshold: 0.5, gross_return_pct: -2 }
  ], { roundTripCostBps: 30, positionFraction: 1, maxConcurrentPositions: 1 });
  assert.equal(report.trade_count, 2);
  assert.equal(report.skipped_signals_at_position_capacity, 1);
  assert.equal(report.trades[0].net_return_pct, 2.7);
  assert.equal(report.trades[1].net_return_pct, -2.3);
  assert.ok(report.max_drawdown_pct > 0);
  assert.equal(report.trades[0].mae_marked_at, base + FIFTEEN_MINUTES);
  assert.equal(report.trades[1].mae_marked_at, base + FOUR_HOURS + FIFTEEN_MINUTES);
  assert.equal(report.trades[0].mfe_marked_at, base + 10 * 60 * 1000);
  assert.equal(report.trades[1].mfe_marked_at, base + FOUR_HOURS + 10 * 60 * 1000);
  assert.equal(report.trades[0].mfe_marked_at, base + 10 * 60 * 1000);
  assert.equal(report.trades[1].mfe_marked_at, base + FOUR_HOURS + 10 * 60 * 1000);
});

test('paper portfolio enforces a per-symbol lock and a hard concurrent-capital ceiling', () => {
  const base = Date.UTC(2026, 0, 1);
  const report = simulatePaperTrades([
    { id: 'a1', symbol: 'AUSDT', at: base, resolved_at: base + FOUR_HOURS,
      score: 0.95, threshold: 0.5, gross_return_pct: 3, max_adverse_excursion_pct: -0.5,
      max_adverse_excursion_at: base + FIFTEEN_MINUTES,
      max_favorable_excursion_pct: 1, max_favorable_excursion_at: base + 10 * 60 * 1000 },
    { id: 'b1', symbol: 'BUSDT', at: base, resolved_at: base + FOUR_HOURS,
      score: 0.94, threshold: 0.5, gross_return_pct: -2, max_adverse_excursion_pct: -2.1,
      max_adverse_excursion_at: base + 2 * FIFTEEN_MINUTES,
      max_favorable_excursion_pct: 0.4, max_favorable_excursion_at: base + FIFTEEN_MINUTES },
    { id: 'a2', symbol: 'AUSDT', at: base + FIFTEEN_MINUTES, resolved_at: base + 2 * FOUR_HOURS,
      score: 0.99, threshold: 0.5, gross_return_pct: 3, max_adverse_excursion_pct: -0.4,
      max_adverse_excursion_at: base + FOUR_HOURS + FIFTEEN_MINUTES,
      max_favorable_excursion_pct: 1.5, max_favorable_excursion_at: base + FOUR_HOURS + 10 * 60 * 1000 },
    { id: 'c1', symbol: 'CUSDT', at: base + FIFTEEN_MINUTES, resolved_at: base + 2 * FOUR_HOURS,
      score: 0.98, threshold: 0.5, gross_return_pct: 3, max_adverse_excursion_pct: -0.2,
      max_adverse_excursion_at: base + FOUR_HOURS + FIFTEEN_MINUTES,
      max_favorable_excursion_pct: 1.4, max_favorable_excursion_at: base + FOUR_HOURS + 10 * 60 * 1000 },
    { id: 'd1', symbol: 'DUSDT', at: base + FOUR_HOURS, resolved_at: base + 2 * FOUR_HOURS,
      score: 0.97, threshold: 0.5, gross_return_pct: 3, max_adverse_excursion_pct: -0.3,
      max_adverse_excursion_at: base + FOUR_HOURS + 2 * FIFTEEN_MINUTES,
      max_favorable_excursion_pct: 1.3, max_favorable_excursion_at: base + FOUR_HOURS + 3 * 60 * 1000 }
  ], { positionFraction: 0.5, maxConcurrentPositions: 2 });
  assert.equal(report.trade_count, 3);
  assert.equal(report.max_concurrent_positions, 2);
  assert.equal(report.skipped_signals_same_symbol_position_open, 1);
  assert.equal(report.skipped_signals_at_position_capacity, 1);
  assert.ok(report.trades.every(trade => trade.exit_realized === true));
  assert.ok(report.max_drawdown_pct > 0, 'the losing open position adverse excursion must contribute to drawdown');
});

test('fixed-SHA benchmark keeps both models on the same OOS events and fails closed without proven superiority', () => {
  const report = runFixedShaBenchmark(makeRows(), {
    sourceCommitSha: SOURCE_SHA,
    folds: 5,
    minimumTrainTimes: 160,
    minimumTrainRows: 80,
    minimumValidationRows: 50,
    minimumTestRows: 50,
    embargoMs: FOUR_HOURS,
    epochs: 1,
    thresholdGrid: [0.4, 0.5, 0.6]
  });
  assert.ok(report.integrity.dataset_sha256);
  assert.equal(report.integrity.source_commit_sha, SOURCE_SHA);
  assert.equal(report.walk_forward.fold_count, 5);
  assert.equal(report.same_test_event_count, 450);
  assert.equal(report.integrity.rejected_or_duplicate_rows_removed, 0);
  assert.equal(report.acceptance_gates.all_input_rows_valid_and_unique, 'PASS');
  assert.deepEqual(report.integrity.market_regimes, ['BEAR_TREND','BULL_TREND','SIDEWAYS']);
  assert.equal(report.acceptance_gates.all_three_observed_btc_regimes, 'PASS');
  assert.equal(report.classic_baseline.trade_count > 0, true);
  assert.equal(report.status, 'NEURAL_SUPERIORITY_NOT_PROVEN');
  assert.equal(report.superiority, 'NOT_PROVEN');
  assert.equal(report.acceptance_gates.beat_classic_on_net_pnl_sharpe_without_higher_drawdown, 'FAIL');
  assert.equal(report.acceptance_gates.same_fixed_sha_and_oos_event_rows, 'PASS');
  assert.equal(report.execution_policy.paper_only, true);
  assert.equal(report.execution_policy.real_order_execution, false);
});

test('fixed-SHA benchmark rejects missing MAE timing and mixed outcome sources', () => {
  const rows = makeRows(8);
  const invalidMae = rows.map(row => ({ ...row }));
  delete invalidMae[0].max_adverse_excursion_at;
  const incomplete = runFixedShaBenchmark(invalidMae, {
    sourceCommitSha: SOURCE_SHA, folds: 5, minimumTrainTimes: 40,
    minimumTrainRows: 20, minimumValidationRows: 10, minimumTestRows: 10
  });
  assert.equal(incomplete.integrity.rows, 7);
  assert.equal(incomplete.integrity.rejected_or_duplicate_rows_removed, 1);
  assert.equal(incomplete.integrity.adverse_excursion_coverage_pct, 100);

  const mixed = [...rows, {
    ...rows[0], id: 'different-source', at: rows[0].at + 1,
    latest_input_at: rows[0].at + 1, resolved_at: rows[0].resolved_at + 1,
    outcome_source: 'BINANCE_SPOT_CLOSED_1M_REPLAY'
  }];
  assert.throws(() => runFixedShaBenchmark(mixed, { sourceCommitSha: SOURCE_SHA }),
    /ONE_CLOSED_SPOT_OUTCOME_SOURCE/);
});

test('fixed-SHA benchmark refuses a dataset missing any observed BTC regime', () => {
  const rows = makeRows(18).map(row => ({
    ...row, market_regime: 'BULL_TREND', historical_window_id: 'only-bull-window'
  }));
  const report = runFixedShaBenchmark(rows, {
    sourceCommitSha: SOURCE_SHA, folds: 5, minimumTrainTimes: 40,
    minimumTrainRows: 20, minimumValidationRows: 10, minimumTestRows: 10
  });
  assert.equal(report.status, 'INSUFFICIENT_MARKET_REGIME_COVERAGE');
  assert.deepEqual(report.integrity.missing_market_regimes, ['BEAR_TREND', 'SIDEWAYS']);
  assert.equal(report.acceptance_gates.all_three_observed_btc_regimes, 'FAIL');
  assert.equal(report.neural, null);
});

test('benchmark refuses a partial source SHA instead of inventing a fixed reference', () => {
  assert.throws(() => runFixedShaBenchmark([], { sourceCommitSha: 'abc123' }),
    /FULL_SOURCE_COMMIT_SHA/);
});
