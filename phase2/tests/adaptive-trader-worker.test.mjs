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
    candle_close_time:now-60_000,candle_close_price:1,candle_age_ms:60_000,as_of:new Date(now).toISOString(),thresholds:{no_chase:true},
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
    assert.equal(status.last_summary.current_recommendation.symbol,'PAPERUSDT');
    assert.equal(status.last_summary.current_recommendation.decision,'WAIT_FOR_CONFIRMATION');
    assert.equal(status.last_summary.current_recommendation.entry_eligible,false);
    assert.equal(status.last_summary.current_recommendation.real_order_execution,false);
    assert.equal(status.last_summary.counts.waiting_confirmation,1);
    assert.equal(status.last_summary.candidates[0].cognitive_assessment.decision,'EARLY_SETUP_REVIEW');
    assert.equal(status.last_summary.candidates[0].cognitive_assessment.entry_eligible,false);
    assert.equal(status.last_summary.candidates[0].cognitive_rank_score,76);
    assert.equal(status.cognitive_brain.journal_records,1);
    assert.equal(status.cognitive_brain.ranking_ready,false);
    assert.equal(status.cognitive_brain.probability_ready,false);
    assert.equal(status.cognitive_brain.recent_journal[0].symbol,'PAPERUSDT');
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
    assert.equal(saved.cognitive_journal.length,1);
    assert.equal(saved.cognitive_journal[0].symbol,'PAPERUSDT');
    assert.equal(saved.cognitive_journal[0].entry_eligible,false);
  }finally{
    await worker.stop();
    await rm(dir,{recursive:true,force:true});
  }
});


test('adaptive trader persists scan cursor across worker restarts and displays learned candidate score fields',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-trader-cursor-'));
  const store=await new DurableStore({dir}).init();
  const offsets=[];
  const snapshotProvider=async({limit,offset=0}={})=>{
    const scanOffset=Math.max(0,Math.trunc(Number(offset)||0))%100;
    offsets.push(scanOffset);
    const now=Date.now();
    return {
      status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date(now).toISOString(),
      universe:{eligible_spot_symbols:100,analyzed_symbols:1,valid_symbols:1,requested_limit:limit,
        scan_offset:scanOffset,scan_advance_count:40,coverage_pct:1,scan_complete:false,
        selection_lane_counts:{ROTATING_COVERAGE:1}},
      candidates:[{symbol:'CURSORUSDT',price:1,quote_volume_24h:5_000_000,change_24h_pct:1,
        score:61,tier:'WATCH',data_valid:true,data_stale:false,closed_candles_only:true,
        candle_close_time:now-60_000,candle_close_price:1,
        features:{volume_ratio:1.2,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.65,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false}],
      latest_prices:[{symbol:'CURSORUSDT',price:1,quote_volume_24h:5_000_000,change_24h_pct:1}],
      meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,
        confidence_score:'UNKNOWN',engine:'ADAPTIVE_TRADER_SIDECAR_V1'}
    };
  };
  const quietLogger={info(){},warn(){}};
  const first=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:60,logger:quietLogger});
  const second=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:60,logger:quietLogger});
  try{
    await first.start({initialDelayMs:60_000});
    const firstResult=await first.runOnce();
    assert.equal(firstResult.status,'SUCCESS');
    assert.equal(offsets[0],0);
    assert.equal(first.snapshot().scan_cursor,40);
    assert.equal(first.snapshot().scan_limit,60);
    assert.equal(first.snapshot().last_summary.candidates[0].base_score,61);
    assert.equal(first.snapshot().last_summary.candidates[0].learning_adjustment,0);
    assert.equal((await store.getAdaptiveTraderState()).scan_cursor,40);
    await first.stop();

    await second.start({initialDelayMs:60_000});
    const secondResult=await second.runOnce();
    assert.equal(secondResult.status,'SUCCESS');
    assert.equal(offsets[1],40);
    assert.equal(second.snapshot().scan_cursor,80);
    assert.equal((await store.getAdaptiveTraderState()).scan_cursor,80);
  }finally{
    await first.stop();
    await second.stop();
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
      base_score:61,tier:'NO_SETUP',closed_candle_baseline:true,training_eligible:true,
      features:{volume_ratio:1.2,taker_buy_ratio:0.49,higher_low:false,compression_ratio:1.1},outcome:null}],
    price_history:[{symbol:'TESTUSDT',price:1,at:now-60*60*1000,tier:'NO_SETUP',score:42,evaluated:true}],
    missed_movers:[]
  });
  const snapshotProvider=async()=>({
    status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date().toISOString(),
    universe:{eligible_spot_symbols:3,analyzed_symbols:3,valid_symbols:3,requested_limit:40,coverage_pct:100,scan_complete:true,
      selection_lane_counts:{EMERGING_MOVER:1,EXTENDED_MOVER_AUDIT:1,TOP_VOLUME:1}},
    candidates:[
      {symbol:'TESTUSDT',price:1.08,quote_volume_24h:5_000_000,change_24h_pct:2,score:59.5,tier:'WATCH',
        data_valid:true,data_stale:false,candle_close_time:now-60_000,candle_close_price:1.07,
        features:{volume_ratio:1.2,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.65,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1,relative_strength_vs_btc_pct:0.4},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false},
      {symbol:'BTCUSDT',price:90_000,quote_volume_24h:50_000_000,change_24h_pct:1,score:57,tier:'WATCH',
        data_valid:true,data_stale:false,candle_close_time:now-60_000,candle_close_price:89_950,
        features:{volume_ratio:1.1,trade_ratio:1.1,taker_buy_ratio:0.51,close_location:0.6,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:1.1,relative_strength_vs_btc_pct:0},
        reason_codes:['TEST_FIXTURE'],entry_eligible:false,paper_trading:true,real_order_execution:false},
      {symbol:'LATEUSDT',price:1.2,quote_volume_24h:1_200_000,change_24h_pct:12.3,score:44,tier:'LATE_MOVE',
        selection_lane:'EXTENDED_MOVER_AUDIT',data_valid:true,data_stale:false,candle_close_time:now-60_000,candle_close_price:1.19,paper_candidate:false,entry_eligible:false,
        paper_trading:true,real_order_execution:false,reason_codes:['LATE_MOVE_NO_CHASE'],
        features:{volume_ratio:2.1,trade_ratio:1.8,taker_buy_ratio:0.58,close_location:0.9,
          higher_low:false,breakout_above_prior_high:false,compression_ratio:0.8,relative_strength_vs_btc_pct:2.0}}
    ],
    closed_candle_outcomes:[{sample_id:'TESTUSDT:old',symbol:'TESTUSDT',
      at:now-5*60*60*1000,baseline_price:1,mark_price:1.08,outcome:'UP',return_pct:8,
      resolved_at:now-60*60*1000,horizon_ms:4*60*60*1000,outcome_source:'CLOSED_CANDLE_4H'}],
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
    assert.ok(status.cognitive_brain.missed_mover_feedback.some(row=>row.symbol==='TESTUSDT'&&
      row.classification==='POTENTIAL_MISSED_MOVER'&&row.no_future_data_used_for_baseline===true));
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


test('server learner records eligible and below-threshold Spot pairs outside the deep-scan batch',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-market-wide-learning-'));
  const store=await new DurableStore({dir}).init();
  const now=Date.now();
  const deep={
    symbol:'DEEPUSDT',price:10,quote_volume_24h:2_000_000,change_24h_pct:1.5,score:63,
    tier:'WATCH',data_valid:true,data_stale:false,closed_candles_only:true,candle_close_time:now-60_000,candle_close_price:10,entry_eligible:false,
    paper_trading:true,real_order_execution:false,
    features:{volume_ratio:1.2,trade_ratio:1.1,taker_buy_ratio:0.5,close_location:0.6,
      recent_15m_return_pct:0.2,trend_aligned:true,relative_strength_vs_btc_pct:0.4},
    reason_codes:['TEST_FIXTURE']
  };
  const snapshotProvider=async()=>({
    status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date(now).toISOString(),
    universe:{eligible_spot_symbols:1,monitored_spot_symbols:3,analyzed_symbols:1,valid_symbols:1,
      requested_limit:40,coverage_pct:100,scan_complete:true,scan_offset:0,scan_advance_count:1},
    candidates:[deep],
    latest_prices:[
      {symbol:'DEEPUSDT',price:10,quote_volume_24h:2_000_000,change_24h_pct:1.5,move_since_previous_pct:0.2},
      {symbol:'UNSCANNEDUSDT',price:2,quote_volume_24h:1_200_000,change_24h_pct:5.4,move_since_previous_pct:1.4},
      {symbol:'LOWVOLUSDT',price:0.5,quote_volume_24h:35_000,change_24h_pct:-1.2,move_since_previous_pct:-0.4}
    ],
    meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,
      confidence_score:'UNKNOWN',engine:'ADAPTIVE_TRADER_SIDECAR_V1'}
  });
  const worker=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:40,logger:{info(){},warn(){}}});
  try{
    await worker.start({initialDelayMs:60_000});
    const result=await worker.runOnce();
    assert.equal(result.status,'SUCCESS');
    const status=worker.snapshot();
    assert.equal(status.memory.deep_candidate_samples,1);
    assert.equal(status.memory.market_wide_samples,1);
    assert.equal(status.memory.history_rows,3);
    assert.equal(status.learning_capture.new_deep_candidate_samples,1);
    assert.equal(status.learning_capture.new_market_wide_samples,1);
    assert.ok(status.learning_profile.required_samples>=60);
    const saved=await store.getAdaptiveTraderState();
    const unscanned=saved.samples.find(row=>row.symbol==='UNSCANNEDUSDT');
    const lowVolumeSample=saved.samples.find(row=>row.symbol==='LOWVOLUSDT');
    const lowVolumeHistory=saved.price_history.find(row=>row.symbol==='LOWVOLUSDT');
    assert.equal(unscanned.observation_type,'MARKET_WIDE_TICKER');
    assert.equal(unscanned.features.change_24h_pct,5.4);
    assert.equal(lowVolumeSample,undefined,'illiquid pairs are observed but do not bias ranking calibration');
    assert.equal(lowVolumeHistory.quote_volume_24h,35_000);
    assert.equal(saved.samples.find(row=>row.symbol==='DEEPUSDT').observation_type,'DEEP_CANDIDATE');
  }finally{
    await worker.stop();
    await rm(dir,{recursive:true,force:true});
  }
});


test('worker ingests real closed-candle historical outcomes before collecting live samples',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-historical-outcomes-'));
  const store=await new DurableStore({dir}).init();
  const now=Date.now(),baselineAt=now-6*60*60*1000;
  const historicalSample={
    id:'HISTORICAL_CLOSED_CANDLE:HISTUSDT:'+String(baselineAt),
    symbol:'HISTUSDT',price:1,at:baselineAt,base_score:72,tier:'EARLY_SETUP',
    observation_type:'HISTORICAL_CLOSED_CANDLE',historical_baseline:true,training_eligible:true,
    quote_volume_24h:4_500_000,change_24h_pct:1.8,
    features:{volume_ratio:1.8,trade_ratio:1.5,taker_buy_ratio:0.59,close_location:0.72,
      higher_low:true,breakout_above_prior_high:true,compression_ratio:0.7,
      relative_strength_vs_btc_pct:0.8,recent_15m_return_pct:0.4,micro_5m_available:true,
      micro_5m_taker_buy_ratio:0.58,micro_5m_volume_ratio:1.5},
    outcome:'UP',mark_price:1.035,return_pct:3.5,
    resolved_at:baselineAt+4*60*60*1000,horizon_ms:4*60*60*1000
  };
  const snapshotProvider=async()=>({
    status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date(now).toISOString(),
    universe:{eligible_spot_symbols:1,monitored_spot_symbols:1,analyzed_symbols:0,valid_symbols:0,
      requested_limit:40,coverage_pct:0,scan_complete:false,scan_offset:0,scan_advance_count:1},
    candidates:[],
    latest_prices:[{symbol:'HISTUSDT',price:1.035,quote_volume_24h:4_500_000,change_24h_pct:3.5}],
    meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,
      confidence_score:'UNKNOWN',engine:'ADAPTIVE_TRADER_SIDECAR_V1'},
    historical_training_samples:[historicalSample]
  });
  const worker=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:40,logger:{info(){},warn(){}}});
  try{
    await worker.start({initialDelayMs:60_000});
    const result=await worker.runOnce();
    assert.equal(result.status,'SUCCESS');
    const status=worker.snapshot();
    assert.equal(status.memory.historical_samples,1);
    assert.equal(status.learning_capture.new_historical_samples,1);
    assert.equal(status.learning_profile.historical_samples,1);
    assert.equal(status.learning_profile.outcome_counts.up,1);
    assert.ok(status.memory.resolved_samples>=1);
    assert.equal(status.learning_capture.historical_input_samples,1);
    assert.equal(status.learning_capture.new_historical_samples,1);
    assert.equal(status.learning_capture.snapshot_historical_samples_available,0);
    assert.equal(status.learning_capture.historical_rejected.missing_id,0);
    assert.equal(status.learning_capture.historical_rejected.duplicate_id,0);
    assert.equal(status.learning_capture.historical_rejected.invalid_outcome,0);
    assert.equal(status.learning_capture.historical_rejected.horizon_too_short,0);
    assert.equal(status.learning_capture.resolved_samples,1);
    assert.equal(status.real_order_execution,false);
    const saved=await store.getAdaptiveTraderState();
    assert.ok(saved.samples.some(row=>row.id===historicalSample.id&&row.outcome==='UP'));
  }finally{
    await worker.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('manual worker scan accepts a valid per-request universe limit and rejects unsafe values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-adaptive-worker-limit-'));
  const store=await new DurableStore({dir}).init();
  const seen=[];
  const snapshotProvider=async({limit,offset=0}={})=>{
    seen.push({limit,offset});
    const now=Date.now();
    return {
      status:'LIVE_DATA',source:'Binance Public REST',as_of:new Date(now).toISOString(),
      universe:{eligible_spot_symbols:100,analyzed_symbols:0,valid_symbols:0,requested_limit:limit,
        scan_offset:offset,scan_advance_count:Math.max(1,limit),coverage_pct:0,scan_complete:false},
      candidates:[],latest_prices:[],
      meta:{live:true,paper_trading:true,real_order_execution:false,closed_candles_only:true,
        confidence_score:'UNKNOWN',engine:'ADAPTIVE_TRADER_SIDECAR_V1'}
    };
  };
  const worker=new AdaptiveTraderWorker({store,snapshotProvider,intervalMs:60_000,scanLimit:80,logger:{info(){},warn(){}}});
  try{
    await worker.start({initialDelayMs:60_000});
    assert.equal((await worker.runOnce({limit:20})).status,'INVALID_LIMIT');
    assert.equal(seen.length,0,'invalid request must not fetch market data');
    assert.equal((await worker.runOnce({limit:60})).status,'SUCCESS');
    assert.deepEqual(seen[0],{limit:60,offset:0});
    assert.equal(worker.snapshot().scan_limit,80,'manual per-request limit does not mutate the recurring scan limit');
    assert.equal(worker.snapshot().real_order_execution,false);
    assert.equal(worker.snapshot().paper_trading,true);
  }finally{
    await worker.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

