import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_EARLY_RISER_HORIZON_MS,
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,
  prepareDailyEarlyRiserCognitiveRow
} from '../core/daily-early-riser-neural-benchmark.mjs';
import {
  buildCognitiveLearningProfile,
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
    neuralIterations:20
  });
  assert.equal(profile.neural_network.required_selection_samples,40);
  assert.equal(profile.neural_network.required_selection_positive_samples,2);
  assert.equal(profile.neural_network.required_selection_negative_samples,8);
  assert.equal(profile.neural_network.selection_support_ready,true);
  assert.equal(profile.neural_network.trained,false);
  assert.equal(profile.neural_network.status,'WAITING_FOR_MATURED_TRAINING_SAMPLES');
});


test('daily TCN uses a larger isolated training budget without changing the legacy default',()=>{
  assert.equal(DAILY_EARLY_RISER_TCN_MAX_TRAINING_SAMPLES,8192);
});
