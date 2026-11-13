#!/usr/bin/env node
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {
  DENSE_GENERALIZATION_SCHEMA,
  validateAndPrepareDense24hRows,
  splitDense24hChronologically,
  runDenseGeneralizationBenchmark
} from '../core/dense-generalization-projection.mjs';

function parseArgs(argv) {
  const result={};
  for(let i=0;i<argv.length;i++){
    if(!argv[i].startsWith('--'))throw new Error('UNEXPECTED_ARGUMENT:'+argv[i]);
    const key=argv[i].slice(2);
    const value=argv[i+1];
    if(value===undefined||value.startsWith('--'))throw new Error('MISSING_ARGUMENT_VALUE:'+key);
    result[key]=value;i++;
  }
  return result;
}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function parseJsonl(buffer){
  const lines=buffer.toString('utf8').split(/\r?\n/);
  const rows=[];
  for(let i=0;i<lines.length;i++){
    if(!lines[i].trim())continue;
    try{rows.push(JSON.parse(lines[i]));}
    catch(error){throw new Error('SAMPLE_JSONL_PARSE_ERROR_LINE_'+(i+1)+':'+error.message);}
  }
  return rows;
}
function printTable(report){
  const rows=[
    ['Inner selection',report.inner_selection],
    ['External validation',report.validation],
    ['Final holdout',report.holdout]
  ];
  const pad=(value,width)=>String(value).padEnd(width);
  console.log('');
  console.log(pad('Split',22)+pad('N',9)+pad('Projection Brier',20)+pad('Logistic Brier',18)+pad('Improvement',15)+'Gate');
  console.log('-'.repeat(93));
  for(const [name,result] of rows){
    const n=result.rows??result.samples??'—';
    const model=result.model_brier??result.model_brier_score??result.model_score??'—';
    const baseline=result.logistic_brier??result.logistic_brier_score??result.logistic_score??'—';
    const improvement=result.brier_improvement??result.improvement??'—';
    const gate=result.passed===true?'PASS':'FAIL';
    console.log(pad(name,22)+pad(n,9)+pad(model,20)+pad(baseline,18)+pad(improvement,15)+gate);
  }
  console.log('');
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  const samplesPath=resolve(args.samples||'artifacts/daily-early-riser-samples.jsonl');
  const censusPath=resolve(args['census-report']||'artifacts/daily-early-riser-census.json');
  const outputPath=resolve(args.output||'artifacts/dense-24h-generalization-report.json');
  const censusRunId=String(args['census-run-id']||process.env.DENSE_CENSUS_RUN_ID||'');
  const censusSourceCommit=String(args['census-source-commit']||process.env.DENSE_CENSUS_SOURCE_COMMIT||'');
  if(!/^\d+$/.test(censusRunId))throw new Error('EXACT_CENSUS_RUN_ID_REQUIRED');
  if(!/^[a-f0-9]{40}$/i.test(censusSourceCommit))throw new Error('EXACT_CENSUS_SOURCE_COMMIT_REQUIRED');

  const [sampleBytes,censusBytes]=await Promise.all([readFile(samplesPath),readFile(censusPath)]);
  const [sampleStat,censusStat]=await Promise.all([stat(samplesPath),stat(censusPath)]);
  if(!sampleStat.isFile()||!sampleStat.size||!censusStat.isFile()||!censusStat.size)
    throw new Error('DENSE24_SOURCE_FILE_EMPTY');
  const sampleSha=sha256(sampleBytes);
  const censusSha=sha256(censusBytes);
  const censusReport=JSON.parse(censusBytes.toString('utf8'));
  const rawSamples=parseJsonl(sampleBytes);
  if(rawSamples.length!==Number(censusReport.sample_file?.rows))
    throw new Error('DENSE24_ROW_COUNT_DIFFERS_FROM_CENSUS_MANIFEST');
  if(sampleSha.toLowerCase()!==String(censusReport.sample_file?.sha256||'').toLowerCase())
    throw new Error('DENSE24_RAW_SAMPLE_SHA_DIFFERS_FROM_CENSUS_MANIFEST');

  const prepared=validateAndPrepareDense24hRows(rawSamples,censusReport,sampleSha);
  const split=splitDense24hChronologically(prepared.rows);
  const benchmark=runDenseGeneralizationBenchmark(prepared.rows,split,{bootstrapIterations:400});
  const report={
    schema:'RADARX_DENSE_24H_GENERALIZATION_EVALUATION_V1',
    model_schema:DENSE_GENERALIZATION_SCHEMA,
    created_at:new Date().toISOString(),
    research_only:true,
    census:{
      run_id:Number(censusRunId),
      source_commit:censusSourceCommit,
      report_sha256:censusSha,
      samples_sha256:sampleSha,
      sample_identity_sha256:prepared.identity_sha256,
      sample_rows:prepared.raw_rows,
      resolved_training_rows:prepared.resolved_training_rows,
      audited_ambiguous_rows:prepared.ambiguous_rows,
      under_floor_rows:prepared.under_floor_rows,
      sample_bytes:sampleStat.size
    },
    cohort:{
      market:'BINANCE_SPOT_USDT',
      horizon_hours:24,
      anchor_stride_hours:24,
      baseline_candles:96,
      candle_interval:'15m CLOSED',
      minimum_quote_volume_usdt:750000,
      liquidity_lane:'STANDARD_750K_PLUS',
      label:'FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_24H_15M_V1',
      outcome_source:'BINANCE_OFFICIAL_CLOSED_15M_SAFE_FIRST_TOUCH_HORIZONS_V1',
      feature_cutoff:'BASELINE_CLOSED_15M_CANDLE_ONLY',
      ambiguous_policy:'AUDIT_AND_EXCLUDE_FROM_SUPERVISED_TRAINING'
    },
    split:{
      purged_rows:split.purged_rows,
      boundaries:split.boundaries,
      ranges:split.ranges,
      leakage_checks:{
        label_maturity_before_next_partition:true,
        same_symbol_daily_anchor_overlap:false,
        standard_lane_only:true,
        feature_fit_train_only:true,
        selection_used_for_model_choice_only:true,
        validation_used_for_acceptance_only:true,
        holdout_used_for_final_acceptance_only:true
      }
    },
    data_audit:{
      raw_file_sha256_verified:true,
      census_manifest_sha256_verified:true,
      exact_row_count_verified:true,
      identities_sha256:prepared.identity_sha256,
      ambiguous_rows:prepared.ambiguous_rows,
      accepted_rows:prepared.resolved_training_rows,
      rejection_reasons:prepared.rejection_reasons
    },
    benchmark,
    deployment_gate:{
      passed:benchmark.gate.predictive_superiority_verified===true,
      production_merge_allowed:false,
      deployment_allowed:false,
      real_order_execution_allowed:false,
      paper_trading_only:true,
      note:'Research result only. Even a historical Brier win is not proof of profitability or live safety.'
    }
  };
  await mkdir(dirname(outputPath),{recursive:true});
  await writeFile(outputPath,JSON.stringify(report,null,2)+'\n','utf8');
  printTable({
    inner_selection:{...benchmark.inner_selection,rows:split.selection.length},
    validation:benchmark.validation,
    holdout:benchmark.holdout
  });
  console.log(JSON.stringify({
    status:benchmark.status,
    predictive_superiority_verified:benchmark.gate.predictive_superiority_verified,
    raw_sample_sha256:sampleSha,
    sample_identity_sha256:prepared.identity_sha256,
    census_run_id:Number(censusRunId),
    census_source_commit:censusSourceCommit,
    output:outputPath,
    production_touched:false,deployed:false,merged:false,real_order_execution:false
  },null,2));
  if(benchmark.gate.predictive_superiority_verified!==true){
    process.exitCode=2;
  }
}
main().catch(error=>{
  console.error('[DENSE_24H_GENERALIZATION_FATAL]',error?.stack||String(error));
  process.exitCode=1;
});
