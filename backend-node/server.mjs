import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import { evaluateSymbolSnapshot } from './engine.mjs';

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
        state.latestSource = base;
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

async function marketSnapshot(symbol, options = {}) {
  const snapshotAt = Date.now();
  const [h4, h1, m15, depth, btc] = await Promise.all([
    fetchJson('/api/v3/klines', {symbol, interval:'4h', limit:'250'}),
    fetchJson('/api/v3/klines', {symbol, interval:'1h', limit:'250'}),
    fetchJson('/api/v3/klines', {symbol, interval:'15m', limit:'500'}),
    fetchJson('/api/v3/depth', {symbol, limit:'100'}),
    options.btc15m
      ? Promise.resolve({data:options.btc15m, source:options.btcSource || 'PRELOADED_BINANCE_REST'})
      : fetchJson('/api/v3/klines', {symbol:'BTCUSDT', interval:'15m', limit:'500'})
  ]);

  const ticker = options.tickerRaw
    ? {data:options.tickerRaw,source:options.tickerSource || 'PRELOADED_BINANCE_REST'}
    : await fetchJson('/api/v3/ticker/24hr', {symbol});

  const uniqueSources = [...new Set([h4.source, h1.source, m15.source, depth.source, ticker.source, btc.source])];
  const snapshotSource = uniqueSources.length === 1 ? uniqueSources[0] : 'MULTIPLE_BINANCE_REST';
  const result = evaluateSymbolSnapshot({
    symbol,
    series4h:h4.data.map(normalizeKline),
    series1h:h1.data.map(normalizeKline),
    series15m:m15.data.map(normalizeKline),
    btc15m:btc.data.map(normalizeKline),
    bookRaw:depth.data,
    ticker24hRaw:ticker.data,
    source:snapshotSource,
    now:snapshotAt
  });
  const dataValid = result.diagnostics?.dataQuality > 0 && result.diagnostics?.futureDataDetected !== true;
  const latestClosedCandle = result.diagnostics?.latestClosed15m ?? null;
  const lastError = dataValid ? null : 'INVALID_MARKET_DATA';

  state.latestSuccessAt = snapshotAt;
  state.latestDataValid = dataValid;
  state.latestClosedCandle = latestClosedCandle;
  state.latestSource = snapshotSource;
  state.lastError = lastError;

  return { result, snapshotAt, dataValid, latestClosedCandle, source:snapshotSource, lastError, ticker:ticker.data };
}

function publicResult(result) {
  return {
    ...result,
    meta: {
      backend:'radarx-public-backend',
      live:true,
      paper_trading:true,
      real_order_execution:false,
      confidence_score:'UNKNOWN'
    }
  };
}

async function refreshForSocket(ws, symbol) {
  try {
    ws.send(JSON.stringify({type:'status',status:'FETCHING',symbol,live:false}));
    const result = await marketSnapshot(symbol);
    ws.send(JSON.stringify({type:'signal', payload:publicResult(result)}));
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

function numericScore(strategy) {
  const values = strategy?.score && typeof strategy.score === 'object' ? Object.values(strategy.score) : [];
  const value = values.find(x => Number.isFinite(Number(x)));
  return value == null ? null : Number(value);
}

function radarStrategy(id, name, score, coverage, passed, direction = 'NONE', state = 'REJECTED', evidence = {}, reasonCodes = []) {
  return {
    id,
    name,
    direction,
    signal_state:state,
    state,
    score:{value:score == null ? null : Math.round(Number(score) * 10) / 10, coverage:coverage == null ? null : coverage},
    hard_gates_passed:Boolean(passed),
    hard_gate_status:{passed:Boolean(passed),failed:passed?[]:['THRESHOLD_OR_DATA']},
    evidence:evidence && typeof evidence === 'object' ? evidence : {},
    reason_codes:Array.isArray(reasonCodes) ? reasonCodes : [],
    invalidation:passed?[]:['FINGERPRINT_GATE_NOT_MET'],
    required_data:['closed_15m','closed_1h','closed_4h','relative_power'],
    missing_required_data:[],
    confidence_score:'UNKNOWN'
  };
}

function buildRadarStrategies(result, dataQualityValue, liquidityQualityValue) {
  const fp = result.fingerprint;
  const base = [
    ['MTF_TREND','تتبّع الاتجاه متعدد الأطر',result.strategies?.trend],
    ['CONFIRMED_BREAKOUT','اختراق مؤكد',result.strategies?.breakout],
    ['MEAN_REVERSION','ارتداد من مناطق التشبع',result.strategies?.meanReversion]
  ].map(([id,name,s]) => {
    const score = numericScore(s);
    const pass = s?.state !== 'REJECTED' && dataQualityValue >= 70 && liquidityQualityValue >= 60 && score != null;
    return radarStrategy(id,name,score,score == null ? 0 : 1,pass,s?.direction || 'NONE',s?.state || 'REJECTED',s?.evidence || {},s?.reasonCodes || []);
  });

  const fpScore = Number(fp?.score);
  const fpDetected = fp?.detected === true && fpScore >= 55 && dataQualityValue >= 70 && liquidityQualityValue >= 60;
  const fpState = ['BREAKOUT','RETEST'].includes(fp?.stage) ? 'CONFIRMED' : fp?.detected ? 'CANDIDATE' : 'REJECTED';
  base.push(radarStrategy(
    'PRE_BREAKOUT_FINGERPRINT',
    'بصمة ما قبل الاختراق',
    Number.isFinite(fpScore) ? fpScore : null,
    Number(fp?.evidenceCount || 0) / 8,
    fpDetected,
    fp?.direction || 'NONE',
    fpState,
    fp?.evidence || {},
    fp?.reasonCodes || []
  ));

  const e = fp?.evidence || {};
  const metricRows = [
    ['EMA_RIBBON_ALIGNMENT','توافق المتوسطات',e.regime?.score, 'LONG'],
    ['ADX_TREND_STRENGTH','قوة الاتجاه',e.regime?.score, 'LONG'],
    ['MACD_TREND_CONTINUATION','استمرار الزخم',e.regime?.score, 'LONG'],
    ['BOLLINGER_BAND_COMPRESSION','ضغط بولينجر',e.compression?.score, 'LONG'],
    ['VWAP_POSITION','موقع VWAP',e.regime?.score, 'LONG'],
    ['RELATIVE_VOLUME_AWAKENING','استيقاظ الحجم',e.volume?.score, 'LONG']
  ];
  for (const [id,name,score,direction] of metricRows) {
    const n=Number(score);
    const pass=Number.isFinite(n) && n>=60 && dataQualityValue>=70 && liquidityQualityValue>=60;
    base.push(radarStrategy(id,name,Number.isFinite(n)?n:null,Number.isFinite(n)?1:0,pass,direction,pass?'CANDIDATE':'REJECTED',{score:n},[]));
  }
  return base.slice(0,10);
}

function buildRadarCandidate(snapshot) {
  const p = publicResult(snapshot);
  const result = p;
  const fp = result.fingerprint;
  const strategies = buildRadarStrategies(result, result.signal?.scores?.data_quality || 0, result.signal?.scores?.liquidity_quality || 0);
  const accepted = strategies.filter(s => s.hard_gates_passed).map(s => s.id);
  const baseScores = strategies.slice(0,3).map(numericScore).filter(x => Number.isFinite(x));
  const fpScore = Number(fp?.score);
  const overall = Math.max(0, ...baseScores, Number.isFinite(fpScore) ? fpScore : 0);
  const fpLeading = fp?.detected === true && Number.isFinite(fpScore) && fpScore >= Math.max(...baseScores,0);
  const best = fpLeading ? 'PRE_BREAKOUT_FINGERPRINT' : (strategies.slice(0,3).sort((a,b)=>(numericScore(b)??-1)-(numericScore(a)??-1))[0]?.id || 'NO_SIGNAL');
  const state = fp?.stage === 'BREAKOUT' || fp?.stage === 'RETEST'
    ? 'CONFIRMED'
    : accepted.length ? 'CANDIDATE' : 'NO_SIGNAL';
  const direction = fp?.direction === 'LONG' ? 'LONG' : (result.signal?.direction || 'NONE');
  const riskFlags = Number(fp?.trapRisk) >= 50 ? ['FINGERPRINT_TRAP_RISK_HIGH'] : [];
  if (fp?.context?.falseBreakout) riskFlags.push('FALSE_BREAKOUT_RISK');
  return {
    symbol:snapshot.result.signal?.symbol,
    last_price:Number(snapshot.result.signal?.price?.reference) || null,
    price_change_24h:Number(snapshot.ticker?.priceChangePercent) || 0,
    quote_volume_24h:Number(snapshot.ticker?.quoteVolume) || 0,
    best_strategy:best,
    direction,
    signal_state:state,
    overall_score:Math.round(overall*10)/10,
    coverage:{ratio:fp?.data?.closed15m>=80?1:0,evidence_ratio:Number(fp?.evidenceCount || 0)/8},
    data_quality:Number(result.signal?.scores?.data_quality || 0),
    liquidity_quality:Number(result.signal?.scores?.liquidity_quality || 0),
    accepted_strategies:accepted,
    strategies,
    evidence:{pre_breakout_fingerprint:fp},
    pre_breakout_fingerprint:fp,
    risk_flags:riskFlags,
    invalidation:fp?.context?.falseBreakout ? ['FALSE_BREAKOUT'] : [],
    reason_codes:[...(fp?.reasonCodes || []),...(result.signal?.reason_codes || [])].slice(0,16),
    data_status:result.signal?.data_status || {},
    as_of:new Date(snapshot.snapshotAt).toISOString()
  };
}

const marketRadarCache={key:'',expiresAt:0,value:null,promise:null};
const MARKET_RADAR_TTL_MS=30000;
const MARKET_RADAR_UNIVERSE_MAX=30;
const STABLE_BASES=new Set(['USDT','USDC','FDUSD','BUSD','TUSD','USDP','DAI','EUR','TRY','BRL','GBP','AUD']);

async function mapLimit(items, limit, worker) {
  const out=Array(items.length); let next=0;
  async function run(){
    while(true){
      const i=next++;
      if(i>=items.length) return;
      try{out[i]=await worker(items[i],i)}catch{out[i]=null}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
  return out;
}

function isScannableUsdtTicker(ticker, quote) {
  const symbol=String(ticker?.symbol || '');
  if(!symbol.endsWith(quote) || !Number.isFinite(Number(ticker?.quoteVolume))) return false;
  const base=symbol.slice(0,-quote.length);
  if(!base || STABLE_BASES.has(base)) return false;
  if(/(?:UP|DOWN|BULL|BEAR|HALF|HEDGE)$/i.test(base)) return false;
  return true;
}

async function buildMarketRadar(quote='USDT',limit=20) {
  const safeQuote=String(quote).toUpperCase();
  const safeLimit=Math.min(20,Math.max(1,Number(limit)||20));
  const key=safeQuote+':'+safeLimit;
  const now=Date.now();
  if(marketRadarCache.value && marketRadarCache.key===key && marketRadarCache.expiresAt>now) return marketRadarCache.value;
  if(marketRadarCache.promise) return marketRadarCache.promise;

  marketRadarCache.key=key;
  marketRadarCache.promise=(async()=>{
    const tickers=await fetchJson('/api/v3/ticker/24hr',{});
    const pool=tickers.data
      .filter(t=>isScannableUsdtTicker(t,safeQuote))
      .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
      .slice(0,Math.max(safeLimit*2,MARKET_RADAR_UNIVERSE_MAX));

    const btcRef=await fetchJson('/api/v3/klines',{symbol:'BTCUSDT',interval:'15m',limit:'500'});
    const results=await mapLimit(pool,5,async ticker=>{
      const snapshot=await marketSnapshot(ticker.symbol,{tickerRaw:ticker,tickerSource:tickers.source,btc15m:btcRef.data.map(normalizeKline),btcSource:btcRef.source});
      const candidate=buildRadarCandidate(snapshot);
      return candidate.data_quality>0 ? candidate : null;
    });
    const candidates=results.filter(Boolean).sort((a,b)=>b.overall_score-a.overall_score).slice(0,safeLimit);
    const value={
      candidates,
      universe:{quote:safeQuote,scanned:pool.length,returned:candidates.length,source:tickers.source},
      as_of:new Date().toISOString(),
      meta:{backend:'radarx-public-backend',live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',fingerprint_version:'prebreakout-fingerprint.v1'}
    };
    marketRadarCache.value=value;
    marketRadarCache.expiresAt=Date.now()+MARKET_RADAR_TTL_MS;
    return value;
  })();

  try{return await marketRadarCache.promise}
  finally{marketRadarCache.promise=null}
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
    const ready = state.latestSuccessAt > 0 && Date.now()-state.latestSuccessAt < STALE_MS;
    return json(res, ready ? 200 : 503, {
      status:ready ? 'ready':'not_ready',
      live_data_ready:ready,
      latest_successful_update:state.latestSuccessAt || null,
      source:state.latestSource,
      last_error:state.lastError
    });
  }

  if (url.pathname === '/api/signal') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    if (!symbol) return json(res, 400, {error:'INVALID_SYMBOL'});
    try {
      return json(res, 200, publicResult(await marketSnapshot(symbol)));
    } catch (error) {
      state.lastError = String(error?.message || error);
      return json(res, 503, {error:'LIVE_DATA_UNAVAILABLE', live:false});
    }
  }

  if (url.pathname === '/api/market-radar') {
    const quote=String(url.searchParams.get('quote') || 'USDT').trim().toUpperCase();
    const limit=Math.min(20,Math.max(1,Number(url.searchParams.get('limit') || 20)));
    if(!/^[A-Z]{2,10}$/.test(quote) || !Number.isInteger(limit) || limit<1) {
      return json(res,400,{error:'INVALID_MARKET_RADAR_QUERY'});
    }
    try {
      const payload=await buildMarketRadar(quote,limit);
      return json(res,200,payload);
    } catch (error) {
      state.lastError=String(error?.message || error);
      return json(res,503,{
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
