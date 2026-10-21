import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';

const normalizeTicker = x => {
  if (!x || typeof x !== 'object') return null;
  const symbol = String(x.s || '').trim().toUpperCase();
  const lastPrice = Number(x.c);
  const openPrice = Number(x.o);
  // Spot retired !ticker@arr in March 2026. The supported !miniTicker@arr
  // omits P (24h change) and n (trade count), so derive price change from c/o
  // and preserve missing trade count as unknown rather than inventing a value.
  const reportedChangePct = Number(x.P);
  const changePct = Number.isFinite(reportedChangePct)
    ? reportedChangePct
    : (lastPrice > 0 && openPrice > 0 ? (lastPrice / openPrice - 1) * 100 : NaN);
  const reportedTradeCount = Number(x.n);
  if (!/^[A-Z0-9]{5,30}$/.test(symbol) || !(lastPrice > 0) || !(openPrice > 0) || !Number.isFinite(changePct)) return null;
  return {
    symbol,
    lastPrice,
    openPrice,
    priceChange24h: changePct,
    highPrice24h: Number(x.h),
    lowPrice24h: Number(x.l),
    quoteVolume24h: Number(x.q),
    tradeCount24h: Number.isFinite(reportedTradeCount) && reportedTradeCount >= 0 ? reportedTradeCount : null,
    eventTime: Number(x.E) || Date.now()
  };
};

export class BinanceAllMarketTickerClient {
  constructor({
    urls,
    WebSocketImpl = WebSocket,
    heartbeatTimeoutMs = 90000,
    maxConnectionMs = 23 * 60 * 60 * 1000,
    initialBackoffMs = 1000,
    maxBackoffMs = 60000,
    jitterRatio = 0.2,
    onTicker = () => {},
    onState = () => {}
  } = {}) {
    if (!Array.isArray(urls) || !urls.length) throw new Error('INVALID_TICKER_WS_URLS');
    this.urls = [...urls];
    this.WebSocketImpl = WebSocketImpl;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxConnectionMs = maxConnectionMs;
    this.initialBackoffMs = initialBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.jitterRatio = jitterRatio;
    this.onTicker = onTicker;
    this.onState = onState;
    this.socket = null;
    this.running = false;
    this.timer = null;
    this.heartbeatTimer = null;
    this.connectionTimer = null;
    this.attempt = 0;
    this.urlIndex = 0;
    this.lastMessageAt = null;
    this.lastConnectedAt = null;
    this.reconnectCount = 0;
    this.messageCount = 0;
    this.tickerCount = 0;
    this.messagesAtConnect = 0;
    this.tickersAtConnect = 0;
    this.lastConnectionFailure = null;
    this.lastDisconnectReason = null;
    this.lastCloseCode = null;
    this.lastCloseReason = null;
    this.lastConnectionDurationMs = null;
    this.connectionOpenedAt = null;
    this.state = 'STOPPED';
    this.connectionId = null;
  }

  health() {
    return {
      state: this.state,
      last_message_at: this.lastMessageAt,
      last_message_age_ms: this.lastMessageAt === null ? null : Math.max(0, Date.now() - this.lastMessageAt),
      last_connected_at: this.lastConnectedAt,
      heartbeat_timeout_ms: this.heartbeatTimeoutMs,
      reconnect_attempts: this.reconnectCount,
      messages_received: this.messageCount,
      tickers_received: this.tickerCount,
      messages_since_connect: this.messageCount - this.messagesAtConnect,
      tickers_since_connect: this.tickerCount - this.tickersAtConnect,
      last_disconnect_reason: this.lastDisconnectReason,
      last_close_code: this.lastCloseCode,
      last_close_reason: this.lastCloseReason,
      last_connection_duration_ms: this.lastConnectionDurationMs,
      url: this.urls[this.urlIndex] ?? null
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    for (const t of [this.timer, this.heartbeatTimer, this.connectionTimer]) if (t) clearTimeout(t);
    this.timer = this.heartbeatTimer = this.connectionTimer = null;
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.state = 'STOPPED';
    this.onState(this.state);
  }

  url() {
    const url = new URL(this.urls[this.urlIndex]);
    // This client consumes exactly one stream. Use Binance's raw-stream endpoint
    // (/ws/<stream>) instead of the combined-stream query, which has been rejected
    // by some hosted egress paths even when the kline stream endpoint is reachable.
    // Keep any non-stream options (for example timeUnit) but remove a stale
    // combined-stream selector supplied in the base URL.
    const path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/stream')) {
      url.pathname = path.slice(0, -'/stream'.length) + '/ws/!miniTicker@arr';
    } else if (path.endsWith('/ws')) {
      url.pathname = path + '/!miniTicker@arr';
    } else if (!path.endsWith('/ws/!miniTicker@arr')) {
      url.pathname = (path || '') + '/ws/!miniTicker@arr';
    }
    url.searchParams.delete('streams');
    return url.toString();
  }

  scheduleReconnect(reason) {
    if (!this.running) return;
    this.state = 'BACKING_OFF';
    this.onState(this.state, reason);
    const exp = Math.min(this.maxBackoffMs, this.initialBackoffMs * (2 ** this.attempt));
    const delay = Math.min(this.maxBackoffMs, Math.round(exp + exp * this.jitterRatio * Math.random()));
    this.attempt++;
    this.reconnectCount++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.urlIndex = (this.urlIndex + 1) % this.urls.length;
      this.connect();
    }, delay);
  }

  connect() {
    if (!this.running) return;
    this.state = 'CONNECTING';
    this.onState(this.state);
    const id = randomUUID();
    this.connectionId = id;
    this.lastConnectionFailure = null;
    this.connectionOpenedAt = null;
    this.messagesAtConnect = this.messageCount;
    this.tickersAtConnect = this.tickerCount;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url());
    } catch (error) {
      this.scheduleReconnect(String(error?.message ?? error));
      return;
    }
    this.socket = socket;
    const guard = fn => (...args) => { if (this.connectionId === id) fn(...args); };

    socket.on('open', guard(() => {
      this.lastConnectedAt = Date.now();
      this.connectionOpenedAt = this.lastConnectedAt;
      this.lastMessageAt = this.lastConnectedAt;
      // An upgraded socket is not a live market feed until a valid ticker arrives.
      this.state = 'WAITING_FOR_DATA';
      this.onState(this.state, 'WS_CONNECTED_WAITING_FOR_FIRST_TICKER');
      this.connectionTimer = setTimeout(() => {
        this.lastConnectionFailure = 'WS_MAX_CONNECTION_AGE_REACHED';
        try { socket.close(); } catch {}
      }, this.maxConnectionMs);
      this.armHeartbeat(socket);
    }));

    socket.on('message', guard(raw => {
      this.messageCount++;
      this.lastMessageAt = Date.now();
      // Reset the watchdog on inbound application data, so the silence threshold
      // is measured from the last frame instead of a periodic timer's old deadline.
      this.armHeartbeat(socket);
      try {
        const parsed = JSON.parse(raw.toString());
        const payload = parsed?.data ?? parsed;
        if (!Array.isArray(payload)) {
          this.onState(this.state, 'INVALID_TICKER_WS_SHAPE');
          return;
        }
        const tickersBefore = this.tickerCount;
        for (const row of payload) {
          const ticker = normalizeTicker(row);
          if (ticker) {
            this.tickerCount++;
            this.onTicker(ticker);
          }
        }
        // Socket open / JSON activity alone must not imply the feed is LIVE.
        if (this.tickerCount > this.tickersAtConnect) {
          const becameLive = this.state !== 'LIVE';
          this.state = 'LIVE';
          // Reset exponential backoff only after actual usable ticker data arrives.
          this.attempt = 0;
          this.lastConnectionFailure = null;
          if (becameLive) this.onState(this.state, 'WS_FIRST_VALID_TICKER_RECEIVED');
        } else if (this.state !== 'LIVE' && this.tickerCount === tickersBefore) {
          this.state = 'WAITING_FOR_DATA';
          this.onState(this.state, 'WS_MESSAGE_WITHOUT_VALID_TICKERS');
        }
      } catch (error) {
        this.onState(this.state, 'INVALID_TICKER_WS_JSON:' + String(error?.message ?? error));
      }
    }));

    socket.on('ping', guard(() => { try { socket.pong?.(); } catch {} }));
    socket.on('unexpected-response', guard((request, response) => {
      const status = Number(response?.statusCode);
      const reason = Number.isFinite(status) && status > 0 ? 'WS_HTTP_' + status : 'WS_UNEXPECTED_RESPONSE';
      this.lastConnectionFailure = reason;
      this.onState(this.state, reason);
      try { response?.resume?.(); } catch {}
      try { socket.terminate?.(); } catch { try { socket.close(); } catch {} }
    }));
    socket.on('error', guard(error => {
      const reason = 'WS_ERROR:' + String(error?.message ?? error);
      this.lastConnectionFailure = reason.slice(0, 180);
      this.onState(this.state, this.lastConnectionFailure);
    }));
    socket.on('close', guard((code, reasonBuffer) => {
      for (const t of [this.heartbeatTimer, this.connectionTimer]) if (t) clearTimeout(t);
      this.heartbeatTimer = this.connectionTimer = null;
      this.socket = null;
      this.lastCloseCode = Number.isFinite(Number(code)) && code !== undefined ? Number(code) : null;
      this.lastCloseReason = String(reasonBuffer?.toString?.() ?? reasonBuffer ?? '').slice(0, 120);
      this.lastConnectionDurationMs = this.connectionOpenedAt ? Date.now() - this.connectionOpenedAt : null;
      const messageAgeMs = this.lastMessageAt === null ? null : Date.now() - this.lastMessageAt;
      const fallbackReason = [
        'WS_CLOSED',
        'code=' + (this.lastCloseCode ?? 'unknown'),
        'reason=' + (this.lastCloseReason || 'none'),
        'connected_ms=' + (this.lastConnectionDurationMs ?? 'unknown'),
        'message_age_ms=' + (messageAgeMs ?? 'unknown'),
        'messages_since_connect=' + (this.messageCount - this.messagesAtConnect),
        'tickers_since_connect=' + (this.tickerCount - this.tickersAtConnect)
      ].join(' ');
      this.lastDisconnectReason = String(this.lastConnectionFailure || fallbackReason).slice(0, 240);
      this.lastConnectionFailure = null;
      if (this.running) this.scheduleReconnect(this.lastDisconnectReason);
    }));
  }

  armHeartbeat(socket) {
    if (!this.running || this.socket !== socket) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.checkHeartbeat(socket), this.heartbeatTimeoutMs);
  }

  checkHeartbeat(socket) {
    if (!this.running || this.socket !== socket) return;
    if (this.lastMessageAt !== null && Date.now() - this.lastMessageAt >= this.heartbeatTimeoutMs) {
      const ageMs = Date.now() - this.lastMessageAt;
      const reason = 'WS_HEARTBEAT_TIMEOUT:message_age_ms=' + ageMs +
        ':heartbeat_timeout_ms=' + this.heartbeatTimeoutMs +
        ':messages_since_connect=' + (this.messageCount - this.messagesAtConnect) +
        ':tickers_since_connect=' + (this.tickerCount - this.tickersAtConnect);
      this.lastConnectionFailure = reason;
      this.lastDisconnectReason = reason;
      this.onState(this.state, reason);
      try { socket.terminate?.(); } catch { try { socket.close(); } catch {} }
      return;
    }
    this.armHeartbeat(socket);
  }
}

export {normalizeTicker};
