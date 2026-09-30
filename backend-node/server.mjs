import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { evaluateSymbolSnapshot } from './engine.mjs';
import { getReadyState } from './readiness.mjs';
import { buildDataStatus, computeFreshness } from './freshness.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = '0.0.0.0';
const REFRESH_MS = 15000;
const STALE_MS = 120000;
const MAX_SYMBOL_LEN = 20;
const BINANCE_BASES = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
  'https://data-api.binance.vision'
];

const state = {
  startedAt: Date.now(),
  latestSuccessAt: 0,
  latestDataValid: false,
  latestClosedCandle: null,
  latestSource: null,
  lastError: null
};

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
};

const normalizeSymbol = (raw) => {
  const symbol = String(raw || 'BTCUSDT').trim().toUpperCase();
  return /^[A-Z0-9]{5,20}$/.test(symbol) ? symbol : null;
};

async function fetchJson(path, query) {
  const qs = new URLSearchParams(query);
  const errors = [];
  for (const base of BINANCE_BASES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetch(base + path + '?' + qs.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error('HTTP_' + response.status);
        const data = await response.json();
        return { data, source: base };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      errors.push(base + ':' + String(error?.message || error));
    }
  }
  throw new Error('ALL_DATA_SOURCES_FAILED:' + errors.join('|'));
}

const normalizeKline = (x) => ({
  openTime:+x[0], open:+x[1], high:+x[2], low:+x[3], close:+x[4],
  volume:+x[5], closeTime:+x[6], quoteVolume:+x[7], tradeCount:+x[8],
  takerBuyBaseVolume:+x[9], takerBuyQuoteVolume:+x[10], closed:+x[6] < Date.now()
});

async function marketSnapshot(symbol) {
  const snapshotAt = Date.now();
  const [h4, h1, m15, depth, ticker] = await Promise.all([
    fetchJson('/api/v3/klines', {symbol, interval:'4h', limit:'250'}),
    fetchJson('/api/v3/klines', {symbol, interval:'15m', limit:'250'}),
    fetchJson('/api/v3/klines', {symbol, interval:'1h', limit:'250'}),
    fetchJson('/api/v3/depth', {symbol, limit:'100'}),
    fetchJson('/api/v3/ticker/24hr', {symbol})
  ]);

  const uniqueSources = [...new Set([h4.source, h1.source, m15.source, depth.source, ticker.source])];
  const snapshotSource = uniqueSources.length === 1 ? uniqueSources[0] : 'MULTIPLE_BINANCE_REST';
  const result = evaluateSymbolSnapshot({
    symbol,
    series4h:h4.data.map(normalizeKline),
    series1h:h1.data.map(normalizeKline),
    series15m:m15.data.map(normalizeKline),
    bookRaw:depth.data,
    ticker24hRaw:ticker.data,
    source:snapshotSource,
    now:snapshotAt
  });
  const dataValid = result.diagnostics?.dataValid === true;
  const latestClosedCandle = result.diagnostics?.latestClosed15m ?? null;
  const lastError = dataValid ? null : 'INVALID_MARKET_DATA';

  state.latestSuccessAt = snapshotAt;
  state.latestDataValid = dataValid;
  state.latestClosedCandle = latestClosedCandle;
  state.latestSource = snapshotSource;
  state.lastError = lastError;

  return { result, snapshotAt, dataValid, latestClosedCandle, source:snapshotSource, lastError };
}

function publicResult(snapshot, now = Date.now()) {
  const result = snapshot.result;
  const freshness = computeFreshness({
    latestSuccessAt: snapshot.snapshotAt,
    latestDataValid: snapshot.dataValid,
    latestClosedCandle: snapshot.latestClosedCandle,
    source: snapshot.source,
    lastError: snapshot.lastError
  }, now, STALE_MS);
  const signalDataStatus = buildDataStatus({
    base: result.signal?.data_status ?? {},
    latestSuccessAt: snapshot.snapshotAt,
    latestDataValid: snapshot.dataValid,
    latestClosedCandle: snapshot.latestClosedCandle,
    source: snapshot.source,
    lastError: snapshot.lastError,
    now,
    staleMs: STALE_MS
  });
  const payload = {
    ...result,
    signal: {
      ...result.signal,
      data_status: signalDataStatus
    },
    meta: {
      backend:'radarx-public-backend',
      live:freshness.live,
      paper_trading:true,
      real_order_execution:false,
      confidence_score:'UNKNOWN'
    }
  };
  return payload;
}

async function refreshForSocket(ws, symbol) {
  try {
    ws.send(JSON.stringify({type:'status',status:'FETCHING',symbol,live:false}));
    const snapshot = await marketSnapshot(symbol);
    ws.send(JSON.stringify({type:'signal', payload:publicResult(snapshot)}));
  } catch (error) {
    state.lastError = String(error?.message || error);
    ws.send(JSON.stringify({
      type:'status',
      status:'DATA_UNAVAILABLE',
      symbol,
      live:false,
      reason:'LIVE_DATA_UNAVAILABLE'
    }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'GET,OPTIONS'
    });
    return res.end();
  }

  if (url.pathname === '/healthz') {
    return json(res, 200, {
      status:'ok',
      service:'radarx-public-backend',
      node:process.version,
      uptime_seconds:Math.floor((Date.now()-state.startedAt)/1000),
      paper_trading:true,
      real_order_execution:false
    });
  }

  if (url.pathname === '/readyz') {
    const readiness = getReadyState(state, Date.now(), STALE_MS);
    return json(res, readiness.statusCode, readiness.body);
  }

  if (url.pathname === '/api/signal') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    if (!symbol) return json(res, 400, {error:'INVALID_SYMBOL'});
    try {
      const snapshot = await marketSnapshot(symbol);
      const payload = publicResult(snapshot);
      if (!payload.meta.live) {
        return json(res, 503, {
          error: payload.signal?.data_status?.data_stale ? 'DATA_STALE' : 'DATA_SOURCE_UNAVAILABLE',
          ...payload
        });
      }
      return json(res, 200, payload);
    } catch (error) {
      state.lastError = String(error?.message || error);
      return json(res, 503, {
        error:'DATA_SOURCE_UNAVAILABLE',
        meta:{backend:'radarx-public-backend',live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
      });
    }
  }

  return json(res, 404, {error:'NOT_FOUND'});
});

const wss = new WebSocketServer({ noServer:true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname !== '/ws') return socket.destroy();
  const symbol = normalizeSymbol(url.searchParams.get('symbol'));
  if (!symbol) return socket.destroy();

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.symbol = symbol;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    refreshForSocket(ws, symbol);
    ws.refreshTimer = setInterval(() => refreshForSocket(ws, symbol), REFRESH_MS);
    ws.on('close', () => clearInterval(ws.refreshTimer));
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log('RadarX public backend listening on ' + HOST + ':' + PORT);
  marketSnapshot('BTCUSDT').catch((error) => {
    state.lastError = String(error?.message || error);
    console.error('Initial readiness fetch failed:', state.lastError);
  });
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
});
