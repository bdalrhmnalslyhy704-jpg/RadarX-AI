import WebSocket from 'ws';

const WS_URL = 'wss://data-stream.binance.vision/stream?streams=btcusdt@kline_5m';
const REST_URL = 'https://data-api.binance.vision/api/v3/time';

async function probeWebSocket() {
  return new Promise(resolve => {
    let settled = false;
    let opened = false;
    const socket = new WebSocket(WS_URL, {handshakeTimeout: 5000});
    const timer = setTimeout(() => finish(opened ? 'OPEN_NO_MESSAGE_TIMEOUT' : 'CONNECT_TIMEOUT'), 9000);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.removeAllListeners(); } catch {}
      try { socket.terminate(); } catch {}
      resolve(result);
    };
    socket.on('open', () => { opened = true; });
    socket.on('message', () => finish('LIVE_MESSAGE'));
    socket.on('unexpected-response', (_request, response) => {
      const status = Number(response?.statusCode);
      try { response?.resume?.(); } catch {}
      finish(Number.isFinite(status) ? 'HTTP_' + status : 'UNEXPECTED_HTTP_RESPONSE');
    });
    socket.on('error', error => {
      const code = String(error?.code || error?.message || 'WS_ERROR')
        .replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 100);
      finish('ERROR_' + code);
    });
  });
}

async function probeRestFallback() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(REST_URL, {signal: controller.signal, headers: {accept: 'application/json'}});
    if (!response.ok) return 'HTTP_' + response.status;
    const body = await response.json();
    return Number.isFinite(Number(body?.serverTime)) ? 'LIVE' : 'INVALID_TIME_RESPONSE';
  } catch (error) {
    return error?.name === 'AbortError' ? 'TIMEOUT' :
      'ERROR_' + String(error?.code || error?.message || 'REST_ERROR').replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 100);
  } finally {
    clearTimeout(timer);
  }
}

const websocket = await probeWebSocket();
const rest = websocket === 'LIVE_MESSAGE' ? 'NOT_NEEDED' : await probeRestFallback();
const result = {
  probe: 'BINANCE_SPOT_MARKET_DATA_ONLY',
  websocket_endpoint: 'wss://data-stream.binance.vision/stream',
  websocket,
  rest_market_data_endpoint: 'https://data-api.binance.vision/api/v3/time',
  rest,
  fallback_policy: websocket === 'LIVE_MESSAGE' ? 'WEBSOCKET_LIVE' :
    rest === 'LIVE' ? 'USE_EXISTING_SHARED_REST_KLINE_OBSERVER_ONLY' : 'NO_TRANSPORT_AVAILABLE',
  rest_requests_made_by_probe: websocket === 'LIVE_MESSAGE' ? 0 : 1,
  per_symbol_rest_requests_added: 0,
  market_wide_cache_coverage_ready: false,
  note: 'Connectivity smoke test only; it does not warm all symbol klines or authorize Shadow.'
};
console.log('[MARKET_DATA_CONNECTIVITY_SMOKE] ' + JSON.stringify(result));
if (websocket !== 'LIVE_MESSAGE' && rest !== 'LIVE') process.exitCode = 1;
