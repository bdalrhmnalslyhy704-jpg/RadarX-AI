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
  calculateKamaEfficiencyRatio,
  evaluateHybridMarketGates,
  buildPurgedWalkForwardFolds,
  calculateVolumeProfile,
  diagnoseHybridGradientIntegrity,
  predictHybridTcnAttention,
  prepareHybridBenchmarkEvent,
  profitDrawdownObjective,
  resolveBarrierTrade,
  hasRiskAdjustedNeuralSuperiority,
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
      if (feature === 28) return 0.35; // directional KAMA efficiency ratio
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
      kama_efficiency_ratio: 0.35,
      volatility_zscore: 0.5,
      btc_trend_return_pct: 0.8,
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

test('hybrid feature contract includes order flow, depth, volume profile, adaptive volatility and KAMA ER', () => {
  assert.equal(HYBRID_FEATURE_NAMES.length, 29);
  assert.equal(HYBRID_SEQUENCE_CHANNELS, 29);
  assert.equal(HYBRID_FEATURE_NAMES.at(-1), 'kama_efficiency_ratio');
  for (const name of [
    'taker_buy_imbalance', 'agg_trade_imbalance', 'depth_imbalance',
    'volume_profile_poc_distance', 'volume_profile_value_area_position',
    'volume_profile_trade_level_available', 'adaptive_volatility_ratio', 'relative_btc_available',
    'short_return_acceleration', 'three_bar_momentum_reversal', 'fast_slow_mean_spread',
    'higher_low_reclaim', 'prior_high_reclaim'
  ]) assert.ok(HYBRID_FEATURE_NAMES.includes(name), name);

  const candles = makeCandles();
  const asOf = candles.at(-1).closeTime;
  const built = buildHybridSequence({ candles, benchmarkCandles: candles, asOf, sequenceSteps: 24 });
  assert.equal(built.ready, true);
  assert.equal(built.sequence.length, 24);
  assert.equal(built.sequence[0].length, 29);
  assert.ok(built.kama_efficiency_ratio >= 0 && built.kama_efficiency_ratio <= 1);
  assert.ok(Number.isFinite(built.volatility_zscore));
  assert.ok(Number.isFinite(built.btc_trend_return_pct));
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

test('KAMA efficiency ratio distinguishes directional movement from a choppy path', () => {
  const trend = Array.from({ length: 11 }, (_, index) => ({
    closeTime: Date.UTC(2026, 0, 1) + index * FIFTEEN_MINUTES,
    closed: true, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index,
    volume: 1000, quoteVolume: 100000, numberOfTrades: 100
  }));
  const choppy = trend.map((row, index) => ({
    ...row, close: 100 + (index % 2 === 0 ? 0 : 0.5), open: 100, high: 101, low: 99
  }));
  const trendingRatio = calculateKamaEfficiencyRatio(trend, { period: 10 });
  const choppyRatio = calculateKamaEfficiencyRatio(choppy, { period: 10 });
  assert.equal(trendingRatio, 1);
  assert.ok(choppyRatio < trendingRatio);
  assert.equal(calculateKamaEfficiencyRatio(trend.slice(0, 8), { period: 10 }), null);
});

test('KAMA, volatility z-score and exponential BTC countertrend gates reject weak context and attenuate opposing trend', () => {
  const lowKama = evaluateHybridMarketGates({
    kama_efficiency_ratio: 0.1, volatility_zscore: 1.1, btc_trend_return_pct: 2
  });
  assert.equal(lowKama.eligible, false);
  assert.equal(lowKama.reason, 'KAMA_EFFICIENCY_BELOW_MINIMUM');

  const lowVolatility = evaluateHybridMarketGates({
    kama_efficiency_ratio: 0.6, volatility_zscore: -0.01, btc_trend_return_pct: 2
  });
  assert.equal(lowVolatility.eligible, false);
  assert.equal(lowVolatility.reason, 'VOLATILITY_BELOW_ROLLING_MEAN');

  const withBtcHeadwind = evaluateHybridMarketGates({
    kama_efficiency_ratio: 0.6, volatility_zscore: 0.4, btc_trend_return_pct: -2
  });
  const withBtcTailwind = evaluateHybridMarketGates({
    kama_efficiency_ratio: 0.6, volatility_zscore: 0.4, btc_trend_return_pct: 2
  });
  assert.equal(withBtcHeadwind.eligible, true);
  assert.ok(withBtcHeadwind.btc_countertrend_penalty_factor < 1);
  assert.equal(withBtcTailwind.btc_countertrend_penalty_factor, 1);
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

  const singleLetter = prepareHybridBenchmarkEvent({
    id: 'single-letter-symbol', symbol: 'WUSDT', decisionAt: at,
    candles, benchmarkCandles: candles, entryPrice: 10, classicScore: 0.7, futureCandles: completedPath
  });
  assert.equal(singleLetter.ready, true, 'valid one-character Binance base assets must be accepted');
  assert.equal(singleLetter.row.symbol, 'WUSDT');
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

test('asymmetric focal loss gives a stronger gradient to overconfident losing-direction predictions', () => {
  const losingRows = [
    { at: 1, symbol: 'LOSSUSDT', gross_return_pct: -2,
      max_adverse_excursion_pct: -2.1, max_favorable_excursion_pct: 0.7 }
  ];
  const highWrong = profitDrawdownObjective([0.9], losingRows, { focalLossWeight: 1 }).asymmetric_focal_loss;
  const lowWrong = profitDrawdownObjective([0.1], losingRows, { focalLossWeight: 1 }).asymmetric_focal_loss;
  assert.ok(highWrong > lowWrong * 100, 'high-confidence false positives must receive materially higher focal penalty');
  const p = 0.72;
  const base = profitDrawdownObjective([p], losingRows, { focalLossWeight: 0.7, focalNegativeWeight: 1.8 });
  const z = Math.log(p / (1 - p));
  const epsilon = 1e-3;
  const sigmoid = value => 1 / (1 + Math.exp(-value));
  const evaluate = value => profitDrawdownObjective([sigmoid(value)], losingRows,
    { focalLossWeight: 0.7, focalNegativeWeight: 1.8 }).loss;
  const numerical = (evaluate(z + epsilon) - evaluate(z - epsilon)) / (2 * epsilon);
  assert.ok(Math.abs(base.logit_gradients[0] - numerical) < 2e-4,
    'asymmetric focal analytical gradient must match central finite difference');
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

test('walk-forward row thresholds are not compared to the number of distinct time buckets', () => {
  const rows = makeRows(651).map((row, index) => {
    const at = Date.UTC(2026, 0, 1) + Math.floor(index / 3) * FIFTEEN_MINUTES;
    return {
      ...row, at, latest_input_at: at, resolved_at: at + FOUR_HOURS,
      max_adverse_excursion_at: at + FIFTEEN_MINUTES,
      max_favorable_excursion_at: at + 2 * FIFTEEN_MINUTES
    };
  });
  const wf = buildPurgedWalkForwardFolds(rows, {
    folds: 5, minimumTrainTimes: 40, minimumTrainRows: 20,
    minimumValidationRows: 30, minimumTestRows: 30, embargoMs: FOUR_HOURS
  });
  assert.equal(wf.distinct_times, 217);
  assert.equal(wf.status, 'READY', JSON.stringify(wf.folds.map(fold => ({
    train: fold.train_count, validation: fold.validation_count, test: fold.test_count
  }))));
  assert.ok(wf.folds.every(fold => fold.validation_count >= 30 && fold.test_count >= 30));
});

test('hand-written TCN and temporal-attention backpropagation matches finite differences', () => {
  const diagnostic = diagnoseHybridGradientIntegrity();
  assert.equal(diagnostic.status, 'PASS', JSON.stringify(diagnostic));
  assert.ok(diagnostic.probes.length >= 9);
  assert.ok(diagnostic.maximum_relative_error <= 2e-4);
});

test('cross-sectional neural ranking pushes same-time profitable assets above losing assets', () => {
  const positive = {
    at: 10, symbol: 'AUSDT', gross_return_pct: 3,
    max_adverse_excursion_pct: -0.2, max_favorable_excursion_pct: 3,
    kama_efficiency_ratio: 0.8, volatility_zscore: 0.8, btc_trend_return_pct: 0.2
  };
  const negative = {
    at: 10, symbol: 'BUSDT', gross_return_pct: -2,
    max_adverse_excursion_pct: -2.1, max_favorable_excursion_pct: 0.2,
    kama_efficiency_ratio: 0.7, volatility_zscore: 0.6, btc_trend_return_pct: 0.2
  };
  const options = {
    enforceMarketGates: true, roundTripCostBps: 30,
    sharpeWeight: 0, cumulativeGrowthWeight: 0, downsideWeight: 0,
    adverseExcursionWeight: 0, excursionDrawdownWeight: 0, drawdownWeight: 0,
    focalLossWeight: 0, crossSectionalRankingWeight: 1
  };
  const objective = profitDrawdownObjective([0.4, 0.6], [positive, negative], options);
  assert.equal(objective.cross_sectional_ranking_pair_count, 1);
  assert.ok(objective.cross_sectional_ranking_loss > 0);
  assert.ok(objective.logit_gradients[0] < 0,
    'gradient must raise the profitable row logit');
  assert.ok(objective.logit_gradients[1] > 0,
    'gradient must lower the losing row logit');
});

test('cross-sectional ranking never compares assets from different decision times', () => {
  const rows = [
    { at: 10, symbol: 'AUSDT', gross_return_pct: 3, max_adverse_excursion_pct: -0.2,
      max_favorable_excursion_pct: 3, kama_efficiency_ratio: 0.8, volatility_zscore: 0.8,
      btc_trend_return_pct: 0.2 },
    { at: 20, symbol: 'BUSDT', gross_return_pct: -2, max_adverse_excursion_pct: -2.1,
      max_favorable_excursion_pct: 0.2, kama_efficiency_ratio: 0.7, volatility_zscore: 0.6,
      btc_trend_return_pct: 0.2 }
  ];
  const objective = profitDrawdownObjective([0.4, 0.6], rows, {
    enforceMarketGates: true, sharpeWeight: 0, cumulativeGrowthWeight: 0,
    downsideWeight: 0, adverseExcursionWeight: 0, excursionDrawdownWeight: 0,
    drawdownWeight: 0, focalLossWeight: 0, crossSectionalRankingWeight: 1
  });
  assert.equal(objective.cross_sectional_ranking_pair_count, 0);
  assert.equal(objective.cross_sectional_ranking_loss, 0);
  assert.equal(objective.logit_gradients[0], 0);
  assert.equal(objective.logit_gradients[1], 0);
});

test('market-gated focal loss ignores samples that can never become executable positions', () => {
  const eligible = {
    at: 1, symbol: 'AUSDT', gross_return_pct: 0.3,
    max_adverse_excursion_pct: 0, max_favorable_excursion_pct: 0,
    kama_efficiency_ratio: 0.7, volatility_zscore: 0.5, btc_trend_return_pct: 0.2
  };
  const blocked = {
    at: 2, symbol: 'BUSDT', gross_return_pct: 0.3,
    max_adverse_excursion_pct: 0, max_favorable_excursion_pct: 0,
    kama_efficiency_ratio: 0.05, volatility_zscore: 0.5, btc_trend_return_pct: 0.2
  };
  const options = {
    enforceMarketGates: true, roundTripCostBps: 30,
    sharpeWeight: 0, cumulativeGrowthWeight: 0, downsideWeight: 0,
    adverseExcursionWeight: 0, excursionDrawdownWeight: 0, drawdownWeight: 0,
    focalLossWeight: 1
  };
  const solo = profitDrawdownObjective([0.8], [eligible], options);
  const mixed = profitDrawdownObjective([0.8, 0.99], [eligible, blocked], options);
  assert.equal(solo.focal_sample_count, 1);
  assert.equal(mixed.focal_sample_count, 1);
  assert.equal(mixed.focal_eligible_coverage_pct, 50);
  assert.equal(mixed.asymmetric_focal_loss, solo.asymmetric_focal_loss);
  assert.ok(Math.abs(mixed.logit_gradients[0] - solo.logit_gradients[0]) < 1e-10);
  assert.equal(mixed.logit_gradients[1], 0);
});

test('hybrid TCN actually uses temporal attention and returns a normalized attention distribution', () => {
  const rows = makeRows(60);
  const fitted = trainHybridTcnAttention(rows, { epochs: 1 });
  assert.equal(fitted.architecture, HYBRID_TCN_ARCHITECTURE);
  assert.equal(fitted.receptive_field_steps, 31);
  assert.deepEqual(fitted.architecture_config, HYBRID_TCN_CONFIGURATION);
  assert.equal(fitted.training_objective,
    'CUMULATIVE_EQUITY_SHARPE_BTC_COUNTERTREND_ASYMMETRIC_FOCAL_KAMA_V4');
  assert.equal(fitted.activation, 'LEAKY_RELU_ALPHA_0_05');
  assert.equal(fitted.normalization.method, 'TRAIN_FOLD_CHANNEL_ZSCORE_CLIPPED_4');
  assert.equal(fitted.normalization.means.length, HYBRID_SEQUENCE_CHANNELS);
  assert.ok(fitted.trained_logit_scale >= 0.25 && fitted.trained_logit_scale <= 4);
  const predicted = predictHybridTcnAttention(rows.at(-1).sequence, fitted);
  assert.ok(predicted);
  assert.ok(predicted.probability >= 0 && predicted.probability <= 1);
  assert.ok(predicted.logit_scale >= 0.25 && predicted.logit_scale <= 4);
  assert.ok(Number.isFinite(predicted.raw_logit));
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

test('cumulative-equity Sharpe gradient remains exact when KAMA, volatility and BTC gates are active', () => {
  const rows = [
    { at: 1, symbol: 'AUSDT', gross_return_pct: 3,
      max_adverse_excursion_pct: -0.8, max_favorable_excursion_pct: 3.2,
      kama_efficiency_ratio: 0.6, volatility_zscore: 0.8, btc_trend_return_pct: -1.5 },
    { at: 2, symbol: 'BUSDT', gross_return_pct: -2,
      max_adverse_excursion_pct: -2.1, max_favorable_excursion_pct: 0.7,
      kama_efficiency_ratio: 0.55, volatility_zscore: 0.2, btc_trend_return_pct: 0.5 },
    { at: 3, symbol: 'CUSDT', gross_return_pct: 2.2,
      max_adverse_excursion_pct: -0.5, max_favorable_excursion_pct: 3.4,
      kama_efficiency_ratio: 0.8, volatility_zscore: 1.1, btc_trend_return_pct: -0.7 }
  ];
  const probabilities = [0.57, 0.63, 0.48];
  const options = { temperature: 0.2, threshold: 0.55, roundTripCostBps: 30, enforceMarketGates: true };
  const base = profitDrawdownObjective(probabilities, rows, options);
  assert.ok(Number.isFinite(base.cumulative_equity_sharpe));
  assert.ok(Number.isFinite(base.cumulative_geometric_return_pct));
  assert.equal(base.btc_countertrend_penalty_enabled, true);
  assert.ok(base.mean_btc_penalty_factor < 1);
  const epsilon = 1e-3;
  const logit = Math.log(probabilities[0] / (1 - probabilities[0]));
  const sigmoid = value => 1 / (1 + Math.exp(-value));
  const evaluate = value => profitDrawdownObjective([
    sigmoid(value), probabilities[1], probabilities[2]
  ], rows, options).loss;
  const numerical = (evaluate(logit + epsilon) - evaluate(logit - epsilon)) / (2 * epsilon);
  assert.ok(Math.abs(base.logit_gradients[0] - numerical) < 3e-4,
    'cumulative equity Sharpe plus BTC-adjusted gate gradient must match central finite difference');
});

test('paper simulator hard-rejects low KAMA or below-mean volatility and applies an exponential BTC headwind', () => {
  const base = Date.UTC(2026, 0, 1);
  const common = {
    at: base, resolved_at: base + FOUR_HOURS,
    max_adverse_excursion_at: base + FIFTEEN_MINUTES,
    max_adverse_excursion_pct: -0.5,
    max_favorable_excursion_at: base + 2 * FIFTEEN_MINUTES,
    max_favorable_excursion_pct: 1.2,
    score: 0.95, threshold: 0.6, gross_return_pct: 3
  };
  const report = simulatePaperTrades([
    { ...common, id: 'ok', symbol: 'AUSDT', kama_efficiency_ratio: 0.6,
      volatility_zscore: 0.3, btc_trend_return_pct: -2 },
    { ...common, id: 'low-kama', symbol: 'BUSDT', kama_efficiency_ratio: 0.1,
      volatility_zscore: 0.8, btc_trend_return_pct: 1 },
    { ...common, id: 'low-vol', symbol: 'CUSDT', kama_efficiency_ratio: 0.7,
      volatility_zscore: -0.2, btc_trend_return_pct: 1 }
  ], { enforceMarketGates: true, positionFraction: 0.5, maxConcurrentPositions: 3 });
  assert.equal(report.trade_count, 1);
  assert.equal(report.market_gate_diagnostics.blocked_kama_efficiency, 1);
  assert.equal(report.market_gate_diagnostics.blocked_low_volatility, 1);
  assert.equal(report.market_gate_diagnostics.btc_countertrend_penalized, 1);
  assert.ok(report.trades[0].score < 0.95);
  assert.ok(report.trades[0].market_gate.btc_countertrend_penalty_factor < 1);
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
  const rows = makeRows();
  rows[0] = { ...rows[0], symbol: 'WUSDT', max_adverse_excursion_pct: 0.15 };
  const report = runFixedShaBenchmark(rows, {
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
  assert.equal(report.integrity.rows, rows.length);
  assert.equal(report.integrity.rejected_or_duplicate_rows_removed, 0);
  const normalizedRows = buildPurgedWalkForwardFolds(rows, {
    folds: 5, minimumTrainTimes: 160, minimumTrainRows: 80,
    minimumValidationRows: 50, minimumTestRows: 50, embargoMs: FOUR_HOURS
  });
  const normalizedSingleLetterRow = normalizedRows.folds
    .flatMap(fold => fold.train).find(row => row.id === 'event-0');
  assert.ok(normalizedSingleLetterRow, 'event must remain eligible for chronological training');
  assert.equal(normalizedSingleLetterRow.symbol, 'WUSDT');
  assert.equal(normalizedSingleLetterRow.max_adverse_excursion_pct, 0,
    'positive raw MAE from a path with no downside is normalized to zero, not discarded');
  assert.equal(report.acceptance_gates.all_input_rows_valid_and_unique, 'PASS');
  assert.deepEqual(report.integrity.market_regimes, ['BEAR_TREND','BULL_TREND','SIDEWAYS']);
  assert.equal(report.acceptance_gates.all_three_observed_btc_regimes, 'PASS');
  assert.equal(report.acceptance_gates.each_required_btc_regime_has_30_oos_events, 'PASS');
  assert.ok(Object.values(report.integrity.out_of_sample_market_regime_counts).every(count => count >= 30));
  assert.equal(report.acceptance_gates.same_fixed_sha_and_oos_event_rows, 'PASS');
  assert.equal(report.acceptance_gates.no_future_features_and_purged_boundaries, 'PASS');
  assert.equal(report.classic_baseline.trade_count > 0, true);
  assert.equal(report.status, 'NEURAL_SUPERIORITY_NOT_PROVEN');
  assert.equal(report.superiority, 'NOT_PROVEN');
  assert.equal(report.acceptance_gates.beat_classic_on_net_pnl_sharpe_without_higher_drawdown, 'FAIL');
  assert.equal(report.acceptance_gates.same_fixed_sha_and_oos_event_rows, 'PASS');
  assert.equal(report.execution_policy.paper_only, true);
  assert.equal(report.execution_policy.real_order_execution, false);
});

test('zero-trade abstention cannot count as risk-adjusted neural superiority', () => {
  const inactiveNeural = {
    trade_count: 0, win_rate_pct: 0, net_pnl_pct: 0,
    max_drawdown_pct: 0, sharpe_per_trade: 0
  };
  const losingClassic = {
    trade_count: 429, win_rate_pct: 27.7389, net_pnl_pct: -12.433706,
    max_drawdown_pct: 14.028493, sharpe_per_trade: -0.91
  };
  assert.equal(hasRiskAdjustedNeuralSuperiority(inactiveNeural, losingClassic, {
    validationThresholdsReady: false
  }), false, 'no trades and zero drawdown are not evidence of a better model');

  const profitableNeural = {
    trade_count: 120, win_rate_pct: 58, net_pnl_pct: 2.1,
    max_drawdown_pct: 5, sharpe_per_trade: 0.8
  };
  const lowerPerformingClassic = {
    trade_count: 120, win_rate_pct: 51, net_pnl_pct: 0.8,
    max_drawdown_pct: 6, sharpe_per_trade: 0.4
  };
  assert.equal(hasRiskAdjustedNeuralSuperiority(profitableNeural, lowerPerformingClassic, {
    validationThresholdsReady: true
  }), true);
});

test('threshold selection abstains when positive validation PnL has negative risk-adjusted utility', () => {
  const rows = makeRows().map(row => ({
    ...row,
    gross_return_pct: 0.4,
    max_adverse_excursion_pct: -25,
    max_favorable_excursion_pct: 0.4
  }));
  const report = runFixedShaBenchmark(rows, {
    sourceCommitSha: SOURCE_SHA,
    folds: 5,
    minimumTrainTimes: 160,
    minimumTrainRows: 80,
    minimumValidationRows: 50,
    minimumTestRows: 50,
    embargoMs: FOUR_HOURS,
    epochs: 1,
    thresholdGrid: [0.4, 0.5],
    minimumValidationTrades: 10
  });
  const trials = report.walk_forward.folds.flatMap(fold =>
    fold.neural_threshold_selection.candidate_trials);
  assert.ok(trials.some(row => row.trade_count >= 10 &&
    row.net_pnl_pct > 0 && row.utility <= 0 &&
    row.risk_adjusted_edge_over_abstention === false),
  'fixture must expose profitable-but-risk-dominated validation choices');
  assert.ok(report.walk_forward.folds.every(fold =>
    fold.neural_threshold_selection.status === 'ABSTAINED_NO_PROFITABLE_VALIDATION_THRESHOLD'),
  'the model must abstain rather than choose a negative-utility strategy');
  assert.equal(report.acceptance_gates.neural_validation_thresholds_profitable_with_minimum_samples, 'FAIL');
});

test('threshold selection explores validation score quantiles and explicitly abstains without a profitable sample', () => {
  const rows = makeRows().map(row => ({
    ...row,
    gross_return_pct: -2,
    max_adverse_excursion_pct: -2.1,
    max_favorable_excursion_pct: 0.8
  }));
  const report = runFixedShaBenchmark(rows, {
    sourceCommitSha: SOURCE_SHA,
    folds: 5,
    minimumTrainTimes: 160,
    minimumTrainRows: 80,
    minimumValidationRows: 50,
    minimumTestRows: 50,
    embargoMs: FOUR_HOURS,
    epochs: 1,
    thresholdGrid: [0.4, 0.6],
    minimumValidationTrades: 10
  });
  assert.equal(report.neural.trade_count, 0);
  assert.equal(report.acceptance_gates.neural_validation_thresholds_profitable_with_minimum_samples, 'FAIL');
  assert.equal(report.acceptance_gates.beat_classic_on_net_pnl_sharpe_without_higher_drawdown, 'FAIL');
  assert.ok(report.walk_forward.folds.every(fold =>
    fold.neural_threshold_selection.status === 'ABSTAINED_NO_PROFITABLE_VALIDATION_THRESHOLD'));
  assert.ok(report.walk_forward.folds.every(fold =>
    fold.neural_threshold_selection.candidate_trials.length > 2));
  assert.ok(report.walk_forward.folds.every(fold =>
    fold.neural_threshold > 1));
});

test('fixed-SHA benchmark rejects OOS coverage that omits one market regime', () => {
  const rows = makeRows(700).map((row, index) => ({
    ...row,
    market_regime: index < 250 ? 'SIDEWAYS' : (index < 475 ? 'BULL_TREND' : 'BEAR_TREND'),
    historical_window_id: index < 250 ? 'sideways-window' : (index < 475 ? 'bull-window' : 'bear-window')
  }));
  const report = runFixedShaBenchmark(rows, {
    sourceCommitSha: SOURCE_SHA, folds: 5, minimumTrainTimes: 160,
    minimumTrainRows: 80, minimumValidationRows: 50, minimumTestRows: 50,
    embargoMs: FOUR_HOURS, epochs: 1, thresholdGrid: [0.4, 0.5, 0.6]
  });
  assert.deepEqual(report.integrity.market_regimes, ['BEAR_TREND', 'BULL_TREND', 'SIDEWAYS']);
  assert.equal(report.acceptance_gates.all_three_observed_btc_regimes, 'PASS');
  assert.equal(report.integrity.out_of_sample_market_regime_counts.SIDEWAYS, 0);
  assert.ok(report.integrity.out_of_sample_market_regime_counts.BULL_TREND >= 30);
  assert.ok(report.integrity.out_of_sample_market_regime_counts.BEAR_TREND >= 30);
  assert.equal(report.acceptance_gates.each_required_btc_regime_has_30_oos_events, 'FAIL');
  assert.equal(report.status, 'NEURAL_SUPERIORITY_NOT_PROVEN');
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
  assert.equal(report.acceptance_gates.each_required_btc_regime_has_30_oos_events, 'FAIL');
  assert.equal(report.neural, null);
});

test('benchmark refuses a partial source SHA instead of inventing a fixed reference', () => {
  assert.throws(() => runFixedShaBenchmark([], { sourceCommitSha: 'abc123' }),
    /FULL_SOURCE_COMMIT_SHA/);
});
