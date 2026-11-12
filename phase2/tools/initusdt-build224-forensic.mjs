import {mkdir,writeFile} from 'node:fs/promises';
import {RestClient} from '../market/binance-rest.mjs';
import {buildSpotUniverse,normalizeTickerRow} from '../market/universe-scanner.mjs';
import {buildEarlyExpansionEvidence,EARLY_EXPANSION_RADAR_DEFAULTS,buildMicroFingerprint,buildMicroEarlyFlowWatchCandidate} from '../core/early-expansion-radar.mjs';

const SYMBOLS=[['INITUSDT',107.41]];
const EVENT_START=Date.parse(process.env.INITUSDT_EVENT_START||'2026-11-08T00:00:00Z');
const THROUGH=process.env.INITUSDT_THROUGH||'2026-11-11T00:00:00Z';
const CHECKPOINTS=[24,12,6,3,1,.25,(5/60)];
const throughMs=Date.parse(THROUGH);
if(!Number.isFinite(throughMs))throw new Error('INVALID_FORENSIC_THROUGH');
const targetStart=EVENT_START;
const fetchStart=targetStart-15*24*60*60*1000;

const rest=new RestClient({
  baseUrls:[
    'https://data-api.binance.vision','https://api.binance.com','https://api-gcp.binance.com',
    'https://api1.binance.com','https://api2.binance.com','https://api3.binance.com','https://api4.binance.com'
  ],
  timeoutMs:12000,minIntervalMs:120,maxRequestsPerMinute:100
});

async function fetchRange(symbol,interval,start,end){
  const out=[];let cursor=start;
  for(let page=0;page<40&&cursor<end;page++){
    const r=await rest.klines(symbol,interval,{limit:1000,startTime:cursor,endTime:end});
    const rows=r.candles||[];if(!rows.length)break;
    for(const c of rows)if(Number(c.closeTime)<=end)out.push(c);
    const last=rows.at(-1);if(!last||Number(last.openTime)<cursor)break;
    const next=Number(last.openTime)+(interval==='1m'?60000:interval==='5m'?300000:interval==='15m'?900000:interval==='1h'?3600000:14400000);
    if(next<=cursor)break;cursor=next;
    if(rows.length<1000)break;
  }
  const seen=new Map();for(const c of out){if(c.closed!==false&&Number(c.closeTime)<=end)seen.set(Number(c.openTime),c);}
  return {candles:[...seen.values()].sort((a,b)=>Number(a.openTime)-Number(b.openTime)),source:rSource(out)};
}
function rSource(rows){return rows.length?[...new Set(rows.map(x=>x.sourceUrl||x.source).filter(Boolean))].join(' | '):'Binance Public REST';}
function at(rows,ts){return rows.filter(c=>Number(c.closeTime)<=ts&&c.closed!==false);}
function resampleReturn(rows,agoMs){
  const a=rows.filter(c=>Number(c.closeTime)<=throughMs).at(-1);
  const b=rows.filter(c=>Number(c.closeTime)<=throughMs-agoMs).at(-1);
  return a&&b&&Number(b.close)>0?(Number(a.close)/Number(b.close)-1)*100:null;
}
function sumField(rows,field,n){
  return rows.slice(-n).reduce((s,c)=>s+Math.max(0,Number(c[field])||0),0);
}
function historicalTicker(one,ts){
  const past=one.filter(c=>Number(c.closeTime)<=ts);
  const last=past.at(-1);
  if(!last)return null;
  const target=Number(ts)-24*60*60*1000;
  const prior=[...past].reverse().find(c=>Number(c.closeTime)<=target)||null;
  const move=prior&&Number(prior.close)>0?(Number(last.close)/Number(prior.close)-1)*100:null;
  return {
    symbol:null,lastPrice:Number(last.close),priceChange24h:move??0,
    quoteVolume24h:sumField(past,'quoteVolume',1440),
    tradeCount24h:sumField(past,'tradeCount',1440)
  };
}
function fastContext(one,ts){
  const p=at(one,ts);if(p.length<20)return {};
  const cur=p.at(-1),p5=p.length>5?p.at(-6):null,p10=p.length>10?p.at(-11):null;
  const r5=p5&&Number(p5.close)>0?(Number(cur.close)/Number(p5.close)-1)*100:0;
  const rPrev=p10&&p5&&Number(p10.close)>0?(Number(p5.close)/Number(p10.close)-1)*100:0;
  const vols=[];for(let i=Math.max(1,p.length-16);i<p.length-1;i++){const a=sumField(p.slice(Math.max(0,i-4),i+1),'quoteVolume',5);if(a>0)vols.push(a);}
  const curVol=sumField(p.slice(-5),'quoteVolume',5);const base=median(vols);
  const trades=[];for(let i=Math.max(1,p.length-16);i<p.length-1;i++){const a=sumField(p.slice(Math.max(0,i-4),i+1),'tradeCount',5);if(a>0)trades.push(a);}
  const curTrades=sumField(p.slice(-5),'tradeCount',5);const tbase=median(trades);
  return {
    price_change_pct:r5,price_acceleration_pct:r5-rPrev,
    volume_accel_ratio:base>0?curVol/base:null,trade_accel_ratio:tbase>0?curTrades/tbase:null,warmed_up:true
  };
}
function median(a){const x=a.filter(Number.isFinite).sort((m,n)=>m-n);if(!x.length)return null;const i=Math.floor(x.length/2);return x.length%2?x[i]:(x[i-1]+x[i])/2;}
function maxForwardReturn(one,index,hours){
  const from=Number(one[index].close);if(!(from>0))return null;
  const end=Number(one[index].closeTime)+hours*3600000;
  const f=one.slice(index+1).filter(c=>Number(c.closeTime)<=end);
  if(!f.length)return null;
  const hi=Math.max(...f.map(c=>Number(c.high)).filter(Number.isFinite));
  return hi>0?(hi/from-1)*100:null;
}
function deriveAnchor(one,expected){
  const w=one.map((c,i)=>({c,i})).filter(x=>Number(x.c.closeTime)>=targetStart&&Number(x.c.closeTime)<=throughMs);
  if(w.length<120)return {status:'NOT_VERIFIED',reason:'INSUFFICIENT_HISTORICAL_EVIDENCE'};
  const peak=w.reduce((best,x)=>Number(x.c.high)>Number(best.c.high)?x:best,w[0]);
  const total=(Number(peak.c.high)/Number(w[0].c.close)-1)*100;
  const referenceMove=Number.isFinite(Number(expected))?Math.abs(Number(expected)):Math.abs(total);
  const trigger=Math.max(3,Math.min(12,referenceMove*.18));
  const sustain=Math.max(trigger,Math.min(18,referenceMove*.12));
  for(const x of w){
    if(x.i>=peak.i)break;
    const f60=maxForwardReturn(one,x.i,1),f240=maxForwardReturn(one,x.i,4);
    const prior=one.slice(Math.max(0,x.i-60),x.i);
    const priorReturn=prior.length&&Number(prior[0].close)>0?(Number(prior.at(-1).close)/Number(prior[0].close)-1)*100:0;
    if(Number(f60)>=trigger&&Number(f240)>=sustain&&priorReturn<trigger){
      return {
        status:'OK',anchor_time:Number(x.c.closeTime),anchor_iso:new Date(Number(x.c.closeTime)).toISOString(),
        peak_time:Number(peak.c.closeTime),peak_iso:new Date(Number(peak.c.closeTime)).toISOString(),
        peak_high:Number(peak.c.high),window_open:Number(w[0].c.close),observed_run_pct:total,
        anchor_definition:{forward_1h_min_pct:trigger,forward_4h_min_pct:sustain,prior_1h_return_lt_pct:trigger}
      };
    }
  }
  return {status:'NOT_VERIFIED',reason:'NO_DERIVED_ANCHOR',observed_run_pct:total,peak_iso:new Date(Number(peak.c.closeTime)).toISOString()};
}
function snapshotSeries(all,ts){
  return Object.fromEntries(Object.entries(all).map(([tf,rows])=>[tf,at(rows,ts)]));
}
function checkpointRows(all,anchorMs,expected,market){
  const out=[];
  for(const h of CHECKPOINTS){
    const ts=anchorMs-Math.round(h*60*60*1000);
    const s=snapshotSeries(all,ts),ticker=historicalTicker(all['1m'],ts);
    if(!ticker){out.push({hours_before:h,status:'NOT_VERIFIED',reason:'INSUFFICIENT_HISTORICAL_EVIDENCE'});continue;}
    ticker.symbol='INITUSDT';
    const evidence=buildEarlyExpansionEvidence({
      series:s,ticker,depth:null,marketContext:market,fastContext:fastContext(all['1m'],ts),now:ts,
      config:EARLY_EXPANSION_RADAR_DEFAULTS,historicalReplay:true
    });
    out.push({
      hours_before:h,timestamp:new Date(ts).toISOString(),status:'OK',
      price:Number(ticker.lastPrice),price_change_24h_pct:ticker.priceChange24h,
      metrics:evidence.metrics,
      score_forensic_only:evidence.forensic_evidence_score,
      live_early_expansion_score:null,
      decision_band:evidence.decision_band,
      reason_codes:evidence.reason_codes,
      risk_flags:evidence.risk_flags,
      historical_orderbook:'UNAVAILABLE',
      historical_spread:'UNAVAILABLE',
      historical_news_event:'NOT_EVALUATED'
    });
  }
  return out;
}
function firstPartialEvidence(all,anchorMs,market){
  const start=anchorMs-24*3600000;let first=null,best=null;
  for(let ts=start;ts<anchorMs;ts+=5*60000){
    const s=snapshotSeries(all,ts),ticker=historicalTicker(all['1m'],ts);if(!ticker)continue;ticker.symbol='INITUSDT';
    const e=buildEarlyExpansionEvidence({series:s,ticker,depth:null,marketContext:market,fastContext:fastContext(all['1m'],ts),now:ts,historicalReplay:true});
    if(e.decision_band==='DATA_INSUFFICIENT')continue;
    if(!best||e.forensic_evidence_score>best.forensic_evidence_score)best={ts,e};
    if(!first&&e.forensic_evidence_score>=58&&Number(ticker.priceChange24h)<=12&&Number(ticker.quoteVolume24h)>=750000){first={ts,e,ticker};break;}
  }
  const brief=x=>x?{time:new Date(x.ts).toISOString(),price:Number(x.ticker.lastPrice),price_change_24h_pct:Number(x.ticker.priceChange24h),quote_volume_24h_usdt:Number(x.ticker.quoteVolume24h),trade_count_24h:Number(x.ticker.tradeCount24h),score:x.e.forensic_evidence_score,decision_band:x.e.decision_band,score_allowed:x.e.gates?.score_allowed??null,liquidity_gate:x.e.gates?.liquidity_gate??null,anti_chase:x.e.gates?.anti_chase??null,reason_codes:x.e.reason_codes,risk_flags:x.e.risk_flags,metrics:x.e.metrics}:null;
  if(!first)return {status:'UNKNOWN',estimated_lead_time:'UNKNOWN',best_partial_evidence:brief(best)};
  return {status:'PARTIAL_EVIDENCE_ONLY',first_time:new Date(first.ts).toISOString(),estimated_lead_time_minutes:Math.round((anchorMs-first.ts)/60000),...brief(first)};
}
function fullTimeline(all,startMs,endMs,market){
  const out=[];
  for(const candle of all['15m'].filter(c=>Number(c.closeTime)>=startMs&&Number(c.closeTime)<=endMs)){
    const ts=Number(candle.closeTime);
    const series=snapshotSeries(all,ts);
    const ticker=historicalTicker(all['1m'],ts);
    if(!ticker)continue;
    ticker.symbol='INITUSDT';
    const evidence=buildEarlyExpansionEvidence({
      series,ticker,depth:null,marketContext:market,fastContext:fastContext(all['1m'],ts),
      now:ts,config:EARLY_EXPANSION_RADAR_DEFAULTS,historicalReplay:true
    });
    out.push({
      open_time:new Date(Number(candle.openTime)).toISOString(),
      close_time:new Date(ts).toISOString(),
      open:Number(candle.open),high:Number(candle.high),low:Number(candle.low),close:Number(candle.close),
      return_15m_pct:Number(((Number(candle.close)/Number(candle.open)-1)*100).toFixed(4)),
      volume_init:Number(candle.volume),
      quote_volume_usdt:Number(candle.quoteVolume),
      trade_count:Number(candle.tradeCount),
      taker_buy_quote_volume_usdt:Number(candle.takerBuyQuoteVolume),
      price_change_24h_pct:Number(ticker.priceChange24h.toFixed(4)),
      quote_volume_24h_usdt:Number(ticker.quoteVolume24h.toFixed(2)),
      trade_count_24h:Number(ticker.tradeCount24h),
      forensic_evidence_score:evidence.forensic_evidence_score,
      decision_band:evidence.decision_band,
      early_expansion_score:evidence.early_expansion_score,
      score_allowed:evidence.gates?.score_allowed??null,
      liquidity_gate:evidence.gates?.liquidity_gate??null,
      score_components:evidence.score_components,
      risk_flags:evidence.risk_flags,
      reason_codes:evidence.reason_codes,
      gates:evidence.gates,
      metrics:evidence.metrics
    });
  }
  return out;
}
function fastDeltaProxy(oneRows,ts){
  const p=at(oneRows,ts);
  if(p.length<21)return {warmed_up:false};
  const cur=p.at(-1),prev=p.at(-2),prev2=p.at(-3);
  const pct=(a,b)=>Number(b?.close)>0?(Number(a?.close)/Number(b.close)-1)*100:null;
  const change=pct(cur,prev),previous=pct(prev,prev2);
  const qDelta=Math.max(0,Number(cur?.quoteVolume)||0),tradeDelta=Math.max(0,Number(cur?.tradeCount)||0);
  const qBase=median(p.slice(-16,-1).map(x=>Number(x.quoteVolume)||0).filter(x=>x>0));
  const tBase=median(p.slice(-16,-1).map(x=>Number(x.tradeCount)||0).filter(x=>x>0));
  return {
    price_change_pct:Number.isFinite(change)?change:0,
    price_acceleration_pct:Number.isFinite(change)&&Number.isFinite(previous)?change-previous:0,
    volume_delta_quote:qDelta,trade_delta:tradeDelta,
    volume_accel_ratio:qBase>0?qDelta/qBase:0,trade_accel_ratio:tBase>0?tradeDelta/tBase:0,
    at:ts,warmed_up:true,
    replay_proxy:'LAST_CLOSED_1M_BAR_VS_PREVIOUS_15_ONE_MINUTE_BARS_NOT_THE_LIVE_20S_TICKER_DELTA'
  };
}
function firstMicroCandidates(all,market,startMs,endMs){
  const out={first_micro_watch_candidate:null,first_micro_score_58:null,first_micro_eligible_deep:null,
    proxy_method:'Exact Build224 Micro fingerprint on historical closed 1m/5m/BTC 5m candles; fast ticker deltas approximated from 1m bars; market-wide ranking and historical book/depth are unavailable'};
  for(const candle of all['1m'].filter(x=>Number(x.closeTime)>=startMs&&Number(x.closeTime)<=endMs)){
    const ts=Number(candle.closeTime),ticker=historicalTicker(all['1m'],ts);
    if(!ticker)continue;
    ticker.symbol='INITUSDT';
    const one=at(all['1m'],ts).slice(-120),five=at(all['5m'],ts).slice(-60);
    const btc=at(market.fiveMinute||[],ts).slice(-120);
    const fingerprint=buildMicroFingerprint({oneMinute:one,fiveMinute:five,btcFiveMinute:btc,ticker,now:ts,config:EARLY_EXPANSION_RADAR_DEFAULTS});
    const fast=fastDeltaProxy(all['1m'],ts);
    const micro={row:ticker,fast,oneMinute:one,fiveMinute:five,micro_fingerprint:fingerprint,source:['BINANCE_PUBLIC_REST']};
    const result={
      time:new Date(ts).toISOString(),price:Number(ticker.lastPrice),
      price_change_24h_pct:Number(ticker.priceChange24h),quote_volume_24h_usdt:Number(ticker.quoteVolume24h),
      trade_count_24h:Number(ticker.tradeCount24h),score:fingerprint.score,
      confirmation_count:fingerprint.confirmation_count,stage:fingerprint.stage,mode:fingerprint.mode,
      eligible:fingerprint.eligible,category_scores:fingerprint.category_scores,metrics:fingerprint.metrics,
      reasons:fingerprint.reasons,risk_flags:fingerprint.risk_flags,fast_proxy:fast
    };
    if(!out.first_micro_score_58&&Number(fingerprint.score)>=58&&Number(fingerprint.confirmation_count)>=3&&
      Math.abs(Number(ticker.priceChange24h))<18&&Math.abs(Number(fingerprint.metrics?.return_15m))<6)
      out.first_micro_score_58=result;
    if(!out.first_micro_eligible_deep&&fingerprint.eligible===true)out.first_micro_eligible_deep=result;
    if(!out.first_micro_watch_candidate){
      const watch=buildMicroEarlyFlowWatchCandidate(micro,ts,EARLY_EXPANSION_RADAR_DEFAULTS);
      if(watch)out.first_micro_watch_candidate={...result,watch_candidate:watch};
    }
    if(out.first_micro_watch_candidate&&out.first_micro_score_58&&out.first_micro_eligible_deep)break;
  }
  return out;
}
function firstScoreRow(rows,threshold){
  const row=rows.find(x=>Number(x.forensic_evidence_score)>=threshold&&
    Number(x.price_change_24h_pct)<=12&&Number(x.quote_volume_24h_usdt)>=750000&&
    !x.risk_flags?.includes('ALREADY_EXTENDED'));
  return row?{
    close_time:row.close_time,price:row.close,score:row.forensic_evidence_score,
    price_change_24h_pct:row.price_change_24h_pct,
    quote_volume_24h_usdt:row.quote_volume_24h_usdt,
    risk_flags:row.risk_flags,reason_codes:row.reason_codes,metrics:row.metrics,
    gates:row.gates
  }:null;
}
async function fetchSymbol(symbol){
  const intervals=[['1m',targetStart-24*3600000],['5m',targetStart-24*3600000],['15m',targetStart-48*3600000],['1h',fetchStart],['4h',fetchStart]];
  const out={},sources=[];
  for(const [tf,start] of intervals){const r=await fetchRange(symbol,tf,start,throughMs);out[tf]=r.candles;sources.push(r.source);}
  return {series:out,sources};
}
function staticRadarAudit(){
  return {
    scanner_scope:'BINANCE_SPOT_USDT',
    closed_candles_only:true,
    fast_scan:'ALL_ELIGIBLE_TICKERS_EVERY_CYCLE',
    min_quote_volume_24h_usdt:750000,
    quiet_base_max_24h_move_pct:8,
    early_window_max_24h_move_pct:12,
    hard_extended_24h_move_pct:18,
    hard_extended_1h_move_pct:8,
    hard_extended_15m_move_pct:6,
    watch_early_score:58,
    pre_expansion_score:70,
    breakout_developing_score:80,
    min_alert_score:82,
    historical_orderbook_replay:'UNAVAILABLE',
    actual_notification_reconstruction:'NOT_VERIFIABLE_WITHOUT_HISTORICAL_ORDERBOOK_AND_RUNTIME_ALERT_LOGS',
    note:'This replay evaluates closed-candle evidence only. It does not fabricate historical bid/ask depth, spread, or actual notification delivery.'
  };
}
async function run(){
  await mkdir('reports',{recursive:true});
  const market5=(await fetchRange('BTCUSDT','5m',fetchStart,throughMs)).candles;
  const market1=(await fetchRange('BTCUSDT','1h',fetchStart,throughMs)).candles;
  const market={fiveMinute:market5,oneHour:market1};
  const cases=[];
  for(const [symbol,expected] of SYMBOLS){
    try{
      const got=await fetchSymbol(symbol);
      const anchor=deriveAnchor(got.series['1m'],expected);
      const timeline=fullTimeline(got.series,targetStart,throughMs,market);
      const microCandidates=firstMicroCandidates(got.series,market,targetStart,throughMs);
      const rawCandleHistory=Object.fromEntries(Object.entries(got.series).map(([tf,rows])=>[tf,rows.filter(x=>Number(x.closeTime)>=targetStart&&Number(x.closeTime)<=throughMs).map(x=>({open_time:new Date(Number(x.openTime)).toISOString(),close_time:new Date(Number(x.closeTime)).toISOString(),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),base_volume:Number(x.volume),quote_volume_usdt:Number(x.quoteVolume),trade_count:Number(x.tradeCount),taker_buy_base_volume:Number(x.takerBuyBaseVolume),taker_buy_quote_volume_usdt:Number(x.takerBuyQuoteVolume)}))]));
      const row={symbol,expected_move_pct:expected,anchor,sources:got.sources,micro_replay:microCandidates,event_window:{start:new Date(targetStart).toISOString(),end:new Date(throughMs).toISOString()},raw_candle_history:rawCandleHistory,full_15m_timeline:timeline,first_klines_only_thresholds:{watch_58:firstScoreRow(timeline,58),pre_expansion_70:firstScoreRow(timeline,70),alert_score_82:firstScoreRow(timeline,82)}};
      if(anchor.status==='OK'){
        row.checkpoints=checkpointRows(got.series,anchor.anchor_time,expected,market);
        row.first_partial_evidence=firstPartialEvidence(got.series,anchor.anchor_time,market);
        row.move_confirmation_metrics={
          observed_peak_high:anchor.peak_high,
          observed_run_pct:anchor.observed_run_pct
        };
      }else row.checkpoints=[];
      cases.push(row);
    }catch(e){
      cases.push({symbol,expected_move_pct:expected,status:'NOT_VERIFIED',reason:'HISTORICAL_DATA_FETCH_FAILED',error:String(e?.message??e)});
    }
  }

  const audit=staticRadarAudit();
  const allScores=cases.flatMap(x=>(x.checkpoints||[]).map(c=>Number(c.score_forensic_only)).filter(Number.isFinite));
  const detectedPartial=cases.filter(x=>x.first_partial_evidence?.status==='PARTIAL_EVIDENCE_ONLY').length;
  const timeline=cases[0]?.full_15m_timeline||[];
  const first58=cases[0]?.first_klines_only_thresholds?.watch_58||null;
  const first70=cases[0]?.first_klines_only_thresholds?.pre_expansion_70||null;
  const first82=cases[0]?.first_klines_only_thresholds?.alert_score_82||null;
  const report={
    report_version:'RADAR8_INITUSDT_FORENSIC_V1',
    event_window:{start:new Date(targetStart).toISOString(),end:new Date(throughMs).toISOString()},
    threshold_summary:{timeline_candles_15m:timeline.length,first_watch_58:first58,first_pre_expansion_70:first70,first_alert_score_82:first82},
    as_of:THROUGH,
    data_policy:{spot_only:true,closed_candles_only:true,no_lookahead_in_features:true,confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false},
    event_definition:'major move onset = earliest 1m closed candle before the 24h-window peak with a forward 1h high >= max(3%, 18% of expected move), forward 4h high >= max(3%, 12% of expected move), and no prior 1h move reaching the trigger.',
    symbols:SYMBOLS.map(x=>x[0]),
    cases,
    existing_radar_code_audit:audit,
    aggregate:{
      named_cases:cases.length,
      cases_with_derived_anchor:cases.filter(x=>x.anchor?.status==='OK').length,
      cases_with_partial_evidence_lead:detectedPartial,
      mean_partial_forensic_score:allScores.length?Number((allScores.reduce((a,b)=>a+b,0)/allScores.length).toFixed(2)):null,
      precision_recall_status:'INSUFFICIENT_NEGATIVE_CONTROL_SAMPLE_IN_THIS_NAMED-CASE_REPLAY',
      false_positive_status:'NOT_ESTIMABLE_FROM_NAMED_POSITIVE_CASES_ONLY',
      orderbook_history_status:'UNAVAILABLE_FROM_BINANCE_PUBLIC_KLINES'
    }
  };
  await writeFile('reports/initusdt-build224-forensic-2026-11-09-10.json',JSON.stringify(report,null,2));
  const md=[];
  md.push('# Build 224 Radar 8 — INITUSDT Historical Replay — 2026-11-09 to 2026-11-10');
  md.push('');
  md.push(`As-of (UTC): ${THROUGH}`);
  md.push('');
  md.push('## Data integrity policy');
  md.push('Only closed Binance Spot candles are used as feature inputs. Historical order-book, historical spread, and historical external-news snapshots are not fabricated; where unavailable the report says INSUFFICIENT_HISTORICAL_EVIDENCE / UNAVAILABLE.');
  md.push('');
  md.push('## Build 224 Micro stage (1m/5m candle replay; approximate fast ticker deltas)');
  md.push(`First Micro score >=58 / >=3 confirmations: ${cases[0]?.micro_replay?.first_micro_score_58?.time||'NONE'}`);
  md.push(`First eligible Deep Micro fingerprint: ${cases[0]?.micro_replay?.first_micro_eligible_deep?.time||'NONE'}`);
  md.push(`First Micro early-flow watch candidate: ${cases[0]?.micro_replay?.first_micro_watch_candidate?.time||'NONE'}`);
  md.push('Micro OHLCV signals use exact Build 224 scoring on closed candles, but the live 20-second ticker delta is approximated from 1-minute bars; this does not reconstruct the historical 18-symbol selection rank, market-wide candidate pool, or book liquidity.');
  md.push('');
  md.push('## Threshold crossings (forensic candle-score proxy; not a guaranteed historical push)');
  md.push(`15m rows evaluated: ${timeline.length}`);
  md.push(`First >=58 WATCH_EARLY proxy: ${first58?`${first58.close_time} @ ${first58.price}`:'NONE'}`);
  md.push(`First >=70 PRE_EXPANSION proxy: ${first70?`${first70.close_time} @ ${first70.price}`:'NONE'}`);
  md.push(`First >=82 alert-score proxy: ${first82?`${first82.close_time} @ ${first82.price}`:'NONE'}`);
  md.push('A candle-score crossing is not proof of actual alert delivery: historical order-book, spread, market-universe admission, deep-scan scheduling and push logs are not available for this past event.');
  md.push('');
  md.push('## Event definition');
  md.push(report.event_definition);
  md.push('');
  for(const c of cases){
    md.push(`## ${c.symbol}`);
    md.push(`Expected move reference: ${c.expected_move_pct==null?'DERIVED_FROM_KLINES':('~'+c.expected_move_pct+'%')}`);
    md.push(`Anchor: ${c.anchor?.anchor_iso||'INSUFFICIENT_HISTORICAL_EVIDENCE'}; peak: ${c.anchor?.peak_iso||'UNKNOWN'}`);
    if(c.first_partial_evidence)md.push(`Earliest partial evidence: ${c.first_partial_evidence.first_time||'UNKNOWN'}; lead time: ${c.first_partial_evidence.estimated_lead_time_minutes??'UNKNOWN'} min; status: ${c.first_partial_evidence.status}`);
    md.push('');
    md.push('| Before anchor | Price | 1m | 5m | 15m | 1h | 4h | RVOL 1m | RVOL 5m | Taker buy | Fast accel | Forensic evidence | Decision |');
    md.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for(const x of c.checkpoints||[]){const m=x.metrics||{};md.push(`|${x.hours_before}h|${fmt(x.price)}|${fmt(m.price_change_1m_pct)}|${fmt(m.price_change_5m_pct)}|${fmt(m.price_change_15m_pct)}|${fmt(m.price_change_1h_pct)}|${fmt(m.price_change_4h_pct)}|${fmt(m.rvol_1m)}|${fmt(m.rvol_5m)}|${fmt(m.taker_buy_ratio)}|${fmt(m.fast_price_acceleration_pct)}|${fmt(x.score_forensic_only)}|${x.decision_band||'UNKNOWN'}|`);}
    md.push('');
    md.push('Historical order-book: INSUFFICIENT_HISTORICAL_EVIDENCE. Historical spread: INSUFFICIENT_HISTORICAL_EVIDENCE. Historical news/event: NOT_EVALUATED.');
    md.push('');
  }
  md.push('## Why the seven existing radars can miss these cases');
  md.push('');
  for(const [id,v] of Object.entries(audit))md.push(`- ${id.toUpperCase()}: ${v.structural_risk} Actual historical emission status: ${v.actual_status}.`);
  md.push('');
  md.push('## Radar 8 evaluation limits');
  md.push(`Named positive cases with a derived anchor: ${report.aggregate.cases_with_derived_anchor}/${report.aggregate.named_cases}.`);
  md.push('Precision/recall and false-positive rate are intentionally not claimed from the named positive cases alone. A larger walk-forward negative/control sample is required before calibration or win-rate claims.');
  md.push('');
  md.push('## Structural fix implemented by Radar 8');
  md.push('Fast scan uses the eligible Binance Spot USDT ticker universe every cycle, compares each symbol against its own recent ticker state for short-horizon acceleration, then reserves deep-scan capacity for both fast accelerators and a quiet candidate set. It does not rank deep candidates primarily by 24h gain.');
  await writeFile('reports/initusdt-build224-forensic-2026-11-09-10.md',md.join('\n'));
  console.log(JSON.stringify(report.aggregate,null,2));
}
function fmt(v){return Number.isFinite(Number(v))?Number(v).toFixed(3):'—';}
run().catch(e=>{console.error(e?.stack||e);process.exitCode=1;});
