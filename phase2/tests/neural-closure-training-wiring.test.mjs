import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const trainerUrl=new URL('../tools/train-neural-closure-models.mjs',import.meta.url);
const temporalTestUrl=new URL('./temporal-neural-brain.test.mjs',import.meta.url);
const lstmModuleUrl=new URL('../core/temporal-lstm-hybrid.mjs',import.meta.url);
const lstmTestUrl=new URL('./temporal-lstm-hybrid.test.mjs',import.meta.url);

test('fixed-SHA trainer opts into the separate regime-local TCN V11 attention challenger',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/predictTemporalAttentionResearchOutput/,
    'the trainer must use the dedicated V11 attention predictor');
  assert.match(trainer,/enableRegimeLocalTcnAttention:true/,
    'the four-hour fixed-SHA workflow must actually train attention specialists');
  assert.match(trainer,/regimeLocalTcnAttentionMaxTrainingSamples:2048/,
    'the V11 training budget must remain explicit and bounded alongside V9/V10');
  assert.match(trainer,/TEMPORAL_ATTENTION_MODEL_ARCHITECTURE/,
    'the saved model identity must use the V11 attention architecture');
});

test('TCN V11 artifact is reloadable and its predictor consumes the persisted model state shape',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/schema:'RADARX_BUILD224_TCN_V11_ATTENTION_ARTIFACT_V1'/);
  assert.match(trainer,/regime,\{research_inference:attentionSpecialists\[regime\]\.research_inference\}/,
    'each serialized BTC regime must wrap research_inference exactly as the predictor expects');
  assert.match(trainer,/row\.temporal_sequence,v11State,\{allowDiagnostic:true\}/,
    'external scoring must exercise the same serialized state that is saved as the artifact');
  assert.match(trainer,/modelName:'TCN_V11'/);
  assert.match(trainer,/modelArtifactsByModel\.TCN_V11=attentionArtifact/);
  const temporalTests=await readFile(temporalTestUrl,'utf8');
  assert.match(temporalTests,/persistedArtifactProfile/,
    'the neural test suite must include a JSON serialization/reload round-trip');
  assert.match(temporalTests,/artifact reload must preserve the exact attention probability/);
});

test('TCN V11 inner qualification requires BOTH BTC risk regimes to pass inner validation and holdout',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/const expectedBtcRegimes=\['BTC_RISK_ON','BTC_RISK_OFF'\]/);
  assert.match(trainer,/expectedBtcRegimes\.every\(regime=>\{/);
  assert.match(trainer,/specialist\.validation_passed===true&&specialist\.holdout_passed===true/);
  assert.match(trainer,/state\?\.inference_mode==='INNER_SELECTED_TCN_ATTENTION_MEMBER'/);
  assert.match(trainer,/passed:attentionInnerQualified/);
  assert.match(trainer,/diagnostic_only:!attentionInnerQualified/);
});

test('fixed-SHA trainer exports V9 ordered-pyramid and V10 multiscale as separate benchmark families',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/enableRegimeLocalTcnPyramid:true/);
  assert.match(trainer,/enableRegimeLocalTcnMultiscale:true/);
  assert.match(trainer,/predictTemporalVariantResearchOutput/);
  assert.match(trainer,/family:'TCN_V9'/);
  assert.match(trainer,/family:'TCN_V10'/);
  assert.match(trainer,/expectedPooling:TEMPORAL_ORDERED_POOLING_MODE/);
  assert.match(trainer,/expectedPooling:TEMPORAL_MULTISCALE_POOLING_MODE/);
  assert.match(trainer,/modelName:family/);
  assert.match(trainer,/predictionsByModel\[family\]=scored\.rows/);
  assert.match(trainer,/bothRegimesSelected/);
  assert.match(trainer,/INNER_SELECTED_TCN_VARIANT_MEMBER/);
});

test('TCN V9 and V10 families are no longer silently left without fixed-SHA predictions',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const families=await readFile(new URL('../core/neural-closure-contracts.mjs',import.meta.url),'utf8');
  assert.match(families,/'TCN_V9'/);
  assert.match(families,/'TCN_V10'/);
  assert.match(trainer,/exportTemporalPoolingVariant\(\{[\s\S]*?family:'TCN_V9'/);
  assert.match(trainer,/exportTemporalPoolingVariant\(\{[\s\S]*?family:'TCN_V10'/);
});

test('fixed-SHA trainer maps TCN-LSTM to the exact 4h first-touch target on split.train only',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/TCN_LSTM_HYBRID_SCHEMA/);
  assert.match(trainer,/const lstmRows=split\.train\.map/);
  assert.match(trainer,/sequence:row\.temporal_sequence/);
  assert.match(trainer,/target:row\.target/);
  assert.match(trainer,/resolved_at:row\.resolved_at/);
  assert.match(trainer,/const lstmHorizonMs=NEURAL_CLOSURE_HORIZON_MS/);
  assert.match(trainer,/splitFourHourTcnLstmTrainingRows\(/);
  assert.match(trainer,/validationRowsForLstm=split\.validation\.map/);
  assert.match(trainer,/internalSplit\.status==='READY'/);
  assert.match(trainer,/selectTcnLstmHybridHyperparameters\(trainingRows,selectionRows/);
  assert.match(trainer,/fitTcnLstmHybridCalibration\(\s*calibrationRows/);
  assert.match(trainer,/predictTcnLstmHybridCalibratedProbability/);
  const lstmModule=await readFile(lstmModuleUrl,'utf8');
  assert.match(lstmModule,/export function splitFourHourTcnLstmTrainingRows/);
  assert.match(lstmModule,/EXTERNAL_VALIDATION_LABEL_READ/);
  assert.match(lstmModule,/OUTER_TRAINING_LABELS_OVERLAP_EXTERNAL_VALIDATION/);
  const lstmTests=await readFile(lstmTestUrl,'utf8');
  assert.match(lstmTests,/four-hour TCN-LSTM splitter keeps fit, selection and calibration inside outer train/);
  assert.match(lstmTests,/four-hour TCN-LSTM splitter rejects non-four-hour labels/);
  assert.match(trainer,/modelName:'TCN_LSTM_HYBRID'/);
  assert.match(trainer,/modelArtifactsByModel\.TCN_LSTM_HYBRID=artifact/);
  assert.match(trainer,/predictionsByModel\.TCN_LSTM_HYBRID=scored\.rows/);
  assert.doesNotMatch(trainer,/benchmarkTcnLstmHybridChronological/,
    'the legacy 24h-only benchmark must not be used for the 4h first-touch cohort');
});

test('TCN-LSTM qualification is inner-only and leaves outer acceptance to the shared Brier benchmark',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/requiredImprovement:0\.00025/);
  assert.match(trainer,/passed:innerQualified/);
  assert.match(trainer,/diagnostic_only:!innerQualified/);
  assert.match(trainer,/probability_ready:false,live_eligibility_ready:false/);
  assert.match(trainer,/runNeuralClosureBenchmark\(\{[\s\S]*qualificationByModel/);
  const contract=await readFile(new URL('../core/neural-closure-contracts.mjs',import.meta.url),'utf8');
  assert.match(contract,/'TCN_LSTM_HYBRID'/);
});

test('TCN V8 failure paths and V11 output keys remain isolated',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/modelName:'TCN_V8'/);
  assert.match(trainer,/unavailable\.TCN_V8=/);
  assert.match(trainer,/modelName:'TCN_V11'/);
  assert.match(trainer,/unavailable\.TCN_V11=/);
  assert.doesNotMatch(trainer,/unavailable\.TCN_V11=\{\s*reason:scored\.reason,\s*diagnostic_regimes:training\.model_internal_diagnostics\.TCN_V8/);
});
