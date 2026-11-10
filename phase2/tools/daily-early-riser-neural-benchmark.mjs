#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,stat,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import readline from 'node:readline';
import {
  DAILY_EARLY_RISER_TARGETS_PCT,
  benchmarkDailyEarlyRiserTarget
} from '../core/daily-early-riser-neural-benchmark.mjs';

const DEFAULT_INPUT='artifacts/daily-early-riser-samples.jsonl';
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
async function loadTargetSamples(path,targetPct){
  const key='plus_'+String(targetPct).replace('.','_')+'_pct';
  const input=createReadStream(path,{encoding:'utf8'});
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  const samples=[];
  let linesRead=0,malformed=0,missingTarget=0;
  for await(const line of lines){
    if(!line.trim())continue;
    linesRead++;
    let sample;
    try{sample=JSON.parse(line);}
    catch{malformed++;continue;}
    const label=sample?.targets?.[key];
    if(!label){missingTarget++;continue;}
    // Retain only one target and the pre-event feature object to bound memory.
    samples.push({
      id:sample.id,symbol:sample.symbol,at:sample.at,
      feature_information_cutoff_at:sample.feature_information_cutoff_at,
      observation_source:sample.observation_source,
      features:sample.features,
      targets:{[key]:label}
    });
  }
  return {samples,lines_read:linesRead,malformed_lines:malformed,missing_target_rows:missingTarget};
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
    logistic_reference:result.logistic_reference,
    neural_network:result.neural_network,
    boosted_tree_model:result.boosted_tree_model,
    hybrid_model:result.hybrid_model,
    model_selection:result.model_selection,
    approval:result.approval
  };
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  const input=resolve(args.input||DEFAULT_INPUT);
  const output=resolve(args.output||DEFAULT_OUTPUT);
  const started=Date.now();
  const report={
    schema:'RADARX_DAILY_EARLY_RISER_NEURAL_BENCHMARK_V1',
    status:'RUNNING',
    created_at:new Date().toISOString(),
    input_file:input,
    target_results:{},
    methodology:{
      labels:'First passage to +5%, +10% or +15% before a -2% adverse barrier within 96 consecutive closed 15m candles',
      input_cutoff:'Features are accepted only when feature_information_cutoff_at equals the baseline candle close',
      chronology:'The existing nested chronological V5 selection, calibration, validation and holdout gates are retained; outcomes crossing boundaries are purged',
      feature_schema:'Existing Cognitive V5 18-feature schema; no new daily-return feature channels are introduced in this first neural benchmark',
      models:['Residual Deep MLP V5 ensemble','Residual GBDT with frozen logistic anchor','Calibrated GBDT+MLP hybrid'],
      comparison_margin_brier:0.003,
      tcn:'Not trained in this step; current TCN remains bound to the distinct 4h target until a separately validated daily TCN contract is implemented',
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
    for(const target of DAILY_EARLY_RISER_TARGETS_PCT){
      const loaded=await loadTargetSamples(input,target);
      const result=benchmarkDailyEarlyRiserTarget(loaded.samples,target);
      report.target_results[String(target)+'_PCT']={
        ...compactTarget(result),
        source_rows:{
          lines_read:loaded.lines_read,
          malformed_lines:loaded.malformed_lines,
          missing_target_rows:loaded.missing_target_rows
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
