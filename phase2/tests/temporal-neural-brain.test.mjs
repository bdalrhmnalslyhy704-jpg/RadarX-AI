import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPORAL_TARGET_DEFINITION,
  TEMPORAL_MODEL_ARCHITECTURE,
  temporalBinaryTarget,
  TEMPORAL_SEQUENCE_STEPS,
  TEMPORAL_SEQUENCE_CHANNELS,
  buildTemporalNeuralProfile,
  predictTemporalProbability
} from '../core/temporal-neural-brain.mjs';

const FOUR_HOURS=4*60*60*1000;
const EIGHT_HOURS=8*60*60*1000;
const BASE_TIME=1_710_000_000_000;

function sequenceFor(up,index=0){
  return Array.from({length:TEMPORAL_SEQUENCE_STEPS},(_,step)=>{
    const pulse=Math.sin((step+index%7)*0.31)*0.04;
    return up
      ?[0.9+pulse,1.2,0.8,1.1,0.7,0.5,-0.2,0.9,1.25,1.1,0.8,0.7,0.4,0.5,0.7,0.2,1.1,0.9,1.2,1.4,0.6,0.3,0.8,1.4,0.9,0.1,1.2,1.0,1]
      :[-0.9-pulse,-1.1,-0.8,-1.0,-0.7,-0.5,0.2,-0.9,-1.0,-0.8,-0.9,-0.7,-0.4,0.5,-0.8,0.9,-0.7,-0.6,-1.1,-1.3,0.7,0.9,-0.8,-1.4,-0.9,0.1,-1.2,-1.0,1];
  });
}
function sample(group,index,{up=null}={}){
  const signal=up===null?(index%2===0):up;
  const at=BASE_TIME+group*EIGHT_HOURS;
  return {
    id:'TCN-'+group+'-'+index,
    symbol:'PAIR'+String(index).padStart(3,'0')+'USDT',
    at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
    training_eligible:true,historical_baseline:true,closed_candle_baseline:false,
    target_definition:TEMPORAL_TARGET_DEFINITION,
    outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:signal?'UP':'DOWN',return_pct:signal?2.4:-2.2,
    temporal_sequence:sequenceFor(signal,group+index)
  };
}

test('temporal target encodes only an actual +3% first-passage as success',()=>{
  assert.equal(temporalBinaryTarget('UP'),1);
  assert.equal(temporalBinaryTarget('DOWN'),0);
  assert.equal(temporalBinaryTarget('FLAT'),0);
});

test('temporal network fails closed without first-passage tensor samples',()=>{
  const profile=buildTemporalNeuralProfile([]);
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.live_eligibility_ready,false);
  assert.equal(profile.trained,false);
  assert.equal(predictTemporalProbability(sequenceFor(true),profile),null);
  assert.equal(profile.target_definition,TEMPORAL_TARGET_DEFINITION);
});

test('temporal network trains only on valid tensors and keeps chronological validation and holdout separate',()=>{
  const rows=[];
  for(let group=0;group<16;group++){
    for(let index=0;index<24;index++)rows.push(sample(group,index));
  }
  rows.push({...sample(0,999),id:'BAD-LEGACY',outcome_source:'HISTORICAL_CLOSED_CANDLE'});
  rows.push({...sample(0,998),id:'BAD-SEQUENCE',temporal_sequence:[[1,2]]});
  const profile=buildTemporalNeuralProfile(rows,{epochs:2});
  assert.equal(profile.resolved_samples,16*24);
  assert.equal(profile.trained,true);
  assert.equal(profile.architecture,TEMPORAL_MODEL_ARCHITECTURE);
  assert.equal(profile.ensemble_members,3);
  assert.equal(profile.training_strategy,'DIVERSIFIED_EPOCH_AND_REGULARIZATION_ENSEMBLE_V1');
  assert.equal(profile.member_training_profiles.length,3);
  assert.equal(new Set(profile.member_training_profiles.map(row=>JSON.stringify(row))).size,3,
    'ensemble members must use distinct deterministic training schedules');
  assert.equal(profile.sequence_steps,24);
  assert.equal(profile.sequence_channels,29);
  assert.ok(profile.training_samples>=160);
  assert.ok(profile.validation_samples>=50);
  assert.ok(profile.holdout_samples>=40,
    'small research fixtures use the 40-sample research minimum; live readiness still requires 100');
  assert.equal(profile.training_positive_count+profile.training_negative_count,profile.training_samples);
  assert.ok(profile.validation.positive_rate_pct>=0&&profile.validation.positive_rate_pct<=100);
  assert.ok(profile.holdout.positive_rate_pct>=0&&profile.holdout.positive_rate_pct<=100);
  assert.ok(profile.max_training_outcome_resolved_at<profile.validation_start_at);
  assert.ok(profile.validation_start_at<profile.holdout_start_at);
  assert.equal(profile.holdout_comparison.sample_count,profile.holdout_samples);
  assert.equal(profile.live_eligibility_ready,false,
    'a small research holdout must never satisfy the 100-outcome live gate');
  if(profile.probability_ready){
    const probability=predictTemporalProbability(sequenceFor(true),profile);
    assert.ok(Number.isFinite(probability)&&probability>=0&&probability<=1);
  }else{
    assert.equal(predictTemporalProbability(sequenceFor(true),profile),null,
      'no temporal probability is published until validation and untouched holdout pass');
  }
});

test('TCN trains and validates an independent expert for each supported BTC regime',()=>{
  const rows=[];
  for(let group=0;group<16;group++){
    for(let index=0;index<24;index++){
      const row=sample(group,index);
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2});
  assert.equal(profile.trained,true);
  assert.equal(profile.validation.evaluated,true);
  assert.equal(profile.holdout.evaluated,true);
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON']);
  const expert=profile.regime_specialists.BTC_RISK_ON;
  assert.equal(expert.model_scope,'SHARED_TCN_WITH_REGIME_CONDITIONAL_MEMBER_SELECTION');
  assert.ok(expert.training_samples>=80);
  assert.ok(expert.selection_samples>=10);
  assert.ok(expert.validation_samples>=24);
  assert.ok(expert.holdout_samples>=20);
  assert.ok(expert.max_training_outcome_resolved_at<expert.selection_start_at,
    'training labels must resolve before member selection begins');
  assert.ok(expert.selection_start_at<expert.validation_start_at,
    'member selection and reported validation must use disjoint chronological rows');
  assert.ok(expert.validation_start_at<profile.holdout_start_at,
    'final holdout must remain strictly later than all fitting and selection data');
  assert.equal(profile.regime_specialists.BTC_RISK_OFF.status,'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE');
  assert.ok(profile.regime_specialists.BTC_RISK_OFF.support_gaps.includes('HOLDOUT_SAMPLE_COUNT'));
  assert.ok(profile.holdout_comparison.sample_count>=40);
});

test('mature history reserves a broad untouched holdout for both BTC regime experts',()=>{
  const rows=[];
  for(let group=0;group<70;group++){
    for(let index=0;index<20;index++){
      const row=sample(group,index);
      const btcRiskOn=group%2===0;
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=btcRiskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2});
  assert.equal(profile.trained,true);
  assert.ok(profile.holdout_samples>=Math.ceil(rows.length*0.40),
    'mature history must reserve a sufficiently broad untouched holdout');
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
    const expert=profile.regime_specialists[regime];
    assert.ok(expert.holdout_samples>=20);
    assert.ok(expert.holdout_positive_samples>=5);
    assert.ok(expert.holdout_negative_samples>=20);
    assert.ok(expert.validation_start_at<profile.holdout_start_at);
  }
});

test('temporal network rejects wrong horizon, wrong target definition and incomplete sequences',()=>{
  const valid=sample(0,0);
  const wrongHorizon={...sample(1,0),horizon_ms:FOUR_HOURS/2};
  const wrongTarget={...sample(2,0),target_definition:'FOUR_HOUR_CLOSE_RETURN_V0'};
  const invalidSource={...sample(3,0),outcome_source:'LIVE_TICKER_PRICE'};
  const invalidTensor={...sample(4,0),temporal_sequence:Array.from({length:24},()=>Array(7).fill(0))};
  const profile=buildTemporalNeuralProfile([valid,wrongHorizon,wrongTarget,invalidSource,invalidTensor]);
  assert.equal(profile.resolved_samples,1);
  assert.equal(profile.probability_ready,false);
});
