import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
    first_passage:{hit:signal?'TAKE_PROFIT_REACHED_FIRST':'STOP_LEVEL_REACHED_FIRST',
      outcome:signal?'UP':'DOWN',path_resolution:'15M'},
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
  assert.equal(profile.temporal_label_resolution,'15M_ONLY');
});

test('temporal network trains only on valid tensors and keeps chronological validation and holdout separate',()=>{
  const rows=[];
  for(let group=0;group<32;group++){
    for(let index=0;index<36;index++){
      const row=sample(group,index,{up:index<8});
      // Keep enough distinct rows in each chronological regime block for the
      // independent 30-row probability-calibration gate to be testable.
      // see both UP and DOWN outcomes within its own market regime.
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=group%2===0?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  rows.push({...sample(0,999),id:'BAD-LEGACY',outcome_source:'HISTORICAL_CLOSED_CANDLE'});
  rows.push({...sample(0,998),id:'BAD-SEQUENCE',temporal_sequence:[[1,2]]});
  const profile=buildTemporalNeuralProfile(rows,{epochs:2,minimumHoldoutSamples:80});
  assert.equal(profile.resolved_samples,32*36);
  assert.equal(profile.trained,true,JSON.stringify({
    status:profile.status,
    training_samples:profile.training_samples,
    validation_samples:profile.validation_samples,
    holdout_samples:profile.holdout_samples,
    shared_model_training_cutoff_at:profile.shared_model_training_cutoff_at,
    shared_model_member_selection_cutoff_at:profile.shared_model_member_selection_cutoff_at,
    shared_model_selection_cutoff_at:profile.shared_model_selection_cutoff_at,
    supported_regimes:profile.supported_regimes,
    regime_specialists:profile.regime_specialists
  }));
  assert.equal(profile.architecture,TEMPORAL_MODEL_ARCHITECTURE);
  assert.equal(profile.ensemble_members,3);
  assert.equal(profile.training_strategy,'INDEPENDENT_TEMPORAL_TCN_REGIME_LOCAL_SELECTION_CALIBRATION_V21');
  assert.equal(profile.training_objective,'UNWEIGHTED_BRIER_PROPER_SCORING_RULE');
  assert.equal(profile.model_scope,'INDEPENDENT_TCN_RESIDUAL_WITH_REGIME_LOCAL_LOGISTIC_ANCHORS');
  assert.equal(profile.member_selection_method,'REGIME_LOCAL_CHRONOLOGICAL_MEMBER_AND_RESIDUAL_SCALE_SELECTION_BRIER');
  assert.equal(profile.regime_model_training_samples,profile.training_samples);
  assert.equal(profile.baseline_anchor,'REGIME_SPECIFIC_TRAINING_ONLY_NO_CROSS_REGIME_FALLBACK_V3');
  assert.equal(profile.residual_scale_selection,'REGIME_LOCAL_SELECTION_BLOCK_BRIER_GRID_V4');
  assert.equal(profile.training_objective,'UNWEIGHTED_BRIER_PROPER_SCORING_RULE');
  assert.deepEqual(profile.candidate_residual_scales,[0,0.1,0.25,0.5,1]);
  assert.equal(profile.member_training_profiles.length,3);
  assert.ok(profile.member_training_profiles.every(row=>
    row.trainingObjective==='UNWEIGHTED_BRIER_PROPER_SCORING_RULE'),
    'member objective metadata must match the Brier-only gradient implemented by V6');
  assert.equal(new Set(profile.member_training_profiles.map(row=>JSON.stringify(row))).size,3,
    'ensemble members must use distinct deterministic training schedules');
  assert.equal(profile.sequence_steps,24);
  assert.equal(profile.sequence_channels,29);
  assert.ok(profile.training_samples>=160);
  assert.ok(profile.validation_samples>=50);
  assert.ok(profile.holdout_samples>=40,
    'small research fixtures use the 40-sample research minimum; live readiness still requires 100');
  assert.equal(profile.training_positive_count+profile.training_negative_count,profile.training_samples);
  assert.equal(profile.regime_model_training_samples,profile.training_samples);
  assert.equal(profile.model_split_scope,'INDEPENDENT_BTC_REGIME_PURGED_WALK_FORWARD');
  for(const regime of profile.supported_regimes){
    const specialist=profile.regime_specialists[regime];
    assert.ok(specialist.max_training_outcome_resolved_at<specialist.training_cutoff_at);
    assert.ok(specialist.training_cutoff_at<specialist.member_selection_cutoff_at);
    assert.ok(specialist.member_selection_cutoff_at<specialist.calibration_cutoff_at);
    assert.ok(specialist.calibration_cutoff_at<=specialist.validation_start_at);
  }
  assert.ok(profile.validation.positive_rate_pct>=0&&profile.validation.positive_rate_pct<=100);
  assert.ok(profile.holdout.positive_rate_pct>=0&&profile.holdout.positive_rate_pct<=100);
  assert.ok(profile.max_training_outcome_resolved_at<profile.validation_start_at);
  assert.ok(profile.validation_start_at<profile.holdout_start_at);
  assert.equal(profile.holdout_comparison.sample_count,profile.holdout.sample_count,
    'the model comparison must report the exact number of holdout rows it actually scored');
  assert.ok(profile.holdout_comparison.sample_count>=40,
    'the scored holdout must meet the research minimum');
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
  for(let group=0;group<32;group++){
    for(let index=0;index<36;index++){
      const row=sample(group,index,{up:index<8});
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
  assert.equal(expert.model_scope,'INDEPENDENT_TCN_WITH_REGIME_LOCAL_LOGISTIC_ANCHOR');
  assert.equal(profile.training_strategy,'INDEPENDENT_TEMPORAL_TCN_REGIME_LOCAL_SELECTION_CALIBRATION_V21');
  assert.equal(profile.training_objective,'UNWEIGHTED_BRIER_PROPER_SCORING_RULE');
  assert.equal(profile.model_scope,'INDEPENDENT_TCN_RESIDUAL_WITH_REGIME_LOCAL_LOGISTIC_ANCHORS');
  assert.equal(profile.member_training_profiles_by_regime.BTC_RISK_ON.length,3);
  assert.ok(profile.member_training_profiles_by_regime.BTC_RISK_ON.every(row=>
    row.trainingObjective==='UNWEIGHTED_BRIER_PROPER_SCORING_RULE'));
  assert.equal(expert.baseline_anchor_source,'REGIME_SPECIFIC_TRAINING_ONLY');
  assert.equal(expert.baseline_anchor_training_samples,expert.training_samples);
  assert.ok(expert.training_samples>=80);
  assert.ok(expert.selection_samples>=10);
  assert.ok(expert.validation_samples>=24);
  assert.ok(expert.holdout_samples>=20);
  assert.ok(expert.max_training_outcome_resolved_at<expert.selection_start_at,
    'training labels must resolve before member selection begins');
  assert.equal(expert.probability_calibration.method,'CALIBRATION_BLOCK_SHRUNK_BRIER_PLATT_V2');
  assert.equal(expert.probability_calibration.fit_on,'REGIME_CALIBRATION_BLOCK');
  assert.equal(expert.member_selection_source,'REGIME_MEMBER_SELECTION_BLOCK');
  assert.equal(expert.calibration_source,'REGIME_CALIBRATION_BLOCK');
  assert.equal(expert.neural_residual_contributes,expert.selected_residual_scale>0);
  assert.equal(expert.logistic_probability_calibration.fitted,true);
  assert.equal(expert.logistic_probability_calibration.sample_count,expert.selection_calibration_samples);
  assert.equal(expert.probability_calibration.sample_count,expert.selection_calibration_samples,
    'probability calibration may use only the disjoint later calibration block');
  assert.ok(expert.member_selection_samples>0);
  assert.ok(expert.selection_calibration_samples>0);
  assert.notEqual(expert.member_selection_samples,expert.selection_calibration_samples,
    'member ranking and probability calibration must not reuse the same rows');
  assert.equal(expert.probability_calibration.fit_on,'REGIME_CALIBRATION_BLOCK');
  assert.equal(expert.logistic_probability_calibration.fitted,true);
  assert.equal(expert.logistic_probability_calibration.sample_count,expert.selection_calibration_samples,
    'the logistic challenger must be calibrated on the exact same regime-local later block');
  assert.ok(Number.isFinite(profile.validation.pooled_logistic_brier_score));
  assert.ok(Number.isFinite(profile.holdout.pooled_logistic_brier_score));
  assert.equal(profile.calibration_fit_scope,'REGIME_LOCAL_CALIBRATION_BLOCK_ONLY');
  assert.equal(profile.training_strategy,'INDEPENDENT_TEMPORAL_TCN_REGIME_LOCAL_SELECTION_CALIBRATION_V21');
  assert.equal(profile.training_objective,'UNWEIGHTED_BRIER_PROPER_SCORING_RULE');
  assert.equal(profile.model_scope,'INDEPENDENT_TCN_RESIDUAL_WITH_REGIME_LOCAL_LOGISTIC_ANCHORS');
  assert.ok(expert.selection_start_at<expert.calibration_start_at&&
    expert.calibration_start_at<expert.validation_start_at,
    'member selection, calibration and reported validation must use three disjoint chronological blocks');
  assert.ok(expert.validation_start_at<profile.holdout_start_at,
    'final holdout must remain strictly later than all fitting and selection data');
  assert.equal(profile.regime_specialists.BTC_RISK_OFF.status,'WAITING_FOR_REGIME_SPECIALIST_SAMPLE_COVERAGE');
  assert.ok(profile.regime_specialists.BTC_RISK_OFF.support_gaps.includes('HOLDOUT_SAMPLE_COUNT'));
  assert.ok(profile.holdout_comparison.sample_count>=40);
  assert.equal(profile.holdout_comparison.sample_count,profile.holdout.sample_count,
    'comparison sample count must describe rows actually evaluated');
  for(const regime of profile.supported_regimes){
    const specialist=profile.regime_specialists[regime];
    assert.ok(specialist.logistic_calibration_samples>=0);
    assert.equal(specialist.neural_residual_contributes,
      specialist.selected_residual_scale>0,
      'zero residual scale is not a neural-network contribution');
    if(!specialist.neural_residual_contributes){
      assert.equal(specialist.selected,false);
      assert.equal(specialist.probability_ready,false);
    }
  }
});

test('mature history reserves a broad untouched holdout and a wider regime-supported validation block',()=>{
  const rows=[];
  for(let group=0;group<80;group++){
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
  assert.ok(profile.holdout_samples>=Math.max(300,Math.ceil(rows.length*0.25)),
    'mature history must retain at least twice the live holdout floor and 25% untouched samples');
  assert.ok(profile.regime_model_training_samples>=600,
    'the bounded holdout must leave a larger purged chronological block for temporal fitting');
  assert.deepEqual(profile.shared_model_split_fractions,
    {training:0.70,memberSelection:0.86,calibration:0.995},
    'mature histories must preserve 16% local member selection and reserve 13.5% for calibration without moving outer validation or holdout');
  assert.ok(profile.validation_samples>=300,
    'mature histories must reserve at least 300 observations for inner TCN validation');
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
    const expert=profile.regime_specialists[regime];
    assert.ok(expert.holdout_samples>=20);
    assert.ok([0,0.1,0.25,0.5,1].includes(expert.selected_residual_scale));
    assert.ok(expert.holdout_positive_samples>=5);
    assert.ok(expert.holdout_negative_samples>=20);
    assert.ok(expert.validation_start_at<profile.holdout_start_at);
  }
});

test('sparse BTC regime cannot borrow selection or calibration labels from the opposite regime',()=>{
  const rows=[];
  for(let group=0;group<32;group++){
    let riskOn=true;
    if(group===15||group===16||group===18||group===20||group===23||group===25||group===27||group===31)riskOn=false;
    for(let index=0;index<12;index++){
      let up;
      if(group>=12&&group<=17&&riskOn)up=false;
      else if(group===18)up=index<4;
      else if(group>=28&&group<=30)up=index<5;
      else if(riskOn&&[8,9,10,11,17,19,21,22,23,24,25,26,27].includes(group))up=false; // remove positive labels from the actual local selection window
      else if(group>=17&&group<=27)up=index<2;
      else up=index<2;
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=riskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2});
  const expert=profile.regime_specialists.BTC_RISK_ON;
  assert.ok(expert.training_samples>=80);
  assert.equal(expert.local_selection_samples,60);
  assert.equal(expert.local_selection_positive_samples,0);
  assert.equal(expert.member_selection_source,'REGIME_MEMBER_SELECTION_BLOCK');
  assert.equal(expert.member_selection_samples,expert.local_selection_samples);
  assert.equal(expert.local_calibration_samples,36);
  assert.equal(expert.calibration_source,'REGIME_CALIBRATION_BLOCK');
  assert.equal(expert.calibration_samples,expert.local_calibration_samples);
  assert.ok(expert.support_gaps.includes('REGIME_MEMBER_SELECTION_BLOCK_UNSUPPORTED'));
  assert.ok(expert.support_gaps.includes('REGIME_CALIBRATION_BLOCK_UNSUPPORTED'));
  assert.ok(expert.support_gaps.includes('VALIDATION_POSITIVE_CLASS'),
    'the specialist remains unavailable because its own later validation block lacks positive outcomes');
  assert.equal(expert.selected,false);
  assert.equal(expert.probability_ready,false);
  assert.equal(expert.probability_calibration,null);
  assert.equal(expert.selected,false);
  assert.equal(expert.probability_ready,false,
    'a regime with unsupported validation outcomes must not publish a temporal probability');
  assert.equal(profile.live_eligibility_ready,false);
});

test('TCN fits, selects and calibrates each specialist only on its own BTC regime',()=>{
  const rows=[];
  // 100 chronological groups preserve separate regime-local fitting,
  // member-selection and larger calibration blocks before outer validation
  // and the untouched final holdout.
  for(let group=0;group<100;group++){
    const riskOn=group%2===0;
    for(let index=0;index<7;index++){
      let up;
      if(group>=85)up=index===0;          // untouched holdout: one positive per group
      else if(group>=61)up=index<2;       // outer validation: two positives per group
      else if(group>=48)up=index<2;       // local calibration: >=35 matured rows per regime
      else if(group>=33)up=index%2===0;  // local member-selection block
      else up=index<2;                    // independent training for both regimes
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();
        copy[19]=riskOn?1.35:-1.35;
        return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:2,minimumHoldoutSamples:80});
  assert.equal(profile.trained,true);
  assert.deepEqual(profile.supported_regimes,['BTC_RISK_ON','BTC_RISK_OFF']);
  for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
    const expert=profile.regime_specialists[regime];
    assert.equal(expert.member_selection_source,'REGIME_MEMBER_SELECTION_BLOCK');
    assert.ok(expert.local_calibration_samples>=30,
      'each BTC regime needs at least 30 matured calibration rows of its own');
    assert.equal(expert.calibration_source,'REGIME_CALIBRATION_BLOCK');
    assert.equal(expert.calibration_samples,expert.local_calibration_samples);
    assert.ok(expert.calibration_targets.positive>=5);
    assert.ok(expert.calibration_targets.negative>=20);
    assert.equal(expert.probability_calibration.fit_on,'REGIME_CALIBRATION_BLOCK');
    assert.equal(expert.probability_calibration.fitted,true);
    assert.equal(expert.logistic_probability_calibration.fitted,true);
    assert.ok(expert.max_training_outcome_resolved_at<expert.selection_start_at);
    assert.ok(expert.selection_start_at<expert.calibration_start_at);
    assert.ok(expert.calibration_start_at<expert.validation_start_at);
    assert.ok(expert.validation_start_at<profile.holdout_start_at);
  }
  assert.equal(profile.live_eligibility_ready,false,
    'a research fixture must not satisfy the 150-outcome live holdout requirement');
});

test('thin BTC regime cannot deploy a pooled logistic anchor as a substitute TCN',()=>{
  const rows=[];
  for(let group=0;group<80;group++){
    const riskOn=group%2===0;
    for(let index=0;index<20;index++){
      const up=riskOn?group>=56&&index<6:index%4===0;
      const row=sample(group,index,{up});
      row.temporal_sequence=row.temporal_sequence.map(step=>{
        const copy=step.slice();copy[19]=riskOn?1.35:-1.35;return copy;
      });
      rows.push(row);
    }
  }
  const profile=buildTemporalNeuralProfile(rows,{epochs:1});
  const on=profile.regime_specialists.BTC_RISK_ON;
  const off=profile.regime_specialists.BTC_RISK_OFF;
  assert.equal(on.baseline_anchor_source,'POOLED_TRAINING_ONLY_FALLBACK');
  assert.equal(on.baseline_anchor_local_positive_samples,0);
  assert.ok(on.baseline_anchor_training_samples>on.baseline_anchor_local_training_samples);
  assert.ok(on.support_gaps.includes('REGIME_LOGISTIC_ANCHOR_LOCAL_SUPPORT'));
  assert.equal(on.selected,false);
  assert.equal(on.probability_ready,false);
  assert.equal(off.baseline_anchor_source,'REGIME_SPECIFIC_TRAINING_ONLY');
  assert.equal(profile.live_eligibility_ready,false,
    'pooled diagnostic anchors must never unlock a regime-local TCN');
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


test('TCN regime fitting, member selection and calibration never cross BTC regimes',async()=>{
  const source=await readFile(new URL('../core/temporal-neural-brain.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('const regimeFit=fitEnsemble(regimeTraining,{'));
  assert.ok(source.includes('const memberSelectionRows=regimeMemberSelection;'));
  assert.ok(source.includes('const calibrationRows=regimeCalibration;'));
  assert.ok(!source.includes('const regimeFit=sharedResidualFit'));
  assert.ok(!source.includes('SHARED_TCN_MEMBER_SELECTION_BLOCK'));
  assert.ok(!source.includes('SHARED_REGIME_CALIBRATION_BLOCK'));
});

test('DHDTech production acceptance requires both V5 and TCN scientific live gates',async()=>{
  const workflow=await readFile(new URL('../../.github/workflows/dhdtech-adaptive-trader-acceptance.yml',import.meta.url),'utf8');
  const containerWorkflow=await readFile(new URL('../../.github/workflows/build224-container-runtime-smoke.yml',import.meta.url),'utf8');
  const validStart=workflow.indexOf('const valid=');
  const successBranch=workflow.indexOf('if(valid)',validStart);
  assert.ok(validStart>=0&&successBranch>validStart,'acceptance success gate must remain explicit');
  const validExpression=workflow.slice(validStart,successBranch);
  for(const gate of ['cognitiveSplitReady','neuralNetworkContract','v5NeuralLiveReady','neuralLiveReady','probabilityClaimSafe']){
    assert.ok(validExpression.includes(gate),'DHDTech success must require '+gate);
  }
  for(const gate of [
    'neuralNetwork.selected===true',
    'neuralNetwork.probability_ready===true',
    'neuralNetwork.live_eligibility_ready===true',
    'neuralNetwork.holdout_comparison?.passed===true',
    'temporalNetwork.selected===true',
    'temporalNetwork.probability_ready===true',
    'temporalNetwork.live_eligibility_ready===true',
    'temporalComparison.beats_pooled_logistic===true'
  ]){
    assert.ok(workflow.includes(gate),'DHDTech model acceptance must verify '+gate);
  }
  assert.ok(workflow.includes('phase2/core/cognitive-brain.mjs'));
  assert.ok(workflow.includes('phase2/core/temporal-neural-brain.mjs'));
  assert.ok(workflow.includes('String(deployedBuildIdentity.commit||\'\')===context.sha'));
  assert.ok(workflow.includes('deploymentResponse.ok&&exactBuildCommit&&'));
  assert.ok(containerWorkflow.includes('FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2'));
  assert.ok(containerWorkflow.includes("temporal_label_resolution==='15M_ONLY'"),
    'container smoke must verify the same uniform 15m target contract');
  assert.ok(containerWorkflow.includes("training_strategy==='INDEPENDENT_TEMPORAL_TCN_REGIME_LOCAL_SELECTION_CALIBRATION_V21'"));
  assert.ok(containerWorkflow.includes('neural_residual_contributes===true'));
  assert.ok(workflow.includes('temporalNeuralContributionSafe'));
  assert.ok(workflow.includes('timeout-minutes: 65'));
  assert.ok(workflow.includes('55*60*1000'));
  for(const gate of [
    'fullUniverseCoverageReady',
    'sameEligibleUniverse',
    'sweepBelongsToThisAcceptance',
    'completedSweep.eligible_symbols_snapshot',
    'completedSweep.attempted_symbols',
    'completedSweep.failed_symbols',
    'paperTradingReady',
    'physicalDeviceDeliveryReady',
    'Number(push.fcm_devices)>=2',
    'Number(push.physical_device_receipt_count)>=2',
    'physical_device_receipt_window_ms',
    'push.physical_device_delivery_verified===true'
  ]){
    assert.ok(workflow.includes(gate),'DHDTech production acceptance must require '+gate);
  }
  assert.ok(workflow.includes('lastManualScanRequestedForScanAt'),
    'acceptance must drive bounded market scans to a complete universe sweep without duplicate requests');
});


test('TCN excludes mixed-resolution 5m first-passage labels from the 15m training target',()=>{
  const fiveMinute=sample(0,0,{up:true});
  const fifteenMinute={...sample(1,1,{up:false}),
    first_passage:{hit:'AMBIGUOUS_BOTH_LEVELS_IN_SAME_CANDLE',outcome:'FLAT',path_resolution:'5M'},
    outcome:'FLAT'};
  const profile=buildTemporalNeuralProfile([fiveMinute,fifteenMinute]);
  assert.equal(TEMPORAL_TARGET_DEFINITION,'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2');
  assert.equal(profile.resolved_samples,1,
    'the model must reject any first-passage sample built at a different candle resolution');
  assert.equal(profile.temporal_label_resolution,'15M_ONLY');
  assert.equal(profile.probability_ready,false);
});
