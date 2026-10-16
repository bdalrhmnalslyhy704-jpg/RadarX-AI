const known = value => value !== null && value !== undefined &&
  !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));
const num = value => known(value) ? Number(value) : null;
const mean = values => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
};
const median = values => {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
};
const clamp = (value, low = 0, high = 100) =>
  Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function cleanClosedCandles(input, now, max = 96) {
  const rows = (Array.isArray(input) ? input : []).filter(c => {
    if (!c || c.closed !== true) return false;
    const openTime = num(c.openTime), closeTime = num(c.closeTime);
    const open = num(c.open), high = num(c.high), low = num(c.low), close = num(c.close);
    const volume = num(c.volume);
    return openTime !== null && closeTime !== null && closeTime <= now && openTime <= closeTime &&
      open > 0 && high >= Math.max(open, close) && low > 0 &&
      low <= Math.min(open, close) && close > 0 && volume !== null && volume >= 0;
  }).sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const unique = [];
  for (const row of rows) {
    if (unique.length && Number(unique.at(-1).openTime) === Number(row.openTime)) unique[unique.length - 1] = row;
    else unique.push(row);
  }
  return unique.slice(-Math.max(1, Math.trunc(Number(max) || 96)));
}

function trueRanges(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = Number(rows[i - 1].close), c = rows[i];
    out.push(Math.max(Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - prev), Math.abs(Number(c.low) - prev)));
  }
  return out;
}
function rangePct(rows) {
  if (!rows.length) return null;
  const close = mean(rows.map(x => Number(x.close)));
  const high = Math.max(...rows.map(x => Number(x.high)));
  const low = Math.min(...rows.map(x => Number(x.low)));
  return close > 0 ? (high - low) / close * 100 : null;
}
function returnPct(rows, barsBack) {
  if (rows.length <= barsBack) return null;
  const old = Number(rows[rows.length - 1 - barsBack].close);
  const last = Number(rows.at(-1).close);
  return old > 0 && last > 0 ? (last / old - 1) * 100 : null;
}
function candleNotional(c) {
  const v = num(c?.quoteVolume);
  return v !== null && v >= 0 ? v : null;
}
function ratioAgainstBaseline(rows, getter, recentCount = 3) {
  const start = Math.max(0, rows.length - recentCount - 24);
  const baselineRows = rows.slice(start, Math.max(start, rows.length - recentCount));
  const recentRows = rows.slice(-recentCount);
  const baseline = median(baselineRows.map(getter).filter(x => Number.isFinite(x) && x >= 0));
  const recent = median(recentRows.map(getter).filter(x => Number.isFinite(x) && x >= 0));
  const available = baseline !== null && baseline > 0 && recent !== null;
  return {
    available, baseline: round(baseline, 6), recent: round(recent, 6),
    ratio: available ? round(recent / baseline, 4) : null
  };
}
function buyShare(rows) {
  const valid = rows.filter(c => {
    const q = candleNotional(c), buy = num(c?.takerBuyQuoteVolume);
    return q !== null && q > 0 && buy !== null && buy >= 0 && buy <= q * 1.001;
  });
  if (!valid.length) return null;
  const quote = valid.reduce((sum, c) => sum + Number(c.quoteVolume), 0);
  const buy = valid.reduce((sum, c) => sum + Number(c.takerBuyQuoteVolume), 0);
  return quote > 0 ? buy / quote : null;
}

function summarizeLiveAggTradeFlow(input, closedRows, now, config = {}) {
  const raw = Array.isArray(input) ? input : [];
  const lookbackMs = Math.max(60_000, Number(config.liveAggTradeLookbackMs) || 10 * 60_000);
  const windowMs = Math.max(30_000, Number(config.liveAggTradeWindowMs) || 5 * 60_000);
  const maxRows = Math.max(1, Math.trunc(Number(config.liveAggTradeLimit) || 1000));
  const maxAgeMs = Math.max(1_000, Number(config.liveAggTradeMaxAgeMs) || 90_000);
  const windowStart = now - windowMs;
  const baselineStart = now - lookbackMs;
  const sampleTruncated = raw.length >= maxRows;
  const malformedRows = raw.filter(trade => {
    const time = num(trade?.T);
    if (time === null || time < baselineStart || time > now) return false;
    const price = num(trade?.p), qty = num(trade?.q);
    return price === null || qty === null || price <= 0 || qty <= 0 || typeof trade?.m !== 'boolean';
  }).length;
  const valid = raw.map(trade => {
    const time = num(trade?.T);
    const price = num(trade?.p);
    const qty = num(trade?.q);
    const firstId = num(trade?.f);
    const lastId = num(trade?.l);
    if (time === null || price === null || qty === null || price <= 0 || qty <= 0 ||
        typeof trade?.m !== 'boolean' || time < baselineStart || time > now) return null;
    const fills = firstId !== null && lastId !== null && Number.isInteger(firstId) &&
      Number.isInteger(lastId) && lastId >= firstId ? lastId - firstId + 1 : 1;
    return {time, price, qty, quote: price * qty, buyerMaker: trade.m, fills};
  }).filter(Boolean).sort((a, b) => a.time - b.time);
  const base = valid.filter(t => t.time >= baselineStart && t.time < windowStart);
  const recent = valid.filter(t => t.time >= windowStart && t.time <= now);
  const summarize = rows => {
    const fills = rows.reduce((sum, t) => sum + t.fills, 0);
    const buyerFills = rows.reduce((sum, t) => sum + (t.buyerMaker ? 0 : t.fills), 0);
    const quote = rows.reduce((sum, t) => sum + t.quote, 0);
    const buyQuote = rows.reduce((sum, t) => sum + (t.buyerMaker ? 0 : t.quote), 0);
    return {
      aggregate_rows: rows.length,
      execution_count: fills,
      buyer_initiated_execution_count: buyerFills,
      buyer_execution_share: fills > 0 ? buyerFills / fills : null,
      quote_notional: quote,
      buyer_initiated_quote_notional: buyQuote,
      buyer_quote_share: quote > 0 ? buyQuote / quote : null
    };
  };
  const b = summarize(base), c = summarize(recent);
  const latestTime = recent.length ? recent.at(-1).time : null;
  const ageMs = latestTime === null ? null : Math.max(0, now - latestTime);
  const baselineClosedBuyShare = buyShare(closedRows.slice(-27, -3));
  const tradeShareDelta = c.buyer_execution_share !== null && b.buyer_execution_share !== null
    ? c.buyer_execution_share - b.buyer_execution_share : null;
  const quoteShareDelta = c.buyer_quote_share !== null && b.buyer_quote_share !== null
    ? c.buyer_quote_share - b.buyer_quote_share : null;
  const baselineExecutionCount = b.execution_count;
  const baselineQuoteNotional = b.quote_notional;
  const executionRatio = !sampleTruncated && baselineExecutionCount > 0
    ? c.execution_count / baselineExecutionCount : null;
  const quoteRatio = !sampleTruncated && baselineQuoteNotional > 0
    ? c.quote_notional / baselineQuoteNotional : null;
  const minRows = Math.max(1, Math.trunc(Number(config.liveAggTradeMinExecutions) || 10));
  const enoughRows = c.execution_count >= minRows && baselineExecutionCount >= minRows;
  const fresh = ageMs !== null && ageMs <= maxAgeMs;
  const validBaselineWindow = lookbackMs >= windowMs * 2;
  let status = 'UNAVAILABLE';
  if (!raw.length) status = 'NO_LIVE_TRADE_SAMPLE';
  else if (sampleTruncated) status = 'SAMPLE_TRUNCATED';
  else if (malformedRows > 0) status = 'INVALID_TRADE_RECORDS';
  else if (!validBaselineWindow) status = 'INVALID_WINDOW_CONFIG';
  else if (!enoughRows) status = 'INSUFFICIENT_EXECUTIONS_FOR_COMPARISON';
  else if (!fresh) status = 'STALE_LIVE_TRADE_SAMPLE';
  else status = 'FRESH_COMPLETE_10M_SAMPLE';
  const available = status === 'FRESH_COMPLETE_10M_SAMPLE' &&
    c.buyer_execution_share !== null && c.buyer_quote_share !== null &&
    b.buyer_execution_share !== null && b.buyer_quote_share !== null;
  return {
    available, status, source: 'BINANCE_PUBLIC_REST_AGG_TRADES',
    as_of_ms: now, window_start_ms: windowStart, baseline_window_start_ms: baselineStart,
    latest_trade_time_ms: latestTime, latest_trade_age_ms: ageMs,
    raw_aggregate_rows: raw.length, malformed_trade_rows: malformedRows, sample_truncated: sampleTruncated,
    current: {
      aggregate_rows: c.aggregate_rows, execution_count: c.execution_count,
      buyer_initiated_execution_count: c.buyer_initiated_execution_count,
      buyer_execution_share: round(c.buyer_execution_share, 4),
      quote_notional: round(c.quote_notional, 4),
      buyer_initiated_quote_notional: round(c.buyer_initiated_quote_notional, 4),
      buyer_quote_share: round(c.buyer_quote_share, 4)
    },
    previous_5m: {
      aggregate_rows: b.aggregate_rows, execution_count: b.execution_count,
      buyer_initiated_execution_count: b.buyer_initiated_execution_count,
      buyer_execution_share: round(b.buyer_execution_share, 4),
      quote_notional: round(b.quote_notional, 4),
      buyer_initiated_quote_notional: round(b.buyer_initiated_quote_notional, 4),
      buyer_quote_share: round(b.buyer_quote_share, 4)
    },
    deltas: {
      buyer_execution_share: round(tradeShareDelta, 4),
      buyer_quote_share: round(quoteShareDelta, 4),
      execution_count_vs_previous_5m: round(executionRatio, 4),
      quote_notional_vs_previous_5m: round(quoteRatio, 4),
      buyer_quote_share_vs_closed_baseline: baselineClosedBuyShare !== null && c.buyer_quote_share !== null
        ? round(c.buyer_quote_share - baselineClosedBuyShare, 4) : null
    }
  };
}

function orderBookMetrics(bookTicker, depth) {
  const bids = Array.isArray(depth?.bids) ? depth.bids : [];
  const asks = Array.isArray(depth?.asks) ? depth.asks : [];
  const bidFromDepth = num(bids[0]?.[0]);
  const askFromDepth = num(asks[0]?.[0]);
  const bid = num(bookTicker?.bidPrice) ?? bidFromDepth;
  const ask = num(bookTicker?.askPrice) ?? askFromDepth;
  const validTop = bid !== null && ask !== null && bid > 0 && ask >= bid;
  const mid = validTop ? (bid + ask) / 2 : null;
  const spreadBps = validTop && mid > 0 ? (ask - bid) / mid * 10_000 : null;
  const bidDepth = mid !== null ? bids.reduce((sum, level) => {
    const price = num(level?.[0]), qty = num(level?.[1]);
    return price !== null && qty !== null && price >= mid * 0.99 && price <= mid ? sum + price * qty : sum;
  }, 0) : null;
  const askDepth = mid !== null ? asks.reduce((sum, level) => {
    const price = num(level?.[0]), qty = num(level?.[1]);
    return price !== null && qty !== null && price >= mid && price <= mid * 1.01 ? sum + price * qty : sum;
  }, 0) : null;
  const depthAvailable = bids.length > 0 && asks.length > 0 && mid !== null;
  const totalDepth = depthAvailable ? bidDepth + askDepth : null;
  const bidQty = num(bookTicker?.bidQty), askQty = num(bookTicker?.askQty);
  const topBidQuote = validTop && bidQty !== null && bidQty >= 0 ? bid * bidQty : null;
  const topAskQuote = validTop && askQty !== null && askQty >= 0 ? ask * askQty : null;
  const topQuoteTotal = topBidQuote !== null && topAskQuote !== null ? topBidQuote + topAskQuote : null;
  const topQuoteImbalance = topQuoteTotal > 0 ? (topBidQuote - topAskQuote) / topQuoteTotal : null;
  return {
    available: validTop,
    bid_price: round(bid, 10), ask_price: round(ask, 10),
    spread_bps: round(spreadBps, 3),
    depth_available: depthAvailable,
    bid_quote_depth_within_1pct: depthAvailable ? round(bidDepth, 2) : null,
    ask_quote_depth_within_1pct: depthAvailable ? round(askDepth, 2) : null,
    total_quote_depth_within_1pct: depthAvailable ? round(totalDepth, 2) : null,
    top_bid_quote_notional: round(topBidQuote, 2),
    top_ask_quote_notional: round(topAskQuote, 2),
    top_quote_imbalance: round(topQuoteImbalance, 4),
    depth_imbalance: depthAvailable && totalDepth > 0 ? round((bidDepth - askDepth) / totalDepth, 4) : round(topQuoteImbalance, 4),
    depth_imbalance_source: depthAvailable ? 'DEPTH_WITHIN_1_PERCENT' : topQuoteImbalance !== null ? 'TOP_OF_BOOK_ONLY' : 'UNAVAILABLE'
  };
}

/**
 * Unified public-Spot feature snapshot for RadarX Build 224.
 * The engine only consumes verified, closed candles. Missing book/depth or
 * taker-flow values remain null and never receive synthetic defaults.
 */
export function buildUnifiedFeatureSnapshot({
  symbol = '', candles = [], ticker = {}, benchmarkCandles = [],
  benchmarkTicker = null, marketBaseline24hPct = null,
  bookTicker = null, depth = null, liveAggTrades = null, now = Date.now(), config = {}
} = {}) {
  const asOf = Number(now);
  const rows = cleanClosedCandles(candles, asOf, config.maxCandles ?? 96);
  const minBars = Math.max(20, Math.trunc(Number(config.minClosedCandles) || 20));
  const last = rows.at(-1) || null;
  const closeTime = last ? Number(last.closeTime) : null;
  const candleAge = closeTime !== null ? Math.max(0, asOf - closeTime) : null;
  const maxAge = Math.max(1, Number(config.maxCandleAgeMs) || 8 * 60_000);
  const daily = num(ticker?.priceChange24h);
  const price = num(ticker?.lastPrice) ?? num(last?.close);
  const quoteVolume24h = num(ticker?.quoteVolume24h);
  const trades24h = num(ticker?.tradeCount24h);
  const source = String(last?.source || ticker?.source || 'UNKNOWN').toUpperCase();
  const benchmarkRows = cleanClosedCandles(benchmarkCandles, asOf, config.maxCandles ?? 96);
  const book = orderBookMetrics(bookTicker, depth);
  const empty = {
    version: 'RADARX_FEATURE_ENGINE_V1', symbol: String(symbol || ticker?.symbol || '').toUpperCase(),
    as_of_ms: Number.isFinite(asOf) ? asOf : null, source,
    closed_candles_only: true, closed_candle_count: rows.length,
    latest_closed_candle_close_time_ms: closeTime, candle_age_ms: candleAge,
    data_ready: false, stage: 'DATA_INSUFFICIENT', score: null,
    features: {}, components: {}, reasons: ['REQUIRED_CLOSED_CANDLE_DATA_UNAVAILABLE']
  };
  if (!Number.isFinite(asOf) || !last || rows.length < minBars || candleAge > maxAge ||
      !Number.isFinite(price) || price <= 0 || daily === null) return empty;

  const tr = trueRanges(rows);
  const currentAtr = mean(tr.slice(-14));
  const baseAtr = median(tr.slice(-42, -14));
  const atrRatio = currentAtr !== null && baseAtr !== null && baseAtr > 0 ? currentAtr / baseAtr : null;
  const recentRange = rangePct(rows.slice(-12));
  const previousRanges = [];
  for (let end = Math.max(12, rows.length - 48); end <= rows.length - 12; end += 4) {
    const value = rangePct(rows.slice(end - 12, end));
    if (Number.isFinite(value)) previousRanges.push(value);
  }
  const baselineRange = median(previousRanges);
  const rangeCompressionRatio = recentRange !== null && baselineRange !== null && baselineRange > 0
    ? recentRange / baselineRange : null;
  const currentBbw = (() => {
    const xs = rows.slice(-20).map(c => Number(c.close));
    const avg = mean(xs);
    if (!(avg > 0) || xs.length < 20) return null;
    const variance = mean(xs.map(v => (v - avg) ** 2));
    return (4 * Math.sqrt(variance) / avg) * 100;
  })();
  const priorBbw = [];
  for (let end = Math.max(20, rows.length - 60); end <= rows.length - 20; end += 5) {
    const xs = rows.slice(end - 20, end).map(c => Number(c.close));
    const avg = mean(xs);
    if (!(avg > 0) || xs.length < 20) continue;
    priorBbw.push((4 * Math.sqrt(mean(xs.map(v => (v - avg) ** 2))) / avg) * 100);
  }
  const baselineBbw = median(priorBbw);
  const bollingerCompressionRatio = currentBbw !== null && baselineBbw !== null && baselineBbw > 0
    ? currentBbw / baselineBbw : null;

  const volume = ratioAgainstBaseline(rows, c => candleNotional(c));
  const trades = ratioAgainstBaseline(rows, c => num(c?.tradeCount ?? c?.count));
  const recentBuyShare = buyShare(rows.slice(-3));
  const baselineBuyShare = buyShare(rows.slice(-27, -3));
  const buyShareDelta = recentBuyShare !== null && baselineBuyShare !== null
    ? recentBuyShare - baselineBuyShare : null;
  // REST aggTrades are a distinct recent-execution sample. They are never
  // appended to candles, and they only supersede candle flow when a full,
  // fresh 10-minute sample covers both 5-minute windows.
  const liveTradeFlow = summarizeLiveAggTradeFlow(liveAggTrades, rows, asOf, config);
  const minBuyShare = Number(config.minBuyShare ?? 0.53);
  const minBuyShareDelta = Number(config.minBuyShareDelta ?? 0.01);
  const buyPressureImproving = liveTradeFlow.available
    ? liveTradeFlow.current.buyer_execution_share >= minBuyShare &&
      liveTradeFlow.deltas.buyer_execution_share >= minBuyShareDelta &&
      liveTradeFlow.current.buyer_quote_share >= minBuyShare &&
      liveTradeFlow.deltas.buyer_quote_share >= minBuyShareDelta
    : recentBuyShare !== null && baselineBuyShare !== null && recentBuyShare >= minBuyShare &&
      buyShareDelta !== null && buyShareDelta >= minBuyShareDelta;

  const recentSix = rows.slice(-6);
  const earlierSix = rows.slice(-12, -6);
  const recentLow = recentSix.length ? Math.min(...recentSix.map(c => Number(c.low))) : null;
  const earlierLow = earlierSix.length ? Math.min(...earlierSix.map(c => Number(c.low))) : null;
  const higherLows = earlierLow > 0 && recentLow > 0 && recentLow >= earlierLow * 0.999;
  const recentClose = Number(last.close);
  const resistanceRows = rows.slice(-26, -2);
  const resistance = resistanceRows.length ? Math.max(...resistanceRows.map(c => Number(c.high))) : null;
  const atrPct = currentAtr !== null && recentClose > 0 ? currentAtr / recentClose * 100 : null;
  const resistanceDistancePct = resistance !== null && recentClose > 0 ? (resistance - recentClose) / recentClose * 100 : null;
  const resistanceDistanceAtr = resistanceDistancePct !== null && atrPct > 0 ? resistanceDistancePct / atrPct : null;
  const priorClose = rows.at(-2) ? Number(rows.at(-2).close) : null;
  const prevCloseAbove = resistance !== null && priorClose !== null && priorClose > resistance;
  const lastCloseAbove = resistance !== null && recentClose > resistance;
  const breakoutConfirmed = Boolean(prevCloseAbove && lastCloseAbove);
  const failedBreakout = Number(last.high) > (resistance ?? Infinity) && recentClose <= (resistance ?? -Infinity) &&
    resistance !== null;
  const return5m = returnPct(rows, 1), return15m = returnPct(rows, 3), return1h = returnPct(rows, 12), return4h = returnPct(rows, 48);
  // Anti-chase applies to upward extension only; large selloffs can be a different setup.
  const move1hAtr = currentAtr !== null && currentAtr > 0 && rows.length > 12
    ? (Number(rows.at(-1).close) - Number(rows.at(-13).close)) / currentAtr : null;
  const move15mAtr = currentAtr !== null && currentAtr > 0 && rows.length > 3
    ? (Number(rows.at(-1).close) - Number(rows.at(-4).close)) / currentAtr : null;

  const benchmark5m = returnPct(benchmarkRows, 1);
  const benchmark15m = returnPct(benchmarkRows, 3);
  const benchmark1h = returnPct(benchmarkRows, 12);
  const relative5m = return5m !== null && benchmark5m !== null ? return5m - benchmark5m : null;
  const relative15m = return15m !== null && benchmark15m !== null ? return15m - benchmark15m : null;
  const relative1h = return1h !== null && benchmark1h !== null ? return1h - benchmark1h : null;
  const marketBase = num(marketBaseline24hPct);
  const benchmarkDaily = num(benchmarkTicker?.priceChange24h);
  const relativeMarket24h = marketBase !== null ? daily - marketBase : null;
  const relativeBtc24h = benchmarkDaily !== null ? daily - benchmarkDaily : null;

  const quoteTurnoverScore = quoteVolume24h !== null
    ? clamp(50 + Math.log10(Math.max(1, quoteVolume24h / 750_000)) * 22) : null;
  const spreadScore = book.spread_bps !== null
    ? clamp(100 - Math.max(0, book.spread_bps - 5) * 3.5) : null;
  const depthReference = book.total_quote_depth_within_1pct ??
    (book.top_bid_quote_notional !== null && book.top_ask_quote_notional !== null
      ? book.top_bid_quote_notional + book.top_ask_quote_notional : null);
  const depthScore = depthReference !== null
    ? clamp(25 + Math.log10(Math.max(1, depthReference)) * (book.depth_available ? 18 : 8)) : null;
  const liquidityParts = [[quoteTurnoverScore, 0.55], [spreadScore, 0.25], [depthScore, 0.20]]
    .filter(([v]) => v !== null);
  const liquidityWeight = liquidityParts.reduce((sum, [, w]) => sum + w, 0);
  const liquidityScore = liquidityWeight > 0
    ? liquidityParts.reduce((sum, [v, w]) => sum + v * w, 0) / liquidityWeight : null;

  const compressed = (rangeCompressionRatio !== null && rangeCompressionRatio <= 0.85) ||
    (bollingerCompressionRatio !== null && bollingerCompressionRatio <= 0.88) ||
    (atrRatio !== null && atrRatio <= 0.85);
  const participationImproving = (volume.ratio !== null && volume.ratio >= 1.12) ||
    (trades.ratio !== null && trades.ratio >= 1.08) ||
    (liveTradeFlow.available && liveTradeFlow.deltas.execution_count_vs_previous_5m !== null &&
      liveTradeFlow.deltas.execution_count_vs_previous_5m >= 1.12);
  const nearResistance = resistanceDistanceAtr !== null && resistanceDistanceAtr >= -0.5 && resistanceDistanceAtr <= 3.0;
  const relativeWeak = (relative15m !== null && relative15m < -0.75) ||
    (relative1h !== null && relative1h < -1.5) ||
    (relativeMarket24h !== null && relativeMarket24h < -3.0);
  const extended = daily >= Number(config.maxMove24hPct ?? 12) ||
    (return15m !== null && return15m >= Number(config.maxMove15mPct ?? 4)) ||
    (return1h !== null && return1h >= Number(config.maxMove1hPct ?? 7)) ||
    (move1hAtr !== null && move1hAtr >= Number(config.maxMove1hAtr ?? 4)) ||
    (move15mAtr !== null && move15mAtr >= Number(config.maxMove15mAtr ?? 2.8));
  const structureScore = higherLows ? 85 : recentLow !== null ? 55 : null;
  const compressionScore = mean([
    rangeCompressionRatio !== null ? clamp(100 * (1 - rangeCompressionRatio)) : null,
    bollingerCompressionRatio !== null ? clamp(100 * (1 - bollingerCompressionRatio)) : null,
    atrRatio !== null ? clamp(100 * (1 - atrRatio)) : null
  ].filter(Number.isFinite));
  const volumeScore = volume.ratio !== null ? clamp(50 + Math.log2(Math.max(0.125, volume.ratio)) * 24) : null;
  const tradeScore = trades.ratio !== null ? clamp(50 + Math.log2(Math.max(0.125, trades.ratio)) * 24) : null;
  const flowScore = liveTradeFlow.available
    ? clamp((liveTradeFlow.current.buyer_execution_share - 0.4) * 300 +
      (liveTradeFlow.deltas.buyer_execution_share ?? 0) * 500 +
      (liveTradeFlow.current.buyer_quote_share - 0.4) * 200 +
      (liveTradeFlow.deltas.buyer_quote_share ?? 0) * 250)
    : recentBuyShare !== null ? clamp((recentBuyShare - 0.4) * 500 + (buyShareDelta ?? 0) * 250) : null;
  const resistanceScore = nearResistance ? clamp(100 - Math.max(0, resistanceDistanceAtr) * 18) : 20;
  const relativeScore = mean([relative5m, relative15m, relative1h, relativeMarket24h, relativeBtc24h]
    .filter(Number.isFinite).map(value => clamp(50 + value * 12)));
  const weighted = [
    [compressionScore, 0.20], [structureScore, 0.15], [volumeScore, 0.13],
    [tradeScore, 0.10], [flowScore, 0.16], [relativeScore, 0.12],
    [resistanceScore, 0.08], [liquidityScore, 0.06]
  ].filter(([v]) => v !== null);
  const weight = weighted.reduce((sum, [, w]) => sum + w, 0);
  let score = weight > 0 ? weighted.reduce((sum, [v, w]) => sum + v * w, 0) / weight : null;
  if (score !== null && extended) score = Math.max(0, score - 20);
  if (score !== null && failedBreakout) score = Math.max(0, score - 18);

  let stage = 'NO_SIGNAL';
  let reasons = [];
  if (extended) {
    stage = 'ALREADY_EXTENDED';
    reasons.push('ANTI_CHASE_EXTENSION_LIMIT');
  } else if (failedBreakout) {
    stage = 'WATCH_EARLY';
    reasons.push('FAILED_BREAKOUT_REJECTED');
  } else if (breakoutConfirmed && participationImproving && buyPressureImproving && !relativeWeak) {
    stage = 'BREAKOUT_DEVELOPING';
    reasons.push('CLOSED_BREAKOUT_WITH_ACTIVITY_AND_BUY_FLOW_CONFIRMATION');
  } else if (compressed && higherLows && participationImproving && buyPressureImproving && nearResistance && !relativeWeak) {
    stage = 'PRE_EXPANSION';
    reasons.push('VOLATILITY_COMPRESSION');
    reasons.push('SELF_BASELINE_PARTICIPATION_EXPANSION');
    reasons.push('AGGRESSOR_BUY_PRESSURE_IMPROVING');
    reasons.push('HIGHER_LOW_SUPPORT_AND_NEAR_RESISTANCE');
  } else if (compressed || participationImproving || higherLows || (flowScore !== null && flowScore >= 60)) {
    stage = 'WATCH_EARLY';
    reasons.push('PARTIAL_PRE_EXPANSION_CONFLUENCE');
  }
  if (relativeWeak) reasons.push('RELATIVE_STRENGTH_WEAK_VS_MARKET_OR_BTC');
  if (volume.ratio !== null && volume.ratio >= 1.12) reasons.push('QUOTE_TURNOVER_ABOVE_SELF_BASELINE');
  if (trades.ratio !== null && trades.ratio >= 1.08) reasons.push('TRADE_COUNT_ABOVE_SELF_BASELINE');
  if (book.spread_bps !== null && book.spread_bps > Number(config.maxSpreadBps ?? 22)) reasons.push('WIDE_TOP_OF_BOOK_SPREAD');
  if (book.depth_available && book.depth_imbalance !== null && book.depth_imbalance < -0.18) reasons.push('SELL_SIDE_DEPTH_DOMINANT');

  return {
    ...empty, data_ready: true, stage, score: round(score, 2), reasons: [...new Set(reasons)],
    features: {
      daily_change_24h_pct: round(daily, 4), last_price: round(price, 10),
      quote_volume_24h: quoteVolume24h, trade_count_24h: trades24h,
      quote_turnover_vs_self_baseline: volume.ratio, quote_turnover_baseline: volume.baseline,
      quote_turnover_recent: volume.recent, trade_count_vs_self_baseline: trades.ratio,
      trade_count_baseline: trades.baseline, trade_count_recent: trades.recent,
      taker_buy_quote_share_recent: round(recentBuyShare, 4),
      taker_buy_quote_share_baseline: round(baselineBuyShare, 4),
      taker_buy_quote_share_delta: round(buyShareDelta, 4),
      live_trade_flow: liveTradeFlow,
      buy_pressure_improving: buyPressureImproving,
      range_compression_ratio: round(rangeCompressionRatio, 4),
      bollinger_compression_ratio: round(bollingerCompressionRatio, 4),
      atr_compression_ratio: round(atrRatio, 4), compressed,
      higher_lows: higherLows, recent_support_low: round(recentLow, 10), prior_support_low: round(earlierLow, 10),
      resistance_price: round(resistance, 10), resistance_distance_pct: round(resistanceDistancePct, 4),
      resistance_distance_atr: round(resistanceDistanceAtr, 3), breakout_confirmed_on_closed_candles: breakoutConfirmed,
      failed_breakout: failedBreakout, return_5m_pct: round(return5m, 4), return_15m_pct: round(return15m, 4),
      return_1h_pct: round(return1h, 4), return_4h_pct: round(return4h, 4),
      move_15m_atr: round(move15mAtr, 3), move_1h_atr: round(move1hAtr, 3), extended,
      relative_strength_vs_btc_5m_pct: round(relative5m, 4),
      relative_strength_vs_btc_15m_pct: round(relative15m, 4),
      relative_strength_vs_btc_1h_pct: round(relative1h, 4),
      relative_strength_vs_btc_24h_pct: round(relativeBtc24h, 4),
      relative_strength_vs_market_24h_pct: round(relativeMarket24h, 4),
      liquidity: {quote_turnover_score: round(quoteTurnoverScore, 2), spread_score: round(spreadScore, 2),
        depth_score: round(depthScore, 2), combined_score: round(liquidityScore, 2),
        actual_top_of_book_and_depth: book},
      data_quality: {closed_candles_only: true, rows_used: rows.length, latest_close_time_ms: closeTime,
        age_ms: candleAge, quote_volume_available: quoteVolume24h !== null,
        taker_flow_available: recentBuyShare !== null, live_trade_flow_available: liveTradeFlow.available,
        live_trade_flow_status: liveTradeFlow.status, spread_available: book.spread_bps !== null,
        depth_available: book.depth_available}
    },
    components: {compression: round(compressionScore, 2), structure: round(structureScore, 2),
      volume_participation: round(volumeScore, 2), trade_participation: round(tradeScore, 2),
      buyer_flow: round(flowScore, 2), relative_strength: round(relativeScore, 2),
      resistance_proximity: round(resistanceScore, 2), liquidity: round(liquidityScore, 2)}
  };
}
