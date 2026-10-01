import {
  evaluateSymbolSnapshot,
  validateSeries,
  lastClosedIndex,
  liquidityQuality as scoreLiquidity
} from '../../phase1/radarx-phase1-engine.mjs';

export const MARKET_RADAR_DEFAULTS = Object.freeze({
  quote: 'USDT',
  scanLimit: 20,
  maxScanLimit: 50,
  returnLimit: 20,
  deepConcurrency: 4,
  deepKlines: 250,
  minQuoteVolume24h: 750000,
  minDataQuality: 70,
  minLiquidityQuality: 60,
  maxTriggerAgeMs: 30 * 60 * 1000,
  retryAttempts: 2,
  retryBaseMs: 200,
  maxBackoffMs: 2000
});

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const unique = a => [...new Set(a)];

export function normalizeRadarLimit(raw, defaults = MARKET_RADAR_DEFAULTS) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaults.scanLimit;
  return Math.max(1, Math.min(defaults.maxScanLimit, Math.trunc(n)));
}

export function validSymbolName(symbol) {
  return /^[A-Z0-9]{2,30}$/.test(String(symbol || '').toUpperCase());
}

export function isSpotTradableSymbol(symbol, quote) {
  if (!symbol || !validSymbolName(symbol.symbol)) return false;
  if (String(symbol.status || '').toUpperCase() !== 'TRADING') return false;
  if (String(symbol.quoteAsset || '').toUpperCase() !== quote) return false;
  if (symbol.isSpotTradingAllowed === false) return false;
  if (Array.isArray(symbol.permissions) && symbol.permissions.length && !symbol.permissions.includes('SPOT')) return false;
  if (!validSymbolName(symbol.baseAsset) || !validSymbolName(symbol.quoteAsset)) return false;
  if (String(symbol.baseAsset).toUpperCase() === quote) return false;
  if (String(symbol.symbol).toUpperCase() !== String(symbol.baseAsset).toUpperCase() + quote) return false;
  return true;
}

export function buildSpotUniverse(exchangeInfo, quote = MARKET_RADAR_DEFAULTS.quote) {
  const q = String(quote || MARKET_RADAR_DEFAULTS.quote).trim().toUpperCase();
  if (!Array.isArray(exchangeInfo?.symbols)) throw new Error('INVALID_EXCHANGE_INFO');
  const symbols = exchangeInfo.symbols
    .filter(x => isSpotTradableSymbol(x, q))
    .map(x => ({
      symbol: String(x.symbol).toUpperCase(),
      baseAsset: String(x.baseAsset).toUpperCase(),
      quoteAsset: q,
      status: String(x.status).toUpperCase()
    }));
  return unique(symbols.map(x => x.symbol)).map(symbol => symbols.find(x => x.symbol === symbol));
}

function logNorm(value, lo, hi) {
  const n = Math.log10(Math.max(1, Number(value)));
  const a = Math.log10(Math.max(1, lo));
  const b = Math.log10(Math.max(1, hi));
  if (b <= a) return n >= b ? 100 : 0;
  return Math.max(0, Math.min(100, (n - a) / (b - a) * 100));
}

export function normalizeTickerRow(ticker, quote) {
  if (!ticker || !validSymbolName(ticker.symbol)) return null;
  const symbol = String(ticker.symbol).toUpperCase();
  const lastPrice = Number(ticker.lastPrice);
  const quoteVolume = Number(ticker.quoteVolume);
  const count = Number(ticker.count);
  const change = Number(ticker.priceChangePercent);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  if (!Number.isFinite(quoteVolume) || quoteVolume < 0) return null;
  if (!Number.isFinite(count) || count < 0) return null;
  if (!Number.isFinite(change)) return null;
  return {
    symbol,
    quoteAsset: String(quote).toUpperCase(),
    lastPrice,
    quoteVolume24h: quoteVolume,
    tradeCount24h: count,
    priceChange24h: change
  };
}

export function rankTickerRows(tickers, symbols, {
  minQuoteVolume24h = MARKET_RADAR_DEFAULTS.minQuoteVolume24h,
  limit = MARKET_RADAR_DEFAULTS.scanLimit
} = {}) {
  const allowed = new Set(symbols.map(x => x.symbol));
  const rows = (Array.isArray(tickers) ? tickers : [])
    .map(x => normalizeTickerRow(x, symbols[0]?.quoteAsset || 'USDT'))
    .filter(Boolean)
    .filter(x => allowed.has(x.symbol))
    .filter(x => x.quoteVolume24h >= minQuoteVolume24h);
  const maxVolume = Math.max(minQuoteVolume24h * 1000, ...rows.map(x => x.quoteVolume24h));
  const maxTrades = Math.max(1000000, ...rows.map(x => x.tradeCount24h));

  return rows
    .map(x => ({
      ...x,
      pre_rank_score:
        logNorm(x.quoteVolume24h, minQuoteVolume24h, maxVolume) * 0.55 +
        logNorm(x.tradeCount24h, 100, maxTrades) * 0.25 +
        Math.max(0, Math.min(100, Math.abs(x.priceChange24h) * 5)) * 0.20
    }))
    .sort((a, b) =>
      b.pre_rank_score - a.pre_rank_score ||
      b.quoteVolume24h - a.quoteVolume24h ||
      b.tradeCount24h - a.tradeCount24h ||
      a.symbol.localeCompare(b.symbol)
    )
    .slice(0, Math.max(0, Math.trunc(limit)));
}

function normalizeRawKlines(rows, source, now) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 11) return null;
    return {
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
      quoteVolume: Number(row[7]),
      tradeCount: Number(row[8]),
      takerBuyBaseVolume: Number(row[9]),
      takerBuyQuoteVolume: Number(row[10]),
      closed: Number(row[6]) < now,
      source: 'BINANCE_PUBLIC_REST',
      sourceUrl: source ?? null
    };
  }).filter(Boolean);
}

function futureData(candles, now) {
  return candles.some(c => Number(c.openTime) > now || Number(c.closeTime) > now);
}

function latestClosed(candles) {
  const index = lastClosedIndex(candles);
  return index >= 0 ? candles[index] : null;
}

function freshnessMs(candles, fetchedAt) {
  const last = latestClosed(candles);
  if (!last) return Infinity;
  return Math.max(0, fetchedAt - Number(last.closeTime));
}

function describeStrategy(strategy) {
  if (!strategy) return null;
  const score = Object.values(strategy.score || {}).find(v => Number.isFinite(Number(v)));
  return {
    id: strategy.strategy || 'UNKNOWN',
    state: strategy.state || 'REJECTED',
    direction: strategy.direction || 'NONE',
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    reason_codes: Array.isArray(strategy.reasonCodes) ? strategy.reasonCodes : [],
    evidence: strategy.evidence && typeof strategy.evidence === 'object' ? strategy.evidence : {},
    invalidation: [
      Number.isFinite(Number(strategy.stopLoss)) ? 'PRICE_STOP_LOSS:' + Number(strategy.stopLoss) : null,
      'CLOSED_TRIGGER_CANDLE_REQUIRED',
      'FRESH_VALID_MARKET_DATA_REQUIRED'
    ].filter(Boolean)
  };
}

function strategyResults(result) {
  return [
    describeStrategy(result.strategies?.trend),
    describeStrategy(result.strategies?.breakout),
    describeStrategy(result.strategies?.meanReversion)
  ].filter(Boolean);
}

function chooseStrategy(strategies) {
  return [...strategies]
    .filter(x => x.state === 'CONFIRMED' || x.state === 'CANDIDATE')
    .filter(x => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score)[0] || null;
}

function decisionBand(score) {
  if (!Number.isFinite(score)) return 'insufficient';
  if (score >= 80) return 'strong';
  if (score >= 65) return 'positive';
  if (score >= 50) return 'watch';
  if (score >= 35) return 'weak';
  return 'reject';
}

function combineSource(sources) {
  const clean = unique(sources.filter(Boolean));
  return clean.length === 1 ? clean[0] : clean.join(' | ') || 'Binance Public REST';
}

export function buildCandidateContract({
  ticker,
  deep,
  rank,
  now,
  minDataQuality = MARKET_RADAR_DEFAULTS.minDataQuality,
  minLiquidityQuality = MARKET_RADAR_DEFAULTS.minLiquidityQuality,
  maxTriggerAgeMs = MARKET_RADAR_DEFAULTS.maxTriggerAgeMs
}) {
  const symbol = ticker.symbol;
  const series = deep.series || {};
  const v4 = validateSeries(series['4h'] || [], '4h');
  const v1 = validateSeries(series['1h'] || [], '1h');
  const v15 = validateSeries(series['15m'] || [], '15m');
  const allCandles = [...(series['4h'] || []), ...(series['1h'] || []), ...(series['15m'] || [])];
  const last15 = latestClosed(series['15m'] || []);
  const triggerAgeMs = freshnessMs(series['15m'] || [], deep.completedAt);
  const future = futureData(allCandles, deep.completedAt);
  const integrityIssues = v4.issues.length + v1.issues.length + v15.issues.length;
  const seriesComplete = Boolean(last15) && v4.valid && v1.valid && v15.valid;
  const stale = !Number.isFinite(triggerAgeMs) || triggerAgeMs > maxTriggerAgeMs;

  let dataQuality = 0;
  if (seriesComplete && !future && !stale) {
    dataQuality = Math.max(0, Math.min(100, 100 - Math.min(30, integrityIssues * 5)));
  }

  const liquidity = deep.liquidity || {
    quality: 0,
    allowed: false,
    reasons: ['LIQUIDITY_DATA_UNAVAILABLE'],
    spreadBps: null
  };
  const strategies = strategyResults(deep.evaluation || {});
  const best = chooseStrategy(strategies);
  const hardGateReasons = [];
  if (!seriesComplete) hardGateReasons.push('INSUFFICIENT_CLOSED_DATA');
  if (future) hardGateReasons.push('FUTURE_DATA');
  if (stale) hardGateReasons.push('STALE_DATA');
  if (!v4.valid || !v1.valid || !v15.valid) hardGateReasons.push('CANDLE_INTEGRITY_FAILURE');
  if (liquidity.quality < minLiquidityQuality) hardGateReasons.push('LOW_LIQUIDITY');
  if (!deep.success) hardGateReasons.push('DEEP_SCAN_FAILED');

  const gatePass = deep.success &&
    seriesComplete &&
    !future &&
    !stale &&
    liquidity.quality >= minLiquidityQuality &&
    dataQuality >= minDataQuality;

  const overallScore = gatePass && best ? Math.round(best.score * 100) / 100 : null;
  const signalState = !gatePass
    ? 'INSUFFICIENT_DATA'
    : best?.state === 'CONFIRMED'
      ? 'CONFIRMED'
      : best?.state === 'CANDIDATE'
        ? 'CANDIDATE'
        : 'NO_SIGNAL';

  const reasonCodes = [
    ...hardGateReasons,
    ...(best?.reason_codes || []),
    ...(liquidity.reasons || [])
  ];
  const invalidation = [...new Set([
    ...(best?.invalidation || []),
    stale ? 'DATA_STALE' : null,
    future ? 'FUTURE_DATA_DETECTED' : null,
    !v4.valid || !v1.valid || !v15.valid ? 'CANDLE_GAP_OR_INTEGRITY_ERROR' : null,
    liquidity.quality < minLiquidityQuality ? 'LIQUIDITY_BELOW_' + minLiquidityQuality : null
  ].filter(Boolean))];
  const riskFlags = [
    ...(liquidity.reasons || []),
    stale ? 'STALE_DATA' : null,
    future ? 'FUTURE_DATA' : null,
    !v4.valid || !v1.valid || !v15.valid ? 'CANDLE_INTEGRITY_FAILURE' : null,
    ...(deep.evaluation?.signal?.risk_reasons || [])
  ].filter(Boolean);

  const evidence = [
    { type: 'market', code: 'QUOTE_VOLUME_24H', value: ticker.quoteVolume24h },
    { type: 'market', code: 'TRADE_COUNT_24H', value: ticker.tradeCount24h },
    { type: 'market', code: 'PRICE_CHANGE_24H', value: ticker.priceChange24h },
    { type: 'quality', code: 'DATA_QUALITY', value: dataQuality },
    { type: 'quality', code: 'LIQUIDITY_QUALITY', value: liquidity.quality },
    ...strategies.flatMap(s => Object.entries(s.evidence).map(([code, value]) => ({
      type: 'strategy',
      strategy: s.id,
      code,
      value
    })))
  ];

  const coverage = {
    required_timeframes: ['4h', '1h', '15m'],
    available_timeframes: ['4h', '1h', '15m'].filter(tf => Array.isArray(series[tf]) && series[tf].length > 0),
    strategy_count: 3,
    evaluated_strategy_count: strategies.length,
    ratio: strategies.length / 3
  };

  const lastError = deep.error ? String(deep.error?.message || deep.error) : null;
  const source = combineSource([
    deep.sources?.exchangeInfo,
    deep.sources?.ticker,
    ...(deep.sources?.klines || []),
    deep.sources?.depth
  ]);

  return {
    symbol,
    rank,
    last_price: deep.success ? ticker.lastPrice : null,
    price_change_24h: ticker.priceChange24h,
    quote_volume_24h: ticker.quoteVolume24h,
    liquidity_quality: Math.round(Number(liquidity.quality) * 100) / 100,
    data_quality: dataQuality,
    market_regime: 'UNKNOWN',
    overall_score: overallScore,
    coverage,
    decision_band: gatePass ? decisionBand(overallScore) : 'insufficient',
    signal_state: signalState,
    direction: best?.direction || 'NONE',
    best_strategy: best?.id || null,
    strategies: strategies.map(s => ({
      id: s.id,
      state: s.state,
      direction: s.direction,
      score: s.score,
      reason_codes: s.reason_codes,
      evidence: s.evidence,
      invalidation: s.invalidation
    })),
    evidence,
    reason_codes: [...new Set(reasonCodes)],
    invalidation,
    risk_flags: [...new Set(riskFlags)],
    data_status: {
      data_stale: stale,
      data_valid: gatePass,
      last_error: lastError,
      source,
      fetch_age_ms: Number.isFinite(deep.minFetchAgeMs) ? Math.max(0, Math.trunc(deep.minFetchAgeMs)) : null
    },
    paper_trading: true,
    real_order_execution: false
  };
}

export async function boundedMap(items, concurrency, worker) {
  const list = [...items];
  const out = Array(list.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      out[index] = await worker(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: width }, () => runner()));
  return out;
}

function shouldRetry(error) {
  const m = String(error?.message || error || '');
  return /TIMEOUT|429|418|502|503|504|NETWORK|FETCH|UNAVAILABLE|ECONN|ENOTFOUND|ETIMEDOUT/.test(m);
}

export async function withRetry(task, {
  attempts = MARKET_RADAR_DEFAULTS.retryAttempts,
  baseMs = MARKET_RADAR_DEFAULTS.retryBaseMs,
  maxBackoffMs = MARKET_RADAR_DEFAULTS.maxBackoffMs,
  sleepFn = sleepDefault
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) break;
      const waitMs = Math.min(maxBackoffMs, baseMs * (2 ** attempt));
      await sleepFn(waitMs);
    }
  }
  throw lastError || new Error('MARKET_RADAR_REQUEST_FAILED');
}

export class MarketUniverseScanner {
  constructor({
    rest,
    strategyConfig,
    config = {},
    clock = () => Date.now(),
    sleepFn = sleepDefault,
    strategyEvaluator = evaluateSymbolSnapshot
  } = {}) {
    if (!rest || typeof rest.request !== 'function') throw new Error('REST_CLIENT_REQUIRED');
    this.rest = rest;
    this.config = { ...MARKET_RADAR_DEFAULTS, ...config };
    this.strategyConfig = strategyConfig;
    this.clock = clock;
    this.sleepFn = sleepFn;
    this.strategyEvaluator = strategyEvaluator;
    this._requests = new Map();
  }

  async requestOnce(path, query = {}) {
    const key = path + '?' + new URLSearchParams(query).toString();
    if (this._requests.has(key)) return this._requests.get(key);
    const promise = withRetry(
      () => this.rest.request(path, query),
      {
        attempts: this.config.retryAttempts,
        baseMs: this.config.retryBaseMs,
        maxBackoffMs: this.config.maxBackoffMs,
        sleepFn: this.sleepFn
      }
    );
    this._requests.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this._requests.delete(key);
      throw error;
    }
  }

  async exchangeInfo() {
    const r = await this.requestOnce('/api/v3/exchangeInfo');
    return { data: r.data, source: r.source, receivedAt: this.clock() };
  }

  async ticker24h() {
    const r = await this.requestOnce('/api/v3/ticker/24hr');
    return { data: r.data, source: r.source, receivedAt: this.clock() };
  }

  async fetchSeries(symbol, interval) {
    return withRetry(
      () => this.rest.klines(symbol, interval, { limit: this.config.deepKlines }),
      {
        attempts: this.config.retryAttempts,
        baseMs: this.config.retryBaseMs,
        maxBackoffMs: this.config.maxBackoffMs,
        sleepFn: this.sleepFn
      }
    );
  }

  async fetchDepth(symbol) {
    return withRetry(
      () => this.rest.depth(symbol, 100),
      {
        attempts: this.config.retryAttempts,
        baseMs: this.config.retryBaseMs,
        maxBackoffMs: this.config.maxBackoffMs,
        sleepFn: this.sleepFn
      }
    );
  }

  computeLiquidity(book, ticker) {
    if (!book?.bids?.length || !book?.asks?.length) {
      return { quality: 0, allowed: false, reasons: ['LIQUIDITY_DATA_UNAVAILABLE'], spreadBps: null };
    }
    const bid = Number(book.bids[0][0]);
    const ask = Number(book.asks[0][0]);
    if (!(bid > 0) || !(ask >= bid)) {
      return { quality: 0, allowed: false, reasons: ['INVALID_BOOK'], spreadBps: null };
    }
    const mid = (bid + ask) / 2;
    const depthBand = this.config.depthBandPct ?? 0.005;
    let bidDepth = 0;
    let askDepth = 0;
    for (const [p, q] of book.bids) {
      if (Number(p) >= mid * (1 - depthBand) && Number(q) >= 0) bidDepth += Number(p) * Number(q);
    }
    for (const [p, q] of book.asks) {
      if (Number(p) <= mid * (1 + depthBand) && Number(q) >= 0) askDepth += Number(p) * Number(q);
    }
    const totalDepth = bidDepth + askDepth;
    const spreadBps = (ask - bid) / mid * 10000;
    const quality = scoreLiquidity({
      spread: spreadBps,
      totalDepth,
      quoteVolume24h: ticker.quoteVolume24h,
      tradeCount24h: ticker.tradeCount24h,
      maxSpreadBps: this.config.maxSpreadBps ?? 20,
      minTrades24h: this.config.minTrades24h ?? 100,
      minQuoteVolume24h: this.config.minQuoteVolume24h ?? null
    });
    const reasons = [];
    if (spreadBps > (this.config.maxSpreadBps ?? 20)) reasons.push('WIDE_SPREAD');
    if (quality < (this.config.minLiquidityQuality ?? 60)) reasons.push('LOW_LIQUIDITY');
    return {
      quality,
      allowed: reasons.length === 0,
      reasons,
      spreadBps,
      bid,
      ask,
      totalDepth,
      bidDepth,
      askDepth
    };
  }

  async scanSymbol(ticker, rank, sources = {}) {
    const startedAt = this.clock();
    const series = {};
    const klinesSources = [];
    let depthRaw = null;
    let depthSource = null;
    let error = null;

    try {
      for (const tf of ['4h', '1h', '15m']) {
        const r = await this.fetchSeries(ticker.symbol, tf);
        const fetchedAt = Number(r.receivedAt) || this.clock();
        series[tf] = Array.isArray(r.candles)
          ? r.candles.map(c => ({ ...c, symbol: ticker.symbol, timeframe: tf }))
          : normalizeRawKlines(r.data, r.source, fetchedAt);
        if (r.source) klinesSources.push(r.source);
      }
      const depth = await this.fetchDepth(ticker.symbol);
      depthRaw = depth?.data ?? depth;
      depthSource = depth?.source ?? null;
    } catch (e) {
      error = e;
    }

    const completedAt = this.clock();
    const deepSuccess = !error && ['4h', '1h', '15m'].every(tf => Array.isArray(series[tf]) && series[tf].length > 0);
    const liquidity = this.computeLiquidity(depthRaw, ticker);
    let evaluation = null;
    if (deepSuccess) {
      const engineConfig = this.strategyConfig;
      evaluation = this.strategyEvaluator({
        symbol: ticker.symbol,
        series4h: series['4h'],
        series1h: series['1h'],
        series15m: series['15m'],
        bookRaw: depthRaw,
        ticker24hRaw: {
          quoteVolume: String(ticker.quoteVolume24h),
          count: String(ticker.tradeCount24h)
        },
        source: 'BINANCE_PUBLIC_REST',
        now: completedAt
      }, engineConfig ? { config: engineConfig } : undefined);
    }

    const fetchAges = ['4h', '1h', '15m']
      .map(tf => series[tf])
      .filter(Array.isArray)
      .map(c => Number(c?.at?.(-1)?.sourceTime));

    const candidate = buildCandidateContract({
      ticker,
      deep: {
        success: deepSuccess,
        series,
        evaluation,
        liquidity,
        sources: {
          exchangeInfo: sources.exchangeInfo,
          ticker: sources.ticker,
          klines: klinesSources,
          depth: depthSource
        },
        completedAt,
        minFetchAgeMs: fetchAges.filter(Number.isFinite).length
          ? Math.min(...fetchAges.filter(Number.isFinite).map(ts => Math.max(0, completedAt - ts)))
          : Math.max(0, completedAt - startedAt),
        error
      },
      rank,
      now: completedAt,
      minDataQuality: this.config.minDataQuality,
      minLiquidityQuality: this.config.minLiquidityQuality,
      maxTriggerAgeMs: this.config.maxTriggerAgeMs
    });

    return candidate;
  }

  async scan({ quote = this.config.quote, limit = this.config.scanLimit } = {}) {
    const startedAt = this.clock();
    const normalizedQuote = String(quote || this.config.quote).trim().toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(normalizedQuote)) throw new Error('INVALID_QUOTE');

    this._requests = new Map();

    const info = await this.exchangeInfo(normalizedQuote);
    const universe = buildSpotUniverse(info.data, normalizedQuote);

    const tickerResponse = await this.ticker24h();
    const ranked = rankTickerRows(
      tickerResponse.data,
      universe,
      {
        minQuoteVolume24h: this.config.minQuoteVolume24h,
        limit: normalizeRadarLimit(limit, this.config)
      }
    );

    const selected = ranked.slice(0, normalizeRadarLimit(limit, this.config));
    const seen = new Set();
    const deduped = selected.filter(x => {
      if (seen.has(x.symbol)) return false;
      seen.add(x.symbol);
      return true;
    });

    const scanned = await boundedMap(
      deduped,
      this.config.deepConcurrency,
      (ticker, i) => this.scanSymbol(ticker, i + 1, {
        exchangeInfo: info.source,
        ticker: tickerResponse.source
      })
    );

    const usable = scanned
      .filter(Boolean)
      .sort((a, b) => {
        const sa = Number.isFinite(a.overall_score) ? a.overall_score : -1;
        const sb = Number.isFinite(b.overall_score) ? b.overall_score : -1;
        return sb - sa ||
          b.liquidity_quality - a.liquidity_quality ||
          b.quote_volume_24h - a.quote_volume_24h ||
          a.symbol.localeCompare(b.symbol);
      })
      .map((x, i) => ({ ...x, rank: i + 1 }));

    const returned = usable.slice(0, this.config.returnLimit);
    return {
      meta: {
        live: returned.some(x => x.data_status.data_valid === true),
        paper_trading: true,
        real_order_execution: false,
        confidence_score: 'UNKNOWN'
      },
      as_of: new Date(this.clock()).toISOString(),
      source: 'Binance Public REST',
      universe: {
        requested: normalizeRadarLimit(limit, this.config),
        scanned: deduped.length,
        returned: returned.length,
        eligible_spot_symbols: universe.length,
        ticker_rows: Array.isArray(tickerResponse.data) ? tickerResponse.data.length : 0,
        min_quote_volume_24h: this.config.minQuoteVolume24h
      },
      candidates: returned,
      diagnostics: {
        duration_ms: Math.max(0, this.clock() - startedAt),
        deep_concurrency: this.config.deepConcurrency,
        max_scan_limit: this.config.maxScanLimit,
        retry_attempts: this.config.retryAttempts
      }
    };
  }
}
