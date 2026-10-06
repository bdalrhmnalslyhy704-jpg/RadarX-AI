import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEarlyExpansionEvidence,buildEarlyExpansionAlert,EarlyExpansionRadar} from '../core/early-expansion-radar.mjs';

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
  assert.match(x.reason_codes.join('|'),'HISTORICAL_ORDERBOOK_UNAVAILABLE');
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
