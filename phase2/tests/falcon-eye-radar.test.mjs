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
  const now=1_800_000_000_000+100*60_000;
  const one=risingBase();
  const five=flat();
  const btc=flat(40,100);
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
  assert.ok(a.component_scores.compression>=50);
  assert.ok(a.component_scores.volume>=60);
  assert.ok(a.component_scores.taker>=60);
  assert.ok(a.component_scores.derivatives>=70);
  assert.ok(a.metrics.futures_spot_volume_ratio>=8);
  assert.ok(a.metrics.oi_change_pct>2);
  assert.ok(a.metrics.funding_rate<0);
});

test('Falcon Eye vetoes OGN-style post-explosion chasing',()=>{
  const now=1_800_000_000_000+100*60_000;
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


function selectionPulse({ready=true,move=.5,score=50,fast=false,base=68,high=76,compression=82,higherLow=82,participation=72,volume=1.3,trades=1.2}={}){
  return {
    ready,score,stage:fast?'IGNITING':'QUIET',fast_trigger:fast,explosive:false,
    baseBreakScore:base,highProximityScore:high,compressionScore:compression,
    higherLowScore:higherLow,participationScore:participation,
    volumeBurstRatio:volume,tradeBurstRatio:trades,accelerationScore:57
  };
}
function selectTicker(symbol,move,pulse,volume=2_000_000){
  return {symbol,lastPrice:1,priceChange24h:move,quoteVolume24h:volume,tradeCount24h:30000,market_pulse:pulse};
}
function selectionRadar(config={}){
  return new FalconEyeRadar({
    rest:{request:async()=>({data:[]}),klines:async()=>({candles:[]})},
    store:{},
    config:{scanBatchSize:8,pulseTopCandidates:4,quietCandidates:2,patrolBatchSize:2,exceptionalRotationBypassSlots:2,...config},
    clock:()=>1_900_000_000_000,
    logger:{warn(){}}
  });
}

test('Falcon Eye quiet quota requires ready daily data, compression, higher lows, and improving participation',()=>{
  const radar=selectionRadar({scanBatchSize:4,pulseTopCandidates:0,quietCandidates:3,patrolBatchSize:1,exceptionalRotationBypassSlots:0});
  const rows=[
    selectTicker('QUIET_AUSDT',.12,selectionPulse({move:.12,score:45,base:72,compression:88,higherLow:85,participation:75,volume:1.24,trades:1.17})),
    selectTicker('QUIET_BUSDT',.32,selectionPulse({move:.32,score:48,base:70,compression:78,higherLow:75,participation:68,volume:1.2,trades:1.12})),
    selectTicker('NO_COMPRESS_USDT',.05,selectionPulse({move:.05,compression:42,higherLow:82})),
    selectTicker('NO_HL_USDT',.08,selectionPulse({move:.08,compression:80,higherLow:38})),
    selectTicker('NO_ACTIVITY_USDT',.03,selectionPulse({move:.03,compression:90,higherLow:85,participation:51,volume:.7,trades:.8})),
    selectTicker('WARMING_USDT',.04,selectionPulse({ready:false,move:.04,compression:90,higherLow:90,participation:90,volume:1.4,trades:1.3}))
  ];
  const selected=radar.selectBatch(rows);
  assert.equal(selected.length,4);
  const quiet=selected.filter(x=>x._selection_lane==='quiet');
  assert.equal(quiet.length,2);
  assert.deepEqual(quiet.map(x=>x.symbol),['QUIET_AUSDT','QUIET_BUSDT']);
  assert.equal(selected.some(x=>x.symbol==='WARMING_USDT'&&x._selection_lane==='quiet'),false);
  assert.equal(selected.some(x=>x.symbol==='NO_COMPRESS_USDT'&&x._selection_lane==='quiet'),false);
  assert.equal(selected.some(x=>x.symbol==='NO_HL_USDT'&&x._selection_lane==='quiet'),false);
  assert.equal(selected.some(x=>x.symbol==='NO_ACTIVITY_USDT'&&x._selection_lane==='quiet'),false);
});

test('Falcon Eye fills the scan batch after cross-lane overlap and duplicate ticker rows',()=>{
  const radar=selectionRadar({scanBatchSize:8,pulseTopCandidates:4,quietCandidates:2,patrolBatchSize:2,exceptionalRotationBypassSlots:1});
  const rows=[];
  for(let i=0;i<5;i++)rows.push(selectTicker('FAST'+i+'USDT',1+i*.2,selectionPulse({score:95-i,fast:true,volume:2.8, trades:2.1,compression:45,higherLow:40})));
  for(let i=0;i<10;i++)rows.push(selectTicker('QUIET'+i+'USDT',.15+i*.2,selectionPulse({score:50-i*.2,fast:false,compression:82,higherLow:78,volume:1.25,trades:1.15})));
  for(let i=0;i<10;i++)rows.push(selectTicker('WARM'+i+'USDT',.4,selectionPulse({ready:false,score:50,fast:false,compression:null,higherLow:null,participation:null,volume:null,trades:null})));
  radar.universe=rows.map(x=>x.symbol);
  const selected=radar.selectBatch([...rows,rows[0],rows[1]]);
  assert.equal(selected.length,8);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,8);
  assert.equal(selected[0]._selection_lane,'exceptional');
  assert.equal(radar.health().selection.selected_total,8);
  assert.equal(radar.health().selection.shortfall,0);
});

test('Falcon Eye patrol prioritizes symbols not selected or deeply scanned in the previous cycle',()=>{
  const radar=selectionRadar({scanBatchSize:8,pulseTopCandidates:0,quietCandidates:0,patrolBatchSize:4,exceptionalRotationBypassSlots:0});
  const rows=Array.from({length:30},(_,i)=>selectTicker(
    'PATROL'+String(i).padStart(2,'0')+'USDT',.4,selectionPulse({ready:false,score:50,compression:null,higherLow:null,participation:null,volume:null,trades:null})
  ));
  radar.universe=rows.map(x=>x.symbol);
  const first=radar.selectBatch(rows);
  const second=radar.selectBatch(rows);
  assert.equal(first.length,8);
  assert.equal(second.length,8);
  assert.equal(second.some(x=>first.some(y=>y.symbol===x.symbol)),false);
  assert.ok(second.slice(0,4).every(x=>x._selection_lane==='patrol'));
});
