import { createHash } from 'node:crypto';
import {validateTemporalSequenceAlignment} from './neural-safety-contracts.mjs';
import {focalAsymmetricBrierLoss} from './neural-closure-contracts.mjs';

export const HYBRID_FEATURE_NAMES = Object.freeze([
  'log_return_1',
  'log_return_3',
  'log_return_12',
  'candle_body_pct',
  'candle_range_pct',
  'close_location',
  'upper_wick_fraction',
  'lower_wick_fraction',
  'quote_turnover_log_ratio',
  'trade_count_log_ratio',
  'taker_buy_imbalance',
  'agg_trade_imbalance',
  'depth_imbalance',
  'spread_bps_scaled',
  'volume_profile_poc_distance',
  'volume_profile_value_area_position',
  'realized_volatility_short',
  'adaptive_volatility_ratio',
  'relative_btc_return',
  'order_book_available',
  'agg_trade_available',
  'volume_profile_trade_level_available',
  'relative_btc_available',
  'short_return_acceleration',
  'three_bar_momentum_reversal',
  'fast_slow_mean_spread',
  'higher_low_reclaim',
  'prior_high_reclaim',
  'kama_efficiency_ratio'
]);

export const HYBRID_SEQUENCE_STEPS = 24;
export const HYBRID_SEQUENCE_CHANNELS = HYBRID_FEATURE_NAMES.length;
export const HYBRID_CANDLE_INTERVAL_MS = 15 * 60 * 1000;
export const HYBRID_REPLAY_CANDLE_INTERVAL_MS = 60 * 1000;
export const HYBRID_OUTCOME_HORIZON_MS = 4 * 60 * 60 * 1000;
export const HYBRID_TCN_RECEPTIVE_FIELD = 1 + (3 - 1) * (1 + 2 + 4 + 8);
export const HYBRID_TCN_ARCHITECTURE =
  'CAUSAL_TCN_24x29_DILATIONS_1_2_4_8_KERNEL3_RECEPTIVE_FIELD31_KAMA_ER_VOLATILITY_Z_GATE_BTC_COUNTERTREND_CUMULATIVE_SHARPE_V4';

const HIDDEN = 12;
const DILATIONS = Object.freeze([1, 2, 4, 8]);
const KERNEL_TAPS = 3;
const TCN_RECEPTIVE_FIELD = 1 + (KERNEL_TAPS - 1) * DILATIONS.reduce((sum, dilation) => sum + dilation, 0);
export const HYBRID_TCN_CONFIGURATION = Object.freeze({
  sequence_steps: HYBRID_SEQUENCE_STEPS,
  feature_channels: HYBRID_SEQUENCE_CHANNELS,
  hidden_channels: HIDDEN,
  residual_tcn_blocks: DILATIONS.length,
  dilations: DILATIONS,
  kernel_taps: KERNEL_TAPS,
  receptive_field_steps: TCN_RECEPTIVE_FIELD,
  temporal_attention: 'LEARNED_QUERY_SOFTMAX',
  activation: 'LEAKY_RELU_ALPHA_0_05',
  input_normalization: 'TRAIN_FOLD_CHANNEL_ZSCORE_CLIPPED_4',
  output_logit_scale: 'TRAINED_EXP_BOUNDED_0_25_TO_4',
  directional_filter: 'KAMA_EFFICIENCY_RATIO_10_CLOSED_CANDLES',
  volatility_gate: 'CURRENT_6_RETURN_VOLATILITY_ZSCORE_AGAINST_PRIOR_24',
  minimum_kama_efficiency_ratio: 0.20,
  minimum_volatility_zscore: 0,
  btc_countertrend_penalty: 'EXPONENTIAL_0_12_PER_NEGATIVE_1PCT_12_BAR_BTC_RETURN',
  training_objective: 'CUMULATIVE_EQUITY_SHARPE_WITH_BTC_COUNTERTREND_PENALTY_V4'
});
const EPS = 1e-8;
const DEFAULT_COST_BPS = 30; // 10 bps fee + 5 bps slippage on each side.
const DEFAULT_MAX_CONCURRENT_POSITIONS = 30;
const DEFAULT_POSITION_FRACTION = 1 / DEFAULT_MAX_CONCURRENT_POSITIONS;
const DEFAULT_TRADE_THRESHOLD_GRID = Object.freeze([0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75]);
const DEFAULT_TARGET_DEFINITION = 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_CLOSED_SPOT_V1';
const REQUIRED_MARKET_REGIMES = Object.freeze(['BULL_TREND', 'BEAR_TREND', 'SIDEWAYS']);

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = values => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -18, 18)));
const leakyRelu = value => value >= 0 ? value : value * 0.05;
const leakyReluDerivative = activated => activated >= 0 ? 1 : 0.05;
const round = (value, digits = 6) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('NON_FINITE_VALUE_IN_BENCHMARK_DATA');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

export function sha256Canonical(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function candleTime(candle) {
  return finite(candle?.closeTime) ?? finite(candle?.close_time) ?? finite(candle?.timestamp);
}

function candleNumber(candle, key, alternate) {
  return finite(candle?.[key]) ?? (alternate ? finite(candle?.[alternate]) : null);
}

function validClosedCandle(candle, asOf = Infinity) {
  const closeTime = candleTime(candle);
  const open = candleNumber(candle, 'open');
  const high = candleNumber(candle, 'high');
  const low = candleNumber(candle, 'low');
  const close = candleNumber(candle, 'close');
  return candle?.closed === true && closeTime !== null && closeTime <= asOf &&
    open !== null && high !== null && low !== null && close !== null &&
    low > 0 && high >= low && open > 0 && close > 0;
}

function quoteVolume(candle) {
  const direct = candleNumber(candle, 'quoteVolume', 'quote_volume');
  if (direct !== null && direct >= 0) return direct;
  const volume = candleNumber(candle, 'volume');
  const close = candleNumber(candle, 'close');
  return volume !== null && close !== null ? Math.max(0, volume * close) : 0;
}

function tradeCount(candle) {
  return Math.max(0, finite(candle?.numberOfTrades ?? candle?.trade_count ?? candle?.tradeCount) ?? 0);
}

function logReturn(current, previous) {
  return current > 0 && previous > 0 ? Math.log(current / previous) : 0;
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function depthTotals(snapshot, midPrice) {
  if (!snapshot || !(midPrice > 0)) return null;
  const total = (levels, side) => {
    if (!Array.isArray(levels)) return null;
    let quote = 0;
    for (const level of levels.slice(0, 20)) {
      const price = finite(Array.isArray(level) ? level[0] : level?.price);
      const quantity = finite(Array.isArray(level) ? level[1] : (level?.quantity ?? level?.qty));
      if (price === null || quantity === null || price <= 0 || quantity < 0) continue;
      const withinBand = side === 'bid'
        ? price >= midPrice * 0.99 && price <= midPrice
        : price <= midPrice * 1.01 && price >= midPrice;
      if (withinBand) quote += price * quantity;
    }
    return quote;
  };
  const bidDirect = finite(snapshot.bidDepthQuote ?? snapshot.bid_depth_quote);
  const askDirect = finite(snapshot.askDepthQuote ?? snapshot.ask_depth_quote);
  const bid = bidDirect ?? total(snapshot.bids, 'bid');
  const ask = askDirect ?? total(snapshot.asks, 'ask');
  if (bid === null || ask === null || bid + ask <= 0) return null;
  const bidPrice = finite(snapshot.bidPrice ?? snapshot.bid_price);
  const askPrice = finite(snapshot.askPrice ?? snapshot.ask_price);
  const spreadBps = bidPrice !== null && askPrice !== null && askPrice >= bidPrice
    ? ((askPrice - bidPrice) / midPrice) * 10000
    : finite(snapshot.spreadBps ?? snapshot.spread_bps);
  return {
    imbalance: (bid - ask) / (bid + ask),
    spreadBps: spreadBps === null ? 0 : spreadBps
  };
}

export function calculateVolumeProfile(candles, { bins = 12, valueAreaFraction = 0.70 } = {}) {
  const rows = (Array.isArray(candles) ? candles : [])
    .filter(row => validClosedCandle(row))
    .slice(-48);
  if (!rows.length) return { available: false, poc: null, value_area_low: null, value_area_high: null };
  const tradePoints = rows.flatMap(row => (Array.isArray(row.aggTrades) ? row.aggTrades : [])
    .map(trade => {
      const price = finite(trade.price);
      const quantity = finite(trade.quantity ?? trade.qty);
      const quote = finite(trade.quoteQty ?? trade.quote_qty) ??
        (price !== null && quantity !== null ? price * quantity : null);
      return price !== null && price > 0 && quote !== null && quote > 0 ? { price, quote } : null;
    }).filter(Boolean)).slice(-100000);
  const tradeCandleCount = rows.filter(row =>
    Array.isArray(row.aggTrades) && row.aggTrades.some(trade => {
      const price=finite(trade.price), quantity=finite(trade.quantity??trade.qty);
      const quote=finite(trade.quoteQty??trade.quote_qty) ??
        (price!==null&&quantity!==null?price*quantity:null);
      return price!==null&&price>0&&quote!==null&&quote>0;
    })).length;
  const tradeCandleCoveragePct = rows.length ? tradeCandleCount / rows.length * 100 : 0;
  // Label a profile as trade-level only when >=80% of its source candles carry
  // actual executed-price records. A handful of trades must not disguise a
  // mostly candle-proxy volume profile.
  const tradeLevelAvailable = tradePoints.length > 0 && tradeCandleCoveragePct >= 80;
  const prices = tradeLevelAvailable
    ? tradePoints.map(trade => trade.price)
    : rows.flatMap(row => [
      candleNumber(row, 'low'), candleNumber(row, 'high'), candleNumber(row, 'close')
    ]).filter(value => value !== null && value > 0);
  const low = Math.min(...prices), high = Math.max(...prices);
  if (!(high >= low) || !(high > 0)) return { available: false, poc: null, value_area_low: null, value_area_high: null };
  const count = Math.max(4, Math.min(32, Math.trunc(Number(bins) || 12)));
  const buckets = Array(count).fill(0);
  const width = Math.max((high - low) / count, high * 1e-8);
  if (tradeLevelAvailable) {
    for (const trade of tradePoints) {
      const index = Math.max(0, Math.min(count - 1, Math.floor((trade.price - low) / width)));
      buckets[index] += trade.quote;
    }
  } else {
    // OHLCV-only fallback: a candle-typical-price volume proxy, not tick-level profile data.
    for (const row of rows) {
      const typical = (candleNumber(row, 'high') + candleNumber(row, 'low') + candleNumber(row, 'close')) / 3;
      const index = Math.max(0, Math.min(count - 1, Math.floor((typical - low) / width)));
      buckets[index] += quoteVolume(row);
    }
  }
  const totalVolume = buckets.reduce((sum, value) => sum + value, 0);
  if (!(totalVolume > 0)) return { available: false, poc: null, value_area_low: null, value_area_high: null };
  let pocIndex = 0;
  for (let i = 1; i < buckets.length; i++) if (buckets[i] > buckets[pocIndex]) pocIndex = i;
  let left = pocIndex, right = pocIndex, accumulated = buckets[pocIndex];
  const target = totalVolume * clamp(Number(valueAreaFraction) || 0.70, 0.5, 0.9);
  while (accumulated < target && (left > 0 || right < count - 1)) {
    const leftVolume = left > 0 ? buckets[left - 1] : -1;
    const rightVolume = right < count - 1 ? buckets[right + 1] : -1;
    if (rightVolume > leftVolume) {
      right++;
      accumulated += buckets[right];
    } else {
      left--;
      accumulated += buckets[left];
    }
  }
  const center = index => low + (index + 0.5) * width;
  return {
    available: true,
    poc: center(pocIndex),
    value_area_low: low + left * width,
    value_area_high: low + (right + 1) * width,
    total_quote_volume: totalVolume,
    trade_candle_count: tradeCandleCount,
    source_candle_count: rows.length,
    trade_candle_coverage_pct: round(tradeCandleCoveragePct, 4),
    source: tradeLevelAvailable ? 'AGG_TRADE_PRICE_LEVELS' : 'CANDLE_TYPICAL_PRICE_PROXY'
  };
}

function aggregateTradeImbalance(candle) {
  const explicitBuy = finite(candle?.aggTradeBuyQuote ?? candle?.agg_trade_buy_quote);
  const explicitSell = finite(candle?.aggTradeSellQuote ?? candle?.agg_trade_sell_quote);
  if (explicitBuy !== null && explicitSell !== null && explicitBuy + explicitSell > 0) {
    return (explicitBuy - explicitSell) / (explicitBuy + explicitSell);
  }
  const trades = Array.isArray(candle?.aggTrades) ? candle.aggTrades : [];
  if (!trades.length) return null;
  let buy = 0, sell = 0;
  for (const trade of trades) {
    const price = finite(trade.price);
    const quantity = finite(trade.quantity ?? trade.qty);
    const quote = finite(trade.quoteQty ?? trade.quote_qty) ??
      (price !== null && quantity !== null ? price * quantity : null);
    if (quote === null || quote <= 0) continue;
    if (trade.isBuyerMaker === true || trade.buyer_maker === true) sell += quote;
    else buy += quote;
  }
  return buy + sell > 0 ? (buy - sell) / (buy + sell) : null;
}

function realizedVolatility(returns) {
  if (returns.length < 2) return 0;
  const average = mean(returns);
  const variance = mean(returns.map(value => (value - average) ** 2));
  return Math.sqrt(Math.max(0, variance ?? 0));
}

export function calculateKamaEfficiencyRatio(candles, { period = 10 } = {}) {
  const window = Math.max(2, Math.min(50, Math.trunc(Number(period) || 10)));
  const rows = (Array.isArray(candles) ? candles : []).filter(row => validClosedCandle(row)).slice(-(window + 1));
  if (rows.length < window + 1) return null;
  const closes = rows.map(row => candleNumber(row, 'close'));
  if (closes.some(value => !(value > 0))) return null;
  let pathLength = 0;
  for (let index = 1; index < closes.length; index++) pathLength += Math.abs(closes[index] - closes[index - 1]);
  if (pathLength <= EPS) return 0;
  return round(clamp(Math.abs(closes.at(-1) - closes[0]) / pathLength, 0, 1), 8);
}

function rollingVolatilityZScore(candles, endIndex, currentVolatility, {
  returnsWindow = 6, historyWindow = 24, minimumHistory = 6
} = {}) {
  const history = [];
  const firstEnd = Math.max(returnsWindow, endIndex - historyWindow);
  for (let end = firstEnd; end < endIndex; end++) {
    const sample = candles.slice(end - returnsWindow, end + 1);
    if (sample.length !== returnsWindow + 1) continue;
    const returns = sample.slice(1).map((row, index) =>
      logReturn(candleNumber(row, 'close'), candleNumber(sample[index], 'close')));
    if (returns.every(value => finite(value) !== null)) history.push(realizedVolatility(returns));
  }
  if (history.length < minimumHistory || finite(currentVolatility) === null) return null;
  const baselineMean = mean(history) ?? 0;
  const baselineStd = realizedVolatility(history);
  if (baselineStd <= 1e-10) return currentVolatility >= baselineMean ? 0 : -4;
  return round(clamp((currentVolatility - baselineMean) / baselineStd, -4, 4), 6);
}

export function evaluateHybridMarketGates(row, {
  minimumKamaEfficiencyRatio = 0.20,
  minimumVolatilityZScore = 0,
  btcCountertrendPenaltyPerPct = 0.12
} = {}) {
  const kama = finite(row?.kama_efficiency_ratio) ?? finite(row?.sequence?.at(-1)?.[HYBRID_SEQUENCE_CHANNELS - 1]);
  const volatilityZ = finite(row?.volatility_zscore);
  const btcTrend = finite(row?.btc_trend_return_pct);
  const kamaAvailable = kama !== null && kama >= 0 && kama <= 1;
  const volatilityAvailable = volatilityZ !== null;
  const btcAvailable = btcTrend !== null;
  const kamaPass = kamaAvailable && kama >= minimumKamaEfficiencyRatio;
  const volatilityPass = volatilityAvailable && volatilityZ >= minimumVolatilityZScore;
  const btcPenaltyFactor = btcAvailable
    ? Math.exp(-Math.max(0, Number(btcCountertrendPenaltyPerPct) || 0) * Math.max(0, -btcTrend))
    : 0;
  const eligible = kamaPass && volatilityPass && btcAvailable;
  return {
    eligible,
    reason: !kamaAvailable ? 'KAMA_EFFICIENCY_UNAVAILABLE' : !kamaPass ? 'KAMA_EFFICIENCY_BELOW_MINIMUM' :
      !volatilityAvailable ? 'VOLATILITY_ZSCORE_UNAVAILABLE' : !volatilityPass ? 'VOLATILITY_BELOW_ROLLING_MEAN' :
        !btcAvailable ? 'BTC_TREND_UNAVAILABLE' : null,
    kama_efficiency_ratio: kama,
    kama_pass: kamaPass,
    volatility_zscore: volatilityZ,
    volatility_pass: volatilityPass,
    btc_trend_return_pct: btcTrend,
    btc_countertrend_penalty_factor: round(btcPenaltyFactor, 8)
  };
}

/**
 * Build a strictly causal 24 x 23 feature tensor from completed Binance Spot
 * candles. Optional book and aggregate-trade fields are consumed only when
 * they are attached to their matching closed candle; absent feeds are masked.
 */
export function buildHybridSequence({
  candles = [], benchmarkCandles = [], asOf = Date.now(), sequenceSteps = HYBRID_SEQUENCE_STEPS
} = {}) {
  const cutoff = finite(asOf) ?? Date.now();
  const steps = Math.max(8, Math.min(64, Math.trunc(Number(sequenceSteps) || HYBRID_SEQUENCE_STEPS)));
  const clean = (Array.isArray(candles) ? candles : [])
    .filter(row => validClosedCandle(row, cutoff))
    .sort((a, b) => candleTime(a) - candleTime(b));
  if (clean.length < steps) return {
    ready: false, reason: 'INSUFFICIENT_CLOSED_CANDLES',
    required_candles: steps, available_candles: clean.length, sequence: null
  };
  const benchmark = (Array.isArray(benchmarkCandles) ? benchmarkCandles : [])
    .filter(row => validClosedCandle(row, cutoff))
    .sort((a, b) => candleTime(a) - candleTime(b));
  const selected = clean.slice(-steps);
  const sequenceTimestamps = selected.map(candleTime);
  if (sequenceTimestamps.some(value=>!Number.isFinite(value))) return {
    ready:false,reason:'TEMPORAL_SEQUENCE_TIMESTAMP_NON_FINITE',
    required_candles:steps,available_candles:selected.length,sequence:null,sequence_timestamps:null
  };
  if (sequenceTimestamps.at(-1)!==cutoff) return {
    ready:false,reason:'TEMPORAL_SEQUENCE_LAST_CLOSE_DIFFERS_FROM_DECISION',
    expected_decision_at:cutoff,observed_last_close_at:sequenceTimestamps.at(-1),
    sequence:null,sequence_timestamps:sequenceTimestamps
  };
  for(let index=1;index<sequenceTimestamps.length;index++){
    if(sequenceTimestamps[index]-sequenceTimestamps[index-1]!==HYBRID_CANDLE_INTERVAL_MS)
      return {ready:false,reason:'TEMPORAL_SEQUENCE_CADENCE_GAP_OR_REORDER',
        invalid_step:index,sequence:null,sequence_timestamps:sequenceTimestamps};
  }
  const sequence = [];
  let latestKamaEfficiencyRatio = null;
  let latestVolatilityZScore = null;
  let latestBtcTrendReturnPct = null;
  for (let index = clean.length - steps; index < clean.length; index++) {
    const current = clean[index];
    const close = candleNumber(current, 'close');
    const open = candleNumber(current, 'open');
    const high = candleNumber(current, 'high');
    const low = candleNumber(current, 'low');
    const range = Math.max(high - low, close * 1e-8);
    const closeTime = candleTime(current);
    const prior = clean.slice(Math.max(0, index - 23), index + 1);
    const priorVolumes = prior.slice(0, -1).map(quoteVolume).filter(value => value > 0);
    const priorTrades = prior.slice(0, -1).map(tradeCount).filter(value => value > 0);
    const volumeBaseline = priorVolumes.length ? mean(priorVolumes) : quoteVolume(current);
    const tradesBaseline = priorTrades.length ? mean(priorTrades) : tradeCount(current);
    const volumeRatio = safeRatio(quoteVolume(current), volumeBaseline || quoteVolume(current));
    const tradesRatio = safeRatio(tradeCount(current), tradesBaseline || tradeCount(current));
    const takerBuyQuote = finite(current.takerBuyQuoteVolume ?? current.taker_buy_quote_volume);
    const totalQuote = quoteVolume(current);
    const takerShare = takerBuyQuote !== null && totalQuote > 0 ? takerBuyQuote / totalQuote : null;
    const depth = depthTotals(current.orderBook ?? current.order_book ?? current.depth, close);
    const aggImbalance = aggregateTradeImbalance(current);
    const volumeProfile = calculateVolumeProfile(prior);
    const closeLocation = clamp((close - low) / range, 0, 1);
    const upperWick = Math.max(0, high - Math.max(open, close)) / range;
    const lowerWick = Math.max(0, Math.min(open, close) - low) / range;
    const returnSeries = prior.slice(1).map((row, i) =>
      logReturn(candleNumber(row, 'close'), candleNumber(prior[i], 'close')));
    const shortVol = realizedVolatility(returnSeries.slice(-6));
    const baseVol = realizedVolatility(returnSeries.slice(-20));
    const adaptiveVol = baseVol > 1e-10 ? shortVol / baseVol : 0;
    const kamaEfficiencyRatio = calculateKamaEfficiencyRatio(prior, { period: 10 });
    const volatilityZScore = rollingVolatilityZScore(clean, index, shortVol);
    const benchmarkIndex = benchmark.findLastIndex(row => candleTime(row) === closeTime);
    const priorSymbolOpenTime = index > 0 ? finite(clean[index - 1].openTime) : null;
    const candleIntervalMs = Math.max(1, priorSymbolOpenTime !== null
      ? (finite(current.openTime) ?? closeTime) - priorSymbolOpenTime
      : (finite(current.closeTime) ?? closeTime) - (finite(current.openTime) ?? closeTime) + 1);
    const priorBenchmarkMatches = benchmarkIndex > 0 &&
      candleTime(benchmark[benchmarkIndex - 1]) === closeTime - candleIntervalMs;
    const relativeBtc = priorBenchmarkMatches
      ? logReturn(candleNumber(benchmark[benchmarkIndex], 'close'),
        candleNumber(benchmark[benchmarkIndex - 1], 'close'))
      : 0;
    let btcTrendReturnPct = null;
    if (benchmarkIndex >= 12 && priorBenchmarkMatches) {
      const trendStartIndex = benchmarkIndex - 12;
      const hasContiguousBtcTrend = Array.from({ length: 12 }, (_, offset) => offset + 1)
        .every(offset => candleTime(benchmark[benchmarkIndex - offset]) === closeTime - offset * candleIntervalMs);
      if (hasContiguousBtcTrend) {
        btcTrendReturnPct = round(logReturn(candleNumber(benchmark[benchmarkIndex], 'close'),
          candleNumber(benchmark[trendStartIndex], 'close')) * 100, 6);
      }
    }
    const oneBarReturn = logReturn(close, candleNumber(prior.at(-2), 'close'));
    const previousOneBarReturn = logReturn(
      candleNumber(prior.at(-2), 'close'), candleNumber(prior.at(-3), 'close'));
    const recentThreeBarReturn = logReturn(close, candleNumber(prior.at(-4), 'close'));
    const precedingThreeBarReturn = logReturn(
      candleNumber(prior.at(-4), 'close'), candleNumber(prior.at(-7), 'close'));
    const fastMeanClose = mean(prior.slice(-3).map(row => candleNumber(row, 'close')).filter(value => value !== null));
    const slowMeanClose = mean(prior.slice(-12).map(row => candleNumber(row, 'close')).filter(value => value !== null));
    const previousRange = prior.slice(-4, -1);
    const previousRangeLow = previousRange.length
      ? Math.min(...previousRange.map(row => candleNumber(row, 'low')).filter(value => value !== null)) : low;
    const previousRangeHigh = previousRange.length
      ? Math.max(...previousRange.map(row => candleNumber(row, 'high')).filter(value => value !== null)) : high;
    const pocDistance = volumeProfile.available && volumeProfile.poc > 0
      ? ((close / volumeProfile.poc) - 1) * 100
      : 0;
    const vaRange = volumeProfile.value_area_high - volumeProfile.value_area_low;
    const valueAreaPosition = volumeProfile.available && vaRange > 0
      ? clamp(((close - volumeProfile.value_area_low) / vaRange) * 2 - 1, -2, 2)
      : 0;
    const rawFeatures = [
      logReturn(close, candleNumber(prior.at(-2), 'close')) * 100,
      logReturn(close, candleNumber(prior.at(-4), 'close')) * 100,
      logReturn(close, candleNumber(prior.at(-13), 'close')) * 100,
      ((close - open) / open) * 100,
      (range / close) * 100,
      (closeLocation - 0.5) * 2,
      upperWick,
      lowerWick,
      Math.log(Math.max(0.05, volumeRatio)),
      Math.log(Math.max(0.05, tradesRatio)),
      takerShare === null ? 0 : (takerShare - 0.5) * 2,
      aggImbalance ?? 0,
      depth?.imbalance ?? 0,
      depth ? clamp(depth.spreadBps / 25, 0, 4) : 0,
      pocDistance,
      valueAreaPosition,
      shortVol * 100,
      adaptiveVol,
      relativeBtc * 100,
      depth ? 1 : 0,
      aggImbalance === null ? 0 : 1,
      volumeProfile.source === 'AGG_TRADE_PRICE_LEVELS' ? 1 : 0,
      priorBenchmarkMatches ? 1 : 0,
      (oneBarReturn - previousOneBarReturn) * 100,
      (recentThreeBarReturn - precedingThreeBarReturn) * 100,
      fastMeanClose !== null && slowMeanClose > 0 ? ((fastMeanClose / slowMeanClose) - 1) * 100 : 0,
      ((low - previousRangeLow) / close) * 100,
      ((close - previousRangeHigh) / close) * 100,
      kamaEfficiencyRatio ?? 0
    ];
    if(!rawFeatures.every(Number.isFinite))return {
      ready:false,reason:'HYBRID_TEMPORAL_FEATURE_NON_FINITE',
      failed_at:closeTime,failed_feature_indices:rawFeatures.flatMap((value,index)=>
        Number.isFinite(value)?[]:[index]),sequence:null,sequence_timestamps:sequenceTimestamps
    };
    const features=rawFeatures.map(value=>round(clamp(value,-4,4),6));
    latestKamaEfficiencyRatio = kamaEfficiencyRatio;
    latestVolatilityZScore = volatilityZScore;
    latestBtcTrendReturnPct = btcTrendReturnPct;
    sequence.push(features);
  }
  const latestInputAt = candleTime(selected.at(-1));
  return {
    ready: sequence.length === steps && latestInputAt === cutoff &&
      latestKamaEfficiencyRatio !== null && latestVolatilityZScore !== null && latestBtcTrendReturnPct !== null &&
      sequence.every(row => row.length === HYBRID_SEQUENCE_CHANNELS && row.every(Number.isFinite)),
    reason: null,
    sequence_steps: steps,
    sequence_channels: HYBRID_SEQUENCE_CHANNELS,
    latest_input_at: latestInputAt,
    sequence_timestamps:sequenceTimestamps,
    interval_ms:HYBRID_CANDLE_INTERVAL_MS,
    feature_information_cutoff_at:cutoff,
    as_of: cutoff,
    feature_names: [...HYBRID_FEATURE_NAMES],
    kama_efficiency_ratio: latestKamaEfficiencyRatio,
    volatility_zscore: latestVolatilityZScore,
    btc_trend_return_pct: latestBtcTrendReturnPct,
    sequence
  };
}

/** Resolve a long-only Spot bracket conservatively from completed future candles. */
export function resolveBarrierTrade({
  entryPrice, decisionAt, futureCandles = [], takeProfitPct = 3, stopLossPct = 2,
  horizonMs = HYBRID_OUTCOME_HORIZON_MS,
  candleIntervalMs = HYBRID_CANDLE_INTERVAL_MS,
  feeBpsPerSide = 10, slippageBpsPerSide = 5
} = {}) {
  const entry = finite(entryPrice);
  const at = finite(decisionAt);
  if (!(entry > 0) || at === null) throw new Error('INVALID_BARRIER_TRADE_ENTRY');
  const take = entry * (1 + Math.max(0.01, Number(takeProfitPct) || 3) / 100);
  const stop = entry * (1 - Math.max(0.01, Number(stopLossPct) || 2) / 100);
  const horizon=Math.max(1,Math.trunc(Number(horizonMs)||HYBRID_OUTCOME_HORIZON_MS));
  const interval=Math.max(1,Math.trunc(Number(candleIntervalMs)||HYBRID_CANDLE_INTERVAL_MS));
  if(horizon%interval!==0)
    throw new TypeError('HYBRID_OUTCOME_HORIZON_NOT_DIVISIBLE_BY_CANDLE_INTERVAL');
  const horizonEnd = at + horizon;
  const path = (Array.isArray(futureCandles) ? futureCandles : [])
    .filter(row => validClosedCandle(row) && candleTime(row) > at && candleTime(row) <= horizonEnd)
    .sort((a, b) => candleTime(a) - candleTime(b));
  if (!path.length) return { resolved: false, reason: 'NO_CLOSED_FUTURE_CANDLES' };
  let exitPrice = null, exitAt = null, exitReason = null;
  let expectedTimestamp=at+interval;
  for (const candle of path) {
    const observedTimestamp=candleTime(candle);
    if(observedTimestamp!==expectedTimestamp)
      return {resolved:false,reason:'GAPPED_OR_MISALIGNED_FORWARD_HORIZON',
        expected_timestamp:expectedTimestamp,observed_timestamp:observedTimestamp,
        interval_ms:interval,horizon_end:horizonEnd};
    const open = candleNumber(candle, 'open');
    const high = candleNumber(candle, 'high');
    const low = candleNumber(candle, 'low');
    const hitStop = low <= stop;
    const hitTake = high >= take;
    if (hitStop && hitTake) {
      // Ambiguous OHLC ordering is resolved against the strategy, never in its favour.
      exitPrice = open <= stop ? open : stop;
      exitReason = 'STOP_FIRST_SAME_CANDLE_AMBIGUITY';
      exitAt = candleTime(candle);
      break;
    }
    if (hitStop) {
      exitPrice = open <= stop ? open : stop;
      exitReason = 'STOP_LOSS';
      exitAt = candleTime(candle);
      break;
    }
    if (hitTake) {
      exitPrice = open >= take ? open : take;
      exitReason = 'TAKE_PROFIT';
      exitAt = candleTime(candle);
      break;
    }
    expectedTimestamp+=interval;
  }
  if (exitPrice === null) {
    const last = path.at(-1);
    if (candleTime(last) < horizonEnd) {
      return { resolved: false, reason: 'INCOMPLETE_FORWARD_HORIZON',
        required_through: horizonEnd, observed_through: candleTime(last) };
    }
    exitPrice = candleNumber(last, 'close');
    exitAt = candleTime(last);
    exitReason = 'HORIZON_CLOSE';
  }
  const grossReturnPct = (exitPrice / entry - 1) * 100;
  const executedPath=path.filter(candle=>candleTime(candle)<=exitAt);
  const adverseCandle=executedPath.reduce((worst,candle)=>
    !worst||candleNumber(candle,'low')<candleNumber(worst,'low')?candle:worst,null);
  const adversePrice=exitReason==='STOP_LOSS'||exitReason==='STOP_FIRST_SAME_CANDLE_AMBIGUITY'
    ?exitPrice
    :(adverseCandle?candleNumber(adverseCandle,'low'):entry);
  const maxAdverseExcursionPct=(adversePrice/entry-1)*100;
  const maxAdverseExcursionAt=exitReason==='STOP_LOSS'||exitReason==='STOP_FIRST_SAME_CANDLE_AMBIGUITY'
    ?exitAt:(adverseCandle?candleTime(adverseCandle):at);

  // A stop-first same-candle ambiguity cannot claim a favourable intrabar high
  // from that exit candle. Prior closed candles and the final candle open remain
  // observable before a gap/stop exit.
  const favourablePath=(exitReason==='STOP_LOSS'||exitReason==='STOP_FIRST_SAME_CANDLE_AMBIGUITY')
    ?executedPath.slice(0,-1):executedPath;
  let favourablePrice=entry, maxFavorableExcursionAt=at;
  for(const candle of favourablePath){
    const high=candleNumber(candle,'high');
    if(high>favourablePrice){
      favourablePrice=high;
      maxFavorableExcursionAt=candleTime(candle);
    }
  }
  if(exitReason==='STOP_LOSS'||exitReason==='STOP_FIRST_SAME_CANDLE_AMBIGUITY'){
    const lastOpen=executedPath.length?candleNumber(executedPath.at(-1),'open'):entry;
    if(lastOpen>favourablePrice){
      favourablePrice=lastOpen;
      maxFavorableExcursionAt=exitAt;
    }
  }
  if(exitReason==='TAKE_PROFIT'){
    favourablePrice=exitPrice;
    maxFavorableExcursionAt=exitAt;
  }
  const maxFavorableExcursionPct=Math.max(0,(favourablePrice/entry-1)*100);
  const roundTripCostBps = 2 * (Math.max(0, Number(feeBpsPerSide) || 0) +
    Math.max(0, Number(slippageBpsPerSide) || 0));
  return {
    resolved: true,
    entry_price: entry,
    exit_price: exitPrice,
    entry_at: at,
    exit_at: exitAt,
    exit_reason: exitReason,
    gross_return_pct: round(grossReturnPct, 6),
    max_adverse_excursion_pct: round(maxAdverseExcursionPct, 6),
    max_adverse_excursion_at: maxAdverseExcursionAt,
    max_favorable_excursion_pct: round(maxFavorableExcursionPct, 6),
    max_favorable_excursion_at: maxFavorableExcursionAt,
    round_trip_cost_bps: round(roundTripCostBps, 4),
    net_return_pct: round(grossReturnPct - roundTripCostBps / 100, 6),
    conservative_same_candle_rule: true
  };
}

 
/** Compose a benchmark row from a decision-time closed-candle window and its
 * fully matured 4-hour forward path. The neural tensor ends at decisionAt. */
export function prepareHybridBenchmarkEvent({
  id, symbol, decisionAt, candles = [], benchmarkCandles = [],
  futureCandles = [], entryPrice, classicScore, featureSnapshotSha = null
} = {}) {
  const at = finite(decisionAt);
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  const score = finite(classicScore);
  if (at === null || !/^[A-Z0-9]{1,26}USDT$/.test(normalizedSymbol) ||
      score === null || score < 0 || score > 1) {
    return { ready: false, reason: 'INVALID_SPOT_DECISION_METADATA' };
  }
  const features = buildHybridSequence({ candles, benchmarkCandles, asOf: at });
  if (features.ready !== true) return { ready: false, reason: features.reason || 'FEATURE_TENSOR_NOT_READY' };
  const outcome = resolveBarrierTrade({
    entryPrice, decisionAt: at, futureCandles, horizonMs: 4 * 60 * 60 * 1000
  });
  if (outcome.resolved !== true) return { ready: false, reason: outcome.reason, outcome };
  if(outcome.exit_reason==='STOP_FIRST_SAME_CANDLE_AMBIGUITY')
    return {ready:false,reason:'AMBIGUOUS_FIRST_TOUCH_WITHIN_ONE_CANDLE',outcome};
  const firstTouchOutcome=outcome.exit_reason==='TAKE_PROFIT'?'UP':
    outcome.exit_reason==='STOP_LOSS'?'DOWN':
    outcome.exit_reason==='HORIZON_END'?'FLAT':null;
  if(!firstTouchOutcome)return {ready:false,reason:'FIRST_TOUCH_OUTCOME_NOT_RECOGNIZED',outcome};
  return {
    ready: true,
    row: {
      id: String(id ?? normalizedSymbol + ':' + at),
      symbol: normalizedSymbol,
      market: 'BINANCE_SPOT_USDT',
      outcome_source: 'BINANCE_SPOT_CLOSED_15M',
      at,
      latest_input_at: features.latest_input_at,
      resolved_at: outcome.exit_at,
      maturity_ms:outcome.exit_at-at,
      outcome_horizon_ms:HYBRID_OUTCOME_HORIZON_MS,
      gross_return_pct: outcome.gross_return_pct,
      max_adverse_excursion_pct: outcome.max_adverse_excursion_pct,
      max_adverse_excursion_at: outcome.max_adverse_excursion_at,
      max_favorable_excursion_pct: outcome.max_favorable_excursion_pct,
      max_favorable_excursion_at: outcome.max_favorable_excursion_at,
      classic_score: score,
      kama_efficiency_ratio: features.kama_efficiency_ratio,
      volatility_zscore: features.volatility_zscore,
      btc_trend_return_pct: features.btc_trend_return_pct,
      outcome_definition: DEFAULT_TARGET_DEFINITION,
      outcome:firstTouchOutcome,
      target:firstTouchOutcome==='UP'?1:0,
      sequence: features.sequence,
      sequence_timestamps:features.sequence_timestamps,
      feature_information_cutoff_at:features.feature_information_cutoff_at,
      feature_snapshot_sha: typeof featureSnapshotSha === 'string' ? featureSnapshotSha : null,
      outcome_exit_reason: outcome.exit_reason
    }
  };
}

function normalizeBenchmarkRows(inputRows, targetDefinition=DEFAULT_TARGET_DEFINITION) {
  const ids = new Set(), events = new Set();
  const rows = [];
  for (const raw of Array.isArray(inputRows) ? inputRows : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    const symbol = String(raw.symbol ?? '').trim().toUpperCase();
    const market = String(raw.market ?? '').trim().toUpperCase();
    const outcomeSource = String(raw.outcome_source ?? '').trim().toUpperCase();
    const rowTargetDefinition=String(raw.outcome_definition??'').trim();
    const marketRegime=String(raw.market_regime??'').trim().toUpperCase();
    const historicalWindowId=String(raw.historical_window_id??'').trim();
    const exitReason=String(raw.outcome_exit_reason??'').trim().toUpperCase();
    const firstTouchOutcome=['UP','DOWN','FLAT'].includes(raw.outcome)?raw.outcome:
      exitReason==='TAKE_PROFIT'?'UP':
      exitReason==='STOP_LOSS'?'DOWN':
      exitReason==='HORIZON_END'?'FLAT':null;
    const firstTouchTarget=firstTouchOutcome==='UP'?1:0;
    const at = finite(raw.at);
    const latestInputAt = finite(raw.latest_input_at);
    const resolvedAt = finite(raw.resolved_at);
    const maturityMs = finite(raw.maturity_ms);
    const outcomeHorizonMs = finite(raw.outcome_horizon_ms);
    const gross = finite(raw.gross_return_pct);
    const adverse = finite(raw.max_adverse_excursion_pct);
    const adverseAt = finite(raw.max_adverse_excursion_at);
    const favourable = finite(raw.max_favorable_excursion_pct);
    const favourableAt = finite(raw.max_favorable_excursion_at);
    const classic = finite(raw.classic_score);
    const sequence = raw.sequence;
    const sequenceTimestamps=raw.sequence_timestamps;
    const expectedSequenceIntervalMs=outcomeSource==='BINANCE_SPOT_CLOSED_1M_REPLAY'
      ?HYBRID_REPLAY_CANDLE_INTERVAL_MS:HYBRID_CANDLE_INTERVAL_MS;
    const temporalAlignment=validateTemporalSequenceAlignment({
      id,symbol,at,resolved_at:resolvedAt,horizon_ms:maturityMs,
      temporal_sequence:sequence,temporal_sequence_timestamps:sequenceTimestamps,
      feature_information_cutoff_at:latestInputAt,
      expectedSteps:HYBRID_SEQUENCE_STEPS,expectedChannels:HYBRID_SEQUENCE_CHANNELS,
      intervalMs:expectedSequenceIntervalMs,requireSequenceTimestamps:true,
      binaryMaskChannels:[]
    });
    const kamaEfficiencyRatio = finite(raw.kama_efficiency_ratio) ?? finite(sequence?.at(-1)?.[HYBRID_SEQUENCE_CHANNELS - 1]);
    const volatilityZScore = finite(raw.volatility_zscore);
    const btcTrendReturnPct = finite(raw.btc_trend_return_pct);
    if (!temporalAlignment.valid ||
        !id || !/^[A-Z0-9]{1,26}USDT$/.test(symbol) ||
        market !== 'BINANCE_SPOT_USDT' ||
        !['BINANCE_SPOT_CLOSED_1M_REPLAY','BINANCE_SPOT_CLOSED_15M'].includes(outcomeSource) ||
        rowTargetDefinition!==targetDefinition ||
        !['UP','DOWN','FLAT'].includes(firstTouchOutcome) ||
        (raw.target!==undefined&&Number(raw.target)!==firstTouchTarget) ||
        !REQUIRED_MARKET_REGIMES.includes(marketRegime) ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(historicalWindowId) ||
        at === null || latestInputAt === null || latestInputAt !== at ||
        resolvedAt === null || resolvedAt <= at || maturityMs !== resolvedAt-at ||
        outcomeHorizonMs !== HYBRID_OUTCOME_HORIZON_MS || gross === null ||
        adverse === null || adverse < -100 ||
        adverseAt === null || adverseAt < at || adverseAt > resolvedAt ||
        favourable === null || favourable < 0 || favourable > 1000 ||
        favourableAt === null || favourableAt < at || favourableAt > resolvedAt || classic === null ||
        classic < 0 || classic > 1 || kamaEfficiencyRatio === null || kamaEfficiencyRatio < 0 || kamaEfficiencyRatio > 1 ||
        volatilityZScore === null || btcTrendReturnPct === null ||
        !Array.isArray(sequence) || sequence.length !== HYBRID_SEQUENCE_STEPS ||
        !sequence.every(step => Array.isArray(step) && step.length === HYBRID_SEQUENCE_CHANNELS &&
          step.every(value => finite(value) !== null && Math.abs(Number(value)) <= 4))) continue;
    const eventKey = symbol + ':' + Math.trunc(at);
    if (ids.has(id) || events.has(eventKey)) continue;
    ids.add(id);
    events.add(eventKey);
    rows.push({
      id, symbol, market, outcome_source: outcomeSource,
      market_regime:marketRegime,historical_window_id:historicalWindowId,
      at, latest_input_at: latestInputAt, resolved_at: resolvedAt,
      maturity_ms:maturityMs,outcome_horizon_ms:outcomeHorizonMs,
      sequence_timestamps:sequenceTimestamps.map(Number),
      gross_return_pct: gross,
      max_adverse_excursion_pct:Math.min(0, adverse),
      max_adverse_excursion_at:adverseAt,
      max_favorable_excursion_pct:favourable,
      max_favorable_excursion_at:favourableAt,
      classic_score: classic,
      kama_efficiency_ratio: kamaEfficiencyRatio,
      volatility_zscore: volatilityZScore,
      btc_trend_return_pct: btcTrendReturnPct,
      outcome_definition:rowTargetDefinition,
      outcome:firstTouchOutcome,target:firstTouchTarget,
      sequence: sequence.map(step => step.map(Number)),
      feature_snapshot_sha: typeof raw.feature_snapshot_sha === 'string' ? raw.feature_snapshot_sha : null
    });
  }
  return rows.sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
}

/**
 * Build expanding-window folds. Each training/selection label must have fully
 * matured before the next boundary minus the full horizon/embargo.
 */
export function buildPurgedWalkForwardFolds(inputRows, {
  folds = 5, minimumTrainTimes = 160, minimumTrainRows = 100,
  minimumValidationRows = 30, minimumTestRows = 30,
  embargoMs = 4 * 60 * 60 * 1000
} = {}) {
  const rows = normalizeBenchmarkRows(inputRows);
  const times = [...new Set(rows.map(row => row.at))].sort((a, b) => a - b);
  const count = Math.max(2, Math.min(10, Math.trunc(Number(folds) || 5)));
  const minimumTrain = Math.max(20, Math.trunc(Number(minimumTrainTimes) || 160));
  const minimumTrainSampleCount = Math.max(20, Math.trunc(Number(minimumTrainRows) || 100));
  const block = Math.floor((times.length - minimumTrain) / (count + 1));
  if (block <= 0) {
    return {
      status: 'INSUFFICIENT_WALK_FORWARD_COVERAGE',
      reason: 'NOT_ENOUGH_DISTINCT_DECISION_TIMES_FOR_REQUESTED_FOLDS',
      distinct_times: times.length, required_initial_train_times: minimumTrain,
      required_validation_rows: minimumValidationRows, required_test_rows: minimumTestRows,
      folds: []
    };
  }
  const initialTrain = times.length - (count + 1) * block;
  const embargo = Math.max(0, Math.trunc(Number(embargoMs) || 0));
  const result = [];
  for (let index = 0; index < count; index++) {
    const validationStartIndex = initialTrain + index * block;
    const validationEndIndex = validationStartIndex + block;
    const testStartIndex = validationEndIndex;
    const testEndIndex = Math.min(times.length, testStartIndex + block);
    const validationStart = times[validationStartIndex];
    const validationEnd = times[validationEndIndex - 1];
    const testStart = times[testStartIndex];
    const testEnd = times[testEndIndex - 1];
    // Purge every label that has not matured by the next boundary. The embargo
    // is applied to decision timestamps in the earlier block, not subtracted
    // a second time from resolved_at (which would double-count the outcome horizon).
    const train = rows.filter(row => row.at < validationStart - embargo && row.resolved_at < validationStart);
    const validation = rows.filter(row => row.at >= validationStart && row.at <= validationEnd &&
      row.resolved_at < testStart);
    const test = rows.filter(row => row.at >= testStart && row.at <= testEnd);
    const maxTrainResolvedAt = train.length ? Math.max(...train.map(row => row.resolved_at)) : null;
    const maxValidationResolvedAt = validation.length ? Math.max(...validation.map(row => row.resolved_at)) : null;
    const valid = train.length >= minimumTrainSampleCount && validation.length >= minimumValidationRows &&
      test.length >= minimumTestRows && maxTrainResolvedAt < validationStart &&
      maxValidationResolvedAt < testStart;
    result.push({
      fold: index + 1,
      status: valid ? 'READY' : 'INSUFFICIENT_AFTER_PURGE',
      train, validation, test,
      boundaries: {
        train_end_exclusive: validationStart,
        validation_start: validationStart,
        validation_end_inclusive: validationEnd,
        test_start: testStart,
        test_end_inclusive: testEnd,
        embargo_ms: embargo
      },
      train_count: train.length,
      minimum_train_rows: minimumTrainSampleCount,
      validation_count: validation.length,
      test_count: test.length,
      purged_training_rows: rows.filter(row => row.at < validationStart &&
        (row.at >= validationStart - embargo || row.resolved_at >= validationStart)).length,
      purged_validation_rows: rows.filter(row => row.at >= validationStart &&
        row.at <= validationEnd && row.resolved_at >= testStart).length,
      max_training_outcome_resolved_at: maxTrainResolvedAt,
      max_validation_outcome_resolved_at: maxValidationResolvedAt
    });
  }
  const ready = result.length === count && result.every(row => row.status === 'READY');
  return {
    status: ready ? 'READY' : 'INSUFFICIENT_WALK_FORWARD_COVERAGE',
    fold_count: result.length, distinct_times: times.length, initial_train_times: initialTrain,
    test_blocks_non_overlapping: result.every((row, index) =>
      index === 0 || result[index - 1].boundaries.test_end_inclusive < row.boundaries.test_start),
    folds: result
  };
}

function zerosLike(value) {
  if (Array.isArray(value)) return value.map(zerosLike);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, zerosLike(child)]));
  }
  return typeof value === 'number' ? 0 : value;
}
function accumulateTreeInPlace(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
      throw new TypeError('HYBRID_GRADIENT_TREE_SHAPE_MISMATCH');
    for (let index = 0; index < left.length; index++)
      left[index] = accumulateTreeInPlace(left[index], right[index]);
    return left;
  }
  if ((left && typeof left === 'object') || (right && typeof right === 'object')) {
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
      throw new TypeError('HYBRID_GRADIENT_TREE_TYPE_MISMATCH');
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length || leftKeys.some(key => !Object.hasOwn(right, key)))
      throw new TypeError('HYBRID_GRADIENT_TREE_KEYS_MISMATCH');
    for (const key of leftKeys) left[key] = accumulateTreeInPlace(left[key], right[key]);
    return left;
  }
  if (!Number.isFinite(left) || !Number.isFinite(right))
    throw new TypeError('HYBRID_GRADIENT_TREE_NON_FINITE');
  const sum = left + right;
  if (!Number.isFinite(sum)) throw new TypeError('HYBRID_GRADIENT_ACCUMULATION_NON_FINITE');
  return sum;
}

function addTrees(left, right) {
  if (Array.isArray(left)) return left.map((value, index) => addTrees(value, right[index]));
  if (left && typeof left === 'object') {
    return Object.fromEntries(Object.keys(left).map(key => [key, addTrees(left[key], right[key])]));
  }
  return left + right;
}
function scaleTree(tree, factor) {
  if (Array.isArray(tree)) return tree.map(value => scaleTree(value, factor));
  return tree * factor;
}
function deterministicWeight(a, b, seed, scale) {
  return scale * Math.sin((a + 1) * 4.137 + (b + 1) * 2.731 + seed * 0.6180339887);
}
function initializeHybridModel(seed = 17) {
  return {
    inputWeights: Array.from({ length: HYBRID_SEQUENCE_CHANNELS }, (_, input) =>
      Array.from({ length: HIDDEN }, (_, output) => deterministicWeight(input, output, seed, 0.06))),
    inputBias: Array.from({ length: HIDDEN }, (_, index) => deterministicWeight(index, 0, seed + 1, 0.005)),
    depthWeights: DILATIONS.map((_, layer) => Array.from({ length: KERNEL_TAPS }, (_, tap) =>
      Array.from({ length: HIDDEN }, (_, channel) => deterministicWeight(layer * 7 + tap, channel, seed + 2, 0.02)))),
    pointWeights: DILATIONS.map((_, layer) => Array.from({ length: HIDDEN }, (_, input) =>
      Array.from({ length: HIDDEN }, (_, output) => deterministicWeight(layer * 19 + input, output, seed + 3, 0.025)))),
    biases: DILATIONS.map((_, layer) => Array.from({ length: HIDDEN }, (_, channel) =>
      deterministicWeight(layer, channel, seed + 4, 0.002))),
    attentionQuery: Array.from({ length: HIDDEN }, (_, index) => deterministicWeight(index, 0, seed + 5, 0.05)),
    outputWeights: Array.from({ length: HIDDEN }, (_, index) => deterministicWeight(index, 0, seed + 6, 0.04)),
    outputBias: 0,
    logitScaleRaw: 0
  };
}

function softmax(values) {
  const maximum = Math.max(...values);
  const exponents = values.map(value => Math.exp(clamp(value - maximum, -30, 30)));
  const total = exponents.reduce((sum, value) => sum + value, 0) || 1;
  return exponents.map(value => value / total);
}

function fitHybridFeatureNormalization(rows) {
  const means = Array(HYBRID_SEQUENCE_CHANNELS).fill(0);
  const counts = Array(HYBRID_SEQUENCE_CHANNELS).fill(0);
  const m2 = Array(HYBRID_SEQUENCE_CHANNELS).fill(0);
  for (const row of rows) {
    for (const step of row.sequence) {
      for (let channel = 0; channel < HYBRID_SEQUENCE_CHANNELS; channel++) {
        const value = Number(step[channel]);
        counts[channel]++;
        const delta = value - means[channel];
        means[channel] += delta / counts[channel];
        m2[channel] += delta * (value - means[channel]);
      }
    }
  }
  const standardDeviations = means.map((_, channel) => {
    const variance = counts[channel] > 1 ? m2[channel] / counts[channel] : 0;
    return Math.max(0.05, Math.sqrt(Math.max(0, variance)));
  });
  return {
    method: 'TRAIN_FOLD_CHANNEL_ZSCORE_CLIPPED_4',
    sample_count_per_channel: counts,
    means: means.map(value => round(value, 8)),
    standard_deviations: standardDeviations.map(value => round(value, 8))
  };
}

function normalizeHybridSequence(sequence, normalization) {
  if (!normalization || !Array.isArray(normalization.means) ||
      !Array.isArray(normalization.standard_deviations)) return sequence;
  return sequence.map(step => step.map((value, channel) => {
    const meanValue = Number(normalization.means[channel]) || 0;
    const scale = Math.max(0.05, Number(normalization.standard_deviations[channel]) || 1);
    return clamp((Number(value) - meanValue) / scale, -4, 4);
  }));
}

function forwardHybrid(sequence, model) {
  const projected = sequence.map(row => Array.from({ length: HIDDEN }, (_, output) => {
    let value = model.inputBias[output];
    for (let input = 0; input < HYBRID_SEQUENCE_CHANNELS; input++) value += row[input] * model.inputWeights[input][output];
    return leakyRelu(value);
  }));
  const activations = [projected];
  const depthCaches = [];
  for (let layer = 0; layer < DILATIONS.length; layer++) {
    const input = activations[layer], dilation = DILATIONS[layer];
    const depth = input.map((row, time) => row.map((_, channel) => {
      let value = input[time][channel];
      for (let tap = 1; tap <= KERNEL_TAPS; tap++) {
        const previous = time - tap * dilation;
        if (previous >= 0) value += model.depthWeights[layer][tap - 1][channel] * input[previous][channel];
      }
      return value;
    }));
    const output = depth.map((row, time) => row.map((_, outputChannel) => {
      let value = input[time][outputChannel] + model.biases[layer][outputChannel];
      for (let inputChannel = 0; inputChannel < HIDDEN; inputChannel++) {
        value += depth[time][inputChannel] * model.pointWeights[layer][inputChannel][outputChannel];
      }
      return leakyRelu(value);
    }));
    depthCaches.push(depth);
    activations.push(output);
  }
  const final = activations.at(-1);
  const scores = final.map(row => {
    let score = 0;
    for (let channel = 0; channel < HIDDEN; channel++) score += row[channel] * model.attentionQuery[channel];
    return score / Math.sqrt(HIDDEN);
  });
  const attention = softmax(scores);
  const context = Array(HIDDEN).fill(0);
  for (let time = 0; time < final.length; time++) {
    for (let channel = 0; channel < HIDDEN; channel++) context[channel] += attention[time] * final[time][channel];
  }
  let rawLogit = model.outputBias;
  for (let channel = 0; channel < HIDDEN; channel++) rawLogit += context[channel] * model.outputWeights[channel];
  const scaleTanh = Math.tanh(Number(model.logitScaleRaw) || 0);
  const logitScale = Math.exp(Math.log(4) * scaleTanh);
  const logit = rawLogit * logitScale;
  return { probability: sigmoid(logit), logit, rawLogit, logitScale, activations, depthCaches, attention, context, scores };
}

function gradientsForHybrid(sequence, model, cache, dLossDLogit) {
  const gradients = zerosLike(model);
  const final = cache.activations.at(-1);
  const scaledLogitGradient = dLossDLogit * cache.logitScale;
  const contextGradient = model.outputWeights.map(weight => weight * scaledLogitGradient);
  gradients.outputBias = scaledLogitGradient;
  for (let channel = 0; channel < HIDDEN; channel++) {
    gradients.outputWeights[channel] = cache.context[channel] * scaledLogitGradient;
  }
  const scaleTanh = Math.tanh(Number(model.logitScaleRaw) || 0);
  gradients.logitScaleRaw = dLossDLogit * cache.rawLogit * cache.logitScale *
    Math.log(4) * (1 - scaleTanh * scaleTanh);
  const attentionContextProducts = final.map(row =>
    row.reduce((sum, value, channel) => sum + value * model.outputWeights[channel], 0) * scaledLogitGradient);
  const weightedAttentionGradient = cache.attention.reduce((sum, weight, index) =>
    sum + weight * attentionContextProducts[index], 0);
  const finalGradient = final.map((row, time) => {
    const scoreGradient = cache.attention[time] *
      (attentionContextProducts[time] - weightedAttentionGradient);
    for (let channel = 0; channel < HIDDEN; channel++) {
      gradients.attentionQuery[channel] += scoreGradient * row[channel] / Math.sqrt(HIDDEN);
    }
    return row.map((_, channel) =>
      cache.attention[time] * contextGradient[channel] +
      scoreGradient * model.attentionQuery[channel] / Math.sqrt(HIDDEN));
  });

  let activationGradient = finalGradient;
  for (let layer = DILATIONS.length - 1; layer >= 0; layer--) {
    const input = cache.activations[layer], output = cache.activations[layer + 1];
    const depth = cache.depthCaches[layer], dilation = DILATIONS[layer];
    const inputGradient = input.map(() => Array(HIDDEN).fill(0));
    for (let time = 0; time < output.length; time++) {
      for (let outputChannel = 0; outputChannel < HIDDEN; outputChannel++) {
        const activation = output[time][outputChannel];
        const dz = activationGradient[time][outputChannel] * leakyReluDerivative(activation);
        gradients.biases[layer][outputChannel] += dz;
        inputGradient[time][outputChannel] += dz; // residual identity
        for (let inputChannel = 0; inputChannel < HIDDEN; inputChannel++) {
          gradients.pointWeights[layer][inputChannel][outputChannel] += depth[time][inputChannel] * dz;
          const depthGradient = model.pointWeights[layer][inputChannel][outputChannel] * dz;
          inputGradient[time][inputChannel] += depthGradient;
          for (let tap = 1; tap <= KERNEL_TAPS; tap++) {
            const previous = time - tap * dilation;
            if (previous < 0) continue;
            gradients.depthWeights[layer][tap - 1][inputChannel] +=
              input[previous][inputChannel] * depthGradient;
            inputGradient[previous][inputChannel] +=
              model.depthWeights[layer][tap - 1][inputChannel] * depthGradient;
          }
        }
      }
    }
    activationGradient = inputGradient;
  }
  for (let time = 0; time < sequence.length; time++) {
    for (let output = 0; output < HIDDEN; output++) {
      const dz = activationGradient[time][output] *
        leakyReluDerivative(cache.activations[0][time][output]);
      gradients.inputBias[output] += dz;
      for (let input = 0; input < HYBRID_SEQUENCE_CHANNELS; input++) {
        gradients.inputWeights[input][output] += sequence[time][input] * dz;
      }
    }
  }
  return gradients;
}

function adamUpdate(parameters, gradients, optimizer, step, learningRate, l2) {
  const walk = (parameter, gradient, moment, variance) => {
    if (Array.isArray(parameter)) {
      const next = parameter.map((value, index) =>
        walk(value, gradient[index], moment[index], variance[index]));
      return {
        value: next.map(row => row.value),
        moment: next.map(row => row.moment),
        variance: next.map(row => row.variance)
      };
    }
    if (parameter && typeof parameter === 'object') {
      const next = Object.keys(parameter).map(key =>
        [key, walk(parameter[key], gradient[key], moment[key], variance[key])]);
      return {
        value: Object.fromEntries(next.map(([key, row]) => [key, row.value])),
        moment: Object.fromEntries(next.map(([key, row]) => [key, row.moment])),
        variance: Object.fromEntries(next.map(([key, row]) => [key, row.variance]))
      };
    }
    const g = clamp(gradient, -2.5, 2.5);
    const m = 0.9 * moment + 0.1 * g;
    const v = 0.999 * variance + 0.001 * g * g;
    const mHat = m / (1 - 0.9 ** step);
    const vHat = v / (1 - 0.999 ** step);
    const next = clamp(parameter - learningRate *
      (mHat / (Math.sqrt(vHat) + EPS) + l2 * parameter), -3, 3);
    return { value: next, moment: m, variance: v };
  };
  const next = walk(parameters, gradients, optimizer.m, optimizer.v);
  return {
    parameters: next.value,
    optimizer: { m: next.moment, v: next.variance }
  };
}

function netReturnPct(row, costBps) {
  return row.gross_return_pct - costBps / 100;
}

/**
 * Differentiable per-event exposure surrogate. It rewards net return and Sharpe,
 * while penalizing downside semivariance, measured adverse excursion, and
 * peak-to-trough drawdown. The OOS simulator separately enforces real position
 * capacity and event-time mark-to-market. This is not MSE/Brier loss.
 */
export function profitDrawdownObjective(probabilities, rows, {
  roundTripCostBps = DEFAULT_COST_BPS,
  positionFraction = DEFAULT_POSITION_FRACTION,
  threshold = 0.55,
  temperature = 0.10,
  sharpeWeight = 0.30,
  cumulativeGrowthWeight = 0.02,
  enforceMarketGates = false,
  minimumKamaEfficiencyRatio = 0.20,
  minimumVolatilityZScore = 0,
  btcCountertrendPenaltyPerPct = 0.12,
  downsideWeight = 0.08,
  adverseExcursionWeight = 0.04,
  excursionDrawdownWeight = 0.04,
  drawdownWeight = 0.08,
  focalLossWeight = 0.25,
  focalGammaPositive = 1,
  focalGammaNegative = 2,
  focalPositiveWeight = 1,
  focalNegativeWeight = 1.6,
  crossSectionalRankingWeight = 0.15
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(probabilities) ||
      probabilities.length !== rows.length || !rows.length) {
    throw new Error('PROFIT_OBJECTIVE_REQUIRES_MATCHED_NON_EMPTY_ROWS');
  }
  if(probabilities.some(value=>finite(value)===null||Number(value)<0||Number(value)>1))
    throw new TypeError('HYBRID_OBJECTIVE_PROBABILITY_NON_FINITE_OR_OUT_OF_RANGE');
  if(rows.some(row=>!row||finite(row.at)===null||finite(row.gross_return_pct)===null||
      !String(row.symbol||'').trim()))
    throw new TypeError('HYBRID_OBJECTIVE_EVENT_IDENTITY_OR_RETURN_INVALID');
  const cost = Math.max(0, Number(roundTripCostBps) || 0);
  const size = clamp(Number(positionFraction) || DEFAULT_POSITION_FRACTION, 0.01, 1);
  const temp = clamp(Number(temperature) || 0.10, 0.02, 0.5);
  const pairs = rows.map((row, index) => ({
    row, probability: clamp(Number(probabilities[index]), 0.001, 0.999), index
  })).sort((a, b) => a.row.at - b.row.at || a.row.symbol.localeCompare(b.row.symbol));
  const positions = Array(rows.length).fill(0);
  const orderedReturns = Array(rows.length).fill(0);
  const orderedAdverseReturns = Array(rows.length).fill(0);
  const orderedExcursionDrawdowns = Array(rows.length).fill(0);
  const orderedProbabilityDerivative = Array(rows.length).fill(0);
  const focalEligible = Array(rows.length).fill(false);
  const orderedBtcPenaltyFactors = Array(rows.length).fill(1);
  for (let orderedIndex = 0; orderedIndex < pairs.length; orderedIndex++) {
    const pair = pairs[orderedIndex];
    const gates = enforceMarketGates ? evaluateHybridMarketGates(pair.row, {
      minimumKamaEfficiencyRatio, minimumVolatilityZScore, btcCountertrendPenaltyPerPct
    }) : { eligible: true, btc_countertrend_penalty_factor: 1 };
    const penaltyFactor = gates.eligible ? Number(gates.btc_countertrend_penalty_factor ?? 1) : 0;
    const rawAllocation = sigmoid((pair.probability - threshold) / temp);
    const allocation = gates.eligible ? rawAllocation * penaltyFactor : 0;
    orderedBtcPenaltyFactors[orderedIndex] = penaltyFactor;
    // Classification loss must match the executable policy: a row rejected by
    // KAMA/volatility/BTC gates can never become a position, so it must not
    // consume model capacity by generating a conflicting focal-loss gradient.
    focalEligible[pair.index] = gates.eligible === true;
    const net = netReturnPct(pair.row, cost);
    positions[pair.index] = allocation;
    orderedReturns[orderedIndex] = allocation * net * size; // percentage points on total equity
    const adverse = Math.min(0, finite(pair.row.max_adverse_excursion_pct) ?? Math.min(0, net));
    const favourable = Math.max(0, finite(pair.row.max_favorable_excursion_pct) ?? 0);
    orderedAdverseReturns[orderedIndex] = allocation * adverse * size;
    orderedExcursionDrawdowns[orderedIndex] =
      allocation * Math.max(0, favourable - adverse) * size;
    orderedProbabilityDerivative[orderedIndex] = gates.eligible
      ? rawAllocation * (1 - rawAllocation) / temp * penaltyFactor * pair.probability * (1 - pair.probability)
      : 0;
  }
  const portfolioReturns = orderedReturns;
  const n = portfolioReturns.length;
  const average = mean(portfolioReturns) ?? 0;
  const equityLogReturns = portfolioReturns.map(value => Math.log1p(clamp(value / 100, -0.99, 10)));
  const averageLogReturn = mean(equityLogReturns) ?? 0;
  const logVariance = mean(equityLogReturns.map(value => (value - averageLogReturn) ** 2)) ?? 0;
  const logStandardDeviation = Math.sqrt(logVariance + 1e-8);
  const cumulativeEquityFactor = Math.exp(equityLogReturns.reduce((sum, value) => sum + value, 0));
  const geometricFactor = Math.pow(cumulativeEquityFactor, 1 / Math.max(1, n));
  const cumulativeGeometricReturnPct = (geometricFactor - 1) * 100;
  const cumulativeEquitySharpe = averageLogReturn / logStandardDeviation;
  const sharpe = cumulativeEquitySharpe;
  let downsideSquared = 0, adverseSquared = 0, excursionDrawdownSquared = 0;
  let underwaterSquared = 0, cumulative = 0, peak = 0, peakIndex = -1;
  const drawdowns = [], peakIndices = [], drawdownGradient = Array(n).fill(0);
  for (let index = 0; index < n; index++) {
    const value = portfolioReturns[index];
    if (value < 0) downsideSquared += value * value;
    adverseSquared += orderedAdverseReturns[index] ** 2;
    excursionDrawdownSquared += orderedExcursionDrawdowns[index] ** 2;
    cumulative += value;
    if (cumulative > peak) {
      peak = cumulative;
      peakIndex = index;
    }
    const drawdown = Math.max(0, peak - cumulative);
    drawdowns.push(drawdown);
    peakIndices.push(peakIndex);
    underwaterSquared += drawdown * drawdown;
  }
  for (let trough = 0; trough < n; trough++) {
    const dd = drawdowns[trough];
    if (dd <= 0) continue;
    const from = peakIndices[trough] + 1;
    for (let index = from; index <= trough; index++) {
      drawdownGradient[index] -= 2 * drawdownWeight * dd / n;
    }
  }
  const downsideMean = downsideSquared / n;
  const adverseMean = adverseSquared / n;
  const excursionDrawdownMean = excursionDrawdownSquared / n;
  const drawdownMean = underwaterSquared / n;
  const focalWeight = clamp(finite(focalLossWeight) ?? 0.25, 0, 2);
  const gammaPositive = clamp(finite(focalGammaPositive) ?? 1, 0, 5);
  const gammaNegative = clamp(finite(focalGammaNegative) ?? 2, 0, 5);
  const positiveWeight = clamp(finite(focalPositiveWeight) ?? 1, 0.1, 5);
  const negativeWeight = clamp(finite(focalNegativeWeight) ?? 1.6, 0.1, 8);
  let focalLossSum = 0;
  const focalLogitGradients = Array(n).fill(0);
  const focalSampleCount = focalEligible.filter(Boolean).length;
  const focalDenominator = Math.max(1, focalSampleCount);
  for (const pair of pairs) {
    if (!focalEligible[pair.index]) continue;
    const probability = clamp(pair.probability, 0.001, 0.999);
    const positive = netReturnPct(pair.row, cost) > 0;
    const focal = focalAsymmetricBrierLoss(probability,pair.row.target,{
      gammaPositive,gammaNegative,positiveWeight,negativeWeight
    });
    focalLossSum += focal.loss;
    focalLogitGradients[pair.index] = focal.logitGradient / focalDenominator;
  }
  const asymmetricFocalLoss = focalSampleCount ? focalLossSum / focalDenominator : 0;
  // Same-timestamp pairwise ranking: the scanner's task is to rank stronger
  // Spot opportunities above weaker ones in the same market snapshot.
  // Only gate-eligible rows participate; no cross-time pair is constructed.
  const rankingWeight = clamp(finite(crossSectionalRankingWeight) ?? 0.15, 0, 2);
  const byDecisionTime = new Map();
  for (const pair of pairs) {
    if (!focalEligible[pair.index]) continue;
    const key = String(pair.row.at);
    if (!byDecisionTime.has(key)) byDecisionTime.set(key, { positive: [], negative: [] });
    const group = byDecisionTime.get(key);
    (netReturnPct(pair.row, cost) > 0 ? group.positive : group.negative).push(pair);
  }
  const rankingPairs = [];
  for (const group of byDecisionTime.values()) {
    for (const positive of group.positive) {
      for (const negative of group.negative) rankingPairs.push([positive, negative]);
    }
  }
  const rankingPairCount = rankingPairs.length;
  const rankingLogitGradients = Array(n).fill(0);
  let rankingLossSum = 0;
  const rankingDenominator = Math.max(1, rankingPairCount);
  for (const [positive, negative] of rankingPairs) {
    const positiveLogit = Math.log(positive.probability / (1 - positive.probability));
    const negativeLogit = Math.log(negative.probability / (1 - negative.probability));
    const difference = positiveLogit - negativeLogit;
    rankingLossSum += Math.max(0, -difference) + Math.log1p(Math.exp(-Math.abs(difference)));
    const pairGradient = sigmoid(-difference) / rankingDenominator;
    rankingLogitGradients[positive.index] -= pairGradient;
    rankingLogitGradients[negative.index] += pairGradient;
  }
  const crossSectionalRankingLoss = rankingPairCount ? rankingLossSum / rankingDenominator : 0;
  const loss = -average - cumulativeGrowthWeight * cumulativeGeometricReturnPct -
    sharpeWeight * cumulativeEquitySharpe + downsideWeight * downsideMean + adverseExcursionWeight * adverseMean +
    excursionDrawdownWeight * excursionDrawdownMean + drawdownWeight * drawdownMean +
    focalWeight * asymmetricFocalLoss + rankingWeight * crossSectionalRankingLoss;
  const logitGradients = Array(n).fill(0);
  for (let index = 0; index < n; index++) {
    const x = portfolioReturns[index];
    let gradient = -1 / n;
    gradient -= cumulativeGrowthWeight * geometricFactor * 100 /
      (Math.max(1, n) * Math.max(1e-6, 100 + x));
    const logReturn = equityLogReturns[index];
    const sharpeDerivativeByLogReturn = 1 / (n * logStandardDeviation) -
      averageLogReturn * (logReturn - averageLogReturn) / (n * logStandardDeviation ** 3);
    gradient -= sharpeWeight * sharpeDerivativeByLogReturn / Math.max(1e-6, 100 + x);
    if (x < 0) gradient += 2 * downsideWeight * x / n;
    gradient += drawdownGradient[index];
    const pair = pairs[index];
    const net = netReturnPct(pair.row, cost) * size;
    const adverse = Math.min(0, finite(pair.row.max_adverse_excursion_pct) ??
      Math.min(0, netReturnPct(pair.row, cost))) * size;
    const adverseGradient = 2 * adverseExcursionWeight *
      orderedAdverseReturns[index] * adverse / n;
    const favourable = Math.max(0, finite(pair.row.max_favorable_excursion_pct) ?? 0);
    const excursionRange = Math.max(0, favourable - Math.min(0,
      finite(pair.row.max_adverse_excursion_pct) ?? Math.min(0, netReturnPct(pair.row, cost))));
    const excursionGradient = 2 * excursionDrawdownWeight *
      orderedExcursionDrawdowns[index] * excursionRange * size / n;
    logitGradients[pair.index] =
      (gradient * net + adverseGradient + excursionGradient) *
      orderedProbabilityDerivative[index] + focalWeight * focalLogitGradients[pair.index] +
      rankingWeight * rankingLogitGradients[pair.index];
  }
  const maxDrawdown = Math.max(0, ...drawdowns);
  return {
    loss: round(loss, 8),
    mean_net_return_pct: round(average, 6),
    sharpe_per_decision: round(sharpe, 6),
    cumulative_equity_sharpe: round(cumulativeEquitySharpe, 6),
    cumulative_geometric_return_pct: round(cumulativeGeometricReturnPct, 6),
    btc_countertrend_penalty_enabled: Boolean(enforceMarketGates),
    mean_btc_penalty_factor: round(mean(orderedBtcPenaltyFactors) ?? 1, 8),
    downside_semivariance: round(downsideMean, 8),
    adverse_excursion_penalty: round(adverseMean, 8),
    intratrade_excursion_drawdown_penalty: round(excursionDrawdownMean, 8),
    drawdown_penalty: round(drawdownMean, 8),
    asymmetric_focal_loss: round(asymmetricFocalLoss, 8),
    cross_sectional_ranking_loss: round(crossSectionalRankingLoss, 8),
    cross_sectional_ranking_weight: rankingWeight,
    cross_sectional_ranking_pair_count: rankingPairCount,
    focal_loss_weight: focalWeight,
    focal_negative_class_weight: negativeWeight,
    focal_sample_count: focalSampleCount,
    focal_eligible_coverage_pct: round(focalSampleCount / n * 100, 4),
    focal_gamma_positive: gammaPositive,
    focal_gamma_negative: gammaNegative,
    max_additive_drawdown_pct: round(maxDrawdown, 6),
    position_fraction: size,
    round_trip_cost_bps: cost,
    positions: positions.map(value => round(value, 8)),
    portfolio_returns_pct: portfolioReturns.map(value => round(value, 8)),
    logit_gradients: logitGradients
  };
}

export function trainHybridTcnAttention(trainingRows, {
  epochs = 8, learningRate = 0.003, l2 = 0.001,
  seed = 17, objectiveOptions = {}
} = {}) {
  const rows = normalizeBenchmarkRows(trainingRows);
  if (rows.length < 20) throw new Error('HYBRID_TCN_REQUIRES_AT_LEAST_20_TRAINING_ROWS');
  const normalization = fitHybridFeatureNormalization(rows);
  const normalizedRows = rows.map(row => ({
    ...row, sequence: normalizeHybridSequence(row.sequence, normalization)
  }));
  const model = initializeHybridModel(seed);
  const parameters = () => ({
    inputWeights: model.inputWeights, inputBias: model.inputBias,
    depthWeights: model.depthWeights, pointWeights: model.pointWeights,
    biases: model.biases, attentionQuery: model.attentionQuery,
    outputWeights: model.outputWeights, outputBias: model.outputBias,
    logitScaleRaw: model.logitScaleRaw
  });
  let optimizer = { m: zerosLike(parameters()), v: zerosLike(parameters()) };
  const totalEpochs = Math.max(1, Math.min(50, Math.trunc(Number(epochs) || 8)));
  const trace = [];
  for (let epoch = 1; epoch <= totalEpochs; epoch++) {
    // Retain scalar probabilities only. A full forward cache contains every
    // time-step activation and convolution tensor; keeping one for every row
    // caused replay #129 to exceed a 4 GiB JS heap on the 33-symbol cohort.
    // The gradient pass below deterministically recomputes one cache at a time.
    const probabilities = new Array(normalizedRows.length);
    for (let index = 0; index < normalizedRows.length; index++) {
      const prediction = forwardHybrid(normalizedRows[index].sequence, model);
      if (!Number.isFinite(prediction.probability) || prediction.probability < 0 ||
          prediction.probability > 1 || !Number.isFinite(prediction.rawLogit))
        throw new TypeError('HYBRID_TCN_FORWARD_PROPAGATED_NON_FINITE:' + index);
      probabilities[index] = prediction.probability;
    }
    const objective = profitDrawdownObjective(probabilities, normalizedRows, {
      enforceMarketGates: true, ...objectiveOptions
    });
    if(!Number.isFinite(objective.loss)||
       !Array.isArray(objective.logit_gradients)||
       objective.logit_gradients.length!==normalizedRows.length||
       objective.logit_gradients.some(value=>!Number.isFinite(value)))
      throw new TypeError('HYBRID_TCN_OBJECTIVE_OR_GRADIENT_NON_FINITE');
    const gradients = zerosLike(parameters());
    for (let index = 0; index < normalizedRows.length; index++) {
      const cache = forwardHybrid(normalizedRows[index].sequence, model);
      if (!Number.isFinite(cache.probability) || !Number.isFinite(cache.rawLogit))
        throw new TypeError('HYBRID_TCN_BACKPROP_FORWARD_NON_FINITE:' + index);
      const item = gradientsForHybrid(normalizedRows[index].sequence, model, cache,
        objective.logit_gradients[index]);
      accumulateTreeInPlace(gradients, item);
    }
    const update = adamUpdate(parameters(), gradients, optimizer, epoch,
      clamp(Number(learningRate) || 0.003, 0.0001, 0.02), Math.max(0, Number(l2) || 0));
    Object.assign(model, update.parameters);
    optimizer = update.optimizer;
    trace.push({ epoch, loss: objective.loss, mean_net_return_pct: objective.mean_net_return_pct,
      sharpe_per_decision: objective.sharpe_per_decision,
      max_additive_drawdown_pct: objective.max_additive_drawdown_pct,
      focal_sample_count: objective.focal_sample_count,
      cross_sectional_ranking_loss: objective.cross_sectional_ranking_loss,
      cross_sectional_ranking_pair_count: objective.cross_sectional_ranking_pair_count });
  }
  return {
    model, architecture: HYBRID_TCN_ARCHITECTURE,
    architecture_config: HYBRID_TCN_CONFIGURATION,
    receptive_field_steps: TCN_RECEPTIVE_FIELD,
    normalization,
    activation: 'LEAKY_RELU_ALPHA_0_05',
    trained_logit_scale: Math.exp(Math.log(4) * Math.tanh(Number(model.logitScaleRaw) || 0)),
    feature_names: [...HYBRID_FEATURE_NAMES],
    training_samples: rows.length, epochs: totalEpochs,
    memory_profile: {
      forward_cache_strategy: 'SCALAR_PROBABILITY_PASS_THEN_SINGLE_ROW_RECOMPUTE',
      maximum_simultaneous_forward_caches: 1,
      retained_per_epoch_values: 'ONE_PROBABILITY_PER_ROW',
      full_cache_recomputation_count_per_epoch: rows.length
    },
    training_objective: 'CUMULATIVE_EQUITY_SHARPE_BTC_COUNTERTREND_FOCAL_ASYMMETRIC_BRIER_KAMA_V5',
    objective_trace: trace
  };
}

export function predictHybridTcnAttention(sequence, fitted) {
  if (!fitted?.model || !Array.isArray(sequence) || sequence.length !== HYBRID_SEQUENCE_STEPS ||
      !sequence.every(step => Array.isArray(step) && step.length === HYBRID_SEQUENCE_CHANNELS &&
        step.every(value => finite(value) !== null))) return null;
  const normalizedSequence = normalizeHybridSequence(sequence, fitted.normalization);
  const result = forwardHybrid(normalizedSequence, fitted.model);
  if(!Number.isFinite(result.probability)||result.probability<0||result.probability>1||
     !Number.isFinite(result.rawLogit)||!Number.isFinite(result.logitScale))return null;
  return {
    probability: round(result.probability, 8),
    raw_logit: round(result.rawLogit, 8),
    logit_scale: round(result.logitScale, 8),
    attention_weights: result.attention.map(value => round(value, 8)),
    architecture: HYBRID_TCN_ARCHITECTURE,
    architecture_config: HYBRID_TCN_CONFIGURATION,
    receptive_field_steps: TCN_RECEPTIVE_FIELD
  };
}

/**
 * Numerically verify the hand-written TCN/attention backpropagation against
 * central finite differences over representative parameters in every block.
 * This is an opt-in diagnostic used by the benchmark tests, not training data.
 */
export function diagnoseHybridGradientIntegrity({
  seed = 17, epsilon = 1e-5, tolerance = 2e-4
} = {}) {
  const sequence = Array.from({ length: HYBRID_SEQUENCE_STEPS }, (_, time) =>
    Array.from({ length: HYBRID_SEQUENCE_CHANNELS }, (_, channel) =>
      Math.sin((time + 1) * (channel + 2) * 0.137) * 0.7 +
      Math.cos((time + 3) * (channel + 1) * 0.071) * 0.2));
  const model = initializeHybridModel(seed);
  const cache = forwardHybrid(sequence, model);
  const analyticalGradients = gradientsForHybrid(sequence, model, cache, 1);
  const probes = [
    ['outputBias', ['outputBias']],
    ['outputWeights[3]', ['outputWeights', 3]],
    ['attentionQuery[2]', ['attentionQuery', 2]],
    ['pointWeights[1][2][4]', ['pointWeights', 1, 2, 4]],
    ['depthWeights[2][1][3]', ['depthWeights', 2, 1, 3]],
    ['inputWeights[7][5]', ['inputWeights', 7, 5]],
    ['inputBias[2]', ['inputBias', 2]],
    ['biases[1][4]', ['biases', 1, 4]],
    ['logitScaleRaw', ['logitScaleRaw']]
  ];
  const getAt = (object, path) => path.reduce((value, key) => value[key], object);
  const setAt = (object, path, value) => {
    let cursor = object;
    for (const key of path.slice(0, -1)) cursor = cursor[key];
    cursor[path.at(-1)] = value;
  };
  const results = probes.map(([name, path]) => {
    const analytical = Number(getAt(analyticalGradients, path));
    const center = Number(getAt(model, path));
    const plus = structuredClone(model), minus = structuredClone(model);
    setAt(plus, path, center + epsilon);
    setAt(minus, path, center - epsilon);
    const upper = forwardHybrid(sequence, plus).logit;
    const lower = forwardHybrid(sequence, minus).logit;
    const numerical = (upper - lower) / (2 * epsilon);
    const absoluteError = Math.abs(analytical - numerical);
    const relativeError = absoluteError / Math.max(1, Math.abs(analytical), Math.abs(numerical));
    return {
      parameter: name,
      analytical: round(analytical, 10),
      numerical: round(numerical, 10),
      absolute_error: round(absoluteError, 10),
      relative_error: round(relativeError, 10)
    };
  });
  const maximumRelativeError = Math.max(...results.map(row => row.relative_error));
  return {
    status: maximumRelativeError <= tolerance ? 'PASS' : 'FAIL',
    tolerance,
    maximum_relative_error: maximumRelativeError,
    probes: results
  };
}

export function simulatePaperTrades(decisions, {
  threshold = 0.55,
  roundTripCostBps = DEFAULT_COST_BPS,
  positionFraction = DEFAULT_POSITION_FRACTION,
  maxConcurrentPositions = DEFAULT_MAX_CONCURRENT_POSITIONS,
  initialEquity = 100,
  enforceMarketGates = false,
  minimumKamaEfficiencyRatio = 0.20,
  minimumVolatilityZScore = 0,
  btcCountertrendPenaltyPerPct = 0.12
} = {}) {
  const size = clamp(Number(positionFraction) || DEFAULT_POSITION_FRACTION, 0.001, 1);
  const maxOpen = Math.max(1, Math.min(30, Math.trunc(Number(maxConcurrentPositions) || DEFAULT_MAX_CONCURRENT_POSITIONS)));
  const costPct = Math.max(0, Number(roundTripCostBps) || 0) / 100;
  const seedEquity = Math.max(1, Number(initialEquity) || 100);
  const inputDecisions = Array.isArray(decisions) ? decisions : [];
  const marketGateDiagnostics = {
    input_count: inputDecisions.length, eligible_count: 0,
    blocked_kama_efficiency: 0, blocked_low_volatility: 0,
    blocked_missing_btc_context: 0, btc_countertrend_penalized: 0
  };
  const contextDecisions = inputDecisions.map(row => {
    const gates = enforceMarketGates ? evaluateHybridMarketGates(row, {
      minimumKamaEfficiencyRatio, minimumVolatilityZScore, btcCountertrendPenaltyPerPct
    }) : { eligible: true, btc_countertrend_penalty_factor: 1, reason: null };
    if (enforceMarketGates) {
      if (gates.reason === 'KAMA_EFFICIENCY_UNAVAILABLE' || gates.reason === 'KAMA_EFFICIENCY_BELOW_MINIMUM') marketGateDiagnostics.blocked_kama_efficiency++;
      else if (gates.reason === 'VOLATILITY_ZSCORE_UNAVAILABLE' || gates.reason === 'VOLATILITY_BELOW_ROLLING_MEAN') marketGateDiagnostics.blocked_low_volatility++;
      else if (gates.reason) marketGateDiagnostics.blocked_missing_btc_context++;
      if (gates.eligible && Number(gates.btc_countertrend_penalty_factor) < 0.999999) marketGateDiagnostics.btc_countertrend_penalized++;
    }
    return { ...row, _market_gate: gates,
      _adjusted_score: (finite(row.score) ?? -1) * Number(gates.eligible ? gates.btc_countertrend_penalty_factor ?? 1 : 0) };
  });
  marketGateDiagnostics.eligible_count = contextDecisions.filter(row => row._market_gate?.eligible).length;
  const selected = contextDecisions
    .filter(row => (!enforceMarketGates || row._market_gate?.eligible === true) &&
      finite(row._adjusted_score) !== null && finite(row.threshold ?? threshold) !== null &&
      row._adjusted_score >= (row.threshold ?? threshold) &&
      finite(row.at) !== null && finite(row.resolved_at) !== null &&
      finite(row.max_adverse_excursion_at) !== null &&
      finite(row.max_favorable_excursion_at) !== null &&
      Number(row.resolved_at) > Number(row.at) &&
      Number(row.max_adverse_excursion_at) >= Number(row.at) &&
      Number(row.max_adverse_excursion_at) <= Number(row.resolved_at) &&
      Number(row.max_favorable_excursion_at) >= Number(row.at) &&
      Number(row.max_favorable_excursion_at) <= Number(row.resolved_at) &&
      finite(row.gross_return_pct) !== null &&
      finite(row.max_adverse_excursion_pct) !== null &&
      finite(row.max_favorable_excursion_pct) !== null)
    .map(row => ({ ...row, score: row._adjusted_score }))
    .sort((a, b) => a.at - b.at || b.score - a.score || a.symbol.localeCompare(b.symbol));

  let cash = seedEquity;
  let peakEquity = seedEquity;
  let maxDrawdown = 0;
  const open = [];
  const trades = [];
  let skippedSameSymbol = 0, skippedCapacity = 0, skippedInsufficientCash = 0;

  const markedEquity = () => cash + open.reduce((sum, position) =>
    sum + position.capital * (1 + position.mark_pct / 100), 0);
  const updateDrawdown = () => {
    const mark = Math.max(0, markedEquity());
    peakEquity = Math.max(peakEquity, mark);
    if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - mark) / peakEquity * 100);
  };
  const processOpenEvent = event => {
    const position = event.position;
    if (!open.includes(position)) return;
    if (event.type === 'MFE') {
      position.mark_pct = Math.max(position.mark_pct, position.max_favorable_pct);
      position.trade.mfe_marked_at = event.at;
      updateDrawdown();
      return;
    }
    if (event.type === 'MAE') {
      position.mark_pct = Math.min(position.mark_pct, position.max_adverse_pct);
      position.trade.mae_marked_at = event.at;
      updateDrawdown();
      return;
    }
    position.mark_pct = position.net_return_pct;
    const pnl = position.capital * position.net_return_pct / 100;
    cash += position.capital + pnl;
    open.splice(open.indexOf(position), 1);
    position.trade.pnl = round(pnl, 8);
    position.trade.equity_after_exit = round(markedEquity(), 8);
    position.trade.exit_realized = true;
    updateDrawdown();
  };
  const eventQueue = [];
  const pushEvent = event => {
    eventQueue.push(event);
    const priority = type => type === 'MFE' ? 0 : (type === 'MAE' ? 1 : 2);
    eventQueue.sort((a, b) => a.at - b.at ||
      priority(a.type) - priority(b.type) ||
      a.position.symbol.localeCompare(b.position.symbol));
  };
  let decisionIndex = 0;
  while (decisionIndex < selected.length || eventQueue.length) {
    const nextDecision = selected[decisionIndex] ?? null;
    const nextPositionEvent = eventQueue[0] ?? null;
    if (nextPositionEvent && (!nextDecision || nextPositionEvent.at <= Number(nextDecision.at))) {
      const eventAt = nextPositionEvent.at;
      while (eventQueue.length && eventQueue[0].at === eventAt) {
        const event = eventQueue.shift();
        processOpenEvent(event);
      }
      continue;
    }
    const decision = nextDecision;
    decisionIndex++;
    const at = Number(decision.at);
    const symbol = String(decision.symbol || '').toUpperCase();
    if (open.some(position => position.symbol === symbol)) {
      skippedSameSymbol++;
      continue;
    }
    if (open.length >= maxOpen) {
      skippedCapacity++;
      continue;
    }
    const equityAtEntry = Math.max(0, markedEquity());
    const capital = equityAtEntry * size;
    if (!(capital > 0) || cash + 1e-9 < capital) {
      skippedInsufficientCash++;
      continue;
    }
    const gross = Number(decision.gross_return_pct);
    const net = gross - costPct;
    const adverse = Math.min(0, Number(decision.max_adverse_excursion_pct));
    const adverseAt = Number(decision.max_adverse_excursion_at);
    const position = {
      id: decision.id, symbol, at, resolved_at: Number(decision.resolved_at),
      capital, gross_return_pct: gross, net_return_pct: net,
      max_adverse_pct: adverse, max_adverse_at: adverseAt,
      max_favorable_pct: Math.max(0, Number(decision.max_favorable_excursion_pct)),
      max_favorable_at: Number(decision.max_favorable_excursion_at),
      mark_pct: 0, score: Number(decision.score),
      trade: {
        id: decision.id, symbol, at, resolved_at: Number(decision.resolved_at),
        score: round(Number(decision.score), 6),
        raw_model_score: round(Number(decision.score) / Math.max(1e-8, Number(decision._market_gate?.btc_countertrend_penalty_factor ?? 1)), 6),
        market_gate: decision._market_gate,
        gross_return_pct: round(gross, 6), net_return_pct: round(net, 6),
        max_adverse_excursion_pct: round(adverse, 6),
        max_adverse_excursion_at: adverseAt,
        max_favorable_excursion_pct: round(Math.max(0, Number(decision.max_favorable_excursion_pct)), 6),
        max_favorable_excursion_at: Number(decision.max_favorable_excursion_at),
        position_fraction: round(capital / Math.max(1e-9, equityAtEntry), 8),
        allocated_capital: round(capital, 8),
        equity_before: round(equityAtEntry, 8),
        equity_after_exit: null, pnl: null, mfe_marked_at: null, mae_marked_at: null, exit_realized: false
      }
    };
    cash -= capital;
    open.push(position);
    trades.push(position.trade);
    const favourableAt=Number(decision.max_favorable_excursion_at);
    if(favourableAt<=position.resolved_at&&Number(decision.max_favorable_excursion_pct)>0)
      pushEvent({at:favourableAt,type:'MFE',position});
    if (adverseAt <= position.resolved_at) pushEvent({ at: adverseAt, type: 'MAE', position });
    pushEvent({ at: position.resolved_at, type: 'EXIT', position });
    updateDrawdown();
  }

  const netTradeReturns = trades.map(row => row.net_return_pct * row.position_fraction);
  const average = mean(netTradeReturns) ?? 0;
  const sd = Math.sqrt(mean(netTradeReturns.map(value => (value - average) ** 2)) ?? 0);
  const wins = trades.filter(row => row.net_return_pct > 0).length;
  return {
    trade_count: trades.length,
    win_count: wins,
    loss_or_breakeven_count: trades.length - wins,
    win_rate_pct: trades.length ? round(wins / trades.length * 100, 4) : 0,
    net_pnl_pct: round((cash / seedEquity - 1) * 100, 6),
    final_equity: round(cash, 8),
    max_drawdown_pct: round(maxDrawdown, 6),
    sharpe_per_trade: sd > 1e-9 ? round(average / sd, 6) : 0,
    skipped_signals_same_symbol_position_open: skippedSameSymbol,
    skipped_signals_at_position_capacity: skippedCapacity,
    skipped_signals_insufficient_cash: skippedInsufficientCash,
    round_trip_cost_bps: Number(roundTripCostBps),
    position_fraction: size,
    max_concurrent_positions: maxOpen,
    market_gate_diagnostics: marketGateDiagnostics,
    trades
  };
}

function quantile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const position = clamp(probability, 0, 1) * (sortedValues.length - 1);
  const lower = Math.floor(position), upper = Math.ceil(position);
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function summarizeValidationScores(scores) {
  const sorted = scores.filter(value => finite(value) !== null)
    .map(value => clamp(Number(value), 0, 1)).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return {
    count: sorted.length,
    min: round(sorted[0], 8),
    q25: round(quantile(sorted, 0.25), 8),
    median: round(quantile(sorted, 0.50), 8),
    q75: round(quantile(sorted, 0.75), 8),
    q90: round(quantile(sorted, 0.90), 8),
    q95: round(quantile(sorted, 0.95), 8),
    q99: round(quantile(sorted, 0.99), 8),
    max: round(sorted.at(-1), 8),
    at_or_above_040: sorted.filter(value => value >= 0.40).length,
    at_or_above_055: sorted.filter(value => value >= 0.55).length,
    at_or_above_075: sorted.filter(value => value >= 0.75).length
  };
}

function chooseThreshold(validationRows, scoreById, options) {
  const scores = validationRows.map(row => scoreById.get(row.id))
    .filter(value => finite(value) !== null).map(Number);
  const sortedScores = [...scores].sort((a, b) => a - b);
  const scoreDistribution = summarizeValidationScores(scores);
  const quantileCandidates = [0.25, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95, 0.975, 0.99]
    .map(probability => quantile(sortedScores, probability))
    .filter(value => finite(value) !== null);
  const thresholds = [...new Set([
    ...(Array.isArray(options.thresholdGrid) ? options.thresholdGrid : []),
    ...quantileCandidates
  ].map(value => round(clamp(Number(value), 0, 1), 8)))].sort((a, b) => a - b);
  const minimumValidationTrades = Math.max(5,
    Math.min(100, Math.trunc(Number(options.minimumValidationTrades) || 10)));
  let best = null;
  const candidateTrials = [];
  for (const threshold of thresholds) {
    const decisions = validationRows.map(row => ({
      ...row, score: scoreById.get(row.id) ?? 0, threshold
    }));
    const report = simulatePaperTrades(decisions, options);
    const utility = report.net_pnl_pct - 0.5 * report.max_drawdown_pct +
      0.1 * report.sharpe_per_trade;
    // A profitable sample is not enough: never select a validation strategy whose
    // risk-adjusted utility is worse than the zero-exposure (no-trade) baseline.
    const eligible = report.trade_count >= minimumValidationTrades &&
      report.net_pnl_pct > 0 && utility > 0;
    const candidate = { threshold, report, utility, eligible };
    candidateTrials.push({
      threshold,
      trade_count: report.trade_count,
      win_rate_pct: report.win_rate_pct,
      net_pnl_pct: report.net_pnl_pct,
      max_drawdown_pct: report.max_drawdown_pct,
      sharpe_per_trade: report.sharpe_per_trade,
      utility: round(utility, 8),
      risk_adjusted_edge_over_abstention: utility > 0,
      eligible
    });
    if (eligible && (!best || candidate.utility > best.utility ||
        (candidate.utility === best.utility && candidate.threshold > best.threshold))) best = candidate;
  }
  if (best) {
    return {
      ...best,
      status: 'SELECTED_PROFITABLE_VALIDATION_THRESHOLD',
      minimum_validation_trades: minimumValidationTrades,
      score_distribution: scoreDistribution,
      candidate_trials: candidateTrials
    };
  }
  // Do not let a zero-trade, zero-drawdown validation fold masquerade as a
  // winning model. An explicit >1 threshold represents abstention, not a trade.
  const abstainThreshold = 1.000001;
  const abstainDecisions = validationRows.map(row => ({
    ...row, score: scoreById.get(row.id) ?? 0, threshold: abstainThreshold
  }));
  return {
    threshold: abstainThreshold,
    report: simulatePaperTrades(abstainDecisions, options),
    utility: 0,
    eligible: false,
    status: 'ABSTAINED_NO_PROFITABLE_VALIDATION_THRESHOLD',
    minimum_validation_trades: minimumValidationTrades,
    score_distribution: scoreDistribution,
    candidate_trials: candidateTrials
  };
}

function summarizeTrades(report) {
  return {
    trade_count: report.trade_count,
    win_rate_pct: report.win_rate_pct,
    net_pnl_pct: report.net_pnl_pct,
    max_drawdown_pct: report.max_drawdown_pct,
    sharpe_per_trade: report.sharpe_per_trade,
    cost_round_trip_bps: report.cost_round_trip_bps
  };
}

export function hasRiskAdjustedNeuralSuperiority(neural, classicBaseline, {
  validationThresholdsReady = false,
  minimumTrades = 100,
  minimumWinRatePct = 55,
  maximumDrawdownPct = 8
} = {}) {
  if (!neural || !classicBaseline || !validationThresholdsReady) return false;
  return Number(neural.trade_count) >= minimumTrades &&
    Number(neural.win_rate_pct) >= minimumWinRatePct &&
    Number(neural.max_drawdown_pct) <= maximumDrawdownPct &&
    Number(neural.net_pnl_pct) > 0 &&
    Number(neural.net_pnl_pct) > Number(classicBaseline.net_pnl_pct) &&
    Number(neural.sharpe_per_trade) > Number(classicBaseline.sharpe_per_trade) &&
    Number(neural.max_drawdown_pct) <= Number(classicBaseline.max_drawdown_pct);
}

/**
 * Same fixed SHA, same closed-candle opportunity rows and same execution costs
 * for both challengers. Validation only chooses each score threshold; no test
 * fold is used for fitting or threshold selection.
 */
export function runFixedShaBenchmark(inputRows, {
  sourceCommitSha,
  folds = 5,
  minimumTrainTimes = 160,
  minimumTrainRows = 100,
  minimumValidationRows = 30,
  minimumTestRows = 30,
  embargoMs = 4 * 60 * 60 * 1000,
  epochs = 8,
  roundTripCostBps = DEFAULT_COST_BPS,
  positionFraction = DEFAULT_POSITION_FRACTION,
  maxConcurrentPositions = DEFAULT_MAX_CONCURRENT_POSITIONS,
  thresholdGrid = DEFAULT_TRADE_THRESHOLD_GRID,
  minimumValidationTrades = 10,
  targetDefinition = DEFAULT_TARGET_DEFINITION
} = {}) {
  if (!/^[a-f0-9]{40}$/i.test(String(sourceCommitSha || ''))) {
    throw new Error('FIXED_BENCHMARK_REQUIRES_FULL_SOURCE_COMMIT_SHA');
  }
  if(String(targetDefinition)!==DEFAULT_TARGET_DEFINITION) {
    throw new Error('UNSUPPORTED_HYBRID_BENCHMARK_TARGET_DEFINITION');
  }
  const rows = normalizeBenchmarkRows(inputRows,DEFAULT_TARGET_DEFINITION);
  const outcomeSources=[...new Set(rows.map(row=>row.outcome_source))];
  if(outcomeSources.length>1)throw new Error('FIXED_BENCHMARK_MUST_USE_ONE_CLOSED_SPOT_OUTCOME_SOURCE');
  const datasetSha = sha256Canonical(rows);
  const fixedSha = sha256Canonical({
    source_commit_sha: String(sourceCommitSha).toLowerCase(),
    dataset_sha256: datasetSha,
    row_count: rows.length,
    target: String(targetDefinition)
  });
  const observedMarketRegimes=[...new Set(rows.map(row=>row.market_regime))].sort();
  const missingMarketRegimes=REQUIRED_MARKET_REGIMES.filter(regime=>!observedMarketRegimes.includes(regime));
  const marketRegimeCoverageComplete=missingMarketRegimes.length===0;
  const walkForward = buildPurgedWalkForwardFolds(rows, {
    folds, minimumTrainTimes, minimumTrainRows, minimumValidationRows, minimumTestRows, embargoMs
  });
  const integrity = {
    source_commit_sha: String(sourceCommitSha).toLowerCase(),
    dataset_sha256: datasetSha,
    fixed_benchmark_sha256: fixedSha,
    rows: rows.length,
    distinct_symbols: new Set(rows.map(row => row.symbol)).size,
    distinct_decision_times: new Set(rows.map(row => row.at)).size,
    rejected_or_duplicate_rows_removed: (Array.isArray(inputRows) ? inputRows.length : 0) - rows.length,
    all_inputs_causal: rows.every(row => row.latest_input_at <= row.at),
    outcome_definition: String(targetDefinition),
    outcome_source_count: outcomeSources.length,
    market_regimes:observedMarketRegimes,
    missing_market_regimes:missingMarketRegimes,
    historical_window_count:new Set(rows.map(row=>row.historical_window_id)).size,
    adverse_excursion_coverage_pct: rows.length
      ? round(rows.filter(row => finite(row.max_adverse_excursion_pct) !== null &&
        finite(row.max_adverse_excursion_at) !== null).length / rows.length * 100, 4) : 0,
    favourable_excursion_coverage_pct: rows.length
      ? round(rows.filter(row => finite(row.max_favorable_excursion_pct) !== null &&
        finite(row.max_favorable_excursion_at) !== null).length / rows.length * 100, 4) : 0,
    agg_trade_flow_coverage_pct: rows.length
      ? round(rows.filter(row =>
        row.sequence.filter(step => step[20] === 1).length / row.sequence.length >= 0.8
      ).length / rows.length * 100, 4) : 0,
    trade_level_volume_profile_coverage_pct: rows.length
      ? round(rows.filter(row => row.sequence.at(-1)?.[21] === 1).length / rows.length * 100, 4) : 0,
    relative_btc_coverage_pct: rows.length
      ? round(rows.filter(row =>
        row.sequence.filter(step => step[22] === 1).length / row.sequence.length >= 0.8
      ).length / rows.length * 100, 4) : 0,
    depth_availability_pct: rows.length
      ? round(rows.filter(row => row.sequence.at(-1)?.[19] === 1).length / rows.length * 100, 4) : 0
  };
  if (!marketRegimeCoverageComplete) return {
    status:'INSUFFICIENT_MARKET_REGIME_COVERAGE',
    integrity,walk_forward:walkForward,
    acceptance_gates:{
      all_three_observed_btc_regimes:'FAIL',
      each_required_btc_regime_has_30_oos_events:'FAIL'
    },
    neural:null,classic_baseline:null,superiority:'NOT_EVALUATED'
  };
  if (walkForward.status !== 'READY') return {
    status: 'INSUFFICIENT_WALK_FORWARD_COVERAGE',
    integrity, walk_forward: walkForward,
    acceptance_gates: {
      min_test_trades: 100, min_win_rate_pct: 55, max_drawdown_pct: 8,
      net_pnl_positive: true, beat_classic_baseline: true,
      each_required_btc_regime_has_30_oos_events: 'FAIL'
    },
    neural: null, classic_baseline: null, superiority: 'NOT_EVALUATED'
  };

  const outOfSampleNeural = [], outOfSampleClassic = [], foldReports = [];
  const executionOptions = {
    threshold: 0.55, roundTripCostBps, positionFraction, maxConcurrentPositions,
    thresholdGrid: [...thresholdGrid], minimumValidationTrades,
    enforceMarketGates: true
  };
  for (const fold of walkForward.folds) {
    const fitted = trainHybridTcnAttention(fold.train, { epochs });
    const validationNeural = new Map(fold.validation.map(row =>
      [row.id, predictHybridTcnAttention(row.sequence, fitted).probability]));
    const validationClassic = new Map(fold.validation.map(row => [row.id, row.classic_score]));
    const neuralChoice = chooseThreshold(fold.validation, validationNeural, executionOptions);
    const classicChoice = chooseThreshold(fold.validation, validationClassic, executionOptions);
    const testPredictions = fold.test.map(row => ({
      ...row,
      neuralScore: predictHybridTcnAttention(row.sequence, fitted).probability,
      neuralThreshold: neuralChoice.threshold,
      classicScore: row.classic_score,
      classicThreshold: classicChoice.threshold
    }));
    outOfSampleNeural.push(...testPredictions.map(row => ({
      ...row, score: row.neuralScore, threshold: row.neuralThreshold
    })));
    outOfSampleClassic.push(...testPredictions.map(row => ({
      ...row, score: row.classicScore, threshold: row.classicThreshold
    })));
    foldReports.push({
      fold: fold.fold,
      train_rows: fold.train_count, validation_rows: fold.validation_count, test_rows: fold.test_count,
      train_outcome_cutoff: fold.max_training_outcome_resolved_at,
      validation_outcome_cutoff: fold.max_validation_outcome_resolved_at,
      neural_threshold: neuralChoice.threshold,
      classic_threshold: classicChoice.threshold,
      neural_validation: summarizeTrades(neuralChoice.report),
      classic_validation: summarizeTrades(classicChoice.report),
      neural_training: {
        epochs: fitted.epochs,
        training_samples: fitted.training_samples,
        trained_logit_scale: fitted.trained_logit_scale,
        objective_trace: fitted.objective_trace
      },
      neural_threshold_selection: {
        status: neuralChoice.status,
        minimum_validation_trades: neuralChoice.minimum_validation_trades,
        score_distribution: neuralChoice.score_distribution,
        candidate_trials: neuralChoice.candidate_trials
      },
      classic_threshold_selection: {
        status: classicChoice.status,
        minimum_validation_trades: classicChoice.minimum_validation_trades,
        score_distribution: classicChoice.score_distribution,
        candidate_trials: classicChoice.candidate_trials
      },
      same_test_event_count: testPredictions.length
    });
  }
  const neural = simulatePaperTrades(outOfSampleNeural, executionOptions);
  const classicBaseline = simulatePaperTrades(outOfSampleClassic, executionOptions);
  const minimumTrades = neural.trade_count >= 100;
  const winRate = neural.win_rate_pct >= 55;
  const drawdown = neural.max_drawdown_pct <= 8;
  const profit = neural.net_pnl_pct > 0;
  const flowCoverage = integrity.agg_trade_flow_coverage_pct >= 80;
  const profileCoverage = integrity.trade_level_volume_profile_coverage_pct >= 70;
  const maeCoverage = integrity.adverse_excursion_coverage_pct >= 99.9;
  const mfeCoverage = integrity.favourable_excursion_coverage_pct >= 99.9;
  const relativeBtcCoverage = integrity.relative_btc_coverage_pct >= 80;
  const uniqueRows = integrity.rejected_or_duplicate_rows_removed === 0;
  const validationThresholdsReady = foldReports.every(fold =>
    fold.neural_threshold_selection?.status === 'SELECTED_PROFITABLE_VALIDATION_THRESHOLD');
  const riskAdjustedSuperiority = hasRiskAdjustedNeuralSuperiority(neural, classicBaseline, {
    validationThresholdsReady
  });
  const sameOutOfSampleEvents = outOfSampleNeural.length === outOfSampleClassic.length &&
    outOfSampleNeural.every((row,index) => row.id === outOfSampleClassic[index]?.id &&
      row.symbol === outOfSampleClassic[index]?.symbol && row.at === outOfSampleClassic[index]?.at &&
      row.resolved_at === outOfSampleClassic[index]?.resolved_at);
  const noLeakage = integrity.all_inputs_causal && walkForward.test_blocks_non_overlapping &&
    walkForward.folds.every(fold =>
      fold.max_training_outcome_resolved_at < fold.boundaries.validation_start &&
      fold.max_validation_outcome_resolved_at < fold.boundaries.test_start &&
      fold.train.every(row=>row.latest_input_at<=row.at) &&
      fold.validation.every(row=>row.latest_input_at<=row.at) &&
      fold.test.every(row=>row.latest_input_at<=row.at));
  const sameFixedShaAndOosRows = Boolean(integrity.source_commit_sha &&
    integrity.dataset_sha256 && integrity.fixed_benchmark_sha256 && sameOutOfSampleEvents);
  const outOfSampleMarketRegimeCounts = Object.fromEntries(REQUIRED_MARKET_REGIMES.map(regime => [
    regime, outOfSampleNeural.filter(row => row.market_regime === regime).length
  ]));
  const minimumOosEventsPerRegime = 30;
  const allRequiredRegimesHaveOosCoverage = REQUIRED_MARKET_REGIMES.every(regime =>
    outOfSampleMarketRegimeCounts[regime] >= minimumOosEventsPerRegime);
  integrity.out_of_sample_market_regime_counts = outOfSampleMarketRegimeCounts;
  integrity.minimum_oos_events_per_regime = minimumOosEventsPerRegime;
  const gates = {
    minimum_100_oos_trades: minimumTrades ? 'PASS' : 'FAIL',
    win_rate_at_least_55_pct: winRate ? 'PASS' : 'FAIL',
    max_drawdown_at_most_8_pct: drawdown ? 'PASS' : 'FAIL',
    net_pnl_positive_after_costs: profit ? 'PASS' : 'FAIL',
    agg_trade_flow_coverage_at_least_80_pct: flowCoverage ? 'PASS' : 'FAIL',
    trade_level_volume_profile_coverage_at_least_70_pct: profileCoverage ? 'PASS' : 'FAIL',
    adverse_excursion_coverage_at_least_99_9_pct: maeCoverage ? 'PASS' : 'FAIL',
    favourable_excursion_coverage_at_least_99_9_pct: mfeCoverage ? 'PASS' : 'FAIL',
    relative_btc_reference_coverage_at_least_80_pct: relativeBtcCoverage ? 'PASS' : 'FAIL',
    all_input_rows_valid_and_unique: uniqueRows ? 'PASS' : 'FAIL',
    all_three_observed_btc_regimes: marketRegimeCoverageComplete ? 'PASS' : 'FAIL',
    each_required_btc_regime_has_30_oos_events: allRequiredRegimesHaveOosCoverage ? 'PASS' : 'FAIL',
    neural_validation_thresholds_profitable_with_minimum_samples:
      validationThresholdsReady ? 'PASS' : 'FAIL',
    beat_classic_on_net_pnl_sharpe_without_higher_drawdown:
      riskAdjustedSuperiority ? 'PASS' : 'FAIL',
    same_fixed_sha_and_oos_event_rows: sameFixedShaAndOosRows ? 'PASS' : 'FAIL',
    no_future_features_and_purged_boundaries: noLeakage ? 'PASS' : 'FAIL'
  };
  const accepted = Object.values(gates).every(value => value === 'PASS');
  return {
    status: accepted ? 'HYBRID_TCN_ATTENTION_ACCEPTED' : 'NEURAL_SUPERIORITY_NOT_PROVEN',
    integrity,
    architecture: HYBRID_TCN_ARCHITECTURE,
    architecture_config: HYBRID_TCN_CONFIGURATION,
    target_definition: String(targetDefinition),
    outcome_sources: [...new Set(rows.map(row => row.outcome_source))],
    market_regimes:observedMarketRegimes,
    historical_window_count:integrity.historical_window_count,
    training_objective: 'CUMULATIVE_EQUITY_SHARPE_BTC_COUNTERTREND_ASYMMETRIC_FOCAL_KAMA_V4',
    market_gate_policy: {
      kama_efficiency_ratio_period: 10,
      minimum_kama_efficiency_ratio: 0.20,
      volatility_zscore_history_bars: 24,
      volatility_zscore_current_return_window: 6,
      minimum_volatility_zscore: 0,
      btc_trend_window_bars: 12,
      btc_countertrend_penalty_per_pct: 0.12,
      missing_context_action: 'REJECT_SIGNAL'
    },
    threshold_selection_policy: {
      method: 'STATIC_GRID_PLUS_VALIDATION_SCORE_QUANTILES',
      minimum_validation_trades: Math.max(5, Math.min(100, Math.trunc(Number(minimumValidationTrades) || 10))),
      require_positive_validation_net_pnl_after_costs: true,
      no_profitable_candidate_action: 'ABSTAIN_FROM_TRADING'
    },
    execution_policy: {
      market: 'BINANCE_SPOT_USDT',
      paper_only: true,
      real_order_execution: false,
      round_trip_cost_bps: roundTripCostBps,
      position_fraction: positionFraction,
      max_concurrent_positions: maxConcurrentPositions,
      one_open_position_per_symbol: true,
      same_candle_take_profit_stop_loss_tie: 'STOP_FIRST'
    },
    walk_forward: {
      status: walkForward.status,
      fold_count: walkForward.fold_count,
      initial_train_times: walkForward.initial_train_times,
      test_blocks_non_overlapping: walkForward.test_blocks_non_overlapping,
      out_of_sample_market_regime_counts: outOfSampleMarketRegimeCounts,
      minimum_oos_events_per_regime: minimumOosEventsPerRegime,
      folds: foldReports
    },
    same_test_event_count: outOfSampleNeural.length,
    neural: summarizeTrades(neural),
    classic_baseline: summarizeTrades(classicBaseline),
    acceptance_gates: gates,
    superiority: accepted ? 'PROVEN_ON_THIS_FIXED_SHA_OOS_SAMPLE' : 'NOT_PROVEN',
    trades: {
      neural: neural.trades,
      classic_baseline: classicBaseline.trades
    },
    release_policy: 'RESEARCH_ONLY_UNTIL_THIS_REPORT_IS_REPRODUCED_ON_THE_RELEASE_SHA_AND_DHDTECH_PAPER_GATE_PASSES'
  };
}
