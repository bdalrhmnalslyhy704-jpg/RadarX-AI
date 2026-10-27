import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {AdaptiveTraderWorker} from '../core/adaptive-trader-worker.mjs';

test('background sidecar restores its own memory, resolves outcomes and records possible misses without touching radar stores',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-trader-worker-'));
  const store=await new DurableStore({dir}).init();
  const now=Date.now();
  await store.putAdaptiveTraderState({
    version:1,enabled:false,scan_count:8,successful_scans:8,
    last_started_at:now-30*60*1000,last_scan_at:now-30*60*1000,
    last_summary:null,learning_profile:null,
    samples:[{id:'TESTUSDT:old',symbol:'TESTUSDT',price:1,at:now-5*60*60*1000,
      base_score:61,tier:'NO_SETUP',features:{volume_ratio:1.2,taker_buy_ratio:0.49,higher_low:false,compression_ratio:1.1},outcome:null}],
    price_history:[{symbol:'TESTUSDT',price:1,at:now-60*60*1000,tier:'NO_SETUP',score:42,evaluated:true}],
    missed_movers:[]
  });
  const snapshotProvider=async()=>({
    status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date().toISOString(),
    universe:{eligible_spot_symbols:2,analyzed_symbols:2,valid_symbols:2,requested_limit:40,coverage_pct:100,scan_complete:true},
    candidates:[
      {symbol:'TESTUSDT',price:1.08,quote_volume_24h:5_000_000,change_24h_pct:2,score:59.5,tier:'WATCH',
        data_valid:true,data_stale:false,features:{volume_ratio:1.2,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.65,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1,relative_strength_vs_btc_pct:0.4},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false},
      {symbol:'BTCUSDT',price:90_000,quote_volume_24h:50_000_000,change_24h_pct:1,score:57,tier:'WATCH',
        data_valid:true,data_stale:false,features:{volume_ratio:1.1,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.6,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1,relative_strength_vs_btc_pct:0},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false}
    ],
    latest_prices:[
      {symbol:'TESTUSDT',price:1.08,quote_volume_24h:5_000_000,change_24h_pct:2},
      {symbol:'BTCUSDT',price:90_000,quote_volume_24h:50_000_000,change_24h_pct:1}
    ],
    meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,
      confidence_score:'UNKNOWN',engine:'ADAPTIVE_TRADER_SIDECAR_V1'}
  });
  const worker=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:40,logger:{info(){},warn(){}}});
  try{
    const started=await worker.start({initialDelayMs:60_000});
    assert.equal(started.enabled,true);
    const result=await worker.runOnce();
    assert.equal(result.status,'SUCCESS');
    const status=worker.snapshot();
    assert.equal(status.successful_scans,9);
    assert.equal(status.last_summary.counts.valid,2);
    assert.equal(status.memory.resolved_samples,1);
    assert.ok(status.missed_movers.some(row=>row.symbol==='TESTUSDT'&&row.classification==='POTENTIAL_MISSED_MOVER'));
    assert.equal(status.real_order_execution,false);
    assert.equal(status.paper_trading,true);

    const saved=await store.getAdaptiveTraderState();
    assert.equal(saved.successful_scans,9);
    assert.ok(saved.samples.some(row=>row.id==='TESTUSDT:old'&&row.outcome==='UP'));
    assert.ok(saved.price_history.length>=2);
    assert.equal(saved.last_summary.counts.early_setup,0);
    assert.equal((await store.getSubscriptions()).length,0);
    assert.deepEqual(await store.readJson(store.files.moveAlerts),{});
  }finally{
    await worker.stop();
    await rm(dir,{recursive:true,force:true});
  }
});
