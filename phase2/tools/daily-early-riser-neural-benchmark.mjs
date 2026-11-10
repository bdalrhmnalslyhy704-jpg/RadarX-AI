#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,stat,writeFile,rename,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import readline from 'node:readline';
import {
  DAILY_EARLY_RISER_TARGETS_PCT,
  benchmarkDailyEarlyRiserTarget
} from '../core/daily-early-riser-neural-benchmark.mjs';

const DEFAULT_INPUT='artifacts/daily-early-riser-samples.jsonl';
const DEFAULT_TEMPORAL_INPUT='artifacts/daily-early-riser-temporal-sequences.jsonl';
const DEFAULT_CENSUS_REPORT='artifacts/daily-early-riser-census.json';
const DEFAULT_OUTPUT='artifacts/daily-early-riser-neural-benchmark.json';

function parseArgs(argv){
  const values={};
  for(let index=0;index<argv.length;index++){
    if(!argv[index].startsWith('--'))continue;
    const key=argv[index].slice(2);
    const value=argv[index+1];
    if(value===undefined||String(value).startsWith('--'))values[key]='true';
    else{values[key]=value;index++;}
  }
  return values;
}
async function sha256File(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
function validTemporalSequence(sequence){
  return Array.isArray(sequence)&&sequence.length===24&&
    sequence.every(step=>Array.isArray(step)&&step.length===29&&
      step.every(value=>value!==null&&value!==undefined&&value!==''&&typeof value!=='boolean'&&
        Number.isFinite(Number(value))&&Math.abs(Number(value))<=4));
}
async function loadTemporalSequences(path,expectedSha256,expectedRows){
  const sourceStat=await stat(path);
  if(!sourceStat.isFile()||sourceStat.size<=0)throw new Error('TEMPORAL_SIDECAR_NOT_READABLE');
  const actualSha256=await sha256File(path);
  if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/i.test(expectedSha256)||
    actualSha256.toLowerCase()!==expectedSha256.toLowerCase())
    throw new Error('TEMPORAL_SIDECAR_SHA256_MISMATCH');
  const input=createReadStream(path,{encoding:'utf8'});
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  const byId=new Map();
  let linesRead=0,malformed=0,invalidShape=0,duplicateIds=0;
  for await(const line of lines){
    if(!line.trim())continue;
    linesRead++;
    let row;
    try{row=JSON.parse(line);}
    catch{malformed++;continue;}
    const id=String(row?.id||'').trim();
    const symbol=String(row?.symbol||'').trim().toUpperCase();
    const at=Number(row?.at);
    if(!id||!symbol||!Number.isFinite(at)||at<=0||!validTemporalSequence(row.temporal_sequence)){
      invalidShape++;continue;
    }
    if(byId.has(id)){duplicateIds++;continue;}
    byId.set(id,{symbol,at,sequence:row.temporal_sequence});
  }
  if(malformed||invalidShape||duplicateIds||byId.size!==Number(expectedRows))
    throw new Error('TEMPORAL_SIDECAR_ROW_AUDIT_FAILED:'+JSON.stringify({
      lines_read:linesRead,valid_rows:byId.size,expected_rows:expectedRows,
      malformed_lines:malformed,invalid_shape:invalidShape,duplicate_ids:duplicateIds
    }));
  return {by_id:byId,sha256:actualSha256,rows:byId.size,bytes:sourceStat.size,
    sequence_steps:24,sequence_channels:29};
}
async function loadTargetSamples(path,targetPct,temporalById){
  const key='plus_'+String(targetPct).replace('.','_')+'_pct';
  const input=createReadStream(path,{encoding:'utf8'});
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  const samples=[];
  let linesRead=0,malformed=0,missingTarget=0,temporalAttached=0,temporalMissing=0,temporalIdentityMismatch=0;
  for await(const line of lines){
    if(!line.trim())continue;
    linesRead++;
    let sample;
    try{sample=JSON.parse(line);}
    catch{malformed++;continue;}
    const label=sample?.targets?.[key];
    if(!label){missingTarget++;continue;}
    // Retain only one target and the pre-event feature object to bound memory.
    const temporalRow=temporalById.get(String(sample.id||''))||null;
    const identityMatches=temporalRow&&temporalRow.symbol===String(sample.symbol||'').trim().toUpperCase()&&
      temporalRow.at===Number(sample.at);
    const temporal_sequence=identityMatches?temporalRow.sequence:null;
    if(temporal_sequence)temporalAttached++;
    else{
      temporalMissing++;
      if(temporalRow&&!identityMatches)temporalIdentityMismatch++;
    }
    samples.push({
      id:sample.id,symbol:sample.symbol,at:sample.at,
      feature_information_cutoff_at:sample.feature_information_cutoff_at,
      observation_source:sample.observation_source,
      features:sample.features,
      temporal_sequence,
      targets:{[key]:label}
    });
  }
  return {samples,lines_read:linesRead,malformed_lines:malformed,missing_target_rows:missingTarget,
    temporal_attached:temporalAttached,temporal_missing:temporalMissing,
    temporal_identity_mismatch:temporalIdentityMismatch};
}
async function writeJsonAtomic(path,value){
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.tmp';
  await writeFile(temp,JSON.stringify(value,null,2)+'\n');
  await rename(temp,path);
}
function compactTarget(result){
  return {
    target_pct:result.target_pct,
    samples:result.samples,
    chronology:result.chronology,
    legacy_three_way_diagnostic:result.legacy_three_way_diagnostic,
    neural_network:result.neural_network,
    boosted_tree_model:result.boosted_tree_model,
    hybrid_model:result.hybrid_model,
    model_selection:result.model_selection,
    temporal_tcn_training_performed:result.temporal_tcn_training_performed,
    temporal_tcn_evaluation_performed:result.temporal_tcn_evaluation_performed,
    temporal_tcn_sequence_samples:result.temporal_tcn_sequence_samples,
    temporal_tcn_reason:result.temporal_tcn_reason,
    temporal_tcn:result.temporal_tcn,
    binary_up_event_contract:result.binary_up_event_contract,
    legacy_three_way_diagnostic:result.legacy_three_way_diagnostic,
    approval:result.approval
  };
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  const input=resolve(args.input||DEFAULT_INPUT);
  const temporalInput=resolve(args['temporal-input']||DEFAULT_TEMPORAL_INPUT);
  const censusReportPath=resolve(args['census-report']||DEFAULT_CENSUS_REPORT);
  const output=resolve(args.output||DEFAULT_OUTPUT);
  const started=Date.now();
  const report={
    schema:'RADARX_DAILY_EARLY_RISER_NEURAL_BENCHMARK_V1',
    status:'RUNNING',
    created_at:new Date().toISOString(),
    input_file:input,
    temporal_input_file:temporalInput,
    census_report_file:censusReportPath,
    temporal_sidecar_audit:null,
    target_results:{},
    methodology:{
      labels:'First passage to +5%, +10% or +15% before a -2% adverse barrier within 96 consecutive closed 15m candles',
      input_cutoff:'Features are accepted only when feature_information_cutoff_at equals the baseline candle close',
      chronology:'The existing nested chronological V5 selection, calibration, validation and holdout gates are retained; outcomes crossing boundaries are purged',
      feature_schema:'MLP/GBDT use the existing Cognitive V5 18-feature vector; the independent daily TCN uses the original 24x29 closed-candle temporal sequence, including 24h asset/BTC/relative-strength and liquidity context',
      models:['Residual Deep MLP V5 ensemble','Residual GBDT with frozen logistic anchor','Calibrated GBDT+MLP hybrid','Independent 24x29 daily TCN for each first-passage target'],
      comparison_margin_brier:0.003,
      tcn:'A separate daily TCN is evaluated from a SHA-256-verified 24x29 sidecar under target-specific 24h first-passage contracts; the production TCN default remains unchanged at 4h',
      holdout_status:'Historical diagnostic holdout only; a future forward Shadow period is still required'
    },
    production_touched:false,
    deployed:false,
    merged:false,
    paper_trading:true,
    real_order_execution:false,
    predictive_superiority_verified:false,
    profitability_verified:false
  };
  try{
    const sourceStat=await stat(input);
    if(!sourceStat.isFile()||sourceStat.size<=0)throw new Error('SAMPLE_FILE_NOT_READABLE');
    report.input_sha256=await sha256File(input);
    const censusReport=JSON.parse(await readFile(censusReportPath,'utf8'));
    if(censusReport?.status!=='AUDITED_WITH_SURVIVOR_UNIVERSE_CAVEAT'&&
      censusReport?.status!=='READY')throw new Error('CENSUS_REPORT_NOT_AUDITED');
    const expectedTemporal=censusReport?.temporal_sample_file;
    if(!expectedTemporal||!Number.isInteger(Number(expectedTemporal.rows))||Number(expectedTemporal.rows)<1)
      throw new Error('CENSUS_TEMPORAL_SIDECAR_METADATA_MISSING');
    const temporalSidecar=await loadTemporalSequences(temporalInput,
      expectedTemporal.sha256,Number(expectedTemporal.rows));
    report.temporal_sidecar_audit={
      rows:temporalSidecar.rows,bytes:temporalSidecar.bytes,sha256:temporalSidecar.sha256,
      sequence_steps:24,sequence_channels:29,verified_against_census_report:true
    };
    for(const target of DAILY_EARLY_RISER_TARGETS_PCT){
      const loaded=await loadTargetSamples(input,target,temporalSidecar.by_id);
      if(loaded.temporal_identity_mismatch!==0)
        throw new Error('TEMPORAL_SEQUENCE_SAMPLE_IDENTITY_MISMATCH:'+target);
      const result=benchmarkDailyEarlyRiserTarget(loaded.samples,target);
      report.target_results[String(target)+'_PCT']={
        ...compactTarget(result),
        source_rows:{
          lines_read:loaded.lines_read,
          malformed_lines:loaded.malformed_lines,
          missing_target_rows:loaded.missing_target_rows,
          temporal_attached:loaded.temporal_attached,
          temporal_missing:loaded.temporal_missing,
          temporal_identity_mismatch:loaded.temporal_identity_mismatch
        }
      };
      console.log('[DAILY_NEURAL_TARGET_COMPLETE] '+JSON.stringify({
        target_pct:target,
        samples:result.samples.accepted,
        training:result.chronology.training_samples,
        validation:result.chronology.validation_samples,
        holdout:result.chronology.holdout_samples,
        neural_status:result.neural_network.status,
        neural_validation_brier:result.neural_network.validation?.model_brier_score??null,
        neural_holdout_brier:result.neural_network.holdout?.model_brier_score??null,
        gbdt_status:result.boosted_tree_model.status,
        hybrid_status:result.hybrid_model.status,
        tcn_status:result.temporal_tcn.status,
        tcn_training_samples:result.temporal_tcn.training_samples,
        tcn_validation_brier:result.temporal_tcn.validation?.model_brier_score??null,
        tcn_holdout_brier:result.temporal_tcn.holdout?.model_brier_score??null,
        tcn_holdout_passed:result.temporal_tcn.holdout_comparison?.passed===true,
        selected_challenger:result.model_selection.validation_challenger,
        holdout_passed:result.model_selection.holdout_comparison?.passed===true
      }));
      await writeJsonAtomic(output,report);
    }
    report.status='COMPLETED_RESEARCH_ONLY';
    report.completed_at=new Date().toISOString();
    report.elapsed_ms=Date.now()-started;
    // Even a historical holdout win is not production approval. The model must
    // pass a later forward Shadow period and a separate net-of-costs replay.
    report.predictive_superiority_verified=false;
    report.profitability_verified=false;
    await writeJsonAtomic(output,report);
    console.log('[DAILY_NEURAL_BENCHMARK_COMPLETE] '+JSON.stringify({
      status:report.status,input_sha256:report.input_sha256,
      targets:Object.keys(report.target_results),elapsed_ms:report.elapsed_ms,
      production_touched:false,real_order_execution:false
    }));
  }catch(error){
    report.status='FAILED';
    report.fatal_error=String(error?.stack||error).slice(0,3000);
    report.failed_at=new Date().toISOString();
    report.elapsed_ms=Date.now()-started;
    await writeJsonAtomic(output,report).catch(()=>{});
    throw error;
  }
}
main().catch(error=>{
  console.error('[DAILY_NEURAL_BENCHMARK_FATAL] '+String(error?.stack||error));
  process.exitCode=1;
});
