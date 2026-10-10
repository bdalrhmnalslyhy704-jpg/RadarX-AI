import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {closedCandleSnapshot,INCOMPLETE,incompleteHorizons,makeScanJourneyCycleId,SCAN_JOURNEY_SCHEMA,validateScanJourneyCycle,scanJourneyOutcomesFromRecord,summarizeScanJourneyOutcomes} from '../core/scan-journey-ledger.mjs';
import {DurableStore} from '../core/store.mjs';

const t0=1_800_000_000_000;
function candle(at,overrides={}) {
  return {openTime:at,closeTime:at+60_000,open:10,high:11,low:9,close:10.5,volume:100,quoteVolume:1050,tradeCount:7,takerBuyBaseVolume:53,closed:true,...overrides};
}
function cycle(at,n,symbols=[{symbol:'AAAUSDT',deep:false}]) {
  return {
    schema_version:SCAN_JOURNEY_SCHEMA,cycle_id:makeScanJourneyCycleId('USDT',at),cycle_number:n,
    radar:'RADAR_8',quote:'USDT',started_at:at,completed_at:at+10_000,
    data_policy:{closed_candles_only:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
    counters:{eligible_total:symbols.length,fast_scanned_total:symbols.length,micro_scanned_total:symbols.length,deep_scanned_total:symbols.filter(x=>x.deep).length},
    coins:symbols.map(x=>({
      symbol:x.symbol,eligible:true,eligibility_at:at,fast_scan_at:at,
      first_eligible_at:at, micro_scan_completed_at:at+3000,
      deep_scan_status:x.deep?'COMPLETED':INCOMPLETE,deep_scan_completed_at:x.deep?at+8000:INCOMPLETE,
      ticker:{price:10},candles_used:x.deep?{'1m':[{open_time:at-60_000,close_time:at,open:10,high:11,low:9,close:10.5,volume:100,quote_volume:1050,trade_count:7,taker_buy_base_volume:53}]}:{'1m':INCOMPLETE},
      outcomes:incompleteHorizons('NOT_MATURED')
    }))
  };
}

test('closed candle snapshot excludes future, still-open and malformed candles',()=>{
  const now=t0+60_000;
  const snapshot=closedCandleSnapshot([
    candle(t0),
    candle(t0+60_000,{closed:false}),
    candle(t0+120_000),
    candle(t0,{high:9}),
  ],now);
  assert.equal(snapshot.length,1);
  assert.equal(snapshot[0].close_time,t0+60_000);
  assert.equal(snapshot[0].quote_volume,1050);
  assert.equal(snapshot[0].trade_count,7);
});

test('scan journey validation rejects future and unclosed candle rows',()=>{
  const good=cycle(t0,1,[{symbol:'AAAUSDT',deep:true}]);
  const future=structuredClone(good);
  future.coins[0].candles_used['1m'][0].close_time=future.completed_at+1;
  assert.equal(validateScanJourneyCycle(future).valid,false);
  assert.ok(validateScanJourneyCycle(future).errors.some(x=>x.startsWith('FUTURE_CANDLE:')));
  const open=structuredClone(good);
  open.coins[0].candles_used['1m'][0].closed=false;
  assert.equal(validateScanJourneyCycle(open).valid,false);
  assert.ok(validateScanJourneyCycle(open).errors.some(x=>x.startsWith('UNCLOSED_CANDLE:')));
  const futureStage=structuredClone(good);
  futureStage.coins[0].eligibility_at=futureStage.completed_at+1;
  assert.equal(validateScanJourneyCycle(futureStage).valid,false);
  assert.ok(validateScanJourneyCycle(futureStage).errors.some(x=>x.startsWith('FUTURE_TIMESTAMP:')));
});

test('INCOMPLETE horizon values are explicit and never invented',()=>{
  const values=incompleteHorizons('NO_CLOSED_CANDLE');
  for(const horizon of ['5m','15m','30m','60m','4h','24h']){
    assert.equal(values[horizon].status,'.INCOMPLETE');
    assert.equal(values[horizon].return_pct,'.INCOMPLETE');
    assert.equal(values[horizon].mark_price,'.INCOMPLETE');
    assert.equal(values[horizon].reason,'NO_CLOSED_CANDLE');
  }
});

test('tracked outcomes distinguish pending, complete, partial and untracked horizons',()=>{
  const record={signal_id:'SIGNAL-AAA',marks:{},horizon_status:{},excursions:{}};
  for(const h of ['5m','15m','30m','60m','4h','24h']){
    record.horizon_status[h]={status:'PENDING',reason:'WAITING_FOR_HORIZON'};
    record.excursions[h]={source:'HISTORICAL_CLOSED_OHLC',complete:false,max_favorable_pct:null,max_adverse_pct:null};
  }
  record.marks['5m']={sample_quality:'HISTORICAL_CLOSED_OHLC',price:10.2,observed_at:t0+300_000,return_pct:2};
  record.horizon_status['5m']={status:'COMPLETE'};
  record.excursions['5m']={source:'HISTORICAL_CLOSED_OHLC',complete:true,max_favorable_pct:3,max_adverse_pct:-1};
  const outcomes=scanJourneyOutcomesFromRecord(record);
  assert.equal(outcomes['5m'].status,'COMPLETE');
  assert.equal(outcomes['5m'].return_pct,2);
  assert.equal(outcomes['15m'].status,'PENDING');
  assert.equal(outcomes['15m'].return_pct,INCOMPLETE);
  assert.equal(outcomes['15m'].reason,'WAITING_FOR_HORIZON');
  assert.equal(outcomes['24h'].status,'PENDING');
  const summary=summarizeScanJourneyOutcomes([
    {symbol:'AAAUSDT',outcome_signal_id:'SIGNAL-AAA',outcomes},
    {symbol:'BBBUSDT',outcome_signal_id:INCOMPLETE,outcomes:incompleteHorizons()}
  ]);
  assert.equal(summary.tracked_total,1);
  assert.equal(summary.untracked_total,1);
  assert.equal(summary.by_horizon['5m'].complete,1);
  assert.equal(summary.by_horizon['15m'].pending,1);
});

test('archived outcome horizons update idempotently as closed-candle results mature',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scan-journey-outcome-refresh-'));
  const store=await new DurableStore({dir}).init();
  const first=cycle(t0,1,[{symbol:'AAAUSDT',deep:true},{symbol:'BBBUSDT',deep:false}]);
  first.coins[0].outcome_signal_id='SIGNAL-AAA';
  const saved=await store.appendScanJourneyCycle(first);
  assert.equal((await store.verifyScanJourneyArchive()).complete,true);
  const outcome={signal_id:'SIGNAL-AAA',marks:{},horizon_status:{},excursions:{}};
  for(const h of ['5m','15m','30m','60m','4h','24h']){
    const ms=h==='5m'?300_000:h==='15m'?900_000:h==='30m'?1_800_000:h==='60m'?3_600_000:h==='4h'?14_400_000:86_400_000;
    outcome.marks[h]={sample_quality:'HISTORICAL_CLOSED_OHLC',price:10.2,observed_at:t0+ms,return_pct:2};
    outcome.horizon_status[h]={status:'COMPLETE',reason:null};
    outcome.excursions[h]={source:'HISTORICAL_CLOSED_OHLC',complete:true,max_favorable_pct:3,max_adverse_pct:-1};
  }
  const now=t0+90_000_000;
  const refresh=await store.refreshScanJourneyOutcomes([outcome],{limit:10,now,checkIntervalMs:5_000});
  assert.equal(refresh.updated_cycles,1);
  assert.equal(refresh.updated_coin_rows,1);
  assert.equal(refresh.retained_cycles,1);
  const reloaded=await store.readScanJourneyCycles({limit:5});
  assert.equal(reloaded[0].coins[0].outcomes['5m'].return_pct,2);
  assert.equal(reloaded[0].coins[0].outcomes['24h'].status,'COMPLETE');
  assert.equal(reloaded[0].coins[1].outcomes['5m'].status,INCOMPLETE);
  assert.equal(reloaded[0].counters.outcomes_tracked_total,1);
  assert.equal(reloaded[0].counters.outcomes_untracked_total,1);
  assert.equal((await store.verifyScanJourneyArchive()).complete,true);
  const again=await store.refreshScanJourneyOutcomes([outcome],{limit:10,now:now+5_000,checkIntervalMs:5_000});
  assert.equal(again.updated_cycles,0);
  const after=await store.getScanJourneyState();
  assert.equal(after.cycle_sequence,saved.cycle_sequence);
  assert.equal(after.retained_coin_rows,2);
});

test('compressed journey archive survives a fresh DurableStore and repeated writes are idempotent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scan-journey-restart-'));
  const store1=await new DurableStore({dir}).init();
  const first=cycle(t0,1,[{symbol:'AAAUSDT',deep:true},{symbol:'BBBUSDT',deep:false}]);
  const wrote=await store1.appendScanJourneyCycle(first);
  assert.equal(wrote.duplicate,false);
  assert.equal(wrote.retained_cycles,1);
  assert.equal(wrote.retained_coin_rows,2);
  const duplicate=await store1.appendScanJourneyCycle(first);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.retained_cycles,1);
  assert.equal(duplicate.retained_coin_rows,2);

  const store2=await new DurableStore({dir}).init();
  const state=await store2.getScanJourneyState();
  const reloaded=await store2.readScanJourneyCycles({limit:5});
  assert.equal(state.total_recorded_cycles,1);
  assert.equal(state.cycle_sequence,1);
  assert.equal(state.retained_coin_rows,2);
  assert.equal(reloaded.length,1);
  assert.equal(reloaded[0].coins.length,2);
  assert.equal(reloaded[0].coins[0].symbol,'AAAUSDT');
  assert.equal(reloaded[0].coins[0].candles_used['1m'][0].close_time,t0);
  assert.equal(state.last_deep_cycle_by_symbol.AAAUSDT,1);
  assert.equal(state.last_deep_cycle_by_symbol.BBBUSDT,undefined);
});

test('last deep scan and eligible age state survive restart and remain fair across cycles',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scan-journey-fairness-'));
  const store1=await new DurableStore({dir}).init();
  await store1.appendScanJourneyCycle(cycle(t0,1,[{symbol:'AAAUSDT',deep:true},{symbol:'BBBUSDT',deep:false}]));
  await store1.appendScanJourneyCycle(cycle(t0+60_000,2,[{symbol:'AAAUSDT',deep:false},{symbol:'BBBUSDT',deep:true}]));
  const store2=await new DurableStore({dir}).init();
  const state=await store2.getScanJourneyState();
  assert.equal(state.cycle_sequence,2);
  assert.equal(state.last_deep_cycle_by_symbol.AAAUSDT,1);
  assert.equal(state.last_deep_cycle_by_symbol.BBBUSDT,2);
  assert.equal(state.last_deep_at_by_symbol.AAAUSDT,t0+8000);
  assert.equal(state.last_deep_at_by_symbol.BBBUSDT,t0+68_000);
  assert.equal(state.eligible_since_by_symbol.AAAUSDT,t0);
  assert.equal(state.eligible_since_by_symbol.BBBUSDT,t0);
  assert.equal((await store2.readScanJourneyCycles({limit:5})).length,2);
});


test('archive verifier detects a lost cycle and a repeated write repairs it without double-counting',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scan-journey-loss-'));
  const store1=await new DurableStore({dir}).init();
  const first=cycle(t0,1,[{symbol:'AAAUSDT',deep:true},{symbol:'BBBUSDT',deep:false}]);
  const saved=await store1.appendScanJourneyCycle(first);
  assert.equal((await store1.verifyScanJourneyArchive()).complete,true);
  const state=await store1.getScanJourneyState();
  const filepath=join(store1.scanJourneyDir,state.cycles[0].filename);
  await rm(filepath);
  const damaged=await store1.verifyScanJourneyArchive();
  assert.equal(damaged.complete,false);
  assert.deepEqual(damaged.missing_cycles,[first.cycle_id]);
  assert.equal(damaged.readable_coin_rows,0);
  const repaired=await store1.appendScanJourneyCycle(first);
  assert.equal(repaired.duplicate,true);
  assert.equal(repaired.repaired,true);
  const verified=await store1.verifyScanJourneyArchive();
  assert.equal(verified.complete,true);
  assert.equal(verified.readable_cycles,1);
  assert.equal(verified.readable_coin_rows,2);
  const after=await store1.getScanJourneyState();
  assert.equal(after.total_recorded_cycles,1);
  assert.equal(after.retained_coin_rows,2);
  assert.equal(after.cycle_sequence,saved.cycle_sequence);
});


test('temporary ticker omission preserves queue age; an observed liquidity failure resets it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radarx-scan-journey-age-'));
  const store=await new DurableStore({dir}).init();
  await (await store).appendScanJourneyCycle(cycle(t0,1,[{symbol:'AAAUSDT',deep:false}]));
  const missing=cycle(t0+60_000,2,[{symbol:'AAAUSDT',deep:false}]);
  missing.coins[0].eligible=false;
  missing.coins[0].eligibility_at=INCOMPLETE;
  missing.coins[0].first_eligible_at=INCOMPLETE;
  missing.coins[0].fast_scan_at=INCOMPLETE;
  missing.coins[0].ticker=INCOMPLETE;
  missing.coins[0].rejection_reason='TICKER_MISSING_FROM_RECEIVED_UNIVERSE';
  await store.appendScanJourneyCycle(missing);
  assert.equal((await store.getScanJourneyState()).eligible_since_by_symbol.AAAUSDT,t0);

  const liquidityFail=cycle(t0+120_000,3,[{symbol:'AAAUSDT',deep:false}]);
  liquidityFail.coins[0].eligible=false;
  liquidityFail.coins[0].rejection_reason='BELOW_MIN_QUOTE_VOLUME_24H';
  await store.appendScanJourneyCycle(liquidityFail);
  assert.equal((await store.getScanJourneyState()).eligible_since_by_symbol.AAAUSDT,undefined);
});
