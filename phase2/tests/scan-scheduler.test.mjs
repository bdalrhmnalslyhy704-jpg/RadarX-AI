import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {ScanSchedulerJournal} from '../core/scan-scheduler.mjs';
import {EarlyExpansionRadar} from '../core/early-expansion-radar.mjs';
import {WhaleAccumulationRadar} from '../core/whale-accumulation-radar.mjs';
import {futureIssues} from '../core/data-quality.mjs';

const NOW=1_900_000_000_000;
const silent={info(){},warn(){}};

test('scheduler journal restores queue age and last real scan after DurableStore restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scheduler-journal-'));
  try{
    let now=10_000;
    const store=await new DurableStore({dir}).init();
    const journal=new ScanSchedulerJournal({radar:'RADAR_8',store,clock:()=>now,logger:silent});
    await journal.hydrate();
    journal.ensureQueued('DEEP','AAAUSDT',now);
    journal.defer('DEEP','AAAUSDT',{cycle:1,at:now,reasonCode:'DEEP_BATCH_CAPACITY',fastSeenAt:now});
    now+=250;
    const first=journal.started('DEEP','AAAUSDT',{cycle:1,at:now,lane:'rotation',fastSeenAt:10_100});
    assert.equal(first.wait_ms,250);
    assert.equal(first.queue_age_ms,250);
    assert.equal(first.time_from_fast_to_scan_ms,150);
    now+=200;
    journal.finished('DEEP','AAAUSDT',{
      cycle:1,at:now,startedAt:10_250,outcome:'INCOMPLETE',
      reasonCode:'DATA_MISSING_OR_NOT_MATURE',failureCounted:false,fastSeenAt:10_100
    });

    journal.ensureQueued('DEEP','BBBUSDT',now);
    now+=100;
    journal.selected('DEEP','BBBUSDT',{cycle:1,at:now,lane:'score',reasonCode:'HIGHEST_CURRENT_EARLY_SCORE'});
    now+=100;
    const noSignalStart=journal.started('DEEP','BBBUSDT',{cycle:1,at:now,lane:'score'});
    assert.equal(noSignalStart.wait_ms,200);
    now+=200;
    journal.finished('DEEP','BBBUSDT',{
      cycle:1,at:now,startedAt:10_650,outcome:'COMPLETED',
      reasonCode:'NO_SIGNAL_NOT_A_FAILURE',failureCounted:false
    });
    await journal.flush();

    const reopenedStore=await new DurableStore({dir}).init();
    const archive=await reopenedStore.readScanSchedulerEvents({radar:'RADAR_8',limit:100});
    assert.ok(archive.length>=6,'scheduler event journal must have multiple lifecycle records');
    assert.deepEqual(archive.map(x=>x.event_at),[...archive.map(x=>x.event_at)].sort((a,b)=>a-b));
    assert.ok(archive.some(x=>x.event_type==='DEFERRED'&&x.reason_code==='DEEP_BATCH_CAPACITY'));
    assert.ok(archive.some(x=>x.event_type==='INCOMPLETE'&&x.failure_counted===false));
    assert.ok(archive.some(x=>x.reason_code==='NO_SIGNAL_NOT_A_FAILURE'&&x.failure_counted===false));

    const restored=new ScanSchedulerJournal({radar:'RADAR_8',store:reopenedStore,clock:()=>now,logger:silent});
    await restored.hydrate();
    assert.equal(restored.lastScanAt('DEEP','AAAUSDT'),10_250);
    assert.equal(restored.queueStartedAt('DEEP','AAAUSDT'),null);
    assert.equal(restored.lastScanAt('DEEP','BBBUSDT'),10_650);
    assert.equal(restored.waitAgeMs('DEEP','AAAUSDT',now),now-10_250);

    const filtered=await reopenedStore.readScanSchedulerEvents({radar:'RADAR_8',symbol:'AAAUSDT',limit:100});
    assert.ok(filtered.length>0);
    assert.ok(filtered.every(x=>x.symbol==='AAAUSDT'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Radar 8 micro rotation gives the longest-waiting symbol a slot and de-duplicates a cycle',()=>{
  const radar=new EarlyExpansionRadar({
    rest:{},store:{},clock:()=>NOW,logger:silent,
    config:{microScanCandidates:4,quietReserve:0,rotationReserve:2,exceptionalRotationBypassSlots:0}
  });
  const rows=['BEST1USDT','BEST2USDT','OLDWAITUSDT','RECENT1USDT','RECENT2USDT'].map((symbol,i)=>({
    symbol,lastPrice:1+i,priceChange24h:20.5,quoteVolume24h:1_000_000,tradeCount24h:20_000
  }));
  const fast=new Map(rows.map((row,i)=>[row.symbol,{
    price_change_pct:i<2?.8:.01,
    price_acceleration_pct:i===0?.12:.005,
    volume_accel_ratio:i<2?1.5:1.01,
    trade_accel_ratio:i<2?1.4:1.01
  }]));
  radar.scheduler.lastStartedAt.set(radar.scheduler.stageKey('MICRO','OLDWAITUSDT'),NOW-900_000);
  for(const symbol of ['BEST1USDT','BEST2USDT','RECENT2USDT'])
    radar.scheduler.lastStartedAt.set(radar.scheduler.stageKey('MICRO',symbol),NOW-5_000);
  radar.scheduler.lastStartedAt.set(radar.scheduler.stageKey('MICRO','RECENT1USDT'),NOW-30_000);
  const selected=radar.selectMicro([...rows,rows[2]],fast,7);
  assert.equal(selected.length,4);
  assert.equal(new Set(selected.map(x=>x.symbol.toUpperCase())).size,4);
  assert.ok(selected.some(x=>x.symbol==='OLDWAITUSDT'&&x._selection_lane==='rotation'));
  const oldest=selected.find(x=>x.symbol==='OLDWAITUSDT');
  const recent=selected.filter(x=>x.symbol.startsWith('RECENT'))
    .sort((a,b)=>b._rotationAgeMs-a._rotationAgeMs)[0];
  assert.ok(oldest&&recent,'rotation should include both an overdue and a recent symbol');
  assert.ok(oldest._rotationAgeMs>recent._rotationAgeMs);
});

test('Radar 9 routes exceptional movement quickly, preserves a quiet-base slot and gives the oldest wait a rotation slot',()=>{
  const radar=new WhaleAccumulationRadar({
    rest:{},store:{readScanSchedulerEvents:async()=>[],appendScanSchedulerEvents:async()=>{}},
    clock:()=>NOW,logger:silent,
    config:{topAnchors:2,rotationBatchSize:2,schedulerFastPathSlots:1,schedulerQuietAnchorSlots:1}
  });
  const symbols=['FASTUSDT','QUIETUSDT','OVERDUEUSDT','RECENTUSDT','OTHERUSDT','DUPUSDT'];
  radar.universe=[...symbols];
  const rows=symbols.map((symbol,i)=>({
    symbol,lastPrice:1+i,priceChange24h:symbol==='QUIETUSDT'?.2:symbol==='FASTUSDT'?2.5:3,
    quoteVolume24h:5_000_000-i*100_000,tradeCount24h:20_000
  }));
  const fastBySymbol={
    FASTUSDT:{volume_accel_ratio:3.4,trade_accel_ratio:2.5,price_acceleration_pct:.28},
    QUIETUSDT:{volume_accel_ratio:1.3,trade_accel_ratio:1.25,price_acceleration_pct:.04}
  };
  radar.fastHistoryBySymbol.set('FASTUSDT',[fastBySymbol.FASTUSDT]);
  radar.fastHistoryBySymbol.set('QUIETUSDT',[fastBySymbol.QUIETUSDT]);
  radar.updateFastSnapshot=row=>fastBySymbol[row.symbol]||{
    volume_accel_ratio:1.01,trade_accel_ratio:1.01,price_acceleration_pct:.005
  };
  radar.scheduler.lastStartedAt.set(radar.scheduler.stageKey('DEEP','OVERDUEUSDT'),NOW-900_000);
  for(const symbol of symbols.filter(x=>x!=='OVERDUEUSDT'))
    radar.scheduler.lastStartedAt.set(radar.scheduler.stageKey('DEEP',symbol),NOW-5_000);
  const selected=radar.selectBatch([...rows,rows[2]],NOW);
  assert.equal(selected.length,4);
  assert.equal(new Set(selected.map(x=>x.symbol)).size,4);
  assert.equal(selected.find(x=>x.symbol==='FASTUSDT')?._selection_lane,'exceptional');
  assert.equal(selected.find(x=>x.symbol==='QUIETUSDT')?._selection_lane,'quiet');
  assert.equal(selected.find(x=>x.symbol==='OVERDUEUSDT')?._selection_lane,'rotation');
  assert.equal(radar.lastSelectionDistribution.exceptional,1);
  assert.equal(radar.lastSelectionDistribution.quiet,1);
});

test('Radar 9 records no-signal and incomplete rows without counting them as failed scans',async()=>{
  let now=NOW;
  const archived=[];
  const store={
    async readScanSchedulerEvents({radar=null}={}){
      return archived.filter(x=>!radar||x.radar===radar);
    },
    async appendScanSchedulerEvents(events){archived.push(...events);return{written:events.length};}
  };
  const radar=new WhaleAccumulationRadar({
    rest:{},store,clock:()=>now,logger:silent,
    config:{topAnchors:2,rotationBatchSize:1,schedulerFastPathSlots:1,schedulerQuietAnchorSlots:1}
  });
  const rows=[
    {symbol:'QUIETUSDT',lastPrice:1,priceChange24h:.2,quoteVolume24h:5_000_000,tradeCount24h:20_000},
    {symbol:'FASTUSDT',lastPrice:2,priceChange24h:2,quoteVolume24h:4_000_000,tradeCount24h:25_000},
    {symbol:'INCOMPLETEUSDT',lastPrice:3,priceChange24h:1,quoteVolume24h:3_000_000,tradeCount24h:22_000}
  ];
  radar.universe=rows.map(x=>x.symbol);
  radar.universeAt=now;
  radar.refreshUniverse=async()=>{};
  radar.tickerRows=async()=>[...rows,rows[0]];
  radar.updateFastSnapshot=row=>row.symbol==='FASTUSDT'
    ?{volume_accel_ratio:3.2,trade_accel_ratio:2.1,price_acceleration_pct:.2}
    :row.symbol==='QUIETUSDT'
      ?{volume_accel_ratio:1.3,trade_accel_ratio:1.2,price_acceleration_pct:.04}
      :{volume_accel_ratio:1.01,trade_accel_ratio:1.01,price_acceleration_pct:.005};
  const scanned=[];
  radar.scanRow=async row=>{
    scanned.push(row.symbol);
    now+=50;
    if(row.symbol==='INCOMPLETEUSDT')return{
      eligible:false,potential_label:'DATA_INSUFFICIENT',data_status:'INCOMPLETE',
      whale_accumulation:{stage:'DATA_INSUFFICIENT'}
    };
    return{
      eligible:false,potential_label:'WATCH',data_status:'LIVE_DATA',
      whale_accumulation:{stage:'WATCH'}
    };
  };
  radar.running=true;
  await radar.tick();
  assert.equal(new Set(scanned).size,scanned.length,'a symbol is scanned at most once in a cycle');
  assert.equal(scanned.length,3,'duplicate ticker rows must not expand the selected cycle');
  const completed=archived.filter(x=>x.radar==='RADAR_9'&&x.stage==='DEEP'&&
    x.event_type==='COMPLETED'&&x.reason_code==='NO_SIGNAL_NOT_A_FAILURE');
  assert.ok(completed.length>=1);
  assert.ok(completed.every(x=>x.failure_counted===false));
  const incomplete=archived.filter(x=>x.radar==='RADAR_9'&&x.event_type==='INCOMPLETE');
  assert.equal(incomplete.length,1);
  assert.equal(incomplete[0].failure_counted,false);
  const cycle=archived.find(x=>x.radar==='RADAR_9'&&x.stage==='CYCLE');
  assert.equal(cycle.failed,0);
  assert.equal(cycle.incomplete,1);
  await radar.stop();
});

test('scheduler event timing stays causal and forward candles remain blocked by the existing data gate',()=>{
  const now=NOW;
  const journal=new ScanSchedulerJournal({radar:'RADAR_8',store:{},clock:()=>now,logger:silent});
  journal.ensureQueued('MICRO','CAUSALUSDT',now-1000);
  const selected=journal.selected('MICRO','CAUSALUSDT',{cycle:1,at:now-500,fastSeenAt:now-600});
  const started=journal.started('MICRO','CAUSALUSDT',{cycle:1,at:now-250,fastSeenAt:now-600});
  assert.ok(selected.fast_seen_at<=selected.event_at);
  assert.ok(started.fast_seen_at<=started.event_at);
  assert.ok(started.event_at>=selected.event_at);

  const future={openTime:now+900_000,closeTime:now+1_799_999,open:1,high:1.1,low:.9,close:1,volume:10,closed:false};
  assert.deepEqual(futureIssues([future],now),['FUTURE_OPEN_0']);
});
