import { createHash } from 'node:crypto';

export const SCAN_JOURNEY_SCHEMA = 'RADARX_SCAN_JOURNEY_V1';
export const INCOMPLETE = '.INCOMPLETE';
export const SCAN_JOURNEY_HORIZONS = Object.freeze(['5m','15m','30m','60m','4h','24h']);

export function incomplete(reason='NOT_AVAILABLE') {
  return { value: INCOMPLETE, status: INCOMPLETE, reason: String(reason || 'NOT_AVAILABLE') };
}

function finite(value) {
  return value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value));
}

export function normalizeMissing(value) {
  if (value === null || value === undefined || value === '') return INCOMPLETE;
  if (typeof value === 'number' && !Number.isFinite(value)) return INCOMPLETE;
  if (Array.isArray(value)) return value.map(normalizeMissing);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,normalizeMissing(child)]));
  }
  return value;
}

export function closedCandleSnapshot(rows, asOfMs=Date.now()) {
  const cutoff = Number(asOfMs);
  if (!Array.isArray(rows) || !Number.isFinite(cutoff)) return INCOMPLETE;
  const valid = rows.filter(c => {
    if (!c || c.closed === false) return false;
    const ot = Number(c.openTime), ct = Number(c.closeTime);
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    const v = Number(c.volume);
    return Number.isFinite(ot) && Number.isFinite(ct) && ot < ct && ct <= cutoff &&
      o > 0 && h >= Math.max(o, cl) && l > 0 && l <= Math.min(o, cl) &&
      h >= l && cl > 0 && Number.isFinite(v) && v >= 0;
  }).sort((a,b) => Number(a.closeTime) - Number(b.closeTime));
  return valid.length ? valid.map(c => ({
    open_time:Number(c.openTime),
    close_time:Number(c.closeTime),
    open:Number(c.open),
    high:Number(c.high),
    low:Number(c.low),
    close:Number(c.close),
    volume:Number(c.volume),
    quote_volume:finite(c.quoteVolume) ? Number(c.quoteVolume) : INCOMPLETE,
    trade_count:finite(c.tradeCount ?? c.count) ? Number(c.tradeCount ?? c.count) : INCOMPLETE,
    taker_buy_base_volume:finite(c.takerBuyBaseVolume) ? Number(c.takerBuyBaseVolume) : INCOMPLETE
  })) : INCOMPLETE;
}

export function reconcileEligibilityQueueAge({
  previous=new Map(),universeSymbols=[],tickerBySymbol=new Map(),eligibleSymbols=[],
  minQuoteVolume24h=0,now=Date.now()
}={}) {
  const next=previous instanceof Map?new Map(previous):new Map(Object.entries(previous||{}).map(([k,v])=>[k,Number(v)]));
  const universe=new Set((Array.isArray(universeSymbols)?universeSymbols:[]).map(x=>String(x).toUpperCase()));
  const ticker=(symbol)=>tickerBySymbol instanceof Map?tickerBySymbol.get(symbol):tickerBySymbol?.[symbol];
  for(const symbol of [...next.keys()]) {
    const key=String(symbol).toUpperCase();
    if(!universe.has(key)){next.delete(symbol);continue;}
    const seen=ticker(key);
    // Preserve age for missing or incomplete ticker rows; only clear the queue
    // when observed liquidity proves the symbol is currently below threshold.
    if(seen&&finite(seen.quoteVolume24h)&&Number(seen.quoteVolume24h)<Number(minQuoteVolume24h))
      next.delete(symbol);
  }
  for(const value of Array.isArray(eligibleSymbols)?eligibleSymbols:[]) {
    const symbol=String(value).toUpperCase();
    if(symbol&&universe.has(symbol)&&!next.has(symbol))next.set(symbol,Number(now));
  }
  return next;
}

export function incompleteHorizons(reason='NO_CLOSED_HORIZON_RESULT') {
  return Object.fromEntries(SCAN_JOURNEY_HORIZONS.map(h => [h, {
    status:INCOMPLETE,
    return_pct:INCOMPLETE,
    mark_price:INCOMPLETE,
    mark_time:INCOMPLETE,
    max_favorable_pct:INCOMPLETE,
    max_adverse_pct:INCOMPLETE,
    reason:String(reason)
  }]));
}

export function scanJourneyOutcomesFromRecord(record) {
  if(!record||typeof record!=='object')return incompleteHorizons('NO_MATCHING_OUTCOME_RECORD');
  return Object.fromEntries(SCAN_JOURNEY_HORIZONS.map(h=>{
    const mark=record.marks?.[h],excursion=record.excursions?.[h],horizon=record.horizon_status?.[h];
    const closed=mark?.sample_quality==='HISTORICAL_CLOSED_OHLC';
    const excursionSource=excursion?.source==='HISTORICAL_CLOSED_OHLC';
    const excursionHasValues=excursionSource&&(finite(excursion?.max_favorable_pct)||finite(excursion?.max_adverse_pct));
    const excursionComplete=excursionSource&&excursion?.complete===true;
    const pending=horizon?.status==='PENDING';
    const status=closed&&horizon?.status==='COMPLETE'&&excursionComplete?'COMPLETE':
      closed||excursionHasValues?'PARTIAL_CLOSED_OHLC':
      pending?'PENDING':INCOMPLETE;
    const value=(x)=>finite(x)?Number(x):INCOMPLETE;
    return [h,{
      status,
      return_pct:closed?value(mark?.return_pct):INCOMPLETE,
      mark_price:closed?value(mark?.price):INCOMPLETE,
      mark_time:closed?value(mark?.observed_at):INCOMPLETE,
      max_favorable_pct:excursionSource?value(excursion?.max_favorable_pct):INCOMPLETE,
      max_adverse_pct:excursionSource?value(excursion?.max_adverse_pct):INCOMPLETE,
      reason:status==='PENDING'?(horizon?.reason||'WAITING_FOR_HORIZON'):
        status==='PARTIAL_CLOSED_OHLC'?(horizon?.reason||'INCOMPLETE_CLOSED_OHLC_WINDOW'):
        status==='COMPLETE'?INCOMPLETE:(horizon?.reason||'NO_CLOSED_OHLC_OUTCOME')
    }];
  }));
}

export function summarizeScanJourneyOutcomes(coins=[]) {
  const rows=Array.isArray(coins)?coins:[];
  const tracked=rows.filter(x=>x&&x.outcome_signal_id&&x.outcome_signal_id!==INCOMPLETE);
  const untracked=Math.max(0,rows.length-tracked.length);
  return {
    tracked_total:tracked.length,
    untracked_total:untracked,
    by_horizon:Object.fromEntries(SCAN_JOURNEY_HORIZONS.map(h=>{
      const values=tracked.map(x=>x.outcomes?.[h]?.status||INCOMPLETE);
      return [h,{
        complete:values.filter(v=>v==='COMPLETE').length,
        pending:values.filter(v=>v==='PENDING').length,
        partial:values.filter(v=>v==='PARTIAL_CLOSED_OHLC').length,
        incomplete:values.filter(v=>v===INCOMPLETE).length
      }];
    }))
  };
}

function epoch(value) {
  if (finite(value)) return Number(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Fail closed when a cycle claims future timestamps or contains an unclosed/future candle. */
export function validateScanJourneyCycle(cycle) {
  const errors = [];
  if (!cycle || typeof cycle !== 'object') return {valid:false,errors:['CYCLE_REQUIRED']};
  if (cycle.schema_version !== SCAN_JOURNEY_SCHEMA) errors.push('SCHEMA_INVALID');
  if (!String(cycle.cycle_id || '').trim()) errors.push('CYCLE_ID_MISSING');
  const completedAt = epoch(cycle.completed_at);
  if (completedAt === null) errors.push('COMPLETED_AT_MISSING');
  const walk = (value,path='cycle') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((child,index)=>walk(child,path+'['+index+']'));
      return;
    }
    for (const [key,child] of Object.entries(value)) {
      const childPath = path+'.'+key;
      if (key === 'closed' && child === false && path.includes('candles_used')) errors.push('UNCLOSED_CANDLE:'+path);
      if (key === 'close_time' || key === 'closeTime') {
        const t = epoch(child);
        if (t !== null && completedAt !== null && t > completedAt) errors.push('FUTURE_CANDLE:'+childPath);
      }
      if (/(^|_)(started_at|completed_at|detected_at|processed_at|eligible_at|eligibility_at|first_eligible_at|fast_scan_at|micro_selected_at|micro_scan_started_at|micro_scan_completed_at|deep_selected_at|deep_scan_started_at|deep_scan_completed_at|notification_gate_evaluated_at|notification_attempted_at|notification_request_resolved_at|notification_sent_at|notification_dispatched_at|observed_at|sent_at|close_time|open_time)$/i.test(key)) {
        const t=epoch(child);
        if (t !== null && completedAt !== null && t > completedAt) errors.push('FUTURE_TIMESTAMP:'+childPath);
      }
      walk(child,childPath);
    }
  };
  walk(cycle);
  return {valid:errors.length===0,errors:[...new Set(errors)]};
}

export function makeScanJourneyCycleId(quote,startedAt) {
  const q=String(quote || 'USDT').trim().toUpperCase();
  const t=Number(startedAt);
  if (!Number.isFinite(t) || t <= 0) throw new Error('SCAN_JOURNEY_STARTED_AT_INVALID');
  return 'RADAR8:'+q+':'+Math.trunc(t);
}

export function scanJourneyFilename(cycleId) {
  return createHash('sha256').update(String(cycleId)).digest('hex')+'.json.gz';
}
