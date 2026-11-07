import { createHash } from 'node:crypto';

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
  'relative_btc_available'
]);

export const HYBRID_SEQUENCE_STEPS = 24;
export const HYBRID_SEQUENCE_CHANNELS = HYBRID_FEATURE_NAMES.length;
export const HYBRID_TCN_ARCHITECTURE =
  'CAUSAL_TCN_24x23_DILATIONS_1_2_4_WITH_TEMPORAL_ATTENTION_V1';

const HIDDEN = 12;
const DILATIONS = Object.freeze([1, 2, 4]);
const KERNEL_TAPS = 2;
const EPS = 1e-8;
const DEFAULT_COST_BPS = 30; // 10 bps fee + 5 bps slippage on each side.
const DEFAULT_MAX_CONCURRENT_POSITIONS = 30;
const DEFAULT_POSITION_FRACTION = 1 / DEFAULT_MAX_CONCURRENT_POSITIONS;
const DEFAULT_TRADE_THRESHOLD_GRID = Object.freeze([0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75]);
const DEFAULT_TARGET_DEFINITION = 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_CLOSED_SPOT_V1';

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

/**
 * Build a strictly causal 24 x 21 feature tensor from completed Binance Spot
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
  const sequence = [];
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
    const benchmarkIndex = benchmark.findLastIndex(row => candleTime(row) <= closeTime);
    const relativeBtc = benchmarkIndex > 0
      ? logReturn(candleNumber(benchmark[benchmarkIndex], 'close'),
        candleNumber(benchmark[benchmarkIndex - 1], 'close'))
      : 0;
    const pocDistance = volumeProfile.available && volumeProfile.poc > 0
      ? ((close / volumeProfile.poc) - 1) * 100
      : 0;
    const vaRange = volumeProfile.value_area_high - volumeProfile.value_area_low;
    const valueAreaPosition = volumeProfile.available && vaRange > 0
      ? clamp(((close - volumeProfile.value_area_low) / vaRange) * 2 - 1, -2, 2)
      : 0;
    const features = [
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
      benchmarkIndex > 0 ? 1 : 0
    ].map(value => round(clamp(Number.isFinite(value) ? value : 0, -4, 4), 6));
    sequence.push(features);
  }
  const latestInputAt = candleTime(selected.at(-1));
  return {
    ready: sequence.length === steps && latestInputAt <= cutoff &&
      sequence.every(row => row.length === HYBRID_SEQUENCE_CHANNELS && row.every(Number.isFinite)),
    reason: null,
    sequence_steps: steps,
    sequence_channels: HYBRID_SEQUENCE_CHANNELS,
    latest_input_at: latestInputAt,
    as_of: cutoff,
    feature_names: [...HYBRID_FEATURE_NAMES],
    sequence
  };
}

/** Resolve a long-only Spot bracket conservatively from completed future candles. */
export function resolveBarrierTrade({
  entryPrice, decisionAt, futureCandles = [], takeProfitPct = 3, stopLossPct = 2,
  horizonMs = 4 * 60 * 60 * 1000,
  feeBpsPerSide = 10, slippageBpsPerSide = 5
} = {}) {
  const entry = finite(entryPrice);
  const at = finite(decisionAt);
  if (!(entry > 0) || at === null) throw new Error('INVALID_BARRIER_TRADE_ENTRY');
  const take = entry * (1 + Math.max(0.01, Number(takeProfitPct) || 3) / 100);
  const stop = entry * (1 - Math.max(0.01, Number(stopLossPct) || 2) / 100);
  const horizonEnd = at + Math.max(1, Number(horizonMs) || 4 * 60 * 60 * 1000);
  const path = (Array.isArray(futureCandles) ? futureCandles : [])
    .filter(row => validClosedCandle(row) && candleTime(row) > at && candleTime(row) <= horizonEnd)
    .sort((a, b) => candleTime(a) - candleTime(b));
  if (!path.length) return { resolved: false, reason: 'NO_CLOSED_FUTURE_CANDLES' };
  let exitPrice = null, exitAt = null, exitReason = null;
  for (const candle of path) {
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
  if (at === null || !/^[A-Z0-9]{2,26}USDT$/.test(normalizedSymbol) ||
      score === null || score < 0 || score > 1) {
    return { ready: false, reason: 'INVALID_SPOT_DECISION_METADATA' };
  }
  const features = buildHybridSequence({ candles, benchmarkCandles, asOf: at });
  if (features.ready !== true) return { ready: false, reason: features.reason || 'FEATURE_TENSOR_NOT_READY' };
  const outcome = resolveBarrierTrade({
    entryPrice, decisionAt: at, futureCandles, horizonMs: 4 * 60 * 60 * 1000
  });
  if (outcome.resolved !== true) return { ready: false, reason: outcome.reason, outcome };
  return {
    ready: true,
    row: {
      id: String(id ?? normalizedSymbol + ':' + at),
      symbol: normalizedSymbol,
      market: 'BINANCE_SPOT_USDT',
      outcome_source: 'BINANCE_SPOT_CLOSED_15M',
      outcome_definition:DEFAULT_TARGET_DEFINITION,
      at,
      latest_input_at: features.latest_input_at,
      resolved_at: outcome.exit_at,
      gross_return_pct: outcome.gross_return_pct,
      max_adverse_excursion_pct: outcome.max_adverse_excursion_pct,
      max_adverse_excursion_at: outcome.max_adverse_excursion_at,
      max_favorable_excursion_pct: outcome.max_favorable_excursion_pct,
      max_favorable_excursion_at: outcome.max_favorable_excursion_at,
      classic_score: score,
      outcome_definition: DEFAULT_TARGET_DEFINITION,
      sequence: features.sequence,
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
    const at = finite(raw.at);
    const latestInputAt = finite(raw.latest_input_at);
    const resolvedAt = finite(raw.resolved_at);
    const gross = finite(raw.gross_return_pct);
    const adverse = finite(raw.max_adverse_excursion_pct);
    const adverseAt = finite(raw.max_adverse_excursion_at);
    const favourable = finite(raw.max_favorable_excursion_pct);
    const favourableAt = finite(raw.max_favorable_excursion_at);
    const classic = finite(raw.classic_score);
    const sequence = raw.sequence;
    if (!id || !/^[A-Z0-9]{2,26}USDT$/.test(symbol) ||
        market !== 'BINANCE_SPOT_USDT' ||
        !['BINANCE_SPOT_CLOSED_1M_REPLAY','BINANCE_SPOT_CLOSED_15M'].includes(outcomeSource) ||
        rowTargetDefinition!==targetDefinition ||
        at === null || latestInputAt === null || latestInputAt > at ||
        resolvedAt === null || resolvedAt <= at || gross === null ||
        adverse === null || adverse > 0 || adverse < -100 ||
        adverseAt === null || adverseAt < at || adverseAt > resolvedAt ||
        favourable === null || favourable < 0 || favourable > 1000 ||
        favourableAt === null || favourableAt < at || favourableAt > resolvedAt || classic === null ||
        classic < 0 || classic > 1 ||
        !Array.isArray(sequence) || sequence.length !== HYBRID_SEQUENCE_STEPS ||
        !sequence.every(step => Array.isArray(step) && step.length === HYBRID_SEQUENCE_CHANNELS &&
          step.every(value => finite(value) !== null && Math.abs(Number(value)) <= 4))) continue;
    const eventKey = symbol + ':' + Math.trunc(at);
    if (ids.has(id) || events.has(eventKey)) continue;
    ids.add(id);
    events.add(eventKey);
    rows.push({
      id, symbol, market, outcome_source: outcomeSource,
      at, latest_input_at: latestInputAt, resolved_at: resolvedAt,
      gross_return_pct: gross,
      max_adverse_excursion_pct:adverse,
      max_adverse_excursion_at:adverseAt,
      max_favorable_excursion_pct:favourable,
      max_favorable_excursion_at:favourableAt,
      classic_score: classic,
      outcome_definition:rowTargetDefinition,
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
  if (block <= 0 || block < Math.min(minimumValidationRows, minimumTestRows)) {
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
    outputBias: 0
  };
}

function softmax(values) {
  const maximum = Math.max(...values);
  const exponents = values.map(value => Math.exp(clamp(value - maximum, -30, 30)));
  const total = exponents.reduce((sum, value) => sum + value, 0) || 1;
  return exponents.map(value => value / total);
}

function forwardHybrid(sequence, model) {
  const projected = sequence.map(row => Array.from({ length: HIDDEN }, (_, output) => {
    let value = model.inputBias[output];
    for (let input = 0; input < HYBRID_SEQUENCE_CHANNELS; input++) value += row[input] * model.inputWeights[input][output];
    return Math.tanh(value);
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
      return Math.tanh(value);
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
  let logit = model.outputBias;
  for (let channel = 0; channel < HIDDEN; channel++) logit += context[channel] * model.outputWeights[channel];
  return { probability: sigmoid(logit), logit, activations, depthCaches, attention, context, scores };
}

function gradientsForHybrid(sequence, model, cache, dLossDLogit) {
  const gradients = zerosLike(model);
  const final = cache.activations.at(-1);
  const contextGradient = model.outputWeights.map(weight => weight * dLossDLogit);
  gradients.outputBias = dLossDLogit;
  for (let channel = 0; channel < HIDDEN; channel++) {
    gradients.outputWeights[channel] = cache.context[channel] * dLossDLogit;
  }
  const attentionContextProducts = final.map(row =>
    row.reduce((sum, value, channel) => sum + value * model.outputWeights[channel], 0) * dLossDLogit);
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
        const dz = activationGradient[time][outputChannel] * (1 - activation * activation);
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
        (1 - cache.activations[0][time][output] ** 2);
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
  sharpeWeight = 0.15,
  downsideWeight = 0.08,
  adverseExcursionWeight = 0.04,
  drawdownWeight = 0.08
} = {}) {
  if (!Array.isArray(probabilities) || probabilities.length !== rows.length || !rows.length) {
    throw new Error('PROFIT_OBJECTIVE_REQUIRES_MATCHED_NON_EMPTY_ROWS');
  }
  const cost = Math.max(0, Number(roundTripCostBps) || 0);
  const size = clamp(Number(positionFraction) || DEFAULT_POSITION_FRACTION, 0.01, 1);
  const temp = clamp(Number(temperature) || 0.10, 0.02, 0.5);
  const pairs = rows.map((row, index) => ({
    row, probability: clamp(Number(probabilities[index]), 0.001, 0.999), index
  })).sort((a, b) => a.row.at - b.row.at || a.row.symbol.localeCompare(b.row.symbol));
  const positions = Array(rows.length).fill(0);
  const orderedReturns = Array(rows.length).fill(0);
  const orderedAdverseReturns = Array(rows.length).fill(0);
  const orderedProbabilityDerivative = Array(rows.length).fill(0);
  for (let orderedIndex = 0; orderedIndex < pairs.length; orderedIndex++) {
    const pair = pairs[orderedIndex];
    const allocation = sigmoid((pair.probability - threshold) / temp);
    const net = netReturnPct(pair.row, cost);
    positions[pair.index] = allocation;
    orderedReturns[orderedIndex] = allocation * net * size; // percentage points on total equity
    const adverse = Math.min(0, finite(pair.row.max_adverse_excursion_pct) ?? Math.min(0, net));
    orderedAdverseReturns[orderedIndex] = allocation * adverse * size;
    orderedProbabilityDerivative[orderedIndex] =
      allocation * (1 - allocation) / temp * pair.probability * (1 - pair.probability);
  }
  const portfolioReturns = orderedReturns;
  const n = portfolioReturns.length;
  const average = mean(portfolioReturns) ?? 0;
  const variance = mean(portfolioReturns.map(value => (value - average) ** 2)) ?? 0;
  const standardDeviation = Math.sqrt(variance + 1e-6);
  const sharpe = average / standardDeviation;
  let downsideSquared = 0, adverseSquared = 0, underwaterSquared = 0, cumulative = 0, peak = 0, peakIndex = -1;
  const drawdowns = [], peakIndices = [], drawdownGradient = Array(n).fill(0);
  for (let index = 0; index < n; index++) {
    const value = portfolioReturns[index];
    if (value < 0) downsideSquared += value * value;
    adverseSquared += orderedAdverseReturns[index] ** 2;
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
  const drawdownMean = underwaterSquared / n;
  const loss = -average - sharpeWeight * sharpe +
    downsideWeight * downsideMean + adverseExcursionWeight * adverseMean +
    drawdownWeight * drawdownMean;
  const logitGradients = Array(n).fill(0);
  for (let index = 0; index < n; index++) {
    const x = portfolioReturns[index];
    let gradient = -1 / n;
    gradient -= sharpeWeight * (
      1 / (n * standardDeviation) -
      average * (x - average) / (n * standardDeviation ** 3)
    );
    if (x < 0) gradient += 2 * downsideWeight * x / n;
    gradient += drawdownGradient[index];
    const pair = pairs[index];
    const net = netReturnPct(pair.row, cost) * size;
    const adverse = Math.min(0, finite(pair.row.max_adverse_excursion_pct) ??
      Math.min(0, netReturnPct(pair.row, cost))) * size;
    const adverseGradient = 2 * adverseExcursionWeight *
      orderedAdverseReturns[index] * adverse / n;
    logitGradients[pair.index] =
      gradient * net * orderedProbabilityDerivative[index] +
      adverseGradient * orderedProbabilityDerivative[index];
  }
  const maxDrawdown = Math.max(0, ...drawdowns);
  return {
    loss: round(loss, 8),
    mean_net_return_pct: round(average, 6),
    sharpe_per_decision: round(sharpe, 6),
    downside_semivariance: round(downsideMean, 8),
    adverse_excursion_penalty: round(adverseMean, 8),
    drawdown_penalty: round(drawdownMean, 8),
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
  const model = initializeHybridModel(seed);
  const parameters = () => ({
    inputWeights: model.inputWeights, inputBias: model.inputBias,
    depthWeights: model.depthWeights, pointWeights: model.pointWeights,
    biases: model.biases, attentionQuery: model.attentionQuery,
    outputWeights: model.outputWeights, outputBias: model.outputBias
  });
  let optimizer = { m: zerosLike(parameters()), v: zerosLike(parameters()) };
  const totalEpochs = Math.max(1, Math.min(50, Math.trunc(Number(epochs) || 8)));
  const trace = [];
  for (let epoch = 1; epoch <= totalEpochs; epoch++) {
    const caches = rows.map(row => forwardHybrid(row.sequence, model));
    const objective = profitDrawdownObjective(caches.map(cache => cache.probability), rows, objectiveOptions);
    let gradients = zerosLike(parameters());
    for (let index = 0; index < rows.length; index++) {
      const item = gradientsForHybrid(rows[index].sequence, model, caches[index],
        objective.logit_gradients[index]);
      gradients = addTrees(gradients, item);
    }
    const update = adamUpdate(parameters(), gradients, optimizer, epoch,
      clamp(Number(learningRate) || 0.003, 0.0001, 0.02), Math.max(0, Number(l2) || 0));
    Object.assign(model, update.parameters);
    optimizer = update.optimizer;
    trace.push({ epoch, loss: objective.loss, mean_net_return_pct: objective.mean_net_return_pct,
      sharpe_per_decision: objective.sharpe_per_decision,
      max_additive_drawdown_pct: objective.max_additive_drawdown_pct });
  }
  return {
    model, architecture: HYBRID_TCN_ARCHITECTURE,
    feature_names: [...HYBRID_FEATURE_NAMES],
    training_samples: rows.length, epochs: totalEpochs,
    training_objective: 'NET_PROFIT_PLUS_SHARPE_MINUS_DOWNSIDE_SEMIVARIANCE_AND_DRAWDOWN_V1',
    objective_trace: trace
  };
}

export function predictHybridTcnAttention(sequence, fitted) {
  if (!fitted?.model || !Array.isArray(sequence) || sequence.length !== HYBRID_SEQUENCE_STEPS ||
      !sequence.every(step => Array.isArray(step) && step.length === HYBRID_SEQUENCE_CHANNELS &&
        step.every(value => finite(value) !== null))) return null;
  const result = forwardHybrid(sequence, fitted.model);
  return {
    probability: round(result.probability, 8),
    attention_weights: result.attention.map(value => round(value, 8)),
    architecture: HYBRID_TCN_ARCHITECTURE
  };
}

export function simulatePaperTrades(decisions, {
  threshold = 0.55,
  roundTripCostBps = DEFAULT_COST_BPS,
  positionFraction = DEFAULT_POSITION_FRACTION,
  maxConcurrentPositions = DEFAULT_MAX_CONCURRENT_POSITIONS,
  initialEquity = 100
} = {}) {
  const size = clamp(Number(positionFraction) || DEFAULT_POSITION_FRACTION, 0.001, 1);
  const maxOpen = Math.max(1, Math.min(30, Math.trunc(Number(maxConcurrentPositions) || DEFAULT_MAX_CONCURRENT_POSITIONS)));
  const costPct = Math.max(0, Number(roundTripCostBps) || 0) / 100;
  const seedEquity = Math.max(1, Number(initialEquity) || 100);
  const selected = (Array.isArray(decisions) ? decisions : [])
    .filter(row => finite(row.score) !== null && finite(row.threshold ?? threshold) !== null &&
      row.score >= (row.threshold ?? threshold) &&
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
    trades
  };
}

function chooseThreshold(validationRows, scoreById, options) {
  let best = null;
  for (const threshold of options.thresholdGrid) {
    const decisions = validationRows.map(row => ({
      ...row, score: scoreById.get(row.id) ?? 0, threshold
    }));
    const report = simulatePaperTrades(decisions, options);
    const utility = report.net_pnl_pct - 0.5 * report.max_drawdown_pct +
      0.1 * report.sharpe_per_trade;
    const candidate = { threshold, report, utility };
    if (!best || candidate.utility > best.utility ||
        (candidate.utility === best.utility && candidate.threshold > best.threshold)) best = candidate;
  }
  return best ?? { threshold: options.thresholdGrid[0], report: simulatePaperTrades([], options), utility: -Infinity };
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
  if (walkForward.status !== 'READY') return {
    status: 'INSUFFICIENT_WALK_FORWARD_COVERAGE',
    integrity, walk_forward: walkForward,
    acceptance_gates: {
      min_test_trades: 100, min_win_rate_pct: 55, max_drawdown_pct: 8,
      net_pnl_positive: true, beat_classic_baseline: true
    },
    neural: null, classic_baseline: null, superiority: 'NOT_EVALUATED'
  };

  const outOfSampleNeural = [], outOfSampleClassic = [], foldReports = [];
  const executionOptions = {
    threshold: 0.55, roundTripCostBps, positionFraction, maxConcurrentPositions, thresholdGrid: [...thresholdGrid]
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
  const riskAdjustedSuperiority = neural.net_pnl_pct > classicBaseline.net_pnl_pct &&
    neural.sharpe_per_trade > classicBaseline.sharpe_per_trade &&
    neural.max_drawdown_pct <= classicBaseline.max_drawdown_pct;
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
    beat_classic_on_net_pnl_sharpe_without_higher_drawdown:
      riskAdjustedSuperiority ? 'PASS' : 'FAIL',
    same_fixed_sha_and_oos_event_rows: 'PASS',
    no_future_features_and_purged_boundaries: 'PASS'
  };
  const accepted = Object.values(gates).every(value => value === 'PASS');
  return {
    status: accepted ? 'HYBRID_TCN_ATTENTION_ACCEPTED' : 'NEURAL_SUPERIORITY_NOT_PROVEN',
    integrity,
    architecture: HYBRID_TCN_ARCHITECTURE,
    target_definition: String(targetDefinition),
    outcome_sources: [...new Set(rows.map(row => row.outcome_source))],
    training_objective: 'NET_PROFIT_PLUS_SHARPE_MINUS_DOWNSIDE_SEMIVARIANCE_AND_DRAWDOWN_V1',
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
