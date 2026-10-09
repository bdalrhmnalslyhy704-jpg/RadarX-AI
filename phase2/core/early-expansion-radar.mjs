import {buildSpotUniverse, normalizeTickerRow, buildHistoricalFollowThrough} from '../market/universe-scanner.mjs';
import {assessLiquidity, validateSeries, futureIssues} from './data-quality.mjs';
import {decorateRadarAlert} from './radar-alert-meta.mjs';
import {evaluateRadarNotificationGate, rememberRadarAlert} from './radar-notification-gate.mjs';
import {assessPreExpansionFingerprint,measureGradualParticipation} from './pre-expansion-fingerprint.mjs';
import {recordPreExpansionSignals,updatePreExpansionMarkouts,maybeLogPreExpansionOutcomeReport,importHistoricalPreExpansionSignals,backfillHistoricalPreExpansionOutcomes} from './pre-expansion-outcome-tracker.mjs';

function normalizeRadarTickerRow(row,quote){
  const normalized=normalizeTickerRow(row,quote);
  if(normalized)return normalized;
  if(!row||typeof row.symbol!=='string'||!/^[A-Z0-9]{5,30}$/i.test(row.symbol))return null;
  const lastPrice=Number(row.lastPrice),quoteVolume=Number(row.quoteVolume),count=Number(row.count);
  if(!Number.isFinite(lastPrice)||lastPrice<=0||!Number.isFinite(quoteVolume)||quoteVolume<0||!Number.isFinite(count)||count<0)return null;
  const rawChange=row.priceChangePercent;
  const dailyKnown=rawChange!==null&&rawChange!==undefined&&!(typeof rawChange==='string'&&rawChange.trim()==='')&&Number.isFinite(Number(rawChange));
  const high=Number(row.highPrice),low=Number(row.lowPrice);
  const tickerTime=['closeTime','eventTime','openTime'].map(key=>Number(row[key])).find(Number.isFinite)??null;
  return {
    symbol:String(row.symbol).toUpperCase(),quoteAsset:String(quote).toUpperCase(),
    lastPrice,quoteVolume24h:quoteVolume,tradeCount24h:count,
    priceChange24h:dailyKnown?Number(rawChange):null,
    highPrice24h:Number.isFinite(high)&&high>0?high:null,
    lowPrice24h:Number.isFinite(low)&&low>0?low:null,tickerTime
  };
}
const clamp=(v,lo=0,hi=100)=>Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):0));
const finite=(v,d=null)=>Number.isFinite(Number(v))?Number(v):d;
function hasFiniteNumber(v){return v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v));}
function absolute24hMove(row){return hasFiniteNumber(row?.priceChange24h)?Math.abs(Number(row.priceChange24h)):null;}
const mean=a=>{const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:null;};
const median=a=>{const x=(Array.isArray(a)?a:[]).map(Number).filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2;};
const pct=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Number(b)!==0?(Number(a)/Number(b)-1)*100:null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function withRetry(fn,{attempts=1,baseMs=150,maxBackoffMs=1500,sleepFn=sleep}={}){
  let last;
  for(let i=0;i<=attempts;i++){
    try{return await fn();}catch(e){
      last=e;
      if(i>=attempts)break;
      await sleepFn(Math.min(maxBackoffMs,baseMs*Math.pow(2,i)));
    }
  }
  throw last||new Error('RADAR8_RETRY_FAILED');
}
export function localAlertCooldown(lastAt,now,cooldownMs){
  const last=Number(lastAt);
  const current=Number(now);
  const cd=Math.max(0,Number(cooldownMs)||0);
  if(!Number.isFinite(last)||!Number.isFinite(current))return {allowed:true,remaining_ms:0};
  const elapsed=Math.max(0,current-last);
  return {allowed:elapsed>=cd,remaining_ms:Math.max(0,cd-elapsed)};
}

export async function boundedMap(items,concurrency,worker){
  const a=Array.from(items||[]),out=Array(a.length);let next=0;
  const n=Math.max(1,Math.min(Number(concurrency)||1,a.length));
  const run=async()=>{while(true){const i=next++;if(i>=a.length)return;out[i]=await worker(a[i],i);}};
  await Promise.all(Array.from({length:n},run));
  return out;
}

export function emptyEarlyExpansionUniverse(config=EARLY_EXPANSION_RADAR_DEFAULTS,quote=config.quote){
  return {
    expected_total:0,received_total:0,missing_ticker_total:0,
    eligible_total:0,fast_scanned_total:0,scanned_total:0,
    deep_scanned_total:0,skipped_total:0,failed_total:0,
    coverage_ratio:0,deep_coverage_ratio:0,eligible_coverage_ratio:0,
    quote:String(quote||config.quote).toUpperCase(),
    scope:'ALL_ELIGIBLE_SPOT_USDT',
    eligibility_filter:{min_quote_volume_24h:Number(config.minQuoteVolume24h)}
  };
}

export function emptyEarlyExpansionSnapshot(config=EARLY_EXPANSION_RADAR_DEFAULTS,quote=config.quote,error=null){
  const q=String(quote||config.quote).trim().toUpperCase();
  return {
    schema_version:'RADAR8_V2',
    radar:'EARLY_EXPANSION_RADAR',
    radar_name:'Radar 8 — البرق',
    as_of:null,
    quote:q,
    universe:emptyEarlyExpansionUniverse(config,q),
    candidates:[],
    alerts_emitted_this_cycle:0,
    meta:{
      live:false,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
      source:[],closed_candles_only:true,
      fast_scan:'ALL_ELIGIBLE_TICKERS_EVERY_CYCLE',
      deep_scan:'TOP_FAST_ACCELERATION_PLUS_QUIET_RESERVE',
      universe_scope:'ALL_ELIGIBLE_SPOT_USDT'
    },
    error:error??null
  };
}

export function buildEarlyExpansionUniverseCoverage({
  expectedSymbols=[],
  receivedSymbols=[],
  eligibleTotal=0,
  fastScannedTotal=0,
  scannedTotal=0,
  deepScannedTotal=0,
  skippedTotal=0,
  failedTotal=0,
  failedSymbols=[],
  quote='USDT',
  minQuoteVolume24h=750000
}={}){
  const expected=new Set((expectedSymbols||[]).map(x=>String(x).toUpperCase()).filter(Boolean));
  const received=new Set((receivedSymbols||[]).map(x=>String(x).toUpperCase()).filter(x=>expected.has(x)));
  const expectedTotal=expected.size,receivedTotal=received.size;
  const missingTickerTotal=Math.max(0,expectedTotal-receivedTotal);
  return {
    expected_total:expectedTotal,
    received_total:receivedTotal,
    missing_ticker_total:missingTickerTotal,
    eligible_total:Math.max(0,Number(eligibleTotal)||0),
    fast_scanned_total:Math.max(0,Number(fastScannedTotal)||0),
    scanned_total:Math.max(0,Number(scannedTotal)||0),
    deep_scanned_total:Math.max(0,Number(deepScannedTotal)||0),
    skipped_total:Math.max(0,Number(skippedTotal)||0),
    failed_total:Math.max(0,Number(failedTotal)||0),
    coverage_ratio:expectedTotal>0?receivedTotal/expectedTotal:0,
    eligible_coverage_ratio:receivedTotal>0?Math.max(0,Number(eligibleTotal)||0)/receivedTotal:0,
    deep_coverage_ratio:Number(eligibleTotal)>0?Math.max(0,Number(deepScannedTotal)||0)/Number(eligibleTotal):0,
    quote:String(quote||'USDT').toUpperCase(),
    scope:'ALL_ELIGIBLE_SPOT_USDT',
    eligibility_filter:{min_quote_volume_24h:Number(minQuoteVolume24h)},
    failed_symbols:[...new Set((failedSymbols||[]).map(x=>String(x).toUpperCase()).filter(Boolean))]
  };
}

export function decideEarlyExpansionBand({
  gateValid,
  gateIssues=[],
  policyIssues=[],
  highRiskPump=false,
  extended=false,
  historicalReplay=false,
  earlyScore=null,
  breakoutBroken=false,
  r5_3=null,
  atrRatio=null,
  cfg=EARLY_EXPANSION_RADAR_DEFAULTS
}={}){
  const dataIssues=Array.isArray(gateIssues)?gateIssues:[];
  const policy=Array.isArray(policyIssues)?policyIssues:[];
  const score=Number.isFinite(Number(earlyScore))?Number(earlyScore):null;
  if(!gateValid||dataIssues.length>0)return 'DATA_INSUFFICIENT';
  if(policy.includes('LIQUIDITY_INSUFFICIENT')||policy.includes('WIDE_SPREAD'))return 'DATA_INSUFFICIENT';
  if(highRiskPump)return 'HIGH_RISK_PUMP';
  if(extended)return 'ALREADY_EXTENDED';
  if(!historicalReplay&&policy.includes('RECENT_FAKEOUT'))return 'WATCH_EARLY';
  if(score!=null&&score>=Number(cfg.breakoutDevelopingScore??82)&&(breakoutBroken||Number(r5_3||0)>=1.5||Number(atrRatio||0)>=1.2))return 'BREAKOUT_DEVELOPING';
  if(score!=null&&score>=Number(cfg.preExpansionScore??72))return 'PRE_EXPANSION';
  if(score!=null&&score>=Number(cfg.watchEarlyScore??60))return 'WATCH_EARLY';
  return 'NO_SIGNAL';
}

export const EARLY_EXPANSION_RADAR_DEFAULTS=Object.freeze({
  quote:'USDT',
  pollMs:45000,
  universeRefreshMs:15*60*1000,
  minQuoteVolume24h:350000,
  minLiquidityQuality:58,
  maxSpreadBps:22,
  minDataQuality:70,
  microScanCandidates:12,
  rotationReserve:8,
  deepCandidates:3,
  quietReserve:8,
  microConcurrency:6,
  deepConcurrency:4,
  oneMinuteKlines:180,
  fiveMinuteKlines:180,
  fifteenMinuteKlines:160,
  oneHourKlines:260,
  fourHourKlines:220,
  freshness1mMs:3*60*1000,
  freshness5mMs:8*60*1000,
  freshness15mMs:20*60*1000,
  freshness1hMs:75*60*1000,
  freshness4hMs:5*60*60*1000,
  maxEarly24hMovePct:12,
  maxQuiet24hMovePct:8,
  quietMinParticipationRatio:1.12,
  quietMinPriceAccelerationPct:0.03,
  quietDeepMinParticipationScore:58,
  exceptionalRotationBypassSlots:2,
  exceptionalVolumeAccelRatio:2.2,
  exceptionalTradeAccelRatio:1.8,
  exceptionalPriceAccelerationPct:0.15,
  rotationBypassMin24hMovePct:4,
  hardExtended24hMovePct:18,
  hardExtended1hMovePct:8,
  hardExtended15mMovePct:6,
  minAlertScore:82,
  preExpansionScore:70,
  breakoutDevelopingScore:80,
  watchEarlyScore:58,
  minMicroFingerprintScore:68,
  minMicroConfirmations:4,
  alertCooldownMs:10*60*1000,
  minRealertScoreDelta:5,
  retryAttempts:1,
  retryBaseMs:150,
  maxBackoffMs:1500
});

function closed(rows,now=Date.now()){
  return (Array.isArray(rows)?rows:[]).filter(c=>
    c?.closed!==false &&
    Number.isFinite(Number(c?.openTime)) &&
    Number.isFinite(Number(c?.closeTime)) &&
    Number(c.closeTime)<=now &&
    Number(c.open)>0 &&
    Number(c.high)>=Math.max(Number(c.open),Number(c.close)) &&
    Number(c.low)<=Math.min(Number(c.open),Number(c.close)) &&
    Number(c.low)>0 &&
    Number(c.close)>0 &&
    Number(c.volume)>=0
  ).sort((a,b)=>Number(a.openTime)-Number(b.openTime));
}

function closes(rows){return rows.map(x=>Number(x.close)).filter(Number.isFinite);}
function returns(rows,n=1){
  if(rows.length<=n)return null;
  const a=Number(rows.at(-(n+1))?.close),b=Number(rows.at(-1)?.close);
  return a>0&&b>0?(b/a-1)*100:null;
}
function rollingReturns(rows,n=1){
  const out=[];for(let i=n;i<rows.length;i++){const a=Number(rows[i-n]?.close),b=Number(rows[i]?.close);if(a>0&&b>0)out.push((b/a-1)*100);}return out;
}
function trueRanges(rows){
  const out=[];for(let i=1;i<rows.length;i++){const h=Number(rows[i].high),l=Number(rows[i].low),pc=Number(rows[i-1].close);if(h>0&&l>0&&pc>0)out.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return out;
}
function atr(rows,len=14){const tr=trueRanges(rows);return tr.length>=len?mean(tr.slice(-len)):null;}
function ema(xs,p=20){
  const x=xs.map(Number).filter(Number.isFinite);if(x.length<p)return null;const k=2/(p+1);let e=mean(x.slice(0,p));for(const v of x.slice(p))e=k*v+(1-k)*e;return e;
}
function emaSeries(xs,p=20){
  const x=xs.map(Number).filter(Number.isFinite);if(x.length<p)return [];
  const k=2/(p+1);let e=mean(x.slice(0,p));const out=Array(p-1).fill(null);out.push(e);for(const v of x.slice(p)){e=k*v+(1-k)*e;out.push(e);}return out;
}
function std(xs){const m=mean(xs);return xs.length?Math.sqrt(mean(xs.map(v=>(v-m)**2))||0):null;}
function bollinger(rows,len=20){
  const a=closes(rows).slice(-len);if(a.length<len)return null;
  const mid=mean(a),sd=std(a)||0;
  return {mid,upper:mid+2*sd,lower:mid-2*sd,width:mid>0?4*sd/mid*100:null};
}
function bbWidthHistory(rows,len=20,count=30){
  const out=[];for(let i=1;i<=count;i++){const end=rows.length-i;if(end>=len){const b=bollinger(rows.slice(0,end+1),len);if(Number.isFinite(b?.width))out.push(b.width);}}return out;
}
function rsi(rows,len=14){
  const x=closes(rows);if(x.length<len+1)return null;let g=0,l=0;
  for(let i=1;i<=len;i++){const d=x[i]-x[i-1];if(d>=0)g+=d;else l-=d;}
  let ag=g/len,al=l/len;
  for(let i=len+1;i<x.length;i++){const d=x[i]-x[i-1];ag=(ag*(len-1)+Math.max(0,d))/len;al=(al*(len-1)+Math.max(0,-d))/len;}
  return al===0?100:100-(100/(1+ag/al));
}
function macd(rows){
  const x=closes(rows),fast=ema(x,12),slow=ema(x,26);if(fast==null||slow==null)return null;
  const line=fast-slow;
  const lines=[];for(let i=26;i<=x.length;i++){const f=ema(x.slice(0,i),12),s=ema(x.slice(0,i),26);if(f!=null&&s!=null)lines.push(f-s);}
  const signal=ema(lines,9);return {line,signal,histogram:signal==null?null:line-signal};
}
function adx(rows,len=14){
  if(rows.length<len*2+2)return null;
  const tr=[],plus=[],minus=[];
  for(let i=1;i<rows.length;i++){
    const h=Number(rows[i].high),l=Number(rows[i].low),ph=Number(rows[i-1].high),pl=Number(rows[i-1].low),pc=Number(rows[i-1].close);
    const up=h-ph,down=pl-l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    plus.push(up>down&&up>0?up:0);minus.push(down>up&&down>0?down:0);
  }
  const vals=[];for(let i=len;i<=tr.length;i++){
    const t=mean(tr.slice(i-len,i))||0,p=mean(plus.slice(i-len,i))||0,m=mean(minus.slice(i-len,i))||0;
    const pdi=t?100*p/t:0,mdi=t?100*m/t:0,dx=(pdi+mdi)>0?100*Math.abs(pdi-mdi)/(pdi+mdi):0;
    vals.push({pdi,mdi,dx});
  }
  if(vals.length<len)return null;
  const recent=vals.at(-len),adxVal=mean(vals.slice(-len).map(x=>x.dx));
  return {adx:adxVal,pdi:recent.pdi,mdi:recent.mdi};
}
function vwap(rows,len=20){
  const a=rows.slice(-len);let pv=0,q=0;
  for(const c of a){const qq=Number(c.quoteVolume??(Number(c.volume)*Number(c.close)));if(qq>=0&&Number(c.close)>0){pv+=Number(c.close)*qq;q+=qq;}}
  return q>0?pv/q:null;
}
function obv(rows){
  let v=0;const out=[];
  for(let i=0;i<rows.length;i++){if(i){const c=Number(rows[i].close),p=Number(rows[i-1].close);if(c>p)v+=Number(rows[i].volume)||0;else if(c<p)v-=Number(rows[i].volume)||0;}out.push(v);}
  return out;
}
function obvSlope(rows){
  const o=obv(rows).slice(-20);if(o.length<10)return null;const first=o[0],last=o.at(-1),base=Math.max(1,Math.abs(first)+Math.abs(last));return (last-first)/base;
}
function closePosition(rows,len=30){
  const a=rows.slice(-len);if(!a.length)return null;const hi=Math.max(...a.map(x=>Number(x.high))),lo=Math.min(...a.map(x=>Number(x.low))),last=Number(a.at(-1).close);return hi>lo?(last-lo)/(hi-lo)*100:null;
}
function pivotLows(rows){
  const out=[];for(let i=2;i<rows.length-2;i++){const l=Number(rows[i].low);if(l<=Number(rows[i-1].low)&&l<=Number(rows[i-2].low)&&l<=Number(rows[i+1].low)&&l<=Number(rows[i+2].low))out.push({index:i,price:l});}return out;
}
function higherLowScore(rows){
  const p=pivotLows(rows);if(p.length<2)return {score:45,higher_low:false};
  const a=p.at(-2)?.price,b=p.at(-1)?.price;const hl=Number.isFinite(a)&&Number.isFinite(b)&&b>a;
  return {score:hl?88:48,higher_low:hl,last_two_pivots:[a,b]};
}
function breakoutInfo(rows,len=20){
  if(rows.length<len+1)return {score:45,distance_pct:null,broken:false,resistance:null};
  const prior=rows.slice(-(len+1),-1);const resistance=Math.max(...prior.map(x=>Number(x.high)));const price=Number(rows.at(-1).close);
  if(!(resistance>0)||!(price>0))return {score:45,distance_pct:null,broken:false,resistance:null};
  const d=(price/resistance-1)*100;const broken=d>=0;
  return {score:broken?98:clamp(100-Math.abs(d)*40),distance_pct:d,broken,resistance};
}
function rangeCompression(rows,len=12){
  const recent=rows.slice(-len).map(x=>Math.abs(Number(x.high)-Number(x.low))/Math.max(Number(x.close),1e-12)*100);
  const base=rows.slice(-len*4,-len).map(x=>Math.abs(Number(x.high)-Number(x.low))/Math.max(Number(x.close),1e-12)*100);
  const r=median(recent),b=median(base);
  if(!(Number.isFinite(r)&&Number.isFinite(b)&&b>0))return {score:45,ratio:null};
  return {score:clamp(92-(r/b)*70),ratio:r/b};
}
function rvol(rows,len=20){
  if(rows.length<len+1)return null;
  const current=Number(rows.at(-1).volume),base=median(rows.slice(-len-1,-1).map(x=>Number(x.volume)));
  return Number.isFinite(current)&&Number.isFinite(base)&&base>0?current/base:null;
}
function quoteRvol(rows,len=20){
  if(rows.length<len+1)return null;
  const current=Number(rows.at(-1).quoteVolume),base=median(rows.slice(-len-1,-1).map(x=>Number(x.quoteVolume)));
  return Number.isFinite(current)&&Number.isFinite(base)&&base>0?current/base:null;
}
function takerRatio(rows,len=5){
  const a=rows.slice(-len),buy=a.reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0),vol=a.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
  return vol>0?buy/vol:null;
}
function takerBaseline(rows){
  const a=rows.slice(-31,-5);if(a.length<10)return null;
  const ratios=a.map(x=>{const v=Number(x.volume),b=Number(x.takerBuyBaseVolume);return v>0?b/v:null;}).filter(Number.isFinite);
  return median(ratios);
}
function pressureScore(rows){
  const br=takerRatio(rows,5),base=takerBaseline(rows),delta=Number.isFinite(br)&&Number.isFinite(base)?br-base:null;
  return {score:Number.isFinite(br)?clamp(50+(br-.5)*300+(delta||0)*450):45,buy_ratio:br,buy_delta:delta};
}
function atrExpansion(rows){
  const now=atr(rows,14),hist=[];for(let i=1;i<=20;i++){const end=rows.length-i;if(end>=16){const a=atr(rows.slice(0,end+1),14);if(Number.isFinite(a))hist.push(a);}}
  const base=median(hist);return {ratio:Number.isFinite(now)&&Number.isFinite(base)&&base>0?now/base:null,score:Number.isFinite(now)&&Number.isFinite(base)&&base>0?clamp(50+(now/base-1)*90):45,current_atr:now};
}
function bbExpansion(rows){
  const b=bollinger(rows,20),hist=bbWidthHistory(rows,20,24),base=median(hist);
  const ratio=Number.isFinite(b?.width)&&Number.isFinite(base)&&base>0?b.width/base:null;
  const squeeze=Number.isFinite(base)&&Number.isFinite(b?.width)?clamp(100-(b.width/Math.max(base,1e-9))*70):45;
  const release=Number.isFinite(ratio)?clamp(50+(ratio-1)*90):45;
  return {width:b?.width??null,ratio,score:clamp(squeeze*.55+release*.45),squeeze_score:squeeze,release_score:release};
}
function mtfAlignment(series){
  const s15=series['15m'],s1=series['1h'],s4=series['4h'];if(!s15?.length||!s1?.length||!s4?.length)return {score:45,details:{}};
  const c15=Number(s15.at(-1).close),c1=Number(s1.at(-1).close),c4=Number(s4.at(-1).close);
  const e15a=ema(closes(s15),9),e15b=ema(closes(s15),21),e1a=ema(closes(s1),20),e1b=ema(closes(s1),50),e4a=ema(closes(s4),20),e4b=ema(closes(s4),50);
  const hits=[
    c15>e15a&&e15a>=e15b,
    c1>e1a&&e1a>=e1b,
    c4>e4a&&e4a>=e4b
  ].filter(Boolean).length;
  return {score:([45,68,84,94][hits]??45),details:{hits,price_above_ema_15m:c15>e15a,price_above_ema_1h:c1>e1a,price_above_ema_4h:c4>e4a}};
}
function marketRegime(marketContext){
  const m5=marketContext?.fiveMinute||[],m1=marketContext?.oneHour||[];if(m5.length<12||m1.length<10)return {score:50,label:'UNKNOWN'};
  const r5=returns(m5,3),r1=returns(m1,3),e20=ema(closes(m1),20),last=Number(m1.at(-1)?.close);
  const bullish=(r5??0)>0&&(r1??0)>0&&Number.isFinite(e20)&&last>e20;
  const bearish=(r5??0)<0&&(r1??0)<0&&Number.isFinite(e20)&&last<e20;
  return {score:bullish?85:bearish?28:55,label:bullish?'BULLISH':bearish?'BEARISH':'MIXED',return_5m:r5,return_1h:r1};
}
function fakeoutFlag(rows,len=20){
  if(rows.length<len+3)return {flag:false,score:50};
  const prior=rows.slice(-(len+2),-2),res=Math.max(...prior.map(x=>Number(x.high)));
  const prev=rows.at(-2),last=rows.at(-1);
  const prevHigh=Number(prev?.high),prevClose=Number(prev?.close),lastClose=Number(last?.close);
  const flag=prevHigh>res&&prevClose<res&&lastClose<res;
  return {flag,score:flag?22:50};
}
function depthSignals(book,price,config){
  if(!book||!Array.isArray(book.bids)||!Array.isArray(book.asks)||!book.bids.length||!book.asks.length)return {available:false,score:null,imbalance:null,spread_bps:null,depth_notional:null};
  const mid=(Number(book.bids[0]?.[0])+Number(book.asks[0]?.[0]))/2;
  if(!(mid>0))return {available:false,score:null,imbalance:null,spread_bps:null,depth_notional:null};
  let bid=0,ask=0;
  for(const [p,q] of book.bids){const px=Number(p),qty=Number(q);if(px>=mid*.995&&qty>=0)bid+=px*qty;}
  for(const [p,q] of book.asks){const px=Number(p),qty=Number(q);if(px<=mid*1.005&&qty>=0)ask+=px*qty;}
  const total=bid+ask,imbalance=total>0?(bid-ask)/total:0,spread=((Number(book.asks[0][0])-Number(book.bids[0][0]))/mid)*10000;
  const liquidity=assessLiquidity({book,ticker24h:{quoteVolume:0,count:0}},config.minLiquidityQuality);
  const spreadScore=clamp(100-spread*5),imbalanceScore=clamp(50+imbalance*180);
  return {available:true,score:clamp(spreadScore*.35+imbalanceScore*.45+clamp(Math.log10(Math.max(1,total))*12)*.20),imbalance,spread_bps:spread,depth_notional:total,bid_depth:bid,ask_depth:ask};
}

function dataGate(series,now,config,{historicalReplay=false,allowMissingDepth=false}={}){
  const issues=[],available=[],missing=[];
  const limits={1:config.freshness1mMs,5:config.freshness5mMs,15:config.freshness15mMs,60:config.freshness1hMs,240:config.freshness4hMs};
  for(const [tf,arr] of Object.entries(series)){
    const raw=Array.isArray(arr)?arr:[];
    // Inspect future timestamps BEFORE removing the current/open candle.
    issues.push(...futureIssues(raw,now));
    const rows=closed(raw,now);
    if(rows.length){available.push(tf);const v=validateSeries(rows,tf);if(!v.valid)issues.push(...v.issues);}
    else missing.push(tf);
    if(rows.length){const age=now-Number(rows.at(-1).closeTime);const key=tf==='1m'?1:tf==='5m'?5:tf==='15m'?15:tf==='1h'?60:240;if(age>Number(limits[key]??config.freshness15mMs))issues.push('STALE_DATA:'+tf);}
  }
  const required=['1m','5m','15m','1h','4h'];
  const ratio=available.length/required.length;
  const quality=issues.length?0:clamp(55+ratio*45);
  if(missing.length)issues.push('MISSING_TIMEFRAME:'+missing.join(','));
  return {valid:issues.length===0&&ratio===1&&quality>=config.minDataQuality,quality,issues,available,missing,latest_closed:{
    '1m':closed(series['1m']||[],now).at(-1)?.closeTime??null,
    '5m':closed(series['5m']||[],now).at(-1)?.closeTime??null,
    '15m':closed(series['15m']||[],now).at(-1)?.closeTime??null,
    '1h':closed(series['1h']||[],now).at(-1)?.closeTime??null,
    '4h':closed(series['4h']||[],now).at(-1)?.closeTime??null
  },historical_replay:historicalReplay,allow_missing_depth:allowMissingDepth};
}

export function buildEarlyExpansionEvidence({series={},ticker={},depth=null,marketContext={},fastContext={},now=Date.now(),config={},historicalReplay=false}={}){
  const cfg={...EARLY_EXPANSION_RADAR_DEFAULTS,...config};
  const s={
    '1m':closed(series['1m']||[],now),
    '5m':closed(series['5m']||[],now),
    '15m':closed(series['15m']||[],now),
    '1h':closed(series['1h']||[],now),
    '4h':closed(series['4h']||[],now)
  };
  // Pass the raw series to the gate so future timestamps are rejected before
  // the closed-candle filter removes them.
  const gate=dataGate(series,now,cfg,{historicalReplay,allowMissingDepth:historicalReplay});
  const p=finite(ticker.lastPrice,null);
  if(!(p>0))return {score:null,decision_band:'DATA_INSUFFICIENT',pre_expansion_stage:'DATA_INSUFFICIENT',pre_expansion_fingerprint:{stage:'DATA_INSUFFICIENT',reason:'INVALID_PRICE'},data_quality:0,liquidity_quality:null,data_stale:true,risk_flags:['INVALID_PRICE'],reason_codes:['INVALID_PRICE'],gates:gate};
  const r1=returns(s['1m'],1),r10=returns(s['1m'],10),r5=returns(s['5m'],1),r15=returns(s['15m'],1),r1h=returns(s['1h'],1),r4h=returns(s['4h'],1);
  const r5_3=returns(s['5m'],3),r15_3=returns(s['15m'],3);
  const rv1=rvol(s['1m'],30),rv5=rvol(s['5m'],20),rv15=rvol(s['15m'],20);
  const qrv5=quoteRvol(s['5m'],20);
  const pressure=pressureScore(s['1m']);
  const bb=bbExpansion(s['5m']);
  const atrx=atrExpansion(s['5m']);
  const vwap5=vwap(s['5m'],20),vwapDistance=Number.isFinite(vwap5)&&vwap5>0?(p/vwap5-1)*100:null;
  const ema15a=ema(closes(s['15m']),9),ema15b=ema(closes(s['15m']),21);
  const ema1a=ema(closes(s['1h']),20),ema1b=ema(closes(s['1h']),50);
  const mac=macd(s['1h']),adxv=adx(s['1h']);
  const hl=higherLowScore(s['15m']);
  const br5=breakoutInfo(s['5m'],20),br15=breakoutInfo(s['15m'],20);
  const comp=rangeCompression(s['5m'],12);
  const obv=obvSlope(s['5m']);
  const liq=depthSignals(depth,p??0,cfg);
  const liqQuality=historicalReplay?null:(Number.isFinite(depth?.bids?.length)&&Number.isFinite(depth?.asks?.length)?finite(assessLiquidity({book:depth,ticker24h:{quoteVolume:Number(ticker.quoteVolume24h),count:Number(ticker.tradeCount24h)}},cfg.minLiquidityQuality).quality,null):null);
  const market=marketRegime(marketContext);
  const rsi1h=rsi(s['1h'],14);
  const historicalFollowThrough=buildHistoricalFollowThrough(s['5m'],now,{shortBars:6,longBars:24});
  const historicalScore=Number(historicalFollowThrough.score)||50;
  const historicalWeak=Number(historicalFollowThrough.samples)>=5&&historicalScore<48;
  const volumeAccel=clamp(50+
    ((rv1??1)-1)*28+
    ((rv5??1)-1)*18+
    ((qrv5??1)-1)*12+
    Math.max(0,Number(fastContext.volume_accel_ratio||1)-1)*20
  );
  const rvolPersistence=clamp(
    ((rv1??1)>=1.15?72:50)+
    ((rv5??1)>=1.20?18:0)+
    ((rv15??1)>=1.15?10:0)
  );
  const pressureScoreValue=clamp(pressure.score);
  const breakout=clamp(br5.score*.65+br15.score*.35);
  const compressionExpansion=clamp(bb.score*.60+comp.score*.40);
  const volatilityExpansion=clamp(atrx.score*.75+clamp(50+Math.max(0,Number(fastContext.price_acceleration_pct||0))*120)*.25);
  const vwapScore=Number.isFinite(vwapDistance)?clamp(50+vwapDistance*110):45;
  const emaRibbonScore=ema15a!=null&&ema15b!=null&&ema1a!=null&&ema1b!=null?
    clamp((ema15a>ema15b?68:38)*.45+(ema1a>ema1b?72:38)*.35+(Number(ticker.lastPrice)>ema15a?82:42)*.20):45;
  const momentumIndicatorScore=clamp(
    (adxv?.adx>=15&&adxv?.pdi>adxv?.mdi?82:45)*.32+
    (mac?.histogram>0?74:42)*.28+
    (rsi1h>=50&&rsi1h<=72?72:rsi1h>72?48:38)*.20+
    (obv!=null&&obv>0?70:50)*.20
  );
  const mtf=mtfAlignment(s);
  const orderbookScore=liq.available?liq.score:50;
  const liquidityScore=historicalReplay?50:(liqQuality??0);
  const dataScore=gate.quality;
  const quiet24=clamp(100-Math.max(0,Math.abs(Number(ticker.priceChange24h)||0))*5);
  const instant=finite(fastContext.price_change_pct,0);
  const accel=finite(fastContext.price_acceleration_pct,0);
  const pumpRisk=(
    instant>=2.5||
    Number(r5_3||0)>=5||
    Number(r15_3||0)>=8
  )&&(
    historicalReplay?false:
    (liquidityScore<cfg.minLiquidityQuality || Number(ticker.priceChange24h||0)>=cfg.hardExtended24hMovePct)
  );
  const dumpRisk=(
    instant<=-2.5||
    Number(r5_3||0)<=-5||
    Number(r15_3||0)<=-8
  )&&(
    historicalReplay?false:
    (liquidityScore<cfg.minLiquidityQuality || Number(ticker.priceChange24h||0)<=-cfg.hardExtended24hMovePct)
  );
  const highRisk=pumpRisk;
  const extended=(
    Math.abs(Number(ticker.priceChange24h)||0)>=cfg.hardExtended24hMovePct||
    Math.abs(Number(r1h)||0)>=cfg.hardExtended1hMovePct||
    Math.abs(Number(r15)||0)>=cfg.hardExtended15mMovePct
  );
  const scoreParts={
    volume_acceleration:volumeAccel,
    rvol_persistence:rvolPersistence,
    compression_expansion:compressionExpansion,
    breakout_proximity:breakout,
    higher_low:hl.score,
    buy_sell_pressure:pressureScoreValue,
    orderbook_imbalance:orderbookScore,
    liquidity_quality:liqQuality??null,
    volatility_expansion:volatilityExpansion,
    mtf_alignment:mtf.score,
    market_regime:market.score,
    freshness_data_quality:dataScore,
    historical_followthrough:historicalScore
  };
  const weighted=[
    ['volume_acceleration',.12],['rvol_persistence',.11],['compression_expansion',.12],
    ['breakout_proximity',.10],['higher_low',.07],['buy_sell_pressure',.08],['orderbook_imbalance',.08],
    ['liquidity_quality',.08],['volatility_expansion',.09],['mtf_alignment',.09],
    ['market_regime',.04],['freshness_data_quality',.02],['historical_followthrough',.07]
  ];
  const usable=weighted.filter(([k])=>Number.isFinite(scoreParts[k]));
  const rawScore=usable.reduce((sum,[k,w])=>sum+scoreParts[k]*w,0)/usable.reduce((sum,[,w])=>sum+w,0);
  const gateIssues=[...gate.issues];
  if(!historicalReplay&&(!liq.available||liquidityScore<cfg.minLiquidityQuality))gateIssues.push('LIQUIDITY_INSUFFICIENT');
  if(!historicalReplay&&liq.available&&Number(liq.spread_bps)>cfg.maxSpreadBps)gateIssues.push('WIDE_SPREAD');
  if(extended)gateIssues.push('ALREADY_EXTENDED');
  if(fakeoutFlag(s['5m']).flag)gateIssues.push('RECENT_FAKEOUT');
  if(historicalWeak)gateIssues.push('HISTORICAL_FOLLOWTHROUGH_WEAK');
  const earlyScore=gate.valid&&gateIssues.every(x=>!['ALREADY_EXTENDED','LIQUIDITY_INSUFFICIENT','WIDE_SPREAD','RECENT_FAKEOUT','HISTORICAL_FOLLOWTHROUGH_WEAK'].includes(x))&&!highRisk&&!dumpRisk&&!historicalReplay
    ? Number(clamp(rawScore).toFixed(1)):null;
  const policyIssues=gateIssues.filter(x=>!gate.issues.includes(x));
  const legacyDecisionBand=decideEarlyExpansionBand({
    gateValid:gate.valid,gateIssues:gate.issues,policyIssues,highRiskPump:highRisk,extended,
    historicalReplay,earlyScore,breakoutBroken:br5.broken,r5_3,atrRatio:atrx.ratio,cfg
  });
  const btcRows=closed(marketContext?.fiveMinute||[],now);
  const coinReturn15m=returns(s['5m'],3),btcReturn15m=returns(btcRows,3);
  const relativeStrengthBtcPct=Number.isFinite(coinReturn15m)&&Number.isFinite(btcReturn15m)?coinReturn15m-btcReturn15m:
    (hasFiniteNumber(fastContext?.micro_fingerprint?.metrics?.relative_strength_5m_pct)?Number(fastContext.micro_fingerprint.metrics.relative_strength_5m_pct):null);
  const volumeTrend=measureGradualParticipation(s['5m'].map(x=>x.quoteVolume??x.volume));
  const tradeTrend=measureGradualParticipation(s['5m'].map(x=>x.tradeCount));
  const volumeRatios=[rv1,rv5,qrv5,fastContext.volume_accel_ratio].filter(Number.isFinite);
  const tradeRatios=[fastContext.trade_accel_ratio,fastContext.micro_fingerprint?.metrics?.trade_rvol_1m,fastContext.micro_fingerprint?.metrics?.trade_rvol_5m].filter(Number.isFinite);
  const atrPct=Number.isFinite(atrx.current_atr)&&p>0?atrx.current_atr/p*100:null;
  const resistanceDistanceAtr=Number.isFinite(br5.distance_pct)&&Number.isFinite(atrPct)&&atrPct>0?-br5.distance_pct/atrPct:null;
  const falseBreakout=fakeoutFlag(s['5m']).flag||fakeoutFlag(s['15m']).flag;
  const preExpansion=assessPreExpansionFingerprint({
    dataReady:gate.valid&&p>0,dailyChangePct:ticker.priceChange24h,lastPrice:p,
    maxMove24hPct:Math.min(8,Number(cfg.maxQuiet24hMovePct??8)),
    maxMove5mPct:2.5,maxMove10mPct:3.8,maxMove15mPct:6,
    baseScore:hl.score*.42+compressionExpansion*.35+quiet24*.23,
    higherLowScore:hl.score,compressionScore:compressionExpansion,
    compressionRatio:comp.ratio,rangeCompressionRatio:comp.ratio,bollingerRatio:bb.ratio,atrRatio:atrx.ratio,
    volumeRatio:volumeRatios.length?Math.max(...volumeRatios):null,
    tradeRatio:tradeRatios.length?Math.max(...tradeRatios):null,
    volumeTrend,tradeTrend,relativeStrengthBtcPct,
    relativeStrengthMarketPct:hasFiniteNumber(ticker.priceChange24h)&&hasFiniteNumber(marketContext?.marketMedianChange24hPct)?Number(ticker.priceChange24h)-Number(marketContext.marketMedianChange24hPct):null,
    resistanceDistanceAtr,breakoutConfirmed:br5.broken,falseBreakout,
    return5mPct:r5,return10mPct:null,return15mPct:r5_3,
    alreadyExtended:extended
  });
  const decisionBand=preExpansion.stage;

  const riskFlags=[
    extended?'ALREADY_EXTENDED':null,
    highRisk?'HIGH_RISK_PUMP':null,
    dumpRisk?'HIGH_RISK_DUMP':null,
    !liq.available&&!historicalReplay?'ORDERBOOK_UNAVAILABLE':null,
    liq.available&&Number(liq.spread_bps)>cfg.maxSpreadBps?'WIDE_SPREAD':null,
    gate.issues.find(x=>x.startsWith('STALE_DATA'))?'STALE_DATA':null,
    gate.issues.find(x=>x.startsWith('MISSING_TIMEFRAME'))?'MISSING_TIMEFRAME':null,
    fakeoutFlag(s['5m']).flag?'RECENT_FAKEOUT':null,
    market.label==='BEARISH'?'MARKET_REGIME_BEARISH':null,
    historicalWeak?'HISTORICAL_FOLLOWTHROUGH_WEAK':null
  ].filter(Boolean);
  const reasons=[
    rv5>=1.2?'RVOL_5M_ACCELERATION':null,
    rv1>=1.15?'RVOL_1M_ACCELERATION':null,
    Number.isFinite(fastContext.volume_accel_ratio)&&fastContext.volume_accel_ratio>=1.4?'FAST_VOLUME_ACCELERATION':null,
    Number.isFinite(fastContext.price_change_pct)&&fastContext.price_change_pct>=0.25?'FAST_PRICE_ACCELERATION':null,
    bb.ratio!=null&&bb.ratio>1.03?'BB_EXPANSION_AFTER_COMPRESSION':null,
    br5.distance_pct!=null&&br5.distance_pct>-1.5?'NEAR_5M_RESISTANCE':null,
    hl.higher_low?'HIGHER_LOW_SEQUENCE':null,
    pressure.buy_ratio!=null&&pressure.buy_ratio>=0.515?'TAKER_BUY_PRESSURE':null,
    liq.available&&liq.imbalance>=0.08?'BID_ASK_IMBALANCE':null,
    atrx.ratio!=null&&atrx.ratio>=1.08?'ATR_EXPANSION':null,
    vwapDistance!=null&&vwapDistance>=0?'VWAP_RECLAIM_OR_ABOVE':null,
    mtf.score>=68?'MTF_ALIGNMENT':null,
    adxv?.pdi>adxv?.mdi&&adxv?.adx>=15?'ADX_PLUS_DI':null,
    mac?.histogram>0?'MACD_POSITIVE_HISTOGRAM':null,
    rsi1h>=50&&rsi1h<=72?'RSI_CONSTRUCTIVE':null,
    obv!=null&&obv>0?'OBV_RISING':null,
    market.label==='BULLISH'?'MARKET_REGIME_SUPPORTIVE':null,
    fakeoutFlag(s['5m']).flag?'FAKEOUT_PENALTY':null
  ].filter(Boolean);

  return {
    early_expansion_score:earlyScore,
    forensic_evidence_score:Number(clamp(rawScore).toFixed(1)),
    decision_band:decisionBand,
    pre_expansion_stage:preExpansion.stage,
    pre_expansion_fingerprint:preExpansion,
    legacy_decision_band:legacyDecisionBand,
    data_quality:Number(gate.quality.toFixed(1)),
    data_stale:Boolean(gate.issues.some(x=>x.startsWith('STALE_DATA'))),
    liquidity_quality:historicalReplay?null:liqQuality,
    liquidity_quality_live:liqQuality,
    score_components:scoreParts,
    metrics:{
      price_change_1m_pct:r1,price_change_5m_pct:r5,price_change_10m_pct:r10,price_change_15m_pct:r15,price_change_1h_pct:r1h,price_change_4h_pct:r4h,
      price_change_5m_15m_agg_pct:r5_3,price_change_15m_45m_agg_pct:r15_3,
      fast_price_change_pct:instant,fast_price_acceleration_pct:accel,
      rvol_1m:rv1,rvol_5m:rv5,rvol_15m:rv15,quote_rvol_5m:qrv5,
      volume_ratio:volumeRatios.length?Math.max(...volumeRatios):null,
      trade_ratio:tradeRatios.length?Math.max(...tradeRatios):microTradeRvol(s['1m'])??microTradeRvol(s['5m']),
      taker_buy_ratio:pressure.buy_ratio,taker_buy_delta:pressure.buy_delta,
      bb_width:bb.width,bb_width_ratio:bb.ratio,compression_ratio:comp.ratio,
      atr_ratio:atrx.ratio,current_atr:atrx.current_atr,
      vwap:vwap5,vwap_distance_pct:vwapDistance,
      ema9_15m:ema15a,ema21_15m:ema15b,ema20_1h:ema1a,ema50_1h:ema1b,
      adx:adxv?.adx??null,plus_di:adxv?.pdi??null,minus_di:adxv?.mdi??null,
      macd_line:mac?.line??null,macd_signal:mac?.signal??null,macd_histogram:mac?.histogram??null,
      rsi_1h:rsi1h,obv_slope:obv,
      five_min_resistance:br5.resistance,five_min_breakout_distance_pct:br5.distance_pct,five_min_broken:br5.broken,
      fifteen_min_resistance:br15.resistance,fifteen_min_breakout_distance_pct:br15.distance_pct,
      higher_low:hl.higher_low,close_location_5m:closePosition(s['5m'],30),
      relative_strength_vs_btc_pct:relativeStrengthBtcPct,relative_strength_vs_market_pct:preExpansion.relative_strength_vs_market_pct,
      resistance_distance_atr:resistanceDistanceAtr,volume_participation_improving:preExpansion.volume_improving,
      trade_participation_improving:preExpansion.trades_improving,participation_trend_score:preExpansion.participation_trend_score,
      orderbook_imbalance:liq.imbalance,spread_bps:liq.spread_bps,depth_notional:liq.depth_notional,
      historical_followthrough_score:historicalScore,
      historical_followthrough_samples:historicalFollowThrough.samples,
      historical_hit_rate_30m:historicalFollowThrough.hit_rate_short,
      historical_hit_rate_2h:historicalFollowThrough.hit_rate_long
    },
    structure_metrics:{higher_low:hl,breakout_5m:br5,breakout_15m:br15,compression:comp,fakeout:fakeoutFlag(s['5m'])},
    trigger_evidence:{
      fast_scan:fastContext,
      rvol_persistence:{rvol_1m:rv1,rvol_5m:rv5,rvol_15m:rv15,quote_rvol_5m:qrv5},
      volatility:{bb,atr:atrx},
      pressure,
      indicators:{vwap_distance_pct:vwapDistance,adx:adxv,macd:mac,rsi_1h:rsi1h,obv_slope:obv},
      mtf_alignment:mtf,
      market_regime:market,
      historical_orderbook_available:!historicalReplay&&liq.available,
      historical_followthrough:historicalFollowThrough
    },
    strategy_evidence:{
      pre_breakout_fingerprint:{
        compression_score:compressionExpansion,
        acceleration_score:volumeAccel,
        participation_score:rvolPersistence,
        pressure_score:pressureScoreValue,
        structure_score:hl.score,
        breakout_score:breakout,
        relative_strength_score:market.score,
        relative_strength_vs_btc_pct:relativeStrengthBtcPct,
        relative_strength_vs_market_pct:preExpansion.relative_strength_vs_market_pct,
        market_regime_label:market.label,
        resistance_distance_atr:resistanceDistanceAtr,
        volume_participation_trend:volumeTrend,
        trade_participation_trend:tradeTrend,
        orderbook_score:orderbookScore,
        historical_followthrough_score:historicalScore,
        historical_followthrough_samples:historicalFollowThrough.samples
      },
      existing_radar_overlap:{
        radar1_early_move:'CAPABILITY_POSSIBLE',
        radar2_strong_move:'LATE_STAGE_ONLY',
        radar3_rotation:'RELATIVE_STRENGTH_DEPENDENT',
        radar4_absorption:'ORDERBOOK_DEPENDENT',
        radar5_kahir:'SELF_BASELINE_DEPENDENT',
        radar6_doomsday:'IGNITION_DEPENDENT',
        radar7_professor:'NEWS/PUBLIC_CLAIM_DEPENDENT'
      }
    },
    market_regime:market,
    gates:{
      score_allowed:Boolean(earlyScore!=null),
      data_gate:gate,
      liquidity_gate:historicalReplay?{allowed:null,reason:'HISTORICAL_ORDERBOOK_UNAVAILABLE'}:{allowed:liq.available&&Number(liqQuality)>=cfg.minLiquidityQuality&&Number(liq.spread_bps)<=cfg.maxSpreadBps,reason:liq.available?'OK':'ORDERBOOK_UNAVAILABLE'},
      anti_chase:{allowed:!extended&&!highRisk,extended,hard_extended_24h:Math.abs(Number(ticker.priceChange24h)||0)>=cfg.hardExtended24hMovePct},
      freshness_data_quality:gate.valid
    },
    risk_flags:[...new Set(riskFlags)],
    reason_codes:[...new Set([
      ...reasons,
      ...gate.issues,
      extended?'ALREADY_EXTENDED':null,
      highRisk?'HIGH_RISK_PUMP':null,
      dumpRisk?'HIGH_RISK_DUMP':null,
      historicalReplay?'HISTORICAL_ORDERBOOK_UNAVAILABLE':null
    ].filter(Boolean))],
    invalidation:[
      'CLOSED_CANDLES_ONLY',
      'STALE_DATA_INVALID',
      'FUTURE_DATA_INVALID',
      'GAPS_INVALID',
      'LIQUIDITY_GATE_REQUIRED_LIVE',
      'WIDE_SPREAD_INVALID',
      extended?'ALREADY_EXTENDED':'NOT_YET_EXTENDED'
    ],
    estimated_lead_time:'UNKNOWN',
    source:historicalReplay?'Binance Public REST historical klines (order-book history unavailable)':'Binance Public REST',
    closed_candles_only:true,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN'
  };
}

function fastCandidateScore(row,fast,cfg){
  const move=absolute24hMove(row);
  const quiet=move===null?35:clamp(100-move*5);
  const instant=clamp(50+Number(fast.price_change_pct||0)*180);
  const accel=clamp(50+Number(fast.price_acceleration_pct||0)*260);
  const vol=Number(fast.volume_accel_ratio);const trades=Number(fast.trade_accel_ratio);
  const activity=clamp(Number.isFinite(vol)?50+(vol-1)*35:50,0,100);
  const tradeActivity=Number.isFinite(trades)?clamp(50+(trades-1)*30):50;
  return instant*.27+accel*.25+activity*.18+tradeActivity*.12+quiet*.12+
    clamp(50+Math.log10(Math.max(1,Number(row.quoteVolume24h)/cfg.minQuoteVolume24h))*22)*.06;
}

function quietCandidateScore(row,fast,cfg){
  const move=absolute24hMove(row);
  if(move===null||!hasFiniteNumber(row?.lastPrice)||Number(row.lastPrice)<=0||
    !hasFiniteNumber(row?.quoteVolume24h)||Number(row.quoteVolume24h)<Number(cfg.minQuoteVolume24h||0))return null;
  const quiet=clamp(100-move*7);
  const volume=hasFiniteNumber(fast?.volume_accel_ratio)?Number(fast.volume_accel_ratio):1;
  const activity=clamp(50+Math.max(0,volume-1)*35);
  const change=hasFiniteNumber(fast?.price_change_pct)?Number(fast.price_change_pct):0;
  return quiet*.55+activity*.25+clamp(80-Math.abs(change)*40)*.20;
}
function isQuietEarlyCandidate(row,fast,cfg){
  const move=absolute24hMove(row);
  if(move===null||move>Number(cfg.maxQuiet24hMovePct??8)||quietCandidateScore(row,fast,cfg)===null)return false;
  const volume=hasFiniteNumber(fast?.volume_accel_ratio)?Number(fast.volume_accel_ratio):null;
  const trades=hasFiniteNumber(fast?.trade_accel_ratio)?Number(fast.trade_accel_ratio):null;
  const acceleration=hasFiniteNumber(fast?.price_acceleration_pct)?Number(fast.price_acceleration_pct):null;
  const shortMove=hasFiniteNumber(fast?.price_change_pct)?Number(fast.price_change_pct):null;
  return (volume!==null&&volume>=Number(cfg.quietMinParticipationRatio??1.12))||
    (trades!==null&&trades>=Number(cfg.quietMinParticipationRatio??1.12))||
    (acceleration!==null&&shortMove!==null&&acceleration>=Number(cfg.quietMinPriceAccelerationPct??0.03)&&shortMove>0);
}
function isExceptionalMicroCandidate(row,fast,cfg){
  const move=absolute24hMove(row);
  if(move===null||move>=Number(cfg.hardExtended24hMovePct||18))return false;
  const volume=hasFiniteNumber(fast?.volume_accel_ratio)?Number(fast.volume_accel_ratio):0;
  const trades=hasFiniteNumber(fast?.trade_accel_ratio)?Number(fast.trade_accel_ratio):0;
  const acceleration=hasFiniteNumber(fast?.price_acceleration_pct)?Number(fast.price_acceleration_pct):0;
  const shortMove=hasFiniteNumber(fast?.price_change_pct)?Number(fast.price_change_pct):0;
  return (volume>=Number(cfg.exceptionalVolumeAccelRatio??2.2)&&acceleration>=Number(cfg.exceptionalPriceAccelerationPct??0.15)&&shortMove>0)||
    (volume>=Number(cfg.exceptionalVolumeAccelRatio??2.2)&&trades>=Number(cfg.exceptionalTradeAccelRatio??1.8)&&acceleration>0)||
    (move>=Number(cfg.rotationBypassMin24hMovePct??4)&&volume>=1.6&&trades>=1.4);
}
function quietDeepRank(item,cfg){
  const row=item?.row,move=absolute24hMove(row),fp=item?.micro_fingerprint;
  if(move===null||move>Number(cfg.maxQuiet24hMovePct??8)||!fp||!hasFiniteNumber(fp.score))return null;
  const m=fp.metrics||{},c=fp.category_scores||{};
  const rv1=hasFiniteNumber(m.rvol_1m)?Number(m.rvol_1m):null;
  const rv5=hasFiniteNumber(m.rvol_5m)?Number(m.rvol_5m):null;
  const tr1=hasFiniteNumber(m.trade_rvol_1m)?Number(m.trade_rvol_1m):null;
  const participation=Math.max(
    hasFiniteNumber(c.participation)?Number(c.participation):0,
    hasFiniteNumber(c.tradeParticipation)?Number(c.tradeParticipation):0,
    rv1!==null?clamp(50+Math.max(0,rv1-1)*18):0,
    rv5!==null?clamp(50+Math.max(0,rv5-1)*12):0,
    tr1!==null?clamp(50+Math.max(0,tr1-1)*20):0
  );
  const structure=Math.max(hasFiniteNumber(c.structure)?Number(c.structure):0,
    hasFiniteNumber(m.higher_low_count)?Number(m.higher_low_count):0);
  const bb=hasFiniteNumber(m.bb_ratio)?Number(m.bb_ratio):null;
  const range=hasFiniteNumber(m.range_compression_ratio)?Number(m.range_compression_ratio):null;
  const atr=hasFiniteNumber(m.atr_ratio)?Number(m.atr_ratio):null;
  const compression=Math.max(hasFiniteNumber(c.compression)?Number(c.compression):0,
    bb!==null&&bb<=.90?78:0,range!==null&&range<=.90?72:0,atr!==null&&atr<=.92?70:0);
  const resistance=hasFiniteNumber(m.resistance_distance_pct)?Number(m.resistance_distance_pct):null;
  const resistanceNear=resistance!==null&&resistance>=-5&&resistance<=1.5;
  if(participation<Number(cfg.quietDeepMinParticipationScore??58)||
    !(compression>=65||structure>=62||resistanceNear))return null;
  return (100-move*6)*.35+participation*.25+structure*.20+compression*.20;
}
function isExceptionalDeepCandidate(item,cfg){
  const move=absolute24hMove(item?.row),fp=item?.micro_fingerprint,m=fp?.metrics||{},c=fp?.category_scores||{};
  if(move===null||move>=Number(cfg.hardExtended24hMovePct||18))return false;
  const volume=Math.max(hasFiniteNumber(m.rvol_1m)?Number(m.rvol_1m):0,hasFiniteNumber(m.rvol_5m)?Number(m.rvol_5m):0);
  const trades=Math.max(hasFiniteNumber(m.trade_rvol_1m)?Number(m.trade_rvol_1m):0,hasFiniteNumber(m.trade_rvol_5m)?Number(m.trade_rvol_5m):0);
  const acceleration=Math.max(hasFiniteNumber(m.acceleration_1m_pct)?Number(m.acceleration_1m_pct):-999,hasFiniteNumber(m.acceleration_5m_pct)?Number(m.acceleration_5m_pct):-999);
  const pressure=hasFiniteNumber(m.taker_buy_ratio)?Number(m.taker_buy_ratio):0;
  const structure=Math.max(hasFiniteNumber(c.structure)?Number(c.structure):0,hasFiniteNumber(m.higher_low_count)?Number(m.higher_low_count):0);
  return (volume>=Number(cfg.exceptionalVolumeAccelRatio??2.2)&&(acceleration>=Number(cfg.exceptionalPriceAccelerationPct??.15)||pressure>=.58||structure>=72))||
    (trades>=Number(cfg.exceptionalTradeAccelRatio??1.8)&&(acceleration>0||pressure>=.58));
}
function selectionSymbol(item){return String(item?.symbol??item?.row?.symbol??'').trim().toUpperCase();}
function takeUniqueLane(selected,seen,pool,count,lane){
  const limit=Math.max(0,Math.trunc(Number(count)||0));
  if(limit===0)return 0;
  let added=0;
  for(const item of pool||[]){
    const symbol=selectionSymbol(item);
    if(!symbol||seen.has(symbol))continue;
    seen.add(symbol);selected.push({...item,_selection_lane:lane});added++;
    if(added>=limit)break;
  }
  return added;
}
function trimCycleMemory(map,maxSize=5000){
  if(map.size<=maxSize)return;
  const oldest=[...map.entries()].sort((a,b)=>a[1]-b[1]);
  for(let i=0;i<oldest.length-maxSize;i++)map.delete(oldest[i][0]);
}

function sourceList(values){return [...new Set(values.flatMap(v=>Array.isArray(v)?v:[v]).filter(Boolean))];}

function alertEligible(candidate,cfg){
  const band=candidate.decision_band;
  return Number.isFinite(candidate.early_expansion_score)&&
    candidate.early_expansion_score>=cfg.minAlertScore&&
    (band==='PRE_EXPANSION'||band==='BREAKOUT_DEVELOPING')&&
    candidate.data_quality>=cfg.minDataQuality&&
    !candidate.data_stale&&
    candidate.risk_flags.every(x=>!['ALREADY_EXTENDED','HIGH_RISK_PUMP','WIDE_SPREAD','RECENT_FAKEOUT'].includes(x));
}

export function buildEarlyExpansionAlert(candidate,now=Date.now()){
  const band=candidate.decision_band;
  return decorateRadarAlert({
    id:'EARLY_EXPANSION:'+candidate.symbol+':'+now,
    event:'EARLY_EXPANSION_RADAR',
    radar:'EARLY_EXPANSION_RADAR',
    radar_name:'Radar 8 — البرق',
    symbol:String(candidate.symbol).toUpperCase(),
    market:'SPOT',
    direction:'UP_BIAS',
    price:finite(candidate.last_price??candidate.lastPrice,null),
    price_change_24h:finite(candidate.price_change_24h??candidate.priceChange24h,null),
    opportunity_score:finite(candidate.early_expansion_score,null),
    early_expansion_score:finite(candidate.early_expansion_score,null),
    potential_label:band,
    decision_band:band,
    price_change_windows:candidate.metrics,
    volume_metrics:{
      rvol_1m:candidate.metrics?.rvol_1m,
      rvol_5m:candidate.metrics?.rvol_5m,
      rvol_15m:candidate.metrics?.rvol_15m,
      quote_rvol_5m:candidate.metrics?.quote_rvol_5m,
      fast_volume_acceleration:candidate.trigger_evidence?.fast_scan?.volume_accel_ratio
    },
    liquidity_metrics:{
      liquidity_quality:candidate.liquidity_quality,
      spread_bps:candidate.metrics?.spread_bps,
      orderbook_imbalance:candidate.metrics?.orderbook_imbalance,
      depth_notional:candidate.metrics?.depth_notional
    },
    structure_metrics:candidate.structure_metrics,
    strategy_evidence:candidate.strategy_evidence,
    trigger_evidence:candidate.trigger_evidence,
    risk_flags:candidate.risk_flags,
    reason_codes:candidate.reason_codes,
    invalidation:candidate.invalidation,
    estimated_lead_time:candidate.estimated_lead_time||'UNKNOWN',
    data_quality:candidate.data_quality,
    liquidity_quality:candidate.liquidity_quality,
    data_stale:candidate.data_stale,
    source:candidate.source,
    coverage:candidate.coverage,
    paper_trading:true,
    real_order_execution:false,
    confidence_score:'UNKNOWN',
    detected_at:now,
    processed_at:now,
    disclaimer:'Radar 8 — البرق يكتشف تراكم أدلة قابلة للقياس قبل/أثناء التوسع؛ لا يتنبأ بيقين ولا يضمن استمرار الحركة، والإشارات ورقية فقط.'
  },'Radar 8 — البرق');
}


function symbolHash(symbol){
  let h=2166136261>>>0;
  for(const ch of String(symbol||'')){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}
  return h>>>0;
}
function microRvol(rows,n=20){
  if(rows.length<n+1)return null;
  const now=Number(rows.at(-1)?.volume),base=median(rows.slice(-n-1,-1).map(x=>Number(x.volume)));
  return Number.isFinite(now)&&Number.isFinite(base)&&base>0?now/base:null;
}
function microTradeRvol(rows,n=20){
  if(rows.length<n+1)return null;
  const now=Number(rows.at(-1)?.tradeCount),base=median(rows.slice(-n-1,-1).map(x=>Number(x.tradeCount)));
  return Number.isFinite(now)&&Number.isFinite(base)&&base>0?now/base:null;
}
function microRelativeStrength(m5,btc5){
  const a=returns(m5,1),b=returns(btc5,1);
  return Number.isFinite(a)&&Number.isFinite(b)?a-b:null;
}
function microTaker(rows,n=5){
  const a=rows.slice(-n);
  const vol=a.reduce((s,x)=>s+Math.max(0,Number(x.volume)||0),0);
  const buy=a.reduce((s,x)=>s+Math.max(0,Number(x.takerBuyBaseVolume)||0),0);
  const ratio=vol>0?buy/vol:null;
  const baseRows=rows.slice(-31,-n);
  const base=median(baseRows.map(x=>{const v=Number(x.volume),b=Number(x.takerBuyBaseVolume);return v>0?b/v:null;}).filter(Number.isFinite));
  return {ratio,delta:Number.isFinite(ratio)&&Number.isFinite(base)?ratio-base:null};
}
function microSeriesIssues(raw,tf,now,cfg){
  const a=Array.isArray(raw)?raw:[];
  const issues=[...futureIssues(a,now)];
  const rows=closed(a,now);
  if(!rows.length)issues.push('MISSING_CANDLES:'+tf);
  else{
    const v=validateSeries(rows,tf);if(!v.valid)issues.push(...v.issues);
    const limit=Number(cfg[`freshness${tf==='1m'?'1m':tf==='5m'?'5m':tf==='15m'?'15m':tf==='1h'?'1h':'4h'}Ms`]??900000);
    if(now-Number(rows.at(-1).closeTime)>limit)issues.push('STALE_DATA:'+tf);
  }
  return {rows,issues};
}
export function scoreMicroProfile(m){
  const participation=clamp(50+(Number.isFinite(m.rv1)?Math.max(0,m.rv1-1)*18:0)+(Number.isFinite(m.rv5)?Math.max(0,m.rv5-1)*12:0)+(Number.isFinite(m.tr1)?Math.max(0,m.tr1-1)*12:0));
  const tradeParticipation=clamp(50+(Number.isFinite(m.tr1)?Math.max(0,m.tr1-1)*20:0)+(Number.isFinite(m.tr5)?Math.max(0,m.tr5-1)*12:0));
  const structure=clamp(Math.max(Number(m.hlScore)||45,m.emaStack?92:m.emaReclaim?78:45));
  const resistance=Number.isFinite(m.resistanceDistance)?(m.breakoutBroken?96:m.resistanceDistance>=-1.5?94:m.resistanceDistance>=-3?82:m.resistanceDistance>=-6?66:42):45;
  const compression=Number.isFinite(m.bbRatio)?clamp(96-Math.max(0,m.bbRatio-.45)*70):45;
  const ema=m.emaStack?92:m.emaReclaim?78:45;
  const relative=Number.isFinite(m.relativeStrength)?clamp(50+m.relativeStrength*140):45;
  const vwapScore=Number.isFinite(m.vwapDistance)?clamp(50+m.vwapDistance*70+(Number.isFinite(m.r5)&&m.r5>0?12:0)):45;
  const pressure=Number.isFinite(m.takerRatio)?clamp(50+(m.takerRatio-.5)*260+(m.takerDelta||0)*350):45;
  const adxScore=Number.isFinite(m.adx)?clamp(m.adx*2.2):45;
  const acceptance=Number.isFinite(m.location)?clamp(m.location*1.05):45;
  const momentumTurn=clamp(50+(Number(m.accel5)||0)*40+(Number(m.accel1)||0)*80+(Number(m.rsiSlope)||0)*1.8+(Number(m.macSlope)||0)*35);
  const absorption=(
    ((Number.isFinite(m.rv1)&&m.rv1>=2)||(Number.isFinite(m.tr1)&&m.tr1>=2)||(Number.isFinite(m.rv5)&&m.rv5>=1.2)) &&
    Number.isFinite(m.r1)&&Math.abs(m.r1)<=1.2 &&
    Number.isFinite(m.takerRatio)&&m.takerRatio<.40 &&
    ((Number.isFinite(m.bbRatio)&&m.bbRatio<=.90)||(Number.isFinite(m.rangeRatio)&&m.rangeRatio<=.78)||Number.isFinite(m.resistanceDistance)&&m.resistanceDistance>=-2.5)
  );
  const reversalAccumulation=pressure>=72&&resistance>=78&&(
    momentumTurn>=55||compression>=70||(Number.isFinite(m.rsi)&&m.rsi>=38&&m.rsi<=56)
  );
  const participationBreak=(
    (participation>=68||tradeParticipation>=68||pressure>=72)&&
    resistance>=78&&structure>=70&&
    (relative>=58||vwapScore>=60||compression>=72||ema>=72)
  );
  const quietCompression=compression>=82&&structure>=72&&resistance>=78&&(ema>=72||relative>=58||vwapScore>=60);
  const mode=absorption&&resistance>=72?'ABSORPTION_IGNITION':
    reversalAccumulation?'REVERSAL_ACCUMULATION':
    participationBreak?'PARTICIPATION_BREAKOUT_BUILD':
    quietCompression?'QUIET_COMPRESSION_BUILD':'EARLY_WATCH';
  const checks=[
    participation>=65||tradeParticipation>=65,
    resistance>=78,structure>=70,compression>=72,ema>=72,
    momentumTurn>=60,relative>=58,vwapScore>=60,pressure>=65||absorption,adxScore>=55
  ];
  const confirmations=checks.filter(Boolean).length;
  const base=(participation*.15+tradeParticipation*.10+structure*.12+resistance*.12+compression*.10+ema*.08+momentumTurn*.08+relative*.08+vwapScore*.06+pressure*.04+adxScore*.04+acceptance*.03);
  const modeBoost=mode==='ABSORPTION_IGNITION'?11:mode==='REVERSAL_ACCUMULATION'?9:mode==='QUIET_COMPRESSION_BUILD'?8:mode==='PARTICIPATION_BREAKOUT_BUILD'?5:0;
  const score=clamp(base+modeBoost);
  const antiChase=Number(m.priceChange24hAbs)<18&&(!Number.isFinite(m.r15)||Math.abs(m.r15)<6);
  const eligible=antiChase&&score>=68&&confirmations>=4&&mode!=='EARLY_WATCH';
  return {score,confirmations,mode,eligible,antiChase,absorption,components:{participation,tradeParticipation,structure,resistance,compression,ema,momentumTurn,relativeStrength:relative,vwap:vwapScore,pressure,adx:adxScore,acceptance}};
}
export function buildMicroFingerprint({oneMinute=[],fiveMinute=[],btcFiveMinute=[],ticker={},now=Date.now(),config=EARLY_EXPANSION_RADAR_DEFAULTS}={}){
  const cfg={...EARLY_EXPANSION_RADAR_DEFAULTS,...config};
  const i1=microSeriesIssues(oneMinute,'1m',now,cfg),i5=microSeriesIssues(fiveMinute,'5m',now,cfg),ib=microSeriesIssues(btcFiveMinute,'5m',now,cfg);
  const issues=[...i1.issues,...i5.issues,...ib.issues];
  if(issues.length)return {eligible:false,stage:'DATA_INSUFFICIENT',score:null,confirmation_count:0,confirmation_total:10,mode:'DATA_INSUFFICIENT',closed_candles_only:true,reason_codes:[...new Set(issues)].slice(0,30),risk_flags:[],metrics:{},category_scores:{}};
  const m1=i1.rows,m5=i5.rows,btc=ib.rows;
  if(m1.length<80||m5.length<40||btc.length<20)return {eligible:false,stage:'WARMING_UP',score:null,confirmation_count:0,confirmation_total:10,mode:'WARMING_UP',closed_candles_only:true,reason_codes:['MICRO_FINGERPRINT_WARMING_UP'],risk_flags:[],metrics:{},category_scores:{}};
  const r1=returns(m1,1),r3=returns(m1,3),r5=returns(m5,1),r15=returns(m5,3);
  const prev5=returns(m5.slice(0,-3),3),prev1=returns(m1.slice(0,-3),3);
  const accel5=Number.isFinite(r15)&&Number.isFinite(prev5)?r15-prev5:null;
  const accel1=Number.isFinite(r3)&&Number.isFinite(prev1)?r3-prev1:null;
  const rv1=microRvol(m1,30),rv5=microRvol(m5,20),tr1=microTradeRvol(m1,30),tr5=microTradeRvol(m5,20),taker=microTaker(m1,5);
  const b=bollinger(m5,20),hist=bbWidthHistory(m5,20,25),bbBase=median(hist),bbRatio=Number.isFinite(b?.width)&&bbBase>0?b.width/bbBase:null;
  const rangeNow=(Number(m5.at(-1).high)-Number(m5.at(-1).low))/Math.max(Number(m5.at(-1).close),1e-12)*100;
  const rangeBase=median(m5.slice(-31,-1).map(x=>(Number(x.high)-Number(x.low))/Math.max(Number(x.close),1e-12)*100));
  const rangeRatio=rangeBase>0?rangeNow/rangeBase:null;
  const atrNow=atr(m5,14),atrBase=median(Array.from({length:20},(_,k)=>{const end=m5.length-k;if(end<16)return null;return atr(m5.slice(0,end+1),14);}).filter(Number.isFinite));
  const atrRatio=Number.isFinite(atrNow)&&atrBase>0?atrNow/atrBase:null;
  const cs=closes(m5),e9=ema(cs,9),e21=ema(cs,21),e50=ema(cs,50),emaStack=Number.isFinite(e9)&&Number.isFinite(e21)&&Number.isFinite(e50)&&e9>=e21&&e21>=e50,emaReclaim=Number.isFinite(e9)&&Number.isFinite(e21)&&e9>=e21;
  const vw=vwap(m5,20),vwDist=Number.isFinite(vw)&&vw>0?(Number(m5.at(-1).close)/vw-1)*100:null;
  const rs=microRelativeStrength(m5,btc);
  const mac=macd(m5),macPrev=macd(m5.slice(0,-3)),macSlope=mac&&macPrev&&Number.isFinite(mac.histogram)&&Number.isFinite(macPrev.histogram)?mac.histogram-macPrev.histogram:null;
  const rsiNow=rsi(m5,14),rsiPrev=rsi(m5.slice(0,-3),14),rsiSlope=Number.isFinite(rsiNow)&&Number.isFinite(rsiPrev)?rsiNow-rsiPrev:null;
  const adxObj=adx(m5,14),adxNow=adxObj?.adx??null;
  const hl=higherLowScore(m5.slice(-48)),br=breakoutInfo(m5,20),location=closePosition(m5,30);
  const price24Abs=Math.abs(Number(ticker.priceChange24h)||0);
  const m={rv1,rv5,tr1,tr5,takerRatio:taker.ratio,takerDelta:taker.delta,bbRatio,rangeRatio,atrRatio,emaStack,emaReclaim,relativeStrength:rs,r1,r5,r15,accel5,accel1,rsi:rsiNow,rsiSlope,macSlope,adx:adxNow,hlScore:hl.score,resistanceDistance:br.distance_pct,breakoutBroken:br.broken,location,vwapDistance:vwDist,priceChange24hAbs:price24Abs};
  const prof=scoreMicroProfile(m);
  const stage=!prof.antiChase?'ANTI_CHASE':prof.eligible?(prof.mode==='ABSORPTION_IGNITION'?'IGNITION_BUILD':'PRE_BREAK'):(prof.score>=58?'WATCH':'BASE_BUILD');
  return {
    eligible:prof.eligible,stage,score:Number(prof.score.toFixed(1)),mode:prof.mode,confirmation_count:prof.confirmations,confirmation_total:10,closed_candles_only:true,
    metrics:{return_1m:r1,return_3m:r3,return_5m:r5,return_15m:r15,acceleration_1m_pct:accel1,acceleration_5m_pct:accel5,rvol_1m:rv1,rvol_5m:rv5,trade_rvol_1m:tr1,trade_rvol_5m:tr5,taker_buy_ratio:taker.ratio,taker_buy_delta:taker.delta,bb_width:b?.width??null,bb_ratio:bbRatio,atr_ratio:atrRatio,ema9:e9,ema21:e21,ema50:e50,vwap:vw,vwap_distance_pct:vwDist,relative_strength_5m_pct:rs,macd_hist:mac?.histogram??null,macd_slope:macSlope,rsi:rsiNow,rsi_slope:rsiSlope,adx:adxNow,higher_low_count:hl.score,resistance_distance_pct:br.distance_pct,resistance:br.resistance,close_location_pct:location,range_compression_ratio:rangeRatio,price_change_24h_abs:price24Abs,absorption:prof.absorption},
    category_scores:prof.components,
    reasons:[prof.components.participation>=75?'MICRO_VOLUME_ACCELERATION':null,prof.components.tradeParticipation>=75?'MICRO_TRADE_ACCELERATION':null,prof.absorption?'LIQUIDITY_ABSORPTION_REVERSAL':null,prof.components.compression>=82?'MICRO_COMPRESSION':null,prof.components.structure>=70?'MICRO_STRUCTURE':null,prof.components.ema>=72?'MICRO_EMA_RECLAIM':null,prof.components.resistance>=78?'MICRO_RESISTANCE_PRESSURE':null,prof.components.relativeStrength>=60?'MICRO_RELATIVE_STRENGTH':null,prof.components.vwap>=60?'MICRO_VWAP_RECLAIM':null,prof.components.momentumTurn>=60?'MICRO_MOMENTUM_TURN':null,prof.components.adx>=55?'MICRO_ADX_TREND':null,prof.mode==='REVERSAL_ACCUMULATION'?'MICRO_REVERSAL_ACCUMULATION':null].filter(Boolean),
    risk_flags:[!prof.antiChase?'MICRO_ANTI_CHASE':null,price24Abs>=12?'MICRO_DAILY_EXTENSION_WARNING':null,Number.isFinite(r15)&&Math.abs(r15)>=5?'MICRO_FAST_EXTENSION_WARNING':null].filter(Boolean),
    source:'Binance Public REST'
  };
}

/**
 * Maintain an effective scan cadence without dropping a whole poll interval when a
 * cycle runs slightly longer than its configured cadence. A busy/error result gets
 * a short bounded retry; every actual tick remains protected by the existing busy flag.
 */
export function nextEarlyExpansionPollDelayMs(pollMs,elapsedMs,completed=true){
  const poll=Math.max(1,Number(pollMs)||45000);
  if(completed!==true)return Math.min(5000,Math.max(1000,poll));
  return Math.max(0,poll-Math.max(0,Number(elapsedMs)||0));
}

export class EarlyExpansionRadar{
  constructor({rest,store,pushManager=null,config={},clock=()=>Date.now(),logger=console}={}){
    if(!rest)throw new Error('REST_CLIENT_REQUIRED');
    if(!store)throw new Error('STORE_REQUIRED');
    this.rest=rest;this.store=store;this.pushManager=pushManager;
    this.config={...EARLY_EXPANSION_RADAR_DEFAULTS,...config};
    this.clock=clock;this.logger=logger;
    this.running=false;this.busy=false;this.timer=null;this.universe=[];this.universeAt=0;
    this.fastState=new Map();this.lastAlertAt=new Map();this.lastAlertScore=new Map();this.lastBand=new Map();
    this.lastMicroScanCycleBySymbol=new Map();this.lastDeepScanCycleBySymbol=new Map();
    this.latestCandidates=[];this.lastResult=null;this.lastScanAtMs=null;this.lastError=null;this.scans=0;this.alertCount=0;
    this.fastScannedTotal=0;this.failedTotal=0;this.failedSymbols=[];this.lastCoverage=emptyEarlyExpansionUniverse(this.config,this.config.quote);
  }
  start(){
    if(this.running)return;
    this.running=true;this.lastError=null;
    const scheduleNext=delayMs=>{
      if(!this.running)return;
      this.timer=setTimeout(()=>{void runCycle();},Math.max(0,Number(delayMs)||0));
    };
    const runCycle=async()=>{
      if(!this.running)return;
      const cycleStartedAt=this.clock();
      let completed=false;
      try{completed=await this.tick();}
      catch(e){this.noteError(e,'scheduled-tick');}
      const elapsedMs=Math.max(0,this.clock()-cycleStartedAt);
      scheduleNext(nextEarlyExpansionPollDelayMs(this.config.pollMs,elapsedMs,completed));
    };
    // tick() refreshes the universe when it is first empty. Starting immediately
    // avoids a separate bootstrap scan racing the scheduler's first timer.
    scheduleNext(0);
  }
  async stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  noteError(e,where='scan'){this.lastError=String(e?.message??e);this.logger.warn?.('EARLY_EXPANSION_RADAR_'+where,this.lastError);}
  normalizeQuote(quote=this.config.quote){
    const q=String(quote||this.config.quote).trim().toUpperCase();
    if(!/^[A-Z0-9]{2,10}$/.test(q))throw new Error('INVALID_QUOTE');
    if(q!==String(this.config.quote).toUpperCase())throw new Error('QUOTE_NOT_CONFIGURED');
    return q;
  }
  async refreshUniverse(quote=this.config.quote){
    const q=this.normalizeQuote(quote);
    const r=await this.rest.request('/api/v3/exchangeInfo');
    this.universe=buildSpotUniverse(r.data,q).map(x=>x.symbol);
    this.universeAt=this.clock();
    this.lastCoverage=emptyEarlyExpansionUniverse(this.config,q);
  }
  async tickerRows(quote=this.config.quote){
    const q=this.normalizeQuote(quote);
    const r=await this.rest.request('/api/v3/ticker/24hr');
    return {rows:(Array.isArray(r.data)?r.data:[]).map(x=>normalizeRadarTickerRow(x,q)).filter(Boolean),source:r.source};
  }
  updateFastState(row){
    const now=this.clock(),history=this.fastState.get(row.symbol)||[],prev=history.at(-1),prev2=history.at(-2);
    const priceChange=prev?.price>0?((row.lastPrice/prev.price)-1)*100:0;
    const prevChange=prev2?.price>0&&prev?.price>0?((prev.price/prev2.price)-1)*100:0;
    const acceleration=priceChange-prevChange;
    const qDelta=prev?row.quoteVolume24h-prev.quote:0;
    const tDelta=prev?row.tradeCount24h-prev.trades:0;
    const qHistory=history.slice(-10).map(x=>x.qDelta).filter(x=>Number.isFinite(x)&&x>0);
    const tHistory=history.slice(-10).map(x=>x.tDelta).filter(x=>Number.isFinite(x)&&x>0);
    const qBase=median(qHistory),tBase=median(tHistory);
    const volumeRatio=Number.isFinite(qBase)&&qBase>0?Math.max(0,qDelta)/qBase:null;
    const tradeRatio=Number.isFinite(tBase)&&tBase>0?Math.max(0,tDelta)/tBase:null;
    const fast={price_change_pct:priceChange,price_acceleration_pct:acceleration,volume_delta_quote:qDelta,trade_delta:tDelta,volume_accel_ratio:volumeRatio,trade_accel_ratio:tradeRatio,at:now,warmed_up:Boolean(prev)};
    history.push({price:row.lastPrice,quote:row.quoteVolume24h,trades:row.tradeCount24h,qDelta,tDelta,priceChange,at:now});
    while(history.length>20)history.shift();
    this.fastState.set(row.symbol,history);
    return fast;
  }
  selectMicro(rows,fastBySymbol,cycle=0){
    const currentCycle=Math.max(0,Math.trunc(Number(cycle)||0));
    const all=(rows||[]).filter(row=>row&&row.symbol).map(row=>{
      const fast=fastBySymbol.get(row.symbol)||{};
      const quiet=quietCandidateScore(row,fast,this.config);
      const fastScore=fastCandidateScore(row,fast,this.config);
      const key=String(row.symbol).toUpperCase();
      const lastCycle=this.lastMicroScanCycleBySymbol.get(key);
      const rotation=((symbolHash(row.symbol)+Math.imul(currentCycle,2654435761))>>>0)/4294967296;
      const rotationAge=lastCycle===undefined?Number.MAX_SAFE_INTEGER:Math.max(0,currentCycle-lastCycle);
      return {...row,fast,
        _microPreScore:fastScore*.55+(quiet??0)*.45,
        _quietScore:quiet??-1,_quietEligible:isQuietEarlyCandidate(row,fast,this.config),
        _exceptional:isExceptionalMicroCandidate(row,fast,this.config),
        _rotation:rotation,_rotationAge:rotationAge};
    });
    const n=Math.max(1,Math.trunc(this.config.microScanCandidates||36));
    const target=Math.min(n,new Set(all.map(x=>String(x.symbol).toUpperCase())).size);
    if(!target)return [];
    const q=Math.min(Math.max(0,Math.trunc(this.config.quietReserve??8)),Math.max(0,target-1));
    const r=Math.min(Math.max(0,Math.trunc(this.config.rotationReserve??8)),Math.max(0,target-q-1));
    const core=target-q-r;
    const byScore=[...all].sort((a,b)=>b._microPreScore-a._microPreScore||a.symbol.localeCompare(b.symbol));
    const byQuiet=all.filter(x=>x._quietEligible).sort((a,b)=>
      (absolute24hMove(a)??Infinity)-(absolute24hMove(b)??Infinity)||b._quietScore-a._quietScore||a.symbol.localeCompare(b.symbol));
    const byRotation=[...all].sort((a,b)=>b._rotationAge-a._rotationAge||a._rotation-b._rotation||a.symbol.localeCompare(b.symbol));
    const byExceptional=all.filter(x=>x._exceptional).sort((a,b)=>b._microPreScore-a._microPreScore||b._rotationAge-a._rotationAge||a.symbol.localeCompare(b.symbol));
    const selected=[],seen=new Set();
    const exceptionSlots=Math.min(core,Math.max(0,Math.trunc(this.config.exceptionalRotationBypassSlots??2)));
    takeUniqueLane(selected,seen,byExceptional,exceptionSlots,'exceptional');
    takeUniqueLane(selected,seen,byScore,Math.max(0,core-selected.length),'score');
    takeUniqueLane(selected,seen,byQuiet,q,'quiet');
    takeUniqueLane(selected,seen,byRotation,r,'rotation');
    takeUniqueLane(selected,seen,byScore,target-selected.length,'fill_score');
    takeUniqueLane(selected,seen,byQuiet,target-selected.length,'fill_quiet');
    takeUniqueLane(selected,seen,byRotation,target-selected.length,'fill_rotation');
    takeUniqueLane(selected,seen,all,target-selected.length,'fill_any');
    for(const item of selected)this.lastMicroScanCycleBySymbol.set(selectionSymbol(item),currentCycle);
    trimCycleMemory(this.lastMicroScanCycleBySymbol);
    return selected.slice(0,target);
  }
  selectDeepFromMicro(results,cycle=0){
    const currentCycle=Math.max(0,Math.trunc(Number(cycle)||0));
    const valid=(results||[]).filter(x=>x&&!x.failed&&selectionSymbol(x)&&x.micro_fingerprint?.score!=null&&hasFiniteNumber(x.micro_fingerprint.score));
    const n=Math.max(1,Math.trunc(this.config.deepCandidates||10));
    const target=Math.min(n,new Set(valid.map(selectionSymbol)).size);
    if(!target)return [];
    // 8 quiet slots by default would crowd out all but one scored candidate in a 10-wide batch.
    const q=Math.min(Math.max(0,Math.trunc(this.config.quietReserve??8)),Math.max(0,target-1),Math.floor(target*.5));
    const r=Math.min(Math.max(0,Math.trunc(this.config.rotationReserve??2)),Math.max(0,target-q-1));
    const core=target-q-r;
    const byScore=[...valid].sort((a,b)=>Number(b.micro_fingerprint?.score??-1)-Number(a.micro_fingerprint?.score??-1)||selectionSymbol(a).localeCompare(selectionSymbol(b)));
    const byQuiet=valid.map(item=>({...item,_quietScore:quietDeepRank(item,this.config)}))
      .filter(item=>item._quietScore!==null)
      .sort((a,b)=>(absolute24hMove(a.row)??Infinity)-(absolute24hMove(b.row)??Infinity)||b._quietScore-a._quietScore||selectionSymbol(a).localeCompare(selectionSymbol(b)));
    const byRotation=[...valid].map(item=>{
      const symbol=selectionSymbol(item),lastCycle=this.lastDeepScanCycleBySymbol.get(symbol);
      return {...item,_rotationAge:lastCycle===undefined?Number.MAX_SAFE_INTEGER:Math.max(0,currentCycle-lastCycle),
        _rotation:((symbolHash(symbol)+Math.imul(currentCycle,2654435761))>>>0)};
    }).sort((a,b)=>b._rotationAge-a._rotationAge||a._rotation-b._rotation||selectionSymbol(a).localeCompare(selectionSymbol(b)));
    const byExceptional=valid.filter(x=>isExceptionalDeepCandidate(x,this.config)).sort((a,b)=>
      Number(b.micro_fingerprint?.score??-1)-Number(a.micro_fingerprint?.score??-1)||selectionSymbol(a).localeCompare(selectionSymbol(b)));
    const selected=[],seen=new Set();
    const exceptionSlots=Math.min(core,Math.max(0,Math.trunc(this.config.exceptionalRotationBypassSlots??2)));
    takeUniqueLane(selected,seen,byExceptional,exceptionSlots,'exceptional');
    takeUniqueLane(selected,seen,byScore,Math.max(0,core-selected.length),'score');
    takeUniqueLane(selected,seen,byQuiet,q,'quiet');
    takeUniqueLane(selected,seen,byRotation,r,'rotation');
    takeUniqueLane(selected,seen,byScore,target-selected.length,'fill_score');
    takeUniqueLane(selected,seen,byQuiet,target-selected.length,'fill_quiet');
    takeUniqueLane(selected,seen,byRotation,target-selected.length,'fill_rotation');
    takeUniqueLane(selected,seen,valid,target-selected.length,'fill_any');
    for(const item of selected)this.lastDeepScanCycleBySymbol.set(selectionSymbol(item),currentCycle);
    trimCycleMemory(this.lastDeepScanCycleBySymbol);
    return selected.slice(0,target);
  }
  async microScan(row,fast,btcFiveMinute){
    const [m1,m5]=await Promise.all([
      withRetry(()=>this.rest.klines(row.symbol,'1m',{limit:this.config.oneMinuteKlines}),{attempts:this.config.retryAttempts,baseMs:this.config.retryBaseMs,maxBackoffMs:this.config.maxBackoffMs,sleepFn:sleep}),
      withRetry(()=>this.rest.klines(row.symbol,'5m',{limit:this.config.fiveMinuteKlines}),{attempts:this.config.retryAttempts,baseMs:this.config.retryBaseMs,maxBackoffMs:this.config.maxBackoffMs,sleepFn:sleep})
    ]);
    return {row,fast,oneMinute:m1.candles,fiveMinute:m5.candles,micro_fingerprint:buildMicroFingerprint({oneMinute:m1.candles,fiveMinute:m5.candles,btcFiveMinute,ticker:row,now:this.clock(),config:this.config}),source:sourceList([m1.source,m5.source])};
  }

  async deepScan(row,fast,marketContext,micro){
    const cfg=this.config,series={'1m':micro.oneMinute,'5m':micro.fiveMinute},sources=[micro.source];
    // These reads are independent. Start them together; the shared weighted REST
    // scheduler still enforces the process-wide public-Binance budget.
    const [r15,r1h,r4h,dd]=await Promise.all([
      withRetry(()=>this.rest.klines(row.symbol,'15m',{limit:cfg.fifteenMinuteKlines}),{attempts:cfg.retryAttempts,baseMs:cfg.retryBaseMs,maxBackoffMs:cfg.maxBackoffMs,sleepFn:sleep}),
      withRetry(()=>this.rest.klines(row.symbol,'1h',{limit:cfg.oneHourKlines}),{attempts:cfg.retryAttempts,baseMs:cfg.retryBaseMs,maxBackoffMs:cfg.maxBackoffMs,sleepFn:sleep}),
      withRetry(()=>this.rest.klines(row.symbol,'4h',{limit:cfg.fourHourKlines}),{attempts:cfg.retryAttempts,baseMs:cfg.retryBaseMs,maxBackoffMs:cfg.maxBackoffMs,sleepFn:sleep}),
      withRetry(()=>this.rest.depth(row.symbol,100),{attempts:cfg.retryAttempts,baseMs:cfg.retryBaseMs,maxBackoffMs:cfg.maxBackoffMs,sleepFn:sleep})
    ]);
    series['15m']=r15.candles;series['1h']=r1h.candles;series['4h']=r4h.candles;
    sources.push(r15.source,r1h.source,r4h.source,dd.source);
    return buildEarlyExpansionEvidence({series,ticker:row,depth:dd.data,marketContext,fastContext:fast,now:this.clock(),config:cfg,historicalReplay:false,sourceList:sources});
  }
  async tick({quote=this.config.quote}={}){
    if(!this.running||this.busy)return false;
    this.busy=true;const scanStartedAt=this.clock();
    const phaseTimings={universe_refresh_ms:0,ticker_fast_selection_ms:0,market_context_ms:0,
      outcome_maintenance_ms:0,micro_scan_ms:0,deep_scan_ms:0,signal_archive_ms:0,notification_ms:0};
    try{
      const q=this.normalizeQuote(quote),now=this.clock();
      const universeRefreshStartedAt=this.clock();
      if(now-this.universeAt>this.config.universeRefreshMs||!this.universe.length)await this.refreshUniverse(q);
      phaseTimings.universe_refresh_ms=Math.max(0,this.clock()-universeRefreshStartedAt);
      const tickerFastStartedAt=this.clock();
      const {rows:rawRows,source:tickerSource}=await this.tickerRows(q);
      const expected=[...this.universe],set=new Set(expected);
      const receivedSymbols=[...new Set(rawRows.map(x=>x.symbol).filter(x=>set.has(x)))];
      const eligible=rawRows.filter(x=>set.has(x.symbol)&&x.quoteVolume24h>=this.config.minQuoteVolume24h);
      const fastBySymbol=new Map();for(const row of eligible)fastBySymbol.set(row.symbol,this.updateFastState(row));
      this.fastScannedTotal=eligible.length;
      const cycle=this.scans+1,selected=this.selectMicro(eligible,fastBySymbol,cycle);
      phaseTimings.ticker_fast_selection_ms=Math.max(0,this.clock()-tickerFastStartedAt);
      let btcFive=[],marketContext={};
      const marketContextStartedAt=this.clock();
      try{
        const [m5,m1]=await Promise.all([this.rest.klines('BTCUSDT','5m',{limit:Math.max(80,this.config.fiveMinuteKlines||180)}),this.rest.klines('BTCUSDT','1h',{limit:60})]);
        btcFive=m5.candles||[];
        const marketMoves=eligible.map(x=>x.priceChange24h).filter(hasFiniteNumber).map(Number);
        marketContext={fiveMinute:m5.candles||[],oneHour:m1.candles||[],marketMedianChange24hPct:median(marketMoves),marketBreadthPct:marketMoves.length?marketMoves.filter(x=>x>0).length/marketMoves.length*100:null};
      }catch(e){this.noteError(e,'market-context');}
      phaseTimings.market_context_ms=Math.max(0,this.clock()-marketContextStartedAt);
      const outcomeMaintenanceStartedAt=this.clock();
      const historyAlerts=[];
      try{
        if(typeof this.store.readEarlyExpansionAlerts==='function')historyAlerts.push(...await this.store.readEarlyExpansionAlerts({sinceMs:now-45*24*60*60*1000,limit:100}));
        if(typeof this.store.readFalconEyeAlerts==='function')historyAlerts.push(...await this.store.readFalconEyeAlerts({sinceMs:now-45*24*60*60*1000,limit:100}));
      }catch(e){this.noteError(e,'outcome-history-read');}
      await importHistoricalPreExpansionSignals(this.store,historyAlerts,{now,logger:this.logger}).catch(e=>this.noteError(e,'outcome-history-import'));
      await updatePreExpansionMarkouts(this.store,rawRows,{now,marketContext,logger:this.logger}).catch(e=>this.noteError(e,'outcome-markout'));
      await backfillHistoricalPreExpansionOutcomes(this.store,this.rest,{now,logger:this.logger}).catch(e=>this.noteError(e,'outcome-history-backfill'));
      await maybeLogPreExpansionOutcomeReport(this.store,{logger:this.logger,now}).catch(e=>this.noteError(e,'outcome-report'));
      phaseTimings.outcome_maintenance_ms=Math.max(0,this.clock()-outcomeMaintenanceStartedAt);
      const microScanStartedAt=this.clock();
      const microScanned=await boundedMap(selected,this.config.microConcurrency,async row=>{
        try{return await this.microScan(row,fastBySymbol.get(row.symbol)||{},btcFive);}
        catch(e){this.failedTotal++;this.noteError(e,'micro-row');return {symbol:row.symbol,failed:true,error:String(e?.message??e),micro_fingerprint:{score:null,confirmation_count:0,eligible:false,closed_candles_only:true},source:sourceList([tickerSource])};}
      });
      phaseTimings.micro_scan_ms=Math.max(0,this.clock()-microScanStartedAt);
      const deepTargets=this.selectDeepFromMicro(microScanned,cycle);
      const deepScanStartedAt=this.clock();
      const scanned=await boundedMap(deepTargets,this.config.deepConcurrency,async micro=>{
        const row=micro.row,fast=fastBySymbol.get(row.symbol)||{};
        try{
          const evidence=await this.deepScan(row,fast,marketContext,micro),fp=micro.micro_fingerprint;
          const microScore=Number(fp?.score),deepScore=Number(evidence.early_expansion_score);
          const promoted=Boolean(fp?.eligible)&&Number.isFinite(microScore);
          const finalScore=promoted?Math.max(Number.isFinite(deepScore)?deepScore:0,microScore):evidence.early_expansion_score;
          const finalBand=evidence.pre_expansion_stage||evidence.decision_band;
          return {
            symbol:row.symbol,last_price:row.lastPrice,price_change_24h:row.priceChange24h,
            early_expansion_score:Number.isFinite(finalScore)?Number(finalScore.toFixed(1)):null,decision_band:finalBand,pre_expansion_stage:finalBand,pre_expansion_fingerprint:evidence.pre_expansion_fingerprint,
            data_quality:evidence.data_quality,liquidity_quality:evidence.liquidity_quality,data_stale:evidence.data_stale,
            metrics:evidence.metrics,micro_fingerprint:fp,
            volume_metrics:{rvol_1m:evidence.metrics.rvol_1m,rvol_5m:evidence.metrics.rvol_5m,rvol_15m:evidence.metrics.rvol_15m,quote_rvol_5m:evidence.metrics.quote_rvol_5m,fast_volume_acceleration:fast.volume_accel_ratio},
            liquidity_metrics:{liquidity_quality:evidence.liquidity_quality,spread_bps:evidence.metrics.spread_bps,orderbook_imbalance:evidence.metrics.orderbook_imbalance,depth_notional:evidence.metrics.depth_notional},
            structure_metrics:evidence.structure_metrics,strategy_evidence:evidence.strategy_evidence,trigger_evidence:evidence.trigger_evidence,
            risk_flags:[...(evidence.risk_flags||[]),...(fp?.risk_flags||[])],reason_codes:[...(evidence.reason_codes||[]),...(fp?.reasons||[])],
            invalidation:evidence.invalidation,estimated_lead_time:evidence.estimated_lead_time,source:sourceList([evidence.source,tickerSource,micro.source]),coverage:null,
            paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',forensic_evidence_score:evidence.forensic_evidence_score,market_regime:evidence.market_regime
          };
        }catch(e){this.failedTotal++;this.noteError(e,'deep-row');return {symbol:row.symbol,failed:true,error:String(e?.message??e),decision_band:'DATA_INSUFFICIENT',data_quality:0,micro_fingerprint:micro.micro_fingerprint,source:sourceList([tickerSource,micro.source])};}
      });
      phaseTimings.deep_scan_ms=Math.max(0,this.clock()-deepScanStartedAt);
      const ok=scanned.filter(x=>x&&!x.failed),deepFailures=scanned.length-ok.length,deepScannedTotal=ok.length;
      const failedSymbols=scanned.filter(x=>x?.failed).map(x=>x.symbol);
      const coverage=buildEarlyExpansionUniverseCoverage({expectedSymbols:expected,receivedSymbols,eligibleTotal:eligible.length,fastScannedTotal:eligible.length,scannedTotal:eligible.length,deepScannedTotal,skippedTotal:Math.max(0,eligible.length-deepScannedTotal),failedTotal:deepFailures,failedSymbols,quote:q,minQuoteVolume24h:this.config.minQuoteVolume24h});
      coverage.micro_scanned_total=microScanned.filter(x=>x&&!x.failed).length;coverage.micro_scan_candidates=selected.length;
      coverage.micro_candidate_target=Math.min(Math.max(1,Math.trunc(this.config.microScanCandidates||36)),eligible.length);
      coverage.micro_candidate_shortfall=Math.max(0,coverage.micro_candidate_target-selected.length);
      coverage.micro_quiet_selected_total=selected.filter(x=>x._selection_lane==='quiet'||x._selection_lane==='fill_quiet').length;
      coverage.micro_rotation_selected_total=selected.filter(x=>x._selection_lane==='rotation'||x._selection_lane==='fill_rotation').length;
      coverage.micro_exceptional_bypass_total=selected.filter(x=>x._selection_lane==='exceptional').length;coverage.rotation_cycle=cycle;
      const deepPool=microScanned.filter(x=>x&&!x.failed&&selectionSymbol(x)&&hasFiniteNumber(x.micro_fingerprint?.score));
      coverage.deep_candidate_pool_total=new Set(deepPool.map(selectionSymbol)).size;
      coverage.deep_candidate_target=Math.min(Math.max(1,Math.trunc(this.config.deepCandidates||10)),coverage.deep_candidate_pool_total);
      coverage.deep_candidates_requested=deepTargets.length;coverage.deep_candidate_shortfall=Math.max(0,coverage.deep_candidate_target-deepTargets.length);
      coverage.deep_quiet_selected_total=deepTargets.filter(x=>x._selection_lane==='quiet'||x._selection_lane==='fill_quiet').length;
      coverage.deep_rotation_selected_total=deepTargets.filter(x=>x._selection_lane==='rotation'||x._selection_lane==='fill_rotation').length;
      coverage.deep_exceptional_bypass_total=deepTargets.filter(x=>x._selection_lane==='exceptional').length;
      coverage.micro_scan_coverage_ratio=eligible.length?coverage.micro_scanned_total/eligible.length:0;coverage.discovery_mode='TICKER_ALL + ROTATING_1M_5M_MICRO + DEEP_15M_1H_4H_DEPTH';
      this.lastCoverage=coverage;this.failedSymbols=[...new Set(failedSymbols)];
      this.logger.info?.('[RADARX_SCAN_COVERAGE] '+JSON.stringify({
        radar:'RADAR_8',build_version:'Build 224',quote:q,observed_at:new Date(now).toISOString(),
        rotation_cycle:coverage.rotation_cycle,
        expected_total:coverage.expected_total,received_total:coverage.received_total,
        missing_ticker_total:coverage.missing_ticker_total,eligible_total:coverage.eligible_total,
        fast_scanned_total:coverage.fast_scanned_total,micro_scan_candidates:coverage.micro_scan_candidates,
        micro_scanned_total:coverage.micro_scanned_total,deep_candidates_requested:coverage.deep_candidates_requested,
        deep_scanned_total:coverage.deep_scanned_total,skipped_total:coverage.skipped_total,
        failed_total:coverage.failed_total,coverage_ratio:coverage.coverage_ratio,
        deep_coverage_ratio:coverage.deep_coverage_ratio,
        quiet_selected_total:coverage.micro_quiet_selected_total,
        rotation_selected_total:coverage.micro_rotation_selected_total,
        exceptional_bypass_total:coverage.micro_exceptional_bypass_total,
        candidate_shortfall:coverage.micro_candidate_shortfall,
        failed_symbols:this.failedSymbols.slice(0,25),
        paper_trading:true,real_order_execution:false
      }));
      for(const item of ok)item.coverage=coverage;
      ok.sort((a,b)=>(Number.isFinite(Number(b.early_expansion_score))?Number(b.early_expansion_score):-1)-(Number.isFinite(Number(a.early_expansion_score))?Number(a.early_expansion_score):-1)||Number(b.micro_fingerprint?.score||-1)-Number(a.micro_fingerprint?.score||-1)||a.symbol.localeCompare(b.symbol));
      this.latestCandidates=ok.slice(0,Math.max(1,Math.min(100,Number(this.config.returnLimit??100))));
      const evaluationObservations=ok.map(candidate=>({
        id:'RADAR8:'+candidate.symbol+':'+now+':'+String(candidate.pre_expansion_stage||candidate.decision_band),
        radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8 — البرق',symbol:candidate.symbol,
        price:candidate.last_price,price_change_24h:candidate.price_change_24h,
        // Measurement-only metadata: preserve the radar's existing score without changing its decision.
        early_expansion_score:candidate.early_expansion_score,
        pre_expansion_stage:candidate.pre_expansion_stage||candidate.decision_band,
        decision_band:candidate.decision_band,data_quality:candidate.data_quality,
        data_stale:candidate.data_stale,closed_candles_only:true,
        reason_codes:candidate.reason_codes||[],risk_flags:candidate.risk_flags||[],
        metrics:candidate.metrics||{},strategy_evidence:candidate.strategy_evidence||{},
        market_regime:candidate.market_regime,source:candidate.source,detected_at:now
      }));
      const signalArchiveStartedAt=this.clock();
      await recordPreExpansionSignals(this.store,evaluationObservations,{now,marketContext,logger:this.logger}).catch(e=>this.noteError(e,'outcome-record'));
      phaseTimings.signal_archive_ms=Math.max(0,this.clock()-signalArchiveStartedAt);
      const notificationStartedAt=this.clock();
      let alertsThisCycle=0;
      for(const candidate of ok){
        const alert=buildEarlyExpansionAlert(candidate,now),eligibleAlert=alertEligible(candidate,this.config)&&candidate.micro_fingerprint?.eligible===true;
        const previousScore=this.lastAlertScore.get(candidate.symbol)||null,bandChanged=this.lastBand.get(candidate.symbol)!==candidate.decision_band;
        if(eligibleAlert&&(bandChanged||previousScore==null||candidate.early_expansion_score-previousScore>=this.config.minRealertScoreDelta)){
          const last=this.lastAlertAt.get(candidate.symbol),local=localAlertCooldown(last,now,this.config.alertCooldownMs);
          if(local.allowed){
            alert.coverage=candidate.coverage;alert.micro_fingerprint=candidate.micro_fingerprint;
            const ng=evaluateRadarNotificationGate(alert,{now});alert.notification_gate=ng;
            if(ng.eligible){
              this.lastAlertAt.set(candidate.symbol,now);this.lastAlertScore.set(candidate.symbol,candidate.early_expansion_score);this.lastBand.set(candidate.symbol,candidate.decision_band);
              await this.store.appendEarlyExpansionAlert(alert);
              if(typeof this.store.appendEarlyExpansionEvent==='function')await this.store.appendEarlyExpansionEvent({...alert,event_type:'EARLY_EXPANSION_ALERT_TRACE'});
              if(this.pushManager?.notifyRadarAlert)await this.pushManager.notifyRadarAlert(alert);
              rememberRadarAlert(alert,now);this.alertCount++;alertsThisCycle++;
            }
          }
        }
        if(!this.lastBand.has(candidate.symbol)||bandChanged)this.lastBand.set(candidate.symbol,candidate.decision_band);
      }
      phaseTimings.notification_ms=Math.max(0,this.clock()-notificationStartedAt);
      this.scans++;this.lastScanAtMs=now;this.lastError=null;
      this.lastResult={schema_version:'RADAR8_V2',radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8 — البرق',as_of:new Date(now).toISOString(),quote:q,universe:coverage,candidates:this.latestCandidates,alerts_emitted_this_cycle:alertsThisCycle,meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',source:sourceList([tickerSource]),closed_candles_only:true,fast_scan:'ALL_ELIGIBLE_TICKERS_EVERY_CYCLE',micro_scan:'ROTATING_1M_5M_ACROSS_ELIGIBLE_UNIVERSE',deep_scan:'TOP_MICRO_FINGERPRINT_PLUS_QUIET_PLUS_ROTATION',universe_scope:'ALL_ELIGIBLE_SPOT_USDT'}};
      const scanCompletedAt=this.clock(),scanDurationMs=Math.max(0,scanCompletedAt-scanStartedAt);
      const explicitlyTimedMs=Object.values(phaseTimings).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0);
      phaseTimings.other_ms=Math.max(0,scanDurationMs-explicitlyTimedMs);
      coverage.scan_started_at=new Date(scanStartedAt).toISOString();
      coverage.scan_completed_at=new Date(scanCompletedAt).toISOString();
      coverage.scan_duration_ms=scanDurationMs;
      coverage.configured_poll_ms=Math.max(0,Number(this.config.pollMs)||0);
      coverage.scan_overrun_ms=Math.max(0,scanDurationMs-coverage.configured_poll_ms);
      coverage.phase_timings_ms={...phaseTimings};
      this.lastCoverage=coverage;
      this.logger.info?.('[RADARX_SCAN_COMPLETE] '+JSON.stringify({
        radar:'RADAR_8',build_version:'Build 224',quote:q,rotation_cycle:coverage.rotation_cycle,
        scan_started_at:coverage.scan_started_at,scan_completed_at:coverage.scan_completed_at,
        scan_duration_ms:coverage.scan_duration_ms,configured_poll_ms:coverage.configured_poll_ms,
        scan_overrun_ms:coverage.scan_overrun_ms,phase_timings_ms:coverage.phase_timings_ms,
        expected_total:coverage.expected_total,received_total:coverage.received_total,
        missing_ticker_total:coverage.missing_ticker_total,eligible_total:coverage.eligible_total,
        fast_scanned_total:coverage.fast_scanned_total,micro_scanned_total:coverage.micro_scanned_total,
        deep_scanned_total:coverage.deep_scanned_total,failed_total:coverage.failed_total,
        coverage_ratio:coverage.coverage_ratio,deep_coverage_ratio:coverage.deep_coverage_ratio,
        paper_trading:true,real_order_execution:false
      }));
      return true;
    }catch(e){
      this.lastError=String(e?.message??e);this.lastScanAtMs=scanStartedAt;
      this.lastResult={...emptyEarlyExpansionSnapshot(this.config,quote,this.lastError),schema_version:'RADAR8_V2',as_of:new Date(scanStartedAt).toISOString()};
      return false;
    }finally{this.busy=false;}
  }
  snapshot(limit=100,quote=this.config.quote){
    const q=this.normalizeQuote(quote);
    const base=this.lastResult||emptyEarlyExpansionSnapshot(this.config,q);
    return {
      ...base,
      schema_version:'RADAR8_V2',
      quote:q,
      universe:{...emptyEarlyExpansionUniverse(this.config,q),...(base.universe||{}),quote:q},
      candidates:(this.latestCandidates||base.candidates||[]).slice(0,Math.max(1,Math.min(100,Number(limit)||100)))
    };
  }
  health(){
    return {
      running:this.running,busy:this.busy,radar:'EARLY_EXPANSION_RADAR',radar_name:'Radar 8 — البرق',
      universe_total:this.universe.length,universe_refreshed_at:this.universeAt||null,
      last_scan_at:this.lastScanAtMs,scans:this.scans,alerts_emitted:this.alertCount,last_error:this.lastError,
      fast_scanned_total:this.fastScannedTotal,failed_total:this.failedTotal,failed_symbols:this.failedSymbols,micro_scanned_total:Number(this.lastCoverage?.micro_scanned_total||0),micro_scan_candidates:Number(this.lastCoverage?.micro_scan_candidates||0),rotation_cycle:Number(this.lastCoverage?.rotation_cycle||0),
      coverage:this.lastCoverage,
      poll_ms:this.config.pollMs,micro_scan_candidates:this.config.microScanCandidates,micro_concurrency:this.config.microConcurrency,rotation_reserve:this.config.rotationReserve,quiet_reserve:this.config.quietReserve,deep_candidates:this.config.deepCandidates,deep_concurrency:this.config.deepConcurrency,
      closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
      algorithms:['ALL eligible Spot USDT ticker fast scan','Rotating 1m/5m micro-fingerprint','Price acceleration','Volume/RVOL acceleration','Trade-count acceleration','ATR/Bollinger compression-release','VWAP/EMA','ADX/MACD/RSI/OBV','Higher lows','Resistance pressure','BTC relative strength','Taker-flow divergence','Absorption/reversal fingerprint','Bid/ask imbalance','Spread/depth quality'],
      source:'Binance Public REST with endpoint rotation/fallback',
      universe_scope:'ALL_ELIGIBLE_SPOT_USDT',
      eligibility_filter:{min_quote_volume_24h:this.config.minQuoteVolume24h},
      historical_orderbook:'UNAVAILABLE',version:'RADAR8_V2_MISSED_MOVER_ENGINE',alert_policy:'MICRO_FINGERPRINT + DEEP_CONFIRMATION + ANTI_CHASE'
    };
  }
}
