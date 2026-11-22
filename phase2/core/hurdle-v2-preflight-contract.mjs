import {
  HURDLE_V2_FIXED_DATASET_SHA256,
  HURDLE_V2_FIXED_INPUT_SHA256,
  verifyHurdleV2Artifact
} from './hurdle-v2-artifact-contract.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]+$/;
export const HURDLE_V2_MIN_EXPECTED_DATASET_SHA256_PREFIX_LENGTH = 48;

function normalizeHex(value, label) {
  if (typeof value !== 'string') {
    throw new TypeError(`HURDLE_PREFLIGHT_${label}_MUST_BE_STRING`);
  }
  const normalized = value.trim().toLowerCase();
  if (!HEX.test(normalized)) {
    throw new TypeError(`HURDLE_PREFLIGHT_${label}_MUST_BE_HEX`);
  }
  return normalized;
}

/**
 * Resolve the request's abbreviated dataset identifier against the full SHA
 * already pinned inside the hash-verified Hurdle V2 artifact. The returned
 * value is always the canonical 64-character SHA-256; the request prefix is
 * never passed downstream as a dataset digest.
 */
export function resolveExpectedHurdleDatasetSha256(
  suppliedSha256,
  artifactDatasetSha256 = HURDLE_V2_FIXED_DATASET_SHA256
) {
  const canonical = normalizeHex(artifactDatasetSha256, 'ARTIFACT_DATASET_SHA256');
  if (!SHA256.test(canonical)) {
    throw new TypeError('HURDLE_PREFLIGHT_ARTIFACT_DATASET_SHA256_INVALID');
  }

  const supplied = normalizeHex(suppliedSha256, 'EXPECTED_DATASET_SHA256');
  if (supplied.length < HURDLE_V2_MIN_EXPECTED_DATASET_SHA256_PREFIX_LENGTH ||
      supplied.length > 64) {
    throw new TypeError('HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_LENGTH_INVALID');
  }

  if (supplied.length === 64) {
    if (supplied !== canonical) {
      throw new Error('HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_MISMATCH');
    }
    return {
      sha256: canonical,
      supplied_sha256: supplied,
      resolution: 'FULL_SHA256_EXACT_MATCH'
    };
  }

  if (!canonical.startsWith(supplied)) {
    throw new Error('HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_PREFIX_MISMATCH');
  }

  return {
    sha256: canonical,
    supplied_sha256: supplied,
    resolution: 'VERIFIED_PREFIX_RESOLVED_TO_CANONICAL_SHA256'
  };
}

/**
 * Validate the byte-level input file digest. Unlike the request identity
 * resolver above, this function intentionally rejects prefixes: the actual
 * downloaded dataset file must match its full pinned SHA-256 before any rows
 * are parsed or passed to a model process.
 */
export function verifyHurdleV2DatasetInputFileSha256(
  actualFileSha256,
  expectedFileSha256 = HURDLE_V2_FIXED_INPUT_SHA256
) {
  const actual = normalizeHex(actualFileSha256, 'ACTUAL_INPUT_FILE_SHA256');
  const expected = normalizeHex(expectedFileSha256, 'EXPECTED_INPUT_FILE_SHA256');
  if (!SHA256.test(actual) || !SHA256.test(expected)) {
    throw new TypeError('HURDLE_PREFLIGHT_INPUT_FILE_SHA256_REQUIRES_FULL_DIGEST');
  }
  if (actual !== expected) {
    throw new Error('HURDLE_PREFLIGHT_INPUT_FILE_SHA256_MISMATCH');
  }
  return actual;
}

/**
 * Cheap metadata-only preflight. It verifies the existing artifact contract,
 * resolves a long request prefix to the pinned full dataset SHA, and confirms
 * the locked/safety states. It does not open dataset rows, fit, replay, or
 * evaluate the model. Dataset bytes still require the full input-file SHA check
 * above before any later authorized replay can consume them.
 */
export function verifyHurdleV2PreflightContract(artifact, suppliedDatasetSha256) {
  const checked = verifyHurdleV2Artifact(artifact);
  if (!checked.valid) {
    throw new Error(`HURDLE_PREFLIGHT_ARTIFACT_INVALID:${checked.reason}`);
  }

  const datasetIdentity = resolveExpectedHurdleDatasetSha256(
    suppliedDatasetSha256,
    artifact.dataset_sha256
  );
  if (artifact.dataset_row_count !== 32300 ||
      artifact.round_trip_cost_bps !== 30 ||
      artifact.holdout_status !== 'LOCKED' ||
      artifact.paper_trading !== true ||
      artifact.real_order_execution !== false ||
      artifact.scientific_qualification_status !== 'NOT_QUALIFIED' ||
      artifact.execution_qualification_status !== 'NOT_QUALIFIED' ||
      artifact.promotion_status !== 'NOT_APPROVED') {
    throw new Error('HURDLE_PREFLIGHT_FIXED_IDENTITY_OR_SAFETY_CONTRACT_INVALID');
  }

  return {
    status: 'PREFLIGHT_METADATA_CONTRACT_VERIFIED',
    artifact_content_hash: artifact.artifact_content_hash,
    artifact_manifest_hash: artifact.artifact_manifest_hash,
    code_commit_sha: artifact.code_commit_sha,
    dataset_sha256: datasetIdentity.sha256,
    dataset_sha_resolution: datasetIdentity.resolution,
    dataset_row_count: artifact.dataset_row_count,
    target_definition: artifact.target_definition,
    target_semantics: artifact.target_semantics,
    feature_schema_id: artifact.feature_schema_id,
    feature_shape: artifact.feature_shape,
    split_id: artifact.split_id,
    purge_definition: artifact.purge_definition,
    objective_id: artifact.objective_id,
    calibration_id: artifact.calibration_id,
    cost_model_id: artifact.cost_model_id,
    round_trip_cost_bps: artifact.round_trip_cost_bps,
    random_seed: artifact.random_seed,
    contextual_head_present: artifact.contextual_head_present,
    pooled_head_present: artifact.pooled_head_present,
    holdout_status: artifact.holdout_status,
    dataset_bytes_verified: false,
    training_started: false,
    replay_started: false,
    paper_trading: artifact.paper_trading,
    real_order_execution: artifact.real_order_execution,
    scientific_qualification_status: artifact.scientific_qualification_status,
    execution_qualification_status: artifact.execution_qualification_status,
    promotion_status: artifact.promotion_status
  };
}
