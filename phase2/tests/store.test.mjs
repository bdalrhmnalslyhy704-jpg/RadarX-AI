import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,stat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {SCAN_JOURNEY_SCHEMA} from '../core/scan-journey-ledger.mjs';

test('TEST_FIXTURE: durable settings subscriptions and audit jsonl survive a fresh read',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-phase2-store-'));
  const store=await new DurableStore({dir}).init();
  const settings={enabled:true,symbols:['BTCUSDT'],timeframes:['15m'],minDataQuality:70,minLiquidityQuality:60,signalTypes:['CONFIRMED']};
  await store.putUserSettings('u1',settings);
  assert.equal((await store.getUserSettings('u1')).enabled,true);
  await store.upsertSubscription('u1',{endpoint:'https://push.example.test/x',expirationTime:null,keys:{p256dh:'TEST_FIXTURE_P256DH',auth:'TEST_FIXTURE_AUTH'}});
  assert.equal((await store.getSubscriptions('u1')).length,1);
  await store.appendNotificationAudit({signal_id:'TEST_FIXTURE',user_id:'u1',status:'SENT'});
  const rows=await store.readRecent('notifications',10);
  assert.equal(rows[0].signal_id,'TEST_FIXTURE');assert.equal(rows[0].status,'SENT');
});


test('TEST_FIXTURE: Radar 4 alert log survives fresh reads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-radar4-store-'));
  const store=await new DurableStore({dir}).init();
  const alert={id:'TEST_RADAR4',event:'LIQUIDITY_ABSORPTION_ALERT',radar:'LIQUIDITY_ABSORPTION_RADAR',symbol:'TESTUSDT',processed_at:Date.now(),detected_time_12h:'12:00:01 ص'};
  await store.appendLiquidityAbsorptionAlert(alert);
  const rows=await store.readLiquidityAbsorptionAlerts({sinceMs:0,limit:10});
  assert.equal(rows.length,1);assert.equal(rows[0].radar,'LIQUIDITY_ABSORPTION_RADAR');assert.equal(rows[0].symbol,'TESTUSDT');
});

test('TEST_FIXTURE: Falcon Eye alert history replays oldest-first after an offline period',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-falcon-replay-'));
  const store=await new DurableStore({dir}).init();
  for (const at of [1000,2000,3000]) {
    await store.appendFalconEyeAlert({
      id:'FALCON:TESTUSDT:'+at,radar:'FALCON_EYE_RADAR',symbol:'TESTUSDT',
      price:0.1234+at/100000,detected_at:at,processed_at:at,
      paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'
    });
  }
  const first=await store.readFalconEyeAlerts({sinceMs:0,limit:2});
  assert.deepEqual(first.map(x=>x.processed_at),[1000,2000]);
  assert.equal(first[0].price,0.1334);
  const next=await store.readFalconEyeAlerts({sinceMs:first[1].processed_at,limit:2});
  assert.deepEqual(next.map(x=>x.processed_at),[3000]);
});


test('durable alert replay pages preserve the full archive, oldest-first order, and same-time cursor boundaries',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-alert-replay-page-'));
  const store=await new DurableStore({dir}).init();
  for(let i=0;i<620;i++){
    const at=100000+Math.floor(i/3);
    await store.appendFalconEyeAlert({
      id:'FALCON:'+String(i).padStart(4,'0'),radar:'FALCON_EYE_RADAR',symbol:'TESTUSDT',
      processed_at:at,detected_at:at,price:0.1234,paper_trading:true,real_order_execution:false
    });
  }
  const first=await store.readAlertPage('falconEyeAlerts',{sinceMs:0,radar:'FALCON_EYE_RADAR',limit:100});
  assert.equal(first.length,100);
  assert.equal(first[0].id,'FALCON:0000');
  assert.equal(first[99].id,'FALCON:0099');
  assert.ok(first[99].replay_cursor_id.endsWith('|FALCON:0099'));
  const second=await store.readAlertPage('falconEyeAlerts',{
    sinceMs:first[99].replay_cursor_at,sinceId:first[99].replay_cursor_id,
    radar:'FALCON_EYE_RADAR',limit:100
  });
  assert.equal(second.length,100);
  assert.equal(second[0].id,'FALCON:0100','same-timestamp items after the page boundary must not be skipped');
  assert.equal(second[99].id,'FALCON:0199');
  const all=[...first,...second];
  let cursorAt=second[99].replay_cursor_at,cursorId=second[99].replay_cursor_id;
  while(all.length<620){
    const next=await store.readAlertPage('falconEyeAlerts',{sinceMs:cursorAt,sinceId:cursorId,radar:'FALCON_EYE_RADAR',limit:100});
    assert.ok(next.length>0,'the persisted cursor must continue through the archive');
    all.push(...next);
    cursorAt=next[next.length-1].replay_cursor_at;
    cursorId=next[next.length-1].replay_cursor_id;
  }
  assert.equal(all.length,620);
  assert.equal(new Set(all.map(x=>x.id)).size,620);
  assert.equal(all[619].id,'FALCON:0619');
});

test('scheduler archive hydrates each radar independently when another radar dominates the newest rows',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scheduler-partition-read-'));
  const store=await new DurableStore({dir}).init();
  await store.appendScanSchedulerEvents([
    {radar:'RADAR_9',stage:'DEEP',symbol:'QUIETUSDT',event_type:'DEFERRED',event_at:1000,queued_at:400},
    {radar:'RADAR_9',stage:'DEEP',symbol:'QUIETUSDT',event_type:'STARTED',event_at:2000,queued_at:400,started_at:2000},
    {radar:'RADAR_9',stage:'DEEP',symbol:'QUIETUSDT',event_type:'COMPLETED',event_at:3000,queued_at:400,started_at:2000}
  ]);
  const noisyRadar=Array.from({length:6005},(_,i)=>({
    radar:'RADAR_8',stage:'FAST',symbol:'COIN'+i+'USDT',event_type:'COMPLETED',
    event_at:4000+i,queued_at:4000+i,started_at:4000+i
  }));
  await store.appendScanSchedulerEvents(noisyRadar);
  const radar9=await store.readScanSchedulerEvents({radar:'RADAR_9',limit:100});
  assert.equal(radar9.length,3,'Radar 8 ticker volume must not evict Radar 9 history');
  assert.deepEqual(radar9.map(x=>x.event_type),['DEFERRED','STARTED','COMPLETED']);
  assert.deepEqual(radar9.map(x=>x.event_at),[1000,2000,3000]);
  const radar8=await store.readScanSchedulerEvents({radar:'RADAR_8',limit:2});
  assert.equal(radar8.length,2);
  assert.deepEqual(radar8.map(x=>x.symbol),['COIN6003USDT','COIN6004USDT']);
});


test('scheduler journal automatically compacts its tail per radar before unbounded growth',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scheduler-bounded-archive-'));
  const store=await new DurableStore({dir}).init();
  await store.appendScanSchedulerEvents([
    {radar:'RADAR_9',stage:'DEEP',symbol:'OLDERUSDT',event_type:'DEFERRED',event_at:1000,queued_at:400},
    {radar:'RADAR_9',stage:'DEEP',symbol:'OLDERUSDT',event_type:'STARTED',event_at:2000,queued_at:400,started_at:2000},
    {radar:'RADAR_9',stage:'DEEP',symbol:'OLDERUSDT',event_type:'COMPLETED',event_at:3000,queued_at:400,started_at:2000}
  ]);
  const noisy=Array.from({length:20000},(_,i)=>({
    radar:'RADAR_8',stage:'FAST',symbol:'COIN'+i+'USDT',event_type:'COMPLETED',
    event_at:4000+i,queued_at:4000+i,started_at:4000+i,evidence:'x'.repeat(600)
  }));
  await store.appendScanSchedulerEvents(noisy);
  const file=store.files.schedulerEvents;
  const before=(await stat(file)).size;
  assert.ok(before>12*1024*1024,'fixture must cross the automatic compaction threshold');
  await store.appendScanSchedulerEvents([{
    radar:'RADAR_8',stage:'FAST',symbol:'AFTER_COMPACTION_USDT',event_type:'COMPLETED',
    event_at:30000,queued_at:30000,started_at:30000
  }]);
  const after=(await stat(file)).size;
  assert.ok(after<before/2,'automatic compaction should materially reduce journal size');
  const radar8=await store.readScanSchedulerEvents({radar:'RADAR_8',limit:5000});
  assert.ok(radar8.length>0&&radar8.length<5000,'keeps a bounded recent tail within the per-radar byte ceiling');
  assert.equal(radar8.at(-1).symbol,'AFTER_COMPACTION_USDT');
  assert.equal(radar8.at(-2).symbol,'COIN19999USDT');
  const radar9=await store.readScanSchedulerEvents({radar:'RADAR_9',limit:100});
  assert.equal(radar9.length,3,'per-radar history must remain available');
  assert.deepEqual(radar9.map(x=>x.event_type),['DEFERRED','STARTED','COMPLETED']);
});

test('Kahir alert audit writes valid newline-delimited JSON events',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-kahir-jsonl-'));
  const store=await new DurableStore({dir}).init();
  await store.appendKahirAlert({id:'KAHIR:AAAUSDT:1',symbol:'AAAUSDT',processed_at:1});
  await store.appendKahirAlert({id:'KAHIR:BBBUSDT:2',symbol:'BBBUSDT',processed_at:2});
  const rows=(await store.readRecent('kahirAlerts',10)).sort((a,b)=>a.processed_at-b.processed_at);
  assert.equal(rows.length,2,'each alert must be a separate JSONL row');
  assert.deepEqual(rows.map(x=>x.symbol),['AAAUSDT','BBBUSDT']);
});


test('startup removes only abandoned atomic-write temporary files before archive writers start',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-startup-temp-cleanup-'));
  const journeys=join(dir,'scan-journeys');
  await mkdir(journeys,{recursive:true});
  const abandonedJson=join(dir,'pre-expansion-outcomes.json.tmp-14-12345');
  const abandonedScheduler=join(dir,'scan-scheduler-events.jsonl.compact-14-12346');
  const abandonedJourney=join(journeys,'cycle.json.gz.tmp-14-12347');
  const unrelated=join(dir,'user-notes.tmp-important');
  const source=join(journeys,'cycle.json.gz');
  await writeFile(abandonedJson,'partial-json-write');
  await writeFile(abandonedScheduler,'partial-compaction');
  await writeFile(abandonedJourney,'partial-cycle');
  await writeFile(unrelated,'keep-me');
  await writeFile(source,'durable-archive');
  const store=await new DurableStore({dir}).init();
  assert.equal(store.tempCleanup.deleted_files,3);
  assert.equal(store.tempCleanup.freed_bytes,Buffer.byteLength('partial-json-write')+Buffer.byteLength('partial-compaction')+Buffer.byteLength('partial-cycle'));
  assert.equal(store.tempCleanup.failed_files,0);
  await assert.rejects(readFile(abandonedJson));
  await assert.rejects(readFile(abandonedScheduler));
  await assert.rejects(readFile(abandonedJourney));
  assert.equal(await readFile(unrelated,'utf8'),'keep-me');
  assert.equal(await readFile(source,'utf8'),'durable-archive');
});


test('large pre-expansion outcome ledger writes compact, valid JSON and remains updateable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-outcome-compact-'));
  const store=await new DurableStore({dir}).init();
  const state={
    version:'PRE_EXPANSION_OUTCOMES_V2',
    records:Array.from({length:5000},(_,i)=>({
      signal_id:'RADAR8:TEST'+i+'USDT:'+i,
      radar:'RADAR_8',
      symbol:'TEST'+i+'USDT',
      signal_type:'WATCH_EARLY',
      detected_at:1700000000000+i,
      entry_price:1+i/10000,
      evaluation_eligible:true,
      marks:{'5m':null,'15m':null,'30m':null,'60m':null,'4h':null,'24h':null},
      horizon_status:{'5m':{status:'PENDING',reason:'WAITING_FOR_HORIZON'},
        '15m':{status:'PENDING',reason:'WAITING_FOR_HORIZON'},
        '30m':{status:'PENDING',reason:'WAITING_FOR_HORIZON'},
        '60m':{status:'PENDING',reason:'WAITING_FOR_HORIZON'},
        '4h':{status:'PENDING',reason:'WAITING_FOR_HORIZON'},
        '24h':{status:'PENDING',reason:'WAITING_FOR_HORIZON'}},
      initial_metrics:{rvol:1.24,volume_ratio:1.31,trade_ratio:1.18},
      reason_codes:['RVOL_5M_ACCELERATION','NEAR_5M_RESISTANCE']
    })),
    last_stage_by_key:{'RADAR_8|TEST0USDT':{stage:'WATCH_EARLY',last_recorded_at:1700000000000}},
    last_price_update_at:0,last_report_log_at:0,last_historical_import_at:0,
    last_historical_backfill_at:0,updated_at:1700000000000
  };
  await store.updatePreExpansionOutcomes(()=>state);
  const saved=await readFile(store.files.preExpansionOutcomes,'utf8');
  assert.equal(JSON.parse(saved).records.length,5000);
  assert.ok(saved.startsWith('{"version":"PRE_EXPANSION_OUTCOMES_V2"'),
    'large outcome ledger should be written in compact JSON');
  assert.ok(Buffer.byteLength(saved)<Buffer.byteLength(JSON.stringify(state,null,2)),
    'compact serialization should avoid large pretty-print overhead');
  await store.updatePreExpansionOutcomes(current=>({...current,updated_at:1700000000123}));
  const next=JSON.parse(await readFile(store.files.preExpansionOutcomes,'utf8'));
  assert.equal(next.records.length,5000,'update must preserve every bounded record');
  assert.equal(next.updated_at,1700000000123);
});


test('scan-journey candle history rehydrates only newest fresh continuous closed data without archive mutation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-journey-candle-rehydrate-'));
  try{
    const store=await new DurableStore({dir}).init();
    const step=5*60_000,now=1_900_000_000_000;
    const makeBars=(asOf,count=72)=>{
      const aligned=Math.floor(asOf/step)*step-step;
      const first=aligned-(count-1)*step;
      return Array.from({length:count},(_,index)=>{
        const open=first+index*step;
        return {open_time:open,close_time:open+step-1,open:100,high:101,low:99,close:100,
          volume:10,quote_volume:1000,trade_count:20,taker_buy_base_volume:5};
      });
    };
    const append=async({id,completedAt,coins})=>store.appendScanJourneyCycle({
      schema_version:SCAN_JOURNEY_SCHEMA,cycle_id:id,cycle_number:1,radar:'RADAR_8',quote:'USDT',
      status:'COMPLETE',started_at:completedAt-1000,completed_at:completedAt,
      data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
      counters:{},coins
    });
    await append({id:'RADAR8:USDT:REHYDRATE:OLD',completedAt:now-60*60_000,coins:[
      {symbol:'OLDUSDT',eligible:true,candles_used:{'5m':makeBars(now-60*60_000)}}
    ]});
    const broken=makeBars(now);
    broken.splice(32,1);
    await append({id:'RADAR8:USDT:REHYDRATE:CURRENT',completedAt:now,coins:[
      {symbol:'FRESHUSDT',eligible:true,candles_used:{'5m':makeBars(now)}},
      {symbol:'BROKENUSDT',eligible:true,candles_used:{'5m':broken}}
    ]});
    const before=await store.getScanJourneyState();
    const result=await store.readScanJourneyCandleHistory({
      symbols:['FRESHUSDT','OLDUSDT','BROKENUSDT','NOSNAPSHOTUSDT'],timeframe:'5m',
      minCandles:60,maxCandles:72,maxCycles:20,maxAgeMs:8*60_000,now
    });
    assert.equal(result.requested_symbols,4);
    assert.equal(result.hydrated_symbols,1);
    assert.equal(result.series.FRESHUSDT.length,72);
    assert.ok(result.series.FRESHUSDT.every(candle=>candle.source==='BINANCE_PUBLIC_REST_CACHE'));
    assert.ok(result.series.FRESHUSDT.every(candle=>candle.closed===true&&candle.closeTime<=now));
    assert.equal(result.stale_symbols,1,'older archive candles must not be treated as live');
    assert.equal(result.invalid_symbols,1,'a gap in the newest stored candle sequence must be rejected');
    assert.equal(result.missing_snapshot_symbols,1,'symbols with no persisted candle snapshot remain unavailable');
    assert.equal(result.invalid_cycles,0);
    const after=await store.getScanJourneyState();
    assert.equal(after.cycle_sequence,before.cycle_sequence,'rehydration is read-only');
    assert.equal(after.compressed_bytes,before.compressed_bytes,'rehydration must not mutate or rewrite the archive');
    const audit=await store.verifyScanJourneyArchive();
    assert.equal(audit.complete,true,'bad market data in a row is not the same as a damaged archive file');
  }finally{
    await import('node:fs/promises').then(fs=>fs.rm(dir,{recursive:true,force:true}));
  }
});
