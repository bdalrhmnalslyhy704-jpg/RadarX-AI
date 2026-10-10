import {BinanceStreamClient} from './binance-ws.mjs';

const DEFAULT_MAX_CANDLES_PER_SYMBOL = 180;
const DEFAULT_MAX_SYMBOLS = 1024;
const validNumber = value => value !== null && value !== undefined &&
  !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));

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
    urls = ['wss://stream.binance.com:9443/stream', 'wss://stream.binance.com:443/stream'],
    WebSocketImpl,
    initialBackoffMs = 1000,
    maxBackoffMs = 60000,
    jitterRatio = 0.2,
    heartbeatTimeoutMs = 90000,
    maxConnectionMs = 23 * 60 * 60 * 1000,
    maxCandlesPerSymbol = DEFAULT_MAX_CANDLES_PER_SYMBOL,
    maxSymbols = DEFAULT_MAX_SYMBOLS,
    clock = () => Date.now(),
    logger = console
  } = {}) {
    this.urls = [...urls];
    this.WebSocketImpl = WebSocketImpl;
    this.streamOptions = {initialBackoffMs, maxBackoffMs, jitterRatio, heartbeatTimeoutMs, maxConnectionMs};
    this.maxCandlesPerSymbol = Math.max(60, Math.trunc(Number(maxCandlesPerSymbol) || DEFAULT_MAX_CANDLES_PER_SYMBOL));
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
    if (this.running) this.rebuildStream();
    return true;
  }

  start() {
    if (this.running) return;
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
    let candleCount = 0, warmedSymbols = 0;
    for (const entry of this.cache.values()) {
      candleCount += entry.candles.length;
      if (entry.candles.length >= 60) warmedSymbols++;
    }
    return {
      state: this.streamState,
      running: this.running,
      subscribed_symbols: this.symbols.length,
      cached_symbols: this.cache.size,
      warmed_symbols: warmedSymbols,
      cached_closed_candles: candleCount,
      received_closed_candles: this.receivedClosedCandles,
      rejected_candles: this.rejectedCandles,
      reconnect_attempts: this.client?.health?.().reconnect_attempts ?? 0,
      last_message_at: this.client?.health?.().last_message_at ?? null,
      last_error: this.lastStreamError
    };
  }
}

export {normalizeClosedCandle};
