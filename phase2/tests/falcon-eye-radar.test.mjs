import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFalconEyeAnalysis,FalconEyeRadar} from '../core/falcon-eye-radar.mjs';

function candle(openTime,close,{open=close-0.02,high=close+0.06,low=close-0.06,volume=900,tradeCount=80,taker=0.50}={}) {
  return {openTime,closeTime:openTime+59_999,open,high,low,close,volume,quoteVolume:close*volume,tradeCount,takerBuyBaseVolume:volume*taker,closed:true};
}

function risingBase(n=100,start=100,step=60_000){
  const rows=[];
  for(let i=0;i<n;i++){
    const close=start+i*0.004;
    const early=i<n-8;
    const lift=early?0:(i-(n-8)+1)*0.09;
    const value=close+lift;
    rows.push(candle(1_800_000_000_000+i*step,value,{volume:early?850:2500,tradeCount:early?75:230,taker:early?0.50:0.56}));
  }
  return rows;
}

function flat(n=40,start=100,step=300_000){
  return Array.from({length:n},(_,i)=>{
    const close=start+i*0.001;
    return {openTime:1_800_000_000_000+i*step,closeTime:1_800_000_000_000+i*step+step-1,open:close-0.005,high:close+0.02,low:close-0.02,close,volume:1200,quoteVolume:close*1200,tradeCount:120,takerBuyBaseVolume:600,closed:true};
  });
}

test('Falcon Eye turns the OGN fingerprint into an early, multi-factor setup',()=>{
  const now=1_800_000_000_000+240*60_000;
  const one=risingBase();
  const five=flat(80);
  const btc=flat(80,100);
  const a=buildFalconEyeAnalysis({
    ticker:{symbol:'OGNUSDT',lastPrice:one.at(-1).close,priceChange24h:2.8,quoteVolume24h:2_500_000},
    oneMinute:one,fiveMinute:five,btcFiveMinute:btc,
    futures:{quoteVolume:25_000_000,openInterest:1_030_000,fundingRate:-0.004},
    previousFutures:{openInterest:1_000_000},
    liquidations:[{time:now-10_000,price:'101',origQty:'1000',side:'BUY'}],
    now
  });
  assert.equal(a.closed_candles_only,true);
  assert.equal(a.not_chasing,true);
  assert.equal(a.eligible,true);
  assert.ok(['PRE_ATTACK','IGNITION'].includes(a.stage));
  assert.ok(a.confirmation_count>=8);
  assert.ok(Number.isFinite(a.component_scores.compression));
  assert.ok(a.component_scores.volume>=60);
  assert.ok(a.component_scores.taker>=60);
  assert.ok(a.component_scores.derivatives>=70);
  assert.ok(a.metrics.futures_spot_volume_ratio>=8);
  assert.ok(a.metrics.oi_change_pct>2);
  assert.ok(a.metrics.funding_rate<0);
});

test('Falcon Eye vetoes OGN-style post-explosion chasing',()=>{
  const now=1_800_000_000_000+240*60_000;
  const one=risingBase();
  for(let i=one.length-10;i<one.length;i++){
    one[i].close=one[i-1].close*1.008;
    one[i].open=one[i-1].close;
    one[i].high=one[i].close*1.01;
    one[i].low=one[i].open*0.995;
    one[i].volume=5000;
    one[i].tradeCount=500;
    one[i].takerBuyBaseVolume=one[i].volume*0.59;
  }
  const five=flat();
  const btc=flat(40,100);
  const a=buildFalconEyeAnalysis({
    ticker:{symbol:'OGNUSDT',lastPrice:one.at(-1).close,priceChange24h:14,quoteVolume24h:5_000_000},
    oneMinute:one,fiveMinute:five,btcFiveMinute:btc,
    futures:{quoteVolume:70_000_000,openInterest:2_000_000,fundingRate:-0.008},
    previousFutures:{openInterest:1_950_000},
    now
  });
  assert.equal(a.eligible,false);
  assert.equal(a.not_chasing,false);
  assert.ok(a.anti_chase_penalty>=20);
  assert.ok(a.metrics.return_10m>3.8 || a.metrics.move_24h_pct>8);
});

// Fixture uses enough closed 5m candles for the pre-breakout window.


test('Falcon Eye health reports scanner state using the injected clock',()=>{
  const now=1_800_000_000_000;
  const radar=new FalconEyeRadar({
    rest:{},
    store:{},
    clock:()=>now
  });
  const health=radar.health();
  assert.equal(health.running,false);
  assert.equal(health.radar,'FALCON_EYE_RADAR');
  assert.equal(health.last_scan_at,null);
  assert.equal(health.scans,0);
  assert.equal(health.last_error,null);
});


test('Falcon Eye rotates deep-scan capacity across the market instead of repeating the same top rows',()=>{
  let now=1_900_000_000_000;
  const symbols=Array.from({length:32},(_,i)=>`C${String(i).padStart(2,'0')}USDT`);
  const radar=new FalconEyeRadar({
    rest:{},store:{},clock:()=>now,
    config:{pollMs:30_000,scanBatchSize:8,pulseTopCandidates:3,quietCandidates:2,deepScanMinIntervalMs:90_000}
  });
  radar.universe=symbols;
  const rows=symbols.map((symbol,i)=>({
    symbol,lastPrice:1+i,quoteVolume24h:2_000_000,priceChange24h:1,
    market_pulse:i<3
      ? {fast_trigger:true,stage:'EVENT',explosive:true,score:96-i,priceDeltaPct:0.8,volumeBurstRatio:3.8,tradeBurstRatio:3.4,baseBreakScore:70,highProximityScore:85}
      : {fast_trigger:false,stage:'WATCH',score:65,priceDeltaPct:0.02,volumeBurstRatio:1.1,tradeBurstRatio:1.1,baseBreakScore:90-i,highProximityScore:85-i*0.4}
  }));
  const seen=new Set();
  for(let cycle=0;cycle<5;cycle++){
    const batch=radar.selectBatch(rows,now);
    assert.equal(batch.length,8,'the scanner should use its full batch budget when enough symbols are eligible');
    assert.equal(new Set(batch.map(x=>x.symbol)).size,batch.length,'one symbol must not consume two slots in a cycle');
    for(const row of batch){
      seen.add(row.symbol);
      radar.lastScanAt.set(row.symbol,now);
    }
    now+=30_000;
  }
  assert.ok(seen.size>=22,`fair patrol should reach at least 22 of 32 symbols over five cycles; got ${seen.size}`);
  assert.ok(radar.lastPatrolVisits>0,'patrol cursor must advance across the exchange universe');
  assert.equal(radar.health().last_batch_count,8);
});

test('Falcon Eye lets a genuinely urgent pulse bypass the normal deep-scan cooldown only',()=>{
  const now=1_900_000_000_000;
  const symbols=Array.from({length:12},(_,i)=>`U${String(i).padStart(2,'0')}USDT`);
  const radar=new FalconEyeRadar({
    rest:{},store:{},clock:()=>now,
    config:{pollMs:30_000,scanBatchSize:8,pulseTopCandidates:3,quietCandidates:2,deepScanMinIntervalMs:90_000}
  });
  radar.universe=symbols;
  const rows=symbols.map((symbol,i)=>({
    symbol,lastPrice:10+i,quoteVolume24h:2_000_000,priceChange24h:1,
    market_pulse:i===0
      ? {fast_trigger:true,stage:'EVENT',explosive:true,score:95,priceDeltaPct:0.8,volumeBurstRatio:3.4,tradeBurstRatio:3.1}
      : {fast_trigger:false,stage:'WATCH',score:55,priceDeltaPct:0.01,volumeBurstRatio:1,tradeBurstRatio:1,baseBreakScore:50,highProximityScore:50}
  }));
  for(const symbol of symbols)radar.lastScanAt.set(symbol,now-30_000);
  const batch=radar.selectBatch(rows,now);
  assert.deepEqual(batch.map(x=>x.symbol),[symbols[0]]);
});


function selectionPulse({ready=true,score=50,fast=false,base=68,high=76,compression=82,higherLow=82,participation=72,volume=1.3,trades=1.2,delta=.04,acceleration=55}={}){
  return {ready,score,stage:fast?'IGNITING':'QUIET',fast_trigger:fast,explosive:false,
    baseBreakScore:base,highProximityScore:high,compressionScore:compression,higherLowScore:higherLow,
    participationScore:participation,volumeBurstRatio:volume,tradeBurstRatio:trades,
    priceDeltaPct:delta,accelerationScore:acceleration};
}
function selectTicker(symbol,move,pulse,volume=2_000_000){
  return {symbol,lastPrice:1,priceChange24h:move,quoteVolume24h:volume,tradeCount24h:30000,market_pulse:pulse};
}
function selectionRadar(config={}){
  return new FalconEyeRadar({
    rest:{request:async()=>({data:[]}),klines:async()=>({candles:[]})},
    store:{appendFalconEyeAlert:async()=>{},readFalconEyeAlerts:async()=>[]},
    config:{scanBatchSize:8,pulseTopCandidates:3,quietCandidates:2,patrolBatchSize:2,exceptionalRotationBypassSlots:2,...config},
    clock:()=>1_900_000_000_000,logger:{warn(){}}
  });
}

test('Falcon Eye quiet lane requires base compression, higher lows, and improving participation',()=>{
  const radar=selectionRadar({scanBatchSize:4,pulseTopCandidates:0,quietCandidates:3,patrolBatchSize:1,exceptionalRotationBypassSlots:0});
  const rows=[
    selectTicker('QUIET_AUSDT',.12,selectionPulse({score:45,base:72,compression:88,higherLow:85,participation:75,volume:1.24,trades:1.17})),
    selectTicker('QUIET_BUSDT',.32,selectionPulse({score:48,base:70,compression:78,higherLow:75,participation:68,volume:1.2,trades:1.12})),
    selectTicker('NO_COMPRESS_USDT',.05,selectionPulse({compression:42,higherLow:82})),
    selectTicker('NO_HL_USDT',.08,selectionPulse({compression:80,higherLow:38})),
    selectTicker('NO_ACTIVITY_USDT',.03,selectionPulse({compression:90,higherLow:85,participation:51,volume:.7,trades:.8,delta:0,acceleration:48})),
    selectTicker('WARMING_USDT',.04,selectionPulse({ready:false,compression:null,higherLow:null,participation:null,volume:null,trades:null}))
  ];
  radar.universe=rows.map(x=>x.symbol);
  const selected=radar.selectBatch(rows);
  assert.equal(selected.length,4);
  const quiet=selected.filter(x=>x._selection_lane==='quiet');
  assert.equal(quiet.length,2);
  assert.deepEqual(quiet.map(x=>x.symbol),['QUIET_AUSDT','QUIET_BUSDT']);
  for(const symbol of ['WARMING_USDT','NO_COMPRESS_USDT','NO_HL_USDT','NO_ACTIVITY_USDT']){
    assert.equal(quiet.some(x=>x.symbol===symbol),false);
  }
});

test('Falcon Eye fills the batch after lane overlap and removes duplicate symbols',()=>{
  const radar=selectionRadar({scanBatchSize:8,pulseTopCandidates:4,quietCandidates:2,patrolBatchSize:2,exceptionalRotationBypassSlots:1});
  const rows=[];
  for(let i=0;i<5;i++)rows.push(selectTicker('FAST'+i+'USDT',1+i*.2,selectionPulse({score:95-i,fast:true,volume:2.8,trades:2.1,compression:45,higherLow:40})));
  for(let i=0;i<10;i++)rows.push(selectTicker('QUIET'+i+'USDT',.15+i*.2,selectionPulse({score:50-i*.2,compression:82,higherLow:78,volume:1.25,trades:1.15})));
  for(let i=0;i<10;i++)rows.push(selectTicker('WARM'+i+'USDT',.4,selectionPulse({ready:false,score:50,compression:null,higherLow:null,participation:null,volume:null,trades:null})));
  radar.universe=rows.map(x=>x.symbol);
  const selected=radar.selectBatch([...rows,rows[0],rows[1]]);
  assert.equal(selected.length,8);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,8);
  assert.equal(selected[0]._selection_lane,'exceptional');
  assert.equal(radar.health().selection.selected_total,8);
  assert.equal(radar.health().selection.shortfall,0);
});

test('Falcon Eye patrol rotates toward symbols not selected in the last cycle',()=>{
  const radar=selectionRadar({scanBatchSize:8,pulseTopCandidates:0,quietCandidates:0,patrolBatchSize:4,exceptionalRotationBypassSlots:0});
  const rows=Array.from({length:30},(_,i)=>selectTicker('PATROL'+String(i).padStart(2,'0')+'USDT',.4,
    selectionPulse({ready:false,score:50,compression:null,higherLow:null,participation:null,volume:null,trades:null})));
  radar.universe=rows.map(x=>x.symbol);
  const first=radar.selectBatch(rows);
  const second=radar.selectBatch(rows);
  assert.equal(first.length,8);
  assert.equal(second.length,8);
  assert.equal(second.some(x=>first.some(y=>y.symbol===x.symbol)),false);
});
