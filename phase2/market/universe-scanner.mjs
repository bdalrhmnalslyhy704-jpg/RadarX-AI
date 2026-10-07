import {
  validateSeries,
  lastClosedIndex,
  liquidityQuality as scoreLiquidity
} from '../../phase1/radarx-phase1-engine.mjs';
import {listActiveStrategies, normalizeStrategyResult} from '../../phase1/strategy-registry.mjs';
import {FUTURE_DATA_CLOCK_SKEW_MS, futureIssues, normalizeEpochMs, timestampUnit} from '../core/data-quality.mjs';

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
  maxBackoffMs: 2000,
  bottomDiscoveryPool: 50,
  bottomDeepConcurrency: 8,
  bottomDeepKlines: 180
});

const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const unique = a => [...new Set(a)];
const mean = a => a.length ? a.reduce((s, x) => s + Number(x), 0) / a.length : null;
const avgDefined = (values, fallback = 50) => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
};
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number(x)));

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
  const highPrice24h = Number(ticker.highPrice);
  const lowPrice24h = Number(ticker.lowPrice);
  const tickerTime = ['closeTime','eventTime','openTime'].map(key => Number(ticker[key])).find(Number.isFinite) ?? null;
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
    priceChange24h: change,
    highPrice24h: Number.isFinite(highPrice24h) && highPrice24h > 0 ? highPrice24h : null,
    lowPrice24h: Number.isFinite(lowPrice24h) && lowPrice24h > 0 ? lowPrice24h : null,
    tickerTime
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

export function rankBottomTickerRows(tickers, symbols, {
  minQuoteVolume24h = MARKET_RADAR_DEFAULTS.minQuoteVolume24h,
  limit = MARKET_RADAR_DEFAULTS.bottomDiscoveryPool
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
    .map(x => {
      const range = Number.isFinite(x.highPrice24h) && Number.isFinite(x.lowPrice24h) && x.highPrice24h > x.lowPrice24h
        ? x.highPrice24h - x.lowPrice24h
        : null;
      const position = range && Number.isFinite(x.lastPrice)
        ? clamp((x.lastPrice - x.lowPrice24h) / range * 100)
        : 50;
      const drawdownPct = x.highPrice24h > 0
        ? clamp((x.highPrice24h - x.lastPrice) / x.highPrice24h * 100)
        : 0;
      const proximityScore = 100 - position;
      const drawdownScore = clamp(drawdownPct * 5);
      const sellOffScore = clamp(50 - x.priceChange24h * 4);
      const liquidityScore = logNorm(x.quoteVolume24h, minQuoteVolume24h, maxVolume);
      const activityScore = logNorm(x.tradeCount24h, 100, maxTrades);
      return {
        ...x,
        bottom_discovery_score:
          proximityScore * 0.38 +
          drawdownScore * 0.27 +
          sellOffScore * 0.15 +
          liquidityScore * 0.12 +
          activityScore * 0.08,
        range_position_pct: position,
        drawdown_from_high_pct: drawdownPct
      };
    })
    .sort((a, b) =>
      b.bottom_discovery_score - a.bottom_discovery_score ||
      b.quoteVolume24h - a.quoteVolume24h ||
      a.symbol.localeCompare(b.symbol)
    )
    .slice(0, Math.max(1, Math.trunc(limit)));
}

function normalizeRawKlines(rows, source, now) {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 11) return null;
    return {
      openTime: normalizeEpochMs(row[0], 'openTime'),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: normalizeEpochMs(row[6], 'closeTime'),
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
  return futureIssues(candles, now).length > 0;
}

function emitTimeDiagnostics({symbol, series, ticker, completedAt, sources}) {
  if (process.env.RADARX_TIME_DIAGNOSTICS !== '1') return;
  const trigger = Array.isArray(series['15m']) ? series['15m'] : [];
  const latestKline = trigger.at(-1) ?? null;
  const latestClosedKline = latestClosed(trigger);
  const units = [...new Set(['4h','1h','15m'].flatMap(tf => (series[tf] || []).slice(-2).flatMap(c => [timestampUnit(c.openTime), timestampUnit(c.closeTime)])))];
  const all = ['4h','1h','15m'].flatMap(tf => series[tf] || []);
  console.info('RADARX_TIME_DIAGNOSTIC', JSON.stringify({
    symbol,
    serverNowMs: completedAt,
    latestKlineOpenTime: latestKline?.openTime ?? null,
    latestKlineCloseTime: latestKline?.closeTime ?? null,
    latestClosedKlineOpenTime: latestClosedKline?.openTime ?? null,
    latestClosedKlineCloseTime: latestClosedKline?.closeTime ?? null,
    latestTickerTime: Number.isFinite(Number(ticker?.tickerTime)) ? Number(ticker.tickerTime) : null,
    timestampUnit: units.length === 1 ? units[0] : units,
    source: [...new Set(sources.filter(Boolean))].join(' | ') || 'UNKNOWN',
    currentOpenCandle: Boolean(latestKline && latestKline.openTime <= completedAt && latestKline.closeTime > completedAt && latestKline.closed === false),
    futureIssues: futureIssues(all, completedAt),
    clockSkewToleranceMs: FUTURE_DATA_CLOCK_SKEW_MS
  }));
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

const REQUIRED_DATA_TIMEFRAMES=Object.freeze({'4h':'4h','1h':'1h','15m':'15m',EMA20:'1h',EMA50:'1h',EMA100:'1h',EMA200:'1h',ADX14:'1h','+DI14':'1h','-DI14':'1h',MACD12_26_9:'MACD',BB20_2:'1h',RSI14:'1h',DAILY_VWAP:'15m',RVOL20:'15m',PRICE_ACTION:'15m',ATR14:'15m',ATR_BASELINE20:'15m',PRICE_CONFIRMATION:'15m'});
const TIMEFRAME_MS=Object.freeze({'15m':900000,'1h':3600000,'4h':14400000});
function requirementAvailable(required,context){
  const tf=REQUIRED_DATA_TIMEFRAMES[required];
  if(tf==='MACD')return Array.isArray(context.series['1h'])&&context.series['1h'].length>0&&Array.isArray(context.series['4h'])&&context.series['4h'].length>0;
  if(tf)return Array.isArray(context.series[tf])&&context.series[tf].length>0;
  if(required==='depth')return Boolean(context.depth?.bids?.length&&context.depth?.asks?.length);
  if(required==='ticker24h')return Number.isFinite(Number(context.ticker?.quoteVolume24h))&&Number.isFinite(Number(context.ticker?.tradeCount24h));
  return false;
}
function requiredDataStatus(strategy,context){
  const required=[...strategy.requiredData],available=required.filter(x=>requirementAvailable(x,context)),missing=required.filter(x=>!available.includes(x));
  return {required,available,missing,ratio:required.length?available.length/required.length:0};
}
function makeInsufficientStrategyResult(strategy,status){
  return {strategy:strategy.id,direction:'NONE',state:'INSUFFICIENT_DATA',score:{},evidence:{required_data:status.required,available_data:status.available,missing_data:status.missing},reasonCodes:['INSUFFICIENT_DATA','MISSING_REQUIRED_DATA'],hardGatesPassed:false,dataQuality:0};
}
function buildStrategyBook(depth,liquidity){
  if(!depth?.bids?.length||!depth?.asks?.length)return null;
  const totalDepth=Number(liquidity?.totalDepth),bidDepth=Number(liquidity?.bidDepth),askDepth=Number(liquidity?.askDepth);
  const obi=Number.isFinite(totalDepth)&&totalDepth>0&&Number.isFinite(bidDepth)&&Number.isFinite(askDepth)?(bidDepth-askDepth)/totalDepth:null;
  return {bid:Number(liquidity?.bid),ask:Number(liquidity?.ask),spreadBps:Number.isFinite(Number(liquidity?.spreadBps))?Number(liquidity.spreadBps):null,obi,liquidityQuality:Number(liquidity?.quality)||0};
}
function strategyHardGateStatus(strategy,status,context,liquidity,rawResult){
  const failed=[];
  if(status.missing.length)failed.push('MISSING_REQUIRED_DATA');
  for(const tf of ['4h','1h','15m'])if(status.required.includes(tf)&&(!Array.isArray(context.series[tf])||!context.validSeries[tf]))failed.push('CANDLE_INTEGRITY_FAILURE:'+tf);
  if(context.future)failed.push('FUTURE_DATA');
  if(context.staleTimeframes.some(tf=>status.required.includes(tf)))failed.push('STALE_DATA');
  if(strategy.hardGates.includes('LIQUIDITY_GATE')&&liquidity.allowed!==true)failed.push('LIQUIDITY_GATE_FAILED');
  if(rawResult?.hardGatesPassed===false)failed.push('STRATEGY_HARD_GATE_FAILED');
  return {passed:failed.length===0&&rawResult?.state!=='INSUFFICIENT_DATA',failed:[...new Set(failed)]};
}
function chooseStrategy(strategies){
  return [...strategies].filter(function(x){return (x.signal_state==='CONFIRMED'||x.signal_state==='CANDIDATE')&&Number.isFinite(Number(x.score?.value));}).sort(function(a,b){return Number(b.score.value)-Number(a.score.value);})[0]||null;
}
function evaluateRegisteredStrategies(args){
  const strategies=args.strategies,series=args.series,depth=args.depth,ticker=args.ticker,liquidity=args.liquidity,context={series,depth,ticker,future:args.future,staleTimeframes:args.staleTimeframes,validSeries:args.validSeries};
  const book=buildStrategyBook(depth,liquidity);
  let overrideResults=null;
  if(typeof args.overrideEvaluator==='function'){
    const legacy=args.overrideEvaluator({symbol:ticker.symbol,series4h:series['4h'],series1h:series['1h'],series15m:series['15m'],book,bookRaw:depth,ticker24hRaw:{quoteVolume:String(ticker.quoteVolume24h),count:String(ticker.tradeCount24h)},source:'BINANCE_PUBLIC_REST',now:args.now},args.config?{config:args.config}:undefined);
    overrideResults=new Map(Object.values(legacy?.strategies||{}).map(function(result){return [result?.strategy,result];}));
  }
  return strategies.map(function(strategy){
    const status=requiredDataStatus(strategy,context);
    let raw;
    if(status.missing.length){
      raw=makeInsufficientStrategyResult(strategy,status);
    }else{
      try{
        if(overrideResults?.has(strategy.id)){
          raw=overrideResults.get(strategy.id);
        }else{
          raw=strategy.evaluator({symbol:ticker.symbol,series4h:series['4h'],series1h:series['1h'],series15m:series['15m'],book,bookRaw:depth,ticker24hRaw:{quoteVolume:String(ticker.quoteVolume24h),count:String(ticker.tradeCount24h)},liquidityQuality:liquidity.quality,config:args.config,source:'BINANCE_PUBLIC_REST',now:args.now});
        }
      }catch(error){
        raw={strategy:strategy.id,direction:'NONE',state:'REJECTED',score:{},evidence:{error:String(error?.message||error)},reasonCodes:['STRATEGY_EVALUATION_ERROR'],hardGatesPassed:false,dataQuality:0};
      }
    }
    const gates=strategyHardGateStatus(strategy,status,context,liquidity,raw);
    const normalized=normalizeStrategyResult(strategy.id,raw,{coverage:{required:status.required,available:status.available,ratio:status.ratio},hardGatesPassed:gates.passed,dataQuality:gates.passed?100:0});
    const accepted=gates.passed&&(normalized.signal_state==='CANDIDATE'||normalized.signal_state==='CONFIRMED')&&normalized.score.value!==null;
    return Object.assign({},normalized,{state:normalized.signal_state,accepted,hard_gates_passed:gates.passed,hard_gate_status:gates,missing_required_data:status.missing});
  });
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

function ema(values, period) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return null;
  const p = Math.max(2, Math.trunc(period));
  const seed = xs.slice(0, Math.min(p, xs.length)).reduce((a,b)=>a+b,0) / Math.min(p, xs.length);
  let out = seed;
  const alpha = 2 / (p + 1);
  for (const value of xs.slice(Math.min(p, xs.length))) out = alpha * value + (1 - alpha) * out;
  return out;
}

function rsiSeries(values, period = 14) {
  const xs = values.map(Number).filter(Number.isFinite);
  if (xs.length < period + 1) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = xs[i] - xs[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out = Array(period).fill(null);
  out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  for (let i = period + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss)));
  }
  return out;
}

function pivotLows(candles, left = 2, right = 2) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const low = Number(candles[i]?.low);
    if (!Number.isFinite(low)) continue;
    let ok = true;
    for (let j = 1; j <= left; j++) if (!(low <= Number(candles[i-j]?.low))) ok = false;
    for (let j = 1; j <= right; j++) if (!(low <= Number(candles[i+j]?.low))) ok = false;
    if (ok) out.push({index:i, price:low, time:Number(candles[i]?.closeTime)||null});
  }
  return out;
}

function pivotHighs(candles, left = 2, right = 2) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const high = Number(candles[i]?.high);
    if (!Number.isFinite(high)) continue;
    let ok = true;
    for (let j = 1; j <= left; j++) if (!(high >= Number(candles[i-j]?.high))) ok = false;
    for (let j = 1; j <= right; j++) if (!(high >= Number(candles[i+j]?.high))) ok = false;
    if (ok) out.push({index:i, price:high, time:Number(candles[i]?.closeTime)||null});
  }
  return out;
}

export function buildBottomMarketContext(series, ticker, now, {book=null, liquidity=null}={}) {
  const raw15 = Array.isArray(series?.['15m']) ? series['15m'] : [];
  const closed15 = raw15.filter(c =>
    c?.closed !== false &&
    Number.isFinite(Number(c?.closeTime)) &&
    Number(c.closeTime) <= now &&
    Number.isFinite(Number(c?.close)) &&
    Number.isFinite(Number(c?.high)) &&
    Number.isFinite(Number(c?.low))
  );
  const last24 = closed15.slice(-96);
  const closes = last24.map(c=>Number(c.close));
  const highs = last24.map(c=>Number(c.high));
  const lows = last24.map(c=>Number(c.low));
  const volumes = last24.map(c=>Number(c.volume)).filter(Number.isFinite);
  const currentPrice = Number(ticker?.lastPrice);

  const candleHigh = highs.length ? Math.max(...highs) : null;
  const candleLow = lows.length ? Math.min(...lows) : null;
  const high24h = Number.isFinite(Number(ticker?.highPrice24h)) && Number(ticker.highPrice24h)>0
    ? Number(ticker.highPrice24h) : candleHigh;
  const low24h = Number.isFinite(Number(ticker?.lowPrice24h)) && Number(ticker.lowPrice24h)>0
    ? Number(ticker.lowPrice24h) : candleLow;

  const highsPivots = pivotHighs(last24);
  const lowsPivots = pivotLows(last24);
  const latestHigh = highsPivots.at(-1) || null;
  const priorLowBeforeHigh = latestHigh
    ? [...lowsPivots].reverse().find(x=>x.index < latestHigh.index) || null
    : lowsPivots.at(-1) || null;
  const lastRiseHigh = latestHigh || (Number.isFinite(high24h) ? {price:high24h,time:null,index:null} : null);
  const lastRiseLow = priorLowBeforeHigh || (Number.isFinite(low24h) ? {price:low24h,time:null,index:null} : null);

  const lastRisePct = lastRiseLow && lastRiseHigh && lastRiseLow.price>0
    ? (lastRiseHigh.price-lastRiseLow.price)/lastRiseLow.price*100 : null;
  const drawdownFromLastRiseHighPct = lastRiseHigh && lastRiseHigh.price>0 && Number.isFinite(currentPrice)
    ? (lastRiseHigh.price-currentPrice)/lastRiseHigh.price*100 : null;
  const recoveryFromLastRiseLowPct = lastRiseLow && lastRiseLow.price>0 && Number.isFinite(currentPrice)
    ? (currentPrice-lastRiseLow.price)/lastRiseLow.price*100 : null;

  const range = Number.isFinite(high24h)&&Number.isFinite(low24h)&&high24h>low24h ? high24h-low24h : null;
  const rangePositionPct = range && Number.isFinite(currentPrice) ? (currentPrice-low24h)/range*100 : null;

  const rsi = rsiSeries(closes,14);
  const currentRsi = rsi.at(-1) ?? null;
  const prevRsi = rsi.at(-2) ?? null;
  const lowPivots = lowsPivots.slice(-3);
  let bullishDivergence = false;
  if (lowPivots.length >= 2) {
    const a=lowPivots.at(-2), b=lowPivots.at(-1);
    const ra=Number(rsi[a.index]), rb=Number(rsi[b.index]);
    bullishDivergence = Number.isFinite(ra)&&Number.isFinite(rb)&&b.price<a.price&&rb>ra+1.5;
  }
  const rsiScore = Number.isFinite(currentRsi)
    ? bullishDivergence ? 90 : currentRsi<=30 ? 82 : currentRsi<=40 ? 72 : currentRsi<=50 ? 58 : currentRsi<=60 ? 45 : 30
    : null;

  const stochWindow=last24.slice(-14);
  const stHigh=Math.max(...stochWindow.map(c=>Number(c.high)).filter(Number.isFinite));
  const stLow=Math.min(...stochWindow.map(c=>Number(c.low)).filter(Number.isFinite));
  const stochK=Number.isFinite(currentPrice)&&stHigh>stLow ? (currentPrice-stLow)/(stHigh-stLow)*100 : null;
  const prev14=last24.slice(-15,-1);
  const prevHigh=Math.max(...prev14.map(c=>Number(c.high)).filter(Number.isFinite));
  const prevLow=Math.min(...prev14.map(c=>Number(c.low)).filter(Number.isFinite));
  const prevClose=Number(closes.at(-2));
  const prevStoch=Number.isFinite(prevClose)&&prevHigh>prevLow ? (prevClose-prevLow)/(prevHigh-prevLow)*100 : null;
  const stochasticScore = Number.isFinite(stochK)
    ? stochK<=20 && Number.isFinite(prevStoch) && stochK>prevStoch ? 92
      : stochK<=30 ? 76
      : stochK<=50 ? 58
      : 35
    : null;

  const obvWindow=last24.slice(-32);
  let obv=0;
  for(let i=1;i<obvWindow.length;i++){
    const a=Number(obvWindow[i-1]?.close),b=Number(obvWindow[i]?.close),v=Number(obvWindow[i]?.volume);
    if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(v)) continue;
    if(b>a) obv+=v; else if(b<a) obv-=v;
  }
  const upVol=obvWindow.slice(-8).reduce((s,c)=>s+(Number(c.close)>Number(c.open)?Number(c.volume):0),0);
  const downVol=obvWindow.slice(-8).reduce((s,c)=>s+(Number(c.close)<Number(c.open)?Number(c.volume):0),0);
  const obvScore = upVol+downVol>0 ? Math.max(0,Math.min(100,50+(upVol-downVol)/(upVol+downVol)*50)) : null;

  const volShort=last24.slice(-8).map(c=>Number(c.volume)).filter(Number.isFinite);
  const volBase=last24.slice(-40,-8).map(c=>Number(c.volume)).filter(Number.isFinite);
  const avgShort=volShort.length?volShort.reduce((a,b)=>a+b,0)/volShort.length:null;
  const avgBase=volBase.length?volBase.reduce((a,b)=>a+b,0)/volBase.length:null;
  const rvolRatio=Number.isFinite(avgShort)&&Number.isFinite(avgBase)&&avgBase>0?avgShort/avgBase:null;
  const priceShort=Number(closes.at(-1))-Number(closes[Math.max(0,closes.length-9)]);
  const priceBase=Number(closes[Math.max(0,closes.length-17)])-Number(closes[Math.max(0,closes.length-25)]);
  const volumePriceDivergence = Number.isFinite(rvolRatio)
    ? rvolRatio>=1.35 && priceShort<=0 ? 84
      : rvolRatio>=1.15 && priceShort>0 ? 78
      : rvolRatio<0.8 && priceShort<=0 ? 64
      : 45
    : null;

  const ema20_1h=ema((series?.['1h']||[]).filter(c=>c?.closed!==false).map(c=>Number(c.close)).filter(Number.isFinite),20);
  const ema50_1h=ema((series?.['1h']||[]).filter(c=>c?.closed!==false).map(c=>Number(c.close)).filter(Number.isFinite),50);
  const emaReclaim = Number.isFinite(currentPrice)&&Number.isFinite(ema20_1h)&&Number.isFinite(ema50_1h)
    ? currentPrice>ema20_1h && ema20_1h>=ema50_1h ? 88
      : currentPrice>ema20_1h ? 68
      : currentPrice>ema50_1h ? 55
      : 28
    : null;

  const recentRange=last24.slice(-24);
  const rangeLow=Math.min(...recentRange.map(c=>Number(c.low)).filter(Number.isFinite));
  const rangeHigh=Math.max(...recentRange.map(c=>Number(c.high)).filter(Number.isFinite));
  const latestClosed=recentRange.at(-1);
  const priorLows=recentRange.slice(0,-1).map(c=>Number(c.low)).filter(Number.isFinite);
  const priorRangeLow=priorLows.length?Math.min(...priorLows):null;
  const spring = latestClosed && Number.isFinite(priorRangeLow)
    ? Number(latestClosed.low)<priorRangeLow && Number(latestClosed.close)>priorRangeLow
    : false;
  const avgRangeVol = recentRange.map(c=>Number(c.volume)).filter(Number.isFinite);
  const avgRv=avgRangeVol.length?avgRangeVol.reduce((a,b)=>a+b,0)/avgRangeVol.length:null;
  const springVol=Number(latestClosed?.volume);
  const wyckoffScore = spring
    ? Number.isFinite(avgRv)&&springVol>avgRv*1.2 ? 94 : 82
    : Number.isFinite(rvolRatio)&&rvolRatio<0.85 && Number.isFinite(rangeLow)&&Number.isFinite(rangeHigh) ? 58 : 38;

  const vwapDen=last24.reduce((s,c)=>s+(Number(c.volume)||0),0);
  const vwapNum=last24.reduce((s,c)=>s+(((Number(c.high)+Number(c.low)+Number(c.close))/3)*(Number(c.volume)||0)),0);
  const vwap= vwapDen>0 ? vwapNum/vwapDen : null;
  const vwapScore=Number.isFinite(currentPrice)&&Number.isFinite(vwap)
    ? currentPrice>=vwap ? 76 : Math.max(25,76-Math.min(45,(vwap-currentPrice)/vwap*250))
    : null;

  const recent8=last24.slice(-8);
  const prev8=last24.slice(-16,-8);
  const sumFinite=(rows,field)=>rows.reduce((s,x)=>{const v=Number(x?.[field]);return s+(Number.isFinite(v)&&v>0?v:0)},0);
  const recentVolume=sumFinite(recent8,'volume');
  const recentTakerBuy=sumFinite(recent8,'takerBuyBaseVolume');
  const prevTakerBuy=sumFinite(prev8,'takerBuyBaseVolume');
  const recentBuyRatio=recentVolume>0?recentTakerBuy/recentVolume:null;
  const prevVolume=sumFinite(prev8,'volume');
  const prevBuyRatio=prevVolume>0?prevTakerBuy/prevVolume:null;
  const buyRatioScore=Number.isFinite(recentBuyRatio)
    ? clamp(50+(recentBuyRatio-.5)*220+(Number.isFinite(prevBuyRatio)?(recentBuyRatio-prevBuyRatio)*180:0))
    : null;

  const mid=Number.isFinite(Number(liquidity?.bid))&&Number.isFinite(Number(liquidity?.ask))
    ? (Number(liquidity.bid)+Number(liquidity.ask))/2
    : Number.isFinite(currentPrice)?currentPrice:null;
  const depthBand=.005;
  const levels=Array.isArray(book?.bids)&&Array.isArray(book?.asks)
    ? {bids:book.bids.filter(x=>Array.isArray(x)&&Number(x[0])>0&&Number(x[1])>=0),
       asks:book.asks.filter(x=>Array.isArray(x)&&Number(x[0])>0&&Number(x[1])>=0)}
    : {bids:[],asks:[]};
  const bandBids=mid>0?levels.bids.filter(x=>Number(x[0])>=mid*(1-depthBand)):[];
  const bandAsks=mid>0?levels.asks.filter(x=>Number(x[0])<=mid*(1+depthBand)):[];
  const bidNotionals=bandBids.map(x=>Number(x[0])*Number(x[1])).filter(Number.isFinite);
  const askNotionals=bandAsks.map(x=>Number(x[0])*Number(x[1])).filter(Number.isFinite);
  const bidDepthBook=bidNotionals.reduce((a,b)=>a+b,0);
  const askDepthBook=askNotionals.reduce((a,b)=>a+b,0);
  const orderbookImbalance=bidDepthBook+askDepthBook>0
    ? (bidDepthBook-askDepthBook)/(bidDepthBook+askDepthBook) : null;
  const orderbookImbalanceScore=Number.isFinite(orderbookImbalance)
    ? clamp(50+orderbookImbalance*180) : null;
  const largestBid=Math.max(0,...bidNotionals);
  const largestAsk=Math.max(0,...askNotionals);
  const largestBidShare=bidDepthBook>0?largestBid/bidDepthBook:null;
  const largestAskShare=askDepthBook>0?largestAsk/askDepthBook:null;
  const whaleScore=Number.isFinite(largestBidShare)&&Number.isFinite(largestAskShare)
    ? clamp(50+(largestBidShare-largestAskShare)*220+
      (Number.isFinite(orderbookImbalance)?orderbookImbalance*60:0))
    : null;
  const largestBidLevel=bandBids.find(x=>Number(x[0])*Number(x[1])===largestBid);
  const largestAskLevel=bandAsks.find(x=>Number(x[0])*Number(x[1])===largestAsk);
  const nearestBidWallPct=largestBid>0&&mid>0&&largestBidLevel
    ? ((mid-Number(largestBidLevel[0]))/mid)*100 : null;
  const nearestAskWallPct=largestAsk>0&&mid>0&&largestAskLevel
    ? ((Number(largestAskLevel[0])-mid)/mid)*100 : null;

  const downVolRecent=recent8.reduce((s,x)=>s+(Number(x.close)<Number(x.open)?Number(x.volume)||0:0),0);
  const downVolPrev=prev8.reduce((s,x)=>s+(Number(x.close)<Number(x.open)?Number(x.volume)||0:0),0);
  const downVolTrend=downVolPrev>0?downVolRecent/downVolPrev:null;
  const lowerWickRecent=recent8.map(x=>{
    const h=Number(x.high),l=Number(x.low),o=Number(x.open),cl=Number(x.close),r=h-l;
    return r>0?Math.max(0,(Math.min(o,cl)-l)/r):0;
  }).filter(Number.isFinite);
  const avgLowerWick=lowerWickRecent.length?mean(lowerWickRecent):null;
  const localLow=last24.length?Math.min(...last24.map(x=>Number(x.low)).filter(Number.isFinite)):null;
  const lastClose=Number(closes.at(-1));
  const lastRange=Number(latestClosed?.high)-Number(latestClosed?.low);
  const holdLow=Number.isFinite(localLow)&&Number.isFinite(lastClose)&&Number.isFinite(lastRange)
    ? (lastClose-localLow)/Math.max(lastRange,1e-12) : null;
  const exhaustionScore=avgDefined([
    Number.isFinite(recentBuyRatio)?clamp(50+(recentBuyRatio-.5)*220):null,
    Number.isFinite(downVolTrend)?clamp(60+(1-downVolTrend)*100):null,
    Number.isFinite(avgLowerWick)?clamp(40+avgLowerWick*100):null,
    bullishDivergence?92:null,
    spring?94:null
  ],null);

  const bbVals=closes.slice(-60);
  let bbWidthNow=null,bbWidthBase=null,bbWidthRatio=null;
  if(bbVals.length>=40){
    const bbWidths=[];
    for(let i=19;i<bbVals.length;i++){
      const w=bbVals.slice(i-19,i+1);
      const mu=avgDefined(w,null);
      const sd=Math.sqrt(avgDefined(w.map(v=>(v-mu)**2),null));
      bbWidths.push(mu>0?4*sd/mu:null);
    }
    const validWidths=bbWidths.filter(Number.isFinite);
    bbWidthNow=validWidths.at(-1)??null;
    const baseWidths=validWidths.slice(-21,-1);
    bbWidthBase=baseWidths.length?avgDefined(baseWidths,null):null;
    bbWidthRatio=Number.isFinite(bbWidthNow)&&Number.isFinite(bbWidthBase)&&bbWidthBase>0?bbWidthNow/bbWidthBase:null;
  }
  const atrRanges=last24.map(x=>Number(x.high)-Number(x.low)).filter(Number.isFinite);
  const atrRecent=atrRanges.slice(-8).length?avgDefined(atrRanges.slice(-8),null):null;
  const atrBase=atrRanges.slice(-40,-8).length?avgDefined(atrRanges.slice(-40,-8),null):null;
  const atrContractionRatio=Number.isFinite(atrRecent)&&Number.isFinite(atrBase)&&atrBase>0?atrRecent/atrBase:null;
  const dryUpRatio=Number.isFinite(rvolRatio)?rvolRatio:null;
  const squeezeScore=avgDefined([
    Number.isFinite(bbWidthRatio)?clamp(100-(bbWidthRatio*85)):null,
    Number.isFinite(atrContractionRatio)?clamp(100-(atrContractionRatio*85)):null,
    Number.isFinite(dryUpRatio)?clamp(100-(dryUpRatio*70)):null
  ],null);

  const roc4=closes.length>=5&&Number.isFinite(Number(closes.at(-5))) && Number(closes.at(-5))>0
    ? (lastClose-Number(closes.at(-5)))/Number(closes.at(-5))*100 : null;
  const rocPrev4=closes.length>=9&&Number.isFinite(Number(closes.at(-9))) && Number(closes.at(-9))>0
    ? (Number(closes.at(-5))-Number(closes.at(-9)))/Number(closes.at(-9))*100 : null;
  const rsiSlope=Number.isFinite(currentRsi)&&Number.isFinite(prevRsi)?currentRsi-prevRsi:null;
  const atrExpansionRatio=Number.isFinite(atrRecent)&&Number.isFinite(atrBase)&&atrBase>0?atrRecent/atrBase:null;
  const momentumScore=avgDefined([
    Number.isFinite(roc4)?clamp(50+roc4*12):null,
    Number.isFinite(rsiSlope)?clamp(50+rsiSlope*4):null,
    Number.isFinite(atrExpansionRatio)?clamp(50+(atrExpansionRatio-1)*80):null,
    Number.isFinite(buyRatioScore)?buyRatioScore:null
  ],null);

  const pivHigh=latestHigh?.price??null;
  const bosUp=Number.isFinite(pivHigh)&&Number.isFinite(currentPrice)&&currentPrice>pivHigh;
  const hl=Number.isFinite(lastRiseLow?.price)&&Number.isFinite(currentPrice)&&currentPrice>lastRiseLow.price;
  const structureScore=avgDefined([
    Number.isFinite(pivHigh)&&Number.isFinite(currentPrice)?clamp(50+(currentPrice-pivHigh)/Math.max(Math.abs(pivHigh),1e-12)*500):null,
    hl?72:null,
    bullishDivergence?84:null,
    bosUp?95:null
  ],50);

  const mtfScores=[];
  for(const tf of ['4h','1h']){
    const xs=(series?.[tf]||[]).filter(c=>c?.closed!==false&&Number.isFinite(Number(c?.close))).map(c=>Number(c.close));
    if(xs.length>=55){
      const e20v=ema(xs,20),e50v=ema(xs,50),p=xs.at(-1);
      mtfScores.push(p>e20v&&e20v>=e50v?90:p>e20v?72:p>e50v?58:28);
    }
  }
  if(Number.isFinite(structureScore))mtfScores.push(structureScore);
  const mtfAlignmentScore=avgDefined(mtfScores,null);

  const bottomAlgorithmScore=avgDefined([
    Number.isFinite(rsiScore)?rsiScore:null,
    Number.isFinite(stochasticScore)?stochasticScore:null,
    Number.isFinite(obvScore)?obvScore:null,
    Number.isFinite(volumePriceDivergence)?volumePriceDivergence:null,
    Number.isFinite(emaReclaim)?emaReclaim:null,
    Number.isFinite(wyckoffScore)?wyckoffScore:null,
    Number.isFinite(vwapScore)?vwapScore:null,
    Number.isFinite(structureScore)?structureScore:null,
    Number.isFinite(buyRatioScore)?buyRatioScore:null,
    Number.isFinite(orderbookImbalanceScore)?orderbookImbalanceScore:null,
    Number.isFinite(whaleScore)?whaleScore:null,
    Number.isFinite(exhaustionScore)?exhaustionScore:null,
    Number.isFinite(squeezeScore)?squeezeScore:null,
    Number.isFinite(momentumScore)?momentumScore:null,
    Number.isFinite(mtfAlignmentScore)?mtfAlignmentScore:null
  ],null);
  return {
    source:'BINANCE_PUBLIC_REST',
    closed_candles_only:true,
    window_candles_15m:last24.length,
    current_price:Number.isFinite(currentPrice)?currentPrice:null,
    high_24h:Number.isFinite(high24h)?high24h:null,
    low_24h:Number.isFinite(low24h)?low24h:null,
    range_position_pct:Number.isFinite(rangePositionPct)?Math.max(0,Math.min(100,rangePositionPct)):null,
    last_rise:{
      high:Number.isFinite(lastRiseHigh?.price)?lastRiseHigh.price:null,
      high_time:Number.isFinite(lastRiseHigh?.time)?lastRiseHigh.time:null,
      low:Number.isFinite(lastRiseLow?.price)?lastRiseLow.price:null,
      low_time:Number.isFinite(lastRiseLow?.time)?lastRiseLow.time:null,
      rise_pct:Number.isFinite(lastRisePct)?lastRisePct:null,
      drawdown_from_high_pct:Number.isFinite(drawdownFromLastRiseHighPct)?drawdownFromLastRiseHighPct:null,
      recovery_from_low_pct:Number.isFinite(recoveryFromLastRiseLowPct)?recoveryFromLastRiseLowPct:null
    },
    algorithms:{
      rsi14:{value:Number.isFinite(currentRsi)?currentRsi:null,score:Number.isFinite(rsiScore)?rsiScore:null,bullish_divergence:bullishDivergence},
      stochastic14:{k:Number.isFinite(stochK)?stochK:null,score:Number.isFinite(stochasticScore)?stochasticScore:null},
      obv_accumulation:{score:Number.isFinite(obvScore)?obvScore:null},
      volume_price_divergence:{score:Number.isFinite(volumePriceDivergence)?volumePriceDivergence:null,rvol_ratio:Number.isFinite(rvolRatio)?rvolRatio:null},
      ema20_50_reclaim:{score:Number.isFinite(emaReclaim)?emaReclaim:null,ema20:Number.isFinite(ema20_1h)?ema20_1h:null,ema50:Number.isFinite(ema50_1h)?ema50_1h:null},
      wyckoff_spring:{score:wyckoffScore,spring_confirmed:spring},
      vwap_position:{score:Number.isFinite(vwapScore)?vwapScore:null,vwap:Number.isFinite(vwap)?vwap:null},
      price_structure:{score:Number.isFinite(structureScore)?structureScore:null,break_of_structure:bosUp,higher_low:hl},
      taker_flow:{buy_ratio:Number.isFinite(recentBuyRatio)?recentBuyRatio:null,previous_buy_ratio:Number.isFinite(prevBuyRatio)?prevBuyRatio:null,score:Number.isFinite(buyRatioScore)?buyRatioScore:null},
      orderbook_pressure:{imbalance:Number.isFinite(orderbookImbalance)?orderbookImbalance:null,score:Number.isFinite(orderbookImbalanceScore)?orderbookImbalanceScore:null,bid_depth:Number.isFinite(bidDepthBook)?bidDepthBook:null,ask_depth:Number.isFinite(askDepthBook)?askDepthBook:null},
      whale_pressure:{score:Number.isFinite(whaleScore)?whaleScore:null,bid_wall_share:Number.isFinite(largestBidShare)?largestBidShare:null,ask_wall_share:Number.isFinite(largestAskShare)?largestAskShare:null,bid_wall_distance_pct:Number.isFinite(nearestBidWallPct)?nearestBidWallPct:null,ask_wall_distance_pct:Number.isFinite(nearestAskWallPct)?nearestAskWallPct:null,heuristic:true},
      sell_exhaustion:{score:Number.isFinite(exhaustionScore)?exhaustionScore:null,down_volume_ratio:Number.isFinite(downVolTrend)?downVolTrend:null,lower_wick_avg:Number.isFinite(avgLowerWick)?avgLowerWick:null,hold_low_ratio:Number.isFinite(holdLow)?holdLow:null},
      squeeze:{score:Number.isFinite(squeezeScore)?squeezeScore:null,bb_width_ratio:Number.isFinite(bbWidthRatio)?bbWidthRatio:null,atr_contraction_ratio:Number.isFinite(atrContractionRatio)?atrContractionRatio:null,volume_dry_ratio:Number.isFinite(dryUpRatio)?dryUpRatio:null},
      momentum_awaken:{score:Number.isFinite(momentumScore)?momentumScore:null,roc4:Number.isFinite(roc4)?roc4:null,roc_prev4:Number.isFinite(rocPrev4)?rocPrev4:null,rsi_slope:Number.isFinite(rsiSlope)?rsiSlope:null,atr_ratio:Number.isFinite(atrExpansionRatio)?atrExpansionRatio:null},
      mtf_alignment:{score:Number.isFinite(mtfAlignmentScore)?mtfAlignmentScore:null}
    },
    metrics:{
      buying_pressure:Number.isFinite(buyRatioScore)?buyRatioScore:null,
      selling_exhaustion:Number.isFinite(exhaustionScore)?exhaustionScore:null,
      compression:Number.isFinite(squeezeScore)?squeezeScore:null,
      momentum:Number.isFinite(momentumScore)?momentumScore:null,
      structure:Number.isFinite(structureScore)?structureScore:null,
      whale_pressure:Number.isFinite(whaleScore)?whaleScore:null,
      orderbook_imbalance:Number.isFinite(orderbookImbalanceScore)?orderbookImbalanceScore:null,
      taker_buy_ratio:Number.isFinite(recentBuyRatio)?recentBuyRatio:null,
      mtf_alignment:Number.isFinite(mtfAlignmentScore)?mtfAlignmentScore:null,
      bos_up:bosUp,
      higher_low:hl,
      composite_algorithm_score:Number.isFinite(bottomAlgorithmScore)?bottomAlgorithmScore:null
    }
  };
}

function currentAdenMorningStartMs(now){
  const offsetMs=3*60*60*1000;
  const local=new Date(now+offsetMs);
  local.setUTCHours(4,0,0,0);
  let start=local.getTime()-offsetMs;
  if(start>now) start-=24*60*60*1000;
  return start;
}

export function buildPreMoveContext(series,ticker,now,bottomContext=null,{marketMedianReturn=null,btcReturn=null}={}){
  const raw15=Array.isArray(series?.['15m'])?series['15m']:[];
  const closed15=raw15.filter(c=>c?.closed!==false&&Number.isFinite(Number(c?.closeTime))&&Number(c.closeTime)<=now&&
    Number.isFinite(Number(c?.open))&&Number.isFinite(Number(c?.close))&&Number.isFinite(Number(c?.high))&&Number.isFinite(Number(c?.low))&&
    Number.isFinite(Number(c?.volume)));
  const sessionStartMs=currentAdenMorningStartMs(now);
  const session=closed15.filter(c=>Number(c.closeTime)>=sessionStartMs);
  const first=session[0]||null;
  const current=Number(ticker?.lastPrice);
  const sessionOpen=Number(first?.open);
  const sessionHigh=session.length?Math.max(...session.map(x=>Number(x.high))):null;
  const sessionLow=session.length?Math.min(...session.map(x=>Number(x.low))):null;
  const sessionRange=Number.isFinite(sessionHigh)&&Number.isFinite(sessionLow)&&sessionHigh>sessionLow?sessionHigh-sessionLow:null;
  const sessionReturn=Number.isFinite(current)&&sessionOpen>0?(current-sessionOpen)/sessionOpen*100:null;
  const sessionPosition=Number.isFinite(current)&&Number.isFinite(sessionLow)&&sessionRange>0?(current-sessionLow)/sessionRange*100:null;

  const early4=session.slice(0,4), late4=session.slice(-4), base8=session.slice(-12,-4);
  const avgVol=rows=>rows.length?mean(rows.map(x=>Number(x.volume))):null;
  const earlyVol=avgVol(early4), lateVol=avgVol(late4), baseVol=avgVol(base8);
  const volumeAccel=Number.isFinite(lateVol)&&Number.isFinite(baseVol)&&baseVol>0?lateVol/baseVol:null;
  const takerRatio=rows=>{
    const vol=rows.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
    const buy=rows.reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0);
    return vol>0?buy/vol:null;
  };
  const earlyBuy=takerRatio(early4),lateBuy=takerRatio(late4),baseBuy=takerRatio(base8);
  const takerAcceleration=Number.isFinite(lateBuy)&&Number.isFinite(baseBuy)?lateBuy-baseBuy:null;

  const earlyClose=Number(early4.at(-1)?.close);
  const lateClose=Number(late4.at(-1)?.close);
  const earlyReturn=Number.isFinite(earlyClose)&&sessionOpen>0?(earlyClose-sessionOpen)/sessionOpen*100:null;
  const lateWindowReturn=Number.isFinite(lateClose)&&Number.isFinite(earlyClose)&&earlyClose>0?(lateClose-earlyClose)/earlyClose*100:null;
  const priceAcceleration=Number.isFinite(lateWindowReturn)&&Number.isFinite(earlyReturn)?lateWindowReturn-earlyReturn:null;

  const calmScore=Number.isFinite(sessionReturn)
    ? sessionReturn<=3?100
      : sessionReturn<=6?88
      : sessionReturn<=9?68
      : sessionReturn<=12?45
      : sessionReturn<=18?20
      : 5
    : 30;
  const accelerationScore=avgDefined([
    Number.isFinite(volumeAccel)?clamp(50+(volumeAccel-1)*75):null,
    Number.isFinite(takerAcceleration)?clamp(50+takerAcceleration*520):null,
    Number.isFinite(priceAcceleration)?clamp(50+priceAcceleration*28):null
  ],45);
  const relativeReturn=Number.isFinite(sessionReturn)&&Number.isFinite(marketMedianReturn)?sessionReturn-marketMedianReturn:null;
  const relativeStrengthScore=Number.isFinite(relativeReturn)
    ? clamp(50+relativeReturn*18) : Number.isFinite(btcReturn)&&Number.isFinite(sessionReturn) ? clamp(50+(sessionReturn-btcReturn)*18) : 50;
  const lowReclaimScore=Number.isFinite(sessionPosition)
    ? sessionPosition>=15&&sessionPosition<=70 ? 78
      : sessionPosition<15 ? 58
      : sessionPosition<=85 ? 70
      : 40
    : 45;
  const bottomSnapshot=bottomContext || {};
  const resistance=Number(bottomSnapshot?.last_rise?.high);
  const resistanceDistancePct=Number.isFinite(current)&&current>0&&resistance>current
    ? (resistance-current)/current*100 : resistance>0&&current>=resistance ? 0 : null;
  const resistanceProximityScore=Number.isFinite(resistanceDistancePct)
    ? resistanceDistancePct<=2?92
      : resistanceDistancePct<=5?82
      : resistanceDistancePct<=9?65
      : 42
    : 48;
  const squeeze=Number(bottomSnapshot?.metrics?.compression);
  const structure=Number(bottomSnapshot?.metrics?.structure);
  const buyPressure=Number(bottomSnapshot?.metrics?.buying_pressure);
  const whalePressure=Number(bottomSnapshot?.metrics?.whale_pressure);
  const dataQuality=Number(ticker?.dataQuality);

  const preMoveScore=avgDefined([
    calmScore,
    accelerationScore,
    relativeStrengthScore,
    lowReclaimScore,
    resistanceProximityScore,
    Number.isFinite(squeeze)?squeeze:null,
    Number.isFinite(structure)?structure:null,
    Number.isFinite(buyPressure)?buyPressure:null,
    Number.isFinite(whalePressure)?whalePressure:null
  ],45);

  const alreadyMoved=(Number.isFinite(sessionReturn)&&sessionReturn>12)||(Number(ticker?.priceChange24h)>20);
  const stage=alreadyMoved?'ALREADY_MOVED':
    preMoveScore>=82&&Number.isFinite(sessionReturn)&&sessionReturn<=6?'READY':
    preMoveScore>=72?'EARLY_WAKE':
    preMoveScore>=62?'QUIET_BUILD':
    'NO_SETUP';

  const reasons=[];
  if(Number.isFinite(volumeAccel)&&volumeAccel>=1.25) reasons.push('VOLUME_ACCELERATING');
  if(Number.isFinite(takerAcceleration)&&takerAcceleration>=0.025) reasons.push('TAKER_BUY_ACCELERATING');
  if(Number.isFinite(relativeReturn)&&relativeReturn>=1) reasons.push('RELATIVE_STRENGTH');
  if(Number.isFinite(squeeze)&&squeeze>=65) reasons.push('COMPRESSION');
  if(structure>=65) reasons.push('STRUCTURE_IMPROVING');
  if(Number.isFinite(whalePressure)&&whalePressure>=70) reasons.push('BID_WALL_PRESSURE');
  if(Number.isFinite(sessionReturn)&&sessionReturn<=6) reasons.push('NOT_EXTENDED');
  if(alreadyMoved) reasons.push('ALREADY_EXTENDED');
  if(Number.isFinite(resistanceDistancePct)&&resistanceDistancePct<=5) reasons.push('RESISTANCE_NEAR');

  return {
    timezone:'Asia/Aden',
    window:'04:00–12:00 local session',
    session_start:new Date(sessionStartMs).toISOString(),
    session_close:Number.isFinite(Number(session.at(-1)?.closeTime))?Number(session.at(-1).closeTime):null,
    current_price:Number.isFinite(current)?current:null,
    session_open:Number.isFinite(sessionOpen)?sessionOpen:null,
    session_high:Number.isFinite(sessionHigh)?sessionHigh:null,
    session_low:Number.isFinite(sessionLow)?sessionLow:null,
    session_return_pct:Number.isFinite(sessionReturn)?sessionReturn:null,
    session_position_pct:Number.isFinite(sessionPosition)?clamp(sessionPosition):null,
    early_return_pct:Number.isFinite(earlyReturn)?earlyReturn:null,
    late_window_return_pct:Number.isFinite(lateWindowReturn)?lateWindowReturn:null,
    price_acceleration_pct:Number.isFinite(priceAcceleration)?priceAcceleration:null,
    volume_acceleration:Number.isFinite(volumeAccel)?volumeAccel:null,
    taker_buy_ratio:Number.isFinite(lateBuy)?lateBuy:null,
    taker_buy_acceleration:Number.isFinite(takerAcceleration)?takerAcceleration:null,
    market_median_return_pct:Number.isFinite(marketMedianReturn)?marketMedianReturn:null,
    relative_strength_vs_market_pct:Number.isFinite(relativeReturn)?relativeReturn:null,
    relative_strength_vs_btc_pct:Number.isFinite(btcReturn)&&Number.isFinite(sessionReturn)?sessionReturn-btcReturn:null,
    resistance_distance_pct:Number.isFinite(resistanceDistancePct)?resistanceDistancePct:null,
    score:Number.isFinite(preMoveScore)?Math.round(clamp(preMoveScore)*10)/10:null,
    stage,
    already_moved:alreadyMoved,
    reasons:[...new Set(reasons)],
    components:{
      calm:Number.isFinite(calmScore)?calmScore:null,
      acceleration:Number.isFinite(accelerationScore)?accelerationScore:null,
      relative_strength:Number.isFinite(relativeStrengthScore)?relativeStrengthScore:null,
      low_reclaim:lowReclaimScore,
      resistance_proximity:resistanceProximityScore,
      squeeze:Number.isFinite(squeeze)?squeeze:null,
      structure:Number.isFinite(structure)?structure:null,
      buying_pressure:Number.isFinite(buyPressure)?buyPressure:null,
      whale_pressure:Number.isFinite(whalePressure)?whalePressure:null
    },
    closed_candles_only:true
  };
}

export function rankPreMoveTickerRows(tickers,symbols,{minQuoteVolume24h=MARKET_RADAR_DEFAULTS.minQuoteVolume24h,limit=30}={}){
  const allowed=new Set(symbols.map(x=>x.symbol));
  return (Array.isArray(tickers)?tickers:[])
    .map(x=>normalizeTickerRow(x,symbols[0]?.quoteAsset||'USDT'))
    .filter(Boolean)
    .filter(x=>allowed.has(x.symbol)&&x.quoteVolume24h>=minQuoteVolume24h)
    .map(x=>{
      const change=Math.abs(x.priceChange24h);
      const calm=change<=3?100:change<=6?88:change<=10?68:change<=15?45:change<=20?20:5;
      return {...x,pre_move_discovery_score:
        logNorm(x.quoteVolume24h,minQuoteVolume24h,Math.max(minQuoteVolume24h*1000,x.quoteVolume24h))*0.45+
        logNorm(x.tradeCount24h,100,Math.max(1000000,x.tradeCount24h))*0.25+
        calm*0.30};
    })
    .sort((a,b)=>b.pre_move_discovery_score-a.pre_move_discovery_score||b.quoteVolume24h-a.quoteVolume24h||a.symbol.localeCompare(b.symbol))
    .slice(0,Math.max(1,Math.trunc(limit)));
}

export function buildHistoricalFollowThrough(candles,now=Date.now(),{
  matchThreshold=68,
  maxSamples=8,
  shortBars=6,
  longBars=24
}={}){
  const rows=(Array.isArray(candles)?candles:[]).filter(c=>
    c?.closed!==false&&Number.isFinite(Number(c?.closeTime))&&Number(c.closeTime)<=now&&
    Number(c.open)>0&&Number(c.high)>=Number(c.low)&&Number(c.low)>0&&Number(c.close)>0&&
    Number(c.volume)>=0
  );
  if(rows.length<40)return{
    samples:0,score:50,hit_rate_short:null,hit_rate_long:null,median_mfe_short:null,
    median_mfe_long:null,median_mae_short:null,similarity:null,method:'HISTORICAL_ANALOG_V1'
  };
  const avgRange=(a)=>{
    const xs=a.map(x=>(Number(x.high)-Number(x.low))/Math.max(Number(x.close),1e-12)).filter(Number.isFinite);
    return xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
  };
  const vectorAt=(i)=>{
    if(i<20)return null;
    const close=Number(rows[i].close);
    const prev3=Number(rows[i-3].close);
    const prev12=Number(rows[i-12].close);
    const recent=rows.slice(i-3,i+1);
    const base=rows.slice(i-15,i-3);
    const avg=(a,f)=>{const xs=a.map(f).filter(Number.isFinite);return xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;};
    const volR=(avg(recent,x=>Number(x.volume))||0)/(avg(base,x=>Number(x.volume))||1);
    const takerVol=recent.reduce((s,x)=>s+(Number(x.takerBuyBaseVolume)||0),0);
    const totalVol=recent.reduce((s,x)=>s+(Number(x.volume)||0),0);
    const taker=totalVol>0?takerVol/totalVol:null;
    const rr=(avgRange(recent)||0)/(avgRange(base)||1);
    const window20=rows.slice(i-19,i+1);
    const hi=Math.max(...window20.map(x=>Number(x.high)));
    const lo=Math.min(...window20.map(x=>Number(x.low)));
    const pos=hi>lo?(close-lo)/(hi-lo)*100:null;
    let hl=0;
    for(let j=Math.max(1,i-6);j<=i;j++)if(Number(rows[j].low)>Number(rows[j-1].low))hl++;
    return {ret3:pct(close,prev3),ret12:pct(close,prev12),volR,taker,rangeR:rr,pos,hl};
  };
  const pctDiff=(a,b,scale)=>Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,Math.min(100,100-Math.abs(a-b)/scale*100)):null;
  const current=vectorAt(rows.length-1);
  if(!current)return{samples:0,score:50,hit_rate_short:null,hit_rate_long:null,median_mfe_short:null,median_mfe_long:null,median_mae_short:null,similarity:null,method:'HISTORICAL_ANALOG_V1'};
  const specs=[['ret3',.20,1.2],['ret12',.12,4],['volR',.20,.9],['taker',.16,.10],['rangeR',.12,.45],['pos',.10,28],['hl',.10,4]];
  const analogs=[];
  const lastUsable=rows.length-1-longBars;
  for(let i=20;i<=lastUsable;i++){
    const v=vectorAt(i);
    if(!v)continue;
    let total=0,weight=0;
    for(const [key,w,scale] of specs){
      const s=pctDiff(Number(current[key]),Number(v[key]),scale);
      if(s==null)continue;
      total+=s*w;weight+=w;
    }
    const similarity=weight>0?total/weight:0;
    if(similarity>=matchThreshold){
      const base=Number(rows[i].close);
      const future=rows.slice(i+1,i+1+longBars);
      const short=future.slice(0,shortBars);
      const mfe=(xs)=>xs.length?Math.max(...xs.map(x=>(Number(x.high)-base)/base*100)):null;
      const mae=(xs)=>xs.length?Math.min(...xs.map(x=>(Number(x.low)-base)/base*100)):null;
      const mfeS=mfe(short),mfeL=mfe(future),maeS=mae(short);
      if(Number.isFinite(mfeS)&&Number.isFinite(mfeL)){
        analogs.push({similarity,mfeS,mfeL,maeS});
      }
    }
  }
  analogs.sort((a,b)=>b.similarity-a.similarity);
  const selected=analogs.slice(0,Math.max(1,Math.min(maxSamples,analogs.length)));
  if(!selected.length)return{
    samples:0,score:50,hit_rate_short:null,hit_rate_long:null,median_mfe_short:null,
    median_mfe_long:null,median_mae_short:null,similarity:null,method:'HISTORICAL_ANALOG_V1'
  };
  const median=(xs)=>{
    const a=xs.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
    if(!a.length)return null;
    const m=Math.floor(a.length/2);
    return a.length%2?a[m]:(a[m-1]+a[m])/2;
  };
  const hitS=selected.filter(x=>x.mfeS>=2).length/selected.length;
  const hitL=selected.filter(x=>x.mfeL>=5).length/selected.length;
  const medS=median(selected.map(x=>x.mfeS));
  const medL=median(selected.map(x=>x.mfeL));
  const medMae=median(selected.map(x=>x.maeS));
  const sim=median(selected.map(x=>x.similarity));
  const score=clamp(
    50+
    (hitS-.5)*55+
    (hitL-.5)*35+
    Math.max(-12,Math.min(12,(Number(medS)||0)-1))*1.5+
    Math.max(-10,Math.min(10,(Number(medL)||0)-2))*.8-
    Math.max(0,Math.abs(Number(medMae)||0)-1)*5+
    ((Number(sim)||50)-68)*.12
  );
  return{
    samples:selected.length,
    score:Number(score.toFixed(1)),
    hit_rate_short:Number((hitS*100).toFixed(1)),
    hit_rate_long:Number((hitL*100).toFixed(1)),
    median_mfe_short:Number(Number(medS).toFixed(2)),
    median_mfe_long:Number(Number(medL).toFixed(2)),
    median_mae_short:Number(Number(medMae).toFixed(2)),
    similarity:Number(Number(sim).toFixed(1)),
    method:'HISTORICAL_ANALOG_V1',
    target_short:'+2% within 30m',
    target_long:'+5% within 2h'
  };
}

export function buildFastImpulseContext(candles,ticker,now){
  const closed=(Array.isArray(candles)?candles:[])
    .filter(c=>c?.closed!==false&&Number.isFinite(Number(c?.closeTime))&&Number(c.closeTime)<=now&&
      Number.isFinite(Number(c?.open))&&Number.isFinite(Number(c?.high))&&
      Number.isFinite(Number(c?.low))&&Number.isFinite(Number(c?.close))&&
      Number.isFinite(Number(c?.volume)));
  if(closed.length<30)return{available:false,closed_candles_only:true,candle_count:closed.length,score:null,stage:'INSUFFICIENT'};
  const closes=closed.map(c=>Number(c.close));
  const recent=closed.slice(-3),prev3=closed.slice(-6,-3),base=closed.slice(-27,-6);
  const avg=(rows,field)=>{const xs=rows.map(x=>Number(x?.[field])).filter(Number.isFinite);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null};
  const sum=(rows,field)=>rows.reduce((s,x)=>{const v=Number(x?.[field]);return s+(Number.isFinite(v)&&v>0?v:0)},0);
  const avgRange=rows=>{const xs=rows.map(x=>Number(x.high)-Number(x.low)).filter(Number.isFinite);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null};
  const avgBodyStrength=rows=>{const xs=rows.map(x=>{const h=Number(x.high),l=Number(x.low),o=Number(x.open),cl=Number(x.close),r=h-l;return r>0?Math.max(0,(cl-o)/r):0}).filter(Number.isFinite);return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null};
  const last=closed.at(-1),previous=closed.at(-2),currentClose=Number(last.close),lastRange=Math.max(Number(last.high)-Number(last.low),1e-12);
  const closeLocation=clamp((currentClose-Number(last.low))/lastRange*100);
  const recentVol=avg(recent,'volume'),baseVol=avg(base,'volume');
  const volumeRatio=Number.isFinite(recentVol)&&Number.isFinite(baseVol)&&baseVol>0?recentVol/baseVol:null;
  const recentBuyVol=sum(recent,'takerBuyBaseVolume'),recentVolSum=sum(recent,'volume');
  const prevBuyVol=sum(prev3,'takerBuyBaseVolume'),prevVolSum=sum(prev3,'volume');
  const buyRatio=recentVolSum>0?recentBuyVol/recentVolSum:null;
  const prevBuyRatio=prevVolSum>0?prevBuyVol/prevVolSum:null;
  const buyDelta=Number.isFinite(buyRatio)&&Number.isFinite(prevBuyRatio)?buyRatio-prevBuyRatio:null;
  const roc15=closes.length>=4&&closes.at(-4)>0?(currentClose-closes.at(-4))/closes.at(-4)*100:null;
  const roc30=closes.length>=7&&closes.at(-7)>0?(currentClose-closes.at(-7))/closes.at(-7)*100:null;
  const roc60=closes.length>=13&&closes.at(-13)>0?(currentClose-closes.at(-13))/closes.at(-13)*100:null;
  const acceleration=Number.isFinite(roc15)&&Number.isFinite(roc30)?roc15-(roc30/2):null;
  const ema9=ema(closes,9),ema21=ema(closes,21);
  const emaAlignment=Number.isFinite(ema9)&&Number.isFinite(ema21)?currentClose>ema9&&ema9>=ema21?92:currentClose>ema9?72:currentClose>ema21?55:30:null;
  const prior20=closed.slice(-21,-1);
  const priorHigh=Math.max(...prior20.map(x=>Number(x.high)).filter(Number.isFinite));
  const breakout=Number.isFinite(priorHigh)&&currentClose>=priorHigh;
  const breakoutDistance=Number.isFinite(priorHigh)&&priorHigh>0?(currentClose-priorHigh)/priorHigh*100:null;
  const breakoutScore=breakout?95:Number.isFinite(breakoutDistance)&&breakoutDistance>=-0.5?82:Number.isFinite(breakoutDistance)&&breakoutDistance>=-1.5?68:42;
  const recentRange=avgRange(recent),baseRange=avgRange(base);
  const rangeRatio=Number.isFinite(recentRange)&&Number.isFinite(baseRange)&&baseRange>0?recentRange/baseRange:null;
  const rangeExpansionScore=Number.isFinite(rangeRatio)?clamp(50+(rangeRatio-1)*85):50;
  const volumeScore=Number.isFinite(volumeRatio)?clamp(50+(volumeRatio-1)*80):45;
  const buyScore=Number.isFinite(buyRatio)?clamp(50+(buyRatio-.5)*300+(Number.isFinite(buyDelta)?buyDelta*240:0)):45;
  const momentumScore=clamp(
    (Number.isFinite(roc15)?clamp(50+roc15*20):45)*0.45+
    (Number.isFinite(roc30)?clamp(50+roc30*12):45)*0.25+
    (Number.isFinite(acceleration)?clamp(50+acceleration*35):45)*0.30
  );
  const bodyStrength=avgBodyStrength(recent);
  const bodyScore=Number.isFinite(bodyStrength)?clamp(50+bodyStrength*90):45;
  const fastScore=clamp(momentumScore*0.24+volumeScore*0.20+buyScore*0.16+breakoutScore*0.14+emaAlignment*0.10+rangeExpansionScore*0.07+bodyScore*0.05+closeLocation*0.04);
  const leaders=[
    volumeScore>=62?'FAST_VOLUME_AWAKENING':null,
    momentumScore>=62?'FAST_MOMENTUM_AWAKENING':null,
    buyScore>=62?'FAST_TAKER_BUY_PRESSURE':null,
    breakoutScore>=68?'FAST_BREAKOUT_PRESSURE':null,
    emaAlignment>=68?'FAST_EMA_ALIGNMENT':null,
    rangeExpansionScore>=60?'FAST_RANGE_EXPANSION':null,
    bodyScore>=62?'FAST_BULLISH_BODY':null,
    closeLocation>=70?'FAST_CLOSE_NEAR_HIGH':null,
    Number.isFinite(buyDelta)&&buyDelta>=0.015?'FAST_TAKER_ACCELERATION':null,
    Number.isFinite(acceleration)&&acceleration>0.15?'FAST_PRICE_ACCELERATION':null
  ].filter(Boolean);
  const stage=fastScore>=78?'IMPULSE_START':fastScore>=68?'EARLY_IMPULSE':fastScore>=60?'WATCH':'NEUTRAL';
  return {
    available:true,closed_candles_only:true,interval:'5m',candle_count:closed.length,
    last_closed_time:Number(last.closeTime),previous_closed_time:Number(previous?.closeTime)||null,
    current_close:currentClose,roc_15m:roc15,roc_30m:roc30,roc_60m:roc60,
    acceleration_pct:Number.isFinite(acceleration)?acceleration:null,
    volume_ratio:Number.isFinite(volumeRatio)?volumeRatio:null,
    taker_buy_ratio:Number.isFinite(buyRatio)?buyRatio:null,
    taker_buy_delta:Number.isFinite(buyDelta)?buyDelta:null,
    ema9:Number.isFinite(ema9)?ema9:null,ema21:Number.isFinite(ema21)?ema21:null,
    breakout_of_20:breakout,breakout_distance_pct:Number.isFinite(breakoutDistance)?breakoutDistance:null,
    close_location_pct:closeLocation,range_ratio:Number.isFinite(rangeRatio)?rangeRatio:null,
    scores:{
      momentum:Number.isFinite(momentumScore)?Math.round(momentumScore*10)/10:null,
      volume:Number.isFinite(volumeScore)?Math.round(volumeScore*10)/10:null,
      taker_buy:Number.isFinite(buyScore)?Math.round(buyScore*10)/10:null,
      breakout:Number.isFinite(breakoutScore)?Math.round(breakoutScore*10)/10:null,
      ema:Number.isFinite(emaAlignment)?Math.round(emaAlignment*10)/10:null,
      range_expansion:Number.isFinite(rangeExpansionScore)?Math.round(rangeExpansionScore*10)/10:null,
      body:Number.isFinite(bodyScore)?Math.round(bodyScore*10)/10:null,
      historical_followthrough:Number.isFinite(historicalQuality.score)?Number(historicalQuality.score):null
    },
    score:Math.round(fastScore*10)/10,stage,leaders,historical_followthrough:historicalQuality
  };
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
  const fastImpulseContext = buildFastImpulseContext(deep.fast?.candles || [], ticker, deep.completedAt);
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
  const strategies = Array.isArray(deep.evaluation) ? deep.evaluation : [];
  const best = chooseStrategy(strategies);
  const acceptedStrategies=strategies.filter(function(s){return s.accepted;}).map(function(s){return s.id;});
  const rejectedStrategies=strategies.filter(function(s){return s.signal_state==='REJECTED';});
  const insufficientStrategies=strategies.filter(function(s){return s.signal_state==='INSUFFICIENT_DATA';});

  const hardGateReasons = [];
  if (!seriesComplete) hardGateReasons.push('INSUFFICIENT_CLOSED_DATA');
  if (future) hardGateReasons.push('FUTURE_DATA');
  if (stale) hardGateReasons.push('STALE_DATA');
  if (!v4.valid || !v1.valid || !v15.valid) hardGateReasons.push('CANDLE_INTEGRITY_FAILURE');
  if (!liquidity.allowed) hardGateReasons.push('LIQUIDITY_GATE_FAILED');
  if (liquidity.quality < minLiquidityQuality) hardGateReasons.push('LOW_LIQUIDITY');
  if (!deep.success) hardGateReasons.push('DEEP_SCAN_FAILED');

  const gatePass = deep.success &&
    seriesComplete &&
    !future &&
    !stale &&
    liquidity.allowed === true &&
    liquidity.quality >= minLiquidityQuality &&
    dataQuality >= minDataQuality;

  const overallScore = gatePass && best && Number.isFinite(Number(best.score?.value)) ? Math.round(Number(best.score.value) * 100) / 100 : null;
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

  const bottomContext=buildBottomMarketContext(series, ticker, deep.completedAt, {book: deep.depth, liquidity});
  const preMoveContext=buildPreMoveContext(series, ticker, deep.completedAt, bottomContext);

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

  const activeStrategyCount=listActiveStrategies().length;
  const coverage={required_timeframes:['4h','1h','15m'],available_timeframes:['4h','1h','15m'].filter(function(tf){return Array.isArray(series[tf])&&series[tf].length>0;}),strategy_count:activeStrategyCount,evaluated_strategy_count:strategies.length,ratio:activeStrategyCount?strategies.length/activeStrategyCount:0};

  const lastError = deep.error ? String(deep.error?.message || deep.error) : null;
  const source = combineSource([
    deep.sources?.exchangeInfo,
    deep.sources?.ticker,
    ...(deep.sources?.klines || []),
    deep.sources?.fastKlines,
    deep.sources?.depth
  ]);

  return {
    symbol,
    rank,
    last_price: deep.success ? ticker.lastPrice : null,
    price_change_24h: ticker.priceChange24h,
    high_price_24h: ticker.highPrice24h,
    low_price_24h: ticker.lowPrice24h,
    quote_volume_24h: ticker.quoteVolume24h,
    bottom_context: bottomContext,
    pre_move_context: preMoveContext,
    liquidity_quality: Math.round(Number(liquidity.quality) * 100) / 100,
    data_quality: dataQuality,
    confidence_score: 'UNKNOWN',
    market_regime: 'UNKNOWN',
    overall_score: gatePass && best && Number.isFinite(Number(best.score?.value)) ? Math.round(Number(best.score.value) * 100) / 100 : null,
    coverage,
    decision_band: gatePass ? decisionBand(overallScore) : 'insufficient',
    signal_state: signalState,
    direction: best?.direction || 'NONE',
    best_strategy: best?.id || null,
    strategies,
    accepted_strategies: acceptedStrategies,
    rejected_strategies: rejectedStrategies,
    insufficient_strategies: insufficientStrategies,
    evidence,
    reason_codes: [...new Set(reasonCodes)],
    invalidation,
    risk_flags: [...new Set(riskFlags)],
    fast_impulse_context: fastImpulseContext,
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
    strategyEvaluator = null
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

  async fetchSeries(symbol, interval, limit = this.config.deepKlines) {
    const safeLimit = Math.max(50, Math.trunc(Number(limit) || this.config.deepKlines));
    return withRetry(
      () => this.rest.klines(symbol, interval, { limit: safeLimit }),
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

  async scanSymbol(ticker, rank, sources = {}, options = {}) {
    const klinesLimit = Math.max(50, Math.trunc(Number(options.klinesLimit) || this.config.deepKlines));
    const startedAt = this.clock();
    const series = {};
    const klinesSources = [];
    let depthRaw = null;
    let depthSource = null;
    let fastDeep = {interval:null,candles:[],source:null};
    let error = null;

    try {
      const fastInterval=String(options.fastInterval||'').trim();
      const fastLimit=Math.max(40,Math.trunc(Number(options.fastKlines)||96));
      const [tfResults, depth, fastResult] = await Promise.all([
        Promise.all(
          ['4h','1h','15m'].map(async tf => {
            const r = await this.fetchSeries(ticker.symbol, tf, klinesLimit);
            const fetchedAt = Number(r.receivedAt) || this.clock();
            return {
              tf,
              source: r.source ?? null,
              candles: Array.isArray(r.candles)
                ? r.candles.map(c => ({ ...c, symbol: ticker.symbol, timeframe: tf }))
                : normalizeRawKlines(r.data, r.source, fetchedAt)
            };
          })
        ),
        this.fetchDepth(ticker.symbol),
        fastInterval ? this.fetchSeries(ticker.symbol, fastInterval, fastLimit) : Promise.resolve(null)
      ]);
      for (const r of tfResults) {
        series[r.tf] = r.candles;
        if (r.source) klinesSources.push(r.source);
      }
      const fastCandles=fastResult
        ? Array.isArray(fastResult.candles)
          ? fastResult.candles.map(c=>({...c,symbol:ticker.symbol,timeframe:fastInterval}))
          : normalizeRawKlines(fastResult.data,fastResult.source,Number(fastResult.receivedAt)||this.clock())
        : [];
      fastDeep={interval:fastInterval||null,candles:fastCandles,source:fastResult?.source??null};
      depthRaw = depth?.data ?? depth;
      depthSource = depth?.source ?? null;
    } catch (e) {
      error = e;
    }

    const completedAt=this.clock();
    const deepSuccess=!error&&['4h','1h','15m'].every(function(tf){return Array.isArray(series[tf])&&series[tf].length>0;});
    const liquidity=this.computeLiquidity(depthRaw,ticker);
    const validSeries={'4h':Array.isArray(series['4h'])&&validateSeries(series['4h'],'4h').valid,'1h':Array.isArray(series['1h'])&&validateSeries(series['1h'],'1h').valid,'15m':Array.isArray(series['15m'])&&validateSeries(series['15m'],'15m').valid};
    const future=futureData(['4h','1h','15m'].flatMap(function(tf){return Array.isArray(series[tf])?series[tf]:[];}),completedAt);
    const staleTimeframes=['4h','1h','15m'].filter(function(tf){const last=latestClosed(series[tf]||[]);return !last||completedAt-Number(last.closeTime)>TIMEFRAME_MS[tf]*2;});
    const evaluation=evaluateRegisteredStrategies({strategies:listActiveStrategies(),series,depth:depthRaw,ticker,liquidity,future,staleTimeframes,validSeries,now:completedAt,config:this.strategyConfig,overrideEvaluator:this.strategyEvaluator});
    const fetchAges = ['4h', '1h', '15m']
      .map(tf => series[tf])
      .filter(Array.isArray)
      .map(c => Number(c?.at?.(-1)?.sourceTime));

    emitTimeDiagnostics({symbol:ticker.symbol,series,ticker,completedAt,sources:[...klinesSources,depthSource]});

    const candidate = buildCandidateContract({
      ticker,
      deep: {
        success: deepSuccess,
        series,
        fast: fastDeep,
        evaluation,
        liquidity,
        depth: depthRaw,
        sources: {
          exchangeInfo: sources.exchangeInfo,
          ticker: sources.ticker,
          klines: klinesSources,
          fastKlines: fastDeep.source,
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

  async scanBottom({ quote = this.config.quote, limit = this.config.scanLimit } = {}) {
    const startedAt = this.clock();
    const normalizedQuote = String(quote || this.config.quote).trim().toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(normalizedQuote)) throw new Error('INVALID_QUOTE');

    this._requests = new Map();

    const info = await this.exchangeInfo(normalizedQuote);
    const universe = buildSpotUniverse(info.data, normalizedQuote);
    const tickerResponse = await this.ticker24h();
    const requested = normalizeRadarLimit(limit, {...this.config, maxScanLimit:50});
    const discoveryLimit = Math.min(
      Math.max(10, requested),
      Math.max(10, Math.min(50, Number(this.config.bottomDiscoveryPool) || 50))
    );
    const discovery = rankBottomTickerRows(tickerResponse.data, universe, {
      minQuoteVolume24h: this.config.minQuoteVolume24h,
      limit: discoveryLimit
    });

    const deepConcurrency = Math.max(
      1,
      Math.min(12, Math.trunc(Number(this.config.bottomDeepConcurrency) || Math.max(this.config.deepConcurrency || 4, 8)))
    );
    const deepKlines = Math.max(
      160,
      Math.min(220, Math.trunc(Number(this.config.bottomDeepKlines) || 220))
    );

    const scanned = await boundedMap(
      discovery,
      deepConcurrency,
      (ticker, i) => this.scanSymbol(
        ticker,
        i + 1,
        {exchangeInfo: info.source, ticker: tickerResponse.source},
        {klinesLimit: deepKlines}
      )
    );

    const valid = scanned
      .filter(Boolean)
      .filter(x => x.data_status?.data_valid === true && Number.isFinite(Number(x.last_price)))
      .sort((a, b) => {
        const aa = Number(a.bottom_context?.metrics?.composite_algorithm_score);
        const bb = Number(b.bottom_context?.metrics?.composite_algorithm_score);
        return (Number.isFinite(bb) ? bb : -1) - (Number.isFinite(aa) ? aa : -1) ||
          Number(b.liquidity_quality) - Number(a.liquidity_quality) ||
          Number(b.quote_volume_24h) - Number(a.quote_volume_24h) ||
          a.symbol.localeCompare(b.symbol);
      });

    const returned = valid.slice(0, requested);
    return {
      meta: {
        live: returned.length > 0,
        paper_trading: true,
        real_order_execution: false,
        confidence_score: 'UNKNOWN',
        radar: 'BOTTOM_REVERSAL'
      },
      as_of: new Date(this.clock()).toISOString(),
      source: 'Binance Public REST',
      universe: {
        requested,
        discovered: discovery.length,
        scanned: scanned.length,
        returned: returned.length,
        eligible_spot_symbols: universe.length,
        ticker_rows: Array.isArray(tickerResponse.data) ? tickerResponse.data.length : 0,
        min_quote_volume_24h: this.config.minQuoteVolume24h,
        deep_scan_cap: discoveryLimit,
        elapsed_ms: Math.max(0, this.clock() - startedAt)
      },
      candidates: returned
    };
  }

  async scanPreMove({ quote = this.config.quote, limit = 30 } = {}) {
    const startedAt=this.clock();
    const normalizedQuote=String(quote||this.config.quote).trim().toUpperCase();
    if(!/^[A-Z]{2,10}$/.test(normalizedQuote)) throw new Error('INVALID_QUOTE');
    this._requests=new Map();

    const info=await this.exchangeInfo(normalizedQuote);
    const universe=buildSpotUniverse(info.data,normalizedQuote);
    const tickerResponse=await this.ticker24h();
    const normalizedLimit=Math.min(50,Math.max(10,normalizeRadarLimit(limit,{...this.config,maxScanLimit:50,scanLimit:30})));
    // Pre-Move is an interactive screen: keep enough liquid symbols for breadth,
    // but do not make the phone wait on a 40-symbol deep scan.
    const discoveryLimit=Math.min(24,Math.max(20,normalizedLimit));
    const discovery=rankPreMoveTickerRows(tickerResponse.data,universe,{
      minQuoteVolume24h:this.config.minQuoteVolume24h,
      limit:discoveryLimit
    });
    const preMoveConcurrency=Math.max(this.config.deepConcurrency,8);
    const preMoveKlines=Math.min(this.config.deepKlines,220);
    const scanned=await boundedMap(
      discovery,
      preMoveConcurrency,
      (ticker,i)=>this.scanSymbol(
        ticker,
        i+1,
        {exchangeInfo:info.source,ticker:tickerResponse.source},
        {klinesLimit:preMoveKlines}
      )
    );
    const valid=scanned.filter(Boolean).filter(x=>x.data_status?.data_valid===true&&Number.isFinite(Number(x.pre_move_context?.session_return_pct)));
    const returns=valid.map(x=>Number(x.pre_move_context.session_return_pct)).filter(Number.isFinite);
    const marketMedianReturn=returns.length?([...returns].sort((a,b)=>a-b)[Math.floor(returns.length/2)]):null;
    const btcReturn=Number(valid.find(x=>x.symbol==='BTCUSDT')?.pre_move_context?.session_return_pct);
    const positiveCount=returns.filter(x=>x>0).length;
    const enriched=valid.map(x=>{
      const ctx=x.pre_move_context;
      const relReturn=Number.isFinite(marketMedianReturn)?Number(ctx.session_return_pct)-marketMedianReturn:null;
      const relScore=Number.isFinite(relReturn)?clamp(50+relReturn*18):Number.isFinite(btcReturn)?clamp(50+(Number(ctx.session_return_pct)-btcReturn)*18):50;
      const components={...ctx.components,relative_strength:relScore};
      const score=avgDefined(Object.values(components),45);
      const alreadyMoved=ctx.already_moved===true;
      const stage=alreadyMoved?'ALREADY_MOVED':
        score>=82&&Number(ctx.session_return_pct)<=6?'READY':
        score>=72?'EARLY_WAKE':
        score>=62?'QUIET_BUILD':'NO_SETUP';
      const reasons=[...(ctx.reasons||[])];
      if(Number.isFinite(relReturn)&&relReturn>=1&&!reasons.includes('RELATIVE_STRENGTH'))reasons.push('RELATIVE_STRENGTH');
      return {...x,pre_move_context:{
        ...ctx,
        market_median_return_pct:Number.isFinite(marketMedianReturn)?marketMedianReturn:null,
        relative_strength_vs_market_pct:Number.isFinite(relReturn)?relReturn:null,
        relative_strength_vs_btc_pct:Number.isFinite(btcReturn)?Number(ctx.session_return_pct)-btcReturn:null,
        score:Math.round(clamp(score)*10)/10,
        stage,
        reasons:[...new Set(reasons)]
      }};
    }).sort((a,b)=>Number(b.pre_move_context.score)-Number(a.pre_move_context.score)||Number(a.pre_move_context.session_return_pct)-Number(b.pre_move_context.session_return_pct));
    const returned=enriched.slice(0,Math.min(10,normalizedLimit));
    return {
      meta:{live:returned.length>0,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',radar:'PRE_MOVE'},
      as_of:new Date(this.clock()).toISOString(),
      source:'Binance Public REST',
      session:{timezone:'Asia/Aden',window:'04:00–12:00 local',market_median_return_pct:marketMedianReturn,btc_return_pct:Number.isFinite(btcReturn)?btcReturn:null,positive_breadth_pct:returns.length?positiveCount/returns.length*100:null},
      universe:{requested:normalizedLimit,discovered:discovery.length,scanned:valid.length,returned:returned.length,eligible_spot_symbols:universe.length,min_quote_volume_24h:this.config.minQuoteVolume24h,elapsed_ms:Math.max(0,this.clock()-startedAt)},
      candidates:returned
    };
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
        confidence_score: 'UNKNOWN',
        strategy_count: listActiveStrategies().length
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
