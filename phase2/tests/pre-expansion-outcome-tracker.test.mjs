import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableStore} from '../core/store.mjs';
import {
  buildPreExpansionOutcomeReport,
  classifyEvaluationMarketRegime,
  evaluateHistoricalPreExpansionSignal,
  importHistoricalPreExpansionSignals,
  backfillHistoricalPreExpansionOutcomes,
  recordPreExpansionSignals,
  updatePreExpansionMarkouts,
  maybeLogPreExpansionOutcomeReport
} from '../core/pre-expansion-outcome-tracker.mjs';

const NOW=1_900_000_000_000;
async function withStore(fn){
  const dir=await mkdtemp(join(tmpdir(),'radarx-preexp-outcomes-'));
  try{const store=await new DurableStore({dir}).init();await fn(store);}
  finally{await rm(dir,{recursive:true,force:true});}
}
function signal({radar='EARLY_EXPANSION_RADAR',symbol='ABCUSDT',stage='PRE_EXPANSION',at=NOW,price=100,move=1.2,regime=null,metrics={},score=66}={}){
  const alert={
    id:radar+':'+symbol+':'+stage+':'+at,radar,symbol,price,price_change_24h:move,
    early_expansion_score:score,pre_expansion_stage:stage,decision_band:stage,data_quality:88,detected_at:at,
    reason_codes:['HIGHER_LOW_SEQUENCE','VOLUME_PARTICIPATION_IMPROVING'],
    metrics:{
      price_change_5m_pct:.2,price_change_10m_pct:.35,price_change_15m_pct:.5,
      relative_strength_vs_btc_pct:.1,volume_ratio:1.3,trade_ratio:1.2,atr_ratio:.8,
      five_min_resistance:105,...metrics
    },
    risk_flags:[],closed_candles_only:true,source:'test-public-candle-fixture'
  };
  if(regime)alert.market_regime_label=regime;
  if(radar==='FALCON_EYE_RADAR')alert.falcon_eye={pre_expansion_fingerprint:{data_ready:true},reasons:['BASE_AND_PARTICIPATION']};
  return alert;
}
function candle(openTime,close,{step=60_000,high=close+.1,low=close-.1,open=close-.02,volume=1000}={}){
  return {openTime,closeTime:openTime+step-1,open,high,low,close,volume,quoteVolume:close*volume,closed:true};
}

test('DurableStore migrates legacy archive files without overwriting persistent data and survives re-open',async()=>{
  const root=await mkdtemp(join(tmpdir(),'radarx-archive-migration-'));
  try{
    const legacyDir=join(root,'legacy'),persistentDir=join(root,'persistent');
    const legacy=await new DurableStore({dir:legacyDir}).init();
    await legacy.updatePreExpansionOutcomes(()=>({
      version:'PRE_EXPANSION_OUTCOMES_V2',
      records:[{signal_id:'archive-canary',radar:'RADAR_8',symbol:'CANARYUSDT',
        created_at:NOW,detected_at:NOW,entry_price:1,marks:{},horizon_status:{},outcome_status:'PENDING'}],
      last_stage_by_key:{},last_price_update_at:0,last_report_log_at:0,
      last_historical_import_at:0,last_historical_backfill_at:0,updated_at:NOW
    }));
    const persistent=await new DurableStore({dir:persistentDir}).init({legacyDir});
    assert.ok(persistent.migratedFiles.includes('pre-expansion-outcomes.json'));
    const first=await persistent.getPreExpansionOutcomes();
    assert.equal(first.records.length,1);
    assert.equal(first.records[0].signal_id,'archive-canary');
    await persistent.updatePreExpansionOutcomes(raw=>({...raw,archive_marker:'persistent-write'}));
    const reopened=await new DurableStore({dir:persistentDir}).init({legacyDir});
    const afterRestart=await reopened.getPreExpansionOutcomes();
    assert.equal(afterRestart.records.length,1);
    assert.equal(afterRestart.archive_marker,'persistent-write');
    assert.deepEqual(reopened.migratedFiles,[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('market regime classifier separates bullish, bearish, and ranging conditions',()=>{
  assert.equal(classifyEvaluationMarketRegime({marketMedianChange24hPct:1.2,marketBreadthPct:70,btcReturn5mPct:.3,btcReturn1hPct:.8}),'BULLISH');
  assert.equal(classifyEvaluationMarketRegime({marketMedianChange24hPct:-1.1,marketBreadthPct:34,btcReturn5mPct:-.4,btcReturn1hPct:-1.2}),'BEARISH');
  assert.equal(classifyEvaluationMarketRegime({marketMedianChange24hPct:.1,marketBreadthPct:51,btcReturn5mPct:.01}),'RANGING');
  assert.equal(classifyEvaluationMarketRegime({}),'UNKNOWN');
  assert.equal(classifyEvaluationMarketRegime({marketRegime:'MIXED'}),'RANGING');
});

test('records Radar 8/Radar 9 observations with time, entry, stage, data quality, reasons, and market regime; de-duplicates repeated stages',async()=>{
  await withStore(async store=>{
    const first=await recordPreExpansionSignals(store,[signal({stage:'WATCH_EARLY'})],{
      now:NOW,marketContext:{marketMedianChange24hPct:1,marketBreadthPct:65,btcReturn5mPct:.3}
    });
    assert.deepEqual(first,{recorded:1,skipped:0});
    const duplicate=await recordPreExpansionSignals(store,[signal({stage:'WATCH_EARLY',at:NOW+30_000})],{now:NOW+30_000});
    assert.equal(duplicate.recorded,0);
    const promotion=await recordPreExpansionSignals(store,[signal({stage:'PRE_EXPANSION',at:NOW+60_000})],{now:NOW+60_000});
    const otherRadar=await recordPreExpansionSignals(store,[signal({radar:'FALCON_EYE_RADAR',stage:'PRE_EXPANSION',at:NOW+60_000})],{now:NOW+60_000});
    assert.equal(promotion.recorded,1);
    assert.equal(otherRadar.recorded,1);
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records.length,3);
    const r8=state.records.find(x=>x.radar==='RADAR_8'&&x.signal_type==='WATCH_EARLY');
    assert.equal(r8.entry_price,100);
    assert.equal(r8.detected_at,NOW);
    assert.equal(r8.data_quality,100);
    assert.equal(r8.reported_data_quality,88);
    assert.equal(r8.evaluation_eligible,true);
    assert.deepEqual(r8.missing_required_fields,[]);
    assert.deepEqual(r8.reason_codes,['HIGHER_LOW_SEQUENCE','VOLUME_PARTICIPATION_IMPROVING']);
    assert.equal(r8.market_regime,'BULLISH');
    assert.equal(r8.created_at,NOW);
    assert.equal(r8.build_version,'Build 224');
    assert.equal(r8.signal_score,66);
    assert.equal(r8.archive_missing_fields.includes('signal_score'),false);
    assert.equal(r8.archive_missing_fields.includes('build_commit'),!r8.build_commit);
    assert.equal(r8.outcome_status,'PENDING');
    assert.equal(r8.horizon_status['5m'].status,'PENDING');
    assert.equal(state.records.find(x=>x.radar==='RADAR_9').radar,'RADAR_9');
  });
});

test('legacy scoreless rows are migrated to incomplete and excluded from stored accuracy cohorts',async()=>{
  await withStore(async store=>{
    const required=['radar','symbol','signal_type','entry_price','detected_at','daily_change_pct',
      'return_5m_pct','return_10m_pct','relative_strength','resistance_context','volume_ratio',
      'trade_ratio','volatility_context','market_regime','reason_codes','closed_fresh_candles','fingerprint_ready'];
    const row={
      signal_id:'LEGACY:NOSCOREUSDT:WATCH_EARLY:'+NOW,radar:'RADAR_8',symbol:'NOSCOREUSDT',
      signal_type:'WATCH_EARLY',entry_price:1,detected_at:NOW,signal_score:null,
      required_fields:required,available_fields:[...required],missing_required_fields:[],
      evaluation_eligible:true,evaluation_status:'ELIGIBLE',evaluation_exclusion_reason:null,
      data_quality:100,data_quality_source:'NORMALIZED_REQUIRED_FIELD_COVERAGE',
      market_regime:'RANGING',marks:{},excursions:{},horizon_status:{},outcome_status:'PENDING'
    };
    await store.updatePreExpansionOutcomes(()=>({
      version:'PRE_EXPANSION_OUTCOMES_V2',records:[row],last_stage_by_key:{},
      last_price_update_at:0,last_report_log_at:0,last_historical_import_at:0,
      last_historical_backfill_at:0,updated_at:NOW
    }));
    const lines=[];
    const result=await maybeLogPreExpansionOutcomeReport(store,{now:NOW,logger:{info:line=>lines.push(line)}});
    assert.equal(result.logged,true);
    assert.equal(result.report.eligible_records,0);
    assert.equal(result.report.excluded_incomplete_records,1);
    assert.equal(result.report.missing_field_counts.signal_score,1);
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records[0].evaluation_eligible,false);
    assert.equal(state.records[0].evaluation_status,'EXCLUDED_INCOMPLETE');
    assert.ok(state.records[0].missing_required_fields.includes('signal_score'));
    assert.ok(state.records[0].data_quality<100);
  });
});

test('signal without source score remains auditable but is excluded from accuracy cohorts',async()=>{
  await withStore(async store=>{
    const result=await recordPreExpansionSignals(store,[signal({symbol:'NOSCOREUSDT',stage:'WATCH_EARLY',score:null})],{now:NOW});
    assert.equal(result.recorded,1);
    const state=await store.getPreExpansionOutcomes();
    const row=state.records[0];
    assert.equal(row.signal_score,null);
    assert.ok(row.archive_missing_fields.includes('signal_score'));
    assert.ok(row.missing_required_fields.includes('signal_score'));
    assert.equal(row.evaluation_eligible,false);
    assert.equal(row.evaluation_status,'EXCLUDED_INCOMPLETE');
    assert.equal(row.evaluation_exclusion_reason.includes('signal_score'),true);
    assert.ok(row.data_quality<100);
    const report=buildPreExpansionOutcomeReport(state);
    assert.equal(report.eligible_records,0);
    assert.equal(report.excluded_incomplete_records,1);
  });
});

test('live markouts sample six horizons and detect a sampled resistance rejection',async()=>{
  await withStore(async store=>{
    const at=NOW+100_000;
    await recordPreExpansionSignals(store,[signal({stage:'BREAKOUT_DEVELOPING',at,regime:'RANGING',metrics:{five_min_resistance:105}})],{now:at});
    let r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:106}],{now:at+30_000});
    assert.equal(r.updated,1);
    const markoutLogs=[];
    r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:106.2}],{
      now:at+5*60_000+30_000,logger:{info:line=>markoutLogs.push(line)}
    });
    assert.equal(r.updated,1);
    // Live ticker observations are audit-only, never certified horizon results.
    assert.ok(markoutLogs.every(line=>!line.includes('[PRE_EXPANSION_MARKOUT]')));
    r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:99.6}],{now:at+7*60_000});
    r=await updatePreExpansionMarkouts(store,[{symbol:'ABCUSDT',lastPrice:104.5}],{now:at+8*60_000});
    const state=await store.getPreExpansionOutcomes(),item=state.records[0];
    assert.equal(item.marks['5m'],undefined);
    assert.equal(item.provisional_marks['5m'].sample_quality,'LIVE_TICKER_PROVISIONAL');
    assert.equal(item.provisional_marks['5m'].status,'INCOMPLETE');
    assert.equal(item.provisional_marks['5m'].reason,'NOT_CLOSED_BINANCE_OHLC');
    assert.equal(item.horizon_status['5m'].status,'INCOMPLETE');
    assert.equal(item.horizon_status['5m'].reason,'WAITING_FOR_BINANCE_CLOSED_OHLC');
    assert.equal(item.false_breakout,null);
    assert.equal(item.provisional_false_breakout,true);
    assert.equal(item.provisional_false_breakout_basis,'SAMPLED_SPOT_PRICE_REJECTION');
    assert.ok(item.provisional_max_favorable_pct>=6);
    assert.ok(item.provisional_max_adverse_pct<=0);
    assert.ok(item.provisional_max_adverse_pct>=-.5);
    assert.ok(item.observations>=3);
  });
});

test('missing daily change is recorded as data-insufficient, not as a successful early signal',async()=>{
  await withStore(async store=>{
    await recordPreExpansionSignals(store,[signal({stage:'DATA_INSUFFICIENT',move:null})],{now:NOW});
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records[0].signal_type,'DATA_INSUFFICIENT');
    assert.equal(state.records[0].data_quality,0);
    assert.equal(state.records[0].data_quality_status,'INSUFFICIENT');
    assert.equal(state.records[0].detected_before_move,false);
    assert.equal(state.records[0].entry_price,100);
  });
});

test('missing or insufficient closed Binance candles are saved INCOMPLETE without invented horizon values',()=>{
  const detected=NOW,now=NOW+25*60*60_000;
  const result=evaluateHistoricalPreExpansionSignal({
    signal_id:'RADAR_8:NO_CANDLESUSDT:PRE_EXPANSION:'+detected,
    radar:'RADAR_8',symbol:'NO_CANDLESUSDT',signal_type:'PRE_EXPANSION',
    created_at:detected,entry_price:1.25,detected_at:detected,market_regime:'RANGING',
    signal_score:null,build_version:'Build 224',build_commit:null
  },{candles1m:[],candles5m:[],now});
  assert.equal(result.ok,true);
  assert.deepEqual(result.record.marks,{});
  assert.equal(result.record.outcome_status,'INCOMPLETE');
  for(const h of ['5m','15m','30m','60m','4h','24h']){
    assert.equal(result.record.horizon_status[h].status,'INCOMPLETE');
    assert.equal(result.record.horizon_status[h].reason,'NO_CLOSED_CANDLE_WITHIN_TOLERANCE');
    assert.equal(result.record.excursions[h].max_favorable_pct,null);
    assert.equal(result.record.excursions[h].max_adverse_pct,null);
    assert.equal(result.record.excursions[h].complete,false);
  }
});

test('historical replay uses closed OHLC candles for markouts, MFE/MAE and false-breakout labeling',()=>{
  const at=NOW,start=at+60_000,one=[],five=[];
  for(let i=0;i<80;i++){
    const close=i<12?100.2:100.2+(i-12)*.12;
    one.push(candle(start+i*60_000,close,{high:i===0?101.2:close+.25,low:i===0?99.7:close-.2,step:60_000}));
  }
  for(let i=0;i<300;i++){
    const close=i<1?100.2:100.2+i*.1;
    five.push(candle(start+i*5*60_000,close,{step:5*60_000,high:i===0?101.2:close+.35,low:i===0?99.6:close-.25}));
  }
  const result=evaluateHistoricalPreExpansionSignal({
    signal_id:'RADAR_8:ABCUSDT:BREAKOUT_DEVELOPING:'+at,
    radar:'RADAR_8',symbol:'ABCUSDT',signal_type:'BREAKOUT_DEVELOPING',
    entry_price:100,detected_at:at,market_regime:'BULLISH',
    resistance_price:100.5,initial_daily_change_pct:1.1,initial_metrics:{return_5m_pct:.2}
  },{candles1m:one,candles5m:five,now:start+25*60*60_000});
  assert.equal(result.ok,true);
  assert.equal(result.record.observed_price_source,'HISTORICAL_CLOSED_OHLC');
  assert.equal(result.record.false_breakout,true);
  assert.equal(result.record.marks['5m'].sample_quality,'HISTORICAL_CLOSED_OHLC');
  assert.ok(result.record.excursions['4h'].max_favorable_pct>3);
  assert.ok(result.record.excursions['4h'].max_adverse_pct<0);
  assert.equal(result.record.outcome_status,'COMPLETE');
});

test('evaluation report separates radar, stage, and market regime and warns on small samples',()=>{
  const at=NOW,start=at+60_000;
  const one=Array.from({length:80},(_,i)=>{
    const close=i<1?100.2:100.2+i*.12;
    return candle(start+i*60_000,close,{high:i===0?101.2:close+.4,low:i===0?99.6:close-.25});
  });
  const five=Array.from({length:300},(_,i)=>{
    const close=i<1?100.2:100.2+i*.1;
    return candle(start+i*5*60_000,close,{step:5*60_000,high:i===0?101.2:close+.4,low:i===0?99.6:close-.25});
  });
  const historical=evaluateHistoricalPreExpansionSignal({
    radar:'RADAR_8',symbol:'ABCUSDT',signal_type:'PRE_EXPANSION',entry_price:100,detected_at:at,market_regime:'BULLISH',
    initial_daily_change_pct:1.1,initial_metrics:{return_5m_pct:.2}
  },{candles1m:one,candles5m:five,now:start+25*60*60_000});
  const report=buildPreExpansionOutcomeReport({version:'PRE_EXPANSION_OUTCOMES_V1',records:[historical.record],now:NOW});
  assert.equal(report.total_records,1);
  assert.equal(report.groups.by_radar.RADAR_8.records,1);
  assert.equal(report.groups.by_stage.PRE_EXPANSION.records,1);
  assert.equal(report.groups.by_market_regime.BULLISH.records,1);
  assert.equal(report.comparison.radar9,null);
  assert.equal(report.groups.by_stage.PRE_EXPANSION.sample_warning,'SMALL_SAMPLE_LESS_THAN_30_MATURED_4H_SIGNALS');
  assert.equal(report.scope.impact_thresholds_pct['4h'],3);
});


test('excludes BTC benchmark and stablecoin pairs from opportunity performance cohort',async()=>{
  await withStore(async store=>{
    const out=await recordPreExpansionSignals(store,[
      signal({symbol:'BTCUSDT',stage:'WATCH_EARLY'}),
      signal({symbol:'TUSDUSDT',stage:'WATCH_EARLY'}),
      signal({symbol:'USDCUSDT',stage:'PRE_EXPANSION'}),
      signal({symbol:'SOLUSDT',stage:'WATCH_EARLY'})
    ],{now:NOW});
    assert.equal(out.recorded,1);
    assert.equal(out.skipped,3);
    const state=await store.getPreExpansionOutcomes();
    assert.deepEqual(state.records.map(x=>x.symbol),['SOLUSDT']);
  });
});

test('Radar 9 normalized aliases receive full coverage when the actual source fields are present',async()=>{
  await withStore(async store=>{
    const alert={
      id:'FALCON:LINKUSDT:'+NOW,radar:'FALCON_EYE_RADAR',symbol:'LINKUSDT',price:100,
      price_change_24h:1.2,score:71,pre_expansion_stage:'WATCH_EARLY',potential_label:'WATCH_EARLY',
      data_quality:90,detected_at:NOW,market_regime_label:'MIXED',
      reasons:['BASE_STRUCTURE','GRADUAL_PARTICIPATION'],
      source:'Binance public REST',
      falcon_eye:{
        pre_expansion_stage:'WATCH_EARLY',not_chasing:true,closed_candles_only:true,
        reasons:['BASE_STRUCTURE','GRADUAL_PARTICIPATION'],
        metrics:{last_price:100,return_5m:.2,return_10m:.35,relative_strength_5m_spread_pct:.12,
          local_high:105,volume_ratio:1.3,trade_ratio:1.2,atr_ratio:.8},
        pre_expansion_fingerprint:{data_ready:true,metrics:{resistance_distance_atr:.6}}
      }
    };
    await recordPreExpansionSignals(store,[alert],{now:NOW});
    const row=(await store.getPreExpansionOutcomes()).records[0];
    assert.equal(row.reported_data_quality,90);
    assert.equal(row.data_quality_source,'NORMALIZED_REQUIRED_FIELD_COVERAGE');
    assert.equal(row.data_quality,100);
    assert.equal(row.signal_score,71);
    assert.equal(row.evaluation_eligible,true);
    assert.equal(row.market_regime,'RANGING');
    assert.deepEqual(row.missing_required_fields,[]);
    assert.equal(row.initial_metrics.return_5m_pct,.2);
    assert.equal(row.initial_metrics.return_10m_pct,.35);
    assert.equal(row.initial_metrics.relative_strength_vs_btc_pct,.12);
    assert.equal(row.initial_metrics.resistance_price,105);
  });
});

test('stale nested Falcon Eye evidence is excluded even when the outer alert omits data_stale',async()=>{
  await withStore(async store=>{
    const base=signal({radar:'FALCON_EYE_RADAR',symbol:'STALEUSDT',stage:'WATCH_EARLY',regime:'RANGING'});
    base.data_stale=false;
    base.falcon_eye={
      ...base.falcon_eye,
      closed_candles_only:true,
      gates:{data_gate:{issues:['STALE_DATA:1m']}}
    };
    await recordPreExpansionSignals(store,[base],{now:NOW});
    const row=(await store.getPreExpansionOutcomes()).records[0];
    assert.equal(row.data_quality,0);
    assert.equal(row.data_quality_status,'STALE');
    assert.equal(row.evaluation_eligible,false);
    assert.equal(row.evaluation_status,'EXCLUDED_INCOMPLETE');
  });
});

test('report never publishes cohort percentages from fewer than 30 eligible signals',()=>{
  const rows=[
    {radar:'RADAR_8',symbol:'AAAUSDT',signal_type:'WATCH_EARLY',market_regime:'RANGING',evaluation_eligible:true,missing_required_fields:[],detected_before_move:true,already_extended_at_detection:false,marks:{},excursions:{}},
    {radar:'RADAR_8',symbol:'BBBUSDT',signal_type:'PRE_EXPANSION',market_regime:'MIXED',evaluation_eligible:true,missing_required_fields:[],detected_before_move:false,already_extended_at_detection:true,marks:{},excursions:{}},
    {radar:'RADAR_9',symbol:'CCCUSDT',signal_type:'BREAKOUT_DEVELOPING',market_regime:'RANGING',evaluation_eligible:true,missing_required_fields:[],detected_before_move:true,already_extended_at_detection:false,marks:{},excursions:{}}
  ];
  const report=buildPreExpansionOutcomeReport({records:rows,now:NOW});
  assert.equal(report.groups.by_radar.RADAR_8.records,2);
  assert.equal(report.groups.by_radar.RADAR_8.detected_before_move_count,1);
  assert.equal(report.groups.by_radar.RADAR_8.detected_before_move_pct,null);
  assert.equal(report.groups.by_radar.RADAR_8.detected_after_move_pct,null);
  assert.equal(report.comparison.radar9.detected_before_move_pct,null);
  assert.equal(report.groups.by_radar.RADAR_8.horizons['4h'].hit_rate_pct,null);
  assert.equal(report.groups.by_market_regime.RANGING.records,3);
});

test('imports only older archived signals, de-duplicates them, and excludes non-opportunity symbols',async()=>{
  await withStore(async store=>{
    const now=NOW+48*60*60_000;
    const archived=[
      signal({radar:'FALCON_EYE_RADAR',symbol:'LINKUSDT',stage:'PRE_EXPANSION',at:NOW}),
      signal({radar:'FALCON_EYE_RADAR',symbol:'LINKUSDT',stage:'PRE_EXPANSION',at:NOW}),
      signal({radar:'FALCON_EYE_RADAR',symbol:'BTCUSDT',stage:'WATCH_EARLY',at:NOW}),
      signal({radar:'FALCON_EYE_RADAR',symbol:'TUSDUSDT',stage:'WATCH_EARLY',at:NOW}),
      signal({radar:'FALCON_EYE_RADAR',symbol:'NEARUSDT',stage:'WATCH_EARLY',at:now-5*60_000})
    ];
    const out=await importHistoricalPreExpansionSignals(store,archived,{now});
    assert.equal(out.imported,1);
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records.length,1);
    assert.equal(state.records[0].symbol,'LINKUSDT');
    assert.equal(state.records[0].historical_archive_import,true);
    const repeated=await importHistoricalPreExpansionSignals(store,archived,{now:now+30_000});
    assert.equal(repeated.imported,0);
    assert.equal((await store.getPreExpansionOutcomes()).records.length,1);
  });
});

test('mature live signal receives retrospective closed-OHLC marks for all six horizons',async()=>{
  await withStore(async store=>{
    const detected=NOW,now=NOW+25*60*60_000;
    const one=Array.from({length:100},(_,i)=>{
      const close=100+i*.035;
      return candle(detected+i*60_000,close,{step:60_000,high:close+.3,low:close-.25});
    });
    const five=Array.from({length:300},(_,i)=>{
      const close=100+i*.035;
      return candle(detected+i*5*60_000,close,{step:5*60_000,high:close+.4,low:close-.3});
    });
    await recordPreExpansionSignals(store,[signal({symbol:'HISTUSDT',stage:'PRE_EXPANSION',at:detected,regime:'RANGING'})],{now:detected});
    await updatePreExpansionMarkouts(store,[{symbol:'HISTUSDT',lastPrice:101}],{now:now-60_000});
    const fakeRest={klines:async(symbol,interval)=>({candles:interval==='1m'?one:five})};
    const result=await backfillHistoricalPreExpansionOutcomes(store,fakeRest,{now,maxSignals:1});
    assert.equal(result.evaluated,1);
    const state=await store.getPreExpansionOutcomes(),row=state.records[0];
    assert.equal(row.historical_evaluation,true);
    assert.equal(row.observed_price_source,'HISTORICAL_CLOSED_OHLC');
    for(const h of ['5m','15m','30m','60m','4h','24h']){
      assert.equal(row.marks[h].sample_quality,'HISTORICAL_CLOSED_OHLC');
    }
    assert.equal(row.outcome_status,'COMPLETE');
    assert.equal(row.historical_evaluation,true);
    assert.equal(row.observed_price_source,'HISTORICAL_CLOSED_OHLC');
    assert.ok(row.max_favorable_pct>0);
    assert.ok(row.max_adverse_pct<0);
    const reopened=await new DurableStore({dir:store.dir}).init();
    const reopenedState=await reopened.getPreExpansionOutcomes();
    const reopenedRow=reopenedState.records.find(x=>x.signal_id===row.signal_id);
    assert.ok(reopenedRow);
    assert.equal(reopenedRow.outcome_status,'COMPLETE');
    assert.equal(reopenedRow.marks['5m'].sample_quality,'HISTORICAL_CLOSED_OHLC');
    assert.equal(reopenedRow.marks['24h'].sample_quality,'HISTORICAL_CLOSED_OHLC');
    assert.deepEqual(['5m','15m','30m','60m','4h','24h'].map(h=>reopenedRow.horizon_status[h].status),
      ['COMPLETE','COMPLETE','COMPLETE','COMPLETE','COMPLETE','COMPLETE']);
  });
});


test('maturing signal records its 5m closed-OHLC outcome without waiting 24 hours',async()=>{
  await withStore(async store=>{
    const detected=NOW,now=NOW+7*60_000;
    const one=Array.from({length:100},(_,i)=>{
      const close=100+i*.04;
      return candle(detected+i*60_000,close,{step:60_000,high:close+.2,low:close-.15});
    });
    const five=Array.from({length:300},(_,i)=>{
      const close=100+i*.04;
      return candle(detected+i*5*60_000,close,{step:5*60_000,high:close+.25,low:close-.2});
    });
    await recordPreExpansionSignals(store,[signal({symbol:'EARLYOUTCOMEUSDT',stage:'PRE_EXPANSION',at:detected,regime:'BEARISH'})],{now:detected});
    const fakeRest={klines:async(symbol,interval)=>({candles:(interval==='1m'?one:five).filter(c=>c.closeTime<=now)})};
    const result=await backfillHistoricalPreExpansionOutcomes(store,fakeRest,{now,maxSignals:1,intervalMs:0});
    assert.equal(result.evaluated,1);
    const state=await store.getPreExpansionOutcomes(),row=state.records[0];
    assert.equal(row.marks['5m'].sample_quality,'HISTORICAL_CLOSED_OHLC');
    assert.equal(row.horizon_status['5m'].status,'COMPLETE');
    assert.equal(row.horizon_status['5m'].historical_checked_at,now);
    assert.equal(row.excursions['5m'].complete,true);
    assert.equal(row.horizon_status['15m'].status,'PENDING');
    assert.equal(row.marks['15m'],undefined);
    assert.equal(row.outcome_status,'PENDING');
    assert.equal(row.historical_evaluation,false);
  });
});

test('Radar 8 alert history can be durably read by the internal retrospective worker',async()=>{
  await withStore(async store=>{
    const alert=signal({symbol:'AAVEUSDT',stage:'BREAKOUT_DEVELOPING'});
    alert.processed_at=NOW;
    await store.appendEarlyExpansionAlert(alert);
    const found=await store.readEarlyExpansionAlerts({sinceMs:NOW-1,limit:20});
    assert.equal(found.length,1);
    assert.equal(found[0].symbol,'AAVEUSDT');
  });
});


test('Radar 8 production alert field aliases reach complete coverage without changing the detector score',async()=>{
  await withStore(async store=>{
    const alert={
      id:'EARLY_EXPANSION:ARBUSDT:'+NOW,event:'EARLY_EXPANSION_RADAR',radar:'EARLY_EXPANSION_RADAR',
      symbol:'ARBUSDT',market:'SPOT',price:1.25,price_change_24h:1.8,early_expansion_score:73.5,
      decision_band:'PRE_EXPANSION',potential_label:'PRE_EXPANSION',data_quality:100,data_stale:false,
      detected_at:NOW,processed_at:NOW,closed_candles_only:true,
      price_change_windows:{
        price_change_5m_pct:.2,price_change_10m_pct:.35,price_change_15m_pct:.55,
        relative_strength_vs_btc_pct:.22,relative_strength_vs_market_pct:.4,
        five_min_resistance:1.28,rvol_5m:1.35,trade_ratio:1.2,atr_ratio:.8
      },
      trigger_evidence:{market_regime:{label:'MIXED'}},
      reason_codes:['RVOL_5M_ACCELERATION','HIGHER_LOW_SEQUENCE'],
      source:'Binance Public REST'
    };
    await recordPreExpansionSignals(store,[alert],{now:NOW});
    const row=(await store.getPreExpansionOutcomes()).records[0];
    assert.equal(row.data_quality,100);
    assert.equal(row.signal_score,73.5);
    assert.equal(row.evaluation_eligible,true);
    assert.equal(row.market_regime,'RANGING');
    assert.deepEqual(row.missing_required_fields,[]);
    assert.equal(row.initial_metrics.return_10m_pct,.35);
    assert.equal(row.initial_metrics.volume_ratio,1.35);
    assert.equal(row.initial_metrics.trade_ratio,1.2);
  });
});

test('a single late sample may create a point mark but cannot certify complete MFE/MAE coverage',async()=>{
  await withStore(async store=>{
    const at=NOW+100_000;
    await recordPreExpansionSignals(store,[signal({symbol:'SPARSEUSDT',stage:'WATCH_EARLY',at,regime:'RANGING'})],{now:at});
    await updatePreExpansionMarkouts(store,[{symbol:'SPARSEUSDT',lastPrice:101}],{now:at+30_000});
    await updatePreExpansionMarkouts(store,[{symbol:'SPARSEUSDT',lastPrice:101.5}],{now:at+5*60_000+30_000});
    const row=(await store.getPreExpansionOutcomes()).records[0];
    assert.equal(row.marks['5m'],undefined);
    assert.equal(row.provisional_marks['5m'].sample_quality,'LIVE_TICKER_PROVISIONAL');
    assert.equal(row.excursions['5m'].complete,false);
    assert.equal(row.excursions['5m'].coverage_status,'INCOMPLETE_CLOSED_OHLC_WINDOW');
    assert.equal(row.provisional_excursions['5m'].complete,false);
    const report=buildPreExpansionOutcomeReport(await store.getPreExpansionOutcomes());
    assert.equal(report.groups.by_radar.RADAR_8.horizons['5m'].excursion_samples,0);
    assert.equal(report.groups.by_radar.RADAR_8.horizons['5m'].avg_max_favorable_pct,null);
  });
});

test('incomplete signals are saved for audit but excluded from markout updates and performance cohorts',async()=>{
  await withStore(async store=>{
    const observedLogs=[];
    await recordPreExpansionSignals(store,[signal({
      symbol:'PARTIALUSDT',stage:'PRE_EXPANSION',regime:'RANGING',
      metrics:{return_10m_pct:null,price_change_10m_pct:null,relative_strength_vs_btc_pct:null,volume_ratio:null,trade_ratio:null,atr_ratio:null}
    })],{now:NOW,logger:{info:line=>observedLogs.push(line)}});
    const before=(await store.getPreExpansionOutcomes()).records[0];
    const observedLine=observedLogs.find(line=>line.includes('[PRE_EXPANSION_SIGNAL_OBSERVED]'));
    assert.ok(observedLine);
    const observed=JSON.parse(observedLine.slice(observedLine.indexOf('{')));
    assert.equal(observed.evaluation_eligible,false);
    assert.equal(observed.data_quality_source,'NORMALIZED_REQUIRED_FIELD_COVERAGE');
    assert.ok(observed.missing_required_fields.includes('return_10m_pct'));
    assert.ok(observed.missing_required_fields.includes('volume_ratio'));
    assert.equal(observed.reported_data_quality,88);
    assert.equal(before.data_quality<100,true);
    assert.equal(before.evaluation_eligible,false);
    assert.equal(before.evaluation_status,'EXCLUDED_INCOMPLETE');
    assert.ok(before.missing_required_fields.includes('return_10m_pct'));
    assert.ok(before.missing_required_fields.includes('volume_ratio'));
    await updatePreExpansionMarkouts(store,[{symbol:'PARTIALUSDT',lastPrice:105}],{now:NOW+6*60_000});
    const after=(await store.getPreExpansionOutcomes()).records[0];
    assert.deepEqual(after.marks,{});
    const report=buildPreExpansionOutcomeReport(await store.getPreExpansionOutcomes());
    assert.equal(report.excluded_incomplete_records,1);
    assert.equal(report.eligible_records,0);
    assert.equal(report.groups.by_radar.RADAR_8.meaningful_move_4h_pct,null);
  });
});

test('legacy rows with MIXED regime are normalized and excluded until their input fields are revalidated',()=>{
  const report=buildPreExpansionOutcomeReport({
    records:[{signal_id:'legacy',radar:'RADAR_9',symbol:'ADAUSDT',signal_type:'WATCH_EARLY',
      market_regime:'MIXED',entry_price:1,detected_at:NOW,marks:{},excursions:{}}],
    now:NOW
  });
  assert.equal(report.groups.by_market_regime.RANGING.records,1);
  assert.equal(report.groups.by_market_regime.RANGING.eligible_records,0);
  assert.equal(report.groups.by_market_regime.RANGING.excluded_incomplete_records,1);
});

test('RANGING history comparison requires 30 positive and 30 adverse cases per radar',()=>{
  const horizons=['5m','15m','30m','60m','4h','24h'];
  const makeRows=count=>Array.from({length:count},(_,i)=>{
    const positive=i<Math.floor(count/2);
    return {
      signal_id:'historic-'+count+'-'+i,radar:i%2?'RADAR_8':'RADAR_9',symbol:'COIN'+i+'USDT',
      signal_type:'PRE_EXPANSION',market_regime:i%3===0?'MIXED':'RANGING',
      evaluation_eligible:true,missing_required_fields:[],evaluation_status:'ELIGIBLE',
      detected_at:NOW+i,entry_price:100,historical_evaluation:true,detected_before_move:true,
      data_quality:100,data_quality_source:'NORMALIZED_REQUIRED_FIELD_COVERAGE',
      marks:Object.fromEntries(horizons.map(h=>[h,{sample_quality:'HISTORICAL_CLOSED_OHLC',return_pct:positive?3.5:-1.2,outcome:positive?'HIT':'MISS'}])),
      excursions:Object.fromEntries(horizons.map(h=>[h,{
        source:'HISTORICAL_CLOSED_OHLC',complete:true,
        max_favorable_pct:h==='4h'?(positive?4.5:1.1):positive?3.5:.8,
        max_adverse_pct:h==='4h'?(positive?-.4:-1.5):positive?-.3:-1.2
      }]))
    };
  });
  const overallOnly=buildPreExpansionOutcomeReport({records:makeRows(60),now:NOW});
  assert.equal(overallOnly.ranging_historical_sample.complete_historical_records,60);
  assert.equal(overallOnly.ranging_historical_sample.positive_cases,30);
  assert.equal(overallOnly.ranging_historical_sample.negative_cases,30);
  assert.equal(overallOnly.ranging_historical_sample.sample_ready,true);
  assert.equal(overallOnly.ranging_historical_sample.ready_for_comparison,false);
  assert.equal(overallOnly.ranging_historical_sample.comparison_warning,'NEED_30_POSITIVE_AND_30_NEGATIVE_COMPLETE_RANGING_CASES_PER_RADAR');
  assert.equal(overallOnly.ranging_historical_sample.by_radar.RADAR_8.positive_cases,15);
  assert.equal(overallOnly.ranging_historical_sample.by_radar.RADAR_9.negative_cases,15);

  const comparable=buildPreExpansionOutcomeReport({records:makeRows(120),now:NOW});
  assert.equal(comparable.ranging_historical_sample.complete_historical_records,120);
  assert.equal(comparable.ranging_historical_sample.positive_cases,60);
  assert.equal(comparable.ranging_historical_sample.negative_cases,60);
  assert.equal(comparable.ranging_historical_sample.sample_ready,true);
  assert.equal(comparable.ranging_historical_sample.ready_for_comparison,true);
  assert.equal(comparable.ranging_historical_sample.comparison_warning,null);
  assert.equal(comparable.ranging_historical_sample.by_radar.RADAR_8.positive_cases,30);
  assert.equal(comparable.ranging_historical_sample.by_radar.RADAR_8.negative_cases,30);
  assert.equal(comparable.ranging_historical_sample.by_radar.RADAR_9.positive_cases,30);
  assert.equal(comparable.ranging_historical_sample.by_radar.RADAR_9.negative_cases,30);
  assert.equal(comparable.comparison.radar8.matured_4h,60);
  assert.equal(comparable.comparison.radar9.matured_4h,60);
});

test('compacts already saved benchmark/stablecoin rows even when live markout polling is throttled',async()=>{
  await withStore(async store=>{
    await recordPreExpansionSignals(store,[signal({symbol:'SOLUSDT',stage:'WATCH_EARLY'})],{now:NOW});
    await store.updatePreExpansionOutcomes(raw=>({
      ...raw,
      last_price_update_at:NOW,
      records:[...raw.records,
        {signal_id:'old-btc-row',radar:'RADAR_9',symbol:'BTCUSDT',signal_type:'WATCH_EARLY',entry_price:100,detected_at:NOW,marks:{},excursions:{}},
        {signal_id:'old-tusd-row',radar:'RADAR_9',symbol:'TUSDUSDT',signal_type:'WATCH_EARLY',entry_price:1,detected_at:NOW,marks:{},excursions:{}}
      ],
      last_stage_by_key:{...raw.last_stage_by_key,'RADAR_9|BTCUSDT':{stage:'WATCH_EARLY',last_recorded_at:NOW},'RADAR_9|TUSDUSDT':{stage:'WATCH_EARLY',last_recorded_at:NOW}}
    }));
    const result=await updatePreExpansionMarkouts(store,[{symbol:'SOLUSDT',lastPrice:100}],{now:NOW+5_000});
    assert.equal(result.throttled,true);
    const state=await store.getPreExpansionOutcomes();
    assert.equal(state.records.some(x=>['BTCUSDT','TUSDUSDT'].includes(x.symbol)),false);
    assert.equal(Object.keys(state.last_stage_by_key).some(k=>k.includes('BTCUSDT')||k.includes('TUSDUSDT')),false);
    assert.deepEqual(state.records.map(x=>x.symbol),['SOLUSDT']);
  });
});
