import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {
  HURDLE_V2_FIXED_DATASET_SHA256,
  HURDLE_V2_FIXED_INPUT_SHA256
} from '../core/hurdle-v2-artifact-contract.mjs';
import {
  HURDLE_V2_MIN_EXPECTED_DATASET_SHA256_PREFIX_LENGTH,
  resolveExpectedHurdleDatasetSha256,
  verifyHurdleV2DatasetInputFileSha256,
  verifyHurdleV2PreflightContract
} from '../core/hurdle-v2-preflight-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(here, '../../artifacts/neural-closure-replay/model-artifacts/HURDLE_V2.json');
const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));

test('the 52-character request identifier resolves only to the artifact-pinned full dataset SHA', () => {
  const supplied = 'f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d2';
  assert.equal(supplied.length, 52);
  const result = resolveExpectedHurdleDatasetSha256(supplied, HURDLE_V2_FIXED_DATASET_SHA256);
  assert.equal(result.sha256, HURDLE_V2_FIXED_DATASET_SHA256);
  assert.equal(result.resolution, 'VERIFIED_PREFIX_RESOLVED_TO_CANONICAL_SHA256');
});

test('a full dataset SHA must match exactly and is never silently replaced', () => {
  const result = resolveExpectedHurdleDatasetSha256(
    HURDLE_V2_FIXED_DATASET_SHA256,
    HURDLE_V2_FIXED_DATASET_SHA256
  );
  assert.equal(result.sha256, HURDLE_V2_FIXED_DATASET_SHA256);
  assert.equal(result.resolution, 'FULL_SHA256_EXACT_MATCH');
  assert.throws(() => resolveExpectedHurdleDatasetSha256('0'.repeat(64)), {
    message: 'HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_MISMATCH'
  });
});

test('short, malformed and nonmatching dataset identifiers fail closed', () => {
  assert.equal(HURDLE_V2_MIN_EXPECTED_DATASET_SHA256_PREFIX_LENGTH, 48);
  assert.throws(() => resolveExpectedHurdleDatasetSha256('f9923205db04'), {
    message: 'HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_LENGTH_INVALID'
  });
  assert.throws(() => resolveExpectedHurdleDatasetSha256('z'.repeat(53)), {
    message: 'HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_MUST_BE_HEX'
  });
  assert.throws(() => resolveExpectedHurdleDatasetSha256('0'.repeat(53)), {
    message: 'HURDLE_PREFLIGHT_EXPECTED_DATASET_SHA256_PREFIX_MISMATCH'
  });
});

test('actual dataset input bytes require a full exact 64-character file digest', () => {
  assert.equal(
    verifyHurdleV2DatasetInputFileSha256(HURDLE_V2_FIXED_INPUT_SHA256),
    HURDLE_V2_FIXED_INPUT_SHA256
  );
  assert.throws(() => verifyHurdleV2DatasetInputFileSha256(HURDLE_V2_FIXED_INPUT_SHA256.slice(0, 53)), {
    message: 'HURDLE_PREFLIGHT_INPUT_FILE_SHA256_REQUIRES_FULL_DIGEST'
  });
  assert.throws(() => verifyHurdleV2DatasetInputFileSha256('0'.repeat(64)), {
    message: 'HURDLE_PREFLIGHT_INPUT_FILE_SHA256_MISMATCH'
  });
});

test('metadata preflight verifies the immutable artifact and safety contracts without opening dataset rows', () => {
  const result = verifyHurdleV2PreflightContract(
    artifact,
    'f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d2'
  );
  assert.equal(result.status, 'PREFLIGHT_METADATA_CONTRACT_VERIFIED');
  assert.equal(result.dataset_sha256, HURDLE_V2_FIXED_DATASET_SHA256);
  assert.equal(result.dataset_row_count, 32300);
  assert.equal(result.dataset_bytes_verified, false);
  assert.equal(result.holdout_status, 'LOCKED');
  assert.equal(result.training_started, false);
  assert.equal(result.replay_started, false);
  assert.equal(result.paper_trading, true);
  assert.equal(result.real_order_execution, false);
  assert.equal(result.scientific_qualification_status, 'NOT_QUALIFIED');
  assert.equal(result.execution_qualification_status, 'NOT_QUALIFIED');
  assert.equal(result.promotion_status, 'NOT_APPROVED');
});

test('metadata preflight rejects an altered artifact or an unlocked holdout state', () => {
  const badHash = {...artifact, artifact_content_hash: '0'.repeat(64)};
  assert.throws(() => verifyHurdleV2PreflightContract(badHash, HURDLE_V2_FIXED_DATASET_SHA256), {
    message: /^HURDLE_PREFLIGHT_ARTIFACT_INVALID:/
  });
  const unlocked = {...artifact, holdout_status: 'OPEN'};
  assert.throws(() => verifyHurdleV2PreflightContract(unlocked, HURDLE_V2_FIXED_DATASET_SHA256), {
    message: /^HURDLE_PREFLIGHT_ARTIFACT_INVALID:/
  });
});

test('cheap preflight CI workflow contains no training, replay, validation or deployment invocation', async () => {
  const workflowPath = join(here, '../../.github/workflows/hurdle-v2-artifact-contract.yml');
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /node --test phase2\/tests\/hurdle-v2-preflight-contract\.test\.mjs/);
  assert.match(workflow, /node --test phase2\/tests\/hurdle-v2-artifact\.test\.mjs/);
  assert.doesNotMatch(workflow, /train-neural-closure-models\.mjs|neural-closure-fixed-cohort-replay|workflow_dispatch|actions\/download-artifact|actions\/deploy/);
});
