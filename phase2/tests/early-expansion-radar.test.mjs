import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEarlyExpansionEvidence,
  buildEarlyExpansionAlert,
  EarlyExpansionRadar,
  emptyEarlyExpansionSnapshot,
  buildEarlyExpansionUniverseCoverage,
  decideEarlyExpansionBand,
  boundedMap
} from '../core/early-expansion-radar.mjs';
import {evaluateRadarNotificationGate,rememberRadarAlert,resetRadarNotificationGateForTests} from '../core/radar-notification-gate.mjs';

function candle(ts,price,tfMs,volume=1000){
  return {openTime:ts,closeTime:ts+tfMs-1,open:price-.1,high:price+.25,low:price-.25,close:price,volume,quoteVolume:price*volume,tradeCount:100,takerBuyBaseVolume:volume*.53,takerBuyQuoteVolume:price*volume*.53,closed:true,source:'TEST',sourceTime:ts+tfMs-1};
}
function series(tf,prices,start){
  const step=tf==='1m'?60000:tf==='5m'?300000:tf==='15m'?900000:tf==='1h'?3600000:14400000;
  return prices.map((p,i)=>candle(start+i*step,p,step,1000+i*20));
}
function strongSeries(tf,count,start){
  const step=tf==='1m'?60000:tf==='5m'?300000:tf==='15m'?900000:tf==='1h'?3600000:14400000;
  return Array.from({length:count},(_,i)=>{
    const base=100+i*.05+(i>count-10?(i-count+10)*.35:0);
    return candle(start+i*step,base,step,1200+i*25);
  });
}
const now=Date.now();
function fixture(){
  return {
    series:{
      '1m':strongSeries('1m',180,now-180*60000),
      '5m':strongSeries('5m',180,now-180*300000),
      '15m':strongSeries('15m',160,now-160*900000),
      '1h':strongSeries('1h',260,now-260*3600000),
      '4h':strongSeries('4h',220,now-220*14400000)
    },
    ticker:{symbol:'TESTUSDT',lastPrice:130,priceChange24h:2,quoteVolume24h:5000000,tradeCount24h:30000},
    marketContext:{fiveMinute:strongSeries('5m',80,now-80*300000),oneHour:strongSeries('1h',60,now-60*3600000)}
  };
}
const book={bids:Array.from({length:10},(_,i)=>[String(129.9-i*.01),'1000']),asks:Array.from({length:10},(_,i)=>[String(130.1+i*.01),'700'])};

test('Radar8 returns a structured pre-expansion contract with paper-only policy',()=>{
  const f=fixture();
  const x=buildEarlyExpansionEvidence({...f,depth:book,fastContext:{price_change_pct:.35,price_acceleration_pct:.12,volume_accel_ratio:1.8,trade_accel_ratio:1.6},now});
  assert.equal(x.closed_candles_only,true);
  assert.equal(x.paper_trading,true);
  assert.equal(x.real_order_execution,false);
  assert.equal(x.confidence_score,'UNKNOWN');
  assert.ok(Object.hasOwn(x,'score_components'));
  assert.ok(Object.hasOwn(x,'trigger_evidence'));
  assert.ok(Object.hasOwn(x,'invalidation'));
});

test('Historical replay never fabricates order-book history and keeps live score null',()=>{
  const f=fixture();
  const x=buildEarlyExpansionEvidence({...f,depth:null,historicalReplay:true,now});
  assert.equal(x.early_expansion_score,null);
  assert.equal(x.liquidity_quality,null);
  assert.match(x.reason_codes.join('|'),/HISTORICAL_ORDERBOOK_UNAVAILABLE/);
  assert.equal(x.decision_band,'NO_SIGNAL');
});

test('Future or stale data disables live score',()=>{
  const f=fixture();
  f.series['1m']=f.series['1m'].map((c,i)=>i===f.series['1m'].length-1?{...c,closeTime:now+600000}:c);
  const x=buildEarlyExpansionEvidence({...f,depth:book,now});
  assert.equal(x.early_expansion_score,null);
  assert.equal(x.decision_band,'DATA_INSUFFICIENT');
  assert.ok(x.reason_codes.some(x=>String(x).includes('FUTURE')));
});

test('Wide spread cannot receive an early score',()=>{
  const f=fixture();
  const wide={...book,bids:[['128','1000']],asks:[['132','1000']]};
  const x=buildEarlyExpansionEvidence({...f,depth:wide,now,config:{maxSpreadBps:20,minLiquidityQuality:60}});
  assert.equal(x.early_expansion_score,null);
  assert.equal(x.decision_band,'DATA_INSUFFICIENT');
});

test('Alert is Radar 8 and carries all required read-only fields',()=>{
  const f=fixture();
  const candidate={symbol:'TESTUSDT',last_price:100,price_change_24h:1,early_expansion_score:86,decision_band:'PRE_EXPANSION',data_quality:100,liquidity_quality:88,data_stale:false,risk_flags:[],reason_codes:['RVOL_5M_ACCELERATION'],metrics:{rvol_1m:1.7,rvol_5m:1.8},trigger_evidence:{fast_scan:{volume_accel_ratio:1.8}},coverage:{universe_total:700,eligible_total:600,scanned_total:600,skipped_total:0,failed_total:0,coverage_ratio:1}};
  const a=buildEarlyExpansionAlert(candidate,now);
  assert.equal(a.radar_name,'Radar 8 — البرق');
  assert.equal(a.early_expansion_score,86);
  assert.equal(a.confidence_score,'UNKNOWN');
  assert.equal(a.paper_trading,true);
  assert.equal(a.real_order_execution,false);
});

test('Radar8 fast state can produce a candidate without 24h ranking chase',async()=>{
  const calls=[];
  const rest={
    request:async(path)=>{calls.push(path);if(path==='/api/v3/exchangeInfo')return{data:{symbols:[{symbol:'AAUSDT',baseAsset:'AA',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},{symbol:'BBUSDT',baseAsset:'BB',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']} ]},source:'TEST'};if(path==='/api/v3/ticker/24hr')return{data:[{symbol:'AAUSDT',lastPrice:'1',quoteVolume:'5000000',count:50000,priceChangePercent:'1'},{symbol:'BBUSDT',lastPrice:'2',quoteVolume:'5000000',count:50000,priceChangePercent:'1'}],source:'TEST'};throw new Error('UNEXPECTED_REQUEST:'+path)},
    klines:async(symbol,tf)=>({source:'TEST',receivedAt:Date.now(),candles:strongSeries(tf,tf==='1m'?180:tf==='5m'?180:tf==='15m'?160:tf==='1h'?260:220,now-(tf==='1m'?180:tf==='5m'?180:tf==='15m'?160:tf==='1h'?260:220)*(tf==='1m'?60000:tf==='5m'?300000:tf==='15m'?900000:tf==='1h'?3600000:14400000))}),
    depth:async()=>({source:'TEST',data:book})
  };
  const store={appendEarlyExpansionAlert:async()=>{},appendEarlyExpansionEvent:async()=>{}};
  const scanner=new EarlyExpansionRadar({rest,store,config:{minQuoteVolume24h:1000000,deepCandidates:1,deepConcurrency:1}});
  scanner.running=true;await scanner.refreshUniverse();
  const ok=await scanner.tick();
  assert.equal(ok,true);
  assert.equal(scanner.health().fast_scanned_total,2);
});


test('Radar8 decision bands are all explicit and exclusive',()=>{
  const base={gateValid:true,cfg:{breakoutDevelopingScore:82,preExpansionScore:72,watchEarlyScore:60}};
  assert.equal(decideEarlyExpansionBand({...base,earlyScore:59}),'NO_SIGNAL');
  assert.equal(decideEarlyExpansionBand({...base,earlyScore:60}),'WATCH_EARLY');
  assert.equal(decideEarlyExpansionBand({...base,earlyScore:72}),'PRE_EXPANSION');
  assert.equal(decideEarlyExpansionBand({...base,earlyScore:82,breakoutBroken:true}),'BREAKOUT_DEVELOPING');
  assert.equal(decideEarlyExpansionBand({...base,extended:true,earlyScore:90}),'ALREADY_EXTENDED');
  assert.equal(decideEarlyExpansionBand({...base,gateValid:false,earlyScore:90}),'DATA_INSUFFICIENT');
  assert.equal(decideEarlyExpansionBand({...base,highRiskPump:true,earlyScore:95}),'HIGH_RISK_PUMP');
});

test('Stale, gap, and duplicate timestamps are fail-closed',()=>{
  const f=fixture();
  f.series['1m']=f.series['1m'].map((x,i)=>i===f.series['1m'].length-1?{...x,closeTime:now-10*60*1000}:x);
  const stale=buildEarlyExpansionEvidence({...f,depth:book,now});
  assert.equal(stale.early_expansion_score,null);
  assert.equal(stale.decision_band,'DATA_INSUFFICIENT');
  assert.ok(stale.reason_codes.some(x=>String(x).startsWith('STALE_DATA:1m')));

  const g=fixture();
  g.series['5m']=g.series['5m'].filter((_,i)=>i!==g.series['5m'].length-10);
  const gap=buildEarlyExpansionEvidence({...g,depth:book,now});
  assert.equal(gap.early_expansion_score,null);
  assert.equal(gap.decision_band,'DATA_INSUFFICIENT');
  assert.ok(gap.reason_codes.some(x=>String(x).includes('GAP')));

  const d=fixture();
  d.series['5m'].push({...d.series['5m'].at(-1)});
  const dup=buildEarlyExpansionEvidence({...d,depth:book,now});
  assert.equal(dup.early_expansion_score,null);
  assert.equal(dup.decision_band,'DATA_INSUFFICIENT');
  assert.ok(dup.reason_codes.some(x=>String(x).includes('UNORDERED')));
});

test('Coverage mismatch is explicit and never reports full coverage',()=>{
  const x=buildEarlyExpansionUniverseCoverage({
    expectedSymbols:['AAUSDT','BBUSDT','CCUSDT'],
    receivedSymbols:['AAUSDT','BBUSDT'],
    eligibleTotal:2,fastScannedTotal:2,scannedTotal:2,deepScannedTotal:1,
    skippedTotal:1,failedTotal:1,failedSymbols:['BBUSDT'],quote:'USDT',minQuoteVolume24h:750000
  });
  assert.equal(x.expected_total,3);
  assert.equal(x.received_total,2);
  assert.equal(x.missing_ticker_total,1);
  assert.equal(x.failed_total,1);
  assert.equal(x.coverage_ratio,2/3);
  assert.equal(x.scope,'ALL_ELIGIBLE_SPOT_USDT');
  assert.equal(x.eligibility_filter.min_quote_volume_24h,750000);
});

test('Scanner reports missing ticker symbols separately from deep failures',async()=>{
  const rest={
    request:async(path)=>{
      if(path==='/api/v3/exchangeInfo')return{data:{symbols:[
        {symbol:'AAUSDT',baseAsset:'AA',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
        {symbol:'BBUSDT',baseAsset:'BB',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']},
        {symbol:'CCUSDT',baseAsset:'CC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}
      ]},source:'TEST'};
      if(path==='/api/v3/ticker/24hr')return{data:[
        {symbol:'AAUSDT',lastPrice:'1',quoteVolume:'5000000',count:50000,priceChangePercent:'1'},
        {symbol:'BBUSDT',lastPrice:'2',quoteVolume:'5000000',count:50000,priceChangePercent:'1'}
      ],source:'TEST'};
      throw new Error('UNEXPECTED_REQUEST:'+path);
    }
  };
  const store={appendEarlyExpansionAlert:async()=>{},appendEarlyExpansionEvent:async()=>{}};
  const scanner=new EarlyExpansionRadar({rest,store,config:{minQuoteVolume24h:1000000,deepCandidates:2,deepConcurrency:2},clock:()=>now});
  scanner.deepScan=async(row)=>{if(row.symbol==='BBUSDT')throw new Error('TEST_DEEP_FAILURE');return {early_expansion_score:80,decision_band:'PRE_EXPANSION',data_quality:100,liquidity_quality:90,data_stale:false,metrics:{rvol_1m:1.5,rvol_5m:1.5,rvol_15m:1.2,quote_rvol_5m:1.3},volume_metrics:{},liquidity_metrics:{},structure_metrics:{},strategy_evidence:{},trigger_evidence:{},risk_flags:[],reason_codes:[],invalidation:[],estimated_lead_time:'UNKNOWN',source:'TEST',forensic_evidence_score:80,market_regime:{}};};
  resetRadarNotificationGateForTests();
  scanner.running=true;await scanner.refreshUniverse();assert.equal(await scanner.tick(),true);
  const u=scanner.snapshot().universe;
  assert.equal(u.expected_total,3);
  assert.equal(u.received_total,2);
  assert.equal(u.missing_ticker_total,1);
  assert.equal(u.eligible_total,2);
  assert.equal(u.fast_scanned_total,2);
  assert.equal(u.failed_total,1);
  assert.deepEqual(u.failed_symbols,['BBUSDT']);
  assert.equal(u.coverage_ratio,2/3);
});

test('boundedMap never exceeds configured concurrency',async()=>{
  let active=0,maxActive=0;
  const out=await boundedMap(Array.from({length:12},(_,i)=>i),3,async x=>{
    active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,3));active--;return x*2;
  });
  assert.equal(maxActive,3);assert.deepEqual(out,[0,2,4,6,8,10,12,14,16,18,20,22]);
});

test('HIGH_RISK_PUMP is directional and does not classify a dump as a pump',()=>{
  const f=fixture();
  const pumpTicker={...f.ticker,priceChange24h:20};
  const pump=buildEarlyExpansionEvidence({...f,ticker:pumpTicker,depth:book,fastContext:{price_change_pct:3,price_acceleration_pct:1,volume_accel_ratio:2,trade_accel_ratio:2},now});
  assert.equal(pump.decision_band,'HIGH_RISK_PUMP');
  assert.ok(pump.risk_flags.includes('HIGH_RISK_PUMP'));

  const dumpTicker={...f.ticker,priceChange24h:-20};
  const dump=buildEarlyExpansionEvidence({...f,ticker:dumpTicker,depth:book,fastContext:{price_change_pct:-3,price_acceleration_pct:-1,volume_accel_ratio:2,trade_accel_ratio:2},now});
  assert.notEqual(dump.decision_band,'HIGH_RISK_PUMP');
  assert.ok(dump.risk_flags.includes('HIGH_RISK_DUMP'));
  assert.ok(!dump.risk_flags.includes('HIGH_RISK_PUMP'));
});

test('Notification gate has a dedicated Radar 8 cooldown profile',()=>{
  resetRadarNotificationGateForTests();
  const a={radar:'EARLY_EXPANSION_RADAR',symbol:'AAAUSDT',opportunity_score:90,data_quality:75,liquidity_quality:65,risk_flags:[]};
  const first=evaluateRadarNotificationGate(a,{now:1000000});
  assert.equal(first.eligible,true);
  rememberRadarAlert(a,1000000);
  const blocked=evaluateRadarNotificationGate(a,{now:1000000+5*60*1000});
  assert.equal(blocked.eligible,false);
  assert.ok(blocked.failures.includes('CROSS_RADAR_COOLDOWN'));
  assert.equal(blocked.cooldown_remaining_ms,5*60*1000);
  const later=evaluateRadarNotificationGate(a,{now:1000000+11*60*1000});
  assert.equal(later.eligible,true);
});

test('Cross-radar cooldown blocks same symbol but not a different symbol',()=>{
  resetRadarNotificationGateForTests();
  const a={radar:'EARLY_EXPANSION_RADAR',symbol:'AAAUSDT',opportunity_score:90,data_quality:75,liquidity_quality:65,risk_flags:[]};
  const other={radar:'KAHIR_RADAR',symbol:'AAAUSDT',opportunity_score:95,data_quality:90,liquidity_quality:80,risk_flags:[],
    analysis:{metrics:{one_minute_z:2},algorithms:{PARTICIPATION_REGIME:{score:80}}}};
  const differentSymbol={...other,symbol:'BBBUSD'};
  assert.equal(evaluateRadarNotificationGate(a,{now:2000000}).eligible,true);
  rememberRadarAlert(a,2000000);
  const blocked=evaluateRadarNotificationGate(other,{now:2000000+2*60*1000});
  assert.equal(blocked.eligible,false);
  assert.ok(blocked.failures.includes('CROSS_RADAR_COOLDOWN'));
  assert.equal(evaluateRadarNotificationGate(differentSymbol,{now:2000000+2*60*1000}).eligible,true);
});

test('Radar 8 local cooldown suppresses a stronger repeat until the cooldown expires',async()=>{
  resetRadarNotificationGateForTests();
  let nowTick=4000000,score=84,alerts=0;
  const rest={
    request:async(path)=>{
      if(path==='/api/v3/exchangeInfo')return{data:{symbols:[{symbol:'AAAUSDT',baseAsset:'AA',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,permissions:['SPOT']}]},source:'TEST'};
      if(path==='/api/v3/ticker/24hr')return{data:[{symbol:'AAAUSDT',lastPrice:'1',quoteVolume:'5000000',count:50000,priceChangePercent:'1'}],source:'TEST'};
      throw new Error('UNEXPECTED_REQUEST:'+path);
    }
  };
  const store={appendEarlyExpansionAlert:async()=>{alerts++;},appendEarlyExpansionEvent:async()=>{}};
  const pushManager={notifyRadarAlert:async()=>{}};
  const scanner=new EarlyExpansionRadar({rest,store,pushManager,config:{minQuoteVolume24h:1000000,deepCandidates:1,deepConcurrency:1,alertCooldownMs:10*60*1000},clock:()=>nowTick});
  scanner.deepScan=async()=>({early_expansion_score:score,decision_band:'PRE_EXPANSION',data_quality:100,liquidity_quality:90,data_stale:false,metrics:{rvol_1m:1.6,rvol_5m:1.5,rvol_15m:1.2,quote_rvol_5m:1.3},volume_metrics:{},liquidity_metrics:{},structure_metrics:{},strategy_evidence:{},trigger_evidence:{},risk_flags:[],reason_codes:[],invalidation:[],estimated_lead_time:'UNKNOWN',source:'TEST',forensic_evidence_score:score,market_regime:{}});
  scanner.running=true;await scanner.refreshUniverse();
  assert.equal(await scanner.tick(),true);
  assert.equal(alerts,1);
  score=90;nowTick+=5*60*1000;
  assert.equal(await scanner.tick(),true);
  assert.equal(alerts,1);
  nowTick+=6*60*1000;
  assert.equal(await scanner.tick(),true);
  assert.equal(alerts,2);
});
