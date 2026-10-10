import {BinanceStreamClient} from './binance-ws.mjs';

const DEFAULT_MAX_CANDLES_PER_SYMBOL = 180;
const DEFAULT_MAX_SYMBOLS = 1024;
const FIVE_MINUTE_MS = 5 * 60_000;
const MIN_READY_CLOSED_CANDLES = 60;
const DEFAULT_MAX_CANDLE_AGE_MS = 8 * 60_000;
const BINANCE_MARKET_DATA_WS_URL = 'wss://data-stream.binance.vision/stream';
const validNumber = value => value !== null && value !== undefined &&
  !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));

function normalizeStreamUrls(urls) {
  const supplied = [...new Set((Array.isArray(urls) ? urls : [])
    .map(value => String(value || '').trim()).filter(Boolean))];
  const usesBinance = supplied.some(value => {
    try { return /(^|\\.)binance\\.(com|vision)$/i.test(new URL(value).hostname); }
    catch { return false; }
  });
  if (!usesBinance) return supplied.length ? supplied : [BINANCE_MARKET_DATA_WS_URL];
  const withoutMirror = supplied.filter(value => {
    try { return new URL(value).hostname.toLowerCase() !== 'data-stream.binance.vision'; }
    catch { return true; }
  });
  return [BINANCE_MARKET_DATA_WS_URL, ...withoutMirror];
}

function assessCachedEntry(entry, now, maxAgeMs) {
  const candles = (entry?.candles || [])
    .filter(row => row?.closed === true && Number.isFinite(Number(row.closeTime)) && Number(row.closeTime) <= now)
    .slice().sort((a, b) => Number(a.openTime) - Number(b.openTime));
  if (!candles.length) return {ready:false, state:'CANDLE_CACHE_MISSING', ageMs:null, closedCandles:0};
  const last = candles.at(-1);
  const ageMs = Math.max(0, now - Number(last.closeTime));
  if (ageMs > maxAgeMs) return {ready:false, state:'STALE_DATA', ageMs, closedCandles:candles.length};
  if (candles.length < MIN_READY_CLOSED_CANDLES) {
    return {ready:false, state:'CANDLE_CACHE_INCOMPLETE', ageMs, closedCandles:candles.length};
  }
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (Number(candle.closeTime) !== Number(candle.openTime) + FIVE_MINUTE_MS - 1 ||
        !Number.isFinite(Number(candle.open)) || !Number.isFinite(Number(candle.high)) ||
        !Number.isFinite(Number(candle.low)) || !Number.isFinite(Number(candle.close)) ||
        !(Number(candle.open) > 0) || !(Number(candle.close) > 0) ||
        Number(candle.high) < Math.max(Number(candle.open), Number(candle.close)) ||
        Number(candle.low) > Math.min(Number(candle.open), Number(candle.close))) {
      return {ready:false, state:'INVALID_CLOSED_CANDLE', ageMs, closedCandles:candles.length};
    }
    if (index > 0 && Number(candle.openTime) - Number(candles[index - 1].openTime) !== FIVE_MINUTE_MS) {
      return {ready:false, state:'CLOSED_CANDLE_SEQUENCE_HAS_GAPS', ageMs, closedCandles:candles.length};
    }
  }
  const verifiedSources = new Set(['BINANCE_PUBLIC_WS', 'BINANCE_PUBLIC_REST', 'BINANCE_PUBLIC_REST_CACHE']);
  if (!candles.some(row => verifiedSources.has(String(row.source || '')))) {
    return {ready:false, state:'UNVERIFIED_CANDLE_SOURCE', ageMs, closedCandles:candles.length};
  }
  return {ready:true, state:'READY', ageMs, closedCandles:candles.length};
}

function normalizeClosedCandle(input, now, fallbackSource = null) {
  if (!input || typeof input !== 'object' || input.closed !== true) return null;
  const openTime = Number(input.openTime), closeTime = Number(input.closeTime);
  const open = Number(input.open), high = Number(input.high);
  const low = Number(input.low), close = Number(input.close);
  const volume = validNumber(input.volume) ? Number(input.volume) : null;
  const tradeCount = validNumber(input.tradeCount) ? Number(input.tradeCount) : null;
  if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) ||
      closeTime < openTime || closeTime > now ||
      !(open > 0) || !(close > 0) || !(low > 0) ||
      high < Math.max(open, close) || low > Math.min(open, close) ||
      (volume !== null && volume < 0) || (tradeCount !== null && tradeCount < 0)) return null;
  const receivedAt = validNumber(input.receivedAt) ? Number(input.receivedAt) :
    (validNumber(input.sourceTime) ? Number(input.sourceTime) : now);
  return {
    symbol: String(input.symbol || '').trim().toUpperCase(),
    openTime, closeTime, open, high, low, close,
    volume, quoteVolume: validNumber(input.quoteVolume) ? Number(input.quoteVolume) : null,
    tradeCount, takerBuyBaseVolume: validNumber(input.takerBuyBaseVolume) ? Number(input.takerBuyBaseVolume) : null,
    takerBuyQuoteVolume: validNumber(input.takerBuyQuoteVolume) ? Number(input.takerBuyQuoteVolume) : null,
    closed: true,
    source: String(input.source || fallbackSource || 'UNKNOWN_SOURCE'),
    sourceTime: validNumber(input.sourceTime) ? Number(input.sourceTime) : receivedAt,
    receivedAt,
    ageMs: Math.max(0, now - closeTime),
    eventTime: validNumber(input.eventTime) ? Number(input.eventTime) : null,
    transportLatencyMs: validNumber(input.transportLatencyMs) ? Number(input.transportLatencyMs) : null,
    timeframe: String(input.timeframe || '5m')
  };
}

/**
 * A bounded, in-memory 5m closed-candle cache.
 *
 * It makes no REST calls. The market-wide feed uses one combined Binance
 * WebSocket connection (one kline_5m stream per eligible symbol); Micro may
 * seed the same cache with its existing 5m REST response, so this feature
 * does not add a per-symbol REST warm-up loop.
 */
export class MarketWideKlineCache {
  constructor({
    urls = [BINANCE_MARKET_DATA_WS_URL, 'wss://stream.binance.com:9443/stream', 'wss://stream.binance.com:443/stream'],
    WebSocketImpl,
    initialBackoffMs = 1000,
    maxBackoffMs = 60000,
    maxReconnectAttempts = 5,
    jitterRatio = 0.2,
    heartbeatTimeoutMs = 90000,
    maxConnectionMs = 23 * 60 * 60 * 1000,
    maxCandlesPerSymbol = DEFAULT_MAX_CANDLES_PER_SYMBOL,
    maxSymbols = DEFAULT_MAX_SYMBOLS,
    maxCandleAgeMs = DEFAULT_MAX_CANDLE_AGE_MS,
    rest = null,
    clock = () => Date.now(),
    logger = console
  } = {}) {
    this.urls = normalizeStreamUrls(urls);
    this.rest = rest;
    this.unsubscribeKlines = null;
    this.WebSocketImpl = WebSocketImpl;
    this.streamOptions = {initialBackoffMs, maxBackoffMs, maxReconnectAttempts, jitterRatio, heartbeatTimeoutMs, maxConnectionMs};
    this.maxCandleAgeMs = Math.max(FIVE_MINUTE_MS, Math.trunc(Number(maxCandleAgeMs) || DEFAULT_MAX_CANDLE_AGE_MS));
    this.maxCandlesPerSymbol = Math.max(MIN_READY_CLOSED_CANDLES, Math.trunc(Number(maxCandlesPerSymbol) || DEFAULT_MAX_CANDLES_PER_SYMBOL));
    this.maxSymbols = Math.min(DEFAULT_MAX_SYMBOLS, Math.max(1, Math.trunc(Number(maxSymbols) || DEFAULT_MAX_SYMBOLS)));
    this.clock = clock;
    this.logger = logger;
    this.cache = new Map();
    this.symbols = [];
    this.client = null;
    this.running = false;
    this.streamState = 'STOPPED';
    this.lastStreamError = null;
    this.receivedClosedCandles = 0;
    this.rejectedCandles = 0;
    this.streamGeneration = 0;
    this.attachRestKlineObserver();
  }

  attachRestKlineObserver() {
    if (this.unsubscribeKlines || typeof this.rest?.subscribeKlines !== 'function') return;
    this.unsubscribeKlines = this.rest.subscribeKlines(({symbol, interval, candles}) => {
      if (String(interval || '') !== '5m') return;
      this.seed(symbol, candles, 'BINANCE_PUBLIC_REST');
    });
  }

  normalizeSymbols(symbols = []) {
    const rows = [...new Set((Array.isArray(symbols) ? symbols : [])
      .map(value => String(value || '').trim().toUpperCase())
      .filter(symbol => /^[A-Z0-9]{2,25}USDT$/.test(symbol)))].sort();
    if (rows.length > this.maxSymbols) throw new Error('MARKET_WIDE_LIGHT_STREAM_LIMIT_EXCEEDED');
    return rows;
  }

  setSymbols(symbols = []) {
    const next = this.normalizeSymbols(symbols);
    if (next.length === this.symbols.length &&
        next.every((symbol, index) => symbol === this.symbols[index])) return false;
    this.symbols = next;
    const eligible = new Set(next);
    for (const symbol of this.cache.keys()) if (!eligible.has(symbol)) this.cache.delete(symbol);
    if (this.running) this.rebuildStream();
    return true;
  }

  start() {
    if (this.running) return;
    this.attachRestKlineObserver();
    this.running = true;
    this.rebuildStream();
  }

  stop() {
    this.running = false;
    this.streamGeneration++;
    const old = this.client;
    this.client = null;
    old?.stop();
    this.streamState = 'STOPPED';
    if (this.unsubscribeKlines) {
      this.unsubscribeKlines();
      this.unsubscribeKlines = null;
    }
  }

  rebuildStream() {
    if (!this.running) return;
    const generation = ++this.streamGeneration;
    const previous = this.client;
    this.client = null;
    previous?.stop();
    if (!this.symbols.length) {
      this.streamState = 'WAITING_FOR_ELIGIBLE_UNIVERSE';
      return;
    }
    const options = {
      urls: this.urls,
      streams: this.symbols.map(symbol => symbol.toLowerCase() + '@kline_5m'),
      ...this.streamOptions,
      ...(this.WebSocketImpl ? {WebSocketImpl: this.WebSocketImpl} : {}),
      onCandle: candle => {
        if (generation !== this.streamGeneration) return;
        if (String(candle?.timeframe || '') !== '5m' || candle?.closed !== true) return;
        const saved = this.putCandle(candle, 'BINANCE_PUBLIC_WS');
        if (saved) this.receivedClosedCandles++;
      },
      onState: (state, reason) => {
        if (generation !== this.streamGeneration) return;
        this.streamState = state;
        if (reason) {
          this.lastStreamError = String(reason);
          this.logger?.warn?.('[MARKET_WIDE_LIGHT_WS] ' + String(reason));
        } else if (state === 'LIVE') {
          this.lastStreamError = null;
        }
      }
    };
    this.client = new BinanceStreamClient(options);
    this.client.start();
  }

  putCandle(input, fallbackSource = null) {
    const now = this.clock();
    const candle = normalizeClosedCandle(input, now, fallbackSource);
    if (!candle || !/^[A-Z0-9]{2,25}USDT$/.test(candle.symbol)) {
      this.rejectedCandles++;
      return false;
    }
    let entry = this.cache.get(candle.symbol);
    if (!entry) {
      if (this.cache.size >= this.maxSymbols) {
        const oldest = [...this.cache.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
        if (oldest) this.cache.delete(oldest[0]);
      }
      entry = {candles: [], lastSeenAt: now};
      this.cache.set(candle.symbol, entry);
    }
    const byOpen = new Map(entry.candles.map(row => [row.openTime, row]));
    const old = byOpen.get(candle.openTime);
    // A WebSocket close takes precedence over a cached REST copy of the same bar.
    if (!old || candle.source === 'BINANCE_PUBLIC_WS' || Number(candle.receivedAt) >= Number(old.receivedAt)) {
      byOpen.set(candle.openTime, candle);
    }
    entry.candles = [...byOpen.values()]
      .filter(row => row.closed === true && Number(row.closeTime) <= now)
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-this.maxCandlesPerSymbol);
    entry.lastSeenAt = now;
    return true;
  }

  seed(symbol, candles, source = 'BINANCE_PUBLIC_REST') {
    const key = String(symbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,25}USDT$/.test(key)) return 0;
    if (this.symbols.length && !this.symbols.includes(key)) return 0;
    let accepted = 0;
    for (const candle of Array.isArray(candles) ? candles : []) {
      const normalized = normalizeClosedCandle({...candle, symbol: key, source: candle?.source || source}, this.clock(), source);
      if (normalized && this.putCandle(normalized, source)) accepted++;
    }
    return accepted;
  }

  getSeries(symbol) {
    const key = String(symbol || '').trim().toUpperCase();
    const entry = this.cache.get(key);
    if (!entry) return null;
    const candles = entry.candles.map(row => ({...row}));
    const last = candles.at(-1) || null;
    return {
      symbol: key,
      candles,
      source: last?.source || 'UNKNOWN_SOURCE',
      receivedAt: last?.receivedAt ?? null,
      latestCloseTime: last?.closeTime ?? null,
      latestCandleAgeMs: last ? Math.max(0, this.clock() - Number(last.closeTime)) : null,
      cachedCandleCount: candles.length,
      lastSeenAt: entry.lastSeenAt
    };
  }

  health() {
    const now = this.clock();
    const states = this.symbols.map(symbol => ({symbol, ...assessCachedEntry(this.cache.get(symbol), now, this.maxCandleAgeMs)}));
    const readySymbols = states.filter(item => item.ready).length;
    const missingSymbols = states.filter(item => item.state === 'CANDLE_CACHE_MISSING').length;
    const staleSymbols = states.filter(item => item.state === 'STALE_DATA').length;
    const incompleteSymbols = states.filter(item => !item.ready &&
      item.state !== 'CANDLE_CACHE_MISSING' && item.state !== 'STALE_DATA').length;
    const candleCount = [...this.cache.values()].reduce((sum, entry) => sum + entry.candles.length, 0);
    const restSeededSymbols = this.symbols.filter(symbol =>
      (this.cache.get(symbol)?.candles || []).some(candle => candle.source === 'BINANCE_PUBLIC_REST' ||
        candle.source === 'BINANCE_PUBLIC_REST_CACHE')).length;
    const wsHealth = this.client?.health?.() || {};
    const websocketLive = wsHealth.state === 'LIVE' || this.streamState === 'LIVE';
    let restFallbackState = 'NOT_ACTIVE';
    if (!websocketLive && this.running) {
      if (this.streamState === 'DEGRADED') {
        restFallbackState = restSeededSymbols > 0 ? 'SHARED_REST_FALLBACK_ACTIVE' : 'WAITING_FOR_SHARED_REST_KLINES';
      } else {
        restFallbackState = restSeededSymbols > 0 ? 'SHARED_REST_OBSERVER_ACTIVE' : 'WEBSOCKET_CONNECTING_WITH_REST_OBSERVER';
      }
    } else if (!this.running && this.streamState === 'STOPPED') {
      restFallbackState = 'STOPPED';
    }
    return {
      state: this.streamState,
      running: this.running,
      transport_state: wsHealth.state || this.streamState,
      websocket_url: wsHealth.url || null,
      rest_fallback_state: restFallbackState,
      rest_fallback_seeded_symbols: restSeededSymbols,
      subscribed_symbols: this.symbols.length,
      cached_symbols: this.cache.size,
      warmed_symbols: readySymbols,
      ready_symbols: readySymbols,
      expected_symbols: this.symbols.length,
      missing_symbols: missingSymbols,
      stale_symbols: staleSymbols,
      incomplete_symbols: incompleteSymbols,
      cache_coverage_ready: this.symbols.length > 0 && readySymbols === this.symbols.length,
      cached_closed_candles: candleCount,
      received_closed_candles: this.receivedClosedCandles,
      rejected_candles: this.rejectedCandles,
      reconnect_attempts: wsHealth.reconnect_attempts ?? 0,
      consecutive_reconnect_attempts: wsHealth.consecutive_reconnect_attempts ?? 0,
      max_reconnect_attempts: wsHealth.max_reconnect_attempts ?? this.streamOptions.maxReconnectAttempts,
      last_message_at: wsHealth.last_message_at ?? null,
      last_error: this.lastStreamError
    };
  }
}

export {normalizeClosedCandle};
