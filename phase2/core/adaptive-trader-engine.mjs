const POLICY = Object.freeze({
  minQuoteVolume24h: 750000,
  minClosedCandles: 12,
  maxCandleAgeMs: 20 * 60 * 1000,
  defaultUniverseLimit: 80,
  maxUniverseLimit: 120,
  learningMinOutcomes: 30,
  paperPositionPct: 5,
  maxPaperPositions: 3,
  takeProfitPct: 3,
  stopLossPct: -2,
  maxHoldMs: 4 * 60 * 60 * 1000,
  estimatedRoundTripCostPct: 0.30,
  realOrderExecution: false
});

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const pct = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? (a / b - 1) * 100 : null;
const isLeveragedToken = symbol => /(?:UP|DOWN|BULL|BEAR)USDT$/.test(String(symbol || '').toUpperCase());

function normalizeCandle(row) {
  if (!Array.isArray(row) || row.length < 11) return null;
  const values = {
    openTime: finite(row[0]), open: finite(row[1]), high: finite(row[2]),
    low: finite(row[3]), close: finite(row[4]), volume: finite(row[5]),
    closeTime: finite(row[6]), quoteVolume: finite(row[7]), trades: finite(row[8]),
    takerBuyBaseVolume: finite(row[9]), takerBuyQuoteVolume: finite(row[10])
  };
  if (Object.values(values).some(v => v === null) ||
      values.openTime <= 0 || values.closeTime !== values.openTime + 15 * 60 * 1000 - 1 ||
      values.low <= 0 || values.high < values.low || values.close <= 0 ||
      values.quoteVolume < 0 || values.trades < 0) return null;
  return values;
}

export function scoreAdaptiveTraderCandidate({ symbol, ticker, klines, btcKlines = null, now = Date.now(), minQuoteVolume24h = POLICY.minQuoteVolume24h } = {}) {
  const cleanSymbol = String(symbol || ticker?.symbol || '').trim().toUpperCase();
  const lastPrice = finite(ticker?.lastPrice ?? ticker?.last_price);
  const quoteVolume24h = finite(ticker?.quoteVolume ?? ticker?.quote_volume_24h);
  const change24hPct = finite(ticker?.priceChangePercent ?? ticker?.price_change_24h);
  const receivedAt = finite(klines?.receivedAt);
  const scanStartedAt = finite(now) ?? Date.now();
  // REST receive time is local transport metadata, not exchange candle time. A
  // slow scan may finish after scanStartedAt; evaluate candles at the response
  // time instead of misclassifying that fresh response as data from the future.
  const evaluationNow = receivedAt !== null && receivedAt <= scanStartedAt + 5 * 60 * 1000
    ? Math.max(scanStartedAt, receivedAt)
    : scanStartedAt;
  const candles = (Array.isArray(klines?.data) ? klines.data : Array.isArray(klines) ? klines : [])
    .map(normalizeCandle).filter(Boolean).filter(candle => candle.closeTime < evaluationNow)
    .sort((a, b) => a.closeTime - b.closeTime);
  const source = String(klines?.source || 'BINANCE_PUBLIC_REST');

  const base = {
    symbol: cleanSymbol,
    price: lastPrice,
    quote_volume_24h: quoteVolume24h,
    change_24h_pct: change24hPct,
    source,
    data_valid: false,
    data_stale: false,
    closed_candles_only: true,
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  };

  if (!/^[A-Z0-9]{5,30}$/.test(cleanSymbol) || !cleanSymbol.endsWith('USDT') ||
      isLeveragedToken(cleanSymbol) || !(lastPrice > 0) || !(quoteVolume24h >= minQuoteVolume24h) ||
      change24hPct === null) {
    return { ...base, tier: 'DATA_REJECTED', score: null, reason_codes: ['UNIVERSE_OR_TICKER_GATE'] };
  }
  if (receivedAt !== null && (receivedAt > scanStartedAt + 5 * 60 * 1000 || scanStartedAt - receivedAt > 5 * 60 * 1000)) {
    return { ...base, data_stale: true, tier: 'DATA_REJECTED', score: null, reason_codes: ['TICKER_SNAPSHOT_STALE_OR_FUTURE'] };
  }
  if (candles.length < POLICY.minClosedCandles) {
    return { ...base, data_stale: candles.length > 0 && evaluationNow - candles[candles.length - 1].closeTime > POLICY.maxCandleAgeMs,
      tier: 'DATA_REJECTED', score: null, reason_codes: ['INSUFFICIENT_CLOSED_CANDLES'] };
  }

  const current = candles[candles.length - 1];
  const recentWindow = candles.slice(-12);
  const hasCandleGaps = recentWindow.some((candle, index) => index > 0 &&
    candle.openTime - recentWindow[index - 1].openTime !== 15 * 60 * 1000);
  if (hasCandleGaps) {
    return { ...base, tier: 'DATA_REJECTED', score: null, reason_codes: ['CLOSED_CANDLE_GAPS'] };
  }
  const candleAgeMs = evaluationNow - current.closeTime;
  if (candleAgeMs < 0 || candleAgeMs > POLICY.maxCandleAgeMs) {
    return { ...base, data_stale: true, tier: 'DATA_REJECTED', score: null, candle_age_ms: candleAgeMs,
      reason_codes: ['CLOSED_CANDLE_STALE_OR_FUTURE'] };
  }

  const prior8 = candles.slice(-9, -1);
  const prior3 = candles.slice(-4, -1);
  const previous8Ranges = candles.slice(-12, -4).map(c => (c.high - c.low) / c.close * 100);
  const recent4Ranges = candles.slice(-4).map(c => (c.high - c.low) / c.close * 100);
  const volumeBaseline = mean(prior8.map(c => c.quoteVolume));
  const tradeBaseline = mean(prior8.map(c => c.trades));
  const volumeRatio = volumeBaseline > 0 ? current.quoteVolume / volumeBaseline : null;
  const tradeRatio = tradeBaseline > 0 ? current.trades / tradeBaseline : null;
  const takerBuyRatio = current.quoteVolume > 0
    ? current.takerBuyQuoteVolume / current.quoteVolume : null;
  const closeLocation = current.high > current.low
    ? clamp((current.close - current.low) / (current.high - current.low), 0, 1) : 0.5;
  const priorHigh = Math.max(...prior3.map(c => c.high));
  const breakoutAbovePriorHigh = current.close > priorHigh;
  const higherLow = candles[candles.length - 1].low > candles[candles.length - 2].low &&
    candles[candles.length - 2].low >= candles[candles.length - 3].low;
  const priorRange = mean(previous8Ranges);
  const recentRange = mean(recent4Ranges);
  const compressionRatio = priorRange > 0 && recentRange !== null ? recentRange / priorRange : null;
  const compressionScore = compressionRatio === null ? 0 : clamp((1.5 - compressionRatio) / 1.2 * 100, 0, 100);
  const oneHourReturnPct = candles.length >= 5 ? pct(current.close, candles[candles.length - 5].close) : null;
  const shortReturnPct = candles.length >= 2 ? pct(current.close, candles[candles.length - 2].close) : null;
  const btcReceivedAt = finite(btcKlines?.receivedAt);
  const btcEvaluationNow = btcReceivedAt !== null && btcReceivedAt <= scanStartedAt + 5 * 60 * 1000
    ? Math.max(scanStartedAt, btcReceivedAt)
    : scanStartedAt;
  const btcCandles = (Array.isArray(btcKlines?.data) ? btcKlines.data : Array.isArray(btcKlines) ? btcKlines : [])
    .map(normalizeCandle).filter(Boolean).filter(candle => candle.closeTime < btcEvaluationNow).sort((a,b)=>a.closeTime-b.closeTime);
  const btcLast = btcCandles[btcCandles.length-1];
  const btcRecent = btcCandles.slice(-5);
  const btcContiguous = btcRecent.length===5 && btcRecent.every((candle,index)=>index===0||candle.openTime-btcRecent[index-1].openTime===15*60*1000);
  const btcOneHourReturnPct = btcContiguous && btcLast && btcEvaluationNow-btcLast.closeTime<=POLICY.maxCandleAgeMs
    ? pct(btcLast.close,btcCandles[btcCandles.length-5].close) : null;
  const relativeStrengthVsBtcPct = oneHourReturnPct!==null&&btcOneHourReturnPct!==null
    ? Number((oneHourReturnPct-btcOneHourReturnPct).toFixed(3)) : null;

  const volumeScore = volumeRatio === null ? 0 : clamp((volumeRatio - 0.5) / 2.5 * 100, 0, 100);
  const tradeScore = tradeRatio === null ? 0 : clamp((tradeRatio - 0.5) / 2.0 * 100, 0, 100);
  const flowScore = takerBuyRatio === null ? 0 : clamp((takerBuyRatio - 0.45) / 0.25 * 100, 0, 100);
  const structureScore = breakoutAbovePriorHigh ? 95 : higherLow ? 74 : closeLocation >= 0.65 ? 56 : 32;
  const relativeStrengthScore = relativeStrengthVsBtcPct===null ? 50 : clamp((relativeStrengthVsBtcPct+2)/4*100,0,100);
  const score = Number((
    volumeScore * 0.18 +
    tradeScore * 0.13 +
    flowScore * 0.18 +
    closeLocation * 100 * 0.14 +
    structureScore * 0.19 +
    compressionScore * 0.08 +
    relativeStrengthScore * 0.10
  ).toFixed(1));

  const lateMove = change24hPct >= 8 || (oneHourReturnPct !== null && oneHourReturnPct >= 5);
  const noChase = change24hPct >= -5 && !lateMove && change24hPct <= 7 &&
    (oneHourReturnPct === null || oneHourReturnPct <= 4) &&
    (relativeStrengthVsBtcPct === null || relativeStrengthVsBtcPct >= -0.25);
  const earlySetup = score >= 68 && volumeRatio !== null && volumeRatio >= 1.5 &&
    tradeRatio !== null && tradeRatio >= 1.25 && takerBuyRatio !== null && takerBuyRatio >= 0.52 &&
    closeLocation >= 0.58 && (higherLow || breakoutAbovePriorHigh) && noChase;

  let tier = 'NO_SETUP';
  if (lateMove) tier = 'LATE_MOVE';
  else if (earlySetup) tier = 'EARLY_SETUP';
  else if (score >= 52) tier = 'WATCH';
  const reasons = [];
  if (volumeRatio !== null && volumeRatio >= 1.5) reasons.push('VOLUME_ACTIVITY_EXPANDING');
  else reasons.push('VOLUME_ACCELERATION_NOT_CONFIRMED');
  if (tradeRatio !== null && tradeRatio >= 1.25) reasons.push('TRADE_ACTIVITY_EXPANDING');
  else reasons.push('TRADE_ACCELERATION_NOT_CONFIRMED');
  if (takerBuyRatio !== null && takerBuyRatio >= 0.52) reasons.push('BUY_FLOW_POSITIVE');
  else reasons.push('BUY_FLOW_NOT_CONFIRMED');
  if (higherLow) reasons.push('HIGHER_LOW_STRUCTURE');
  if (breakoutAbovePriorHigh) reasons.push('CLOSED_CANDLE_LOCAL_BREAKOUT');
  if (compressionRatio !== null && compressionRatio <= 0.8) reasons.push('VOLATILITY_COMPRESSION');
  if (relativeStrengthVsBtcPct !== null && relativeStrengthVsBtcPct >= 0.25) reasons.push('RELATIVE_STRENGTH_VS_BTC');
  if (relativeStrengthVsBtcPct === null) reasons.push('BTC_BENCHMARK_UNAVAILABLE');
  if (change24hPct < -5) reasons.push('DAILY_DRAWDOWN_BLOCK');
  if (!noChase) reasons.push('ANTI_CHASE_BLOCK');
  if (lateMove) reasons.push('ALREADY_EXTENDED');

  return {
    ...base,
    data_valid: true,
    data_stale: false,
    as_of: new Date(evaluationNow).toISOString(),
    candle_close_time: current.closeTime,
    candle_age_ms: candleAgeMs,
    score,
    tier,
    entry_eligible: false,
    paper_candidate: earlySetup,
    features: {
      volume_ratio: Number((volumeRatio ?? 0).toFixed(3)),
      trade_ratio: Number((tradeRatio ?? 0).toFixed(3)),
      taker_buy_ratio: Number((takerBuyRatio ?? 0).toFixed(4)),
      close_location: Number(closeLocation.toFixed(4)),
      higher_low: higherLow,
      breakout_above_prior_high: breakoutAbovePriorHigh,
      compression_ratio: compressionRatio === null ? null : Number(compressionRatio.toFixed(3)),
      compression_score: Number(compressionScore.toFixed(1)),
      hourly_return_pct: oneHourReturnPct === null ? null : Number(oneHourReturnPct.toFixed(3)),
      btc_hourly_return_pct: btcOneHourReturnPct === null ? null : Number(btcOneHourReturnPct.toFixed(3)),
      relative_strength_vs_btc_pct: relativeStrengthVsBtcPct,
      relative_strength_score: Number(relativeStrengthScore.toFixed(1)),
      recent_15m_return_pct: shortReturnPct === null ? null : Number(shortReturnPct.toFixed(3)),
      base_price: current.close
    },
    reason_codes: reasons,
    thresholds: {
      min_quote_volume_24h: minQuoteVolume24h,
      no_chase: noChase,
      late_move: lateMove,
      policy_revision: 'ADAPTIVE_SIDECAR_V1'
    }
  };
}

async function mapLimit(items, limit, worker) {
  const result = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { result[index] = await worker(items[index], index); }
      catch (error) { result[index] = { error: String(error?.message || error).slice(0, 160) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, runner));
  return result;
}

export async function buildAdaptiveTraderMarketSnapshot({ rest, limit = POLICY.defaultUniverseLimit, now = Date.now(),
  minQuoteVolume24h = POLICY.minQuoteVolume24h } = {}) {
  if (!rest || typeof rest.request !== 'function') throw new Error('ADAPTIVE_TRADER_REST_UNAVAILABLE');
  const safeLimit = clamp(Math.trunc(Number(limit) || POLICY.defaultUniverseLimit), 20, POLICY.maxUniverseLimit);
  // BTC is only a comparative benchmark. A failure to fetch it must not block
  // the entire Spot universe when valid per-symbol closed candles are available.
  const [exchangeInfo, tickerResult, btcResult] = await Promise.all([
    rest.request('/api/v3/exchangeInfo'),
    rest.request('/api/v3/ticker/24hr'),
    rest.request('/api/v3/klines', { symbol: 'BTCUSDT', interval: '15m', limit: 20 })
      .then(value => ({value,error:null}))
      .catch(error => ({value:null,error:String(error?.message??error).slice(0,160)}))
  ]);
  const btcKlines = btcResult.value;
  const symbolInfo = Array.isArray(exchangeInfo?.data?.symbols) ? exchangeInfo.data.symbols : [];
  const activeSpot = new Set(symbolInfo.filter(item =>
    item && item.status === 'TRADING' && item.quoteAsset === 'USDT' &&
    item.isSpotTradingAllowed !== false &&
    (!Array.isArray(item.permissions) || item.permissions.length === 0 || item.permissions.includes('SPOT'))
  ).map(item => String(item.symbol || '').toUpperCase()));
  const tickers = Array.isArray(tickerResult?.data) ? tickerResult.data : [];
  const eligible = tickers.filter(row => {
    const symbol = String(row?.symbol || '').toUpperCase();
    return activeSpot.has(symbol) && symbol.endsWith('USDT') && !isLeveragedToken(symbol) &&
      finite(row?.lastPrice) > 0 && finite(row?.quoteVolume) >= minQuoteVolume24h;
  }).sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
  const selected = eligible.slice(0, safeLimit);

  const analyzed = await mapLimit(selected, 5, async ticker => {
    const result = await rest.request('/api/v3/klines', { symbol: ticker.symbol, interval: '15m', limit: 20 });
    return scoreAdaptiveTraderCandidate({ symbol: ticker.symbol, ticker, klines: result, btcKlines, now, minQuoteVolume24h });
  });
  const candidates = analyzed.map((row, index) => row && !row.error
    ? row
    : {
      symbol: selected[index]?.symbol || 'UNKNOWN',
      price: finite(selected[index]?.lastPrice),
      quote_volume_24h: finite(selected[index]?.quoteVolume),
      data_valid: false,
      data_stale: false,
      source: 'BINANCE_PUBLIC_REST',
      tier: 'DATA_UNAVAILABLE',
      score: null,
      reason_codes: ['KLINE_FETCH_FAILED'],
      error: String(row?.error || 'KLINE_FETCH_FAILED'),
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN'
    });
  candidates.sort((a, b) => (Number(b.score) || -1) - (Number(a.score) || -1));
  const validCount = candidates.filter(row => row.data_valid && !row.data_stale).length;
  const source = String(tickerResult?.source || exchangeInfo?.source || 'BINANCE_PUBLIC_REST');
  return {
    status: validCount > 0 ? 'LIVE_DATA' : 'DATA_UNAVAILABLE',
    source: 'Binance Public REST',
    as_of: new Date(Number(now)).toISOString(),
    universe: {
      quote: 'USDT',
      eligible_spot_symbols: eligible.length,
      analyzed_symbols: candidates.length,
      valid_symbols: validCount,
      requested_limit: safeLimit,
      coverage_pct: eligible.length ? Number((candidates.length / eligible.length * 100).toFixed(1)) : 0,
      scan_complete: candidates.length === eligible.length,
      min_quote_volume_24h: minQuoteVolume24h,
      excluded_leveraged_tokens: true
    },
    candidates,
    latest_prices: eligible.map(row => ({
      symbol: String(row.symbol),
      price: finite(row.lastPrice),
      quote_volume_24h: finite(row.quoteVolume),
      change_24h_pct: finite(row.priceChangePercent)
    })),
    meta: {
      live: validCount > 0,
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN',
      closed_candles_only: true,
      engine: 'ADAPTIVE_TRADER_SIDECAR_V1',
      execution: 'DISABLED',
      learning_scope: 'LOCAL_DEVICE_PAPER_OUTCOMES_ONLY',
      source_host: source,
      btc_benchmark_available: Boolean(btcKlines?.data),
      btc_benchmark_error: btcResult.error,
      cache_policy: 'SERVER_PUBLIC_REST_CACHE'
    }
  };
}

export function createAdaptiveTraderSnapshotService({
  rest, ttlMs = 90000, minQuoteVolume24h = POLICY.minQuoteVolume24h, scanTimeoutMs = 45_000
} = {}) {
  const cache = new Map();
  const flights = new Map();
  const getSnapshot = async ({ limit = POLICY.defaultUniverseLimit, now = Date.now() } = {}) => {
    const safeLimit = clamp(Math.trunc(Number(limit) || POLICY.defaultUniverseLimit), 20, POLICY.maxUniverseLimit);
    const hit = cache.get(safeLimit);
    if (hit && Number(now) - hit.cachedAt < ttlMs) {
      return {
        ...hit.snapshot,
        meta: { ...hit.snapshot.meta, cache_mode: 'FRESH_SERVER_CACHE', cache_age_ms: Math.max(0, Number(now) - hit.cachedAt) }
      };
    }
    // One sidecar scan at a time; the REST client uses a process-shared budget
    // with the other radars. Coalescing different universe requests avoids a
    // burst of overlapping 40/80/120-pair scans on that shared budget.
    const active = flights.values().next().value;
    if (active) {
      // Preserve the requested universe size, but wait until the current scan
      // releases the shared REST budget before starting another scan.
      try { await active; } catch {}
      return getSnapshot({ limit: safeLimit, now: Date.now() });
    }
    const previousDeadline = Number(rest.requestDeadlineAtMs) > 0 ? Number(rest.requestDeadlineAtMs) : null;
    const deadline = Date.now() + Math.max(5_000, Math.min(60_000, Math.trunc(Number(scanTimeoutMs) || 45_000)));
    rest.requestDeadlineAtMs = previousDeadline === null ? deadline : Math.min(previousDeadline, deadline);
    const effectiveDeadline = rest.requestDeadlineAtMs;
    const task = buildAdaptiveTraderMarketSnapshot({ rest, limit: safeLimit, now, minQuoteVolume24h }).then(snapshot => {
      const cachedAt = Date.now();
      cache.set(safeLimit, { snapshot, cachedAt });
      // Only the supported dashboard tiers are used in production. Keep this cache bounded even if callers vary inputs.
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return { ...snapshot, meta: { ...snapshot.meta, cache_mode: 'FRESH_SCAN', cache_age_ms: 0 } };
    }).finally(() => {
      if (rest.requestDeadlineAtMs === effectiveDeadline) rest.requestDeadlineAtMs = previousDeadline;
      for (const [key, activeTask] of flights) if (activeTask === task) flights.delete(key);
    });
    flights.set(safeLimit, task);
    return task;
  };
  return getSnapshot;
}

export function buildAdaptiveLearningProfile(samples = [], { minSamples = POLICY.learningMinOutcomes, minimumBucket = 8 } = {}) {
  const resolved = (Array.isArray(samples) ? samples : []).filter(row =>
    row && ['UP', 'DOWN', 'FLAT'].includes(row.outcome) && row.features && typeof row.features === 'object');
  const positive = resolved.filter(row => row.outcome === 'UP').length;
  const overallRate = resolved.length ? (positive + 2) / (resolved.length + 4) : 0.5;
  const featureKeys = {
    volume: row => finite(row.features.volume_ratio) !== null && Number(row.features.volume_ratio) >= 1.5,
    buyer_flow: row => finite(row.features.taker_buy_ratio) !== null && Number(row.features.taker_buy_ratio) >= 0.52,
    structure: row => row.features.higher_low === true || row.features.breakout_above_prior_high === true,
    compression: row => finite(row.features.compression_ratio) !== null && Number(row.features.compression_ratio) <= 0.8
  };
  const buckets = {};
  const adjustments = {};
  for (const [key, matcher] of Object.entries(featureKeys)) {
    const rows = resolved.filter(matcher);
    const wins = rows.filter(row => row.outcome === 'UP').length;
    const rate = (wins + 2) / (rows.length + 4);
    buckets[key] = { samples: rows.length, wins, positive_rate_pct: Number((rate * 100).toFixed(1)) };
    adjustments[key] = rows.length >= minimumBucket
      ? Number(clamp((rate - overallRate) * 20, -4, 4).toFixed(2)) : 0;
  }
  const ready = resolved.length >= minSamples &&
    Object.values(buckets).filter(x => x.samples >= minimumBucket).length >= 3;
  return {
    ready,
    resolved_samples: resolved.length,
    required_samples: minSamples,
    positive_outcome_rate_pct: Number((overallRate * 100).toFixed(1)),
    adjustments: ready ? adjustments : { volume: 0, buyer_flow: 0, structure: 0, compression: 0 },
    buckets,
    note: ready
      ? 'CALIBRATION_ONLY_NO_AUTOMATIC_RULE_OR_EXECUTION_CHANGES'
      : 'INSUFFICIENT_OUTCOMES_NO_LEARNING_ADJUSTMENT_APPLIED'
  };
}

export function applyAdaptiveLearning(baseScore, features = {}, profile = {}) {
  const score = finite(baseScore);
  if (score === null) return null;
  if (profile?.ready !== true) return Number(clamp(score, 0, 100).toFixed(1));
  const active = [];
  if (finite(features.volume_ratio) !== null && Number(features.volume_ratio) >= 1.5) active.push(finite(profile.adjustments?.volume) || 0);
  if (finite(features.taker_buy_ratio) !== null && Number(features.taker_buy_ratio) >= 0.52) active.push(finite(profile.adjustments?.buyer_flow) || 0);
  if (features.higher_low === true || features.breakout_above_prior_high === true) active.push(finite(profile.adjustments?.structure) || 0);
  if (finite(features.compression_ratio) !== null && Number(features.compression_ratio) <= 0.8) active.push(finite(profile.adjustments?.compression) || 0);
  const delta = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  return Number(clamp(score + clamp(delta, -4, 4), 0, 100).toFixed(1));
}

export function findMissedMoverEvents({ history = [], currentPrices = [], now = Date.now(), thresholdPct = 5, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const current = new Map((Array.isArray(currentPrices) ? currentPrices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price ?? row?.lastPrice)]));
  const newestQualifying = new Map();
  const newestEvaluatedQualifying = new Map();
  for (const row of (Array.isArray(history) ? history : [])) {
    const symbol = String(row?.symbol || '').toUpperCase();
    const at = finite(row?.at);
    const price = finite(row?.price);
    if (!symbol || at === null || price === null || price <= 0 || at >= Number(now) ||
        Number(now) - at < 15 * 60 * 1000 || Number(now) - at > maxAgeMs) continue;
    const livePrice = current.get(symbol);
    if (!(livePrice > 0)) continue;
    const move = (livePrice / price - 1) * 100;
    if (move < thresholdPct) continue;
    const candidate = { ...row, symbol, at, price, move };
    const prior = newestQualifying.get(symbol);
    if (!prior || at > prior.at) newestQualifying.set(symbol, candidate);
    if (row.evaluated === true) {
      const evaluatedPrior = newestEvaluatedQualifying.get(symbol);
      if (!evaluatedPrior || at > evaluatedPrior.at) newestEvaluatedQualifying.set(symbol, candidate);
    }
  }
  const events = [];
  for (const [symbol, fallback] of newestQualifying) {
    // Prefer the latest snapshot the detector truly analyzed. A later unassessed
    // snapshot must not erase evidence that a previously analyzed setup was missed.
    const previous = newestEvaluatedQualifying.get(symbol) || fallback;
    const price = current.get(symbol);
    const move = (price / previous.price - 1) * 100;
    const previousTier = String(previous.tier || 'NOT_EVALUATED');
    const wasEvaluated = previous.evaluated === true;
    const wasOnRadar = wasEvaluated && ['EARLY_SETUP', 'WATCH'].includes(previousTier);
    events.push({
      id: symbol + ':' + String(previous.at),
      symbol,
      baseline_at: new Date(previous.at).toISOString(),
      baseline_price: previous.price,
      current_price: price,
      move_pct: Number(move.toFixed(2)),
      baseline_tier: previousTier,
      baseline_was_evaluated: wasEvaluated,
      classification: !wasEvaluated ? 'UNASSESSED_MOVE' : wasOnRadar ? 'FOLLOW_UP_MOVE' : 'POTENTIAL_MISSED_MOVER',
      diagnostic_only: true,
      reason: 'OBSERVED_PRICE_MOVED_AFTER_PRIOR_SNAPSHOT',
      no_future_data_used_for_baseline: true
    });
  }
  return events.sort((a, b) => b.move_pct - a.move_pct);
}

export function createPaperPortfolio(startingBalance = 10000) {
  const amount = finite(startingBalance);
  const balance = amount !== null && amount > 0 ? amount : 10000;
  return {
    version: 1,
    mode: 'PAPER_ONLY',
    enabled: false,
    starting_balance: balance,
    cash: balance,
    open_positions: [],
    closed_trades: [],
    created_at: Date.now(),
    paper_trading: true,
    real_order_execution: false
  };
}

export function openPaperPosition(portfolio, candidate, now = Date.now()) {
  if (!portfolio || portfolio.enabled !== true || portfolio.real_order_execution !== false) return { opened: false, reason: 'PAPER_MODE_DISABLED' };
  if (!candidate || candidate.data_valid !== true || candidate.data_stale === true ||
      candidate.closed_candles_only !== true || candidate.real_order_execution !== false ||
      candidate.tier !== 'EARLY_SETUP' || candidate.paper_candidate !== true ||
      candidate.entry_eligible !== false || !candidate.thresholds?.no_chase ||
      !candidate.features || Number(candidate.score) < 68 ||
      Number(candidate.features.volume_ratio) < 1.5 ||
      Number(candidate.features.trade_ratio) < 1.25 ||
      Number(candidate.features.taker_buy_ratio) < 0.52 ||
      Number(candidate.features.close_location) < 0.58 ||
      Number(candidate.quote_volume_24h) < POLICY.minQuoteVolume24h) {
    return { opened: false, reason: 'STRICT_PAPER_SETUP_GATE_FAILED' };
  }
  const symbol = String(candidate.symbol || '').toUpperCase();
  const price = finite(candidate.price);
  if (!symbol.endsWith('USDT') || !(price > 0)) return { opened: false, reason: 'PAPER_SYMBOL_OR_PRICE_INVALID' };
  if ((portfolio.open_positions || []).some(row => row.symbol === symbol)) return { opened: false, reason: 'PAPER_POSITION_ALREADY_OPEN' };
  if ((portfolio.open_positions || []).length >= POLICY.maxPaperPositions) return { opened: false, reason: 'PAPER_POSITION_LIMIT' };
  const equity = estimatePaperEquity(portfolio);
  const notional = Math.min(Number(portfolio.cash) || 0, equity * POLICY.paperPositionPct / 100);
  if (!(notional > 0)) return { opened: false, reason: 'PAPER_CASH_EXHAUSTED' };
  const position = {
    id: 'PAPER:' + symbol + ':' + String(now),
    symbol,
    entry_price: price,
    mark_price: price,
    quantity: notional / price,
    notional,
    opened_at: Number(now),
    entry_score: Number(candidate.score),
    entry_features: { ...candidate.features },
    mode: 'PAPER_ONLY',
    paper_trading: true,
    real_order_execution: false
  };
  portfolio.cash = Number(portfolio.cash) - notional;
  portfolio.open_positions = [...(portfolio.open_positions || []), position];
  return { opened: true, reason: null, position: { ...position }, portfolio };
}

export function advancePaperPortfolio(portfolio, currentPrices = [], now = Date.now()) {
  if (!portfolio || portfolio.real_order_execution !== false || portfolio.mode !== 'PAPER_ONLY') {
    throw new Error('PAPER_PORTFOLIO_POLICY_VIOLATION');
  }
  const prices = new Map((Array.isArray(currentPrices) ? currentPrices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price)]));
  const open = [];
  const newlyClosed = [];
  for (const position of (portfolio.open_positions || [])) {
    const price = prices.get(String(position.symbol || '').toUpperCase());
    const mark = price !== null && price !== undefined && price > 0 ? price : finite(position.mark_price) || finite(position.entry_price);
    const entry = finite(position.entry_price);
    const age = Number(now) - Number(position.opened_at);
    const gross = entry > 0 ? (mark / entry - 1) * 100 : 0;
    const reason = gross >= POLICY.takeProfitPct ? 'PAPER_TAKE_PROFIT'
      : gross <= POLICY.stopLossPct ? 'PAPER_STOP_LOSS'
      : age >= POLICY.maxHoldMs ? 'PAPER_TIME_EXIT' : null;
    if (reason) {
      const notional = Number(position.notional) || 0;
      const pnl = notional * (gross - POLICY.estimatedRoundTripCostPct) / 100;
      portfolio.cash = Number(portfolio.cash) + notional + pnl;
      newlyClosed.push({
        ...position, exit_price: mark, closed_at: Number(now), gross_return_pct: Number(gross.toFixed(3)),
        net_pnl: Number(pnl.toFixed(4)), net_return_pct: Number((gross - POLICY.estimatedRoundTripCostPct).toFixed(3)),
        exit_reason: reason, paper_trading: true, real_order_execution: false
      });
    } else {
      open.push({ ...position, mark_price: mark, gross_return_pct: Number(gross.toFixed(3)),
        estimated_net_pnl: Number((Number(position.notional) * (gross - 0.15) / 100).toFixed(4)),
        age_ms: Math.max(0, age) });
    }
  }
  portfolio.open_positions = open;
  portfolio.closed_trades = [...(portfolio.closed_trades || []), ...newlyClosed].slice(-2000);
  portfolio.updated_at = Number(now);
  return { portfolio, newlyClosed, equity: estimatePaperEquity(portfolio), real_order_execution: false };
}

export function estimatePaperEquity(portfolio) {
  const cash = finite(portfolio?.cash) || 0;
  const marked = (Array.isArray(portfolio?.open_positions) ? portfolio.open_positions : []).reduce((sum, position) => {
    const entry = finite(position.entry_price);
    const mark = finite(position.mark_price) || entry;
    return sum + (entry > 0 ? (Number(position.notional) || 0) * mark / entry : 0);
  }, 0);
  const floatingCost = (Array.isArray(portfolio?.open_positions) ? portfolio.open_positions : []).reduce((sum, position) =>
    sum + (Number(position.notional) || 0) * 0.0015, 0);
  return Number((cash + marked - floatingCost).toFixed(2));
}

export const ADAPTIVE_TRADER_POLICY = POLICY;
