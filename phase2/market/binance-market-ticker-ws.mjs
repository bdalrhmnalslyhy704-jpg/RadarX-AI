import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';

const normalizeTicker = x => {
  if (!x || typeof x !== 'object') return null;
  const symbol = String(x.s || '').trim().toUpperCase();
  const lastPrice = Number(x.c);
  const openPrice = Number(x.o);
  const changePct = Number(x.P);
  if (!/^[A-Z0-9]{5,30}$/.test(symbol) || !(lastPrice > 0) || !(openPrice > 0) || !Number.isFinite(changePct)) return null;
  return {
    symbol,
    lastPrice,
    openPrice,
    priceChange24h: changePct,
    highPrice24h: Number(x.h),
    lowPrice24h: Number(x.l),
    quoteVolume24h: Number(x.q),
    tradeCount24h: Number(x.n),
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
    this.state = 'STOPPED';
    this.connectionId = null;
  }

  health() {
    return {
      state: this.state,
      last_message_at: this.lastMessageAt,
      last_connected_at: this.lastConnectedAt,
      reconnect_attempts: this.reconnectCount,
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
    url.searchParams.set('streams', '!ticker@arr');
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
      this.lastMessageAt = this.lastConnectedAt;
      this.attempt = 0;
      this.state = 'LIVE';
      this.onState(this.state);
      this.connectionTimer = setTimeout(() => { try { socket.close(); } catch {} }, this.maxConnectionMs);
      this.heartbeatTimer = setTimeout(() => this.checkHeartbeat(socket), this.heartbeatTimeoutMs);
    }));

    socket.on('message', guard(raw => {
      this.lastMessageAt = Date.now();
      this.state = 'LIVE';
      try {
        const parsed = JSON.parse(raw.toString());
        const payload = parsed?.data ?? parsed;
        const rows = Array.isArray(payload) ? payload : [];
        for (const row of rows) {
          const ticker = normalizeTicker(row);
          if (ticker) this.onTicker(ticker);
        }
      } catch (error) {
        this.onState(this.state, 'INVALID_TICKER_WS_JSON:' + String(error?.message ?? error));
      }
    }));

    socket.on('ping', guard(() => { try { socket.pong?.(); } catch {} }));
    socket.on('error', guard(error => this.onState(this.state, 'WS_ERROR:' + String(error?.message ?? error))));
    socket.on('close', guard(() => {
      for (const t of [this.heartbeatTimer, this.connectionTimer]) if (t) clearTimeout(t);
      this.heartbeatTimer = this.connectionTimer = null;
      this.socket = null;
      if (this.running) this.scheduleReconnect('WS_CLOSED');
    }));
  }

  checkHeartbeat(socket) {
    if (!this.running || this.socket !== socket) return;
    if (this.lastMessageAt && Date.now() - this.lastMessageAt > this.heartbeatTimeoutMs) {
      try { socket.terminate?.(); } catch { try { socket.close(); } catch {} }
      return;
    }
    this.heartbeatTimer = setTimeout(() => this.checkHeartbeat(socket), this.heartbeatTimeoutMs);
  }
}

export {normalizeTicker};
