import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  DAILY_EARLY_RISER_HORIZON_MS,
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,
  DAILY_EARLY_RISER_MLP_INNER_SELECTION_MARGIN,
  DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
  DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
  summarizeDailyNeuralAnchorDiagnostics,
  prepareDailyEarlyRiserCognitiveRow
} from '../core/daily-early-riser-neural-benchmark.mjs';
import {
  buildCognitiveLearningProfile,
  buildCognitiveFeatureVector,
  COGNITIVE_FEATURE_NAMES,
  COGNITIVE_FEATURE_SCHEMA,
  COGNITIVE_DAILY_FEATURE_NAMES,
  COGNITIVE_DAILY_FEATURE_SCHEMA,
  effectiveNeuralInnerSelectionMargin,
  effectiveNeuralSelectionMinimum,
  hasNeuralSelectionSupport,
  predictCognitiveProbability
} from '../core/cognitive-brain.mjs';
import {
  createDailyEarlyRiserForwardForecastPairFromModelBundle
} from '../core/daily-early-riser-forward-shadow.mjs';
import {
  buildTemporalNeuralProfile,
  TEMPORAL_TARGET_DEFINITION,
  TEMPORAL_SEQUENCE_STEPS,
  TEMPORAL_SEQUENCE_CHANNELS
} from '../core/temporal-neural-brain.mjs';

function createHashForTest(value){
  return createHash('sha256').update(value).digest('hex');
}

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
    neuralAnchorAdaptation:DAILY_EARLY_RISER_MLP_ANCHOR_ADAPTATION,
    featureSchema:DAILY_EARLY_RISER_MODEL_FEATURE_SCHEMA,
    includeNeuralModelFit:true
  });
  assert.equal(profile.neural_network.trained,true);
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
  if(profile.neural_network.selected_member_index>=0){
    assert.ok(profile.neural_network.model_fit);
    assert.ok(profile.neural_network.same_window_logistic_fit);
    const neuralProbability=predictCognitiveProbability(
      samples.at(-1).features,profile.neural_network.model_fit
    );
    const logisticProbability=predictCognitiveProbability(
      samples.at(-1).features,profile.neural_network.same_window_logistic_fit
    );
    assert.ok(neuralProbability>=0.02&&neuralProbability<=0.98);
    assert.ok(logisticProbability>=0.02&&logisticProbability<=0.98);

    const stable=value=>{
      if(value===null||typeof value!=='object')return JSON.stringify(value);
      if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
      return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
    };
    const digest=value=>createHashForTest(stable(value));
    const modelBundle={
      schema:'RADARX_DAILY_EARLY_RISER_SHADOW_MODEL_V1',
      enabled:true,target_pct:5,
      target_definition:'FIRST_PASSAGE_PLUS_5_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1',
      horizon_ms:horizon,feature_schema:COGNITIVE_DAILY_FEATURE_SCHEMA,
      feature_names:[...profile.feature_names],
      trained_through_at:profile.neural_network.max_refit_training_outcome_resolved_at,
      selected_member_index:profile.neural_network.selected_member_index,
      selected_residual_scale:profile.neural_network.selected_residual_scale,
      historical_holdout_passed:profile.neural_network.holdout_comparison?.passed===true,
      model_fit:profile.neural_network.model_fit,
      same_window_logistic_fit:profile.neural_network.same_window_logistic_fit,
      research_only:true,production_eligible:false,real_order_execution:false,
      training_dataset_sha256:'a'.repeat(64),source_code_commit:'b'.repeat(40)
    };
    modelBundle.mlp_model_sha256=digest(modelBundle.model_fit);
    modelBundle.logistic_model_sha256=digest(modelBundle.same_window_logistic_fit);
    const identity={
      schema:modelBundle.schema,target_pct:modelBundle.target_pct,
      target_definition:modelBundle.target_definition,horizon_ms:modelBundle.horizon_ms,
      feature_schema:modelBundle.feature_schema,feature_names:modelBundle.feature_names,
      trained_through_at:modelBundle.trained_through_at,
      training_dataset_sha256:modelBundle.training_dataset_sha256,
      source_code_commit:modelBundle.source_code_commit,
      mlp_model_sha256:modelBundle.mlp_model_sha256,
      logistic_model_sha256:modelBundle.logistic_model_sha256,
      selected_member_index:modelBundle.selected_member_index,
      selected_residual_scale:modelBundle.selected_residual_scale
    };
    const modelBundleSha=digest(identity);
    const at=Math.max(Date.now(),Number(modelBundle.trained_through_at)+horizon+1);
    const baseline={
      openTime:at-15*60*1000+1,open:100,high:101,low:99,close:100,closeTime:at,
      quoteVolume:1_000_000,trades:1000,takerBuyQuoteVolume:500_000
    };
    const forecasts=createDailyEarlyRiserForwardForecastPairFromModelBundle({
      model_bundle:modelBundle,model_bundle_sha256:modelBundleSha,
      symbol:'AAAUSDT',at,feature_information_cutoff_at:at,recorded_at:at+1,
      baseline,features:samples.at(-1).features
    });
    assert.equal(forecasts.length,2);
    assert.equal(forecasts[0].model_variant,'DAILY_MLP_CHALLENGER_V1');
    assert.equal(forecasts[1].model_variant,'SAME_WINDOW_LOGISTIC_BASELINE_V1');
    assert.ok(Math.abs(forecasts[0].up_probability-predictCognitiveProbability(
      samples.at(-1).features,modelBundle.model_fit))<1e-12);
    assert.ok(Math.abs(forecasts[1].up_probability-predictCognitiveProbability(
      samples.at(-1).features,modelBundle.same_window_logistic_fit))<1e-12);
  }else{
    assert.equal(profile.neural_network.model_fit,undefined);
  }
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

test('daily TCN uses a larger isolated training budget without changing the legacy default',()=>{
  assert.equal(DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,8192);
});
