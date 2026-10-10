import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
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


test('Radar 8 Micro quiet-base summary survives durable archive append and reload',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-quiet-summary-archive-'));
  const at=1_800_000_000_000;
  const store=await new DurableStore({dir}).init();
  const summary={
    evaluated_total:12,pre_expansion_total:2,watch_early_total:3,
    already_extended_total:1,data_insufficient_total:2,no_signal_total:4,
    average_scan_latency_ms:740,max_scan_latency_ms:1500
  };
  const cycle={
    schema_version:SCAN_JOURNEY_SCHEMA,
    cycle_id:'RADAR8:USDT:'+at,
    cycle_number:1,radar:'RADAR_8',quote:'USDT',status:'COMPLETE',
    started_at:at,completed_at:at+2000,
    data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
    counters:{micro_selected_total:12,quiet_base_pre_expansion_micro:summary},
    coins:[{
      symbol:'ARCHIVEUSDT',eligible:true,fast_scan_at:at+100,
      micro_selected_at:at+200,micro_scan_started_at:at+300,micro_scan_completed_at:at+900,
      micro_fingerprint:{quiet_base_pre_expansion:{fingerprint:'QUIET_BASE_PRE_EXPANSION',classification:'PRE_EXPANSION',detected:true,closed_candles_only:true}},
      deep_scan_status:'DEFERRED'
    }]
  };
  const write=await store.appendScanJourneyCycle(cycle);
  assert.equal(write.duplicate,false);
  const freshStore=await new DurableStore({dir}).init();
  const restored=await freshStore.readScanJourneyCycles({limit:1});
  assert.equal(restored.length,1);
  assert.deepEqual(restored[0].counters.quiet_base_pre_expansion_micro,summary);
  assert.equal(restored[0].coins[0].micro_fingerprint.quiet_base_pre_expansion.classification,'PRE_EXPANSION');
  assert.equal(restored[0].data_policy.paper_trading,true);
  assert.equal(restored[0].data_policy.real_order_execution,false);
  assert.equal(restored[0].data_policy.closed_candles_only,true);
});
