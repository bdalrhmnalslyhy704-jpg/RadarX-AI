import test from 'node:test';
import assert from 'node:assert/strict';
import {EarlyExpansionRadar,nextEarlyExpansionPollDelayMs,buildMicroFingerprint,EARLY_EXPANSION_RADAR_DEFAULTS} from '../core/early-expansion-radar.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {DurableStore} from '../core/store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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




function baselineHasFiniteNumber(v){return v!==null&&v!==undefined&&!(typeof v==='string'&&v.trim()==='')&&Number.isFinite(Number(v));}
function baselineMove(row){return baselineHasFiniteNumber(row?.priceChange24h)?Math.abs(Number(row.priceChange24h)):null;}
function baselineSymbol(item){return String(item?.symbol??item?.row?.symbol??'').trim().toUpperCase();}
function baselineClamp(v,lo=0,hi=100){return Math.max(lo,Math.min(hi,Number.isFinite(Number(v))?Number(v):0));}
function baselineSymbolHash(symbol){
  let h=2166136261>>>0;
  for(const ch of String(symbol||'')){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}
  return h>>>0;
}
function baselineQuietDeepRank(item,cfg){
  const row=item?.row,move=baselineMove(row),fp=item?.micro_fingerprint;
  if(move===null||move>Number(cfg.maxQuiet24hMovePct??8)||!fp||!baselineHasFiniteNumber(fp.score))return null;
  const m=fp.metrics||{},c=fp.category_scores||{};
  const rv1=baselineHasFiniteNumber(m.rvol_1m)?Number(m.rvol_1m):null;
  const rv5=baselineHasFiniteNumber(m.rvol_5m)?Number(m.rvol_5m):null;
  const tr1=baselineHasFiniteNumber(m.trade_rvol_1m)?Number(m.trade_rvol_1m):null;
  const participation=Math.max(
    baselineHasFiniteNumber(c.participation)?Number(c.participation):0,
    baselineHasFiniteNumber(c.tradeParticipation)?Number(c.tradeParticipation):0,
    rv1!==null?baselineClamp(50+Math.max(0,rv1-1)*18):0,
    rv5!==null?baselineClamp(50+Math.max(0,rv5-1)*12):0,
    tr1!==null?baselineClamp(50+Math.max(0,tr1-1)*20):0
  );
  const structure=Math.max(baselineHasFiniteNumber(c.structure)?Number(c.structure):0,
    baselineHasFiniteNumber(m.higher_low_count)?Number(m.higher_low_count):0);
  const bb=baselineHasFiniteNumber(m.bb_ratio)?Number(m.bb_ratio):null;
  const range=baselineHasFiniteNumber(m.range_compression_ratio)?Number(m.range_compression_ratio):null;
  const atr=baselineHasFiniteNumber(m.atr_ratio)?Number(m.atr_ratio):null;
  const compression=Math.max(baselineHasFiniteNumber(c.compression)?Number(c.compression):0,
    bb!==null&&bb<=.90?78:0,range!==null&&range<=.90?72:0,atr!==null&&atr<=.92?70:0);
  const resistance=baselineHasFiniteNumber(m.resistance_distance_pct)?Number(m.resistance_distance_pct):null;
  const resistanceNear=resistance!==null&&resistance>=-5&&resistance<=1.5;
  if(participation<Number(cfg.quietDeepMinParticipationScore??58)||
    !(compression>=65||structure>=62||resistanceNear))return null;
  return (100-move*6)*.35+participation*.25+structure*.20+compression*.20;
}
function baselineExceptionalDeep(item,cfg){
  const move=baselineMove(item?.row),fp=item?.micro_fingerprint,m=fp?.metrics||{},c=fp?.category_scores||{};
  if(fp?.activity_shock?.detected===true)return true;
  if(move===null||move>=Number(cfg.hardExtended24hMovePct||18))return false;
  const volume=Math.max(baselineHasFiniteNumber(m.rvol_1m)?Number(m.rvol_1m):0,baselineHasFiniteNumber(m.rvol_5m)?Number(m.rvol_5m):0);
  const trades=Math.max(baselineHasFiniteNumber(m.trade_rvol_1m)?Number(m.trade_rvol_1m):0,baselineHasFiniteNumber(m.trade_rvol_5m)?Number(m.trade_rvol_5m):0);
  const acceleration=Math.max(baselineHasFiniteNumber(m.acceleration_1m_pct)?Number(m.acceleration_1m_pct):-999,baselineHasFiniteNumber(m.acceleration_5m_pct)?Number(m.acceleration_5m_pct):-999);
  const pressure=baselineHasFiniteNumber(m.taker_buy_ratio)?Number(m.taker_buy_ratio):0;
  const structure=Math.max(baselineHasFiniteNumber(c.structure)?Number(c.structure):0,baselineHasFiniteNumber(m.higher_low_count)?Number(m.higher_low_count):0);
  return (volume>=Number(cfg.exceptionalVolumeAccelRatio??2.2)&&(acceleration>=Number(cfg.exceptionalPriceAccelerationPct??.15)||pressure>=.58||structure>=72))||
    (trades>=Number(cfg.exceptionalTradeAccelRatio??1.8)&&(acceleration>0||pressure>=.58));
}
function baselineTakeLane(selected,seen,pool,count,lane){
  const limit=Math.max(0,Math.trunc(Number(count)||0));if(limit===0)return;
  let added=0;
  for(const item of pool||[]){
    const symbol=baselineSymbol(item);
    if(!symbol||seen.has(symbol))continue;
    seen.add(symbol);selected.push({...item,_selection_lane:lane});added++;
    if(added>=limit)break;
  }
}
// Faithful test-only reproduction of Build 224's pre-PR #198 Deep selector.
// It intentionally uses independent historical rotation state and the very same
// Micro outputs given to the experimental selector; it does no REST calls.
function selectBuild224Baseline(radar,results,cycle,state,selectionAt=Date.now()){
  const currentCycle=Math.max(0,Math.trunc(Number(cycle)||0));
  const valid=(results||[]).filter(x=>x&&!x.failed&&baselineSymbol(x)&&x.micro_fingerprint?.score!=null&&baselineHasFiniteNumber(x.micro_fingerprint.score));
  const n=Math.max(1,Math.trunc(radar.config.deepCandidates||10));
  const target=Math.min(n,new Set(valid.map(baselineSymbol)).size);
  if(!target)return {selected:[],audit:[],candidate_total:0};
  const q=Math.min(Math.max(0,Math.trunc(radar.config.quietReserve??8)),Math.max(0,target-1),Math.floor(target*.5));
  const r=Math.min(Math.max(0,Math.trunc(radar.config.rotationReserve??2)),Math.max(0,target-q-1));
  const core=target-q-r;
  const byScore=[...valid].sort((a,b)=>Number(b.micro_fingerprint?.score??-1)-Number(a.micro_fingerprint?.score??-1)||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  const byQuiet=valid.map(item=>({...item,_quietScore:baselineQuietDeepRank(item,radar.config)}))
    .filter(item=>item._quietScore!==null)
    .sort((a,b)=>(baselineMove(a.row)??Infinity)-(baselineMove(b.row)??Infinity)||b._quietScore-a._quietScore||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  for(const item of valid){const s=baselineSymbol(item);if(!state.queuedAt.has(s))state.queuedAt.set(s,selectionAt);}
  const byRotation=[...valid].map(item=>{
    const symbol=baselineSymbol(item),lastCycle=state.lastCycle.get(symbol),lastAt=state.lastAt.get(symbol),queuedAt=state.queuedAt.get(symbol);
    const neverScanned=lastAt===undefined;
    return {...item,_neverScanned:neverScanned,
      _rotationAgeMs:neverScanned?Number.MAX_SAFE_INTEGER:Math.max(0,selectionAt-lastAt),
      _queueAgeMs:queuedAt===undefined?0:Math.max(0,selectionAt-queuedAt),
      _rotationAge:lastCycle===undefined?Number.MAX_SAFE_INTEGER:Math.max(0,currentCycle-lastCycle),
      _rotation:((baselineSymbolHash(symbol)+Math.imul(currentCycle,2654435761))>>>0)};
  }).sort((a,b)=>Number(b._neverScanned)-Number(a._neverScanned)||b._rotationAgeMs-a._rotationAgeMs||b._queueAgeMs-a._queueAgeMs||b._rotationAge-a._rotationAge||a._rotation-b._rotation||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  const byExceptional=valid.filter(x=>baselineExceptionalDeep(x,radar.config)).sort((a,b)=>
    Number(b.micro_fingerprint?.score??-1)-Number(a.micro_fingerprint?.score??-1)||baselineSymbol(a).localeCompare(baselineSymbol(b)));
  const selected=[],seen=new Set(),exceptionSlots=Math.min(core,Math.max(0,Math.trunc(radar.config.exceptionalRotationBypassSlots??2)));
  baselineTakeLane(selected,seen,byExceptional,exceptionSlots,'exceptional');
  baselineTakeLane(selected,seen,byScore,Math.max(0,core-selected.length),'score');
  baselineTakeLane(selected,seen,byQuiet,q,'quiet');
  baselineTakeLane(selected,seen,byRotation,r,'rotation');
  baselineTakeLane(selected,seen,byScore,target-selected.length,'fill_score');
  baselineTakeLane(selected,seen,byQuiet,target-selected.length,'fill_quiet');
  baselineTakeLane(selected,seen,byRotation,target-selected.length,'fill_rotation');
  baselineTakeLane(selected,seen,valid,target-selected.length,'fill_any');
  const picked=new Map(selected.map((item,index)=>[baselineSymbol(item),{rank:index+1,lane:item._selection_lane||'score'}]));
  const scoreRanks=new Map();byScore.forEach((item,i)=>{const s=baselineSymbol(item);if(!scoreRanks.has(s))scoreRanks.set(s,i+1);});
  const quietRanks=new Map();byQuiet.forEach((item,i)=>{const s=baselineSymbol(item);if(!quietRanks.has(s))quietRanks.set(s,i+1);});
  const uniqueInputs=[...new Map((results||[]).filter(item=>baselineSymbol(item)).map(item=>[baselineSymbol(item),item])).entries()];
  const audit=uniqueInputs.map(([symbol,item])=>{
    const chosen=picked.get(symbol),score=baselineHasFiniteNumber(item?.micro_fingerprint?.score)?Number(item.micro_fingerprint.score):null;
    const classification=item?.micro_fingerprint?.quiet_base_pre_expansion?.classification??null;
    return {symbol,score,score_rank:scoreRanks.get(symbol)??null,
      quiet_rank:quietRanks.get(symbol)??null,classification,selected:Boolean(chosen),selected_rank:chosen?.rank??null,
      selection_lane:chosen?.lane??null,reason:chosen?'SELECTED_'+chosen.lane.toUpperCase():
        item?.failed?'MICRO_SCAN_FAILED':score===null?'MICRO_FINGERPRINT_NOT_SCOREABLE':'DEEP_BATCH_CAPACITY'};
  });
  return {selected:selected.slice(0,target),audit,candidate_total:valid.length};
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


test('Radar 8 PRE_EXPANSION ranks ahead of WATCH_EARLY in the single quiet Deep slot',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:0});
  const strong=candidate('STRONGUSDT',1.4,{score:98});
  const watch=candidate('WATCHUSDT',0.8,{score:97});
  watch.micro_fingerprint.quiet_base_pre_expansion={
    fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'WATCH_EARLY',detected:false,closed_candles_only:true,evidence:[]
  };
  const pre=candidate('PREUSDT',1.2,{score:60,participation:54,tradeParticipation:52,structure:55,compression:50});
  pre.micro_fingerprint.quiet_base_pre_expansion={
    fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'PRE_EXPANSION',detected:true,closed_candles_only:true,evidence:[]
  };
  const selected=radar.selectDeepFromMicro([strong,watch,pre,watch],17);
  assert.equal(selected.length,3);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,3,'duplicate symbols must not consume multiple slots');
  const quiet=selected.filter(x=>x._selection_lane==='quiet'||x._selection_lane==='fill_quiet');
  assert.equal(quiet.length,1,'Deep capacity 3 must retain only one quiet seat');
  assert.equal(quiet[0].row.symbol,'PREUSDT');
  assert.equal(pre.micro_fingerprint.eligible,false,'PRE prioritization is observation priority, not a buy flag');
});

test('Radar 8 WATCH_EARLY cannot displace independent quiet evidence even with a higher micro score',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:0});
  const strong=candidate('COREUSDT',1.2,{score:99});
  const independent=candidate('INDEPENDENTQUIETUSDT',1.1,{score:62});
  const watch=candidate('WATCHONLYUSDT',0.6,{score:98});
  watch.micro_fingerprint.quiet_base_pre_expansion={
    fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'WATCH_EARLY',detected:false,closed_candles_only:true,evidence:[]
  };
  const selected=radar.selectDeepFromMicro([strong,watch,independent],18);
  assert.ok(selected.some(x=>x.row.symbol==='COREUSDT'));
  assert.ok(selected.some(x=>x.row.symbol==='INDEPENDENTQUIETUSDT'&&x._selection_lane==='quiet'),
    JSON.stringify(selected.map(x=>({symbol:x.row.symbol,lane:x._selection_lane}))));
  assert.equal(selected.find(x=>x.row.symbol==='WATCHONLYUSDT')?._selection_lane,'rotation',
    'WATCH may only reach the cycle through the existing fair-rotation lane here');
  assert.equal(watch.micro_fingerprint.eligible,false);
});

test('Radar 8 WATCH_EARLY without strong independent quiet rank cannot reserve the quiet seat',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:0});
  const strong=candidate('CORE2USDT',1.1,{score:99});
  const watch=candidate('WEAKWATCHUSDT',1.0,{score:98,participation:40,tradeParticipation:38,structure:35,compression:35,volume:.9,trades:.8});
  watch.micro_fingerprint.metrics.bb_ratio=1.25;
  watch.micro_fingerprint.metrics.range_compression_ratio=1.2;
  watch.micro_fingerprint.metrics.atr_ratio=1.15;
  watch.micro_fingerprint.metrics.resistance_distance_pct=18;
  watch.micro_fingerprint.quiet_base_pre_expansion={
    fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'WATCH_EARLY',detected:false,closed_candles_only:true,evidence:[]
  };
  const independent=candidate('BETTERQUIETUSDT',1.2,{score:60});
  const selected=radar.selectDeepFromMicro([strong,watch,independent],19);
  assert.ok(selected.some(x=>x.row.symbol==='BETTERQUIETUSDT'&&x._selection_lane==='quiet'));
  assert.notEqual(selected.find(x=>x.row.symbol==='WEAKWATCHUSDT')?._selection_lane,'quiet');
});

test('Radar 8 exceptional deep bypass remains available alongside the quiet reserve and rotation',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:1});
  const event=candidate('SHOCKUSDT',2,{score:42});
  event.micro_fingerprint.activity_shock={detected:true,score:94,watch_only:true,entry_eligible:false};
  const pre=candidate('PRESEATUSDT',1.2,{score:60,participation:54,tradeParticipation:52,structure:55,compression:50});
  pre.micro_fingerprint.quiet_base_pre_expansion={
    fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'PRE_EXPANSION',detected:true,closed_candles_only:true,evidence:[]
  };
  const selected=radar.selectDeepFromMicro([event,pre,candidate('NORMALUSDT',3,{score:80}),candidate('ROTATION2USDT',2,{score:62})],20);
  assert.ok(selected.some(x=>x.row.symbol==='SHOCKUSDT'&&x._selection_lane==='exceptional'));
  assert.ok(selected.some(x=>x.row.symbol==='PRESEATUSDT'&&x._selection_lane==='quiet'));
  assert.equal(event.micro_fingerprint.activity_shock.entry_eligible,false);
  assert.equal(selected.length,3);
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,3);
});

test('Radar 8 Deep rotation still advances to an unseen candidate across cycles',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:0,rotationReserve:1,exceptionalRotationBypassSlots:0});
  const input=['ROT0USDT','ROT1USDT','ROT2USDT','ROT3USDT'].map(symbol=>candidate(symbol,1,{score:85}));
  const first=radar.selectDeepFromMicro(input,1);
  const firstRotation=first.find(x=>x._selection_lane==='rotation');
  assert.ok(firstRotation);
  const second=radar.selectDeepFromMicro(input,2);
  const secondRotation=second.find(x=>x._selection_lane==='rotation');
  assert.ok(secondRotation);
  assert.notEqual(secondRotation.row.symbol,firstRotation.row.symbol,
    JSON.stringify({first:first.map(x=>({s:x.row.symbol,l:x._selection_lane})),second:second.map(x=>({s:x.row.symbol,l:x._selection_lane}))}));
  assert.equal(new Set(second.map(x=>x.row.symbol)).size,3);
});

test('Radar 8 Micro quiet-base assessment reuses existing 1m and 5m candle reads only',async()=>{
  const calls=[];
  const radar=new EarlyExpansionRadar({
    rest:{async klines(symbol,interval){calls.push({symbol,interval});return{source:'TEST_FIXTURE',candles:[]};}},
    store:{},config:{retryAttempts:0},clock:()=>now,logger:{warn(){}}
  });
  const result=await radar.microScan(
    {symbol:'READCOUNTUSDT',lastPrice:1,priceChange24h:1,quoteVolume24h:1_000_000,tradeCount24h:1000},
    {},[]
  );
  assert.deepEqual(calls.map(x=>x.interval).sort(),['1m','5m']);
  assert.ok(result.micro_fingerprint.quiet_base_pre_expansion);
});


test('Radar 8 stores a unique rank and explicit capacity reason for every candidate',()=>{
  const radar=makeRadar({microScanCandidates:12,quietReserve:3,rotationReserve:2,deepCandidates:3});
  const input=rows(18);
  const selected=radar.selectMicro([...input,input[0]],fastMap(input),31);
  assert.equal(selected.length,12);
  assert.equal(radar.lastMicroDuplicateInputCount,1);
  assert.equal(radar.lastMicroSelectionAudit.length,18);
  assert.equal(new Set(radar.lastMicroSelectionAudit.map(x=>x.symbol)).size,18);
  assert.deepEqual(radar.lastMicroSelectionAudit.map(x=>x.rank_by_micro_score).sort((a,b)=>a-b),Array.from({length:18},(_,i)=>i+1));
  assert.equal(radar.lastMicroSelectionAudit.filter(x=>x.selected).length,12);
  assert.equal(radar.lastMicroSelectionAudit.filter(x=>x.decision_reason==='MICRO_BATCH_CAPACITY').length,6);
  assert.deepEqual(new Set(selected.map(x=>x.symbol)),new Set(radar.lastMicroSelectionAudit.filter(x=>x.selected).map(x=>x.symbol)));
});

test('Radar 8 archives an explicit Deep score rank, final rank and deferral reason for every Micro result',()=>{
  const radar=makeRadar({deepCandidates:3,quietReserve:1,rotationReserve:1,exceptionalRotationBypassSlots:0});
  const input=Array.from({length:6},(_,i)=>candidate('AUDIT'+i+'USDT',1+i*.2,{score:90-i*3}));
  input[0].micro_fingerprint.quiet_base_pre_expansion={fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'PRE_EXPANSION',detected:true,closed_candles_only:true};
  input[1].micro_fingerprint.quiet_base_pre_expansion={fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'WATCH_EARLY',detected:false,closed_candles_only:true};
  const selected=radar.selectDeepFromMicro([...input,input[0]],32);
  assert.equal(selected.length,3);
  assert.equal(radar.lastDeepDuplicateInputCount,1);
  assert.equal(radar.lastDeepSelectionAudit.length,6);
  assert.equal(radar.lastDeepSelectionAudit.filter(x=>x.selected).length,3);
  assert.deepEqual(radar.lastDeepSelectionAudit.map(x=>x.rank_by_micro_score).sort((a,b)=>a-b),[1,2,3,4,5,6]);
  assert.equal(radar.lastDeepSelectionAudit.filter(x=>x.decision_reason==='DEEP_BATCH_CAPACITY').length,3);
  assert.equal(radar.lastDeepSelectionAudit.find(x=>x.symbol==='AUDIT0USDT').quiet_base_classification,'PRE_EXPANSION');
  assert.equal(new Set(selected.map(x=>x.row.symbol)).size,3);
});

test('RestClient telemetry separates real HTTP attempts from cached logical calls',async()=>{
  const collector={cycle_id:'TEST_REST_TELEMETRY',logical_calls:0,cache_hits:0,coalesced_calls:0,actual_http_attempts:0,by_stage:{},calls:[]};
  let fetchCount=0;
  const rest=new RestClient({
    baseUrls:['https://radarx-rest-telemetry.invalid'],minIntervalMs:0,timeoutMs:1500,
    fetchImpl:async()=>{
      fetchCount++;
      return new Response(JSON.stringify({symbol:'RESTTELEMETRYUSDT',lastPrice:'1'}),{
        status:200,headers:{'content-type':'application/json','x-mbx-used-weight-1m':'2'}
      });
    }
  });
  const before=rest.telemetrySnapshot();
  const ctx={collector,radar:'RADAR_8',cycle_id:collector.cycle_id,stage:'TEST_TICKER',symbol:'RESTTELEMETRYUSDT'};
  const query={symbol:'RESTTELEMETRYUSDT'};
  await rest.request('/api/v3/ticker/24hr',query,ctx);
  await rest.request('/api/v3/ticker/24hr',query,ctx);
  const after=rest.telemetrySnapshot();
  assert.equal(fetchCount,1);
  assert.equal(collector.logical_calls,2);
  assert.equal(collector.actual_http_attempts,1);
  assert.equal(collector.cache_hits,1);
  assert.equal(collector.by_stage.TEST_TICKER.actual_http_attempts,1);
  assert.equal(collector.by_stage.TEST_TICKER.cache_hits,1);
  assert.equal(collector.calls[0].actual_http_attempts[0].http_status,200);
  assert.ok(Number.isFinite(collector.calls[0].actual_http_attempts[0].latency_ms));
  assert.equal(after.actual_http_attempts-before.actual_http_attempts,1);
});

const shouldRunLiveRadar8Monitor=process.env.GITHUB_ACTIONS==='true'&&
  process.env.GITHUB_WORKFLOW==='RadarX Phase 2 Tests'&&
  process.env.GITHUB_HEAD_REF==='experiment/build224-radar8-micro-quiet-base-20261010';

test('OPERATIONAL_MONITOR: 25 consecutive Radar 8 cycles with same-data Build 224 baseline comparison', {
  skip:!shouldRunLiveRadar8Monitor,timeout:360_000
},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-radar8-live-monitor-'));
  const store=await new DurableStore({dir}).init();
  const rest=new RestClient({
    baseUrls:['https://data-api.binance.vision','https://api.binance.com'],
    timeoutMs:9000,minIntervalMs:100,maxRequestsPerMinute:240
  });
  const monitorLogs=[];
  const logger={
    info(message){if(String(message).includes('RADARX_'))monitorLogs.push(String(message));},
    warn(...args){monitorLogs.push(args.map(String).join(' '));},
    error(...args){monitorLogs.push(args.map(String).join(' '));}
  };
  const radar=new EarlyExpansionRadar({
    rest,store,
    config:{
      ...EARLY_EXPANSION_RADAR_DEFAULTS,
      minQuoteVolume24h:350_000,microScanCandidates:12,deepCandidates:3,
      quietReserve:8,rotationReserve:8,microConcurrency:6,deepConcurrency:4,
      universeRefreshMs:60*60*1000,retryAttempts:1,pollMs:45_000
    },
    clock:()=>Date.now(),logger
  });
  radar.running=true;
  const baselineState={lastAt:new Map(),lastCycle:new Map(),queuedAt:new Map()};
  let activeBaselineComparison=null;
  const appendJourney=store.appendScanJourneyCycle.bind(store);
  store.appendScanJourneyCycle=async record=>{
    if(record?.status==='COMPLETE'&&activeBaselineComparison)
      record.counters.same_cycle_baseline_comparison=structuredClone(activeBaselineComparison);
    return appendJourney(record);
  };
  const realDeepSelector=radar.selectDeepFromMicro.bind(radar);
  radar.selectDeepFromMicro=function(results,cycle){
    const baseline=selectBuild224Baseline(this,results,cycle,baselineState,Date.now());
    const prSelected=realDeepSelector(results,cycle);
    const prAudit=new Map(this.lastDeepSelectionAudit.map(x=>[x.symbol,x]));
    const baselineAudit=new Map(baseline.audit.map(x=>[x.symbol,x]));
    const symbols=new Set([...baselineAudit.keys(),...prAudit.keys()]);
    const candidateRanks=[...symbols].sort().map(symbol=>{
      const b=baselineAudit.get(symbol)||{},p=prAudit.get(symbol)||{};
      return {symbol,classification:b.classification??p.quiet_base_classification??null,
        score:b.score??p.score??null,
        baseline_score_rank:b.score_rank??null,baseline_quiet_rank:b.quiet_rank??null,
        baseline_selected_rank:b.selected_rank??null,baseline_lane:b.selection_lane??null,baseline_reason:b.reason??'NOT_IN_BASELINE_POOL',
        pr_score_rank:p.rank_by_micro_score??null,pr_quiet_rank:p.quiet_rank??null,
        pr_selected_rank:p.selected_rank??null,pr_lane:p.selection_lane??null,pr_reason:p.decision_reason??'NOT_IN_PR_POOL'};
    });
    const baselineSymbols=baseline.selected.map(baselineSymbol),prSymbols=prSelected.map(baselineSymbol);
    const classOf=symbol=>candidateRanks.find(x=>x.symbol===symbol)?.classification;
    activeBaselineComparison={
      schema_version:'RADAR8_SAME_CYCLE_BASELINE_V1',
      baseline:'Build224 before PR #198: score + ordinary quiet rank + fair rotation + exceptional bypass',
      experimental:'PR #198 current selector',
      cycle,deep_candidate_total:baseline.candidate_total,
      pre_expansion_candidates_total:candidateRanks.filter(x=>x.classification==='PRE_EXPANSION').length,
      watch_early_candidates_total:candidateRanks.filter(x=>x.classification==='WATCH_EARLY').length,
      baseline_deep_symbols:baselineSymbols,pr_deep_symbols:prSymbols,
      selected_overlap_total:baselineSymbols.filter(s=>prSymbols.includes(s)).length,
      selected_changed_from_baseline_total:new Set([...baselineSymbols,...prSymbols]).size-baselineSymbols.filter(s=>prSymbols.includes(s)).length,
      baseline_pre_expansion_selected_total:baselineSymbols.filter(s=>classOf(s)==='PRE_EXPANSION').length,
      pr_pre_expansion_selected_total:prSymbols.filter(s=>classOf(s)==='PRE_EXPANSION').length,
      baseline_watch_early_selected_total:baselineSymbols.filter(s=>classOf(s)==='WATCH_EARLY').length,
      pr_watch_early_selected_total:prSymbols.filter(s=>classOf(s)==='WATCH_EARLY').length,
      baseline_quiet_lane_selected_total:baseline.selected.filter(x=>String(x._selection_lane||'').includes('quiet')).length,
      pr_quiet_lane_selected_total:prSelected.filter(x=>String(x._selection_lane||'').includes('quiet')).length,
      baseline_exceptional_selected_total:baseline.selected.filter(x=>x._selection_lane==='exceptional').length,
      pr_exceptional_selected_total:prSelected.filter(x=>x._selection_lane==='exceptional').length,
      candidate_ranks:candidateRanks
    };
    return prSelected;
  };
  const cycles=[];
  try{
    for(let i=0;i<25;i++){
      activeBaselineComparison=null;
      const ok=await radar.tick();
      assert.equal(ok,true,'cycle '+(i+1)+' must complete against live REST data: '+JSON.stringify({lastError:radar.lastError,health:radar.health(),rest:rest.health(),telemetry:rest.telemetrySnapshot(),logs:monitorLogs.slice(-8)}));
      const latest=(await store.readScanJourneyCycles({limit:1}))[0];
      assert.ok(latest,'completed cycle must be archived');
      assert.equal(latest.status,'COMPLETE');
      assert.equal(latest.data_policy.paper_trading,true);
      assert.equal(latest.data_policy.real_order_execution,false);
      assert.equal(latest.counters.operational_telemetry_schema,'RADAR8_OPERATIONAL_TELEMETRY_V1');
      assert.ok(latest.counters.rest_request_telemetry.process_rest_delta.available);
      assert.ok(latest.counters.rest_request_telemetry.actual_http_attempts>0);
      assert.ok(latest.counters.rest_request_telemetry.process_rest_delta.actual_http_attempts>0);
      assert.ok(latest.counters.micro_selected_total<=12);
      assert.ok(latest.counters.deep_selected_total<=3);
      assert.equal(latest.counters.micro_selected_total,new Set(latest.counters.micro_selected_symbols).size);
      assert.equal(latest.counters.deep_selected_total,new Set(latest.counters.deep_selected_symbols).size);
      assert.equal(latest.counters.micro_selected_total,latest.coins.filter(x=>x.micro_selection_selected===true).length);
      assert.equal(latest.counters.deep_selected_total,latest.coins.filter(x=>x.deep_selection_selected===true).length);
      const comparison=latest.counters.same_cycle_baseline_comparison;
      assert.ok(comparison,'baseline comparison must be stored in the same cycle archive row');
      assert.equal(comparison.candidate_ranks.length,latest.counters.deep_selection_ranked_total);
      assert.deepEqual([...comparison.pr_deep_symbols].sort(),[...latest.counters.deep_selected_symbols].sort());
      assert.ok(comparison.baseline_deep_symbols.length<=3);
      assert.ok(comparison.pr_deep_symbols.length<=3);
      assert.equal(comparison.candidate_ranks.filter(x=>x.pr_selected_rank!==null).length,comparison.pr_deep_symbols.length);
      assert.equal(comparison.candidate_ranks.filter(x=>x.baseline_selected_rank!==null).length,comparison.baseline_deep_symbols.length);
      for(const symbol of comparison.baseline_deep_symbols){
        baselineState.lastAt.set(symbol,latest.completed_at);
        baselineState.lastCycle.set(symbol,latest.cycle_number||i+1);
        baselineState.queuedAt.delete(symbol);
      }
      cycles.push({
        cycle_id:latest.cycle_id,started_at:latest.started_at,completed_at:latest.completed_at,
        scan_duration_ms:latest.scan_duration_ms,
        eligible_total:latest.counters.eligible_total,eligible_symbols:latest.counters.eligible_symbols,
        micro_selected_total:latest.counters.micro_selected_total,micro_selected_symbols:latest.counters.micro_selected_symbols,
        micro_success_total:latest.counters.micro_success_total,micro_pre_expansion_total:latest.counters.micro_pre_expansion_total,
        micro_watch_early_total:latest.counters.micro_watch_early_total,micro_quiet_selected_total:latest.counters.micro_quiet_selected_total,
        micro_exceptional_candidate_total:latest.counters.micro_exceptional_candidate_total,
        deep_selected_symbols:latest.counters.deep_selected_symbols,
        deep_pre_expansion_selected_total:latest.counters.deep_pre_expansion_selected_total,
        deep_watch_early_selected_total:latest.counters.deep_watch_early_selected_total,
        deep_deferred_total:latest.counters.deep_deferred_total,micro_deferred_total:latest.counters.micro_deferred_total,
        micro_duplicate_input_symbol_rows:latest.counters.micro_duplicate_input_symbol_rows,
        deep_duplicate_input_symbol_rows:latest.counters.deep_duplicate_input_symbol_rows,
        micro_failed_total:latest.counters.micro_failed_total,deep_failed_total:latest.counters.deep_failed_total,
        rest_attempts:latest.counters.rest_request_telemetry.actual_http_attempts,
        process_http_attempts:latest.counters.rest_request_telemetry.process_rest_delta.actual_http_attempts,
        rest_request_stages:Object.fromEntries(Object.entries(latest.counters.rest_request_telemetry.by_stage).map(([k,v])=>[k,v.actual_http_attempts])),
        phase_timings_ms:latest.phase_timings_ms,
        same_data_baseline_comparison:comparison
      });
    }
    assert.equal(cycles.length,25);
    const verified=await store.verifyScanJourneyArchive();
    assert.equal(verified.complete,true,JSON.stringify(verified));
    const baselinePre=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.baseline_pre_expansion_selected_total,0);
    const prPre=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.pr_pre_expansion_selected_total,0);
    const baselineWatch=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.baseline_watch_early_selected_total,0);
    const prWatch=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.pr_watch_early_selected_total,0);
    const baselineChosen=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.baseline_deep_symbols.length,0);
    const prChosen=cycles.reduce((n,x)=>n+x.same_data_baseline_comparison.pr_deep_symbols.length,0);
    const summary={
      mode:'CI_LIVE_PUBLIC_SPOT_REST_NOT_PRODUCTION_DEPLOYMENT',
      baseline_mode:'test-only faithful Build 224 pre-PR selector replayed on each exact Micro result pool; independent shadow rotation state',
      cycles_run:cycles.length,cycles,archive_verified:verified.complete,
      aggregate:{
        eligible_per_cycle_median:cycles.slice().sort((a,b)=>a.eligible_total-b.eligible_total)[Math.floor(cycles.length/2)].eligible_total,
        median_cycle_ms:cycles.slice().map(x=>x.scan_duration_ms).sort((a,b)=>a-b)[Math.floor(cycles.length/2)],
        rest_attempts_total:cycles.reduce((n,x)=>n+x.rest_attempts,0),
        micro_failures:cycles.reduce((n,x)=>n+x.micro_failed_total,0),
        deep_failures:cycles.reduce((n,x)=>n+x.deep_failed_total,0),
        duplicates:cycles.reduce((n,x)=>n+x.micro_duplicate_input_symbol_rows+x.deep_duplicate_input_symbol_rows,0),
        baseline_deep_candidate_seats:baselineChosen,pr_deep_candidate_seats:prChosen,
        baseline_pre_expansion_deep:baselinePre,pr_pre_expansion_deep:prPre,
        baseline_watch_early_deep:baselineWatch,pr_watch_early_deep:prWatch,
        cycles_with_pre_expansion:cycles.filter(x=>x.same_data_baseline_comparison.pre_expansion_candidates_total>0).length,
        cycles_where_pr_added_pre_expansion_to_deep:cycles.filter(x=>x.same_data_baseline_comparison.pr_pre_expansion_selected_total>x.same_data_baseline_comparison.baseline_pre_expansion_selected_total).length,
        cycles_where_deep_selection_changed:cycles.filter(x=>x.same_data_baseline_comparison.selected_changed_from_baseline_total>0).length
      },
      paper_trading:true,real_order_execution:false
    };
    console.log('[RADAR8_LIVE_MONITOR_SUMMARY] '+JSON.stringify(summary));
  }finally{
    await radar.stop();
    await rm(dir,{recursive:true,force:true});
  }
});
