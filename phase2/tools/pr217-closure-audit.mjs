import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';

const PROD = 'https://radarx-ai-triple-production.up.railway.app';
const BINANCE = 'https://data-api.binance.vision';
const MIN_QUOTE_VOLUME = 750000;
const CANDLE_MS = 300000;
const BARS_24H = 288;
const LOOKBACK_MS = 72 * 60 * 60 * 1000;
const KLINE_LIMIT = 1000;
const REPORT_JSON = resolve(process.env.RADARX_CLOSURE_REPORT_JSON || 'artifacts/pr217-closure-audit.json');
const REPORT_MD = resolve(process.env.RADARX_CLOSURE_REPORT_MD || 'artifacts/pr217-closure-audit.md');

const MOVERS = ['LUMIAUSDT','STRKUSDT','MBLUSDT','ERAUSDT','TIAUSDT','CHIPUSDT','CFXUSDT','VELODROMEUSDT','AEROUSDT'];
const PRIOR_NOTIFICATIONS = ['LTCUSDT','BTCUSDT','ONTUSDT','ADAUSDT','BLURUSDT','AIUSDT','BIOUSDT','RAREUSDT'];
const TARGETS = [...new Set([...MOVERS,...PRIOR_NOTIFICATIONS])];
const RADARS = [
  'EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR',
  'KAHIR_RADAR','DOOMSDAY_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR',
  'COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','PROFESSOR_RADAR','FALCON_EYE_RADAR'
];
const HORIZONS = [
  {key:'5m',ms:5*60000,bars:1},{key:'15m',ms:15*60000,bars:3},
  {key:'30m',ms:30*60000,bars:6},{key:'60m',ms:60*60000,bars:12},
  {key:'4h',ms:4*60*60000,bars:48},{key:'24h',ms:24*60*60000,bars:288}
];
const now=Date.now(), since=now-LOOKBACK_MS;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))?Number(v):null;
const round=(v,d=3)=>Number.isFinite(v)?Number(v.toFixed(d)):null;
const pct=(v,b)=>Number.isFinite(v)&&Number.isFinite(b)&&b>0?(v/b-1)*100:null;
const iso=v=>Number.isFinite(Number(v))&&Number(v)>0?new Date(Number(v)).toISOString():null;
const makeUrl=(base,path,params={})=>{
  const u=new URL(path,base);
  for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  return u.toString();
};
async function fetchJson(url,{retries=2,timeoutMs=18000}={}) {
  let last;
  for(let attempt=0;attempt<=retries;attempt++) {
    try {
      const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      const text=await response.text();
      let body;
      try { body=JSON.parse(text); } catch { throw new Error('INVALID_JSON_HTTP_'+response.status); }
      if(!response.ok) {
        const error=new Error('HTTP_'+response.status+':'+String(body?.error||body?.message||'request failed').slice(0,120));
        if(response.status<500&&response.status!==429)throw error;
        throw error;
      }
      return body;
    } catch(error) {
      last=error;
      if(attempt<retries)await sleep(350*(attempt+1));
    }
  }
  throw last||new Error('FETCH_FAILED');
}
async function mapLimit(items,limit,fn) {
  const out=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(e){out[i]={error:String(e?.message||e)};}}
  }));
  return out;
}
function statusRows(value) {
  if(Array.isArray(value))return value.map((row,i)=>({id:String(row?.radar||row?.radar_name||i),...(row||{})}));
  if(value&&typeof value==='object')return Object.entries(value).map(([id,row])=>({id,...(row||{})}));
  return [];
}
function stamp(row){return num(row?.detected_at??row?.processed_at??row?.detectedAt??row?.created_at??row?.event_at)||0;}
function typeOf(row){return String(row?.signal_type??row?.potential_label??row?.event??row?.type??row?.stage??'UNKNOWN').toUpperCase();}
function identity(row,fallback='UNKNOWN_RADAR'){return String(row?.replay_cursor_id||row?.signal_id||row?.id||[row?.radar||fallback,row?.symbol||'',typeOf(row),stamp(row)].join('|'));}
function candlesFrom(raw) {
  const byOpenTime=new Map();
  for(const row of (Array.isArray(raw)?raw:[])) {
    if(!Array.isArray(row)||row.length<9)continue;
    const candle={
      openTime:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),
      baseVolume:Number(row[5]),closeTime:Number(row[6]),quoteVolume:Number(row[7]),trades:Number(row[8])
    };
    if(!Number.isFinite(candle.openTime)||candle.openTime%CANDLE_MS!==0||
      candle.closeTime!==candle.openTime+CANDLE_MS-1||candle.closeTime>now||
      ![candle.open,candle.high,candle.low,candle.close,candle.quoteVolume].every(Number.isFinite)||
      candle.open<=0||candle.close<=0||candle.low<=0||candle.high<Math.max(candle.open,candle.close)||
      candle.low>Math.min(candle.open,candle.close)||candle.high<candle.low||candle.quoteVolume<0)continue;
    byOpenTime.set(candle.openTime,candle);
  }
  const sorted=[...byOpenTime.values()].sort((a,b)=>a.openTime-b.openTime);
  // Keep only the latest continuous chain. Never bridge an absent or invalid closed candle.
  let latestChainStart=0;
  for(let i=1;i<sorted.length;i++)
    if(sorted[i].openTime!==sorted[i-1].openTime+CANDLE_MS)latestChainStart=i;
  return sorted.slice(latestChainStart);
}
function quoteVolume24hAt(rows,index) {
  if(index<BARS_24H-1)return {status:'NOT_ENOUGH_24H_CLOSED_CANDLES',quote_volume:null,bars:index+1};
  const selected=rows.slice(index-BARS_24H+1,index+1);
  if(selected.length!==BARS_24H)return {status:'NOT_ENOUGH_24H_CLOSED_CANDLES',quote_volume:null,bars:selected.length};
  return {status:'COMPLETE',quote_volume:selected.reduce((s,r)=>s+r.quoteVolume,0),bars:selected.length};
}
function historicalLiquidityAt(rows,at) {
  let index=-1;
  for(let i=0;i<rows.length;i++){if(rows[i].closeTime<=at)index=i;else break;}
  if(index<0)return {status:'NO_CLOSED_CANDLE_AT_SIGNAL',quote_volume_24h:null,eligible:null};
  const v=quoteVolume24hAt(rows,index);
  return {status:v.status,quote_volume_24h:round(v.quote_volume,2),threshold_usdt:MIN_QUOTE_VOLUME,eligible:v.status==='COMPLETE'?v.quote_volume>=MIN_QUOTE_VOLUME:null};
}
function moveMarker(rows) {
  if(rows.length<BARS_24H+2)return {status:'NOT_ENOUGH_CLOSED_CANDLE_HISTORY',at:null,return_24h_pct:null};
  let previous=null;
  for(let i=BARS_24H;i<rows.length;i++) {
    const current=pct(rows[i].close,rows[i-BARS_24H].close);
    if(previous!==null&&previous<5&&current>=5)return {status:'FOUND_ROLLING_24H_PLUS5_CROSS',at:rows[i].closeTime,return_24h_pct:round(current)};
    previous=current;
  }
  return {status:'NO_PLUS5_CROSS_IN_AVAILABLE_WINDOW',at:null,return_24h_pct:null};
}
function outcomes(signal,rows) {
  const at=stamp(signal);
  if(!at)return {status:'SIGNAL_TIMESTAMP_UNAVAILABLE',detected_at:null,entry_price:null,horizons:{}};
  let index=-1;
  for(let i=0;i<rows.length;i++){if(rows[i].closeTime<=at)index=i;else break;}
  const reportedEntry=num(signal.entry_price??signal.entryPrice??signal.price??signal.last_price);
  const entry=reportedEntry??(index>=0?rows[index].close:null);
  const entryPriceSource=reportedEntry!==null?'SIGNAL_REPORTED_PRICE':entry!==null?'LAST_CLOSED_CANDLE_BEFORE_SIGNAL':'UNAVAILABLE';
  const horizons={};
  for(const h of HORIZONS) {
    const target=at+h.ms;
    // Use only candles that opened at/after the signal timestamp and closed by the horizon.
    // A candle already in progress at the signal time can contain pre-signal highs/lows.
    const firstFullOpen=Math.ceil(at/CANDLE_MS)*CANDLE_MS;
    const expectedFullBars=Math.max(0,Math.floor((target-firstFullOpen)/CANDLE_MS));
    const future=rows.filter(r=>r.openTime>=at&&r.closeTime<=target);
    const matured=now>=target;
    const contiguous=future.every((r,i)=>i===0||r.openTime===future[i-1].openTime+CANDLE_MS);
    const covered=expectedFullBars>0&&future.length===expectedFullBars&&contiguous;
    const status=matured?(covered?'COMPLETE':'INCOMPLETE_CLOSED_CANDLE_COVERAGE'):'PENDING';
    const high=future.length?Math.max(...future.map(r=>r.high)):null;
    const low=future.length?Math.min(...future.map(r=>r.low)):null;
    const last=future.at(-1)||null;
    const closeReturn=entry&&last?round(pct(last.close,entry)):null;
    const mfe=entry&&high!==null?round(pct(high,entry)):null;
    const mae=entry&&low!==null?round(pct(low,entry)):null;
    const final=status==='COMPLETE';
    horizons[h.key]={
      status,source:'BINANCE_SPOT_CLOSED_5M_OHLC',
      nominal_horizon_ms:h.ms,expected_full_closed_bars:expectedFullBars,observed_bars:future.length,
      contiguous,endpoint_close_at:iso(last?.closeTime),
      endpoint_elapsed_ms:last?last.closeTime-at:null,
      endpoint_gap_to_horizon_ms:last?Math.max(0,target-last.closeTime):null,
      close_return_pct:final?closeReturn:null,mfe_pct:final?mfe:null,mae_pct:final?mae:null,
      provisional_close_return_pct:final?null:closeReturn,
      provisional_mfe_pct:final?null:mfe,provisional_mae_pct:final?null:mae,
      evaluation_basis:'LAST_FULLY_CLOSED_5M_CANDLE_AT_OR_BEFORE_HORIZON',
      matures_at:iso(target)
    };
  }
  const liquidity=historicalLiquidityAt(rows,at);
  const rawStage=signal.stage??signal.phase??signal.pipeline_stage??signal.analysis_stage??signal.signal_stage??null;
  return {
    status:'SIGNAL_ROW_FOUND',signal_id:identity(signal),radar:signal.radar||signal._audit_endpoint_radar||null,
    signal_type:typeOf(signal),signal_stage:rawStage,
    signal_stage_status:rawStage===null?'NOT_EXPOSED_BY_PUBLIC_ALERT_ROW':'FIELD_EXPOSED_FULL_PATH_NOT_EXPOSED',
    detected_at:iso(at),entry_price:entry,entry_price_source:entryPriceSource,
    evaluation_eligible:typeof signal.evaluation_eligible==='boolean'?signal.evaluation_eligible:null,
    data_quality_status:signal.data_quality_status||signal.data_status?.status||null,
    source_score_status:signal.source_score_status||null,
    historical_24h_quote_volume:liquidity,
    historical_fast_micro_deep_path:'NOT_EXPOSED_BY_PUBLIC_ALERT_ROW',
    horizons
  };
}

const report={
  schema:'RADARX_PR217_CLOSURE_AUDIT_V1',generated_at:iso(now),
  intended_candidate_sha:process.env.GITHUB_SHA||null,
  production_endpoint:PROD,
  window:{since:iso(since),until:iso(now),candle_interval:'5m',eligibility_floor_usdt:MIN_QUOTE_VOLUME},
  safety:{paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
  verdict:'NOT_PROVEN',production:{status:'NOT_RUN'},radar_runtime:{status:'NOT_RUN',engines:[]},
  analyst_runtime:{status:'NOT_RUN'},symbol_audit:[],endpoint_errors:[],
  limitations:[
    'Read-only audit: no forced scans, no deployment, and no real order execution.',
    'The deployed service commit is the production baseline, not the unmerged PR candidate.',
    'Alert routes return bounded recent pages; a symbol absent from a page is not proof of a missed signal.',
    'Public alert rows do not expose the complete historical Fast/Micro/Deep decision path for every cycle.',
    'The +5% rolling 24h marker is an operational comparison point, not a claim of a unique economic move start.',
    'A single radar-status health snapshot is not a series of periodic cycle records.'
  ]
};

try {
  const basics=await Promise.allSettled([
    fetchJson(makeUrl(PROD,'/api/radar-status')),
    fetchJson(makeUrl(PROD,'/api/multi-analyst',{quote:'USDT',limit:15,scan:0})),
    fetchJson(makeUrl(BINANCE,'/api/v3/exchangeInfo'),{timeoutMs:25000}),
    fetchJson(makeUrl(BINANCE,'/api/v3/ticker/24hr'),{timeoutMs:25000})
  ]);
  const status=basics[0].status==='fulfilled'?basics[0].value:null;
  const analyst=basics[1].status==='fulfilled'?basics[1].value:null;
  const exchange=basics[2].status==='fulfilled'?basics[2].value:null;
  const tickers=basics[3].status==='fulfilled'?basics[3].value:null;
  for(let i=0;i<basics.length;i++)if(basics[i].status!=='fulfilled')report.endpoint_errors.push({source:['radar-status','multi-analyst-cache','exchangeInfo','ticker24hr'][i],error:String(basics[i].reason)});
  if(status) {
    report.production={status:'RESPONDED',meta:status.meta||null};
    report.radar_runtime={status:'SNAPSHOT_AVAILABLE_NOT_CYCLE_PROOF',meta:status.meta||null,engines:statusRows(status.radars).map(row=>({
      id:row.id,name:row.radar_name||row.name||null,running:typeof row.running==='boolean'?row.running:null,
      scans:num(row.scans),alerts:num(row.alerts),last_scan_at:typeof row.last_scan_at==='string'?row.last_scan_at:iso(row.last_scan_at||row.lastScanAt),
      last_error:row.last_error||row.error||null,
      cycle_proof:'SINGLE_HEALTH_SNAPSHOT_IS_NOT_A_PERIODIC_CYCLE_SERIES'
    }))};
  } else report.production={status:'NOT_PROVEN'};
  if(analyst) {
    const candidates=Array.isArray(analyst.candidates)?analyst.candidates:[];
    const roleEvidence=[];
    for(const candidate of candidates)for(const field of ['analysts','opinions','analyst_results','role_outputs','votes','reviews']) {
      const v=candidate?.[field];
      if(Array.isArray(v))roleEvidence.push({symbol:candidate.symbol||null,field,role_count:v.length,roles:v.map(x=>String(x?.analyst_id||x?.role||x?.name||x?.id||'UNKNOWN'))});
      else if(v&&typeof v==='object')roleEvidence.push({symbol:candidate.symbol||null,field,role_count:Object.keys(v).length,roles:Object.keys(v)});
    }
    report.analyst_runtime={
      status:'CACHED_ENDPOINT_OBSERVED',analysis_mode:analyst.meta?.analysis_mode||null,
      candidate_count:candidates.length,candidate_keys:Object.keys(candidates[0]||{}),
      per_candidate_role_evidence:roleEvidence.slice(0,30),
      twenty_roles_proven:roleEvidence.some(row=>row.role_count>=20),
      independent_roles_proven:false,
      verdict:'NOT_PROVEN: cached output or role count alone does not prove 20 independent analyst executions per symbol'
    };
  } else report.analyst_runtime={status:'NOT_PROVEN'};
  const exchangeMap=new Map((Array.isArray(exchange?.symbols)?exchange.symbols:[]).map(row=>[row.symbol,row]));
  const tickerMap=new Map((Array.isArray(tickers)?tickers:[]).map(row=>[row.symbol,row]));

  const alertPages=await mapLimit(RADARS,2,async radar=>{
    const body=await fetchJson(makeUrl(PROD,'/api/radar-alerts',{radar,since,limit:100}),{timeoutMs:25000});
    return {radar,alerts:Array.isArray(body.alerts)?body.alerts:[],meta:body.meta||null};
  });
  const alertsBySymbol=new Map(TARGETS.map(s=>[s,[]]));
  report.radar_runtime.endpoint_audit=[];
  for(let i=0;i<RADARS.length;i++) {
    const result=alertPages[i];
    if(result.error) {
      report.endpoint_errors.push({source:'radar-alerts',radar:RADARS[i],error:result.error});
      report.radar_runtime.endpoint_audit.push({radar:RADARS[i],status:'NOT_PROVEN',error:result.error});
      continue;
    }
    let targetCount=0;
    for(const alert of result.alerts) {
      const symbol=String(alert?.symbol||'').toUpperCase();
      if(!alertsBySymbol.has(symbol)||stamp(alert)<since||stamp(alert)>now)continue;
      const endpointKey=RADARS[i]+'|'+identity(alert,RADARS[i]);
      if(!alertsBySymbol.get(symbol).some(row=>(row._audit_endpoint_radar||row.radar||RADARS[i])+'|'+identity(row,RADARS[i])===endpointKey))
        alertsBySymbol.get(symbol).push({...alert,_audit_endpoint_radar:RADARS[i]});
      targetCount++;
    }
    report.radar_runtime.endpoint_audit.push({
      radar:RADARS[i],status:'RESPONDED',returned_alerts:result.alerts.length,
      target_symbol_rows:targetCount,endpoint_meta:result.meta
    });
  }

  const candleResults=await mapLimit(TARGETS,3,async symbol=>{
    const recentUrl=new URL('/api/v3/klines',BINANCE);
    recentUrl.searchParams.set('symbol',symbol);recentUrl.searchParams.set('interval','5m');
    // With no startTime Binance returns the newest 1,000 closed/open candles.
    recentUrl.searchParams.set('limit',String(KLINE_LIMIT));
    const recent=await fetchJson(recentUrl.toString(),{timeoutMs:25000});
    const firstRecentOpen=(Array.isArray(recent)?recent:[]).map(row=>num(row?.[0])).filter(Number.isFinite).sort((a,b)=>a-b)[0];
    let older=[];
    if(firstRecentOpen!==undefined) {
      const olderUrl=new URL('/api/v3/klines',BINANCE);
      olderUrl.searchParams.set('symbol',symbol);olderUrl.searchParams.set('interval','5m');
      olderUrl.searchParams.set('startTime',String(firstRecentOpen-(BARS_24H+4)*CANDLE_MS));
      olderUrl.searchParams.set('endTime',String(firstRecentOpen-1));
      olderUrl.searchParams.set('limit',String(BARS_24H+4));
      older=await fetchJson(olderUrl.toString(),{timeoutMs:25000});
    }
    return {symbol,candles:candlesFrom([...(Array.isArray(older)?older:[]),...(Array.isArray(recent)?recent:[])])};
  });
  const candleMap=new Map();
  for(let i=0;i<candleResults.length;i++) {
    const row=candleResults[i];
    if(row.error)report.endpoint_errors.push({source:'binance-klines',symbol:TARGETS[i],error:row.error});
    else candleMap.set(row.symbol,row.candles);
  }

  for(const symbol of TARGETS) {
    const pair=exchangeMap.get(symbol),ticker=tickerMap.get(symbol),candles=candleMap.get(symbol)||[];
    const rawAlerts=(alertsBySymbol.get(symbol)||[]).filter(row=>stamp(row)>=since&&stamp(row)<=now).sort((a,b)=>stamp(a)-stamp(b));
    // Keep only the first chronological signal per radar+symbol for outcome scoring.
    // Later rows remain explicitly counted as observations, not independent signals.
    const firstByRadar=new Map();
    for(const row of rawAlerts) {
      const radar=String(row.radar||row.radar_name||row._audit_endpoint_radar||'UNKNOWN_RADAR');
      if(!firstByRadar.has(radar))firstByRadar.set(radar,row);
    }
    const firstUniqueRows=[...firstByRadar.values()].sort((a,b)=>stamp(a)-stamp(b));
    const signals=firstUniqueRows.map(row=>outcomes(row,candles));
    const marker=moveMarker(candles);
    const quoteVolume=num(ticker?.quoteVolume);
    const preMarkerEligible=signals.filter(row=>row.detected_at&&marker.at!==null&&
      Date.parse(row.detected_at)<=marker.at&&row.evaluation_eligible!==false&&row.historical_24h_quote_volume?.eligible===true);
    let relation='NOT_PROVEN';
    if(marker.at!==null) {
      if(preMarkerEligible.length)relation='ELIGIBLE_FIRST_RADAR_SIGNAL_BEFORE_ROLLING_24H_PLUS5_MARKER_NOT_PROOF_OF_MOVE_START';
      else if(signals.some(row=>row.detected_at&&Date.parse(row.detected_at)>marker.at))
        relation='AVAILABLE_FIRST_SIGNALS_AFTER_MARKER_OR_HISTORICAL_ELIGIBILITY_NOT_MET';
      else relation='NO_ELIGIBLE_FIRST_RADAR_SIGNAL_BEFORE_MARKER_IN_BOUNDED_ALERT_WINDOW';
    } else relation='NO_PLUS5_MARKER_IN_AVAILABLE_CONTINUOUS_CLOSED_CANDLE_WINDOW';
    report.symbol_audit.push({
      symbol,
      source_groups:[...(MOVERS.includes(symbol)?['USER_MOVER_LIST']:[]),...(PRIOR_NOTIFICATIONS.includes(symbol)?['LEGACY_NOTIFICATION_LIST']:[])],
      current_eligibility:{
        in_current_exchange_info:Boolean(pair),current_status:pair?.status||null,
        spot_trading_allowed:pair?pair.isSpotTradingAllowed!==false:null,
        current_quote_volume_24h:quoteVolume,threshold_usdt:MIN_QUOTE_VOLUME,
        eligible_now:pair&&quoteVolume!==null?pair.status==='TRADING'&&pair.quoteAsset==='USDT'&&pair.isSpotTradingAllowed!==false&&quoteVolume>=MIN_QUOTE_VOLUME:null
      },
      candle_history:{
        status:candles.length>=BARS_24H?'CLOSED_5M_HISTORY_AVAILABLE':'LIMITED_OR_UNAVAILABLE',
        closed_candles:candles.length,first_closed_candle:iso(candles[0]?.closeTime),
        last_closed_candle:iso(candles.at(-1)?.closeTime),continuous_latest_chain:true
      },
      movement_start_marker_24h_plus5:{...marker,at:iso(marker.at),interpretation:'OPERATIONAL_ROLLING_24H_THRESHOLD_CROSS_NOT_ECONOMIC_MOVE_START'},
      signal_evidence:{
        window_since:iso(since),per_radar_endpoint_cap:100,
        matching_alert_rows_in_bounded_pages:rawAlerts.length,
        first_unique_signals_one_per_radar_symbol:signals.length,
        later_alert_rows_not_counted_as_independent:Math.max(0,rawAlerts.length-signals.length),
        matching_alerts:signals.length,
        signal_types:signals.reduce((acc,row)=>(acc[row.signal_type]=(acc[row.signal_type]||0)+1,acc),{}),
        earliest_signal:signals[0]?{radar:signals[0].radar,signal_type:signals[0].signal_type,at:signals[0].detected_at,entry_price:signals[0].entry_price}:null,
        first_pre_marker_eligible_alert:preMarkerEligible[0]?{radar:preMarkerEligible[0].radar,signal_type:preMarkerEligible[0].signal_type,at:preMarkerEligible[0].detected_at,entry_price:preMarkerEligible[0].entry_price,source_score_status:preMarkerEligible[0].source_score_status}:null,
        relationship_to_marker:relation,full_fast_micro_deep_trace:'NOT_EXPOSED_BY_PUBLIC_ALERT_ROW'
      },
      signals,
      mature_outcome_counts:Object.fromEntries(HORIZONS.map(h=>[h.key,signals.filter(row=>row.horizons?.[h.key]?.status==='COMPLETE').length]))
    });
  }
} catch(error) {
  report.endpoint_errors.push({source:'closure-audit-main',error:String(error?.stack||error)});
}

const historyReady=report.symbol_audit.filter(row=>row.candle_history?.closed_candles>=BARS_24H).length;
const symbolsWithAlerts=report.symbol_audit.filter(row=>row.signal_evidence?.matching_alerts>0).length;
report.summary={
  target_symbols:TARGETS.length,symbols_with_24h_closed_candle_history:historyReady,
  symbols_with_alert_rows_in_bounded_window:symbolsWithAlerts,
  requested_radar_engines:RADARS.length,radar_health_rows:report.radar_runtime.engines.length,
  endpoint_errors:report.endpoint_errors.length,
  twenty_independent_analyst_roles_proven:report.analyst_runtime?.twenty_roles_proven===true&&report.analyst_runtime?.independent_roles_proven===true,
  complete_independent_historical_replay:false,overall:'NOT_PROVEN'
};
await mkdir(dirname(REPORT_JSON),{recursive:true});
await mkdir(dirname(REPORT_MD),{recursive:true});
await writeFile(REPORT_JSON,JSON.stringify(report,null,2)+'\n','utf8');
const markdown=[
  '# PR #217 — read-only live endpoint and closed-candle audit',
  '',
  'Generated: '+report.generated_at,
  'Candidate SHA: '+(report.intended_candidate_sha||'UNKNOWN'),
  'Production endpoint: '+PROD,
  '',
  '## Summary',
  '',
  '- Target symbols: '+report.summary.target_symbols,
  '- Symbols with at least 24h of closed 5m candles: '+report.summary.symbols_with_24h_closed_candle_history,
  '- Symbols with alert rows in bounded API windows: '+report.summary.symbols_with_alert_rows_in_bounded_window,
  '- Requested radar engines: '+report.summary.requested_radar_engines,
  '- Endpoint errors: '+report.summary.endpoint_errors,
  '- Twenty independently executed analyst roles proven: '+report.summary.twenty_independent_analyst_roles_proven,
  '',
  '## Symbol evidence',
  '',
  '| Symbol | Eligible now | Continuous closed 5m candles | Raw alert rows | First unique signals (per radar) | Earliest first signal | +5% marker | Relationship |',
  '|---|---:|---:|---:|---:|---|---|---|',
  ...report.symbol_audit.map(row=>'| '+row.symbol+' | '+(row.current_eligibility.eligible_now===true?'YES':row.current_eligibility.eligible_now===false?'NO':'UNKNOWN')+' | '+row.candle_history.closed_candles+' | '+row.signal_evidence.matching_alert_rows_in_bounded_pages+' | '+row.signal_evidence.first_unique_signals_one_per_radar_symbol+' | '+(row.signal_evidence.earliest_signal?row.signal_evidence.earliest_signal.signal_type+' @ '+row.signal_evidence.earliest_signal.at:'NONE IN BOUNDED PAGE')+' | '+row.movement_start_marker_24h_plus5.status+' | '+row.signal_evidence.relationship_to_marker+' |'),
  '',
  '## Radar health snapshot',
  '',
  '| Engine | Running | Scans | Alerts | Last scan |',
  '|---|---:|---:|---:|---|',
  ...report.radar_runtime.engines.map(row=>'| '+(row.name||row.id)+' | '+(row.running===true?'YES':row.running===false?'NO':'UNKNOWN')+' | '+(row.scans??'UNKNOWN')+' | '+(row.alerts??'UNKNOWN')+' | '+(row.last_scan_at||'UNKNOWN')+' |'),
  '',
  '## Analyst engine',
  '',
  '- Status: '+(report.analyst_runtime.status||'NOT PROVEN'),
  '- Analysis mode: '+(report.analyst_runtime.analysis_mode||'UNKNOWN'),
  '- Candidate count: '+(report.analyst_runtime.candidate_count??'UNKNOWN'),
  '- Twenty roles independently executed per symbol: '+(report.summary.twenty_independent_analyst_roles_proven?'PROVEN':'NOT PROVEN'),
  '',
  '## Limitations',
  '',
  ...report.limitations.map(item=>'- '+item),
  '',
  '## Verdict',
  '',
  '**NOT_PROVEN** — this is read-only evidence, not a release pass and not proof that the PR candidate is deployed.'
].join('\n');
await writeFile(REPORT_MD,markdown+'\n','utf8');
console.log(JSON.stringify({
  event:'PR217_CLOSURE_AUDIT_WRITTEN',candidate_sha:report.intended_candidate_sha,
  target_symbols:TARGETS.length,symbols_with_candles:historyReady,symbols_with_alerts:symbolsWithAlerts,
  radar_rows:report.radar_runtime.engines.length,endpoint_errors:report.endpoint_errors.length,
  verdict:report.verdict,report_json:REPORT_JSON,report_markdown:REPORT_MD
}));
