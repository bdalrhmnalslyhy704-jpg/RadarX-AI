import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predictHurdleExpectedNetReturn } from './hurdle-return-head.mjs';

export const HURDLE_V2_ARTIFACT_SCHEMA =
  'RADARX_BUILD224_HURDLE_V2_DUAL_HEAD_ARTIFACT_V2';
export const HURDLE_V2_CONTEXT_SCHEMA =
  'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_SCORE_GATED_BY_MATCHED_FULL_SEQUENCE_LOGISTIC_CV_OOF_CLASSIFIER_AND_INDEPENDENT_RANK_SCORE_V8';
export const HURDLE_V2_POOLED_SCHEMA =
  'RADARX_TCN_LSTM_EXECUTION_HEAD_POOLED_ONLY_V1';
export const HURDLE_V2_FEATURE_SCHEMA =
  'RADARX_TCN_LSTM_HURDLE_V2_CONTEXTUAL_44_AND_POOLED_8_FEATURES_V2';
export const HURDLE_V2_OBJECTIVE =
  'RADARX_HURDLE_V2_BINARY_LOGISTIC_NLL_PLUS_CLASS_CONDITIONAL_HUBER_V1';
export const HURDLE_V2_CALIBRATION_ID =
  'RADARX_HURDLE_V2_PURGED_EXECUTION_HEAD_PLATT_CALIBRATION_V1';

const HURDLE_V2_FIXED_DATASET_ROWS = 32300;
const HURDLE_V2_FIXED_DATASET_SHA256 =
  'f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77';
const HURDLE_V2_FIXED_INPUT_SHA256 =
  'f16adcbb88fb64e4d79626c1cf0e4c8d461bd33a3c0f598223ac809c28b0ff3d';
const HURDLE_V2_FIXED_SOURCE_COMMIT =
  '039c9074fc21fa0ea303e360a6ea56d3a401a559';
const HURDLE_V2_FIXED_SPLIT = Object.freeze({
  schema: 'RADARX_NEURAL_CLOSURE_PURGED_60_20_20_UTC_DAY_SPLIT_V1',
  purge_ms: 86400000,
  counts: Object.freeze({
    train: 19269, validation: 6282, holdout: 6389,
    purged: 360, total: 32300
  })
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
};
const hashObject = value => sha256(Buffer.from(canonical(value), 'utf8'));
const finiteTree = (value, at = 'artifact') => {
  if (Array.isArray(value)) value.forEach((child, index) => finiteTree(child, at + '[' + index + ']'));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) finiteTree(child, at + '.' + key);
  } else if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('HURDLE_V2_NON_FINITE:' + at);
  } else if (value === undefined || typeof value === 'function' ||
      typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError('HURDLE_V2_NON_SERIALIZABLE:' + at);
  }
};
const pooledFeatureNames = Array.from({length: 8}, (_, i) => 'pooled_latent_' + i);
const contextualFeatureNames = [
  ...pooledFeatureNames,
  ...pooledFeatureNames.map(name => name + '_x_logistic_anchor_score'),
  ...pooledFeatureNames.map(name => name + '_x_temporal_logistic_cv_score'),
  ...pooledFeatureNames.map(name => name + '_x_neural_classifier_score'),
  ...pooledFeatureNames.map(name => name + '_x_independent_return_rank_score'),
  'logistic_anchor_logit_tanh_div_4',
  'temporal_logistic_cv_logit_tanh_div_4',
  'neural_classifier_logit_tanh_div_4',
  'independent_return_rank_score_tanh_div_4'
];

function validateFixedSplit(splitDefinition, datasetRowCount) {
  const counts = splitDefinition?.counts;
  const scored = Number(counts?.train) + Number(counts?.validation) +
    Number(counts?.holdout);
  const purged = Number(datasetRowCount) - scored;
  const boundaries = splitDefinition?.boundaries;
  const chronologyValid = boundaries &&
    finite(boundaries.train_last_at) &&
    finite(boundaries.validation_first_at) &&
    finite(boundaries.validation_last_at) &&
    finite(boundaries.holdout_first_at) &&
    boundaries.validation_first_at - boundaries.train_last_at >
      HURDLE_V2_FIXED_SPLIT.purge_ms &&
    boundaries.holdout_first_at - boundaries.validation_last_at >
      HURDLE_V2_FIXED_SPLIT.purge_ms;
  if (!chronologyValid ||
      datasetRowCount !== HURDLE_V2_FIXED_DATASET_ROWS ||
      splitDefinition?.schema !== HURDLE_V2_FIXED_SPLIT.schema ||
      splitDefinition?.purge_ms !== HURDLE_V2_FIXED_SPLIT.purge_ms ||
      counts?.train !== HURDLE_V2_FIXED_SPLIT.counts.train ||
      counts?.validation !== HURDLE_V2_FIXED_SPLIT.counts.validation ||
      counts?.holdout !== HURDLE_V2_FIXED_SPLIT.counts.holdout ||
      purged !== HURDLE_V2_FIXED_SPLIT.counts.purged) {
    throw new TypeError('HURDLE_V2_SPLIT_PROVENANCE_INVALID');
  }
  return {
    train: counts.train,
    validation: counts.validation,
    holdout: counts.holdout,
    purged,
    total: datasetRowCount
  };
}

function validateNormalizer(normalizer, count, name) {
  if (!normalizer || !Array.isArray(normalizer.feature_mean) ||
      !Array.isArray(normalizer.feature_std) ||
      normalizer.feature_mean.length !== count || normalizer.feature_std.length !== count ||
      !normalizer.feature_mean.every(finite) ||
      !normalizer.feature_std.every(value => finite(value) && value > 0) ||
      !finite(normalizer.target_mean) || !finite(normalizer.target_std) ||
      normalizer.target_std <= 0) {
    throw new TypeError('HURDLE_V2_NORMALIZATION_INVALID:' + name);
  }
}
function validateHead(head, names, name) {
  const count = names.length;
  const calibration=head?.probability_calibration;
  const calibrationValid=calibration?.schema===
      'RADARX_HURDLE_POSITIVE_NET_RETURN_PLATT_CALIBRATOR_V1'&&
    calibration.fitted===true&&
    finite(calibration.slope)&&calibration.slope>=0.05&&calibration.slope<=8&&
    finite(calibration.intercept)&&calibration.intercept>=-8&&calibration.intercept<=8&&
    calibration.fit_boundary===
      'PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK_ONLY'&&
    calibration.training_partition==='PURGED_INNER_TRAINING_EXECUTION_HEAD_TRAINING_BLOCK'&&
    calibration.calibration_partition==='PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK'&&
    Number.isInteger(calibration.training_rows)&&calibration.training_rows>=20&&
    Number.isInteger(calibration.training_positive_rows)&&calibration.training_positive_rows>=8&&
    Number.isInteger(calibration.training_non_positive_rows)&&calibration.training_non_positive_rows>=8&&
    Number.isInteger(calibration.calibration_rows)&&calibration.calibration_rows>=30&&
    Number.isInteger(calibration.calibration_positive_rows)&&calibration.calibration_positive_rows>=8&&
    Number.isInteger(calibration.calibration_non_positive_rows)&&calibration.calibration_non_positive_rows>=8&&
    Number.isInteger(calibration.purged_rows)&&calibration.purged_rows>0&&
    Number.isInteger(calibration.horizon_ms)&&calibration.horizon_ms===14_400_000&&
    finite(calibration.training_max_at)&&finite(calibration.training_max_resolved_at)&&
    finite(calibration.calibration_min_at)&&
    calibration.training_max_resolved_at<calibration.calibration_min_at&&
    calibration.calibration_min_at-calibration.training_max_at>=calibration.horizon_ms&&
    finite(calibration.resolved_label_gap_ms)&&calibration.resolved_label_gap_ms>0&&
    calibration.chronology_valid===true&&
    calibration.complete_decision_groups===true&&
    calibration.disjoint_sample_identities===true&&
    calibration.validation_or_holdout_used===false;
  if (!head || head.schema !== 'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V2' ||
      head.fitted !== true || !Array.isArray(head.weights) ||
      head.weights.length !== count || !head.weights.every(finite) ||
      !Array.isArray(head.feature_mean) || head.feature_mean.length !== count ||
      !head.feature_mean.every(finite) || !Array.isArray(head.feature_std) ||
      head.feature_std.length !== count ||
      !head.feature_std.every(value => finite(value) && value > 0) ||
      !finite(head.bias) || head.conditional_mean_type !== 'FEATURE_CONDITIONAL_HUBER_REGRESSION_V1' ||
      head.validation_or_holdout_used !== false ||
      head.fit_boundary !== 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY' ||
      !head.positive_conditional_mean_model?.fitted ||
      !head.non_positive_conditional_mean_model?.fitted ||
      !calibrationValid) {
    throw new TypeError('HURDLE_V2_HEAD_INVALID:' + name);
  }
  for (const [label, model, positive] of [
    ['positive', head.positive_conditional_mean_model, true],
    ['non_positive', head.non_positive_conditional_mean_model, false]
  ]) {
    if (model.weights?.length !== count || !model.weights.every(finite) ||
        !finite(model.bias) || !finite(model.training_target_min_pct) ||
        !finite(model.training_target_max_pct) ||
        model.training_target_min_pct > model.training_target_max_pct ||
        (positive ? model.training_target_min_pct <= 0 : model.training_target_max_pct > 0)) {
      throw new TypeError('HURDLE_V2_CONDITIONAL_MEAN_INVALID:' + name + ':' + label);
    }
  }
  return head;
}
function policySnapshot(policy, name) {
  if (!policy || typeof policy !== 'object') {
    return {
      schema: 'RADARX_TCN_LSTM_SELECTIVE_EXECUTION_POLICY_V2',
      status: 'UNAVAILABLE',
      reason: 'POLICY_NOT_RETURNED_BY_INNER_SELECTION',
      source_partition: 'INNER_SELECTION_ONLY',
      threshold: null, percentile: null, lambda: null,
      passed: false, holdout_values_used: false
    };
  }
  return {
    ...policy,
    source_partition: 'INNER_SELECTION_ONLY',
    holdout_values_used: false,
    snapshot_name: name
  };
}
function headProbe(head, count, offset) {
  const features = Array.from({length: count}, (_, index) =>
    (index - count / 2 + offset) / 37);
  return predictHurdleExpectedNetReturn(features, head);
}
function manifestFrom(core, contentHash) {
  return {
    artifact_schema: core.artifact_schema,
    artifact_schema_version: core.artifact_schema_version,
    model_family: core.model_family,
    model_version: core.model_version,
    code_commit_sha: core.code_commit_sha,
    dataset_sha256: core.dataset_sha256,
    input_file_sha256: core.input_file_sha256,
    dataset_source_commit_sha: core.dataset_source_commit_sha,
    dataset_row_count: core.dataset_row_count,
    target_definition: core.target_definition,
    target_semantics: core.target_semantics,
    feature_schema_id: core.feature_schema_id,
    feature_shape: core.feature_shape,
    feature_order: core.feature_order,
    split_id: core.split_id,
    split_definition: core.split_definition,
    purge_definition: core.purge_definition,
    objective_id: core.objective_id,
    selection_objective_id: core.selection_objective_id,
    calibration_id: core.calibration_id,
    cost_model_id: core.cost_model_id,
    round_trip_cost_bps: core.round_trip_cost_bps,
    random_seed: core.random_seed,
    training_status: core.training_status,
    evaluation_status: core.evaluation_status,
    scientific_qualification_status: core.scientific_qualification_status,
    execution_qualification_status: core.execution_qualification_status,
    promotion_status: core.promotion_status,
    contextual_head_present: core.contextual_head_present,
    pooled_head_present: core.pooled_head_present,
    head_parameter_hashes: core.head_parameter_hashes,
    holdout_status: core.holdout_status,
    serialization_status: core.serialization_status,
    reload_status: core.reload_status,
    numerical_equivalence_status: core.numerical_equivalence_status,
    reproducibility_status: core.reproducibility_status,
    artifact_content_hash: contentHash
  };
}
function finalizeArtifact(core) {
  const contentHash = hashObject(core);
  const manifest = manifestFrom(core, contentHash);
  return {
    ...core,
    artifact_content_hash: contentHash,
    artifact_manifest: manifest,
    artifact_manifest_hash: hashObject(manifest),
    hash_status: 'HASH_VERIFIED',
    signature_status: 'HASH_VERIFIED_ONLY'
  };
}

export function createHurdleV2Artifact({
  fit, selection, datasetSha256, inputFileSha256, datasetSourceCommitSha,
  datasetRowCount, targetDefinition, targetSemantics, splitDefinition,
  codeCommitSha, roundTripCostBps = 30, randomSeed = 22429,
  innerQualified = false, objectiveId = HURDLE_V2_OBJECTIVE,
  selectionObjectiveId = null, orderedRankingDependency = null
} = {}) {
  if (!fit?.model || !selection || !/^[a-f0-9]{40}$/i.test(String(codeCommitSha || '')) ||
      String(datasetSha256).toLowerCase() !== HURDLE_V2_FIXED_DATASET_SHA256 ||
      String(inputFileSha256).toLowerCase() !== HURDLE_V2_FIXED_INPUT_SHA256 ||
      String(datasetSourceCommitSha).toLowerCase() !== HURDLE_V2_FIXED_SOURCE_COMMIT ||
      !Number.isInteger(datasetRowCount) || datasetRowCount < 1 ||
      !Number.isInteger(randomSeed) || randomSeed < 0 ||
      roundTripCostBps !== 30 ||
      typeof targetDefinition !== 'string' || !targetDefinition ||
      typeof targetSemantics !== 'string' || !targetSemantics ||
      !splitDefinition || !Number.isFinite(splitDefinition.purge_ms) ||
      splitDefinition.purge_ms <= 0 || !splitDefinition.counts) {
    throw new TypeError('HURDLE_V2_PROVENANCE_INVALID');
  }
  const fixedSplitCounts = validateFixedSplit(splitDefinition, datasetRowCount);
  if(orderedRankingDependency!==null&&(
    orderedRankingDependency?.artifact_schema!==
      'RADARX_TCN_LSTM_ORDERED_TEMPORAL_RANKER_ARTIFACT_V1'||
    !/^[a-f0-9]{64}$/.test(String(orderedRankingDependency?.artifact_content_hash??''))||
    !/^[a-f0-9]{64}$/.test(String(orderedRankingDependency?.artifact_manifest_hash??''))||
    orderedRankingDependency?.code_commit_sha!==String(codeCommitSha).toLowerCase()||
    orderedRankingDependency?.dataset_sha256!==String(datasetSha256).toLowerCase()||
    orderedRankingDependency?.input_file_sha256!==String(inputFileSha256).toLowerCase()||
    orderedRankingDependency?.representation!=='RAW_ORDERED_696_V1'||
    orderedRankingDependency?.feature_schema_id!==
      'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1'||
    orderedRankingDependency?.feature_count!==696||
    orderedRankingDependency?.validation_or_holdout_used!==false||
    orderedRankingDependency?.holdout_status!=='LOCKED'
  ))throw new TypeError('HURDLE_V2_ORDERED_RANKER_DEPENDENCY_INVALID');
  const model = fit.model;
  if (model.executionRegressionHeadsFitted !== true ||
      model.executionHeadInputFeatureSchema !== HURDLE_V2_CONTEXT_SCHEMA) {
    throw new TypeError('HURDLE_V2_EXECUTION_HEAD_SCHEMA_OR_FIT_FLAG_INVALID');
  }
  const heads = model.executionHurdleReturnHeads;
  const contextual = validateHead(heads?.LOGIT_CONTEXT_AUGMENTED,
    contextualFeatureNames, 'contextual');
  const pooled = validateHead(heads?.POOLED_ONLY, pooledFeatureNames, 'pooled');
  const normalizers = model.executionHeadNormalizers;
  validateNormalizer(normalizers?.LOGIT_CONTEXT_AUGMENTED?.net_return, 44, 'contextual.net_return');
  validateNormalizer(normalizers?.LOGIT_CONTEXT_AUGMENTED?.downside_risk, 44, 'contextual.downside_risk');
  validateNormalizer(normalizers?.POOLED_ONLY?.net_return, 8, 'pooled.net_return');
  validateNormalizer(normalizers?.POOLED_ONLY?.downside_risk, 8, 'pooled.downside_risk');
  for (const [key, weights, bias, count] of [
    ['contextual', model.executionReturnHeadWeights, model.executionReturnHeadBias, 44],
    ['pooled', model.executionReturnHeadPooledOnlyWeights, model.executionReturnHeadPooledOnlyBias, 8],
    ['contextual_risk', model.executionRiskHeadWeights, model.executionRiskHeadBias, 44],
    ['pooled_risk', model.executionRiskHeadPooledOnlyWeights, model.executionRiskHeadPooledOnlyBias, 8]
  ]) {
    if (!Array.isArray(weights) || weights.length !== count ||
        !weights.every(finite) || !finite(bias)) {
      throw new TypeError('HURDLE_V2_REQUIRED_REFERENCE_PARAMETERS_INVALID:' + key);
    }
  }
  const trainingSummary = fit.training?.execution_regression_heads ?? {};
  const contextPolicy = policySnapshot(fit.execution_risk_policy, 'contextual');
  const pooledPolicy = policySnapshot(fit.pooled_only_execution_risk_policy, 'pooled');
  const qualification = {
    status: innerQualified ? 'INNER_QUALIFIED_FOR_OUTER_REPLAY' : 'NOT_QUALIFIED',
    passed: innerQualified === true,
    selection_status: selection.status ?? 'UNKNOWN',
    selection_scoring: selection.selection_scoring ?? null,
    gate_results: selection.execution_head_context_ablation_qualification ?? null,
    context_ablation: selection.execution_head_context_ablation ??
      selection.execution_head_context_ablation_qualification?.result ?? null,
    selected_configuration: selection.selected_configuration ?? null,
    diagnostic_configuration: selection.diagnostic_configuration ?? null,
    ranking_head_selection_qualification:
      selection.ranking_head_selection_qualification ?? null,
    candidates: (selection.candidates ?? []).map(candidate => ({
      name: candidate.name ?? null,
      selection_brier: candidate.selection_brier ?? null,
      brier_improvement: candidate.brier_improvement ?? null,
      pairwise_ranking_improvement: candidate.pairwise_ranking_improvement ?? null,
      independent_ranking_signal_passed:
        candidate.independent_ranking_signal_passed === true,
      passed_inner_brier_margin: candidate.passed_inner_brier_margin === true,
      passed_inner_pairwise_ranking_gate:
        candidate.passed_inner_pairwise_ranking_gate === true,
      passed_inner_margin: candidate.passed_inner_margin === true,
      ranking_head_selection_qualified:
        candidate.ranking_head_selection_qualified === true,
      execution_head_context_ablation_passed:
        candidate.execution_head_context_ablation_passed === true,
      execution_risk_policy: candidate.execution_risk_policy ? {
        status: candidate.execution_risk_policy.status ?? null,
        passed: candidate.execution_risk_policy.passed === true
      } : null,
      return_selection_diagnostics: candidate.return_selection_diagnostics ? {
        status: candidate.return_selection_diagnostics.status ?? null,
        preliminary_return_screen_candidates:
          candidate.return_selection_diagnostics.preliminary_return_screen_candidates ?? null
      } : null,
      execution_head_context_ablation: candidate.execution_head_context_ablation ?? null
    })),
    baseline: selection.baseline ?? null,
    validation_or_holdout_used: false
  };
  const core = {
    artifact_schema: HURDLE_V2_ARTIFACT_SCHEMA,
    artifact_schema_version: 2,
    head_parameter_hashes: {
      contextual: hashObject(contextual),
      pooled: hashObject(pooled)
    },
    model_family: 'TCN_LSTM_HURDLE_EXPECTED_NET_RETURN',
    model_version: 'HURDLE_V2_FEATURE_CONDITIONAL_MEANS_V4_PURGED_PLATT_CALIBRATED_EXECUTION_POLICY',
    code_commit_sha: String(codeCommitSha).toLowerCase(),
    dataset_sha256: String(datasetSha256).toLowerCase(),
    input_file_sha256: String(inputFileSha256).toLowerCase(),
    dataset_source_commit_sha: String(datasetSourceCommitSha).toLowerCase(),
    dataset_row_count: datasetRowCount,
    target_definition: targetDefinition,
    target_semantics: targetSemantics,
    execution_target_definition: 'REALIZED_FIRST_TOUCH_RETURN_MINUS_ROUND_TRIP_COST_GT_ZERO',
    feature_schema_id: HURDLE_V2_FEATURE_SCHEMA,
    feature_shape: {base_temporal_sequence: [24, 29], contextual: [44], pooled: [8]},
    head_type: 'CONTEXTUAL_AND_POOLED_DUAL_HEAD_BUNDLE',
    feature_order: {
      contextual: contextualFeatureNames,
      pooled: pooledFeatureNames
    },
    feature_dtypes: {
      contextual: Array(44).fill('float64'),
      pooled: Array(8).fill('float64')
    },
    upstream_ordered_ranker_dependency: orderedRankingDependency,
    input_contract: {
      base_sequence: {closed_candles_only: true, interval: '15m', shape: [24, 29]},
      contextual: {
        feature_count: 44,
        feature_schema_id: HURDLE_V2_CONTEXT_SCHEMA,
        ranking_logit_is_probability: false,
        ranking_score_is_calibrated_probability: false,
        requires_external_temporal_logistic_logit: true,
        score_contexts: [
          'TCN_LOGISTIC_ANCHOR', 'PURGED_TEMPORAL_LOGISTIC_CV',
          'NEURAL_CLASSIFIER_RAW_LOGIT', 'TRAIN_ONLY_INDEPENDENT_RETURN_RANK_SCORE'
        ]
      },
      pooled: {
        feature_count: 8,
        feature_schema_id: HURDLE_V2_POOLED_SCHEMA,
        feature_source: 'TCN_LSTM_POOLED_LATENT_STATE_ONLY'
      },
      feature_order_is_semantically_significant: true,
      numeric_dtype: 'IEEE754_FLOAT64'
    },
    contextual_head_present: true,
    pooled_head_present: true,
    contextual_head_parameters: contextual,
    pooled_head_parameters: pooled,
    conditional_positive_return_parameters: {
      contextual: contextual.positive_conditional_mean_model,
      pooled: pooled.positive_conditional_mean_model
    },
    conditional_non_positive_return_parameters: {
      contextual: contextual.non_positive_conditional_mean_model,
      pooled: pooled.non_positive_conditional_mean_model
    },
    pointwise_return_reference_parameters: {
      contextual: {
        schema: 'RADARX_TCN_LSTM_EXECUTION_RETURN_HEAD_V1',
        weights: model.executionReturnHeadWeights,
        bias: model.executionReturnHeadBias,
        normalization: normalizers.LOGIT_CONTEXT_AUGMENTED.net_return
      },
      pooled: {
        schema: 'RADARX_TCN_LSTM_EXECUTION_RETURN_HEAD_V1',
        weights: model.executionReturnHeadPooledOnlyWeights,
        bias: model.executionReturnHeadPooledOnlyBias,
        normalization: normalizers.POOLED_ONLY.net_return
      }
    },
    risk_parameters: {
      adjustment_semantics: 'MAX(0,PREDICTED_DOWNSIDE_RISK_PCT)',
      ranking_adjustment_semantics:
        'FROZEN_WEIGHT_TIMES_TANH_INDEPENDENT_RAW_RETURN_RANK_SCORE_DIV_4; NEVER_ADDED_TO_CLASSIFIER_PROBABILITY',
      contextual: {
        schema: 'RADARX_TCN_LSTM_EXECUTION_RISK_HEAD_V1',
        head_type: 'CONTEXTUAL',
        weights: model.executionRiskHeadWeights,
        bias: model.executionRiskHeadBias,
        normalization: normalizers.LOGIT_CONTEXT_AUGMENTED.downside_risk,
        ranking_score_adjustment_weight:
          Number(contextPolicy.selected_ranking_score_adjustment_weight??0)
      },
      pooled: {
        schema: 'RADARX_TCN_LSTM_EXECUTION_RISK_HEAD_V1',
        head_type: 'POOLED',
        weights: model.executionRiskHeadPooledOnlyWeights,
        bias: model.executionRiskHeadPooledOnlyBias,
        normalization: normalizers.POOLED_ONLY.downside_risk,
        ranking_score_adjustment_weight:
          Number(pooledPolicy.selected_ranking_score_adjustment_weight??0)
      },
      risk_adjusted_expected_return_formula:
        'BASE_RISK_ADJUSTED_NET_RETURN = SELECTED_RETURN_ESTIMATOR_PREDICTION_PCT - FROZEN_RISK_PENALTY_WEIGHT * MAX(0,PREDICTED_DOWNSIDE_RISK_PCT); ENTRY_REQUIRES_BASE_RISK_ADJUSTED_NET_RETURN > 0; RANK_ADJUSTED_SELECTION_SCORE = BASE_RISK_ADJUSTED_NET_RETURN + FROZEN_RANK_ADJUSTMENT_WEIGHT * TANH(INDEPENDENT_RAW_RETURN_RANK_SCORE/4)',
      selected_estimator_semantics:
        'USE_FROZEN_POLICY_SELECTED_RETURN_ESTIMATOR; HURDLE_EXPECTED_VALUE_ONLY_WHEN_INNER_POLICY_SELECTED_IT'
    },
    normalization_parameters: {
      contextual: {feature_mean: contextual.feature_mean, feature_std: contextual.feature_std},
      pooled: {feature_mean: pooled.feature_mean, feature_std: pooled.feature_std},
      contextual_risk: normalizers.LOGIT_CONTEXT_AUGMENTED.downside_risk,
      pooled_risk: normalizers.POOLED_ONLY.downside_risk
    },
    abstention_parameters: {
      policy_selection_partition: 'INNER_SELECTION_ONLY',
      top_k_per_timestamp: 1,
      cross_sectional_selection_required: true,
      score_gate_rule: 'STRICTLY_POSITIVE_RISK_ADJUSTED_EXPECTED_NET_RETURN',
      contextual: contextPolicy,
      pooled: pooledPolicy,
      eligible_does_not_mean_trade: true
    },
    objective_id: objectiveId,
    selection_objective_id: selectionObjectiveId ?? selection.selection_scoring?.method ?? null,
    loss_definition: {
      probability: 'UNWEIGHTED_BINARY_LOGISTIC_NEGATIVE_LOG_LIKELIHOOD_WITH_L2_0_05',
      positive_conditional_return: 'CLASS_CONDITIONAL_HUBER_DELTA_1_L2_0_1',
      non_positive_conditional_return: 'CLASS_CONDITIONAL_HUBER_DELTA_1_L2_0_1',
      class_reweighting: false,
      probability_class_weights: {positive: 1, non_positive: 1}
    },
    calibration_definition:
      'HURDLE_RAW_SIGMOID_POSITIVE_NET_RETURN_PROBABILITY_USES_PURGED_EXECUTION_HEAD_PLATT_CALIBRATION_ON_A_LATER_BLOCK; THE CALIBRATION BLOCK IS DISJOINT FROM THE EARLIER HURDLE FIT BLOCK AND INNER SELECTION; THE FOUR_HOUR_LABEL_MATURITY_GAP_IS_ENFORCED; OUTER_VALIDATION_AND_HOLDOUT_ARE_NOT_USED',
    calibration_id: HURDLE_V2_CALIBRATION_ID,
    cost_model_id: 'FIXED_LINEAR_ROUND_TRIP_BPS_V1',
    round_trip_cost_bps: roundTripCostBps,
    cost_application: {
      training_target_includes_declared_round_trip_cost: true,
      applied_exactly_once: true,
      subtract_again_at_inference: false,
      predicted_return_semantics: 'ALREADY_NET_OF_DECLARED_ROUND_TRIP_COST'
    },
    random_seed: randomSeed,
    optimizer_randomness: 'DETERMINISTIC_FULL_BATCH_HURDLE_HEAD_FIT_NO_INTERNAL_RANDOM_DRAWS',
    split_id: splitDefinition.schema,
    split_definition: {
      schema: splitDefinition.schema,
      purge_ms: splitDefinition.purge_ms,
      counts: fixedSplitCounts,
      training_rows: fixedSplitCounts.train,
      outer_validation_rows: fixedSplitCounts.validation,
      untouched_holdout_rows: fixedSplitCounts.holdout,
      holdout_scored_rows: 0,
      utc_day_boundaries: splitDefinition.boundaries ?? null
    },
    purge_definition: {
      outer_purge_ms: splitDefinition.purge_ms,
      execution_head_fit_partition: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
      execution_head_training_rows: trainingSummary.training_rows ?? trainingSummary.trainingRows ?? null,
      model_training_rows: trainingSummary.model_training_rows ?? null,
      model_and_execution_head_identities_disjoint:
        trainingSummary.training_and_execution_head_identities_disjoint === true,
      representation_out_of_sample: trainingSummary.representation_out_of_sample === true,
      validation_or_holdout_used: false
    },
    training_provenance: {
      fit_boundary: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
      source_partition: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
      training_rows: trainingSummary.training_rows ?? null,
      model_training_rows: trainingSummary.model_training_rows ?? null,
      representation_out_of_sample: trainingSummary.representation_out_of_sample === true,
      training_and_execution_head_identities_disjoint:
        trainingSummary.training_and_execution_head_identities_disjoint === true,
      round_trip_cost_bps: roundTripCostBps,
      hurdle_return_head: {
        schema: 'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V2',
        conditional_mean_type: 'FEATURE_CONDITIONAL_HUBER_REGRESSION_V1',
        logit_context_augmented: {
          fitted: contextual.fitted, positive_rows: contextual.positive_rows,
          non_positive_rows: contextual.non_positive_rows,
          empirical_positive_rate: contextual.empirical_positive_rate,
          class_reweighting_used: contextual.class_reweighting_used
        },
        pooled_only: {
          fitted: pooled.fitted, positive_rows: pooled.positive_rows,
          non_positive_rows: pooled.non_positive_rows,
          empirical_positive_rate: pooled.empirical_positive_rate,
          class_reweighting_used: pooled.class_reweighting_used
        },
        probability_calibration:{
          contextual:{
            schema:contextual.probability_calibration.schema,
            fit_boundary:contextual.probability_calibration.fit_boundary,
            training_rows:contextual.probability_calibration.training_rows,
            calibration_rows:contextual.probability_calibration.calibration_rows,
            purged_rows:contextual.probability_calibration.purged_rows,
            horizon_ms:contextual.probability_calibration.horizon_ms,
            resolved_label_gap_ms:contextual.probability_calibration.resolved_label_gap_ms,
            chronology_valid:contextual.probability_calibration.chronology_valid
          },
          pooled:{
            schema:pooled.probability_calibration.schema,
            fit_boundary:pooled.probability_calibration.fit_boundary,
            training_rows:pooled.probability_calibration.training_rows,
            calibration_rows:pooled.probability_calibration.calibration_rows,
            purged_rows:pooled.probability_calibration.purged_rows,
            horizon_ms:pooled.probability_calibration.horizon_ms,
            resolved_label_gap_ms:pooled.probability_calibration.resolved_label_gap_ms,
            chronology_valid:pooled.probability_calibration.chronology_valid
          }
        },
        validation_or_holdout_used: false
      },
      validation_or_holdout_used: false
    },
    inner_qualification: qualification,
    training_status: 'TRAINED',
    evaluation_status: innerQualified ? 'INNER_QUALIFIED_FOR_OUTER_REPLAY' : 'NOT_QUALIFIED',
    scientific_qualification_status: innerQualified ? 'INNER_QUALIFIED_FOR_OUTER_REPLAY' : 'NOT_QUALIFIED',
    execution_qualification_status: innerQualified ? 'INNER_QUALIFIED_FOR_OUTER_REPLAY' : 'NOT_QUALIFIED',
    promotion_status: 'NOT_APPROVED',
    holdout_status: 'LOCKED',
    serialization_status: 'SERIALIZED',
    reload_status: 'RELOAD_VERIFIED',
    numerical_equivalence_status: 'DETERMINISTIC_PROBE_PARITY_VERIFIED',
    reproducibility_status: innerQualified
      ? 'HASH_AND_RELOAD_VERIFIED_INNER_QUALIFIED_NOT_PROMOTED'
      : 'HASH_AND_RELOAD_VERIFIED_NOT_SCIENTIFICALLY_QUALIFIED',
    paper_trading: true,
    real_order_execution: false
  };
  finiteTree(core);
  const artifact = finalizeArtifact(core);
  const verification = verifyHurdleV2Artifact(artifact);
  if (!verification.valid) throw new Error('HURDLE_V2_ARTIFACT_VERIFY_FAILED:' + verification.reason);
  return artifact;
}

export function predictHurdleV2ArtifactHead(features, head) {
  return predictHurdleExpectedNetReturn(features, head);
}
export function runHurdleV2ReloadProbes(artifact) {
  return {
    contextual: headProbe(artifact.contextual_head_parameters, 44, 0.5),
    pooled: headProbe(artifact.pooled_head_parameters, 8, 0.5)
  };
}
export function verifyHurdleV2Artifact(artifact) {
  const fail = reason => ({valid: false, reason});
  try {
    if (!artifact || artifact.artifact_schema !== HURDLE_V2_ARTIFACT_SCHEMA ||
        artifact.artifact_schema_version !== 2) return fail('ARTIFACT_SCHEMA_INVALID');
    if (!/^[a-f0-9]{40}$/i.test(String(artifact.code_commit_sha || '')) ||
        artifact.dataset_sha256 !== HURDLE_V2_FIXED_DATASET_SHA256 ||
        artifact.input_file_sha256 !== HURDLE_V2_FIXED_INPUT_SHA256 ||
        artifact.dataset_source_commit_sha !== HURDLE_V2_FIXED_SOURCE_COMMIT ||
        artifact.dataset_row_count !== HURDLE_V2_FIXED_DATASET_ROWS)
      return fail('PROVENANCE_INVALID');
    if (!artifact.contextual_head_present || !artifact.pooled_head_present)
      return fail('DUAL_HEAD_MISSING');
    if (artifact.input_contract?.contextual?.feature_schema_id !== HURDLE_V2_CONTEXT_SCHEMA)
      return fail('CONTEXT_SCHEMA_MISMATCH');
    const rankerDependency=artifact.upstream_ordered_ranker_dependency??null;
    if(rankerDependency!==null&&(
      rankerDependency?.artifact_schema!==
        'RADARX_TCN_LSTM_ORDERED_TEMPORAL_RANKER_ARTIFACT_V1'||
      !/^[a-f0-9]{64}$/.test(String(rankerDependency?.artifact_content_hash??''))||
      !/^[a-f0-9]{64}$/.test(String(rankerDependency?.artifact_manifest_hash??''))||
      rankerDependency?.code_commit_sha!==artifact.code_commit_sha||
      rankerDependency?.dataset_sha256!==artifact.dataset_sha256||
      rankerDependency?.input_file_sha256!==artifact.input_file_sha256||
      rankerDependency?.representation!=='RAW_ORDERED_696_V1'||
      rankerDependency?.feature_schema_id!==
        'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1'||
      rankerDependency?.feature_count!==696||
      rankerDependency?.validation_or_holdout_used!==false||
      rankerDependency?.holdout_status!=='LOCKED'
    ))return fail('ORDERED_RANKER_DEPENDENCY_INVALID');
    if (artifact.feature_order?.contextual?.length !== 44 ||
        artifact.feature_order?.pooled?.length !== 8 ||
        artifact.contextual_head_parameters?.weights?.length !== 44 ||
        artifact.pooled_head_parameters?.weights?.length !== 8)
      return fail('FEATURE_SHAPE_MISMATCH');
    const splitCounts = artifact.split_definition?.counts;
    let splitChronologyValid = false;
    try {
      validateFixedSplit({
        schema: artifact.split_definition?.schema,
        purge_ms: artifact.split_definition?.purge_ms,
        counts: splitCounts,
        boundaries: artifact.split_definition?.utc_day_boundaries
      }, artifact.dataset_row_count);
      splitChronologyValid = true;
    } catch {
      splitChronologyValid = false;
    }
    if (artifact.split_id !== HURDLE_V2_FIXED_SPLIT.schema ||
        artifact.split_definition?.schema !== HURDLE_V2_FIXED_SPLIT.schema ||
        artifact.split_definition?.purge_ms !== HURDLE_V2_FIXED_SPLIT.purge_ms ||
        splitCounts?.train !== HURDLE_V2_FIXED_SPLIT.counts.train ||
        splitCounts?.validation !== HURDLE_V2_FIXED_SPLIT.counts.validation ||
        splitCounts?.holdout !== HURDLE_V2_FIXED_SPLIT.counts.holdout ||
        splitCounts?.purged !== HURDLE_V2_FIXED_SPLIT.counts.purged ||
        splitCounts?.total !== HURDLE_V2_FIXED_SPLIT.counts.total ||
        !splitChronologyValid ||
        artifact.split_definition?.training_rows !== splitCounts?.train ||
        artifact.split_definition?.outer_validation_rows !== splitCounts?.validation ||
        artifact.split_definition?.untouched_holdout_rows !== splitCounts?.holdout ||
        artifact.split_definition?.holdout_scored_rows !== 0)
      return fail('SPLIT_PROVENANCE_INVALID');
    if (artifact.paper_trading !== true ||
        artifact.real_order_execution !== false ||
        artifact.promotion_status !== 'NOT_APPROVED')
      return fail('EXECUTION_POLICY_MISMATCH');
    const qualification = artifact.inner_qualification;
    const qualified = qualification?.passed === true;
    const expectedQualificationStatus = qualified
      ? 'INNER_QUALIFIED_FOR_OUTER_REPLAY' : 'NOT_QUALIFIED';
    if (typeof qualification?.passed !== 'boolean' ||
        qualification.status !== expectedQualificationStatus ||
        artifact.evaluation_status !== expectedQualificationStatus ||
        artifact.scientific_qualification_status !== expectedQualificationStatus ||
        artifact.execution_qualification_status !== expectedQualificationStatus ||
        artifact.training_status !== 'TRAINED')
      return fail('QUALIFICATION_STATUS_INCONSISTENT');
    if (qualified) {
      const selected = qualification.candidates?.find(candidate =>
        candidate.name === qualification.selected_configuration);
      if (qualification.selection_status !== 'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY' ||
          typeof qualification.selected_configuration !== 'string' ||
          qualification.selected_configuration.length === 0 ||
          qualification.diagnostic_configuration !== null ||
          qualification.gate_results?.qualified !== true ||
          qualification.context_ablation?.passed !== true ||
          qualification.ranking_head_selection_qualification?.qualified !== true ||
          selected?.passed_inner_margin !== true ||
          selected?.passed_inner_brier_margin !== true ||
          selected?.passed_inner_pairwise_ranking_gate !== true ||
          selected?.independent_ranking_signal_passed !== true ||
          selected?.ranking_head_selection_qualified !== true ||
          selected?.execution_head_context_ablation_passed !== true ||
          selected?.execution_risk_policy?.passed !== true ||
          selected?.execution_risk_policy?.status === 'UNAVAILABLE' ||
          selected?.return_selection_diagnostics?.status !== 'AVAILABLE' ||
          !(Number(selected?.return_selection_diagnostics?.preliminary_return_screen_candidates) > 0))
        return fail('QUALIFICATION_GATE_EVIDENCE_INCOMPLETE');
    }
    if (artifact.target_definition !== 'FIRST_TOUCH_PLUS_3_PCT_BEFORE_MINUS_2_PCT_WITHIN_4H_1M_V1' ||
        artifact.target_semantics !== 'UP_IF_PLUS_3_PCT_FIRST_BEFORE_MINUS_2_PCT_ELSE_NON_SUCCESS_WITHIN_4H_1M_V1')
      return fail('TARGET_PROVENANCE_MISMATCH');
    if (artifact.cost_model_id !== 'FIXED_LINEAR_ROUND_TRIP_BPS_V1' ||
        artifact.round_trip_cost_bps !== 30 ||
        artifact.cost_application?.applied_exactly_once !== true ||
        artifact.cost_application?.subtract_again_at_inference !== false)
      return fail('COST_PROVENANCE_MISMATCH');
    if (artifact.objective_id !== HURDLE_V2_OBJECTIVE ||
        artifact.calibration_id !== HURDLE_V2_CALIBRATION_ID) return fail('OBJECTIVE_OR_CALIBRATION_MISSING');
    for (const [name,value] of [
      ['contextual',artifact.risk_parameters?.contextual?.ranking_score_adjustment_weight],
      ['pooled',artifact.risk_parameters?.pooled?.ranking_score_adjustment_weight]
    ]) {
      if (!finite(value)||value<0||value>8)
        return fail('RANKING_SCORE_ADJUSTMENT_WEIGHT_INVALID:'+name);
    }
    if (artifact.risk_parameters?.ranking_adjustment_semantics !==
      'FROZEN_WEIGHT_TIMES_TANH_INDEPENDENT_RAW_RETURN_RANK_SCORE_DIV_4; NEVER_ADDED_TO_CLASSIFIER_PROBABILITY')
      return fail('RANKING_SCORE_ADJUSTMENT_SEMANTICS_INVALID');
    for (const [name,value] of [
      ['contextual',artifact.abstention_parameters?.contextual?.selected_minimum_positive_net_return_probability],
      ['pooled',artifact.abstention_parameters?.pooled?.selected_minimum_positive_net_return_probability]
    ]) {
      if (!finite(value)||value<0||value>1)
        return fail('POSITIVE_RETURN_PROBABILITY_THRESHOLD_INVALID:'+name);
    }
    if (artifact.holdout_status !== 'LOCKED' || artifact.split_definition?.holdout_scored_rows !== 0 ||
        artifact.inner_qualification?.validation_or_holdout_used !== false)
      return fail('HOLDOUT_LOCK_CONTRACT_INVALID');
    validateHead(artifact.contextual_head_parameters, contextualFeatureNames, 'contextual');
    validateHead(artifact.pooled_head_parameters, pooledFeatureNames, 'pooled');
    finiteTree(artifact);
    const core = {...artifact};
    delete core.artifact_content_hash;
    delete core.artifact_manifest;
    delete core.artifact_manifest_hash;
    delete core.hash_status;
    delete core.signature_status;
    const actualContentHash = hashObject(core);
    if (actualContentHash !== artifact.artifact_content_hash) return fail('CONTENT_HASH_MISMATCH');
    const expectedManifest = manifestFrom(core, actualContentHash);
    if (canonical(expectedManifest) !== canonical(artifact.artifact_manifest))
      return fail('MANIFEST_CONTENT_MISMATCH');
    if (hashObject(expectedManifest) !== artifact.artifact_manifest_hash)
      return fail('MANIFEST_HASH_MISMATCH');
    if (hashObject(artifact.contextual_head_parameters) !== artifact.head_parameter_hashes?.contextual ||
        hashObject(artifact.pooled_head_parameters) !== artifact.head_parameter_hashes?.pooled)
      return fail('HEAD_PARAMETER_HASH_MISMATCH');
    const probes = runHurdleV2ReloadProbes(artifact);
    if (![probes.contextual, probes.pooled].every(item =>
      finite(item.probability_positive_net_return) &&
      finite(item.expected_net_return_pct) &&
      finite(item.positive_net_return_mean_pct) &&
      finite(item.non_positive_net_return_mean_pct)))
      return fail('RELOAD_PROBE_NON_FINITE');
    return {valid: true, content_hash: actualContentHash,
      manifest_hash: artifact.artifact_manifest_hash, probes};
  } catch (error) {
    return fail('ARTIFACT_VALIDATION_ERROR:' + String(error?.message || error));
  }
}

export async function writeHurdleV2ArtifactAtomic(directory, artifact) {
  const before = verifyHurdleV2Artifact(artifact);
  if (!before.valid) throw new Error('HURDLE_V2_EXPORT_REJECTED:' + before.reason);
  await mkdir(directory, {recursive: true});
  const artifactPath = join(directory, 'HURDLE_V2.json');
  const manifestPath = join(directory, 'HURDLE_V2.manifest.json');
  const nonce = process.pid + '-' + artifact.artifact_content_hash.slice(0, 12);
  const artifactTemp = artifactPath + '.tmp-' + nonce;
  const manifestTemp = manifestPath + '.tmp-' + nonce;
  const bytes = JSON.stringify(artifact, null, 2) + '\n';
  const manifestBytes = JSON.stringify(artifact.artifact_manifest, null, 2) + '\n';
  await writeFile(artifactTemp, bytes, {flag: 'wx'});
  await writeFile(manifestTemp, manifestBytes, {flag: 'wx'});
  try {
    await rename(artifactTemp, artifactPath);
    await rename(manifestTemp, manifestPath);
  } catch (error) {
    throw new Error('HURDLE_V2_ATOMIC_PUBLISH_FAILED:' + String(error?.message || error));
  }
  const reloaded = JSON.parse(await readFile(artifactPath, 'utf8'));
  const after = verifyHurdleV2Artifact(reloaded);
  if (!after.valid) throw new Error('HURDLE_V2_RELOAD_FAILED:' + after.reason);
  if (canonical(runHurdleV2ReloadProbes(artifact)) !==
      canonical(runHurdleV2ReloadProbes(reloaded)))
    throw new Error('HURDLE_V2_RELOAD_NUMERICAL_PARITY_FAILED');
  const manifestOnDisk = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (canonical(manifestOnDisk) !== canonical(reloaded.artifact_manifest))
    throw new Error('HURDLE_V2_MANIFEST_RELOAD_MISMATCH');

  // Run the final verification in a fresh Node process, independent of the trainer's module state.
  const moduleUrl = new URL('./hurdle-v2-artifact-contract.mjs', import.meta.url).href;
  const childSource = [
    "import {readFile} from 'node:fs/promises';",
    "import {verifyHurdleV2Artifact,runHurdleV2ReloadProbes} from " + JSON.stringify(moduleUrl) + ";",
    "const artifact=JSON.parse(await readFile(process.argv[1],'utf8'));",
    "const result=verifyHurdleV2Artifact(artifact);",
    "if(!result.valid) throw new Error(result.reason);",
    "console.log(JSON.stringify({valid:true,content_hash:result.content_hash,manifest_hash:result.manifest_hash,probes:runHurdleV2ReloadProbes(artifact)}));"
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, artifactPath], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024
  });
  if (child.error || child.status !== 0) {
    throw new Error('HURDLE_V2_FRESH_PROCESS_RELOAD_FAILED:' +
      String(child.error?.message || child.stderr || child.status));
  }
  return {
    artifact_path: artifactPath,
    manifest_path: manifestPath,
    artifact_content_hash: artifact.artifact_content_hash,
    artifact_manifest_hash: artifact.artifact_manifest_hash,
    artifact_bytes: Buffer.byteLength(bytes),
    head_parameter_hashes: artifact.head_parameter_hashes,
    same_process_reload_verified: true,
    fresh_process_reload_verified: true,
    fresh_process_result: JSON.parse(child.stdout.trim())
  };
}
