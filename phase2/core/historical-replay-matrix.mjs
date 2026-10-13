export const HISTORICAL_MATRIX_DEFAULT_SYMBOLS=Object.freeze([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT','AVAXUSDT','DOTUSDT',
  'LTCUSDT','BCHUSDT','TRXUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','FETUSDT',
  'RLCUSDT','RADUSDT','ORCAUSDT','API3USDT','DIAUSDT','OGNUSDT','CTSIUSDT','GTCUSDT','WUSDT','FILUSDT'
]);
const HOUR_MS=60*60*1000;
const MAX_WINDOW_MS=7*24*HOUR_MS;
function toMs(value){if(typeof value==='number'&&Number.isFinite(value))return value;const n=Date.parse(String(value??''));return Number.isFinite(n)?n:NaN;}
function clampNumber(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}

// Six-hour slices retain multiple closed BTC hourly candles for observed-regime
// classification while bounding full aggregate-trade pagination in CI. The matrix
// still covers 30 independent Spot USDT symbols across three historical regimes.
export const HISTORICAL_MATRIX_DEFAULT_WINDOWS=Object.freeze([
  Object.freeze({id:'late-2024-rally-candidate',label:'Late 2024 rally candidate — 6h slice',start:'2024-11-06T00:00:00.000Z',end:'2024-11-06T06:00:00.000Z'}),
  Object.freeze({id:'early-2025-selloff-candidate',label:'Early 2025 selloff candidate — 6h slice',start:'2025-02-25T00:00:00.000Z',end:'2025-02-25T06:00:00.000Z'}),
  Object.freeze({id:'late-2024-range-candidate',label:'Late 2024 range candidate — 6h slice',start:'2024-09-10T00:00:00.000Z',end:'2024-09-10T06:00:00.000Z'})
]);

export function normalizeMatrixSymbols(values=HISTORICAL_MATRIX_DEFAULT_SYMBOLS){
  const items=(Array.isArray(values)?values:String(values??'').split(',')).map(x=>String(x??'').trim().toUpperCase()).filter(Boolean);
  if(!items.length)throw new Error('HISTORICAL_MATRIX_EMPTY_SYMBOLS');
  if(items.some(s=>!/^[A-Z0-9]{5,20}$/.test(s)))throw new Error('HISTORICAL_MATRIX_INVALID_SYMBOL');
  return [...new Set(items)];
}

export function normalizeMatrixWindows(windows=HISTORICAL_MATRIX_DEFAULT_WINDOWS,{now=Date.now(),maxWindowMs=MAX_WINDOW_MS}={}){
  if(!Array.isArray(windows)||!windows.length)throw new Error('HISTORICAL_MATRIX_EMPTY_WINDOWS');
  if(windows.length>12)throw new Error('HISTORICAL_MATRIX_TOO_MANY_WINDOWS');
  const ids=new Set();
  return windows.map((raw,index)=>{
    const w=raw&&typeof raw==='object'?raw:{};
    const id=String(w.id??('window-'+(index+1))).trim().toLowerCase();
    if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)||ids.has(id))throw new Error('HISTORICAL_MATRIX_INVALID_OR_DUPLICATE_WINDOW_ID');
    ids.add(id);
    const startMs=toMs(w.start),endMs=toMs(w.end);
    if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs>=endMs)throw new Error('HISTORICAL_MATRIX_INVALID_WINDOW_RANGE:'+id);
    if(endMs>Number(now)+60_000)throw new Error('HISTORICAL_MATRIX_FUTURE_WINDOW:'+id);
    if(endMs-startMs>maxWindowMs)throw new Error('HISTORICAL_MATRIX_WINDOW_OVER_SEVEN_DAYS:'+id);
    return {id,label:String(w.label??id).slice(0,120),start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString(),startMs,endMs};
  });
}

/** Classifies the observed BTCUSDT closed-candle window, not a user-supplied label. */
export function classifyBtcMarketRegime(candles,{minTrendPct=2,maxSidewaysRangePct=4}={}){
  const rows=(Array.isArray(candles)?candles:[]).filter(c=>c&&c.closed!==false&&Number(c.open)>0&&Number(c.close)>0&&Number.isFinite(Number(c.open))&&Number.isFinite(Number(c.close))&&Number.isFinite(Number(c.high))&&Number.isFinite(Number(c.low))&&Number(c.high)>=Number(c.low));
  if(rows.length<3)return {regime:'UNKNOWN',sample_count:rows.length,net_return_pct:null,range_pct:null,reason:'BTC_CLOSED_CANDLE_HISTORY_INSUFFICIENT'};
  rows.sort((a,b)=>Number(a.openTime??a.open_time??0)-Number(b.openTime??b.open_time??0));
  const first=Number(rows[0].open),last=Number(rows[rows.length-1].close);
  const netReturnPct=(last-first)/first*100;
  const highest=Math.max(...rows.map(c=>Number(c.high))),lowest=Math.min(...rows.map(c=>Number(c.low)));
  const rangePct=(highest-lowest)/first*100;
  const trend=clampNumber(minTrendPct,0.25,20,2),sidewaysRange=clampNumber(maxSidewaysRangePct,0.5,25,4);
  let regime='MIXED',reason='BTC_RETURN_OR_RANGE_NOT_DIRECTIONAL';
  if(netReturnPct>=trend){regime='BULL_TREND';reason='BTC_CLOSE_RETURN_ABOVE_THRESHOLD';}
  else if(netReturnPct<=-trend){regime='BEAR_TREND';reason='BTC_CLOSE_RETURN_BELOW_NEGATIVE_THRESHOLD';}
  else if(Math.abs(netReturnPct)<trend&&rangePct<=sidewaysRange){regime='SIDEWAYS';reason='BTC_RETURN_AND_RANGE_WITHIN_SIDEWAYS_BOUNDS';}
  return {regime,sample_count:rows.length,net_return_pct:Number(netReturnPct.toFixed(4)),range_pct:Number(rangePct.toFixed(4)),thresholds:{min_trend_pct:trend,max_sideways_range_pct:sidewaysRange},reason};
}

export function summarizeHistoricalWindowReport(report={}) {
  const rows=Array.isArray(report?.results)?report.results:[];
  const fullTrade=rows.filter(x=>x?.data_quality?.trade_coverage_complete===true&&x?.data_quality?.candle_fetch_complete===true&&Number(x?.summary?.replay_steps)>0);
  const candleFallback=rows.filter(x=>x?.data_quality?.replay_mode==='CANDLE_ONLY_FALLBACK'&&x?.data_quality?.candle_only_fallback_used===true&&x?.data_quality?.candle_fetch_complete===true&&x?.data_quality?.synthetic_data_used===false&&Number(x?.summary?.replay_steps)>0);
  const usable=new Map();
  for(const row of fullTrade)usable.set(row, 'FULL_TRADE');
  for(const row of candleFallback)usable.set(row, 'CANDLE_ONLY_FALLBACK');
  const accepted=rows.reduce((n,x)=>n+Math.max(0,Number(x?.summary?.accepted)||0),0);
  const rejected=rows.reduce((n,x)=>n+Math.max(0,Number(x?.summary?.rejected)||0),0);
  const firstAccepted=rows.map(x=>x?.summary?.first_accepted_at).filter(Boolean).sort()[0]??null;
  const first50=rows.map(x=>x?.summary?.first_actual_window_50pct_at).filter(Boolean).sort()[0]??null;
  const first70=rows.map(x=>x?.summary?.first_actual_window_70pct_at).filter(Boolean).sort()[0]??null;
  const requestedSymbols=Math.max(0,Math.trunc(Number(report?.symbol_count)||rows.length));
  const allReturned=rows.length>0&&rows.length===requestedSymbols;
  const allUsable=allReturned&&usable.size===rows.length;
  const fallbackCount=[...usable.values()].filter(mode=>mode==='CANDLE_ONLY_FALLBACK').length;
  return {
    requested_symbols:requestedSymbols,
    returned_symbol_results:rows.length,
    coverage_complete_symbols:usable.size,
    coverage_incomplete_symbols:Math.max(0,requestedSymbols-usable.size),
    trade_coverage_complete_symbols:fullTrade.length,
    candle_fallback_symbols:fallbackCount,
    accepted_decisions:accepted,
    rejected_decisions:rejected,
    first_accepted_at:firstAccepted,
    first_actual_window_50pct_at:first50,
    first_actual_window_70pct_at:first70,
    coverage_status:!allUsable?'INCOMPLETE_OR_EMPTY':(fallbackCount>0?'COMPLETE_WITH_CANDLE_FALLBACK':'COMPLETE')
  };
}
