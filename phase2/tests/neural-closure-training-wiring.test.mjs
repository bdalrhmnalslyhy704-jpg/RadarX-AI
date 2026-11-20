import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const trainerUrl=new URL('../tools/train-neural-closure-models.mjs',import.meta.url);
const temporalTestUrl=new URL('./temporal-neural-brain.test.mjs',import.meta.url);
const lstmModuleUrl=new URL('../core/temporal-lstm-hybrid.mjs',import.meta.url);
const lstmTestUrl=new URL('./temporal-lstm-hybrid.test.mjs',import.meta.url);

test('fixed-cohort replay workflow downloads the exact validated dataset and verifies immutable identity',async()=>{
  const workflow=await readFile(new URL('../../.github/workflows/neural-closure-fixed-cohort-replay.yml',import.meta.url),'utf8');
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/run-id: '44196188685'/);
  assert.match(workflow,/radarx-build224-neural-closure-dataset-039c9074fc21fa0ea303e360a6ea56d3a401a559/);
  assert.match(workflow,/path: artifacts\/neural-closure/);
  assert.match(workflow,/--input artifacts\/neural-closure\/dataset\.json/);
  assert.match(workflow,/--roundTripCostBps 30/);
  assert.match(workflow,/--minimumWinRatePct 55/);
  assert.match(workflow,/--maximumDrawdownPct 8/);
  assert.match(workflow,/f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77/);
  assert.match(workflow,/EXPECTED_ROW_COUNT: '32300'/);
  assert.match(workflow,/FIXED_COHORT_SHA_MISMATCH/);
  assert.match(workflow,/MODEL_SOURCE_SHA_MISMATCH/);
  assert.match(workflow,/cancel-in-progress: false/,
    'a newer candidate replay must queue instead of cancelling the active fixed-cohort benchmark');
  assert.ok(workflow.includes('github.sha'),
    'each immutable candidate commit must have its own fixed-cohort replay slot');
});

test('fixed-SHA collector and trainer accept expanded current top-100 candidate prefilters without relaxing historical gates',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const collector=await readFile(new URL('../tools/build-neural-closure-dataset.mjs',import.meta.url),'utf8');
  const policy=await readFile(new URL('../core/neural-closure-data-builder.mjs',import.meta.url),'utf8');
  const workflow=await readFile(new URL('../../.github/workflows/neural-closure-data-collection.yml',import.meta.url),'utf8');
  assert.match(collector,/maxSymbols:100,minSymbols:40/);
  assert.match(collector,/result\.maxSymbols>100/);
  assert.match(collector,/VALIDATED_SYMBOL_COUNT_BELOW_MINIMUM/);
  assert.match(collector,/REJECTED_INCOMPLETE_RAW_ARCHIVE/);
  assert.match(collector,/REJECTED_LOW_VALID_EVENT_COVERAGE/);
  assert.match(collector,/rejection_reasons:symbolRejectedReasons/);
  assert.match(collector,/CURRENT_TOP_100_CANDIDATE_PREFILTER_WITH_POINT_IN_TIME_HISTORICAL_24H_EVENT_GATE_V1/);
  assert.match(policy,/CURRENT_BINANCE_SPOT_24H_TICKER_TOP_100_AT_COLLECTION_TIME/);
  assert.match(trainer,/expectedUniverseSelection/);
  assert.match(trainer,/maximumCandidateSymbols>=10&&maximumCandidateSymbols<=100/);
  assert.match(trainer,/candidate_prefilter\?\.maximum_symbols\)===maximumCandidateSymbols/);
  assert.match(trainer,/historicalMinimum<750_000/);
  assert.ok(workflow.includes("MAX_SYMBOLS: ${{ inputs.max_symbols || '100' }}"),
    'push-triggered collection must use the documented top-100 default when no manual input is supplied');
  assert.ok(workflow.includes("default: '100'"),
    'manual workflow dispatch must retain the documented top-100 default');
  assert.ok(workflow.includes('--maxSymbols "$MAX_SYMBOLS"'),
    'the selected workflow universe must be passed to the collector');
});

test('fixed-SHA trainer refuses rows without exact point-in-time 96-bar liquidity evidence',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/POINT_IN_TIME_HISTORICAL_LIQUIDITY_POLICY_REQUIRED/);
  assert.match(trainer,/SUM_OF_96_CLOSED_15M_KLINE_QUOTE_VOLUME_AT_EACH_DECISION_CLOSE/);
  assert.match(trainer,/POINT_IN_TIME_HISTORICAL_LIQUIDITY_ROW_EVIDENCE_INVALID/);
  assert.match(trainer,/evidence\.no_future_candles_used===true/);
  assert.match(trainer,/evidence\.window_end_close_at\)===Number\(row\.at\)/);
  assert.match(trainer,/evidence\.window_evidence_sha256/);
  assert.match(trainer,/historical_delisted_asset_coverage!==false/);
});

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
  assert.match(trainer,/isUsableTemporalAttentionResearchInferenceState\(state\)/);
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
  assert.match(trainer,/const executionEvidenceById=new Map\(split\.train\.map/);
  assert.match(trainer,/const selectionRowsWithExecutionEvidence=selectionRows\.map/);
  assert.match(trainer,/first_touch:row\.first_touch/);
  assert.match(trainer,/execution_return_contract:row\.execution_return_contract/);
  assert.match(trainer,/max_adverse_excursion_pct:row\.max_adverse_excursion_pct/);
  assert.match(trainer,/max_favorable_excursion_pct:row\.max_favorable_excursion_pct/);
  assert.match(trainer,/selectTcnLstmHybridHyperparameters\(\s*trainingRowsWithExecutionEvidence,selectionRowsWithExecutionEvidence/);
  assert.match(trainer,/resolved_at:row\.resolved_at/);
  assert.match(trainer,/const lstmHorizonMs=NEURAL_CLOSURE_HORIZON_MS/);
  assert.match(trainer,/splitFourHourTcnLstmTrainingRows\(/);
  assert.match(trainer,/validationRowsForLstm=split\.validation\.map/);
  assert.match(trainer,/internalSplit\.status==='READY'/);
  assert.match(trainer,/selectTcnLstmHybridHyperparameters\(\s*trainingRowsWithExecutionEvidence,selectionRowsWithExecutionEvidence/);
  assert.match(trainer,/fitTcnLstmHybridCalibration\(\s*calibrationRows/);
  assert.match(trainer,/predictTcnLstmHybridCalibratedProbability/);
  const lstmModule=await readFile(lstmModuleUrl,'utf8');
  assert.match(lstmModule,/export function summarizeTcnLstmSelectionReturns/);
  assert.match(lstmModule,/return_selection_diagnostics:returnDiagnostics/);
  assert.match(lstmModule,/cross_sectional_rank_diagnostics:crossSectionalRankDiagnostics/);
  assert.match(lstmModule,/topKProbabilitySignals\(rows,baselineProbabilities,topK\)/);
  assert.match(lstmModule,/simulateFirstTouchPaperPortfolio\(\s*rows,modelMask\.probabilities/);
  assert.match(lstmModule,/model_minus_logistic/);
  assert.match(lstmModule,/baselineProbabilities:baselinePredictions/);
  assert.match(trainer,/roundTripCostBps:args\.roundTripCostBps/);
  assert.match(trainer,/minimumReturnTrades:20/);
  assert.match(trainer,/minimumReturnWinRatePct:55/);
  assert.match(lstmModule,/const \{realized_return_pct,\.\.\.fitRow\}=row/,
    'realized outcomes must be stripped before the Logistic anchor and neural optimizer fit');
  assert.match(lstmModule,/affects_candidate_ranking:false/);
  assert.match(lstmModule,/affects_acceptance_gates:false/);
  assert.match(lstmModule,/export function splitFourHourTcnLstmTrainingRows/);
  assert.match(lstmModule,/external_validation_labels_read:false/);
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

test('fixed-SHA trainer exports failed-inner TCN-LSTM candidates only as diagnostic outer predictions',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const recurrent=await readFile(lstmModuleUrl,'utf8');
  assert.match(recurrent,/diagnostic_fit: passed \? null : winner\.fit/);
  assert.match(trainer,/selection\.selected_fit\?\?selection\.diagnostic_fit\?\?null/);
  assert.match(trainer,/if\(selectedFit!==null&&calibrator\.fitted===true\)/);
  assert.match(trainer,/passed:innerQualified/);
  assert.match(trainer,/inner_selection_qualified:innerQualified/);
  assert.match(trainer,/diagnostic_only:!innerQualified/);
  assert.match(trainer,/INNER_BEST_DIAGNOSTIC_ONLY/);
  assert.match(trainer,/requiredImprovement:0\.00025/);
  assert.doesNotMatch(trainer,/qualificationByModel\.TCN_LSTM_HYBRID=\{\s*passed:true/,
    'trainer must never force-pass a diagnostic-only LSTM');
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

test('regime-local TCN families use a smaller inner discovery margin but retain the strict 0.003 outer promotion gate',async()=>{
  const neural=await readFile(new URL('../core/temporal-neural-brain.mjs',import.meta.url),'utf8');
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(neural,/TEMPORAL_TCN_INNER_SELECTION_BRIER_MARGIN = 0\.00025/);
  assert.equal((neural.match(/innerSelectionMargin:requiredInnerSelectionMargin/g)||[]).length,5,
    'base regime-local TCN, V9, V10, V11 and pooled fallback must share the same explicit discovery margin');
  assert.match(neural,/const qualified=candidates\.filter\([\s\S]*?requiredInnerSelectionMargin\)/);
  assert.match(neural,/const validationPassed=Boolean\([\s\S]*?outerPromotionMargin\)/);
  assert.match(neural,/const holdoutPassed=Boolean\([\s\S]*?outerPromotionMargin\)/);
  assert.match(neural,/required_inner_selection_brier_margin:requiredInnerSelectionMargin/);
  assert.match(neural,/required_outer_validation_brier_margin:outerPromotionMargin/);
  assert.match(neural,/holdout_comparison:\{\s*required_brier_margin:outerPromotionMargin/);
  assert.match(trainer,/inner_selection_required_brier_margin:temporalProfile\?\.inner_selection_required_brier_margin\?\?null/);
  assert.match(trainer,/outer_validation_required_brier_margin:temporalProfile\?\.outer_validation_required_brier_margin\?\?null/);
  assert.match(trainer,/required_inner_selection_brier_margin:specialist\.required_inner_selection_brier_margin\?\?null/);
  assert.match(trainer,/required_outer_validation_brier_margin:specialist\.required_outer_validation_brier_margin\?\?null/);
  assert.match(neural,/holdout_comparison:\{\s*required_brier_margin:outerPromotionMargin/);
  // Candidate discovery only nominates. The independent benchmark still uses
  // the predeclared promotion margin and all risk gates; no holdout is unlocked
  // by this smaller inner selection threshold.
  const contract=await readFile(new URL('../core/neural-closure-contracts.mjs',import.meta.url),'utf8');
  assert.match(contract,/requiredBrierImprovement=NEURAL_CLOSURE_BRIER_MARGIN/);
  assert.match(contract,/minimumTrades=20/);
  assert.match(contract,/minimumWinRatePct=55/);
  assert.match(contract,/maximumDrawdownPct=8/);
  assert.match(contract,/roundTripCostBps=30/);
});

test('V9-V11 artifacts include a strictly qualified all-regime fallback for missing BTC specialists',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const neural=await readFile(new URL('../core/temporal-neural-brain.mjs',import.meta.url),'utf8');
  assert.match(neural,/const pooledAcrossRegimes=regime==='ALL_REGIMES'/);
  assert.match(neural,/filter\(row=>pooledAcrossRegimes\|\|regimeOfSequence/);
  assert.match(neural,/pooled_fallback:pooledTcnPyramidFallback/);
  assert.match(neural,/pooled_fallback:pooledTcnMultiscaleFallback/);
  assert.match(neural,/pooled_fallback:pooledTcnAttentionFallback/);
  assert.match(neural,/profile\?\.pooled_fallback\?\.research_inference/);
  assert.match(trainer,/const pooledFallbackQualified=pooledFallback\.selection_passed===true&&/);
  assert.match(trainer,/pooledFallback\.validation_passed===true&&pooledFallback\.holdout_passed===true/);
  assert.match(trainer,/const attentionPooledQualified=attentionPooledFallback\.selection_passed===true&&/);
  assert.match(trainer,/pooled_fallback:pooledStateUsable\?\{research_inference:pooledState\}:null/);
  assert.match(trainer,/pooled_fallback:attentionPooledStateUsable\?\{research_inference:attentionPooledState\}:null/);
  assert.match(trainer,/auditTemporalAttentionResearchInferenceCoverage\(/);
  assert.match(trainer,/auditTemporalVariantResearchInferenceCoverage\(/);
  assert.match(trainer,/isUsableTemporalAttentionResearchInferenceState\(state\)/);
  assert.match(trainer,/isUsableTemporalVariantResearchInferenceState\(state,\{\s*expectedPoolingMode:expectedPooling\s*\}\)/);
  assert.match(trainer,/const missingRegimes=variantCoverage\.missing_regimes/);
  assert.match(trainer,/if\(\(inferenceRegimes\.length===0&&!pooledStateUsable\)\|\|missingRegimes\.length>0\)/);
  assert.match(neural,/isUsableTemporalAttentionResearchInferenceState/);
  assert.match(neural,/isUsableTemporalVariantResearchInferenceState/);
  assert.match(trainer,/qualificationPassed=bothRegimesSelected\|\|pooledFallbackQualified/);
  assert.match(trainer,/POOLED_ALL_REGIMES_FALLBACK_PASSED_VALIDATION_AND_HOLDOUT/);
  assert.match(trainer,/diagnostic_only:!qualificationPassed/);
});

test('TCN V8 failure paths and V11 output keys remain isolated',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  assert.match(trainer,/auditTemporalResearchInferenceCoverage\(/);
  assert.match(trainer,/v8Coverage\.complete/);
  assert.match(trainer,/TCN_V8_MISSING_REGIME_INFERENCE_STATE/);
  assert.match(trainer,/inference_coverage_complete:v8Coverage\.complete/);
  assert.match(trainer,/modelName:'TCN_V8'/);
  assert.match(trainer,/unavailable\.TCN_V8=/);
  assert.match(trainer,/regime_specialists:Object\.fromEntries\(Object\.entries\(\s*temporalProfile\?\.regime_specialists\?\?/,
    'V8 report diagnostics must source selection scores from the public temporal profile, not persisted inference state');
  assert.match(trainer,/selection_scores:specialist\.member_selection_scores\?\?\[\]/);
  assert.match(trainer,/selection_logistic_brier:specialist\.member_selection_logistic_brier\?\?null/);
  assert.match(trainer,/shared_selection_logistic_brier:temporalProfile\?\.shared_model_selection_logistic_brier\?\?null/);
  assert.match(trainer,/shared_selection_passed:temporalProfile\?\.shared_model_selection_passed===true/);
  assert.match(trainer,/selection_qualified_candidate_count:specialist\.member_selection_qualified_candidates\?\?0/);
  assert.match(trainer,/selection_samples:specialist\.local_selection_samples\?\?0/);
  assert.match(trainer,/shared_member_selection_samples:specialist\.shared_member_selection_samples\?\?specialist\.member_selection_samples\?\?0/);
  assert.match(trainer,/calibration_samples:specialist\.local_calibration_samples\?\?0/);
  assert.match(trainer,/shared_calibration_samples:specialist\.shared_calibration_samples\?\?specialist\.calibration_samples\?\?0/);
  assert.doesNotMatch(trainer,/regime_specialists:Object\.fromEntries\(Object\.entries\(\s*temporalProfile\?\._research_fit\?\.specialists_by_regime/,
    'persisted inference state must not be treated as the candidate-score audit record');
  assert.match(trainer,/modelName:'TCN_V11'/);
  assert.match(trainer,/unavailable\.TCN_V11=/);
  assert.doesNotMatch(trainer,/unavailable\.TCN_V11=\{\s*reason:scored\.reason,\s*diagnostic_regimes:training\.model_internal_diagnostics\.TCN_V8/);
});


test('fixed-SHA summary exposes disjoint threshold-selection and outer-validation risk evidence',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const temporal=await readFile(lstmModuleUrl,'utf8');
  assert.match(trainer,/validation:model\.validation\?\{/,
    'the report must retain the complete validation evidence object');
  assert.match(trainer,/probability_stage_diagnostics:\s*model\.validation\?\.probability_stage_diagnostics\?\?null/,
    'the console and model-comparison summary must expose the full staged calibration diagnostics');
  assert.match(trainer,/maxTrainingSamples:4096/,
    'the TCN-LSTM research ablation must use the existing supported 4096-row training budget');
  assert.match(trainer,/max_training_samples:4096/,
    'the reported TCN-LSTM training budget must match the actual trainer configuration');
  assert.match(temporal,/RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_LOGISTIC_AND_CLASSIFIER_V3/,
    'the active execution head must include normalized Logistic and neural classifier scores');
  assert.match(temporal,/LOGIT_CONTEXT_AUGMENTED/,
    'the score-conditioned head must be the default execution path');
  assert.match(temporal,/pooled_latent_'\+index/,
    'score conditioning must expose pooled-channel multiplicative interactions');
  assert.match(temporal,/x_logistic_anchor_score/,
    'each pooled channel must be gated by the Logistic score');
  assert.match(temporal,/x_neural_classifier_score/,
    'each pooled channel must be gated by the neural classifier score');
  assert.match(temporal,/POOLED_ONLY/,
    'the pooled-only head must be retained as a matched ablation control');
  assert.match(temporal,/execution_head_context_ablation\?\.passed===true/,
    'inner qualification must require a matched execution-head ablation pass');
  assert.match(temporal,/splitTcnLstmTrainingRowsForExecutionHead/,
    'the execution regression heads must use a purged later training-only block');
  assert.match(temporal,/TCN_LSTM_EXECUTION_HEAD_TRAINING_PURGE_VIOLATION/,
    'encoder and execution-head training rows must satisfy a strict forward-label purge');
  assert.match(temporal,/fitTcnLstmExecutionRegressionHeads\(executionRows,executionRows,model,anchor/,
    'execution-head latent features must be produced by a model that did not fit those rows');
  assert.match(temporal,/representation_out_of_sample:true/,
    'the fitted execution head must attest to out-of-sample representations');
  assert.match(trainer,/RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_LOGISTIC_AND_CLASSIFIER_V3/,
    'the report must publish the exact active V3 score-gated execution-head schema');
  assert.match(temporal,/RECENCY_WEIGHTED_COMPLETE_15M_DECISION_BUCKETS_V1/,
    'the recurrent fit budget must cover full inner-training chronology in complete decision buckets');
  assert.match(trainer,/training_sample_selection:selection\.training_sample_selection\?\?null/,
    'the public benchmark must expose recurrent training-sample selection provenance');
  assert.match(trainer,/threshold_selection_sample_count:model\.validation\.threshold_selection_sample_count\?\?0/);
  assert.match(trainer,/threshold_selection_probability_distribution:\s*model\.validation\.threshold_selection_probability_distribution\?\?null/);
  assert.match(trainer,/outer_validation_probability_distribution:\s*model\.validation\.outer_validation_probability_distribution\?\?null/);
  assert.match(trainer,/chronological_stability_diagnostics:\s*model\.validation\.chronological_stability_diagnostics\?\?null/,
    'the benchmark report must retain chronological stability diagnostics');
  assert.match(trainer,/expanded_threshold_window_counterfactual:\s*model\.validation\.expanded_threshold_window_counterfactual\?\?null/,
    'the report must preserve the independent expanded-window counterfactual');
  assert.match(trainer,/threshold_selection:model\.validation\.threshold_selection\?\?null/);
  assert.match(trainer,/selected_threshold:model\.validation\.selected_threshold\?\?null/);
  assert.match(trainer,/threshold_selection_gates:model\.validation\.threshold_selection_gates\?\?null/);
  assert.match(trainer,/threshold_trials:model\.validation\.threshold_trials\?\?\[\]/);
  assert.match(trainer,/validation_threshold_metrics:model\.validation\.validation_threshold_metrics\?\?null/);
  assert.match(trainer,/validation_threshold_risk_gates:model\.validation\.validation_threshold_risk_gates\?\?null/);
  assert.match(trainer,/outer_validation_gate:model\.validation\.outer_validation_gate\?\?null/,
    'the exact reason for a holdout lock must be visible in the artifact summary');
  assert.match(trainer,/holdout_lock_reason:model\.holdout\?\.reason\?\?null/);
  assert.match(trainer,/regime_specialists:Object\.fromEntries\(Object\.entries\(specialists\)/,
    'each V9/V10 BTC regime must expose its selection and Logistic comparison scores');
  assert.match(trainer,/candidate_residual_scores:specialist\.member_selection_scores\?\?\[\]/,
    'the residual-scale search must be auditable per BTC regime');
  assert.match(trainer,/regime_specialists:Object\.fromEntries\(Object\.entries\(attentionSpecialists\)/,
    'TCN V11 must expose the same per-regime selection diagnostics');
  assert.match(trainer,/inner_diagnostics:training\.model_internal_diagnostics\?\?\{\}/,
    'workflow logs must expose the detailed internal diagnostics needed to audit failed candidate selection');
  assert.match(trainer,/pooled_fallback_diagnostics:\{/,
    'pooled TCN fallback scores must remain visible even when no inference state was selected');
  assert.match(trainer,/candidate_residual_scores:pooledFallback\.member_selection_scores\?\?\[\]/);
  assert.match(trainer,/candidate_residual_scores:attentionPooledFallback\.member_selection_scores\?\?\[\]/);
});


test('fixed-SHA temporal challengers use extended train-only epoch budgets without relaxing validation gates',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const workflow=await readFile(new URL('../../.github/workflows/neural-closure-rebenchmark.yml',import.meta.url),'utf8');
  const temporal=await readFile(new URL('../core/temporal-neural-brain.mjs',import.meta.url),'utf8');
  const recurrent=await readFile(lstmModuleUrl,'utf8');
  const closure=await readFile(new URL('../core/neural-closure-contracts.mjs',import.meta.url),'utf8');

  // Three TCN seeds now request 18/24/36 epochs (75% / 100% / 150%
  // profiles from the 24-epoch base) inside the immutable outer training
  // block. Train-only checkpointing is unchanged; selection remains separate.
  assert.match(trainer,/regimeLocalTcnPyramidEpochs:Math\.max\(12,Math\.min\(24,args\.epochs\)\)/);
  assert.match(trainer,/regimeLocalTcnMultiscaleEpochs:Math\.max\(12,Math\.min\(24,args\.epochs\)\)/);
  assert.match(trainer,/regimeLocalTcnAttentionEpochs:Math\.max\(12,Math\.min\(24,args\.epochs\)\)/);
  assert.match(workflow,/--epochs 24/);
  assert.match(workflow,/timeout-minutes: 90/);
  assert.match(trainer,/args\.epochs>24/);
  assert.match(trainer,/TEMPORAL_EPOCHS_MUST_BE_1_TO_24/);
  assert.match(trainer,/epochs:16,learningRate:0\.0015,l2:0\.001,[\s\S]*?objectiveMode:'BINARY_CROSS_ENTROPY',[\s\S]*?targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION/);
  assert.match(temporal,/monitor:'TRAINING_BLOCK_OBJECTIVE_ONLY'/);
  assert.match(temporal,/validation_or_holdout_used:false/);
  assert.match(temporal,/const effectiveEpochs=Math\.max\(1,Math\.min\(180/);
  assert.match(temporal,/epochs:Math\.max\(1,Math\.min\(24,Math\.trunc\(Number\(epochs\)\|\|6\)\)\)/,
    'the regime-local trainer must not clip the new 24-epoch base schedule back to eight');
  assert.match(temporal,/Math\.ceil\(baseEpochs\*1\.5\)/,
    'the third ensemble member must retain the 1.5x epoch profile');

  // The bounded eight-candidate recurrent grid keeps the plain Brier anchor
  // and seven Brier + shared-classifier ranking weights. Focal is excluded
  // because the prior replay showed a Brier/ranking tradeoff.
  assert.match(trainer,/4H_BRIER_BASE_LR0015_L2_0005_E12[\s\S]*?epochs:12/);
  assert.match(trainer,/objective:'BRIER'/);
  for(const name of [
    '4H_BRIER_SHARED_RANK_W005_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W010_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W020_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W040_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W060_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W080_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W120_LR0015_E16'
  ]) assert.ok(trainer.includes(name),'missing Brier + shared-ranking challenger '+name);
  assert.match(recurrent,/config\.epochs\s*>\s*30/);
  assert.match(recurrent,/deriveTrainingClassWeights\(rows\.map\(row=>row\.target\)\)/);
  assert.match(recurrent,/FOCAL_ASYMMETRIC_BRIER/);
  assert.match(recurrent,/loss_objective:objective/);
  assert.match(trainer,/requiredImprovement:0\.00025/);
  assert.match(temporal,/export const TEMPORAL_BRIER_SUPERIORITY_MARGIN = 0\.003/);
  assert.match(closure,/export const NEURAL_CLOSURE_BRIER_MARGIN = 0\.003/);
  assert.match(trainer,/validation_or_holdout_rows_seen_by_fit:0/);
});


test('TCN-LSTM Brier plus shared-classifier ranking sweep stays within the selector cap',async()=>{
  const trainer=await readFile(trainerUrl,'utf8');
  const recurrent=await readFile(lstmModuleUrl,'utf8');
  const candidateBlock=trainer.match(/candidates:\[([\s\S]*?)\n\s+\]\n\s+\}\);/);
  assert.ok(candidateBlock,'TCN-LSTM candidate grid must be discoverable');
  const candidateNames=[...candidateBlock[1].matchAll(/name:'([^']+)'/g)]
    .map(match=>match[1]);
  assert.equal(candidateNames.length,8,'grid must stay within the selector hard cap');
  assert.ok(candidateNames.includes('4H_BRIER_BASE_LR0015_L2_0005_E12'));
  for(const name of [
    '4H_BRIER_SHARED_RANK_W005_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W010_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W020_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W040_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W060_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W080_LR0015_E16',
    '4H_BRIER_SHARED_RANK_W120_LR0015_E16'
  ]) assert.ok(candidateNames.includes(name),'missing Brier + shared-ranking candidate '+name);
  for(const weight of ['0.005','0.01','0.02','0.04','0.06','0.08','0.12']){
    assert.ok(trainer.includes('rankingWeight:'+weight),'missing combined ranking weight '+weight);
  }
  assert.equal((candidateBlock[1].match(/objective:'BRIER',rankingWeight:/g)||[]).length,7,
    'all seven ranking candidates must retain the proper-scoring Brier objective');
  assert.match(trainer,/rankingPairsPerTimestamp:12/,
    'ranking supervision must use a broader bounded set of same-time return pairs');
  assert.match(trainer,/requiredImprovement:0\.00025/);
  assert.match(trainer,/minimumReturnWinRatePct:55/);
  assert.match(trainer,/rankingMinimumReturnGapPct:0\.50/);
  assert.match(recurrent,/forward\.logit\+blendWeight\*forward\.ranking_residual_logit/);
  assert.doesNotMatch(recurrent,/forward\.logit\+blendWeight\*forward\.ranking_logit/);
  assert.match(recurrent,/CLASSIFIER_LOGIT_PLUS_RANKING_RESIDUAL_LOGIT_V1/);
  assert.match(recurrent,/projectTcnLstmAuxiliaryGradient/);
  assert.match(recurrent,/PCGRAD_PROJECT_AUXILIARY_RANKING_GRADIENT/);
});

test('matched Logistic threshold is frozen on selection and risk comparison is symmetric',async()=>{
  const closure=await readFile(new URL('../core/neural-closure-contracts.mjs',import.meta.url),'utf8');
  const recurrent=await readFile(lstmModuleUrl,'utf8');
  assert.match(closure,/referenceOnly:modelName==='LOGISTIC_REGRESSION'/);
  assert.match(closure,/status:'SELECTED_ON_VALIDATION_REFERENCE_ONLY'/);
  assert.match(closure,/selection_role:'LOGISTIC_BASELINE_REFERENCE_ONLY'/);
  assert.match(closure,/logisticThresholdSelectionReady=\[\s*'SELECTED_ON_VALIDATION_REFERENCE_ONLY','SELECTED_ON_VALIDATION_ONLY'/);
  assert.doesNotMatch(closure,/matchedExecutionThresholdReady=[\s\S]*?Object\.values\(logisticReferenceRiskGates\)\.every/);
  assert.match(closure,/strictly_beats_logistic_net_pnl/);
  assert.match(closure,/drawdown_no_worse_than_logistic/);
  assert.match(recurrent,/beats_logistic_anchor:complete&&[\s\S]*modelMetrics\.net_pnl_pct>anchorMetrics\.net_pnl_pct&&[\s\S]*modelMetrics\.max_drawdown_pct<=anchorMetrics\.max_drawdown_pct/);
  assert.doesNotMatch(recurrent,/modelMetrics\.win_rate_pct>anchorMetrics\.win_rate_pct/);
});
