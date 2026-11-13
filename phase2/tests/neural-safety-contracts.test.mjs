import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTemporalSequenceAlignment,
  causalForwardFillWindow,
  prequalifyHybridComponent,
  prequalifyHybridComponents,
  calculateAsymmetricDirectionalRankingLoss
} from '../core/neural-safety-contracts.mjs';

const STEPS=24,CHANNELS=29,INTERVAL=900000,AT=1_740_000_000_000;
const seq=()=>Array.from({length:STEPS},()=>{const row=Array(CHANNELS).fill(0.1);row[28]=1;return row;});
const times=()=>Array.from({length:STEPS},(_,i)=>AT-(STEPS-1-i)*INTERVAL);

test('temporal alignment requires exact shape, 15m cadence, baseline close and target maturity',()=>{
  const base={
    id:'x',symbol:'BTCUSDT',at:AT,resolved_at:AT+86400000,horizon_ms:86400000,
    temporal_sequence:seq(),temporal_sequence_timestamps:times(),
    feature_information_cutoff_at:AT
  };
  const good=validateTemporalSequenceAlignment(base);
  assert.equal(good.valid,true);
  assert.equal(good.cadence_verified,true);
  assert.equal(validateTemporalSequenceAlignment({
    ...base,temporal_sequence_timestamps:undefined
  }).reason,'TEMPORAL_SEQUENCE_TIMESTAMPS_MISSING');
  const gap=times();gap[12]+=1;
  assert.equal(validateTemporalSequenceAlignment({
    ...base,temporal_sequence_timestamps:gap
  }).reason,'TEMPORAL_SEQUENCE_TIMESTAMP_GAP_OR_REORDER:12');
  assert.equal(validateTemporalSequenceAlignment({
    ...base,temporal_sequence_timestamps:times().slice(0,23).concat([AT+INTERVAL])
  }).reason,'TEMPORAL_SEQUENCE_LAST_CLOSE_DIFFERS_FROM_BASELINE');
  assert.equal(validateTemporalSequenceAlignment({
    ...base,feature_information_cutoff_at:AT+INTERVAL
  }).reason,'FEATURE_CUTOFF_DIFFERS_FROM_BASELINE');
  assert.equal(validateTemporalSequenceAlignment({
    ...base,resolved_at:AT+86400001
  }).reason,'OUTCOME_MATURITY_DOES_NOT_MATCH_HORIZON');
  const badMask=seq();badMask[4][28]=0.5;
  assert.equal(validateTemporalSequenceAlignment({
    ...base,temporal_sequence:badMask,binaryMaskChannels:[28]
  }).reason,'TEMPORAL_BINARY_MASK_CHANNEL_INVALID:28:4');
});

test('causal forward fill masks approved sparse features and never fills leading or price-channel gaps',()=>{
  const end=AT,grid=Array.from({length:4},(_,i)=>end-(3-i)*INTERVAL);
  const observations=[
    {timestamp:grid[0],values:[1,5]},
    {timestamp:grid[1],values:[2,null]},
    {timestamp:grid[2],values:[3,null]},
    {timestamp:grid[3],values:[4,8]}
  ];
  const filled=causalForwardFillWindow(observations,{
    endTimestamp:end,expectedSteps:4,intervalMs:INTERVAL,expectedChannels:2,
    allowedSparseChannels:[1],maxGapIntervals:2
  });
  assert.deepEqual(filled.values.map(row=>row[1]),[5,5,5,8]);
  assert.deepEqual(filled.observation_masks.map(row=>row[1]),[1,0,0,1]);
  assert.equal(filled.imputed_values,2);
  assert.throws(()=>causalForwardFillWindow([
    {timestamp:grid[0],values:[1,null]},
    {timestamp:grid[1],values:[2,null]},
    {timestamp:grid[2],values:[3,null]},
    {timestamp:grid[3],values:[4,null]}
  ],{endTimestamp:end,expectedSteps:4,intervalMs:INTERVAL,expectedChannels:2,
    allowedSparseChannels:[],maxGapIntervals:2}),/FORWARD_FILL_NOT_ALLOWED_FOR_CHANNEL/);
  assert.throws(()=>causalForwardFillWindow([
    {timestamp:grid[0],values:[1,5]},
    {timestamp:grid[1],values:[2,null]},
    {timestamp:grid[2],values:[3,null]},
    {timestamp:grid[3],values:[4,null]}
  ],{endTimestamp:end,expectedSteps:4,intervalMs:INTERVAL,expectedChannels:2,
    allowedSparseChannels:[1],maxGapIntervals:2}),/FORWARD_FILL_GAP_EXCEEDS_SAFE_LIMIT/);
  assert.throws(()=>causalForwardFillWindow([
    {timestamp:end+INTERVAL,values:[1,2]}
  ],{endTimestamp:end,expectedSteps:4,intervalMs:INTERVAL,expectedChannels:2,
    allowedSparseChannels:[1]}),/FORWARD_FILL_FUTURE_OBSERVATION_FORBIDDEN/);
});

test('hybrid prequalification rejects unfit or weak standalone components',()=>{
  const good=prequalifyHybridComponent({
    name:'MLP',fitValid:true,
    selection:{samples:80,positive:20,negative:60,candidateBrier:0.14,logisticBrier:0.141}
  });
  assert.equal(good.qualified,true);
  const weak=prequalifyHybridComponent({
    name:'GBDT',fitValid:true,
    selection:{samples:80,positive:20,negative:60,candidateBrier:0.1408,logisticBrier:0.141}
  });
  assert.equal(weak.qualified,false);
  const combined=prequalifyHybridComponents([
    {name:'MLP',fitValid:true,selection:{samples:80,positive:20,negative:60,candidateBrier:0.14,logisticBrier:0.141}},
    {name:'GBDT',fitValid:true,selection:{samples:80,positive:20,negative:60,candidateBrier:0.1408,logisticBrier:0.141}}
  ]);
  assert.equal(combined.qualified,false);
  assert.equal(combined.qualified_component_count,1);
});

test('pairwise directional ranking pairs only positive and negative rows at identical timestamps',()=>{
  const result=calculateAsymmetricDirectionalRankingLoss({
    logits:[0.3,-0.1,0.2,-0.2],
    targets:[1,0,1,0],
    timestamps:[10,10,20,30],
    symbols:['A','B','C','D'],
    baselineLogits:[0,0,0,0]
  });
  assert.equal(result.metrics.timestamp_group_count,3);
  assert.equal(result.metrics.same_timestamp_pair_count,1);
  const noSameTimePairs=calculateAsymmetricDirectionalRankingLoss({
    logits:[0.3,-0.1],targets:[1,0],timestamps:[10,20],
    symbols:['A','B'],baselineLogits:[0,0]
  });
  assert.equal(noSameTimePairs.metrics.same_timestamp_pair_count,0);
});

test('false-positive high-confidence and baseline-gap terms appear in the objective',()=>{
  const common={
    targets:[1,0,0],timestamps:[1,1,1],symbols:['A','B','C'],
    baselineLogits:[0,0,0],config:{rankingWeight:0,falsePositiveWeight:1,baselineGapWeight:0}
  };
  const confident=calculateAsymmetricDirectionalRankingLoss({...common,logits:[0.2,3,0.1]});
  const modest=calculateAsymmetricDirectionalRankingLoss({...common,logits:[0.2,0.2,0.1]});
  assert.ok(confident.metrics.false_positive_confidence_penalty>
    modest.metrics.false_positive_confidence_penalty);
  assert.ok(confident.gradient_logits[1]>0);
  const baselineAware=calculateAsymmetricDirectionalRankingLoss({
    ...common,logits:[0.2,0.1,0.1],
    config:{rankingWeight:0,falsePositiveWeight:0,baselineGapWeight:1,requiredBaselineImprovement:0.01}
  });
  assert.ok(baselineAware.metrics.baseline_gap_penalty>=0);
});

test('asymmetric directional loss analytic logit gradients match central finite differences',()=>{
  const args={
    logits:[0.4,-0.2,0.1,-0.5],
    targets:[1,0,1,0],
    timestamps:[100,100,100,200],
    symbols:['A','B','C','D'],
    baselineLogits:[0.05,0.02,0.01,-0.1],
    config:{rankingWeight:0.31,falsePositiveWeight:0.42,baselineGapWeight:0.27,
      requiredBaselineImprovement:0.002,pairMargin:0.08,pairTemperature:0.7}
  };
  const analytic=calculateAsymmetricDirectionalRankingLoss(args);
  for(let index=0;index<args.logits.length;index++){
    const upper=[...args.logits],lower=[...args.logits],step=1e-5;
    upper[index]+=step;lower[index]-=step;
    const plus=calculateAsymmetricDirectionalRankingLoss({...args,logits:upper}).loss;
    const minus=calculateAsymmetricDirectionalRankingLoss({...args,logits:lower}).loss;
    const numeric=(plus-minus)/(2*step);
    assert.ok(Math.abs(numeric-analytic.gradient_logits[index])<2e-6,
      'gradient mismatch at '+index+': '+numeric+' vs '+analytic.gradient_logits[index]);
  }
});

test('non-finite predictions and timestamps fail closed before loss propagation',()=>{
  assert.throws(()=>calculateAsymmetricDirectionalRankingLoss({
    logits:[NaN,0],targets:[1,0],timestamps:[1,1],baselineLogits:[0,0]
  }),/DIRECTIONAL_LOSS_INPUT_NON_FINITE_OR_NON_BINARY/);
  assert.throws(()=>calculateAsymmetricDirectionalRankingLoss({
    logits:[0,0],targets:[1,0],timestamps:[1,Infinity],baselineLogits:[0,0]
  }),/DIRECTIONAL_LOSS_TIMESTAMP_VECTOR_INVALID/);
});

test('temporal alignment rejects invalid shape configuration and whitespace numeric input',()=>{
  const base={
    id:'x',symbol:'BTCUSDT',at:AT,resolved_at:AT+86400000,horizon_ms:86400000,
    temporal_sequence:seq(),temporal_sequence_timestamps:times(),
    feature_information_cutoff_at:AT
  };
  assert.equal(validateTemporalSequenceAlignment({...base,expectedSteps:0}).reason,
    'TEMPORAL_VALIDATION_CONFIGURATION_INVALID');
  assert.equal(validateTemporalSequenceAlignment({...base,expectedChannels:0}).reason,
    'TEMPORAL_VALIDATION_CONFIGURATION_INVALID');
  assert.equal(validateTemporalSequenceAlignment({...base,intervalMs:0}).reason,
    'TEMPORAL_VALIDATION_CONFIGURATION_INVALID');
  assert.equal(validateTemporalSequenceAlignment({...base,at:'   '}).reason,
    'TEMPORAL_EVENT_TIME_NON_FINITE');
  assert.equal(validateTemporalSequenceAlignment({...base,binaryMaskChannels:[28,28]}).reason,
    'TEMPORAL_BINARY_MASK_CHANNEL_CONTRACT_INVALID');
});

test('hybrid prequalification rejects invalid thresholds instead of silently weakening release gates',()=>{
  const selection={samples:80,positive:20,negative:60,candidateBrier:0.14,logisticBrier:0.141};
  const invalidMargin=prequalifyHybridComponent({
    name:'MLP',fitValid:true,selection,requiredMargin:-0.01
  });
  assert.equal(invalidMargin.qualified,false);
  assert.equal(invalidMargin.reason,'COMPONENT_PREQUALIFICATION_CONFIG_INVALID');
  const invalidSupport=prequalifyHybridComponent({
    name:'GBDT',fitValid:true,selection,minimumSamples:0
  });
  assert.equal(invalidSupport.qualified,false);
  assert.equal(invalidSupport.reason,'COMPONENT_PREQUALIFICATION_CONFIG_INVALID');
  const invalidHybrid=prequalifyHybridComponents([], {minimumQualified:0});
  assert.equal(invalidHybrid.qualified,false);
  assert.equal(invalidHybrid.reason,'HYBRID_MINIMUM_QUALIFIED_CONFIGURATION_INVALID');
});

test('directional pair sampling is bounded for large same-timestamp candidate sets',()=>{
  const positiveCount=500,negativeCount=500,total=positiveCount+negativeCount;
  const logits=Array.from({length:total},(_,index)=>index<positiveCount?0.2:-0.2);
  const targets=Array.from({length:total},(_,index)=>index<positiveCount?1:0);
  const symbols=Array.from({length:total},(_,index)=>(index<positiveCount?'P':'N')+index);
  const result=calculateAsymmetricDirectionalRankingLoss({
    logits,targets,timestamps:Array(total).fill(AT),symbols,
    baselineLogits:Array(total).fill(0),
    config:{maxPairsPerTimestamp:64}
  });
  assert.equal(result.metrics.same_timestamp_pair_count,64);
  assert.equal(result.metrics.timestamp_group_count,1);
});

test('directional loss rejects malformed vectors and unbounded pair configuration',()=>{
  const args={
    logits:[0.2,-0.2],targets:[1,0],timestamps:[1,1],
    symbols:['A','B'],baselineLogits:[0,0]
  };
  assert.throws(()=>calculateAsymmetricDirectionalRankingLoss({...args,sampleWeights:null}),
    /DIRECTIONAL_LOSS_SAMPLE_WEIGHTS_INVALID/);
  assert.throws(()=>calculateAsymmetricDirectionalRankingLoss({...args,symbols:null}),
    /DIRECTIONAL_LOSS_SYMBOL_VECTOR_INVALID/);
  assert.throws(()=>calculateAsymmetricDirectionalRankingLoss({
    ...args,config:{maxPairsPerTimestamp:1.5}
  }),/DIRECTIONAL_LOSS_CONFIG_OUT_OF_RANGE/);
  assert.throws(()=>calculateAsymmetricDirectionalRankingLoss({
    ...args,config:{brierWeight:0}
  }),/DIRECTIONAL_LOSS_CONFIG_OUT_OF_RANGE/);
});
