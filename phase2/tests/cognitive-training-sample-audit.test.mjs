import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPORAL_TARGET_DEFINITION
} from '../core/temporal-neural-brain.mjs';
import {
  auditCognitiveTrainingSamples,
  buildCognitiveTrainingRejectionJsonl,
  buildCognitiveTrainingTensorJsonl,
  cognitiveTrainingSampleRejectionReasons,
  isValidCognitiveTrainingSample
} from '../core/cognitive-training-sample-audit.mjs';

const FOUR_HOURS=4*60*60*1000;

function validSample(overrides={}){
  const at=1_700_000_000_000;
  return {
    id:'VALID-001',
    symbol:'BTCUSDT',
    at,
    resolved_at:at+FOUR_HOURS,
    horizon_ms:FOUR_HOURS,
    training_eligible:true,
    historical_baseline:true,
    target_definition:TEMPORAL_TARGET_DEFINITION,
    outcome_source:'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
    outcome:'UP',
    first_passage:{path_resolution:'15M',outcome:'UP'},
    temporal_sequence:Array.from({length:24},()=>Array(29).fill(0)),
    ...overrides
  };
}

test('a complete first-passage sample with a finite 24x29 tensor is accepted',()=>{
  const row=validSample();
  assert.deepEqual(cognitiveTrainingSampleRejectionReasons(row),[]);
  assert.equal(isValidCognitiveTrainingSample(row),true);
  assert.equal(isValidCognitiveTrainingSample(validSample({id:''})),true,
    'the original validity predicate does not include identity; the audit handles identity exclusions separately');
});

test('audit preserves the original numeric-coercion rule for resolved horizon',()=>{
  const row=validSample({at:null,resolved_at:FOUR_HOURS});
  assert.equal(isValidCognitiveTrainingSample(row),true,
    'the audit must preserve the original Number(null) === 0 behavior');
  const audit=auditCognitiveTrainingSamples([row]);
  assert.equal(audit.valid_samples,1);
  assert.equal(audit.invalid_samples,0);
});

test('sample rejection audit identifies target, source, outcome and timestamp failures independently',()=>{
  const row=validSample({
    training_eligible:false,
    historical_baseline:false,
    target_definition:'WRONG_TARGET',
    outcome_source:'LIVE_TICKER_PRICE',
    outcome:'UNKNOWN',
    first_passage:{path_resolution:'1M',outcome:'DOWN'},
    at:null,
    resolved_at:1,
    horizon_ms:60_000
  });
  const reasons=cognitiveTrainingSampleRejectionReasons(row);
  for(const code of [
    'TRAINING_NOT_ELIGIBLE',
    'HISTORICAL_BASELINE_NOT_CONFIRMED',
    'TARGET_DEFINITION_MISMATCH',
    'OUTCOME_SOURCE_NOT_OFFICIAL_HISTORICAL_FIRST_PASSAGE',
    'OUTCOME_NOT_RESOLVED',
    'FIRST_PASSAGE_RESOLUTION_NOT_15M',
    'FIRST_PASSAGE_OUTCOME_MISMATCH',
    'SAMPLE_TIMESTAMPS_INVALID',
    'DECLARED_HORIZON_NOT_EXACTLY_4H'
  ])assert.ok(reasons.includes(code),'missing rejection code '+code);
});

test('tensor audit distinguishes missing tensors, bad step count, wrong channels and non-finite values',()=>{
  assert.ok(cognitiveTrainingSampleRejectionReasons(validSample({temporal_sequence:null}))
    .includes('TEMPORAL_SEQUENCE_MISSING'));
  assert.ok(cognitiveTrainingSampleRejectionReasons(validSample({temporal_sequence:[[0]]}))
    .includes('TEMPORAL_SEQUENCE_STEP_COUNT_NOT_24'));
  const wrongChannels=Array.from({length:24},()=>Array(28).fill(0));
  assert.ok(cognitiveTrainingSampleRejectionReasons(validSample({temporal_sequence:wrongChannels}))
    .includes('TEMPORAL_SEQUENCE_CHANNEL_COUNT_NOT_29'));
  const nonFinite=Array.from({length:24},()=>Array(29).fill(0));
  nonFinite[3][4]=NaN;
  assert.ok(cognitiveTrainingSampleRejectionReasons(validSample({temporal_sequence:nonFinite}))
    .includes('TEMPORAL_SEQUENCE_CONTAINS_NON_FINITE_VALUE'));
  const nonArray=Array.from({length:24},()=>Array(29).fill(0));
  nonArray[8]=null;
  assert.ok(cognitiveTrainingSampleRejectionReasons(validSample({temporal_sequence:nonArray}))
    .includes('TEMPORAL_SEQUENCE_STEP_NOT_ARRAY'));
});

test('audit separates valid, invalid, missing-id and duplicate-id rows without changing acceptance rules',()=>{
  const good=validSample();
  const bad=validSample({id:'BAD-TENSOR',symbol:'ETHUSDT',temporal_sequence:null});
  const duplicate=validSample({id:good.id,symbol:'DUPUSDT'});
  const missingId=validSample({id:'',symbol:'NOIDUSDT'});
  const audit=auditCognitiveTrainingSamples([good,bad,duplicate,missingId]);
  assert.equal(audit.observed_rows,4);
  assert.equal(audit.valid_samples,1);
  assert.equal(audit.invalid_samples,1,
    'missing and duplicate identifiers remain identity exclusions, not invalid feature/label samples');
  assert.equal(audit.duplicate_ids,2,
    'the historical audit counts missing and duplicate IDs in the identity-exclusion total');
  assert.equal(audit.missing_ids,1);
  assert.equal(audit.valid_temporal_sequences,1);
  assert.equal(audit.rejection_reason_counts.TEMPORAL_SEQUENCE_MISSING,1);
  assert.equal(audit.rejection_reason_counts.DUPLICATE_SAMPLE_ID,1);
  assert.equal(audit.rejection_reason_counts.SAMPLE_ID_MISSING,1);
  assert.equal(audit.rejected_samples_by_symbol.ETHUSDT.sample_count,1);
  assert.equal(audit.rejected_samples_by_symbol.NOIDUSDT.sample_count,1);
  assert.equal(audit.rejected_samples_by_symbol.DUPUSDT.sample_count,1);
});

test('rejection JSONL records sample identities and reasons but never serializes tensor payloads',()=>{
  const audit=auditCognitiveTrainingSamples([
    validSample({id:'BAD-JSONL',temporal_sequence:null})
  ]);
  const jsonl=buildCognitiveTrainingRejectionJsonl(audit);
  const rows=jsonl.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,'BAD-JSONL');
  assert.deepEqual(rows[0].reasons,['TEMPORAL_SEQUENCE_MISSING']);
  assert.equal(Object.hasOwn(rows[0],'temporal_sequence'),false);
});

test('tensor sidecar preserves every value in the full 24x29 sequence with stable identity',()=>{
  const sequence=Array.from({length:24},(_,step)=>
    Array.from({length:29},(_,channel)=>Number((step*0.1+channel*0.001).toFixed(6))));
  const row=validSample({id:'FULL-TENSOR-001',symbol:'ETHUSDT',temporal_sequence:sequence});
  const jsonl=buildCognitiveTrainingTensorJsonl([row]);
  const parsed=jsonl.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(parsed.length,1);
  assert.equal(parsed[0].id,row.id);
  assert.equal(parsed[0].symbol,row.symbol);
  assert.equal(parsed[0].sequence_steps,24);
  assert.equal(parsed[0].sequence_channels,29);
  assert.deepEqual(parsed[0].temporal_sequence,sequence);
  assert.equal(parsed[0].temporal_sequence_sha256.length,64);
  assert.equal(buildCognitiveTrainingTensorJsonl([validSample({temporal_sequence:null})]),'',
    'invalid tensor rows are never written into the replay sidecar');
});
