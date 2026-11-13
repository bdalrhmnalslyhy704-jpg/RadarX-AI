import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  DAILY_EARLY_RISER_HORIZON_MS,
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_OPPORTUNITY_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,
  DAILY_EARLY_RISER_MLP_MAX_TRAINING_SAMPLES,
  DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION,
  DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN,
  DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
  effectiveDailyTcnMultiscaleTrainingBudget,
  effectiveDailyMlpIterations,
  DAILY_EARLY_RISER_MLP_MAX_ITERATIONS,
  DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
  summarizeDailyNeuralAnchorDiagnostics,
  prepareDailyEarlyRiserCognitiveRow,
  benchmarkDailyEarlyRiserTarget,
  benchmarkDailyEarlyRiserRegimeLocalMlp
} from '../core/daily-early-riser-neural-benchmark.mjs';
import {DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE} from '../core/daily-early-riser-census.mjs';
import {
  buildCognitiveLearningProfile,
  buildCognitiveFeatureVector,
  COGNITIVE_FEATURE_NAMES,
  COGNITIVE_FEATURE_SCHEMA,
  COGNITIVE_DAILY_FEATURE_NAMES,
  COGNITIVE_DAILY_FEATURE_SCHEMA,
  factorizationMachineProjection,
  effectiveNeuralInnerSelectionMargin,
  effectiveNeuralSelectionMinimum,
  hasNeuralSelectionSupport
} from '../core/cognitive-brain.mjs';
import {
  buildTemporalNeuralProfile,
  TEMPORAL_TARGET_DEFINITION,
  TEMPORAL_SEQUENCE_STEPS,
  TEMPORAL_SEQUENCE_CHANNELS
} from '../core/temporal-neural-brain.mjs';

function sampleWith({
  at=1_800_000_000_000,
  featureCutoffAt=at,
  targetPct=5,
  outcome='UP',
  status='RESOLVED',
  resolvedAt=at+DAILY_EARLY_RISER_HORIZON_MS,
  horizonMs=DAILY_EARLY_RISER_HORIZON_MS,
  outcomeSource=DAILY_EARLY_RISER_OUTCOME_SOURCE
}={}){
  const key='plus_'+targetPct+'_pct';
  return {
    id:'DAILY_TEST:AAAUSDT:'+String(at),
    symbol:'AAAUSDT',
    at,
    feature_information_cutoff_at:featureCutoffAt,
    observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
    features:{
      volume_ratio:1.4,trade_ratio:1.2,taker_buy_ratio:0.61,
      close_location:0.72,current_range_pct:1.2,
      relative_strength_vs_btc_pct:0.8
    },
    targets:{
      [key]:{
        status,outcome,resolved_at:resolvedAt,horizon_ms:horizonMs,
        outcome_source:outcomeSource,
        target_definition:'FIRST_PASSAGE_PLUS_'+targetPct+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1'
      }
    }
  };
}

test('TCN-only V10 training-window ablation is capped at 8,192 while standard profiles stay at 4,096',()=>{
  assert.equal(effectiveDailyTcnMultiscaleTrainingBudget({tcnOnly:true}),8192);
  assert.equal(effectiveDailyTcnMultiscaleTrainingBudget({tcnOnly:false}),4096);
  assert.equal(effectiveDailyTcnMultiscaleTrainingBudget({
    tcnOnly:true,temporalRegimeLocalTcnMultiscaleMaxTrainingSamples:12000
  }),8192);
  assert.equal(effectiveDailyTcnMultiscaleTrainingBudget({
    tcnOnly:false,temporalRegimeLocalTcnMultiscaleMaxTrainingSamples:8192
  }),4096);
});

test('regime-local MLP reconstructs BTC return from the same-window official asset and relative returns when TCN sequence is absent',()=>{
  const riskOn=sampleWith({at:1_800_000_000_000,targetPct:5,outcome:'UP'});
  riskOn.daily_change_pct=4;
  riskOn.relative_strength_vs_btc_24h_pct=2;
  const riskOff=sampleWith({at:1_800_000_900_000,targetPct:5,outcome:'DOWN'});
  riskOff.daily_change_pct=-3;
  riskOff.relative_strength_vs_btc_24h_pct=1;
  const result=benchmarkDailyEarlyRiserRegimeLocalMlp([riskOn,riskOff],5,{
    labelMode:'first_passage',horizonHours:24
  });
  assert.deepEqual(result.regime_sample_counts,{BTC_RISK_ON:1,BTC_RISK_OFF:1});
  assert.equal(result.rejection_counts.BTC_REGIME_ALL_SOURCES_MISSING,undefined);
  assert.equal(result.rejection_counts.BTC_REGIME_RETURN_NEAR_ZERO_AMBIGUOUS,undefined);
  assert.equal(result.regime_specialists.BTC_RISK_ON.sample_count,1);
  assert.equal(result.regime_specialists.BTC_RISK_OFF.sample_count,1);
  assert.equal(result.regime_specialists.BTC_RISK_ON.status,'WAITING_FOR_REGIME_LOCAL_MLP_SAMPLE_SUPPORT');
  assert.equal(result.regime_specialists.BTC_RISK_OFF.status,'WAITING_FOR_REGIME_LOCAL_MLP_SAMPLE_SUPPORT');
  assert.equal(result.probability_ready,false);
});

test('regime-local MLP rejects an archived BTC regime that conflicts with the closed temporal sequence',()=>{
  const sample=sampleWith({at:1_800_000_000_000,targetPct:5,outcome:'UP'});
  sample.daily_change_pct=4;
  sample.relative_strength_vs_btc_24h_pct=2;
  sample.temporal_sequence=Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,time)=>
    Array.from({length:TEMPORAL_SEQUENCE_CHANNELS},(_,channel)=>
      channel===19&&time===TEMPORAL_SEQUENCE_STEPS-1?-0.25:0));
  const result=benchmarkDailyEarlyRiserRegimeLocalMlp([sample],5,{
    labelMode:'first_passage',horizonHours:24
  });
  assert.equal(result.rejection_counts.BTC_REGIME_SOURCE_DISAGREEMENT,1);
  assert.equal(result.sample_count,0);
  assert.equal(result.status,'REGIME_ASSIGNMENT_COVERAGE_INCOMPLETE');
  assert.equal(result.probability_ready,false);
});

test('regime-local MLP assigns samples by the final closed BTC 24h feature and never merges unsupported regimes',()=>{
  const sequenceFor=sign=>Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,time)=>
    Array.from({length:TEMPORAL_SEQUENCE_CHANNELS},(_,channel)=>
      channel===19&&time===TEMPORAL_SEQUENCE_STEPS-1?sign:0));
  const riskOn=sampleWith({at:1_800_000_000_000,targetPct:5,outcome:'UP'});
  const riskOff=sampleWith({at:1_800_000_900_000,targetPct:5,outcome:'DOWN'});
  riskOn.temporal_sequence=sequenceFor(0.25);
  riskOff.temporal_sequence=sequenceFor(-0.25);
  const result=benchmarkDailyEarlyRiserRegimeLocalMlp([riskOn,riskOff],5,{
    labelMode:'first_passage',horizonHours:24,
    neuralTrainingHistoryFraction:1
  });
  assert.equal(result.schema,'RADARX_DAILY_EARLY_RISER_REGIME_LOCAL_MLP_ABLATION_V1');
  assert.equal(result.btc_regime_definition,
    'LAST_CLOSED_15M_SEQUENCE_BTC_24H_RETURN_CHANNEL_19_SIGN_V1');
  assert.deepEqual(result.regime_sample_counts,{BTC_RISK_ON:1,BTC_RISK_OFF:1});
  assert.equal(result.sample_count,2);
  assert.equal(result.trained,false,
    'one sample in each regime cannot pass the specialist minimum-data gate');
  assert.equal(result.research_out_of_sample_validated,false);
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
  assert.equal(result.production_touched,false);
  assert.equal(result.real_order_execution,false);
  assert.equal(result.regime_specialists.BTC_RISK_ON.status,
    'WAITING_FOR_REGIME_LOCAL_MLP_SAMPLE_SUPPORT');
  assert.equal(result.regime_specialists.BTC_RISK_OFF.status,
    'WAITING_FOR_REGIME_LOCAL_MLP_SAMPLE_SUPPORT');
});

test('TCN-only mode returns temporal challengers without running MLP, tabular GBDT or hybrid profiles',()=>{
  const samples=Array.from({length:4},(_,index)=>sampleWith({
    at:1_800_000_000_000+index*15*60*1000,targetPct:5,
    outcome:index===0?'UP':'DOWN'
  }));
  const result=benchmarkDailyEarlyRiserTarget(samples,5,{
    tcnOnly:true,enableTemporalBoostedTree:false
  });
  assert.equal(result.research_mode,'TCN_ONLY_ISOLATED_COMPUTE');
  assert.equal(result.target_pct,5);
  assert.equal(result.temporal_tcn_sequence_samples,0,
    'no sequence tensor means no temporal model fit; this fixture tests only routing');
  assert.equal(result.temporal_tree_training_performed,false);
  assert.equal(result.neural_network,undefined);
  assert.equal(result.boosted_tree_model,undefined);
  assert.equal(result.hybrid_model,undefined);
  assert.equal(result.temporal_tcn.status,'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES');
  assert.equal(result.approval.probability_ready,false);
  assert.equal(result.approval.live_eligibility_ready,false);
  assert.equal(result.approval.real_order_execution,false);
});

test('daily cognitive row preserves the 24h first-passage label and baseline-only feature cutoff',()=>{
  const input=sampleWith({targetPct:5,outcome:'UP'});
  const result=prepareDailyEarlyRiserCognitiveRow(input,5);
  assert.equal(result.reason,null);
  assert.equal(result.row.outcome,'UP');
  assert.equal(result.row.at,input.at);
  assert.equal(result.row.resolved_at,input.at+DAILY_EARLY_RISER_HORIZON_MS);
  assert.equal(result.row.horizon_ms,DAILY_EARLY_RISER_HORIZON_MS);
  assert.equal(result.row.outcome_source,DAILY_EARLY_RISER_OUTCOME_SOURCE);
  assert.equal(result.row.historical_baseline,true);
  assert.equal(result.row.closed_candle_baseline,true);
  assert.equal(result.row.training_eligible,true);
  assert.deepEqual(result.row.features,input.features);
});

test('daily feature adapter carries baseline-time multi-horizon context into the isolated 35-channel schema',()=>{
  const input=sampleWith({targetPct:5,outcome:'UP'});
  input.quote_volume_24h=2_250_000;
  input.daily_change_pct=2.4;
  input.relative_strength_vs_btc_24h_pct=1.8;
  Object.assign(input.features,{
    return_30m_pct:0.6,hourly_return_pct:1.1,return_3h_pct:2.0,
    btc_hourly_return_pct:0.2,breakout_distance_pct:0.35,
    lower_wick_pct:0.3,micro_5m_available:true,
    micro_5m_volume_ratio:1.8,micro_5m_trade_ratio:1.4,
    micro_5m_return_pct:0.25,micro_5m_close_location:0.72,
    micro_5m_taker_buy_ratio:0.66
  });
  const prepared=prepareDailyEarlyRiserCognitiveRow(input,5);
  assert.equal(prepared.reason,null);
  assert.equal(prepared.row.features.quote_volume_24h,2_250_000);
  assert.equal(prepared.row.features.daily_change_pct,2.4);
  assert.equal(prepared.row.features.relative_strength_vs_btc_24h_pct,1.8);
  const vector=buildCognitiveFeatureVector(prepared.row.features,DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA);
  assert.equal(DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,COGNITIVE_DAILY_FEATURE_SCHEMA);
  assert.equal(vector.length,COGNITIVE_DAILY_FEATURE_NAMES.length);
  assert.equal(vector.length,35);
  assert.equal(COGNITIVE_FEATURE_SCHEMA,'CROSS_ASSET_EARLY_FLOW_FEATURES_V2');
  assert.equal(COGNITIVE_FEATURE_NAMES.length,18);
  assert.equal(buildCognitiveFeatureVector(prepared.row.features).length,18,
    'legacy callers must retain the original 18-channel vector');
  assert.ok(vector.every(Number.isFinite));
  const names=Object.fromEntries(COGNITIVE_DAILY_FEATURE_NAMES.map((name,index)=>[name,index]));
  for(const name of ['momentum_30m','momentum_1h','momentum_3h','daily_momentum',
    'relative_strength_24h','quote_volume_scale','breakout_distance','lower_wick_support',
    'micro_volume_expansion','micro_trade_expansion','micro_momentum','micro_close_location',
    'micro_buyer_divergence','timeframe_trend_consensus',
    'relative_strength_timeframe_divergence'])
    assert.ok(Number.isInteger(names[name]),'missing '+name);
  assert.ok(vector[names.quote_volume_scale]>0);
  assert.ok(vector[names.micro_buyer_divergence]>0);
  assert.ok(vector[names.timeframe_trend_consensus]>0);
});

test('ambiguous, invalid and unresolved labels are excluded rather than mapped to FLAT',()=>{
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({status:'AMBIGUOUS',outcome:'AMBIGUOUS'}),5).reason,
    'LABEL_NOT_RESOLVED');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({status:'INVALID',outcome:'INVALID'}),5).reason,
    'LABEL_NOT_RESOLVED');
});

test('the daily horizon must mature exactly 96 closed 15m candles after the feature cutoff',()=>{
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({resolvedAt:1_800_000_000_000+DAILY_EARLY_RISER_HORIZON_MS-1}),5).reason,
    'LABEL_HORIZON_MISMATCH');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({horizonMs:4*60*60*1000}),5).reason,
    'LABEL_HORIZON_MISMATCH');
});

test('future information or a non-Binance baseline is rejected',()=>{
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({featureCutoffAt:1_800_000_000_000-1}),5).reason,
    'FEATURE_CUTOFF_NOT_AT_BASELINE');
  const row=sampleWith({targetPct:5});
  row.observation_source='MOCK_OR_UNVERIFIED';
  assert.equal(prepareDailyEarlyRiserCognitiveRow(row,5).reason,'FEATURE_CUTOFF_NOT_AT_BASELINE');
});

test('target definitions remain independent for +5%, +10% and +15%',()=>{
  const input={
    ...sampleWith({targetPct:5,outcome:'UP'}),
    targets:{
      plus_5_pct:sampleWith({targetPct:5,outcome:'UP'}).targets.plus_5_pct,
      plus_10_pct:sampleWith({targetPct:10,outcome:'DOWN'}).targets.plus_10_pct,
      plus_15_pct:sampleWith({targetPct:15,outcome:'FLAT'}).targets.plus_15_pct
    }
  };
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,5).row.outcome,'UP');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,10).row.outcome,'DOWN');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,15).row.outcome,'FLAT');
});



test('72h upside opportunity adapter keeps a later rally positive after an early drawdown',()=>{
  const at=1_800_000_000_000;
  const input=sampleWith({at,targetPct:5,outcome:'DOWN'});
  const label={
    status:'RESOLVED',outcome:'UP',
    resolved_at:at+72*60*60*1000,horizon_ms:72*60*60*1000,
    outcome_source:DAILY_EARLY_RISER_OPPORTUNITY_OUTCOME_SOURCE,
    target_definition:'ANY_UPSIDE_TOUCH_PLUS_5_PCT_WITHIN_72H_15M_V1',
    target_reached:true,first_target_index:210,
    independent_of_adverse_barrier:true
  };
  input.opportunity_targets={'72h':{plus_5_pct:label}};
  const prepared=prepareDailyEarlyRiserCognitiveRow(input,5,{
    labelMode:'upside_opportunity',horizonHours:72
  });
  assert.equal(prepared.reason,null);
  assert.equal(prepared.row.outcome,'UP');
  assert.equal(prepared.row.horizon_ms,72*60*60*1000);
  assert.equal(prepared.row.target_definition,label.target_definition);
  assert.equal(prepared.row.first_passage,undefined,
    'opportunity labels must not masquerade as first-passage tradeability labels');
  assert.deepEqual(prepared.row.outcome_contract,{
    kind:'UPSIDE_TOUCH',path_resolution:'15M',outcome:'UP',
    horizon_hours:72,independent_of_adverse_barrier:true
  });
});

test('safe-opportunity adapter preserves the target-before-drawdown entry objective',()=>{
  const at=1_800_000_000_000;
  const input=sampleWith({at,targetPct:5,outcome:'DOWN'});
  const label={
    status:'RESOLVED',outcome:'UP',resolved_at:at+72*60*60*1000,
    horizon_ms:72*60*60*1000,outcome_source:DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE,
    target_definition:'FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_72H_15M_V1',
    first_touch_index:12,independent_of_future_after_first_touch:true
  };
  input.safe_opportunity_targets={'72h':{plus_5_pct:label}};
  const prepared=prepareDailyEarlyRiserCognitiveRow(input,5,{
    labelMode:'safe_opportunity',horizonHours:72
  });
  assert.equal(prepared.reason,null);
  assert.equal(prepared.row.outcome,'UP');
  assert.equal(prepared.row.outcome_source,DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE);
  assert.equal(prepared.row.target_definition,label.target_definition);
  assert.deepEqual(prepared.row.outcome_contract,{
    kind:'SAFE_FIRST_PASSAGE',path_resolution:'15M',outcome:'UP',
    horizon_hours:72,adverse_pct:2
  });

  label.outcome='DOWN';
  const down=prepareDailyEarlyRiserCognitiveRow(input,5,{
    labelMode:'safe_opportunity',horizonHours:72
  });
  assert.equal(down.row.outcome,'DOWN');
  label.outcome='AMBIGUOUS';label.status='AMBIGUOUS';
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,5,{
    labelMode:'safe_opportunity',horizonHours:72
  }).reason,'LABEL_NOT_RESOLVED');
});

test('temporal TCN accepts the explicitly typed safe first-touch contract',()=>{
  const at=1_800_000_000_000;
  const sequence=Array.from({length:TEMPORAL_SEQUENCE_STEPS},()=>Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  const row={
    id:'AAAUSDT:SAFE72',symbol:'AAAUSDT',at,
    resolved_at:at+72*60*60*1000,horizon_ms:72*60*60*1000,
    outcome:'UP',outcome_source:DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE,
    target_definition:'FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_72H_15M_V1',
    outcome_contract:{kind:'SAFE_FIRST_PASSAGE',path_resolution:'15M',outcome:'UP',
      horizon_hours:72,adverse_pct:2},
    historical_baseline:true,closed_candle_baseline:true,training_eligible:true,
    temporal_sequence:sequence
  };
  const result=buildTemporalNeuralProfile([row],{
    targetDefinition:row.target_definition,
    outcomeHorizonMs:72*60*60*1000,
    allowedOutcomeSources:[DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE],
    outcomeContractKind:'SAFE_FIRST_PASSAGE'
  });
  assert.equal(result.resolved_samples,1);
  assert.equal(result.outcome_contract_kind,'SAFE_FIRST_PASSAGE');
});

test('standard-lane training excludes Micro Watch rows instead of mixing liquidity cohorts',()=>{
  const standard=sampleWith({at:1_800_000_000_000,outcome:'UP'});
  standard.symbol='STANDARDUSDT';standard.id='STANDARDUSDT:STANDARD';
  standard.liquidity_lane='STANDARD_750K_PLUS';standard.quote_volume_24h=1_200_000;
  const micro=sampleWith({at:1_800_000_000_000+15*60*1000,outcome:'UP'});
  micro.symbol='MICROUSDT';micro.id='MICROUSDT:MICRO';
  micro.liquidity_lane='MICRO_WATCH_ONLY_UNDER_750K';micro.quote_volume_24h=420_000;
  const result=benchmarkDailyEarlyRiserTarget([standard,micro],5,{
    requiredLiquidityLane:'STANDARD_750K_PLUS',skipTemporal:true
  });
  assert.equal(result.required_liquidity_lane,'STANDARD_750K_PLUS');
  assert.equal(result.samples.accepted,1);
  assert.equal(result.samples.rejection_reasons.LIQUIDITY_LANE_FILTER,1);
  assert.equal(result.approval.real_order_execution,false);
  assert.throws(()=>benchmarkDailyEarlyRiserTarget([standard],5,{
    requiredLiquidityLane:'ALL_LANES'
  }),/UNSUPPORTED_DAILY_EARLY_RISER_LIQUIDITY_LANE/);
});

test('skip-temporal research split lets tabular challengers finish without competing for TCN compute',()=>{
  const samples=Array.from({length:40},(_,index)=>sampleWith({
    at:1_800_000_000_000+index*24*60*60*1000,
    outcome:index%7===0?'UP':'DOWN'
  }));
  const result=benchmarkDailyEarlyRiserTarget(samples,5,{
    skipTemporal:true,enableTemporalBoostedTree:true,
    minTrainingSamples:10,minimumValidationSamples:5,minimumHoldoutSamples:5,
    minNeuralTrainingSamples:240
  });
  assert.equal(result.temporal_tcn_reason,'SKIPPED_BY_EXPLICIT_RESEARCH_COMPUTE_SPLIT');
  assert.equal(result.temporal_tcn_training_performed,false);
  assert.equal(result.temporal_tcn.status,'SKIPPED_BY_EXPLICIT_RESEARCH_COMPUTE_SPLIT');
  assert.equal(result.approval.real_order_execution,false);
});

test('temporal TCN accepts the explicitly typed 72h upside contract without relabelling it as first passage',()=>{
  const at=1_800_000_000_000;
  const sequence=Array.from({length:TEMPORAL_SEQUENCE_STEPS},()=>Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  const row={
    id:'AAAUSDT:UPSIDE72',symbol:'AAAUSDT',at,
    resolved_at:at+72*60*60*1000,horizon_ms:72*60*60*1000,
    outcome:'UP',outcome_source:DAILY_EARLY_RISER_OPPORTUNITY_OUTCOME_SOURCE,
    target_definition:'ANY_UPSIDE_TOUCH_PLUS_5_PCT_WITHIN_72H_15M_V1',
    outcome_contract:{kind:'UPSIDE_TOUCH',path_resolution:'15M',outcome:'UP',horizon_hours:72},
    historical_baseline:true,closed_candle_baseline:true,training_eligible:true,
    temporal_sequence:sequence
  };
  const result=buildTemporalNeuralProfile([row],{
    targetDefinition:row.target_definition,
    outcomeHorizonMs:72*60*60*1000,
    allowedOutcomeSources:[DAILY_EARLY_RISER_OPPORTUNITY_OUTCOME_SOURCE],
    outcomeContractKind:'UPSIDE_TOUCH'
  });
  assert.equal(result.resolved_samples,1);
  assert.equal(result.target_definition,row.target_definition);
  assert.equal(result.outcome_contract_kind,'UPSIDE_TOUCH');
  assert.equal(result.status,'WAITING_FOR_TEMPORAL_FIRST_PASSAGE_SAMPLES');
});

test('opportunity benchmark refuses the first-passage dataset instead of silently training on the wrong objective',()=>{
  const input=sampleWith({targetPct:5,outcome:'UP'});
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,5,{
    labelMode:'upside_opportunity',horizonHours:72
  }).reason,'LABEL_NOT_RESOLVED');
});

test('invalid temporal channels are withheld without discarding a valid tabular sample',()=>{
  const input=sampleWith({targetPct:5,outcome:'UP'});
  input.temporal_sequence=Array.from({length:TEMPORAL_SEQUENCE_STEPS},()=>Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  input.temporal_sequence[0][0]=null;
  const prepared=prepareDailyEarlyRiserCognitiveRow(input,5);
  assert.equal(prepared.reason,null);
  assert.equal(prepared.row.training_eligible,true);
  assert.equal(prepared.row.temporal_sequence,null);
});

test('daily 24h target contract is accepted only through explicit TCN opt-in; legacy 4h contract stays unchanged',()=>{
  const input=sampleWith({targetPct:5,outcome:'UP'});
  input.temporal_sequence=Array.from({length:TEMPORAL_SEQUENCE_STEPS},()=>Array(TEMPORAL_SEQUENCE_CHANNELS).fill(0));
  const prepared=prepareDailyEarlyRiserCognitiveRow(input,5);
  assert.equal(prepared.reason,null);
  assert.equal(prepared.row.first_passage.path_resolution,'15M');
  assert.equal(prepared.row.first_passage.outcome,'UP');
  assert.equal(prepared.row.temporal_sequence.length,24);
  const dailyDefinition='FIRST_PASSAGE_PLUS_5_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1';
  const opts={
    targetDefinition:dailyDefinition,
    outcomeHorizonMs:DAILY_EARLY_RISER_HORIZON_MS,
    allowedOutcomeSources:[DAILY_EARLY_RISER_OUTCOME_SOURCE]
  };
  const dailyProfile=buildTemporalNeuralProfile([prepared.row],opts);
  assert.equal(dailyProfile.resolved_samples,1);
  assert.equal(dailyProfile.target_definition,dailyDefinition);
  assert.equal(dailyProfile.sequence_steps,24);
  assert.equal(dailyProfile.sequence_channels,29);
  const dailyOnLegacyDefault=buildTemporalNeuralProfile([prepared.row]);
  assert.equal(dailyOnLegacyDefault.resolved_samples,0);
  assert.equal(dailyOnLegacyDefault.target_definition,TEMPORAL_TARGET_DEFINITION);
  const legacySample={
    ...prepared.row,
    id:'LEGACY_4H:AAAUSDT:'+String(prepared.row.at),
    resolved_at:prepared.row.at+4*60*60*1000,
    horizon_ms:4*60*60*1000,
    outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    target_definition:TEMPORAL_TARGET_DEFINITION
  };
  const legacyProfile=buildTemporalNeuralProfile([legacySample]);
  assert.equal(legacyProfile.resolved_samples,1);
  assert.equal(legacyProfile.target_definition,TEMPORAL_TARGET_DEFINITION);
});


test('daily inner neural selection floor is independent from outer validation minimum while legacy default is preserved',()=>{
  assert.equal(effectiveNeuralSelectionMinimum(3000),3000);
  assert.equal(effectiveNeuralSelectionMinimum(3000,200),200);
  assert.equal(effectiveNeuralSelectionMinimum(3000,5),20);
  assert.equal(effectiveNeuralSelectionMinimum(100,1200),900);
});


test('neural inner selection requires enough total rows and both binary classes',()=>{
  assert.equal(hasNeuralSelectionSupport({sampleCount:299,positiveCount:10,negativeCount:289,minimumSamples:300,minimumPositive:10,minimumNegative:30}),false);
  assert.equal(hasNeuralSelectionSupport({sampleCount:300,positiveCount:9,negativeCount:291,minimumSamples:300,minimumPositive:10,minimumNegative:30}),false);
  assert.equal(hasNeuralSelectionSupport({sampleCount:300,positiveCount:10,negativeCount:290,minimumSamples:300,minimumPositive:10,minimumNegative:30}),true);
  assert.equal(hasNeuralSelectionSupport({sampleCount:300,positiveCount:10,negativeCount:289,minimumSamples:300,minimumPositive:10,minimumNegative:30}),false);
});


test('daily profile reaches the decoupled selection gate without temporal-declaration-order errors',()=>{
  const horizon=24*60*60*1000;
  const samples=[];
  for(let day=0;day<300;day++){
    for(let symbolIndex=0;symbolIndex<5;symbolIndex++){
      const at=1_760_000_000_000+day*horizon;
      const symbol='T'+symbolIndex+'USDT';
      const positive=(day*7+symbolIndex*3)%11===0;
      samples.push({
        id:'UNIT_TEST:'+symbol+':'+String(at),
        symbol,at,resolved_at:at+horizon,horizon_ms:horizon,
        outcome:positive?'UP':'DOWN',
        outcome_source:'UNIT_TEST_DAILY',
        training_eligible:true,closed_candle_baseline:true,
        features:{
          volume_ratio:1.4+(day%5)*0.1,trade_ratio:1.2,
          taker_buy_ratio:positive?0.61:0.49,
          relative_strength_vs_btc_pct:positive?0.8:-0.2,
          recent_15m_return_pct:positive?0.4:-0.3,
          current_range_pct:1.2,close_location:0.7,
          upper_wick_pct:0.1,higher_low:positive,
          breakout_above_prior_high:false,compression_ratio:0.7,
          micro_5m_available:false
        }
      });
    }
  }
  const profile=buildCognitiveLearningProfile(samples,{
    minTrainingSamples:100,
    minimumValidationSamples:30,
    minimumHoldoutSamples:30,
    validationFraction:0.2,
    holdoutFraction:0.2,
    outcomeHorizonMs:horizon,
    allowedOutcomeSources:['UNIT_TEST_DAILY'],
    minNeuralTrainingSamples:900,
    maxNeuralTrainingSamples:6000,
    minimumNeuralSelectionSamples:40,
    minimumNeuralSelectionPositiveSamples:2,
    minimumNeuralSelectionNegativeSamples:8,
    temporalSamples:[],
    neuralIterations:20,
    neuralInnerSelectionMargin:0.00025,
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA
  });
  assert.equal(profile.neural_network.required_selection_samples,40);
  assert.equal(profile.neural_network.required_selection_positive_samples,2);
  assert.equal(profile.neural_network.required_selection_negative_samples,8);
  assert.equal(profile.neural_network.selection_support_ready,true);
  assert.equal(profile.neural_network.inner_selection_diagnostics.required_brier_margin,0.00025);
  assert.equal(profile.neural_network.inner_selection_diagnostics.outer_validation_required_margin,0.003);
  assert.equal(profile.neural_network.selection_margin,0.003);
  assert.equal(profile.feature_schema,DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA);
  assert.equal(profile.feature_names.length,COGNITIVE_DAILY_FEATURE_NAMES.length);
  assert.equal(profile.neural_network.input_neurons,COGNITIVE_DAILY_FEATURE_NAMES.length);
  assert.equal(profile.neural_network.architecture,'35-10-6-1+RESIDUAL');
  assert.equal(profile.neural_network.trained,false);
  assert.equal(profile.neural_network.status,'WAITING_FOR_MATURED_TRAINING_SAMPLES');
});


test('low-rank factor-cross projection equals pairwise interactions and passes finite-difference derivative audit',()=>{
  const vector=[0.7,-0.4,1.1,0.25];
  const factors=[[0.2,-0.4],[0.7,0.3],[-0.2,0.5],[0.15,-0.1]];
  const projection=factorizationMachineProjection(vector,factors);
  assert.ok(projection);
  for(let component=0;component<2;component++){
    let exact=0;
    for(let i=0;i<vector.length;i++)for(let j=i+1;j<vector.length;j++)
      exact+=factors[i][component]*factors[j][component]*vector[i]*vector[j];
    assert.ok(Math.abs(projection.interactions[component]-exact)<1e-12);
    for(let feature=0;feature<vector.length;feature++){
      const epsilon=1e-6;
      const plus=factors.map(row=>[...row]),minus=factors.map(row=>[...row]);
      plus[feature][component]+=epsilon;minus[feature][component]-=epsilon;
      const upper=factorizationMachineProjection(vector,plus).interactions[component];
      const lower=factorizationMachineProjection(vector,minus).interactions[component];
      const numeric=(upper-lower)/(2*epsilon);
      const analytic=projection.factor_derivatives[feature][component];
      assert.ok(Math.abs(numeric-analytic)<1e-8,
        `factor derivative mismatch at feature ${feature}, component ${component}: ${numeric} vs ${analytic}`);
    }
  }
  assert.equal(factorizationMachineProjection(vector,[[]]),null);
});

test('daily feature schema can train and evaluate a real 35-input MLP without dimension fallback',()=>{
  const horizon=24*60*60*1000;
  const samples=[];
  for(let day=0;day<500;day++){
    for(let symbolIndex=0;symbolIndex<3;symbolIndex++){
      const at=1_740_000_000_000+day*horizon;
      const symbol='D'+symbolIndex+'USDT';
      const positive=(day*7+symbolIndex*3)%11===0;
      samples.push({
        id:'DAILY_35_INPUT:'+symbol+':'+String(at),
        symbol,at,resolved_at:at+horizon,horizon_ms:horizon,
        outcome:positive?'UP':'DOWN',outcome_source:'UNIT_TEST_DAILY_35',
        training_eligible:true,closed_candle_baseline:true,
        features:{
          volume_ratio:positive?2.1:0.9,trade_ratio:positive?1.8:0.8,
          taker_buy_ratio:positive?0.64:0.47,
          relative_strength_vs_btc_pct:positive?1.1:-0.4,
          recent_15m_return_pct:positive?0.5:-0.35,
          return_30m_pct:positive?0.8:-0.5,hourly_return_pct:positive?1.2:-0.8,
          return_3h_pct:positive?2.2:-1.4,btc_hourly_return_pct:0.2,
          daily_change_pct:positive?3.2:-2.1,
          relative_strength_vs_btc_24h_pct:positive?2.3:-1.2,
          quote_volume_24h:positive?2_400_000:1_100_000,
          breakout_distance_pct:positive?0.25:-0.15,
          current_range_pct:1.3,lower_wick_pct:positive?0.42:0.08,
          close_location:positive?0.76:0.38,upper_wick_pct:0.12,
          higher_low:positive,breakout_above_prior_high:false,
          compression_ratio:0.72,micro_5m_available:true,
          micro_5m_volume_ratio:positive?1.9:0.85,
          micro_5m_trade_ratio:positive?1.6:0.9,
          micro_5m_return_pct:positive?0.3:-0.2,
          micro_5m_close_location:positive?0.75:0.4,
          micro_5m_taker_buy_ratio:positive?0.68:0.46
        }
      });
    }
  }
  const profile=buildCognitiveLearningProfile(samples,{
    minTrainingSamples:100,minimumValidationSamples:30,minimumHoldoutSamples:30,
    validationFraction:0.2,holdoutFraction:0.2,
    outcomeHorizonMs:horizon,allowedOutcomeSources:['UNIT_TEST_DAILY_35'],
    minNeuralTrainingSamples:240,maxNeuralTrainingSamples:6000,
    minimumNeuralSelectionSamples:40,minimumNeuralSelectionPositiveSamples:2,
    minimumNeuralSelectionNegativeSamples:8,temporalSamples:[],
    iterations:40,learningRate:0.08,neuralIterations:10,
    neuralInnerSelectionMargin:0.00025,
    neuralTrainingHistoryFraction:DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION,
    neuralAnchorAdaptation:DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA
  });
  assert.equal(profile.neural_network.trained,true);
  assert.equal(profile.neural_network.training_history_fraction,0.60);
  assert.ok(profile.neural_network.fit_training_samples<profile.neural_network.preselection_training_samples,
    'the MLP gradient fit must use the newest 60% of its timestamp-grouped training block');
  assert.ok(profile.neural_network.fit_training_samples>=240,
    'the recency window must preserve the minimum neural training support');
  assert.ok(profile.neural_network.max_training_outcome_resolved_at<profile.neural_network.selection_start_at,
    'recency selection must not leak into the later member-selection block');
  assert.equal(profile.neural_network.input_neurons,35);
  assert.equal(profile.neural_network.architecture,'35-10-6-1+RESIDUAL');
  assert.equal(profile.neural_network.feature_schema,COGNITIVE_DAILY_FEATURE_SCHEMA);
  assert.equal(profile.neural_network.anchor_adaptation,'TRUST_REGION_TETHERED_V1');
  assert.equal(profile.neural_network.anchor_trust_radius,0.12);
  assert.equal(profile.neural_network.anchor_bias_trust_radius,0.15);
  assert.equal(profile.neural_network.anchor_tether_strength,0.35);
  assert.equal(profile.neural_network.anchor_learning_rate_scale,0.25);
  assert.ok(profile.neural_network.max_anchor_skip_delta<=0.120001,
    'all adjusted logistic skip coefficients must stay inside the declared trust region');
  assert.ok(profile.neural_network.anchor_output_bias_delta<=0.150001,
    'the adjusted output bias must stay inside the declared trust region');
  assert.equal(profile.neural_network.validation.evaluated,true);
  assert.equal(profile.neural_network.holdout.evaluated,true);

  const fullHistoryProfile=buildCognitiveLearningProfile(samples,{
    minTrainingSamples:100,minimumValidationSamples:30,minimumHoldoutSamples:30,
    validationFraction:0.2,holdoutFraction:0.2,
    outcomeHorizonMs:horizon,allowedOutcomeSources:['UNIT_TEST_DAILY_35'],
    minNeuralTrainingSamples:240,maxNeuralTrainingSamples:6000,
    minimumNeuralSelectionSamples:40,minimumNeuralSelectionPositiveSamples:2,
    minimumNeuralSelectionNegativeSamples:8,temporalSamples:[],
    iterations:40,learningRate:0.08,neuralIterations:10,
    neuralInnerSelectionMargin:0.00025,neuralTrainingHistoryFraction:1,
    neuralAnchorAdaptation:DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA
  });
  assert.equal(fullHistoryProfile.neural_network.trained,true);
  assert.equal(fullHistoryProfile.neural_network.training_history_fraction,1);
  assert.equal(fullHistoryProfile.neural_network.fit_training_samples,
    fullHistoryProfile.neural_network.preselection_training_samples,
    '100% MLP fit must use the entire eligible timestamp-grouped train block');
  assert.ok(fullHistoryProfile.neural_network.max_training_outcome_resolved_at<
    fullHistoryProfile.neural_network.selection_start_at,
    'full-history MLP must remain purged before member selection');
  assert.equal(fullHistoryProfile.neural_network.validation.sample_count,
    profile.neural_network.validation.sample_count,
    'history ablation must preserve outer validation membership');
  assert.equal(fullHistoryProfile.neural_network.holdout.sample_count,
    profile.neural_network.holdout.sample_count,
    'history ablation must preserve untouched holdout membership');

  const factorizedProfile=buildCognitiveLearningProfile(samples,{
    minTrainingSamples:100,minimumValidationSamples:30,minimumHoldoutSamples:30,
    validationFraction:0.2,holdoutFraction:0.2,
    outcomeHorizonMs:horizon,allowedOutcomeSources:['UNIT_TEST_DAILY_35'],
    minNeuralTrainingSamples:240,maxNeuralTrainingSamples:6000,
    minimumNeuralSelectionSamples:40,minimumNeuralSelectionPositiveSamples:2,
    minimumNeuralSelectionNegativeSamples:8,temporalSamples:[],
    iterations:40,learningRate:0.08,neuralIterations:10,
    neuralInnerSelectionMargin:0.00025,neuralTrainingHistoryFraction:1,
    neuralAnchorAdaptation:DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
    enableFactorizationMachine:true,factorizationRank:3,
    factorizationIterations:30,factorizationLearningRate:0.008,factorizationL2:0.06,
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA
  });
  const fmNeural=factorizedProfile.neural_network;
  assert.equal(fmNeural.trained,true);
  assert.equal(fmNeural.factorization_member_enabled,true);
  assert.equal(fmNeural.ensemble_members,4);
  assert.equal(fmNeural.ensemble_members_required,4);
  assert.equal(fmNeural.member_training_profiles.filter(item=>
    item.model_kind==='RESIDUAL_FACTOR_CROSS_V1').length,1);
  assert.equal(fmNeural.inner_selection_diagnostics.candidate_member_scale_count,20,
    'the low-rank pairwise member must enter the same 4-member x 5-scale selection grid');
  assert.ok(fmNeural.max_training_outcome_resolved_at<fmNeural.selection_start_at,
    'factor-cross fit must remain strictly before the disjoint selection block');
});

test('daily anchor diagnostics report requested and applied modes without a false frozen default',()=>{
  assert.deepEqual(summarizeDailyNeuralAnchorDiagnostics({},DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION),{
    anchor_adaptation_requested:'TRUST_REGION_TETHERED_V1',
    anchor_adaptation:'NOT_REPORTED',
    anchor_trust_radius:null,
    anchor_bias_trust_radius:null,
    anchor_tether_strength:null,
    anchor_learning_rate_scale:null,
    max_anchor_skip_delta:null,
    anchor_output_bias_delta:null
  });
  assert.deepEqual(summarizeDailyNeuralAnchorDiagnostics({
    anchor_adaptation:'TRUST_REGION_TETHERED_V1',
    anchor_trust_radius:0.12,anchor_bias_trust_radius:0.15,
    anchor_tether_strength:0.35,anchor_learning_rate_scale:0.25,
    max_anchor_skip_delta:0.08,anchor_output_bias_delta:0.03
  }),{
    anchor_adaptation_requested:'TRUST_REGION_TETHERED_V1',
    anchor_adaptation:'TRUST_REGION_TETHERED_V1',
    anchor_trust_radius:0.12,anchor_bias_trust_radius:0.15,
    anchor_tether_strength:0.35,anchor_learning_rate_scale:0.25,
    max_anchor_skip_delta:0.08,anchor_output_bias_delta:0.03
  });
});

test('inner MLP selection margin is decoupled but cannot weaken the outer 0.003 gate',()=>{
  assert.equal(DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN,0.00025);
  assert.equal(effectiveNeuralInnerSelectionMargin(null,0.003),0.003);
  assert.equal(effectiveNeuralInnerSelectionMargin(0.00025,0.003),0.00025);
  assert.equal(effectiveNeuralInnerSelectionMargin(0.01,0.003),0.003);
  assert.equal(effectiveNeuralInnerSelectionMargin(-0.01,0.003),0);
  assert.equal(effectiveNeuralInnerSelectionMargin(0.00025,0.006),0.00025);
});

test('daily TCN and MLP history experiments use isolated 32768-row caps without changing the legacy 4h contract',()=>{
  assert.equal(DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,32768);
  assert.equal(DAILY_EARLY_RISER_MLP_MAX_TRAINING_SAMPLES,32768);
  assert.equal(DAILY_EARLY_RISER_MLP_TRAINING_HISTORY_FRACTION,0.60);
});


test('persisted benchmark report retains the independent regime-local TCN challenger',async()=>{
  const source=await readFile(new URL('../tools/daily-early-riser-neural-benchmark.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('temporal_regime_local_tcn_challenger:result.temporal_regime_local_tcn_challenger'),
    'compactTarget must serialize the independent TCN challenger instead of dropping it');
  assert.ok(source.includes('temporal_regime_local_tcn_pyramid_challenger:result.temporal_regime_local_tcn_pyramid_challenger'),
    'compactTarget must serialize the ordered-pooling TCN challenger instead of dropping it');
  assert.ok(source.includes('temporal_regime_local_tcn_multiscale_challenger:result.temporal_regime_local_tcn_multiscale_challenger'),
    'compactTarget must serialize the full-receptive-field V10 challenger instead of dropping it');
  assert.ok(source.includes("const attentionOnly=String(args['attention-only']||'false')==='true'"));
  assert.ok(source.includes('V11_ATTENTION_ONLY_REQUIRES_TCN_ONLY_MODE'));
  assert.ok(source.includes('research_mode:tcnOnly'));
  assert.ok(source.includes('V11_ATTENTION_ONLY_ISOLATED_COMPUTE'));
  assert.ok(source.includes('enableRegimeLocalTcn:!attentionOnly'));
  assert.ok(source.includes('enableRegimeLocalTcnPyramid:!attentionOnly'));
  assert.ok(source.includes('enableRegimeLocalTcnMultiscale:!attentionOnly'));
  assert.ok(source.includes('enableRegimeLocalTcnAttention:true'));
  assert.ok(source.includes("args['neural-training-history-fraction']"));
  assert.ok(source.includes('neuralTrainingHistoryFraction,'));
  assert.ok(source.includes("args['enable-factorization-machine']"));
  assert.ok(source.includes('enableFactorizationMachine,factorizationRank,factorizationIterations'));
  assert.ok(source.includes('factorization_candidate_scores'));
});

test('daily MLP iteration budget is explicit, bounded and supports deeper convergence ablations',()=>{
  assert.equal(effectiveDailyMlpIterations(),30);
  assert.equal(effectiveDailyMlpIterations(20),30);
  assert.equal(effectiveDailyMlpIterations(60),60);
  assert.equal(effectiveDailyMlpIterations(120),120);
  assert.equal(effectiveDailyMlpIterations(999),DAILY_EARLY_RISER_MLP_MAX_ITERATIONS);
  assert.equal(effectiveDailyMlpIterations(-5),30);
  assert.equal(DAILY_EARLY_RISER_MLP_MAX_ITERATIONS,180);
});

test('daily neural benchmark CLI forwards and records an explicit MLP iteration budget',async()=>{
  const source=await readFile(new URL('../tools/daily-early-riser-neural-benchmark.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("args['neural-iterations']"));
  assert.ok(source.includes('neural_iterations:neuralIterations'));
  assert.ok(source.includes('neuralTrainingHistoryFraction,neuralIterations,'));
});

test('72h safe-opportunity target definition is carried into the cognitive comparison contract',()=>{
  const at=1_800_000_000_000;
  const horizonMs=72*60*60*1000;
  const expectedDefinition='FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_72H_15M_V1';
  const expectedSemantics='PLUS_TARGET_BEFORE_MINUS_2_PERCENT_WITHIN_HORIZON';
  const sample=sampleWith({
    at,targetPct:5,outcome:'UP',resolvedAt:at+horizonMs,horizonMs,
    outcomeSource:DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE
  });
  sample.safe_opportunity_targets={
    '72h':{
      plus_5_pct:{
        status:'RESOLVED',outcome:'UP',resolved_at:at+horizonMs,horizon_ms:horizonMs,
        outcome_source:DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE,
        target_definition:expectedDefinition
      }
    }
  };
  const prepared=prepareDailyEarlyRiserCognitiveRow(sample,5,{
    labelMode:'safe_opportunity',horizonHours:72
  });
  assert.ok(prepared.row,prepared.reason||'safe 72h sample should be valid');
  const profile=buildCognitiveLearningProfile([prepared.row],{
    outcomeHorizonMs:horizonMs,
    allowedOutcomeSources:[DAILY_EARLY_RISER_SAFE_OUTCOME_SOURCE],
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
    modelTargetDefinition:expectedDefinition,
    modelTargetSemantics:expectedSemantics,
    temporalSamples:[],temporalOptions:{}
  });
  assert.equal(profile.comparison_contract.target_definition,expectedDefinition);
  assert.equal(profile.comparison_contract.target_semantics,expectedSemantics);
  assert.equal(profile.neural_network.target_definition,expectedDefinition);
  assert.equal(profile.neural_network.target_semantics,expectedSemantics);
});
