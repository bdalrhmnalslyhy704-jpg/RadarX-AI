import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fitHurdleReturnHead,fitHurdlePositiveReturnCalibration,predictHurdleExpectedNetReturn} from '../core/hurdle-return-head.mjs';
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
          source_partition: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
          representation_out_of_sample: true,
          training_and_execution_head_identities_disjoint: true
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
      counts: {train:19269, validation:6282, holdout:6389}
    },
    codeCommitSha: '1f845f944b0f5119a2bb6b08aeeaf1d48178f1ec',
    roundTripCostBps: 30,
    randomSeed: 22429,
    innerQualified: false,
    objectiveId: HURDLE_V2_OBJECTIVE,
    selectionObjectiveId: 'INNER_CLASSIFIER_BRIER_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKING_V6'
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
});
test('04. artifact records complete code, dataset, target, split and cost provenance', () => {
  assert.equal(artifact.code_commit_sha, fixture.codeCommitSha);
  assert.equal(artifact.dataset_sha256, fixture.datasetSha256);
  assert.equal(artifact.dataset_row_count, 32300);
  assert.equal(artifact.target_definition, fixture.targetDefinition);
  assert.equal(artifact.target_semantics, fixture.targetSemantics);
  assert.equal(artifact.split_id, fixture.splitDefinition.schema);
  assert.equal(artifact.round_trip_cost_bps, 30);
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
