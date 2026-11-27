import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fitHurdleReturnHead,fitHurdlePositiveReturnCalibration,
  fitHurdleConditionalMeanCalibration,predictHurdleExpectedNetReturn
} from '../core/hurdle-return-head.mjs';
import {
  HURDLE_V2_CONTEXT_SCHEMA,HURDLE_V2_OBJECTIVE,
  createHurdleV2Artifact,verifyHurdleV2Artifact,
  runHurdleV2ReloadProbes,writeHurdleV2ArtifactAtomic
} from '../core/hurdle-v2-artifact-contract.mjs';

let fixture;
let directory;
let artifact;
let exported;

function makeRows(width, count) {
  return Array.from({length:count}, (_, row) =>
    Array.from({length:width}, (_, column) =>
      Math.sin((row + 1) * (column + 2) * 0.031) +
      Math.cos((row + 3) * (column + 1) * 0.017) +
      column * 0.002));
}
function allFinite(value) {
  if (Array.isArray(value)) return value.every(allFinite);
  if (value && typeof value === 'object') return Object.values(value).every(allFinite);
  return typeof value !== 'number' || Number.isFinite(value);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function sha256(value) {
  return createHash('sha256').update(Buffer.from(canonical(value), 'utf8')).digest('hex');
}
function resealArtifact(source, changes = {}) {
  const copy = structuredClone(source);
  Object.assign(copy, changes);
  const core = {...copy};
  delete core.artifact_content_hash;
  delete core.artifact_manifest;
  delete core.artifact_manifest_hash;
  delete core.hash_status;
  delete core.signature_status;
  copy.artifact_content_hash = sha256(core);
  copy.artifact_manifest = {
    ...copy.artifact_manifest,
    input_file_sha256: copy.input_file_sha256,
    dataset_source_commit_sha: copy.dataset_source_commit_sha,
    split_definition: copy.split_definition,
    purge_definition: copy.purge_definition,
    evaluation_status: copy.evaluation_status,
    scientific_qualification_status: copy.scientific_qualification_status,
    execution_qualification_status: copy.execution_qualification_status,
    promotion_status: copy.promotion_status,
    artifact_content_hash: copy.artifact_content_hash
  };
  copy.artifact_manifest_hash = sha256(copy.artifact_manifest);
  return copy;
}
function makeNormalizer(count) {
  return {
    feature_mean: Array(count).fill(0),
    feature_std: Array(count).fill(1),
    target_mean: 0,
    target_std: 1
  };
}

before(async () => {
  const rows44 = makeRows(44, 96);
  const returns = rows44.map((row, index) =>
    index % 3 === 0 ? 1.25 + row[0] * 0.15
      : index % 3 === 1 ? -0.75 + row[1] * 0.08
        : -0.25 + row[2] * 0.05);
  const contextual = fitHurdleReturnHead(rows44, returns, {
    learningRate: 0.02, epochs: 120, l2: 0.05, minimumClassRows: 8
  });
  const pooled = fitHurdleReturnHead(rows44.map(row => row.slice(0, 8)), returns, {
    learningRate: 0.02, epochs: 120, l2: 0.05, minimumClassRows: 8
  });
  const calibration=fitHurdlePositiveReturnCalibration(
    Array(returns.length).fill(0.65),returns,{
      minimumSamples:30,minimumPositive:8,minimumNegative:8,
      iterations:800,learningRate:0.03,regularization:0.05
    }
  );
  const calibrationProvenance={
    ...calibration,
    training_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_TRAINING_BLOCK',
    calibration_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK',
    training_rows:1800,training_positive_rows:500,training_non_positive_rows:1300,
    training_max_at:1000,training_max_resolved_at:14_401_000,
    calibration_rows:returns.length,
    calibration_positive_rows:returns.filter(value=>value>0).length,
    calibration_non_positive_rows:returns.filter(value=>value<=0).length,
    calibration_min_at:15_301_000,
    purged_rows:480,purged_groups:16,horizon_ms:14_400_000,
    resolved_label_gap_ms:900_000,training_decision_time_gap_ms:14_400_000,
    chronology_valid:true,complete_decision_groups:true,
    disjoint_sample_identities:true,source_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
    validation_or_holdout_used:false
  };
  const meanCalibrationProvenance={
    training_partition:calibrationProvenance.training_partition,
    calibration_partition:calibrationProvenance.calibration_partition,
    training_rows:calibrationProvenance.training_rows,
    training_positive_rows:calibrationProvenance.training_positive_rows,
    training_non_positive_rows:calibrationProvenance.training_non_positive_rows,
    training_max_at:calibrationProvenance.training_max_at,
    training_max_resolved_at:calibrationProvenance.training_max_resolved_at,
    calibration_rows:calibrationProvenance.calibration_rows,
    calibration_positive_rows:calibrationProvenance.calibration_positive_rows,
    calibration_non_positive_rows:calibrationProvenance.calibration_non_positive_rows,
    calibration_min_at:calibrationProvenance.calibration_min_at,
    purged_rows:calibrationProvenance.purged_rows,
    purged_groups:calibrationProvenance.purged_groups,
    horizon_ms:calibrationProvenance.horizon_ms,
    resolved_label_gap_ms:calibrationProvenance.resolved_label_gap_ms,
    training_decision_time_gap_ms:calibrationProvenance.training_decision_time_gap_ms,
    chronology_valid:calibrationProvenance.chronology_valid,
    complete_decision_groups:calibrationProvenance.complete_decision_groups,
    disjoint_sample_identities:calibrationProvenance.disjoint_sample_identities,
    source_partition:calibrationProvenance.source_partition,
    validation_or_holdout_used:false
  };
  const attachMeanCalibrations=(head,features)=>{
    const predictions=features.map(row=>predictHurdleExpectedNetReturn(row,head));
    const positiveIndexes=returns.map((value,index)=>value>0?index:-1)
      .filter(index=>index>=0);
    const nonPositiveIndexes=returns.map((value,index)=>value<=0?index:-1)
      .filter(index=>index>=0);
    head.positive_conditional_mean_model.conditional_mean_calibration={
      ...fitHurdleConditionalMeanCalibration(
        positiveIndexes.map(index=>predictions[index].positive_net_return_mean_pct),
        positiveIndexes.map(index=>returns[index]),
        {positiveClass:true,iterations:200,regularization:0.05}
      ),...meanCalibrationProvenance
    };
    head.non_positive_conditional_mean_model.conditional_mean_calibration={
      ...fitHurdleConditionalMeanCalibration(
        nonPositiveIndexes.map(index=>predictions[index].non_positive_net_return_mean_pct),
        nonPositiveIndexes.map(index=>returns[index]),
        {positiveClass:false,iterations:200,regularization:0.05}
      ),...meanCalibrationProvenance
    };
  };
  attachMeanCalibrations(contextual,rows44);
  attachMeanCalibrations(pooled,rows44.map(row=>row.slice(0,8)));
  contextual.probability_calibration={...calibrationProvenance};
  pooled.probability_calibration={...calibrationProvenance};
  const model = {
    executionRegressionHeadsFitted: true,
    executionHeadInputFeatureSchema: HURDLE_V2_CONTEXT_SCHEMA,
    executionHurdleReturnHeads: {
      LOGIT_CONTEXT_AUGMENTED: contextual,
      POOLED_ONLY: pooled
    },
    executionHeadNormalizers: {
      LOGIT_CONTEXT_AUGMENTED: {
        net_return: makeNormalizer(44), downside_risk: makeNormalizer(44)
      },
      POOLED_ONLY: {
        net_return: makeNormalizer(8), downside_risk: makeNormalizer(8)
      }
    },
    executionReturnHeadWeights: Array.from({length:44}, (_, i) => (i + 1) * 0.0005),
    executionReturnHeadBias: 0.015,
    executionReturnHeadPooledOnlyWeights: Array.from({length:8}, (_, i) => (i + 1) * 0.001),
    executionReturnHeadPooledOnlyBias: 0.01,
    executionRiskHeadWeights: Array.from({length:44}, (_, i) => (i + 1) * 0.0002),
    executionRiskHeadBias: 0.005,
    executionRiskHeadPooledOnlyWeights: Array.from({length:8}, (_, i) => (i + 1) * 0.0004),
    executionRiskHeadPooledOnlyBias: 0.004
  };
  const policy = {
    schema: 'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
    status: 'EVALUATED',
    passed: false,
    selected_risk_penalty_weight: 0.1,
    selected_ranking_score_adjustment_weight: 0.5,
    selected_minimum_positive_net_return_probability: 0.6,
    selected_minimum_risk_adjusted_score: 0.2,
    selected_return_estimator: 'HURDLE_EXPECTED_VALUE',
    selected_abstention_percentile: 0.2,
    selection_partition_only: true,
    threshold_selected_on_inner_selection: true,
    threshold_frozen_before_outer_validation: true,
    round_trip_cost_bps: 30,
    top_k_per_timestamp: 1,
    holdout_values_used: false
  };
  fixture = {
    fit: {
      model,
      execution_risk_policy: policy,
      pooled_only_execution_risk_policy: {...policy, selected_risk_penalty_weight: 0.12,
        selected_ranking_score_adjustment_weight: 0},
      training: {
        execution_regression_heads: {
          training_rows: 1800,
          model_training_rows: 6500,
          model_training_max_resolved_at: 14401000,
          execution_head_min_at: 15301000,
          purge_gap_ms: 900000,
          execution_head_split_status: 'READY',
          execution_head_split_method: 'LATEST_COMPLETE_15M_GROUPS_WITH_FORWARD_LABEL_PURGE',
          purged_rows: 12,
          chronology_valid: true,
          source_partition: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
          execution_head_split_source_partition: 'INNER_TRAINING_PARTITION_ONLY',
          representation_out_of_sample: true,
          training_and_execution_head_identities_disjoint: true,
          validation_or_holdout_used: false,
          hurdle_return_head: {validation_or_holdout_used:false}
        }
      }
    },
    selection: {
      status: 'ABSTAIN_NO_INNER_SELECTION_SUPERIORITY',
      selection_scoring: {
        method: 'INNER_CLASSIFIER_BRIER_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKING_V6'
      },
      execution_head_context_ablation_qualification: {
        passed: false, reason: 'CONTEXT_POLICY_FAILED_ABSOLUTE_GATES_VS_NO_EXPOSURE_REFERENCE'
      },
      execution_head_context_ablation: {
        status: 'FAIL', passed: false,
        contextual: {trade_count: 7, win_rate_pct: 42.857142857, net_pnl_pct: 0.060233, max_drawdown_pct: 0.193713},
        pooled_only: {trade_count: 0, win_rate_pct: null, net_pnl_pct: 0, max_drawdown_pct: 0}
      },
      validation_or_holdout_used_for_fit_or_selection: false,
      candidates: [{
        name: '4H_BRIER_SHARED_RANK_W040_LR0015_E16',
        selection_brier: 0.02892058,
        brier_improvement: 0.00116802,
        pairwise_ranking_improvement: 0.04560154
      }],
      baseline: {selection_brier: 0.03008860}
    },
    datasetSha256: 'f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77',
    inputFileSha256: 'f16adcbb88fb64e4d79626c1cf0e4c8d461bd33a3c0f598223ac809c28b0ff3d',
    datasetSourceCommitSha: '039c9074fc21fa0ea303e360a6ea56d3a401a559',
    datasetRowCount: 32300,
    targetDefinition: 'FIRST_TOUCH_PLUS_3_PCT_BEFORE_MINUS_2_PCT_WITHIN_4H_1M_V1',
    targetSemantics: 'UP_IF_PLUS_3_PCT_FIRST_BEFORE_MINUS_2_PCT_ELSE_NON_SUCCESS_WITHIN_4H_1M_V1',
    splitDefinition: {
      schema: 'RADARX_NEURAL_CLOSURE_PURGED_60_20_20_UTC_DAY_SPLIT_V1',
      purge_ms: 86400000,
      counts: {train:19269, validation:6282, holdout:6389},
      boundaries: {
        train_last_at: 1767225599000,
        validation_first_at: 1767312000001,
        validation_last_at: 1767398399000,
        holdout_first_at: 1767484800001
      }
    },
    codeCommitSha: '1f845f944b0f5119a2bb6b08aeeaf1d48178f1ec',
    roundTripCostBps: 30,
    randomSeed: 22429,
    innerQualified: false,
    objectiveId: HURDLE_V2_OBJECTIVE,
    selectionObjectiveId: 'INNER_CLASSIFIER_BRIER_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKING_V6',
    orderedRankingDependency: {
      artifact_schema:'RADARX_TCN_LSTM_ORDERED_TEMPORAL_RANKER_ARTIFACT_V1',
      artifact_path:'model-artifacts/TCN_LSTM_ORDERED_RANKER.json',
      manifest_path:'model-artifacts/TCN_LSTM_ORDERED_RANKER.manifest.json',
      artifact_content_hash:'5'.repeat(64),
      artifact_manifest_hash:'6'.repeat(64),
      code_commit_sha:'1f845f944b0f5119a2bb6b08aeeaf1d48178f1ec',
      dataset_sha256:'f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77',
      input_file_sha256:'f16adcbb88fb64e4d79626c1cf0e4c8d461bd33a3c0f598223ac809c28b0ff3d',
      representation:'RAW_ORDERED_696_V1',
      feature_schema_id:'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1',
      feature_count:696,validation_or_holdout_used:false,holdout_status:'LOCKED'
    }
  };
  artifact = createHurdleV2Artifact(fixture);
  directory = await mkdtemp(join(tmpdir(), 'radarx-hurdle-v2-'));
});

test('01. deterministic fixture actually trains both Hurdle heads', () => {
  assert.equal(fixture.fit.model.executionHurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED.fitted, true);
  assert.equal(fixture.fit.model.executionHurdleReturnHeads.POOLED_ONLY.fitted, true);
});
test('02. contextual and pooled head parameters are learned, non-zero and finite', () => {
  for (const key of ['LOGIT_CONTEXT_AUGMENTED','POOLED_ONLY']) {
    const head = fixture.fit.model.executionHurdleReturnHeads[key];
    assert.ok(head.weights.some(value => value !== 0));
    assert.ok(head.positive_conditional_mean_model.weights.some(value => value !== 0));
    assert.ok(head.non_positive_conditional_mean_model.weights.some(value => value !== 0));
    assert.ok(allFinite(head));
  }
});
test('03. artifact contains both independently serialized heads', () => {
  assert.equal(artifact.contextual_head_present, true);
  assert.equal(artifact.pooled_head_present, true);
  assert.equal(artifact.contextual_head_parameters.weights.length, 44);
  assert.equal(artifact.pooled_head_parameters.weights.length, 8);
  assert.equal(artifact.upstream_ordered_ranker_dependency.feature_count,696);
  assert.equal(artifact.upstream_ordered_ranker_dependency.representation,'RAW_ORDERED_696_V1');
});
test('03f. Hurdle rejects overlapping execution-head chronology or a missing purge audit',()=>{
  const overlap=structuredClone(fixture);
  overlap.fit.training.execution_regression_heads.execution_head_min_at=
    overlap.fit.training.execution_regression_heads.model_training_max_resolved_at;
  assert.throws(()=>createHurdleV2Artifact(overlap),
    /HURDLE_V2_ARTIFACT_VERIFY_FAILED:EXECUTION_HEAD_CHRONOLOGY_OR_PURGE_INVALID/);

  const missingSplit=structuredClone(fixture);
  missingSplit.fit.training.execution_regression_heads.execution_head_split_status='UNAVAILABLE';
  assert.throws(()=>createHurdleV2Artifact(missingSplit),
    /HURDLE_V2_ARTIFACT_VERIFY_FAILED:EXECUTION_HEAD_CHRONOLOGY_OR_PURGE_INVALID/);

  const wrongSource=structuredClone(fixture);
  wrongSource.fit.training.execution_regression_heads.execution_head_split_source_partition='OUTER_VALIDATION';
  assert.throws(()=>createHurdleV2Artifact(wrongSource),
    /HURDLE_V2_ARTIFACT_VERIFY_FAILED:EXECUTION_HEAD_CHRONOLOGY_OR_PURGE_INVALID/);
});

test('03e. Hurdle refuses holdout-tainted execution-head training provenance',()=>{
  const invalid=structuredClone(fixture);
  invalid.fit.training.execution_regression_heads.validation_or_holdout_used=true;
  assert.throws(()=>createHurdleV2Artifact(invalid),
    /HURDLE_V2_ARTIFACT_VERIFY_FAILED:TRAINING_PROVENANCE_HOLDOUT_FLAG_INVALID/);
});

test('03d. Hurdle uses the selection result holdout flag instead of manufacturing a false value',()=>{
  const invalid=structuredClone(fixture);
  invalid.selection.validation_or_holdout_used_for_fit_or_selection=true;
  assert.throws(()=>createHurdleV2Artifact(invalid),
    /HURDLE_V2_ARTIFACT_VERIFY_FAILED:HOLDOUT_LOCK_CONTRACT_INVALID/);
});

test('03c. Hurdle preserves and rejects non-inner or holdout-tainted inference-policy provenance',()=>{
  const invalid=structuredClone(fixture);
  invalid.fit.execution_risk_policy={
    ...invalid.fit.execution_risk_policy,
    selection_partition_only:false,
    source_partition:'OUTER_VALIDATION',
    holdout_values_used:true
  };
  assert.throws(()=>createHurdleV2Artifact(invalid),
    /HURDLE_V2_ARTIFACT_VERIFY_FAILED:ABSTENTION_POLICY_PROVENANCE_INVALID/);
});

test('03b. Hurdle rejects an upstream ordered-ranker dependency with mismatched provenance',()=>{
  const invalid=structuredClone(fixture);
  invalid.orderedRankingDependency.dataset_sha256='9'.repeat(64);
  assert.throws(()=>createHurdleV2Artifact(invalid),
    /HURDLE_V2_ORDERED_RANKER_DEPENDENCY_INVALID/);
  const changed=JSON.parse(JSON.stringify(artifact));
  changed.upstream_ordered_ranker_dependency.artifact_content_hash='7'.repeat(64);
  assert.equal(verifyHurdleV2Artifact(changed).reason,'CONTENT_HASH_MISMATCH');
});
test('04. artifact records complete code, dataset, target, split and cost provenance', () => {
  assert.equal(artifact.code_commit_sha, fixture.codeCommitSha);
  assert.equal(artifact.dataset_sha256, fixture.datasetSha256);
  assert.equal(artifact.dataset_source_commit_sha, fixture.datasetSourceCommitSha);
  assert.equal(artifact.input_file_sha256, fixture.inputFileSha256);
  assert.equal(artifact.dataset_row_count, 32300);
  assert.equal(artifact.target_definition, fixture.targetDefinition);
  assert.equal(artifact.target_semantics, fixture.targetSemantics);
  assert.equal(artifact.split_id, fixture.splitDefinition.schema);
  assert.equal(artifact.round_trip_cost_bps, 30);
  assert.deepEqual(artifact.split_definition.counts, {
    train: 19269, validation: 6282, holdout: 6389, purged: 360, total: 32300
  });
  assert.equal(artifact.artifact_manifest.input_file_sha256, fixture.inputFileSha256);
  assert.equal(artifact.artifact_manifest.dataset_source_commit_sha, fixture.datasetSourceCommitSha);
  assert.deepEqual(artifact.artifact_manifest.split_definition, artifact.split_definition);
  assert.deepEqual(artifact.artifact_manifest.purge_definition, artifact.purge_definition);
});
test('05. Hurdle objective and calibration contract are explicit', () => {
  assert.equal(artifact.objective_id, HURDLE_V2_OBJECTIVE);
  assert.equal(artifact.selection_objective_id, fixture.selectionObjectiveId);
  assert.match(artifact.calibration_definition, /PURGED_EXECUTION_HEAD_PLATT_CALIBRATION/);
  assert.equal(artifact.calibration_id,'RADARX_HURDLE_V2_PURGED_EXECUTION_HEAD_PLATT_CALIBRATION_V1');
  assert.equal(artifact.artifact_schema_version,2);
  assert.equal(artifact.contextual_head_parameters.probability_calibration.fitted,true);
  assert.equal(artifact.pooled_head_parameters.probability_calibration.fitted,true);
  assert.ok(artifact.calibration_id);
});
test('05b. artifact verifier rejects a head without the purged probability calibrator',()=>{
  const invalid=JSON.parse(JSON.stringify(artifact));
  delete invalid.contextual_head_parameters.probability_calibration;
  const result=verifyHurdleV2Artifact(invalid);
  assert.equal(result.valid,false);
  assert.match(result.reason,/HURDLE_V2_HEAD_INVALID:contextual/);
});

test('06. failed scientific qualification does not prevent artifact creation', () => {
  assert.equal(artifact.training_status, 'TRAINED');
  assert.equal(artifact.scientific_qualification_status, 'NOT_QUALIFIED');
  assert.equal(artifact.inner_qualification.passed, false);
});
test('07. failed qualification keeps promotion disabled', () => {
  assert.equal(artifact.promotion_status, 'NOT_APPROVED');
  assert.equal(artifact.execution_qualification_status, 'NOT_QUALIFIED');
});
test('08. feature order and V6 schema match both tensor widths', () => {
  assert.equal(artifact.input_contract.contextual.feature_schema_id, HURDLE_V2_CONTEXT_SCHEMA);
  assert.equal(artifact.feature_order.contextual.length, 44);
  assert.equal(artifact.feature_order.pooled.length, 8);
  assert.equal(artifact.feature_shape.contextual[0], 44);
  assert.equal(artifact.feature_shape.pooled[0], 8);
});
test('09. every normalizer has the exact width and finite positive scales', () => {
  assert.equal(artifact.normalization_parameters.contextual.feature_mean.length, 44);
  assert.equal(artifact.normalization_parameters.pooled.feature_mean.length, 8);
  assert.equal(artifact.normalization_parameters.contextual_risk.feature_std.length, 44);
  assert.equal(artifact.normalization_parameters.pooled_risk.feature_std.length, 8);
  assert.ok(allFinite(artifact.normalization_parameters));
});
test('10. conditional positive and non-positive return parameters are present', () => {
  assert.ok(artifact.conditional_positive_return_parameters.contextual.fitted);
  assert.ok(artifact.conditional_positive_return_parameters.pooled.fitted);
  assert.ok(artifact.conditional_non_positive_return_parameters.contextual.fitted);
  assert.ok(artifact.conditional_non_positive_return_parameters.pooled.fitted);
});
test('11. pointwise expected-return references are included for both heads', () => {
  assert.equal(artifact.pointwise_return_reference_parameters.contextual.weights.length, 44);
  assert.equal(artifact.pointwise_return_reference_parameters.pooled.weights.length, 8);
});
test('12. risk parameters and the inner-selected policies are persisted', () => {
  assert.equal(artifact.risk_parameters.contextual.weights.length, 44);
  assert.equal(artifact.risk_parameters.pooled.weights.length, 8);
  assert.equal(artifact.abstention_parameters.policy_selection_partition, 'INNER_SELECTION_ONLY');
  assert.equal(artifact.abstention_parameters.contextual.selected_risk_penalty_weight, 0.1);
  assert.equal(artifact.abstention_parameters.contextual.selected_ranking_score_adjustment_weight, 0.5);
  assert.equal(artifact.abstention_parameters.contextual.selected_minimum_positive_net_return_probability,0.6);
  assert.equal(artifact.abstention_parameters.pooled.selected_risk_penalty_weight, 0.12);
  assert.equal(artifact.abstention_parameters.pooled.selected_minimum_positive_net_return_probability,0.6);
  assert.equal(artifact.risk_parameters.contextual.ranking_score_adjustment_weight, 0.5);
  assert.equal(artifact.risk_parameters.pooled.ranking_score_adjustment_weight, 0);
  assert.match(artifact.risk_parameters.ranking_adjustment_semantics,/NEVER_ADDED_TO_CLASSIFIER_PROBABILITY/);
});
test('13. declared 30 bps cost is applied once and never subtracted again at inference', () => {
  assert.equal(artifact.cost_application.applied_exactly_once, true);
  assert.equal(artifact.cost_application.subtract_again_at_inference, false);
  assert.equal(artifact.cost_application.training_target_includes_declared_round_trip_cost, true);
});
test('14. locked holdout metadata contains zero predictions and zero scored rows', () => {
  assert.equal(artifact.holdout_status, 'LOCKED');
  assert.equal(artifact.split_definition.holdout_scored_rows, 0);
  assert.equal(artifact.inner_qualification.validation_or_holdout_used, false);
});
test('15. all serialized parameter values are finite', () => {
  assert.ok(allFinite(artifact));
});
test('16. hashes are stable for an identical deterministic fixture', () => {
  const repeated = createHurdleV2Artifact(fixture);
  assert.equal(repeated.artifact_content_hash, artifact.artifact_content_hash);
  assert.equal(repeated.artifact_manifest_hash, artifact.artifact_manifest_hash);
});
test('17. content hash and manifest hash verify independently', () => {
  const result = verifyHurdleV2Artifact(artifact);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.content_hash, artifact.artifact_content_hash);
  assert.equal(result.manifest_hash, artifact.artifact_manifest_hash);
});
test('18. reloaded contextual probability and conditional returns match the original', () => {
  const expected = runHurdleV2ReloadProbes(artifact).contextual;
  const actual = predictHurdleExpectedNetReturn(
    Array.from({length:44}, (_, i) => (i - 22 + 0.5) / 37),
    artifact.contextual_head_parameters
  );
  assert.deepEqual(actual, expected);
});
test('19. reloaded pooled probability and conditional returns match the original', () => {
  const expected = runHurdleV2ReloadProbes(artifact).pooled;
  const actual = predictHurdleExpectedNetReturn(
    Array.from({length:8}, (_, i) => (i - 4 + 0.5) / 37),
    artifact.pooled_head_parameters
  );
  assert.deepEqual(actual, expected);
});
test('20. contextual and pooled reload probe outputs include expected net return', () => {
  const outputs = runHurdleV2ReloadProbes(artifact);
  assert.ok(Number.isFinite(outputs.contextual.expected_net_return_pct));
  assert.ok(Number.isFinite(outputs.pooled.expected_net_return_pct));
});
test('21. gradient-driven parameter updates and Huber/logistic losses are finite', () => {
  for (const key of ['LOGIT_CONTEXT_AUGMENTED','POOLED_ONLY']) {
    const head = fixture.fit.model.executionHurdleReturnHeads[key];
    assert.ok(Number.isFinite(head.initial_log_loss));
    assert.ok(Number.isFinite(head.final_log_loss));
    assert.ok(head.epochs_completed > 0);
    assert.ok(head.weights.some(value => Math.abs(value) > 1e-10));
    assert.ok(Number.isFinite(head.positive_conditional_mean_model.final_huber_loss));
    assert.ok(Number.isFinite(head.non_positive_conditional_mean_model.final_huber_loss));
  }
});
test('22. deterministic artifact export writes both the payload and manifest', async () => {
  exported = await writeHurdleV2ArtifactAtomic(directory, artifact);
  assert.ok(exported.artifact_path.endsWith('HURDLE_V2.json'));
  assert.ok(exported.manifest_path.endsWith('HURDLE_V2.manifest.json'));
});
test('23. artifact and manifest survive reload from disk with identical hashes', async () => {
  const disk = JSON.parse(await readFile(exported.artifact_path, 'utf8'));
  const manifest = JSON.parse(await readFile(exported.manifest_path, 'utf8'));
  assert.equal(verifyHurdleV2Artifact(disk).valid, true);
  assert.deepEqual(manifest, disk.artifact_manifest);
  assert.equal(disk.artifact_content_hash, exported.artifact_content_hash);
  assert.equal(disk.artifact_manifest_hash, exported.artifact_manifest_hash);
});
test('24. fresh Node process reloads artifact and verifies both head probes', () => {
  assert.equal(exported.same_process_reload_verified, true);
  assert.equal(exported.fresh_process_reload_verified, true);
  assert.equal(exported.fresh_process_result.valid, true);
  assert.equal(Number.isFinite(exported.fresh_process_result.probes.contextual.expected_net_return_pct), true);
  assert.equal(Number.isFinite(exported.fresh_process_result.probes.pooled.expected_net_return_pct), true);
});
test('25. a passing CI-style artifact check does not imply scientific qualification', () => {
  const result = verifyHurdleV2Artifact(artifact);
  assert.equal(result.valid, true);
  assert.equal(artifact.scientific_qualification_status, 'NOT_QUALIFIED');
  assert.equal(artifact.promotion_status, 'NOT_APPROVED');
});
test('26. qualification failure never deletes the artifact', async () => {
  const disk = JSON.parse(await readFile(exported.artifact_path, 'utf8'));
  assert.equal(disk.inner_qualification.passed, false);
  assert.equal(disk.artifact_content_hash, artifact.artifact_content_hash);
  await rm(directory, {recursive:true,force:true});
});
test('27. verifier rejects an invalid source SHA even after valid hashes are rebuilt', () => {
  const tampered = resealArtifact(artifact, {input_file_sha256: 'not-a-sha256'});
  const result = verifyHurdleV2Artifact(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'PROVENANCE_INVALID');
});
test('28. verifier rejects a changed fixed split even after valid hashes are rebuilt', () => {
  const tampered = structuredClone(artifact);
  tampered.split_definition.counts.train -= 1;
  const resealed = resealArtifact(tampered);
  const result = verifyHurdleV2Artifact(resealed);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SPLIT_PROVENANCE_INVALID');
});
test('29. verifier rejects enabling real orders even after valid hashes are rebuilt', () => {
  const tampered = resealArtifact(artifact, {
    paper_trading: false,
    real_order_execution: true
  });
  const result = verifyHurdleV2Artifact(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'EXECUTION_POLICY_MISMATCH');
});
test('30. verifier rejects a different but well-formed dataset SHA after resealing', () => {
  const tampered = resealArtifact(artifact, {
    dataset_sha256: 'a'.repeat(64)
  });
  const result = verifyHurdleV2Artifact(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'PROVENANCE_INVALID');
});
test('31. verifier rejects a different but well-formed source commit after resealing', () => {
  const tampered = resealArtifact(artifact, {
    dataset_source_commit_sha: 'b'.repeat(40)
  });
  const result = verifyHurdleV2Artifact(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'PROVENANCE_INVALID');
});
test('32. verifier rejects a broken UTC purge boundary after resealing', () => {
  const tampered = structuredClone(artifact);
  tampered.split_definition.utc_day_boundaries.validation_first_at =
    tampered.split_definition.utc_day_boundaries.train_last_at + 86400000;
  const resealed = resealArtifact(tampered);
  const result = verifyHurdleV2Artifact(resealed);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SPLIT_PROVENANCE_INVALID');
});
test('33. verifier rejects a forged inner-qualified status when all recorded gates failed', () => {
  const tampered = structuredClone(artifact);
  tampered.inner_qualification.passed = true;
  tampered.inner_qualification.status = 'INNER_QUALIFIED_FOR_OUTER_REPLAY';
  tampered.inner_qualification.selection_status = 'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY';
  tampered.evaluation_status = 'INNER_QUALIFIED_FOR_OUTER_REPLAY';
  tampered.scientific_qualification_status = 'INNER_QUALIFIED_FOR_OUTER_REPLAY';
  tampered.execution_qualification_status = 'INNER_QUALIFIED_FOR_OUTER_REPLAY';
  const resealed = resealArtifact(tampered);
  const result = verifyHurdleV2Artifact(resealed);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'QUALIFICATION_GATE_EVIDENCE_INCOMPLETE');
});

test('33b. Hurdle refuses inner qualification when the upstream ranker has no V6 fold-stability proof',()=>{
  const invalid=structuredClone(fixture);
  invalid.innerQualified=true;
  assert.throws(()=>createHurdleV2Artifact(invalid),
    /HURDLE_V2_RANKER_FOLD_STABILITY_EVIDENCE_REQUIRED/);
});

test('33c. verifier requires strict pairwise accuracy and log-loss superiority over Logistic in all three ranker folds',()=>{
  const qualified=structuredClone(artifact);
  const qualification=qualified.inner_qualification;
  const selectedName='SYNTHETIC_FOLD_STABLE_CANDIDATE';
  qualification.passed=true;
  qualification.status='INNER_QUALIFIED_FOR_OUTER_REPLAY';
  qualification.selection_status='INNER_SELECTION_QUALIFIED_RESEARCH_ONLY';
  qualification.selected_configuration=selectedName;
  qualification.diagnostic_configuration=null;
  const makeExecutionEvidence=(status,anchorGate)=>({
    schema:'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
    status,passed:true,selection_partition_only:true,
    source_partition:'INNER_SELECTION_ONLY',
    threshold_selected_on_inner_selection:true,
    threshold_frozen_before_outer_validation:true,
    holdout_values_used:false,round_trip_cost_bps:30,
    minimum_trades:20,minimum_win_rate_pct:55,maximum_drawdown_pct:8,
    top_k_per_timestamp:1,
    selected_trial:{
      top_k_per_timestamp:1,
      passed:true,
      gates:{
        return_data_complete:true,minimum_trades:true,minimum_win_rate:true,
        positive_net_pnl:true,maximum_drawdown:true,genuine_abstention:true,
        matched_logistic_signal_count:true,matched_logistic_executed_trade_count:true,
        [anchorGate]:true
      },
      model_metrics:{return_data_status:'COMPLETE',signal_count:24,trade_count:24,
        win_rate_pct:62.5,net_pnl_pct:2.1,max_drawdown_pct:4},
      logistic_anchor_metrics:{return_data_status:'COMPLETE',signal_count:24,trade_count:24,
        net_pnl_pct:1.2,max_drawdown_pct:4.5},
      logistic_anchor_signal_counts_matched:true,
      logistic_anchor_trade_counts_matched:true
    }
  });
  const contextAblation={
    schema:'RADARX_TCN_LSTM_EXECUTION_HEAD_CONTEXT_ABLATION_V1',
    status:'EVALUATED',source_partition:'INNER_SELECTION_ONLY',
    baseline_variant:'POOLED_ONLY',candidate_variant:'LOGIT_CONTEXT_AUGMENTED',
    pooled_only_no_exposure:true,context_policy_passed:true,
    both_policies_frozen_on_selection:true,
    baseline_and_candidate_use_matched_logistic_trade_counts:true,
    pooled_only_metrics:{signal_count:0,trade_count:0,win_rate_pct:null,
      net_pnl_pct:0,max_drawdown_pct:0},
    context_metrics:{signal_count:24,trade_count:24,win_rate_pct:62.5,
      net_pnl_pct:2.1,max_drawdown_pct:4},
    gates:{context_policy_absolute_gates:true,net_pnl_strictly_improved:true,
      win_rate_not_worse:true,drawdown_not_worse:true},
    passed:true,holdout_values_used:false
  };
  qualification.baseline={selection_brier:0.03};
  qualification.required_inner_improvement=0.00025;
  qualification.gate_results={qualified:true,result:contextAblation,
    source_partition:'INNER_SELECTION_ONLY',holdout_values_used:false};
  qualification.context_ablation=contextAblation;
  qualification.ranking_head_selection_qualification={qualified:true,status:'EVALUATED',
    source_partition:'INNER_SELECTION_ONLY',holdout_values_used:false};
  qualification.candidates=[{
    name:selectedName,
    passed_inner_margin:true,
    passed_inner_brier_margin:true,
    passed_inner_pairwise_ranking_gate:true,
    selection_brier:0.028,
    logistic_selection_brier:0.03,
    brier_improvement:0.002,
    independent_ranking_signal_passed:true,
    ranking_head_selection_qualified:true,
    execution_head_context_ablation_passed:true,
    execution_risk_policy:makeExecutionEvidence(
      'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION',
      'beats_matched_logistic_anchor'
    ),
    ranking_execution_selection:makeExecutionEvidence(
      'EVALUATED','beats_logistic_anchor'
    ),
    return_selection_diagnostics:{status:'AVAILABLE',preliminary_return_screen_candidates:1}
  }];
  qualified.evaluation_status='INNER_QUALIFIED_FOR_OUTER_REPLAY';
  qualified.scientific_qualification_status='INNER_QUALIFIED_FOR_OUTER_REPLAY';
  qualified.execution_qualification_status='INNER_QUALIFIED_FOR_OUTER_REPLAY';

  const withoutProof=resealArtifact(qualified);
  assert.equal(verifyHurdleV2Artifact(withoutProof).reason,
    'RANKER_FOLD_STABILITY_EVIDENCE_MISSING_OR_INVALID');

  const supported=structuredClone(qualified);
  supported.upstream_ordered_ranker_dependency.ranker_qualification={
    schema:'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6',
    fold_count:3,
    selected_candidate_qualified:true,
    fold_stable_dual_metric_superiority:true,
    fold_stable_dual_metric_candidate_count:1,
    robustness_status:'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY',
    selection_rule:'REQUIRE_STRICT_POSITIVE_LOGISTIC_MARGINS_FOR_PAIRWISE_ACCURACY_AND_LOG_LOSS_IN_EVERY_PURGED_TRAINING_FOLD',
    validation_or_holdout_used:false,
    selected_candidate:{
      temporal_block_count:4,
      l2:0.05,
      best_epoch:8,
      parameterization_id:'TEMPORAL_BLOCK_TIED_4X29_V1',
      parameter_count:116,
      minimum_fold_pairwise_accuracy_improvement_pct:0.5,
      minimum_fold_pairwise_log_loss_improvement:0.01,
      fold_results:[
        {fold_index:1,candidate_pairwise_accuracy_pct:62,logistic_pairwise_accuracy_pct:60,
          accuracy_improvement_pct:2,candidate_pairwise_log_loss:0.60,
          logistic_pairwise_log_loss:0.62,log_loss_improvement:0.02},
        {fold_index:2,candidate_pairwise_accuracy_pct:62.5,logistic_pairwise_accuracy_pct:62,
          accuracy_improvement_pct:0.5,candidate_pairwise_log_loss:0.61,
          logistic_pairwise_log_loss:0.62,log_loss_improvement:0.01},
        {fold_index:3,candidate_pairwise_accuracy_pct:64,logistic_pairwise_accuracy_pct:63,
          accuracy_improvement_pct:1,candidate_pairwise_log_loss:0.58,
          logistic_pairwise_log_loss:0.60,log_loss_improvement:0.02}
      ]
    }
  };
  const sealed=resealArtifact(supported);
  const result=verifyHurdleV2Artifact(sealed);
  assert.equal(result.valid,true,result.reason);
  assert.equal(sealed.holdout_status,'LOCKED');
  assert.equal(sealed.promotion_status,'NOT_APPROVED');
  assert.equal(sealed.real_order_execution,false);

  const accuracyRegression=structuredClone(supported);
  const badAccuracyFold=accuracyRegression.upstream_ordered_ranker_dependency
    .ranker_qualification.selected_candidate.fold_results[1];
  badAccuracyFold.candidate_pairwise_accuracy_pct=badAccuracyFold.logistic_pairwise_accuracy_pct;
  badAccuracyFold.accuracy_improvement_pct=0;
  const accuracyResealed=resealArtifact(accuracyRegression);
  assert.equal(verifyHurdleV2Artifact(accuracyResealed).reason,
    'RANKER_FOLD_STABILITY_EVIDENCE_MISSING_OR_INVALID',
    'one fold with no accuracy improvement must fail closed');

  const lossRegression=structuredClone(supported);
  const badLossFold=lossRegression.upstream_ordered_ranker_dependency
    .ranker_qualification.selected_candidate.fold_results[2];
  badLossFold.candidate_pairwise_log_loss=badLossFold.logistic_pairwise_log_loss+0.001;
  badLossFold.log_loss_improvement=-0.001;
  const lossResealed=resealArtifact(lossRegression);
  assert.equal(verifyHurdleV2Artifact(lossResealed).reason,
    'RANKER_FOLD_STABILITY_EVIDENCE_MISSING_OR_INVALID',
    'one fold with worse pairwise log loss must fail closed');

  const forgedBrier=structuredClone(supported);
  forgedBrier.inner_qualification.candidates[0].brier_improvement=0.0001;
  const brierResealed=resealArtifact(forgedBrier);
  assert.equal(verifyHurdleV2Artifact(brierResealed).reason,
    'CLASSIFIER_BRIER_MARGIN_EVIDENCE_INVALID',
    'a recorded Brier margin below the frozen inner threshold must fail closed');

  const inconsistentBrier=structuredClone(supported);
  inconsistentBrier.inner_qualification.candidates[0].selection_brier=0.029;
  const inconsistentBrierResealed=resealArtifact(inconsistentBrier);
  assert.equal(verifyHurdleV2Artifact(inconsistentBrierResealed).reason,
    'CLASSIFIER_BRIER_MARGIN_EVIDENCE_INVALID',
    'recorded Brier improvement must recompute from the saved Logistic and model Brier values');

  const mismatchedLogisticBrier=structuredClone(supported);
  mismatchedLogisticBrier.inner_qualification.candidates[0].logistic_selection_brier=0.031;
  const mismatchedLogisticBrierResealed=resealArtifact(mismatchedLogisticBrier);
  assert.equal(verifyHurdleV2Artifact(mismatchedLogisticBrierResealed).reason,
    'CLASSIFIER_BRIER_MARGIN_EVIDENCE_INVALID',
    'candidate Logistic Brier must match the immutable selected Logistic baseline');

  const belowWinGate=structuredClone(supported);
  const winTrial=belowWinGate.inner_qualification.candidates[0].execution_risk_policy.selected_trial;
  winTrial.model_metrics.win_rate_pct=54.9;
  const winResealed=resealArtifact(belowWinGate);
  assert.equal(verifyHurdleV2Artifact(winResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'a candidate below the predeclared 55% win-rate gate must fail closed');

  const negativePnl=structuredClone(supported);
  negativePnl.inner_qualification.candidates[0].ranking_execution_selection
    .selected_trial.model_metrics.net_pnl_pct=0;
  const pnlResealed=resealArtifact(negativePnl);
  assert.equal(verifyHurdleV2Artifact(pnlResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'a candidate without positive net PnL must fail closed');

  const excessiveDrawdown=structuredClone(supported);
  excessiveDrawdown.inner_qualification.candidates[0].execution_risk_policy
    .selected_trial.model_metrics.max_drawdown_pct=8.01;
  const drawdownResealed=resealArtifact(excessiveDrawdown);
  assert.equal(verifyHurdleV2Artifact(drawdownResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'a candidate above the 8% maximum drawdown must fail closed');

  const mismatchedSignals=structuredClone(supported);
  mismatchedSignals.inner_qualification.candidates[0].execution_risk_policy
    .selected_trial.logistic_anchor_metrics.signal_count=23;
  const signalsResealed=resealArtifact(mismatchedSignals);
  assert.equal(verifyHurdleV2Artifact(signalsResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'the actual model and Logistic signal counts must match, not only the recorded flag');

  const fractionalTrades=structuredClone(supported);
  const fractionalTrial=fractionalTrades.inner_qualification.candidates[0]
    .execution_risk_policy.selected_trial;
  fractionalTrial.model_metrics.trade_count=24.5;
  fractionalTrial.logistic_anchor_metrics.trade_count=24.5;
  const fractionalResealed=resealArtifact(fractionalTrades);
  assert.equal(verifyHurdleV2Artifact(fractionalResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'executed trade counts must be integers');

  const impossibleWinRate=structuredClone(supported);
  impossibleWinRate.inner_qualification.candidates[0].ranking_execution_selection
    .selected_trial.model_metrics.win_rate_pct=100.1;
  const impossibleWinResealed=resealArtifact(impossibleWinRate);
  assert.equal(verifyHurdleV2Artifact(impossibleWinResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'win rate must remain within the mathematical 0–100% interval');

  const wrongTopK=structuredClone(supported);
  wrongTopK.inner_qualification.candidates[0].ranking_execution_selection
    .selected_trial.top_k_per_timestamp=2;
  const wrongTopKResealed=resealArtifact(wrongTopK);
  assert.equal(verifyHurdleV2Artifact(wrongTopKResealed).reason,
    'PROFITABILITY_GATE_EVIDENCE_MISSING_OR_INVALID',
    'profitability evidence must preserve the frozen top-1 execution rule');
});

test('34. verifier rejects scientific qualification status drift from the qualification record', () => {
  const resealed = resealArtifact(artifact, {
    scientific_qualification_status: 'INNER_QUALIFIED_FOR_OUTER_REPLAY'
  });
  const result = verifyHurdleV2Artifact(resealed);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'QUALIFICATION_STATUS_INCONSISTENT');
});
