import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {AdaptiveTraderWorker} from '../core/adaptive-trader-worker.mjs';

test('server paper portfolio records isolated trades and persists evidence without live orders',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-trader-paper-'));
  const store=await new DurableStore({dir}).init();
  const now=Date.now();
  const paperCandidate={
    symbol:'PAPERUSDT',price:1,quote_volume_24h:5_000_000,change_24h_pct:2,score:76,
    tier:'EARLY_SETUP',data_valid:true,data_stale:false,closed_candles_only:true,
    paper_candidate:true,entry_eligible:false,paper_trading:true,real_order_execution:false,
    candle_close_time:now-60_000,as_of:new Date(now).toISOString(),thresholds:{no_chase:true},
    features:{volume_ratio:2.1,trade_ratio:1.7,taker_buy_ratio:0.59,close_location:0.72,
      higher_low:true,breakout_above_prior_high:false,compression_ratio:0.7,
      hourly_return_pct:1.1,relative_strength_vs_btc_pct:0.8}
  };
  const snapshotProvider=async()=>({
    status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date().toISOString(),
    universe:{eligible_spot_symbols:1,analyzed_symbols:1,valid_symbols:1,requested_limit:40,coverage_pct:100,scan_complete:true},
    candidates:[paperCandidate],
    latest_prices:[{symbol:'PAPERUSDT',price:1,quote_volume_24h:5_000_000,change_24h_pct:2}],
    meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,
      confidence_score:'UNKNOWN',engine:'ADAPTIVE_TRADER_SIDECAR_V1'}
  });
  const worker=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:40,logger:{info(){},warn(){}}});
  try{
    await worker.start({initialDelayMs:60_000});
    const result=await worker.runOnce();
    assert.equal(result.status,'SUCCESS');
    const status=worker.snapshot();
    assert.equal(status.scanner_contract,'SERVER_DRIVEN_SCAN_V2');
    assert.equal(status.last_summary.status,'LIVE_DATA');
    assert.equal(status.last_summary.meta.live,true);
    assert.equal(status.last_summary.meta.real_order_execution,false);
    assert.ok(Array.isArray(status.last_summary.candidates));
    assert.ok(Array.isArray(status.last_summary.latest_prices));
    assert.equal(status.server_paper_portfolio.open_positions,1);
    assert.equal(status.server_paper_portfolio.starting_balance,10000);
    assert.equal(status.paper_validation_profile.ready,false);
    assert.equal(status.paper_validation_profile.resolved_paper_trades,0);
    assert.equal(status.real_order_execution,false);
    const saved=await store.getAdaptiveTraderState();
    assert.equal(saved.paper_portfolio.mode,'PAPER_ONLY');
    assert.equal(saved.paper_portfolio.real_order_execution,false);
    assert.equal(saved.paper_portfolio.open_positions.length,1);
    assert.equal(saved.paper_portfolio.open_positions[0].symbol,'PAPERUSDT');
  }finally{
    await worker.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

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
    universe:{eligible_spot_symbols:3,analyzed_symbols:3,valid_symbols:3,requested_limit:40,coverage_pct:100,scan_complete:true,
      selection_lane_counts:{EMERGING_MOVER:1,EXTENDED_MOVER_AUDIT:1,TOP_VOLUME:1}},
    candidates:[
      {symbol:'TESTUSDT',price:1.08,quote_volume_24h:5_000_000,change_24h_pct:2,score:59.5,tier:'WATCH',
        data_valid:true,data_stale:false,features:{volume_ratio:1.2,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.65,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1,relative_strength_vs_btc_pct:0.4},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false},
      {symbol:'BTCUSDT',price:90_000,quote_volume_24h:50_000_000,change_24h_pct:1,score:57,tier:'WATCH',
        data_valid:true,data_stale:false,features:{volume_ratio:1.1,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.6,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1,relative_strength_vs_btc_pct:0},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false},
      {symbol:'LATEUSDT',price:1.2,quote_volume_24h:1_200_000,change_24h_pct:12.3,score:44,tier:'LATE_MOVE',
        selection_lane:'EXTENDED_MOVER_AUDIT',data_valid:true,data_stale:false,paper_candidate:false,entry_eligible:false,
        paper_trading:true,real_order_execution:false,reason_codes:['LATE_MOVE_NO_CHASE'],
        features:{volume_ratio:2.1,trade_ratio:1.8,taker_buy_ratio:0.58,close_location:0.9,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:0.8,relative_strength_vs_btc_pct:2.0}}
    ],
    latest_prices:[
      {symbol:'TESTUSDT',price:1.08,quote_volume_24h:5_000_000,change_24h_pct:2},
      {symbol:'BTCUSDT',price:90_000,quote_volume_24h:50_000_000,change_24h_pct:1},
      {symbol:'LATEUSDT',price:1.2,quote_volume_24h:1_200_000,change_24h_pct:12.3}
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
    assert.equal(status.last_summary.counts.valid,3);
    assert.equal(status.last_summary.counts.late_move,1);
    assert.equal(status.last_summary.mover_audit.length,1);
    assert.equal(status.last_summary.mover_audit[0].symbol,'LATEUSDT');
    assert.equal(status.last_summary.mover_audit[0].selection_lane,'EXTENDED_MOVER_AUDIT');
    assert.equal(status.last_summary.mover_audit[0].quote_volume_24h,1_200_000);
    assert.equal(status.last_summary.mover_audit[0].paper_candidate,false);
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
