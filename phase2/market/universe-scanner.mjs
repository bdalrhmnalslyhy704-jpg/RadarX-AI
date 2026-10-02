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
  maxBackoffMs: 2000
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
    bottom_context: buildBottomMarketContext(series, ticker, deep.completedAt, {book: deep.depth, liquidity}),
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
      const [tfResults, depth] = await Promise.all([
        Promise.all(
          ['4h','1h','15m'].map(async tf => {
            const r = await this.fetchSeries(ticker.symbol, tf);
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
        this.fetchDepth(ticker.symbol)
      ]);
      for (const r of tfResults) {
        series[r.tf] = r.candles;
        if (r.source) klinesSources.push(r.source);
      }
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
        evaluation,
        liquidity,
        depth: depthRaw,
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
