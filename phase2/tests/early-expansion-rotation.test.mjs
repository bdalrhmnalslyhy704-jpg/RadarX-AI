import test from 'node:test';
import assert from 'node:assert/strict';
import {EarlyExpansionRadar,nextEarlyExpansionPollDelayMs,buildMicroFingerprint} from '../core/early-expansion-radar.mjs';

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


function microCandles({count,step,now,btc=false}){
  const lastOpen=Math.floor((now-1)/step)*step-step;
  const firstOpen=lastOpen-(count-1)*step;
  return Array.from({length:count},(_,i)=>{
    const openTime=firstOpen+i*step;
    const center=btc?40000+Math.min(i,count-14)*0.1:1+Math.min(i,count-14)*0.00025;
    const halfRange=btc?(i<count-14?0.2:0.02):(i<count-14?0.004:0.0003);
    const volume= !btc&&i>=count-12?[1050,1150,1320][Math.floor((i-(count-12))/4)]:1000;
    const tradeCount= !btc&&i>=count-12?[105,116,134][Math.floor((i-(count-12))/4)]:100;
    return {openTime,closeTime:openTime+step-1,open:center-(btc?0.05:0.00008),
      high:center+halfRange,low:center-halfRange,close:center,volume,
      quoteVolume:volume*center,tradeCount,takerBuyBaseVolume:volume*.32,closed:true};
  });
}


test('Radar 8 health remains available while an activity-shock candidate is held',()=>{
  const radar=makeRadar();
  radar.running=true;
  radar.fastShockPendingUntil.set('TESTUSDT',now+60_000);
  const health=radar.health();
  assert.equal(health.running,true);
  assert.equal(health.fast_shock_pending_total,1);
  assert.equal(health.last_error,null);
});

test('Radar 8 schedules the next cycle from actual completion instead of skipping an overrun interval',()=>{
  assert.equal(nextEarlyExpansionPollDelayMs(45000,30000,true),15000);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,45000,true),0);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,61800,true),0);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,64000,true),0);
  assert.equal(nextEarlyExpansionPollDelayMs(45000,1000,false),5000);
  assert.equal(nextEarlyExpansionPollDelayMs(1000,1000,false),1000);
});

test('Radar 8 logs a full-cycle duration and phase timing breakdown',async()=>{
  const events=[];
  const store={
    state:{records:[],last_historical_import_at:0,last_historical_backfill_at:0,last_report_log_at:0,updated_at:now},
    async updatePreExpansionOutcomes(update){
      const next=update(this.state);
      if(next&&next!==false)this.state=next;
      return this.state;
    },
    async readEarlyExpansionAlerts(){return[];},
    async readFalconEyeAlerts(){return[];}
  };
  const rest={
    async request(path){return path.includes('exchangeInfo')?{data:{symbols:[]}}:{data:[]};},
    async klines(){return {candles:[]};},
    async depth(){return {data:{bids:[],asks:[]}};}
  };
  const radar=new EarlyExpansionRadar({
    rest,store,config:{pollMs:45000,microScanCandidates:8,deepCandidates:3},
    clock:()=>now,logger:{info:x=>events.push(String(x)),warn:x=>events.push(String(x))}
  });
  radar.running=true;
  assert.equal(await radar.tick(),true);
  const line=events.find(x=>x.startsWith('[RADARX_SCAN_COMPLETE] '));
  assert.ok(line,'complete scan timing log must be emitted');
  const report=JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(report.radar,'RADAR_8');
  assert.equal(report.configured_poll_ms,45000);
  assert.equal(report.scan_duration_ms,0);
  assert.equal(report.scan_overrun_ms,0);
  assert.equal(report.expected_total,0);
  assert.equal(report.received_total,0);
  assert.equal(report.paper_trading,true);
  assert.equal(report.real_order_execution,false);
  for(const key of ['universe_refresh_ms','ticker_fast_selection_ms','market_context_ms','outcome_maintenance_ms','micro_scan_ms','market_micro_overlap_ms','deep_scan_ms','signal_archive_ms','notification_ms','other_ms'])
    assert.ok(Number.isFinite(report.phase_timings_ms[key]),key);
});

test('Radar 8 starts 15m, 1h, 4h and depth reads concurrently for each deep candidate',async()=>{
  let active=0,maxActive=0;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const rest={
    async klines(symbol,interval){
      active++;maxActive=Math.max(maxActive,active);
      await delay(20);active--;
      return {source:'TEST_FIXTURE',candles:[]};
    },
    async depth(){
      active++;maxActive=Math.max(maxActive,active);
      await delay(20);active--;
      return {source:'TEST_FIXTURE',data:{bids:[],asks:[]}};
    }
  };
  const radar=new EarlyExpansionRadar({rest,store:{},config:{retryAttempts:1},clock:()=>now,logger:{warn(){}}});
  const result=await radar.deepScan(
    {symbol:'PARALLELUSDT',lastPrice:1,priceChange24h:1,quoteVolume24h:1_000_000,tradeCount24h:1000},
    {},{}, {oneMinute:[],fiveMinute:[],source:'TEST_FIXTURE'}
  );
  assert.ok(Number.isFinite(result.data_quality));
  assert.equal(maxActive,4,JSON.stringify({maxActive}));
});

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
  const quietMoves=quiet.map(x=>Math.abs(x.priceChange24h));
  assert.deepEqual(quietMoves,[...quietMoves].sort((a,b)=>a-b));
  assert.ok(quietMoves.every(x=>x<=8));
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
  assert.equal(second.filter(x=>!firstSymbols.has(x.symbol)).length,5,JSON.stringify({first:first.map(x=>({s:x.symbol,l:x._selection_lane,age:x._rotationAge})),second:second.map(x=>({s:x.symbol,l:x._selection_lane,age:x._rotationAge})),overlap:second.filter(x=>firstSymbols.has(x.symbol)).map(x=>x.symbol)}));
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

test('Radar 8 gives confirmed activity shocks a deep-scan bypass without granting entry eligibility',()=>{
  const radar=makeRadar({deepCandidates:4,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:2});
  const event=candidate('EVENTUSDT',25,{score:57,participation:65,tradeParticipation:66,structure:48,compression:45,volume:1.1,trades:1.0});
  event.micro_fingerprint.activity_shock={detected:true,stage:'EVENT_DRIVEN_BREAKOUT',score:92,watch_only:true,entry_eligible:false,extended:true};
  const others=[candidate('AAAUSDT',2,{score:89}),candidate('BBBUSTDT',3,{score:88}),candidate('CCCUSDT',1,{score:84}),candidate('DDDUSDT',4,{score:82})];
  const selected=radar.selectDeepFromMicro([event,...others],9);
  assert.ok(selected.some(x=>x.row.symbol==='EVENTUSDT'&&x._selection_lane==='exceptional'));
  assert.equal(event.micro_fingerprint.activity_shock.entry_eligible,false);
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


test('Radar 8 deep selection prioritizes a closed-candle PRE_EXPANSION micro fingerprint in the quiet lane',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:0});
  const strong=candidate('HIGHSCOREUSDT',4.2,{score:96});
  const rotation=candidate('ROTATIONUSDT',2.1,{score:73});
  const quiet=candidate('QUIETBASEUSDT',1.6,{score:61,participation:54,tradeParticipation:52,structure:55,compression:50});
  quiet.micro_fingerprint.quiet_base_pre_expansion={
    fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'PRE_EXPANSION',detected:true,
    closed_candles_only:true,evidence:[]
  };
  const selected=radar.selectDeepFromMicro([strong,rotation,quiet],5);
  assert.equal(selected.length,3);
  assert.ok(selected.some(x=>x.row.symbol==='QUIETBASEUSDT'&&x._selection_lane==='quiet'),
    JSON.stringify(selected.map(x=>({symbol:x.row.symbol,lane:x._selection_lane}))));
});

test('Radar 8 micro fingerprint archives the quiet-base assessment from closed 5m candles',()=>{
  const now=1_900_000_000_000;
  const oneMinute=microCandles({count:100,step:60_000,now});
  const fiveMinute=microCandles({count:90,step:300_000,now});
  const btcFiveMinute=microCandles({count:90,step:300_000,now,btc:true});
  const fp=buildMicroFingerprint({
    oneMinute,fiveMinute,btcFiveMinute,
    ticker:{symbol:'MICROQUIETUSDT',lastPrice:fiveMinute.at(-1).close,priceChange24h:2.1,quoteVolume24h:1_000_000},
    now,config:{freshness1mMs:2*60_000,freshness5mMs:8*60_000}
  });
  assert.equal(fp.quiet_base_pre_expansion?.fingerprint,'QUIET_BASE_PRE_EXPANSION');
  assert.equal(fp.quiet_base_pre_expansion?.classification,'PRE_EXPANSION',JSON.stringify(fp.quiet_base_pre_expansion));
  assert.equal(fp.quiet_base_pre_expansion?.closed_candles_only,true);
  assert.ok(fp.quiet_base_pre_expansion.evidence.every(x=>x.used_through_candle_close_time_ms<=now));
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
