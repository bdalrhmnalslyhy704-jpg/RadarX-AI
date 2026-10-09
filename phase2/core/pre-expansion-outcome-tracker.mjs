const HORIZONS=Object.freeze([
  ['5m',5*60_000,.8],
  ['15m',15*60_000,1.0],
  ['30m',30*60_000,1.5],
  ['60m',60*60_000,2.0],
  ['4h',4*60*60_000,3.0],
  ['24h',24*60*60_000,5.0]
]);
const WATCHED_STAGES=new Set(['WATCH_EARLY','PRE_EXPANSION','BREAKOUT_DEVELOPING','ALREADY_EXTENDED','DATA_INSUFFICIENT']);
const PERFORMANCE_STAGES=new Set(['WATCH_EARLY','PRE_EXPANSION','BREAKOUT_DEVELOPING']);
const RADAR_ALIASES=new Map([
  ['EARLY_EXPANSION_RADAR','RADAR_8'],
  ['RADAR8','RADAR_8'],
  ['RADAR_8','RADAR_8'],
  ['FALCON_EYE_RADAR','RADAR_9'],
  ['FALCONEYE','RADAR_9'],
  ['RADAR9','RADAR_9'],
  ['RADAR_9','RADAR_9']
]);
const MAX_RECORDS=5000;
const REARM_MS=60*60*1000;
const PRICE_POLL_MIN_MS=20_000;
const FALSE_BREAKOUT_WINDOW_MS=15*60_000;

const num=(v,d=null)=>v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v))?Number(v):d;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const list=v=>Array.isArray(v)?v:[];
const keyOf=(radar,symbol)=>radar+'|'+symbol;
const pct=(price,entry)=>Number.isFinite(price)&&Number.isFinite(entry)&&entry>0?(price/entry-1)*100:null;

export function emptyPreExpansionOutcomeState(){
  return {version:'PRE_EXPANSION_OUTCOMES_V1',records:[],last_stage_by_key:{},last_price_update_at:0,updated_at:0};
}
function normalizeState(raw){
  const state=object(raw);
  return {
    ...emptyPreExpansionOutcomeState(),...state,
    records:list(state.records),
    last_stage_by_key:object(state.last_stage_by_key),
    last_price_update_at:num(state.last_price_update_at,0),
    updated_at:num(state.updated_at,0)
  };
}

function extractMetrics(alert){
  const r9=object(alert.falcon_eye);
  return {
    ...object(alert.metrics),
    ...object(alert.price_change_windows),
    ...object(r9.metrics),
    ...object(object(alert.pre_expansion_fingerprint).metrics),
    ...object(alert.metrics)
  };
}
function normalizedRadar(alert){
  const raw=String(alert?.radar||alert?.event||'').toUpperCase();
  if(RADAR_ALIASES.has(raw))return RADAR_ALIASES.get(raw);
  if(raw.includes('EARLY_EXPANSION'))return 'RADAR_8';
  if(raw.includes('FALCON_EYE')||raw.includes('FALCON-EYE'))return 'RADAR_9';
  return null;
}
function inferStage(alert){
  const raw=String(alert?.pre_expansion_stage??alert?.decision_band??alert?.potential_label??alert?.falcon_eye?.pre_expansion_stage??'').toUpperCase();
  return WATCHED_STAGES.has(raw)?raw:null;
}
function stageMetrics(alert){
  const m=extractMetrics(alert);
  return {
    daily_change_pct:num(alert?.price_change_24h??alert?.price_change_24h_pct??m.daily_change_pct??m.move_24h_pct),
    return_5m_pct:num(m.price_change_5m_pct??m.return_5m??m.return_5m_pct),
    return_10m_pct:num(m.return_10m??m.return_10m_pct),
    return_15m_pct:num(m.price_change_15m_pct??m.return_15m_pct),
    return_20m_pct:num(m.return_20m),
    return_1h_pct:num(m.price_change_1h_pct),
    relative_strength_vs_btc_pct:num(m.relative_strength_vs_btc_pct??m.relative_strength_5m_spread_pct??m.relative_strength_15m_spread_pct),
    relative_strength_vs_market_pct:num(m.relative_strength_vs_market_pct),
    resistance_price:num(m.five_min_resistance??m.local_high??m.resistance),
    resistance_distance_atr:num(m.resistance_distance_atr),
    data_stale:Boolean(alert?.data_stale||object(alert?.gates).data_stale),
    closed_candles_only:alert?.closed_candles_only!==false
  };
}
function assessAlreadyExtended(alert,stage,m){
  const risks=list(alert?.risk_flags).map(x=>String(x).toUpperCase());
  return stage==='ALREADY_EXTENDED'||risks.some(x=>x==='ALREADY_EXTENDED'||x.includes('EXTENDED_CHASE'))||
    (m.daily_change_pct!==null&&Math.abs(m.daily_change_pct)>=8)||
    (m.return_5m_pct!==null&&Math.abs(m.return_5m_pct)>=2.5)||
    (m.return_10m_pct!==null&&Math.abs(m.return_10m_pct)>=3.8)||
    (m.return_15m_pct!==null&&Math.abs(m.return_15m_pct)>=6)||
    object(alert?.falcon_eye).not_chasing===false;
}
function assessBeforeMove(alert,stage,m,extended){
  if(stage==='DATA_INSUFFICIENT'||m.daily_change_pct===null||m.data_stale||!m.closed_candles_only||extended)return false;
  return Math.abs(m.daily_change_pct)<8&&
    (m.return_5m_pct===null||Math.abs(m.return_5m_pct)<1.5)&&
    (m.return_10m_pct===null||Math.abs(m.return_10m_pct)<2.5)&&
    (m.return_15m_pct===null||Math.abs(m.return_15m_pct)<4)&&
    (m.return_1h_pct===null||Math.abs(m.return_1h_pct)<6);
}

function candleRows(rows,now=Infinity){
  return list(rows).filter(c=>c&&num(c.openTime)!==null&&num(c.closeTime)!==null&&
    Number(c.closeTime)<=now&&Number(c.close)>0&&Number(c.high)>=Number(c.low)&&
    Number(c.low)>0&&c.closed!==false).sort((a,b)=>Number(a.closeTime)-Number(b.closeTime));
}
function lastReturn(rows,nBars){
  if(rows.length<=nBars)return null;
  const first=num(rows.at(-(nBars+1))?.close),last=num(rows.at(-1)?.close);
  return first>0&&last>0?(last/first-1)*100:null;
}
export function classifyEvaluationMarketRegime(context={}){
  const c=object(context);
  if(['BULLISH','BEARISH','RANGING','UNKNOWN'].includes(String(c.marketRegime||c.market_regime||'').toUpperCase())){
    return String(c.marketRegime||c.market_regime).toUpperCase();
  }
  const medianChange=num(c.marketMedianChange24hPct??c.market_median_change_24h_pct);
  const breadth=num(c.marketBreadthPct??c.market_breadth_pct);
  const btc5=num(c.btcReturn5mPct??c.btc_return_5m_pct)??lastReturn(c.fiveMinute||[],1);
  const btc1h=num(c.btcReturn1hPct??c.btc_return_1h_pct)??lastReturn(c.oneHour||[],1);
  if(medianChange===null||breadth===null||btc5===null)return 'UNKNOWN';
  if(medianChange>=.5&&breadth>=55&&(btc1h===null||btc1h>=-.2)&&btc5>=-.15)return 'BULLISH';
  if(medianChange<=-.5&&breadth<=45&&(btc1h===null||btc1h<=.2)&&btc5<=.15)return 'BEARISH';
  return 'RANGING';
}
function reasonList(alert){
  const reasons=[...list(alert?.reason_codes),...list(alert?.reasons),...list(alert?.falcon_eye?.reasons)];
  return [...new Set(reasons.map(x=>typeof x==='string'?x:String(x?.code||x?.reason||'')).filter(Boolean))].slice(0,24);
}
function dataQuality(alert,stage,m){
  const reported=num(alert?.data_quality??alert?.falcon_eye?.data_quality);
  if(stage==='DATA_INSUFFICIENT'||m.data_stale||!m.closed_candles_only||m.daily_change_pct===null)return 0;
  if(reported!==null)return Math.max(0,Math.min(100,reported));
  const required=[m.daily_change_pct,m.return_5m_pct,m.relative_strength_vs_btc_pct];
  const available=required.filter(x=>x!==null).length;
  return Math.round(available/required.length*100);
}
function makeSignal(alert,now,marketContext){
  const radar=normalizedRadar(alert),stage=inferStage(alert);
  const symbol=String(alert?.symbol||'').trim().toUpperCase();
  const entry=num(alert?.price??alert?.last_price??alert?.lastPrice??alert?.falcon_eye?.metrics?.last_price);
  if(!radar||!symbol||!stage)return null;
  const detectedAt=num(alert?.detected_at??alert?.processed_at??alert?.as_of_ms,now);
  const m=stageMetrics(alert),extended=assessAlreadyExtended(alert,stage,m);
  const context={...object(marketContext),...object(alert?.market_context)};
  const marketRegime=String(alert?.market_regime_label||alert?.market_regime?.label||'').toUpperCase()||
    classifyEvaluationMarketRegime(context);
  const quality=dataQuality(alert,stage,m);
  const reasons=reasonList(alert);
  const existingId=String(alert?.id||'').trim();
  const signalId=existingId||[radar,symbol,stage,detectedAt].join(':');
  return {
    signal_id:signalId,radar,symbol,entry_price:entry,detected_at:detectedAt,
    detected_at_iso:new Date(detectedAt).toISOString(),signal_type:stage,
    data_quality:quality,reported_data_quality:num(alert?.data_quality??alert?.falcon_eye?.data_quality),
    data_quality_status:stage==='DATA_INSUFFICIENT'?'INSUFFICIENT':m.data_stale?'STALE':m.daily_change_pct===null?'DAILY_CHANGE_UNKNOWN':'AVAILABLE',
    reason_codes:reasons,market_regime:marketRegime,
    initial_daily_change_pct:m.daily_change_pct,
    relative_strength_vs_btc_pct:m.relative_strength_vs_btc_pct,
    relative_strength_vs_market_pct:m.relative_strength_vs_market_pct,
    resistance_price:m.resistance_price,resistance_distance_atr:m.resistance_distance_atr,
    already_extended_at_detection:extended,
    detected_before_move:assessBeforeMove(alert,stage,m,extended),
    initial_metrics:m,source:list(alert?.source).length?list(alert.source):[String(alert?.source||'UNKNOWN')],
    false_breakout:null,false_breakout_basis:null,
    marks:{},excursions:Object.fromEntries(HORIZONS.map(([h])=>[h,{max_favorable_pct:null,max_adverse_pct:null,complete:false}])),
    first_2pct_at:null,first_3pct_at:null,max_favorable_pct:null,max_adverse_pct:null,
    max_favorable_at:null,max_adverse_at:null,observations:0,last_observed_at:detectedAt,
    observed_price_source:'SAMPLED_SPOT_TICKERS',historical_evaluation:false
  };
}

export async function recordPreExpansionSignals(store,alerts,{now=Date.now(),marketContext={}}={}){
  if(typeof store?.updatePreExpansionOutcomes!=='function')return {recorded:0,skipped:list(alerts).length,reason:'TRACKER_STORE_UNAVAILABLE'};
  let recorded=0,skipped=0;
  await store.updatePreExpansionOutcomes(raw=>{
    const state=normalizeState(raw);let changed=false;
    for(const alert of list(alerts)){
      const incoming=makeSignal(alert,now,marketContext);
      if(!incoming){skipped++;continue;}
      const key=keyOf(incoming.radar,incoming.symbol),prior=state.last_stage_by_key[key];
      if(prior&&prior.stage===incoming.signal_type&&now-num(prior.last_recorded_at,0)<REARM_MS){
        skipped++;continue;
      }
      const existing=state.records.find(x=>x.signal_id===incoming.signal_id);
      if(existing){skipped++;continue;}
      state.records.push(incoming);
      state.last_stage_by_key[key]={stage:incoming.signal_type,last_recorded_at:now,signal_id:incoming.signal_id};
      recorded++;changed=true;
    }
    const cutoff=now-45*24*60*60*1000;
    state.records=state.records.filter(x=>num(x.detected_at,0)>=cutoff||!HORIZONS.every(([h])=>x.marks?.[h]));
    if(state.records.length>MAX_RECORDS)state.records=state.records.slice(-MAX_RECORDS);
    const stageKeys=Object.keys(state.last_stage_by_key);
    if(stageKeys.length>6000){
      stageKeys.sort((a,b)=>num(state.last_stage_by_key[a]?.last_recorded_at,0)-num(state.last_stage_by_key[b]?.last_recorded_at,0));
      for(const k of stageKeys.slice(0,stageKeys.length-6000))delete state.last_stage_by_key[k];
    }
    if(changed){state.updated_at=now;return state;}
    return false;
  });
  return {recorded,skipped};
}

function markOutcome(ret,horizon){
  const r=num(ret);
  if(r===null)return null;
  const def=HORIZONS.find(x=>x[0]===horizon);
  const threshold=def?.[2]??1;
  return r>=threshold?'HIT':r<=-threshold*.7?'MISS':'NEUTRAL';
}
function priceMap(rows){
  const map=new Map();
  for(const r of list(rows)){
    const symbol=String(r?.symbol||'').trim().toUpperCase(),price=num(r?.lastPrice??r?.last_price??r?.price);
    if(symbol&&price>0)map.set(symbol,{price,at:num(r?.at,Date.now())});
  }
  return map;
}
function horizonTolerance(ms){return Math.min(5*60_000,Math.max(90_000,ms*.05));}
function updateOneRecord(record,price,now){
  if(!(record.entry_price>0)||!Number.isFinite(price)||price<=0||now<record.detected_at)return false;
  const age=now-record.detected_at,ret=pct(price,record.entry_price);
  if(ret===null)return false;
  let changed=false;
  if(record.last_observed_at!==now){record.observations=(record.observations||0)+1;record.last_observed_at=now;changed=true;}
  record.last_observed_price=price;
  record.last_return_pct=Number(ret.toFixed(4));
  if(record.max_favorable_pct===null||ret>record.max_favorable_pct){
    record.max_favorable_pct=Number(ret.toFixed(4));record.max_favorable_at=now;changed=true;
  }
  if(record.max_adverse_pct===null||ret<record.max_adverse_pct){
    record.max_adverse_pct=Number(ret.toFixed(4));record.max_adverse_at=now;changed=true;
  }
  if(record.first_2pct_at===null&&ret>=2){record.first_2pct_at=now;changed=true;}
  if(record.first_3pct_at===null&&ret>=3){record.first_3pct_at=now;changed=true;}
  for(const [h,ms] of HORIZONS){
    const excursion=record.excursions?.[h]||{max_favorable_pct:null,max_adverse_pct:null,complete:false};
    if(age<=ms&&!excursion.complete){
      if(excursion.max_favorable_pct===null||ret>excursion.max_favorable_pct)excursion.max_favorable_pct=Number(ret.toFixed(4));
      if(excursion.max_adverse_pct===null||ret<excursion.max_adverse_pct)excursion.max_adverse_pct=Number(ret.toFixed(4));
      record.excursions[h]=excursion;changed=true;
    }
    if(!record.marks?.[h]&&age>=ms){
      record.marks=record.marks||{};
      record.marks[h]={
        price,observed_at:now,delay_ms:age-ms,return_pct:Number(ret.toFixed(4)),
        outcome:markOutcome(ret,h),sample_quality:age-ms<=horizonTolerance(ms)?'NEAR_TARGET':'LATE_SAMPLE',
        tolerance_ms:horizonTolerance(ms)
      };
      excursion.complete=true;record.excursions[h]=excursion;changed=true;
    }
  }
  const breakout=record.resistance_price;
  if(record.signal_type==='BREAKOUT_DEVELOPING'&&breakout>0&&record.false_breakout===null){
    if(!record.breakout_crossed_at&&price>=breakout*1.001){
      record.breakout_crossed_at=now;record.breakout_cross_price=price;changed=true;
    }else if(record.breakout_crossed_at){
      if(now-record.breakout_crossed_at<=FALSE_BREAKOUT_WINDOW_MS&&price<breakout*.998){
        record.false_breakout=true;record.false_breakout_detected_at=now;record.false_breakout_basis='SAMPLED_SPOT_PRICE_REJECTION';changed=true;
      }else if(now-record.breakout_crossed_at>FALSE_BREAKOUT_WINDOW_MS){
        record.false_breakout=false;record.false_breakout_basis='SAMPLED_SPOT_PRICES_NO_REJECTION_WITHIN_15M';changed=true;
      }
    }else if(age>=FALSE_BREAKOUT_WINDOW_MS){
      record.false_breakout=false;record.false_breakout_basis='SAMPLED_SPOT_PRICES_NO_BREAKOUT_WITHIN_15M';changed=true;
    }
  }else if(record.false_breakout===null&&age>=FALSE_BREAKOUT_WINDOW_MS){
    record.false_breakout=false;record.false_breakout_basis='NO_BREAKOUT_REJECTION_OBSERVED';changed=true;
  }
  if(HORIZONS.every(([h])=>record.marks?.[h]))record.outcome_status='COMPLETE';
  else record.outcome_status='PENDING';
  return changed;
}

export async function updatePreExpansionMarkouts(store,tickerRows,{now=Date.now(),marketContext={}}={}){
  if(typeof store?.updatePreExpansionOutcomes!=='function')return {updated:0,pending:0,reason:'TRACKER_STORE_UNAVAILABLE'};
  let updated=0,pending=0,skippedByThrottle=false;
  const quotes=priceMap(tickerRows);
  await store.updatePreExpansionOutcomes(raw=>{
    const state=normalizeState(raw);
    if(now-state.last_price_update_at<PRICE_POLL_MIN_MS){skippedByThrottle=true;pending=state.records.filter(x=>x.outcome_status!=='COMPLETE'&&x.entry_price>0).length;return false;}
    let changed=false;
    const marketRegime=classifyEvaluationMarketRegime(marketContext);
    for(const record of state.records){
      const quote=quotes.get(record.symbol);
      if(!quote)continue;
      if(record.outcome_status==='COMPLETE')continue;
      if(record.entry_price===null||record.entry_price<=0)continue;
      const one=updateOneRecord(record,quote.price,now);
      if(one){
        record.latest_market_regime=marketRegime;
        record.updated_at=now;updated++;changed=true;
      }
      if(record.outcome_status!=='COMPLETE')pending++;
    }
    if(!changed)return false;
    state.last_price_update_at=now;state.updated_at=now;return state;
  });
  return {updated,pending,throttled:skippedByThrottle};
}

function marketRegimeForSignal(signal){
  const label=String(signal?.market_regime||'UNKNOWN').toUpperCase();
  return ['BULLISH','BEARISH','RANGING','UNKNOWN'].includes(label)?label:'UNKNOWN';
}
function signalAlreadyExtended(signal){
  if(signal?.already_extended_at_detection===true)return true;
  const m=object(signal?.initial_metrics);
  return Math.abs(num(signal?.initial_daily_change_pct,0))>=8||
    Math.abs(num(m.return_5m_pct,0))>=2.5||
    Math.abs(num(m.return_10m_pct,0))>=3.8||
    Math.abs(num(m.return_15m_pct,0))>=6;
}
function returnPct(price,entry){return entry>0?Number(((price/entry-1)*100).toFixed(4)):null;}

export function evaluateHistoricalPreExpansionSignal(signal,{candles1m=[],candles5m=[],now=Date.now()}={}){
  const entry=num(signal?.entry_price??signal?.price),detectedAt=num(signal?.detected_at??signal?.detectedAt);
  if(!(entry>0)||detectedAt===null)return {ok:false,reason:'INVALID_SIGNAL_ENTRY'};
  const one=candleRows(candles1m,now),five=candleRows(candles5m,now);
  const all=[...one,...five].filter(c=>Number(c.closeTime)>detectedAt&&Number(c.closeTime)<=detectedAt+24*60*60_000)
    .sort((a,b)=>Number(a.closeTime)-Number(b.closeTime));
  const record={
    ...signal,entry_price:entry,detected_at:detectedAt,
    market_regime:marketRegimeForSignal(signal),
    already_extended_at_detection:signalAlreadyExtended(signal),
    detected_before_move:signal?.detected_before_move??!signalAlreadyExtended(signal),
    marks:{},excursions:{},historical_evaluation:true,
    observed_price_source:'HISTORICAL_CLOSED_OHLC',
    max_favorable_pct:null,max_adverse_pct:null,
    false_breakout:null,false_breakout_basis:null
  };
  const sourceFor=h=>h==='4h'||h==='24h'?five:one;
  for(const [h,ms] of HORIZONS){
    const end=detectedAt+ms,source=sourceFor(h);
    const intervalMs=source===five?5*60_000:60_000;
    const windowRows=source.filter(c=>Number(c.closeTime)>detectedAt&&Number(c.closeTime)<=end);
    const mark=source.find(c=>Number(c.closeTime)>=end&&Number(c.closeTime)<=now);
    if(mark&&Number(mark.closeTime)-end<=Math.max(2*intervalMs,90_000)){
      const ret=returnPct(Number(mark.close),entry);
      record.marks[h]={price:Number(mark.close),observed_at:Number(mark.closeTime),delay_ms:Number(mark.closeTime)-end,return_pct:ret,outcome:markOutcome(ret,h),sample_quality:'HISTORICAL_CLOSED_OHLC',tolerance_ms:Math.max(2*intervalMs,90_000)};
    }
    const valid=windowRows.filter(c=>Number(c.high)>0&&Number(c.low)>0);
    if(valid.length){
      const maxHigh=Math.max(...valid.map(c=>Number(c.high))),minLow=Math.min(...valid.map(c=>Number(c.low)));
      record.excursions[h]={max_favorable_pct:returnPct(maxHigh,entry),max_adverse_pct:returnPct(minLow,entry),max_high:maxHigh,min_low:minLow,complete:Boolean(record.marks[h]),source:'HISTORICAL_CLOSED_OHLC'};
      if(record.max_favorable_pct===null||record.excursions[h].max_favorable_pct>record.max_favorable_pct)record.max_favorable_pct=record.excursions[h].max_favorable_pct;
      if(record.max_adverse_pct===null||record.excursions[h].max_adverse_pct<record.max_adverse_pct)record.max_adverse_pct=record.excursions[h].max_adverse_pct;
    }
  }
  if(record.first_3pct_at===undefined||record.first_3pct_at===null){
    const crossed=all.filter(c=>Number(c.high)>=entry*1.03).sort((a,b)=>Number(a.closeTime)-Number(b.closeTime))[0];
    record.first_3pct_at=crossed?Number(crossed.closeTime):null;
  }
  if(record.signal_type==='BREAKOUT_DEVELOPING'&&num(record.resistance_price)>0){
    const cutoff=detectedAt+FALSE_BREAKOUT_WINDOW_MS;
    const bars=one.filter(c=>Number(c.closeTime)>detectedAt&&Number(c.closeTime)<=cutoff);
    const falseBar=bars.find(c=>Number(c.high)>=Number(record.resistance_price)*1.001&&Number(c.close)<Number(record.resistance_price)*.998);
    record.false_breakout=falseBar?true:(bars.length&&bars.at(-1).closeTime>=cutoff?false:null);
    record.false_breakout_detected_at=falseBar?Number(falseBar.closeTime):null;
    record.false_breakout_basis=record.false_breakout===null?'INSUFFICIENT_15M_CLOSED_CANDLES':'HISTORICAL_1M_HIGH_CLOSE';
  }
  record.outcome_status=HORIZONS.every(([h])=>Boolean(record.marks[h]))?'COMPLETE':'PARTIAL';
  return {ok:true,record,source:'HISTORICAL_CLOSED_OHLC'};
}

function average(xs){
  const values=xs.map(Number).filter(Number.isFinite);
  return values.length?values.reduce((sum,x)=>sum+x,0)/values.length:null;
}
function percent(n,d){return d>0?Number((n/d*100).toFixed(2)):null;}
function horizonStats(rows,h){
  const valid=rows.filter(r=>r.marks?.[h]?.sample_quality!=='LATE_SAMPLE'&&Number.isFinite(num(r.marks?.[h]?.return_pct)));
  const returns=valid.map(r=>Number(r.marks[h].return_pct));
  const hits=valid.filter(r=>r.marks[h].outcome==='HIT').length;
  const misses=valid.filter(r=>r.marks[h].outcome==='MISS').length;
  const excursions=valid.map(r=>r.excursions?.[h]).filter(Boolean);
  return {
    samples:valid.length,avg_return_pct:average(returns)==null?null:Number(average(returns).toFixed(4)),
    hit_rate_pct:percent(hits,valid.length),miss_rate_pct:percent(misses,valid.length),
    avg_max_favorable_pct:average(excursions.map(x=>x.max_favorable_pct))==null?null:Number(average(excursions.map(x=>x.max_favorable_pct)).toFixed(4)),
    avg_max_adverse_pct:average(excursions.map(x=>x.max_adverse_pct))==null?null:Number(average(excursions.map(x=>x.max_adverse_pct)).toFixed(4))
  };
}
function summarizeGroup(rows){
  const measurable=rows.filter(r=>PERFORMANCE_STAGES.has(r.signal_type));
  const completed4h=measurable.filter(r=>r.marks?.['4h']&&r.excursions?.['4h']?.complete!==false&&r.marks['4h'].sample_quality!=='LATE_SAMPLE');
  const impacts=completed4h.filter(r=>num(r.excursions?.['4h']?.max_favorable_pct,-Infinity)>=3).length;
  const falseSignals=completed4h.filter(r=>num(r.excursions?.['4h']?.max_favorable_pct,-Infinity)<3).length;
  const timeTo3=completed4h.filter(r=>r.first_3pct_at&&r.first_3pct_at<=r.detected_at+4*60*60_000).map(r=>(r.first_3pct_at-r.detected_at)/60_000);
  const falseKnown=measurable.filter(r=>r.false_breakout!==null&&r.false_breakout!==undefined);
  const late=measurable.filter(r=>r.already_extended_at_detection===true).length;
  const drawdowns=rows.map(r=>r.excursions?.['24h']?.max_adverse_pct??r.max_adverse_pct).map(num).filter(x=>x!==null);
  return {
    records:rows.length,
    measurable_signals:measurable.length,
    matured_4h:completed4h.length,
    meaningful_move_4h_pct:percent(impacts,completed4h.length),
    false_signal_rate_4h_pct:percent(falseSignals,completed4h.length),
    avg_time_to_plus3_pct_within_4h_minutes:average(timeTo3)==null?null:Number(average(timeTo3).toFixed(2)),
    false_breakout_known:falseKnown.length,
    false_breakout_rate_pct:percent(falseKnown.filter(r=>r.false_breakout===true).length,falseKnown.length),
    already_extended_count:late,
    already_extended_pct:percent(late,measurable.length),
    max_adverse_drawdown_pct:drawdowns.length?Number(Math.min(...drawdowns).toFixed(4)):null,
    horizons:Object.fromEntries(HORIZONS.map(([h])=>[h,horizonStats(rows,h)])),
    sample_warning:completed4h.length<30?'SMALL_SAMPLE_LESS_THAN_30_MATURED_4H_SIGNALS':null
  };
}

export function buildPreExpansionOutcomeReport(input={}){
  const state=normalizeState(input),records=state.records;
  const groupBy=(rows,keyFn)=>{
    const groups={};for(const row of rows){const key=keyFn(row);(groups[key] ||= []).push(row);}
    return Object.fromEntries(Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,summarizeGroup(v)]));
  };
  return {
    version:'PRE_EXPANSION_OUTCOME_REPORT_V1',as_of:new Date(num(input.now,Date.now())).toISOString(),
    scope:{radars:['RADAR_8','RADAR_9'],stages:[...WATCHED_STAGES],horizons_ms:Object.fromEntries(HORIZONS.map(([h,ms])=>[h,ms])),impact_thresholds_pct:Object.fromEntries(HORIZONS.map(([h,,threshold])=>[h,threshold])),mfe_mae_source:'SAMPLED_SPOT_TICKERS unless historical_evaluation=true',no_real_orders:true},
    total_records:records.length,pending_records:records.filter(r=>r.outcome_status!=='COMPLETE'&&r.entry_price>0).length,
    groups:{
      by_radar:groupBy(records,r=>r.radar),
      by_stage:groupBy(records,r=>r.signal_type),
      by_market_regime:groupBy(records,r=>r.market_regime||'UNKNOWN'),
      by_radar_stage_regime:groupBy(records,r=>[r.radar,r.signal_type,r.market_regime||'UNKNOWN'].join('|'))
    },
    comparison:{
      radar8:records.filter(r=>r.radar==='RADAR_8').length?summarizeGroup(records.filter(r=>r.radar==='RADAR_8')):null,
      radar9:records.filter(r=>r.radar==='RADAR_9').length?summarizeGroup(records.filter(r=>r.radar==='RADAR_9')):null
    },
    updated_at:state.updated_at||null
  };
}

export const PRE_EXPANSION_OUTCOME_HORIZONS=HORIZONS.map(([key,ms,impact_threshold_pct])=>({key,ms,impact_threshold_pct}));
