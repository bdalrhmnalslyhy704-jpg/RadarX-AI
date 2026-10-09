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
const HISTORICAL_WINDOW_MS=45*24*60*60*1000;
const HISTORICAL_IMPORT_INTERVAL_MS=60*60*1000;
const HISTORICAL_BACKFILL_INTERVAL_MS=6*60*60*1000;
const HISTORICAL_BACKFILL_MAX_SIGNALS=2;
const EXCLUDED_EVALUATION_SYMBOLS=new Set(['BTCUSDT','USDCUSDT','TUSDUSDT','USDPUSDT','FDUSDUSDT','BUSDUSDT','DAIUSDT','EURUSDT','EURTUSDT','USDEUSDT','PYUSDUSDT','USTCUSDT']);
const PRICE_POLL_MIN_MS=20_000;
const FALSE_BREAKOUT_WINDOW_MS=15*60_000;

const num=(v,d=null)=>v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v))?Number(v):d;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const list=v=>Array.isArray(v)?v:[];
const keyOf=(radar,symbol)=>radar+'|'+symbol;
const pct=(price,entry)=>Number.isFinite(price)&&Number.isFinite(entry)&&entry>0?(price/entry-1)*100:null;

export function emptyPreExpansionOutcomeState(){
  return {version:'PRE_EXPANSION_OUTCOMES_V1',records:[],last_stage_by_key:{},last_price_update_at:0,last_report_log_at:0,last_historical_import_at:0,last_historical_backfill_at:0,updated_at:0};
}
function normalizeRegime(value){
  const label=String(value??'').trim().toUpperCase();
  if(label==='MIXED')return 'RANGING';
  return ['BULLISH','BEARISH','RANGING','UNKNOWN'].includes(label)?label:'UNKNOWN';
}
function normalizeState(raw){
  const state=object(raw);
  const records=list(state.records)
    .filter(row=>!EXCLUDED_EVALUATION_SYMBOLS.has(String(row?.symbol||'').toUpperCase()))
    .map(row=>{
      const current=object(row);
      const schemaCurrent=typeof current.evaluation_eligible==='boolean'&&Array.isArray(current.missing_required_fields);
      return {
        ...current,
        market_regime:normalizeRegime(current.market_regime),
        evaluation_eligible:schemaCurrent?current.evaluation_eligible:false,
        missing_required_fields:schemaCurrent?current.missing_required_fields:['LEGACY_RECORD_NOT_REVALIDATED'],
        evaluation_status:schemaCurrent?(current.evaluation_status||(current.evaluation_eligible?'ELIGIBLE':'EXCLUDED_INCOMPLETE')):'EXCLUDED_LEGACY_UNVALIDATED'
      };
    });
  return {
    ...emptyPreExpansionOutcomeState(),...state,records,
    last_stage_by_key:Object.fromEntries(Object.entries(object(state.last_stage_by_key)).filter(([key])=>!EXCLUDED_EVALUATION_SYMBOLS.has((String(key).split('|')[1]||'').toUpperCase()))),
    last_price_update_at:num(state.last_price_update_at,0),
    last_report_log_at:num(state.last_report_log_at,0),
    last_historical_import_at:num(state.last_historical_import_at,0),
    last_historical_backfill_at:num(state.last_historical_backfill_at,0),
    updated_at:num(state.updated_at,0)
  };
}

function extractMetrics(alert){
  const r9=object(alert.falcon_eye);
  return {
    ...object(alert.metrics),
    ...object(alert.price_change_windows),
    ...object(r9.metrics),
    ...object(object(r9.pre_expansion_fingerprint).metrics),
    ...object(object(alert.pre_expansion_fingerprint).metrics),
    ...object(object(alert.pre_breakout_fingerprint).metrics),
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
    return_5m_pct:num(m.price_change_5m_pct??m.return_5m??m.return_5m_pct??m.price_change_5m),
    return_10m_pct:num(m.return_10m??m.return_10m_pct??m.price_change_10m_pct??m.price_change_10m),
    return_15m_pct:num(m.price_change_15m_pct??m.return_15m_pct??m.return_15m),
    return_20m_pct:num(m.return_20m_pct??m.return_20m),
    return_1h_pct:num(m.price_change_1h_pct??m.return_1h_pct??m.return_1h),
    relative_strength_vs_btc_pct:num(m.relative_strength_vs_btc_pct??m.relative_strength_5m_spread_pct??m.relative_strength_15m_spread_pct??m.spread_5m??m.spread_15m),
    relative_strength_vs_market_pct:num(m.relative_strength_vs_market_pct??m.relative_strength_market_pct),
    resistance_price:num(m.five_min_resistance??m.resistance_price??m.local_high??m.resistance),
    resistance_distance_atr:num(m.resistance_distance_atr),
    volume_ratio:num(m.volume_ratio??m.rvol_5m??m.relative_volume_ratio),
    trade_ratio:num(m.trade_ratio??m.trade_count_ratio??m.trades_ratio),
    atr_ratio:num(m.atr_ratio??m.volatility_ratio),
    bollinger_ratio:num(m.bollinger_ratio??m.bollinger_width_ratio),
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
  const suppliedRegime=String(c.marketRegime||c.market_regime||'').toUpperCase();
  if(suppliedRegime==='MIXED')return 'RANGING';
  if(['BULLISH','BEARISH','RANGING','UNKNOWN'].includes(suppliedRegime))return suppliedRegime;
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
function fieldCoverage({radar,symbol,stage,entry,detectedAt,marketRegime,metrics,reasons,fingerprintReady}){
  const fields={
    radar:Boolean(radar),
    symbol:Boolean(symbol),
    signal_type:WATCHED_STAGES.has(stage)&&stage!=='DATA_INSUFFICIENT',
    entry_price:Number.isFinite(entry)&&entry>0,
    detected_at:Number.isFinite(detectedAt)&&detectedAt>0,
    daily_change_pct:metrics.daily_change_pct!==null,
    return_5m_pct:metrics.return_5m_pct!==null,
    return_10m_pct:metrics.return_10m_pct!==null,
    relative_strength:metrics.relative_strength_vs_btc_pct!==null||metrics.relative_strength_vs_market_pct!==null,
    resistance_context:metrics.resistance_price!==null||metrics.resistance_distance_atr!==null,
    volume_ratio:metrics.volume_ratio!==null,
    trade_ratio:metrics.trade_ratio!==null,
    volatility_context:metrics.atr_ratio!==null||metrics.bollinger_ratio!==null,
    market_regime:['BULLISH','BEARISH','RANGING'].includes(marketRegime),
    reason_codes:reasons.length>0,
    closed_fresh_candles:metrics.closed_candles_only&&!metrics.data_stale,
    fingerprint_ready:radar!=='RADAR_9'||fingerprintReady===true
  };
  const requiredFields=Object.keys(fields);
  const availableFields=requiredFields.filter(key=>fields[key]);
  const missingFields=requiredFields.filter(key=>!fields[key]);
  const blocked=stage==='DATA_INSUFFICIENT'||metrics.data_stale||!metrics.closed_candles_only||metrics.daily_change_pct===null;
  const score=blocked?0:Math.round(availableFields.length/requiredFields.length*100);
  return {score,required_fields:requiredFields,available_fields:availableFields,missing_fields:missingFields};
}

function makeSignal(alert,now,marketContext){
  const radar=normalizedRadar(alert),stage=inferStage(alert);
  const symbol=String(alert?.symbol||'').trim().toUpperCase();
  const entry=num(alert?.price??alert?.last_price??alert?.lastPrice??alert?.falcon_eye?.metrics?.last_price);
  const detectedAt=num(alert?.detected_at??alert?.processed_at??alert?.as_of_ms);
  if(!radar||!symbol||!stage||EXCLUDED_EVALUATION_SYMBOLS.has(symbol)||!(entry>0)||!(detectedAt>0))return null;
  const m=stageMetrics(alert),extended=assessAlreadyExtended(alert,stage,m);
  const context={...object(marketContext),...object(alert?.market_context)};
  const suppliedRegime=alert?.market_regime_label??alert?.market_regime?.label??alert?.market_regime;
  const marketRegime=normalizeRegime(suppliedRegime||classifyEvaluationMarketRegime(context));
  const r9=object(alert?.falcon_eye);
  const fingerprintReady=object(r9.pre_expansion_fingerprint).data_ready===true;
  const reasons=reasonList(alert);
  const coverage=fieldCoverage({radar,symbol,stage,entry,detectedAt,marketRegime,metrics:m,reasons,fingerprintReady});
  const quality=coverage.score;
  const reportedQuality=num(alert?.data_quality??alert?.falcon_eye?.data_quality);
  const evaluationEligible=quality===100&&stage!=='DATA_INSUFFICIENT'&&!m.data_stale&&m.closed_candles_only;
  const evaluationStatus=evaluationEligible?'ELIGIBLE':'EXCLUDED_INCOMPLETE';
  const signalId=String(alert?.id||'').trim()||[radar,symbol,stage,detectedAt].join(':');
  const detectedBeforeMove=assessBeforeMove(alert,stage,m,extended);
  return {
    signal_id:signalId,radar,symbol,entry_price:entry,detected_at:detectedAt,
    detected_at_iso:new Date(detectedAt).toISOString(),signal_type:stage,
    data_quality:quality,data_quality_source:'NORMALIZED_REQUIRED_FIELD_COVERAGE',
    reported_data_quality:reportedQuality,data_quality_status:
      stage==='DATA_INSUFFICIENT'?'INSUFFICIENT':
      m.data_stale?'STALE':
      m.daily_change_pct===null?'DAILY_CHANGE_UNKNOWN':
      quality===100?'COMPLETE':'INCOMPLETE_FIELD_COVERAGE',
    required_fields:coverage.required_fields,
    available_fields:coverage.available_fields,
    missing_required_fields:coverage.missing_fields,
    evaluation_eligible:evaluationEligible,
    evaluation_status:evaluationStatus,
    evaluation_exclusion_reason:evaluationEligible?null:coverage.missing_fields.join(',')||'DATA_QUALITY_GATE',
    reason_codes:reasons,market_regime:marketRegime,
    initial_daily_change_pct:m.daily_change_pct,
    relative_strength_vs_btc_pct:m.relative_strength_vs_btc_pct,
    relative_strength_vs_market_pct:m.relative_strength_vs_market_pct,
    resistance_price:m.resistance_price,resistance_distance_atr:m.resistance_distance_atr,
    already_extended_at_detection:extended,
    detected_before_move:detectedBeforeMove,
    detected_after_move:!detectedBeforeMove,
    initial_metrics:m,
    source:list(alert?.source).length?list(alert.source):[String(alert?.source||'UNKNOWN')],
    false_breakout:null,false_breakout_basis:null,
    marks:{},
    excursions:Object.fromEntries(HORIZONS.map(([h])=>[h,{max_favorable_pct:0,max_adverse_pct:0,complete:false}])),
    first_2pct_at:null,first_3pct_at:null,max_favorable_pct:0,max_adverse_pct:0,
    max_favorable_at:null,max_adverse_at:null,observations:0,last_observed_at:detectedAt,
    observed_price_source:'SAMPLED_SPOT_TICKERS',historical_evaluation:false
  };
}

export async function recordPreExpansionSignals(store,alerts,{now=Date.now(),marketContext={},logger=console}={}){
  const loggedSignals=[];
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
      state.records.push(incoming);loggedSignals.push({signal_id:incoming.signal_id,radar:incoming.radar,symbol:incoming.symbol,signal_type:incoming.signal_type,entry_price:incoming.entry_price,detected_at:incoming.detected_at,data_quality:incoming.data_quality,market_regime:incoming.market_regime,detected_before_move:incoming.detected_before_move,already_extended_at_detection:incoming.already_extended_at_detection,reason_codes:incoming.reason_codes});
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
  for(const signal of loggedSignals)logger?.info?.('[PRE_EXPANSION_SIGNAL_OBSERVED] '+JSON.stringify(signal));
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
    const excursion=record.excursions?.[h]||{max_favorable_pct:0,max_adverse_pct:0,complete:false};
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
  if(HORIZONS.every(([h])=>record.marks?.[h])){
    record.outcome_status=HORIZONS.every(([h])=>record.marks[h]?.sample_quality!=='LATE_SAMPLE')?'COMPLETE':'LATE_SAMPLES';
  }else record.outcome_status='PENDING';
  return changed;
}

export async function updatePreExpansionMarkouts(store,tickerRows,{now=Date.now(),marketContext={},logger=console}={}){
  const loggedMarkouts=[];
  if(typeof store?.updatePreExpansionOutcomes!=='function')return {updated:0,pending:0,reason:'TRACKER_STORE_UNAVAILABLE'};
  let updated=0,pending=0,skippedByThrottle=false;
  const quotes=priceMap(tickerRows);
  await store.updatePreExpansionOutcomes(raw=>{
    const rawState=object(raw);
    const state=normalizeState(raw);
    const cohortCleanup=list(rawState.records).length!==state.records.length||
      Object.keys(object(rawState.last_stage_by_key)).length!==Object.keys(state.last_stage_by_key).length||
      list(rawState.records).some(row=>row?.market_regime!==normalizeRegime(row?.market_regime)||
        typeof row?.evaluation_eligible!=='boolean'||!Array.isArray(row?.missing_required_fields));
    if(now-state.last_price_update_at<PRICE_POLL_MIN_MS){
      skippedByThrottle=true;pending=state.records.filter(x=>x.outcome_status!=='COMPLETE'&&x.entry_price>0).length;
      if(cohortCleanup){state.updated_at=now;return state;}
      return false;
    }
    let changed=cohortCleanup;
    const marketRegime=classifyEvaluationMarketRegime(marketContext);
    for(const record of state.records){
      if(record.evaluation_eligible!==true)continue;
      const quote=quotes.get(record.symbol);
      if(!quote)continue;
      if(record.outcome_status==='COMPLETE')continue;
      if(record.entry_price===null||record.entry_price<=0)continue;
      const previousMarks=record.marks||{};
      const one=updateOneRecord(record,quote.price,now);
      for(const [h] of HORIZONS){
        if(!previousMarks[h]&&record.marks?.[h])loggedMarkouts.push({signal_id:record.signal_id,radar:record.radar,symbol:record.symbol,signal_type:record.signal_type,horizon:h,detected_at:record.detected_at,observed_at:record.marks[h].observed_at,delay_ms:record.marks[h].delay_ms,entry_price:record.entry_price,price:record.marks[h].price,return_pct:record.marks[h].return_pct,outcome:record.marks[h].outcome,sample_quality:record.marks[h].sample_quality,max_favorable_pct:record.excursions?.[h]?.max_favorable_pct,max_adverse_pct:record.excursions?.[h]?.max_adverse_pct});
      }
      if(one){
        record.latest_market_regime=marketRegime;
        record.updated_at=now;updated++;changed=true;
      }
      if(record.outcome_status!=='COMPLETE')pending++;
    }
    if(!changed)return false;
    state.last_price_update_at=now;state.updated_at=now;return state;
  });
  for(const mark of loggedMarkouts)logger?.info?.('[PRE_EXPANSION_MARKOUT] '+JSON.stringify(mark));
  return {updated,pending,throttled:skippedByThrottle};
}

function marketRegimeForSignal(signal){
  const label=String(signal?.market_regime||'UNKNOWN').toUpperCase();
  if(label==='MIXED')return 'RANGING';
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
    max_favorable_pct:0,max_adverse_pct:0,
    false_breakout:null,false_breakout_basis:null
  };
  const sourceFor=h=>h==='4h'||h==='24h'?five:one;
  for(const [h,ms] of HORIZONS){
    const end=detectedAt+ms,source=sourceFor(h);
    const intervalMs=source===five?5*60_000:60_000;
    const windowRows=source.filter(c=>Number(c.openTime)>=detectedAt&&Number(c.closeTime)<=end);
    const mark=source.find(c=>Number(c.closeTime)>=end&&Number(c.closeTime)<=now);
    if(mark&&Number(mark.closeTime)-end<=Math.max(2*intervalMs,90_000)){
      const ret=returnPct(Number(mark.close),entry);
      record.marks[h]={price:Number(mark.close),observed_at:Number(mark.closeTime),delay_ms:Number(mark.closeTime)-end,return_pct:ret,outcome:markOutcome(ret,h),sample_quality:'HISTORICAL_CLOSED_OHLC',tolerance_ms:Math.max(2*intervalMs,90_000)};
    }
    const valid=windowRows.filter(c=>Number(c.high)>0&&Number(c.low)>0);
    if(valid.length){
      const maxHigh=Math.max(...valid.map(c=>Number(c.high))),minLow=Math.min(...valid.map(c=>Number(c.low)));
      record.excursions[h]={max_favorable_pct:Math.max(0,returnPct(maxHigh,entry)),max_adverse_pct:Math.min(0,returnPct(minLow,entry)),max_high:maxHigh,min_low:minLow,complete:Boolean(record.marks[h]),source:'HISTORICAL_CLOSED_OHLC'};
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
    const bars=one.filter(c=>Number(c.openTime)>=detectedAt&&Number(c.closeTime)<=cutoff);
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
  const valid=rows.filter(r=>r.evaluation_eligible===true&&
    ['NEAR_TARGET','HISTORICAL_CLOSED_OHLC'].includes(r.marks?.[h]?.sample_quality)&&
    Number.isFinite(num(r.marks?.[h]?.return_pct)));
  const returns=valid.map(r=>Number(r.marks[h].return_pct));
  const hits=valid.filter(r=>r.marks[h].outcome==='HIT').length;
  const misses=valid.filter(r=>r.marks[h].outcome==='MISS').length;
  const excursions=valid.map(r=>r.excursions?.[h]).filter(Boolean);
  const enough=valid.length>=30;
  const avgReturn=average(returns),avgMfe=average(excursions.map(x=>x.max_favorable_pct)),avgMae=average(excursions.map(x=>x.max_adverse_pct));
  return {
    samples:valid.length,
    avg_return_pct:avgReturn==null?null:Number(avgReturn.toFixed(4)),
    hit_rate_pct:enough?percent(hits,valid.length):null,
    miss_rate_pct:enough?percent(misses,valid.length):null,
    rate_status:enough?'READY_N_GE_30':'INSUFFICIENT_SAMPLE',
    avg_max_favorable_pct:avgMfe==null?null:Number(avgMfe.toFixed(4)),
    avg_max_adverse_pct:avgMae==null?null:Number(avgMae.toFixed(4))
  };
}

function summarizeGroup(rows){
  const measurable=rows.filter(r=>r.evaluation_eligible===true&&PERFORMANCE_STAGES.has(r.signal_type));
  const completed4h=measurable.filter(r=>r.marks?.['4h']&&
    ['NEAR_TARGET','HISTORICAL_CLOSED_OHLC'].includes(r.marks['4h'].sample_quality)&&
    r.excursions?.['4h']?.complete!==false);
  const impacts=completed4h.filter(r=>num(r.excursions?.['4h']?.max_favorable_pct,-Infinity)>=3).length;
  const falseSignals=completed4h.filter(r=>num(r.excursions?.['4h']?.max_favorable_pct,-Infinity)<3).length;
  const timeTo3=completed4h.filter(r=>r.first_3pct_at&&r.first_3pct_at<=r.detected_at+4*60*60_000).map(r=>(r.first_3pct_at-r.detected_at)/60_000);
  const falseKnown=measurable.filter(r=>r.signal_type==='BREAKOUT_DEVELOPING'&&r.false_breakout!==null&&r.false_breakout!==undefined);
  const late=measurable.filter(r=>r.already_extended_at_detection===true).length;
  const drawdowns=rows.filter(r=>r.evaluation_eligible===true).map(r=>num(r.excursions?.['24h']?.max_adverse_pct??r.max_adverse_pct,null)).filter(x=>x!==null);
  const ratesReady=completed4h.length>=30;
  return {
    records:rows.length,
    eligible_records:rows.filter(r=>r.evaluation_eligible===true).length,
    excluded_incomplete_records:rows.filter(r=>r.evaluation_eligible!==true).length,
    measurable_signals:measurable.length,
    detected_before_move_count:measurable.filter(r=>r.detected_before_move===true).length,
    detected_before_move_pct:measurable.length>=30?percent(measurable.filter(r=>r.detected_before_move===true).length,measurable.filter(r=>typeof r.detected_before_move==='boolean').length):null,
    detected_after_move_count:measurable.filter(r=>r.detected_before_move===false).length,
    detected_after_move_pct:measurable.length>=30?percent(measurable.filter(r=>r.detected_before_move===false).length,measurable.filter(r=>typeof r.detected_before_move==='boolean').length):null,
    matured_4h:completed4h.length,
    meaningful_move_4h_pct:ratesReady?percent(impacts,completed4h.length):null,
    false_signal_rate_4h_pct:ratesReady?percent(falseSignals,completed4h.length):null,
    avg_time_to_plus3_pct_within_4h_minutes:timeTo3.length>=30?Number(average(timeTo3).toFixed(2)):null,
    false_breakout_known:falseKnown.length,
    false_breakout_rate_pct:falseKnown.length>=30?percent(falseKnown.filter(r=>r.false_breakout===true).length,falseKnown.length):null,
    already_extended_count:late,
    already_extended_pct:measurable.length>=30?percent(late,measurable.length):null,
    max_adverse_drawdown_pct:drawdowns.length?Number(Math.min(...drawdowns).toFixed(4)):null,
    horizons:Object.fromEntries(HORIZONS.map(([h])=>[h,horizonStats(rows,h)])),
    sample_warning:completed4h.length<30?'SMALL_SAMPLE_LESS_THAN_30_MATURED_4H_SIGNALS':null
  };
}

function buildRangingHistoricalSample(records){
  const candidates=records.filter(r=>r.evaluation_eligible===true&&r.market_regime==='RANGING'&&
    r.historical_evaluation===true&&PERFORMANCE_STAGES.has(r.signal_type)&&
    HORIZONS.every(([h])=>r.marks?.[h]?.sample_quality==='HISTORICAL_CLOSED_OHLC'&&
      r.excursions?.[h]?.source==='HISTORICAL_CLOSED_OHLC'&&r.excursions?.[h]?.complete===true));
  const positive=candidates.filter(r=>num(r.excursions?.['4h']?.max_favorable_pct,-Infinity)>=3);
  const negative=candidates.filter(r=>num(r.excursions?.['4h']?.max_favorable_pct,-Infinity)<3&&
    num(r.excursions?.['4h']?.max_adverse_pct,0)<=-1);
  const neutral=candidates.length-positive.length-negative.length;
  const ready=positive.length>=30&&negative.length>=30;
  return {
    regime:'RANGING',source:'ARCHIVED_SIGNALS_REPLAYED_AGAINST_CLOSED_OHLC',
    label_thresholds:{positive_max_favorable_4h_pct_gte:3,negative_max_favorable_4h_pct_lt:3,negative_max_adverse_4h_pct_lte:-1},
    complete_historical_records:candidates.length,
    positive_cases:positive.length,negative_cases:negative.length,neutral_cases:neutral,
    ready_for_comparison:ready,
    sample_warning:ready?null:'NEED_AT_LEAST_30_POSITIVE_AND_30_NEGATIVE_COMPLETE_RANGING_CASES',
    case_source:'REAL_ARCHIVED_SIGNAL_TIMESTAMPS_AND_CLOSED_OHLC_ONLY'
  };
}


export function buildPreExpansionOutcomeReport(input={}){
  const state=normalizeState(input),records=state.records;
  const groupBy=(rows,keyFn)=>{
    const groups={};for(const row of rows){const key=keyFn(row);(groups[key] ||= []).push(row);}
    return Object.fromEntries(Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,summarizeGroup(v)]));
  };
  const eligible=records.filter(r=>r.evaluation_eligible===true);
  const coverageValues=records.map(r=>num(r.data_quality,null)).filter(x=>x!==null);
  return {
    version:'PRE_EXPANSION_OUTCOME_REPORT_V2',as_of:new Date(num(input.now,Date.now())).toISOString(),
    scope:{radars:['RADAR_8','RADAR_9'],stages:[...WATCHED_STAGES],horizons_ms:Object.fromEntries(HORIZONS.map(([h,ms])=>[h,ms])),impact_thresholds_pct:Object.fromEntries(HORIZONS.map(([h,,threshold])=>[h,threshold])),mfe_mae_source:'Per horizon: SAMPLED_SPOT_TICKERS or HISTORICAL_CLOSED_OHLC, explicitly labelled',minimum_cohort_for_rates:30,no_real_orders:true},
    total_records:records.length,eligible_records:eligible.length,
    excluded_incomplete_records:records.length-eligible.length,
    average_field_coverage_pct:coverageValues.length?Number(average(coverageValues).toFixed(2)):null,
    pending_records:records.filter(r=>r.evaluation_eligible===true&&r.outcome_status==='PENDING').length,
    ranging_historical_sample:buildRangingHistoricalSample(records),
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


/**
 * Writes a compact internal log report at most once per hour. This deliberately
 * uses Railway runtime logs instead of changing any public API response.
 */
export async function maybeLogPreExpansionOutcomeReport(store,{logger=console,now=Date.now(),intervalMs=60*60_000}={}){
  if(typeof store?.updatePreExpansionOutcomes!=='function')return {logged:false,reason:'TRACKER_STORE_UNAVAILABLE'};
  let report=null;
  await store.updatePreExpansionOutcomes(raw=>{
    const state=normalizeState(raw);
    if(!state.records.length||now-state.last_report_log_at<intervalMs)return false;
    state.last_report_log_at=now;state.updated_at=now;
    report=buildPreExpansionOutcomeReport({...state,now});
    return state;
  });
  if(!report)return {logged:false,reason:'THROTTLED_OR_NO_RECORDS'};
  const compact={
    event:'PRE_EXPANSION_OUTCOME_REPORT',
    version:report.version,as_of:report.as_of,total_records:report.total_records,pending_records:report.pending_records,
    thresholds:report.scope.impact_thresholds_pct,
    by_radar:Object.fromEntries(Object.entries(report.groups.by_radar).map(([k,v])=>[k,{
      records:v.records,matured_4h:v.matured_4h,meaningful_move_4h_pct:v.meaningful_move_4h_pct,
      false_signal_rate_4h_pct:v.false_signal_rate_4h_pct,avg_time_to_plus3_pct_within_4h_minutes:v.avg_time_to_plus3_pct_within_4h_minutes,
      false_breakout_rate_pct:v.false_breakout_rate_pct,already_extended_pct:v.already_extended_pct,
      detected_before_move_pct:v.detected_before_move_pct,detected_after_move_pct:v.detected_after_move_pct,
      max_adverse_drawdown_pct:v.max_adverse_drawdown_pct,sample_warning:v.sample_warning,
      horizons:v.horizons
    }])),
    by_stage:report.groups.by_stage,
    by_market_regime:report.groups.by_market_regime,
    comparison:report.comparison,
    notes:['Cohort rates are suppressed until at least 30 eligible observations mature for the relevant denominator.','Incomplete field-coverage rows are retained for audit but excluded from all performance rates and markout updates.','Live excursions are sampled ticker extremes; historical replay results use closed OHLC candles.','Average time is detection-to-first +3% movement, not a guaranteed predictive lead time.','RANGING historical sample uses archived signal timestamps and real closed OHLC only; it is not a full detector-state replay over all historical candles.']
  };
  logger.info?.('[PRE_EXPANSION_OUTCOME_REPORT] '+JSON.stringify(compact));
  return {logged:true,report:compact};
}

export const PRE_EXPANSION_OUTCOME_HORIZONS=HORIZONS.map(([key,ms,impact_threshold_pct])=>({key,ms,impact_threshold_pct}));


/**
 * Imports older saved Radar 8/9 alerts for retrospective OHLC review.
 * Only alerts older than 24h are imported, so no incomplete signal is mistaken
 * for a matured historical result. This does not expose or modify any API.
 */
export async function importHistoricalPreExpansionSignals(store,alerts,{now=Date.now(),logger=console,intervalMs=HISTORICAL_IMPORT_INTERVAL_MS}={}){
  if(typeof store?.updatePreExpansionOutcomes!=='function')return {imported:0,skipped:list(alerts).length,reason:'TRACKER_STORE_UNAVAILABLE'};
  let claimed=false;
  await store.updatePreExpansionOutcomes(raw=>{
    const state=normalizeState(raw);
    if(now-state.last_historical_import_at<intervalMs)return false;
    state.last_historical_import_at=now;state.updated_at=now;claimed=true;return state;
  });
  if(!claimed)return {imported:0,skipped:list(alerts).length,throttled:true};
  const importable=list(alerts).filter(alert=>{
    const at=num(alert?.detected_at??alert?.processed_at??alert?.as_of_ms);
    return at!==null&&now-at>=24*60*60_000&&now-at<=HISTORICAL_WINDOW_MS;
  });
  const importedEvents=[];
  let imported=0,skipped=0;
  await store.updatePreExpansionOutcomes(raw=>{
    const state=normalizeState(raw);let changed=false;
    for(const alert of importable){
      const row=makeSignal(alert,now,alert?.market_context||{});
      if(!row){skipped++;continue;}
      if(state.records.some(x=>x.signal_id===row.signal_id)){skipped++;continue;}
      row.historical_archive_import=true;
      row.outcome_status='PENDING';
      state.records.push(row);
      importedEvents.push({signal_id:row.signal_id,radar:row.radar,symbol:row.symbol,signal_type:row.signal_type,detected_at:row.detected_at,entry_price:row.entry_price});
      imported++;changed=true;
    }
    const cutoff=now-HISTORICAL_WINDOW_MS;
    state.records=state.records.filter(x=>num(x.detected_at,0)>=cutoff||!HORIZONS.every(([h])=>x.marks?.[h]));
    if(state.records.length>MAX_RECORDS)state.records=state.records.slice(-MAX_RECORDS);
    if(changed){state.updated_at=now;return state;}
    return false;
  });
  for(const row of importedEvents)logger?.info?.('[PRE_EXPANSION_HISTORICAL_SIGNAL_IMPORTED] '+JSON.stringify(row));
  return {imported,skipped:skipped+(list(alerts).length-importable.length)};
}

/**
 * Replays mature recorded signals against actual closed public 1m/5m OHLC.
 * A small hourly budget avoids competing with the live radars for the shared
 * Binance public-REST request budget. Historical prices replace sampled prices
 * only horizon-by-horizon when the required closed candle markout exists.
 */
export async function backfillHistoricalPreExpansionOutcomes(store,rest,{now=Date.now(),logger=console,intervalMs=HISTORICAL_BACKFILL_INTERVAL_MS,maxSignals=HISTORICAL_BACKFILL_MAX_SIGNALS}={}){
  if(typeof store?.updatePreExpansionOutcomes!=='function'||typeof rest?.klines!=='function'){
    return {evaluated:0,skipped:0,reason:'HISTORICAL_REST_OR_STORE_UNAVAILABLE'};
  }
  let selected=[];
  await store.updatePreExpansionOutcomes(raw=>{
    const state=normalizeState(raw);
    if(now-state.last_historical_backfill_at<intervalMs)return false;
    selected=state.records.filter(r=>
      r&&r.evaluation_eligible===true&&num(r.detected_at)!==null&&num(r.entry_price)>0&&
      now-Number(r.detected_at)>=24*60*60_000+10*60_000&&
      now-Number(r.detected_at)<=HISTORICAL_WINDOW_MS&&
      r.historical_evaluation!==true
    ).sort((a,b)=>{
      const aRanging=a.market_regime==='RANGING'?0:1,bRanging=b.market_regime==='RANGING'?0:1;
      return aRanging-bRanging||Number(a.detected_at)-Number(b.detected_at);
    }).slice(0,Math.max(1,Math.min(6,Math.trunc(Number(maxSignals)||1))));
    if(!selected.length)return false;
    state.last_historical_backfill_at=now;state.updated_at=now;return state;
  });
  if(!selected.length)return {evaluated:0,skipped:0,throttled:true};
  let evaluated=0,skipped=0;
  for(const signal of selected){
    try{
      const detectedAt=Number(signal.detected_at);
      const [one,five]=await Promise.all([
        rest.klines(signal.symbol,'1m',{limit:100,startTime:detectedAt,endTime:detectedAt+75*60_000}),
        rest.klines(signal.symbol,'5m',{limit:300,startTime:detectedAt,endTime:detectedAt+25*60*60_000})
      ]);
      const closedOne=candleRows(one?.candles,now),closedFive=candleRows(five?.candles,now);
      if(closedOne.length<55||closedFive.length<270){skipped++;logger?.warn?.('[PRE_EXPANSION_HISTORICAL_BACKFILL_INSUFFICIENT] '+JSON.stringify({signal_id:signal.signal_id,symbol:signal.symbol,one_minute_closed:closedOne.length,five_minute_closed:closedFive.length}));continue;}
      const result=evaluateHistoricalPreExpansionSignal(signal,{candles1m:closedOne,candles5m:closedFive,now});
      if(!result.ok){skipped++;continue;}
      let event=null;
      await store.updatePreExpansionOutcomes(raw=>{
        const state=normalizeState(raw),current=state.records.find(x=>x.signal_id===signal.signal_id);
        if(!current||current.historical_evaluation===true)return false;
        current.live_marks=current.live_marks||{...object(current.marks)};
        current.live_excursions=current.live_excursions||{...object(current.excursions)};
        const historical=result.record;
        const covered=[];
        for(const [h] of HORIZONS){
          if(historical.marks?.[h]?.sample_quality==='HISTORICAL_CLOSED_OHLC'){
            current.marks[h]=historical.marks[h];covered.push(h);
          }
          if(historical.excursions?.[h]?.source==='HISTORICAL_CLOSED_OHLC'){
            current.excursions[h]=historical.excursions[h];
          }
        }
        current.first_3pct_at=historical.first_3pct_at??current.first_3pct_at;
        current.first_2pct_at=historical.first_2pct_at??current.first_2pct_at;
        current.max_favorable_pct=Number.isFinite(historical.max_favorable_pct)?historical.max_favorable_pct:current.max_favorable_pct;
        current.max_adverse_pct=Number.isFinite(historical.max_adverse_pct)?historical.max_adverse_pct:current.max_adverse_pct;
        if(historical.false_breakout!==null)current.false_breakout=historical.false_breakout;
        current.false_breakout_detected_at=historical.false_breakout_detected_at??current.false_breakout_detected_at;
        current.false_breakout_basis=historical.false_breakout_basis??current.false_breakout_basis;
        current.historical_evaluation_horizons=covered;
        current.historical_evaluation=HORIZONS.every(([h])=>covered.includes(h));
        current.observed_price_source=current.historical_evaluation?'HISTORICAL_CLOSED_OHLC':'MIXED_LIVE_AND_HISTORICAL';
        current.historical_evaluated_at=now;
        current.outcome_status=HORIZONS.every(([h])=>Boolean(current.marks?.[h]))
          ?(HORIZONS.every(([h])=>current.marks[h]?.sample_quality!=='LATE_SAMPLE')?'COMPLETE':'LATE_SAMPLES')
          :'PARTIAL';
        current.updated_at=now;state.updated_at=now;
        event={signal_id:current.signal_id,radar:current.radar,symbol:current.symbol,signal_type:current.signal_type,historical_horizons:covered,complete:current.historical_evaluation,max_favorable_pct:current.max_favorable_pct,max_adverse_pct:current.max_adverse_pct,false_breakout:current.false_breakout};
        return state;
      });
      if(event){evaluated++;logger?.info?.('[PRE_EXPANSION_HISTORICAL_BACKFILL] '+JSON.stringify(event));}
      else skipped++;
    }catch(error){
      skipped++;
      logger?.warn?.('[PRE_EXPANSION_HISTORICAL_BACKFILL_ERROR] '+JSON.stringify({signal_id:signal.signal_id,symbol:signal.symbol,error:String(error?.message??error)}));
    }
  }
  return {evaluated,skipped};
}
