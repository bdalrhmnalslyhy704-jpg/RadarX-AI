import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyDailyEarlyRiserCensusArtifact } from '../tools/verify-daily-early-riser-census-artifact.mjs';

const INTERVAL = 15 * 60 * 1000;
const TARGET = 'FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_24H_15M_V1';
const SOURCE = 'BINANCE_OFFICIAL_CLOSED_15M_SAFE_FIRST_TOUCH_HORIZONS_V1';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const makeSequence = () => Array.from({length:24},()=>Array(29).fill(0.1));
const makeTimes = at => Array.from({length:24},(_,index)=>at-(23-index)*INTERVAL);

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'radarx-census-audit-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const reportPath=join(directory,'census.json');
  const samplePath=join(directory,'samples.jsonl');
  const temporalPath=join(directory,'temporal.jsonl');
  const baseAt=1_780_000_000_000;
  const samples=[0,1].map(index=>{
    const at=baseAt+index*86400000;
    return {
      id:'sample-'+index,
      symbol:'TESTUSDT',
      at,
      liquidity_lane:'STANDARD_750K_PLUS',
      quote_volume_24h:900000,
      safe_opportunity_targets:{
        '24h':{
          plus_5_pct:{
            status:'RESOLVED',outcome:index?'DOWN':'UP',
            horizon_ms:86400000,target_definition:TARGET,outcome_source:SOURCE
          }
        }
      },
      feature_information_cutoff_at:at,
      observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE'
    };
  });
  const temporal=samples.map(sample=>({
    id:sample.id,symbol:sample.symbol,at:sample.at,
    temporal_sequence:makeSequence(),
    temporal_sequence_timestamps:makeTimes(sample.at)
  }));
  const sampleBytes=samples.map(row=>JSON.stringify(row)).join('\n')+'\n';
  const temporalBytes=temporal.map(row=>JSON.stringify(row)).join('\n')+'\n';
  await writeFile(samplePath,sampleBytes);
  await writeFile(temporalPath,temporalBytes);
  const report={
    status:'AUDITED_WITH_SURVIVOR_UNIVERSE_CAVEAT',
    data_quality:{
      all_sample_audits_ready:true,no_overlapping_daily_labels:true,
      feature_cutoff_violations:0,horizon_violations:0,symbols_failed:0,
      symbols_incomplete_archive:0,archive_coverage_after_first_available_pct:100
    },
    sample_file:{rows:samples.length,sha256:sha256(sampleBytes)},
    temporal_sample_file:{
      rows:temporal.length,sha256:sha256(temporalBytes),
      timestamps_verified:true,sequence_steps:24,sequence_channels:29,
      interval_ms:INTERVAL,invalid_declared_sequences:0
    }
  };
  await writeFile(reportPath,JSON.stringify(report));
  return {reportPath,samplePath,temporalPath,report,samples,temporal};
}

test('large-census verifier streams JSONL and cross-checks SHA, rows and temporal identity',async t=>{
  const data=await fixture(t);
  const result=await verifyDailyEarlyRiserCensusArtifact({
    reportPath:data.reportPath,samplePath:data.samplePath,temporalPath:data.temporalPath,
    expectedSourceCommit:'cde938585d9a44cdf751db1ceb23c3f211fa32a1',
    censusRunId:'test-run',minimumSamples:2
  });
  assert.equal(result.sample_rows,2);
  assert.equal(result.temporal_rows,2);
  assert.equal(result.temporal_timestamps_verified,true);
  assert.equal(result.bad_lane,0);
  assert.equal(result.bad_label,0);
  assert.equal(result.bad_cutoff,0);
  assert.equal(result.overlap,0);
  assert.equal(result.invalid_temporal,0);
  assert.equal(result.validation_mode,'STREAMING_JSONL_SHA_AND_ROW_IDENTITY_AUDIT_V1');
});

test('large-census verifier fails closed when raw sample bytes do not match report SHA',async t=>{
  const data=await fixture(t);
  await writeFile(data.samplePath,'{}\n');
  await assert.rejects(
    verifyDailyEarlyRiserCensusArtifact({
      reportPath:data.reportPath,samplePath:data.samplePath,temporalPath:data.temporalPath,
      minimumSamples:2
    }),
    /SAMPLE_SHA256_MISMATCH/
  );
});

test('large-census verifier rejects temporal sequence cadence gaps despite a valid sidecar SHA',async t=>{
  const data=await fixture(t);
  const malformed={...data.temporal[0]};
  malformed.temporal_sequence_timestamps[12]+=1;
  const rows=[malformed,data.temporal[1]];
  const bytes=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  await writeFile(data.temporalPath,bytes);
  data.report.temporal_sample_file.sha256=sha256(bytes);
  await writeFile(data.reportPath,JSON.stringify(data.report));
  await assert.rejects(
    verifyDailyEarlyRiserCensusArtifact({
      reportPath:data.reportPath,samplePath:data.samplePath,temporalPath:data.temporalPath,
      minimumSamples:2
    }),
    /TEMPORAL_SIDECAR_IDENTITY_OR_SEQUENCE_INVALID:1/
  );
});

test('large-census verifier rejects a temporal row detached from the sample cohort',async t=>{
  const data=await fixture(t);
  const detached={...data.temporal[0],id:'unknown-sample'};
  const bytes=[detached,data.temporal[1]].map(row=>JSON.stringify(row)).join('\n')+'\n';
  await writeFile(data.temporalPath,bytes);
  data.report.temporal_sample_file.sha256=sha256(bytes);
  await writeFile(data.reportPath,JSON.stringify(data.report));
  await assert.rejects(
    verifyDailyEarlyRiserCensusArtifact({
      reportPath:data.reportPath,samplePath:data.samplePath,temporalPath:data.temporalPath,
      minimumSamples:2
    }),
    /TEMPORAL_SIDECAR_IDENTITY_OR_SEQUENCE_INVALID:1/
  );
});
