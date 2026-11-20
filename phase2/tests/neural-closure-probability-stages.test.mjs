import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  COGNITIVE_FEATURE_NAMES,COGNITIVE_FEATURE_SCHEMA,
  predictFourHourCognitiveChallengerProbabilityStages,
  predictFourHourCognitiveResearchProbabilityStages
} from '../core/cognitive-brain.mjs';

function simpleLogisticFit(calibrator=null){
  return {
    kind:'TRAIN_ONLY_LINEAR_COGNITIVE_TEST_FIT',
    feature_schema:COGNITIVE_FEATURE_SCHEMA,
    feature_names:[...COGNITIVE_FEATURE_NAMES],
    weights:Array(COGNITIVE_FEATURE_NAMES.length).fill(0),
    intercept:0,
    probability_calibrator:calibrator
  };
}

test('Cognitive inference exports raw and Platt-calibrated stages separately',()=>{
  const fit=simpleLogisticFit({
    accepted:true,method:'PLATT_SCALING',slope:1,intercept:0.2,
    fit_on:'LATE_CHRONOLOGICAL_CALIBRATION_FIT_BLOCK',
    fit_samples:120,fit_positive:50,fit_negative:70
  });
  const stages=predictFourHourCognitiveChallengerProbabilityStages({},fit);
  assert.ok(stages);
  assert.equal(stages.raw_probability,0.5);
  assert.ok(Math.abs(stages.calibrated_probability-0.549833997312478)<1e-12);
  assert.equal(stages.probability,stages.calibrated_probability);
  assert.equal(stages.calibration_metadata.applied_to_final_model,true);
  assert.equal(stages.calibration_metadata.training_partition_only,true);
  assert.equal(stages.calibration_metadata.outer_validation_used_for_calibrator_fit,false);
  assert.equal(stages.calibration_metadata.outer_validation_used_for_calibrator_selection,false);
  assert.equal(stages.calibration_metadata.holdout_used_for_calibration,false);
});

test('Cognitive inference keeps raw and calibrated outputs identical when no accepted calibrator exists',()=>{
  const fit=simpleLogisticFit({
    accepted:false,method:'PLATT_SCALING',slope:1.5,intercept:2,
    fit_on:'LATE_CHRONOLOGICAL_CALIBRATION_FIT_BLOCK'
  });
  const stages=predictFourHourCognitiveChallengerProbabilityStages({},fit);
  assert.ok(stages);
  assert.equal(stages.raw_probability,0.5);
  assert.equal(stages.calibrated_probability,0.5);
  assert.equal(stages.calibration_metadata.applied_to_final_model,false);
  assert.equal(stages.calibration_metadata.selected_method,'NO_CALIBRATION');
});

test('selected Cognitive research inference reports both probability stages',()=>{
  const fit=simpleLogisticFit({
    accepted:true,method:'PLATT_SCALING',slope:1,intercept:0.2,
    fit_on:'INNER_TRAINING_CALIBRATION_BLOCK',
    fit_samples:100,fit_positive:40,fit_negative:60
  });
  const profile={fit,research_inference:{mode:'INNER_SELECTED_MEMBER'}};
  const stages=predictFourHourCognitiveResearchProbabilityStages({},profile);
  assert.ok(stages);
  assert.equal(stages.raw_probability,0.5);
  assert.ok(stages.calibrated_probability>stages.raw_probability);
});

test('trainer and temporal TCN predictors preserve raw/calibrated probability stages',async()=>{
  const trainer=await readFile(new URL('../tools/train-neural-closure-models.mjs',import.meta.url),'utf8');
  const temporal=await readFile(new URL('../core/temporal-neural-brain.mjs',import.meta.url),'utf8');
  assert.match(trainer,/const rawProbability=staged\?\.raw_probability\?\?staged\?\.probability\?\?prediction/);
  assert.match(trainer,/const calibratedProbability=staged\?\.calibrated_probability\?\?rawProbability/);
  assert.match(trainer,/predictFourHourCognitiveResearchProbabilityStages/);
  assert.match(trainer,/predictFourHourCognitiveChallengerProbabilityStages/);
  assert.match(temporal,/raw_probability:rawProbability,\s*calibrated_probability:probability/);
  assert.match(temporal,/raw_probability:raw,calibrated_probability:probability/);
  assert.match(trainer,/return output\?\?null;/);
});
