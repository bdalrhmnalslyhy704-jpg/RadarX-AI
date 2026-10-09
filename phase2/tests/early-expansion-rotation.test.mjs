import test from 'node:test';
import assert from 'node:assert/strict';
import {EarlyExpansionRadar} from '../core/early-expansion-radar.mjs';

const now=1_900_000_000_000;
function makeRadar(config={}){
  return new EarlyExpansionRadar({
    rest:{request:async()=>({data:[]}),klines:async()=>({candles:[]}),depth:async()=>({data:{bids:[],asks:[]}})},
    store:{},
    config:{minQuoteVolume24h:100000,microScanCandidates:36,deepCandidates:10,quietReserve:8,rotationReserve:8,...config},
    clock:()=>now,logger:{warn(){}}
  });
}
function rows(count){
  return Array.from({length:count},(_,i)=>({
    symbol:'SEL'+String(i).padStart(3,'0')+'USDT',
    lastPrice:1+i*.01,
    priceChange24h:(i%8)*.45,
    quoteVolume24h:1_000_000+i*1_000,
    tradeCount24h:20_000+i*100
  }));
}
function fastMap(items,overrides={}){
  return new Map(items.map((row,i)=>[row.symbol,{
    price_change_pct:.08+(i%4)*.02,
    price_acceleration_pct:.01+(i%3)*.01,
    volume_accel_ratio:1.25+(i%3)*.05,
    trade_accel_ratio:1.20+(i%2)*.1,
    ...overrides[row.symbol]
  }]));
}
function candidate(symbol,move,{score=65,participation=75,tradeParticipation=70,structure=78,compression=82,volume=1.5,trades=1.4}={}){
  return {
    row:{symbol,lastPrice:1,priceChange24h:move,quoteVolume24h:1_000_000,tradeCount24h:20_000},
    micro_fingerprint:{
      score,eligible:false,mode:'QUIET_COMPRESSION_BUILD',confirmation_count:4,
      metrics:{
        price_change_24h_abs:Math.abs(move),rvol_1m:volume,rvol_5m:Math.max(1.1,volume-.2),
        trade_rvol_1m:trades,trade_rvol_5m:Math.max(1.1,trades-.1),bb_ratio:.78,
        range_compression_ratio:.82,atr_ratio:.88,higher_low_count:structure,
        resistance_distance_pct:-2,acceleration_1m_pct:.08,acceleration_5m_pct:.12,taker_buy_ratio:.57
      },
      category_scores:{participation,tradeParticipation,structure,compression,momentumTurn:62}
    }
  };
}

test('Radar 8 fills the 36 unique-symbol micro batch across overlapping selector lanes',()=>{
  const radar=makeRadar({microScanCandidates:36,quietReserve:8,rotationReserve:8});
  const input=rows(60);
  const selected=radar.selectMicro([...input,input[0],input[1]],fastMap(input),1);
  assert.equal(selected.length,36);
  assert.equal(new Set(selected.map(x=>x.symbol.toUpperCase())).size,36);
  assert.equal(selected.filter(x=>x._selection_lane==='quiet').length,8);
  assert.equal(selected.filter(x=>x._selection_lane==='rotation').length,8);
});

test('Radar 8 quiet micro lane orders lowest valid daily change when participation is waking',()=>{
  const radar=makeRadar({microScanCandidates:10,quietReserve:5,rotationReserve:2});
  const input=rows(20);
  const overrides={};
  overrides[input[0].symbol]={price_change_pct:.12,price_acceleration_pct:.08,volume_accel_ratio:1.5,trade_accel_ratio:1.3};
  const fast=fastMap(input,overrides);
  const selected=radar.selectMicro(input,fast,1);
  const quiet=selected.filter(x=>x._selection_lane==='quiet');
  assert.equal(quiet.length,5);
  assert.deepEqual(quiet.map(x=>Math.abs(x.priceChange24h)),[0,.45,.9,1.35,1.8]);
});

test('Radar 8 does not classify missing daily change as a quiet candidate',()=>{
  const radar=makeRadar({microScanCandidates:10,quietReserve:4,rotationReserve:2});
  const input=[...rows(12),{symbol:'UNKNOWN24HUSDT',lastPrice:1.2,quoteVolume24h:1_000_000,tradeCount24h:20000}];
  const fast=fastMap(input,{'UNKNOWN24HUSDT':{price_change_pct:.4,price_acceleration_pct:.2,volume_accel_ratio:3.1,trade_accel_ratio:2.4}});
  const selected=radar.selectMicro(input,fast,1);
  assert.equal(selected.length,10);
  assert.equal(selected.some(x=>x.symbol==='UNKNOWN24HUSDT'&&x._selection_lane==='quiet'),false);
});

test('Radar 8 prioritizes symbols not covered in the prior rotation cycle',()=>{
  const radar=makeRadar({microScanCandidates:10,quietReserve:0,rotationReserve:5});
  const input=rows(50),fast=fastMap(input);
  const first=radar.selectMicro(input,fast,1);
  const second=radar.selectMicro(input,fast,2);
  const firstSymbols=new Set(first.map(x=>x.symbol));
  assert.equal(first.length,10);
  assert.equal(second.length,10);
  assert.equal(second.filter(x=>!firstSymbols.has(x.symbol)).length,5);
  assert.equal(second.filter(x=>x._selection_lane==='rotation').length,5);
});

test('Radar 8 exceptional acceleration may bypass rotation without changing batch size',()=>{
  const radar=makeRadar({microScanCandidates:8,quietReserve:2,rotationReserve:3,exceptionalRotationBypassSlots:2});
  const input=rows(40);
  input.push({symbol:'ZZZFASTUSDT',lastPrice:1,priceChange24h:3.5,quoteVolume24h:1_200_000,tradeCount24h:30000});
  const fast=fastMap(input);
  fast.set('ZZZFASTUSDT',{price_change_pct:.85,price_acceleration_pct:.28,volume_accel_ratio:3.8,trade_accel_ratio:2.7});
  const selected=radar.selectMicro(input,fast,1);
  assert.equal(selected.length,8);
  assert.equal(selected[0].symbol,'ZZZFASTUSDT');
  assert.equal(selected[0]._selection_lane,'exceptional');
});

test('Radar 8 deep scan preserves score capacity while selecting quiet bases from smallest move first',()=>{
  const radar=makeRadar({deepCandidates:10,quietReserve:8,rotationReserve:2});
  const candidates=[
    candidate('ZZZQUIETUSDT',.12,{score:54,volume:1.8,trades:1.7}),
    candidate('AAAUSDT',7.4,{score:92,volume:1.2,trades:1.1}),
    candidate('BBBUSDT',4.6,{score:85}),candidate('CCCUSDT',2.2,{score:76}),
    candidate('DDDUSDT',.65,{score:66}),candidate('EEEUSDT',1.1,{score:62}),
    candidate('FFFUSDT',3.4,{score:60}),candidate('GGGUSDT',5.1,{score:59}),
    candidate('HHHUSDT',.85,{score:57}),candidate('IIIUSDT',6.5,{score:55}),
    candidate('JJJUSDT',2.8,{score:53}),candidate('KKKUSDT',1.7,{score:52})
  ];
  const selected=radar.selectDeepFromMicro(candidates,1);
  assert.equal(selected.length,10);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,10);
  const quiet=selected.filter(x=>x._selection_lane==='quiet');
  assert.equal(quiet.length,5);
  assert.equal(quiet[0].row.symbol,'ZZZQUIETUSDT');
});

test('Radar 8 deep scan de-duplicates row-wrapped candidates and fills ten slots',()=>{
  const radar=makeRadar({deepCandidates:10,quietReserve:8,rotationReserve:2});
  const input=Array.from({length:24},(_,i)=>candidate('DEEP'+String(i).padStart(2,'0')+'USDT',.25+(i%10)*.45,{
    score:90-(i%7),participation:75,tradeParticipation:72,structure:78,compression:82
  }));
  const selected=radar.selectDeepFromMicro([...input,input[0],input[1]],4);
  assert.equal(selected.length,10);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,10);
  assert.equal(selected.filter(x=>x._selection_lane==='quiet').length,5);
});
