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
  let temporalFlaggedAvailable=0,temporalFlaggedMissing=0,temporalUnexpected=0;
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
    const declaredAvailable=sample.temporal_sequence_available===true;
    if(declaredAvailable)temporalFlaggedAvailable++;
    const identityMatches=temporalRow&&temporalRow.symbol===String(sample.symbol||'').trim().toUpperCase()&&
      temporalRow.at===Number(sample.at);
    const temporal_sequence=identityMatches?temporalRow.sequence:null;
    if(declaredAvailable&&!temporal_sequence)temporalFlaggedMissing++;
    if(!declaredAvailable&&temporalRow)temporalUnexpected++;
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
    temporal_identity_mismatch:temporalIdentityMismatch,
    temporal_flagged_available:temporalFlaggedAvailable,
    temporal_flagged_missing:temporalFlaggedMissing,
    temporal_unexpected:temporalUnexpected};
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
    feature_schema:result.feature_schema,
    feature_names:result.feature_names,
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
    temporal_tree_training_performed:result.temporal_tree_training_performed,
    temporal_tree_challenger:result.temporal_tree_challenger,
    temporal_regime_local_tcn_challenger:result.temporal_regime_local_tcn_challenger,
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
    schema:'RADARX_DAILY_EARLY_RISER_NEURAL_BENCHMARK_V2',
    status:'RUNNING',
    created_at:new Date().toISOString(),
    input_file:input,
    temporal_input_file:temporalInput,
    census_report_file:censusReportPath,
    temporal_sidecar_audit:null,
    main_sample_file_audit:null,
    target_results:{},
    methodology:{
      labels:'First passage to +5%, +10% or +15% before a -2% adverse barrier within 96 consecutive closed 15m candles',
      input_cutoff:'Features are accepted only when feature_information_cutoff_at equals the baseline candle close',
      chronology:'The existing nested chronological V5 selection, calibration, validation and holdout gates are retained; outcomes crossing boundaries are purged',
      mlp_training_history:'The daily MLP gradient-fit window uses the newest 60% of its chronological model-fit timestamps; the same-window logistic anchor uses exactly the same rows, while member selection, calibration, outer validation and untouched holdout remain later disjoint blocks',
      feature_schema:'Daily MLP/GBDT use an isolated 35-channel V3 schema; legacy Cognitive V5 remains 18 channels outside this daily experiment. Daily context is computed from baseline-only closed candles. The independent daily TCN uses the original 24x29 closed-candle temporal sequence.',
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
    const quality=censusReport?.data_quality||{};
    if(quality.all_sample_audits_ready!==true||quality.no_overlapping_daily_labels!==true||
      Number(quality.feature_cutoff_violations)!==0||Number(quality.horizon_violations)!==0||
      Number(quality.symbols_failed)!==0||Number(quality.symbols_incomplete_archive)!==0||
      Number(quality.archive_coverage_after_first_available_pct)!==100)
      throw new Error('CENSUS_DATA_QUALITY_GATE_FAILED');
    const expectedSamples=censusReport?.sample_file;
    if(!expectedSamples||!Number.isInteger(Number(expectedSamples.rows))||Number(expectedSamples.rows)<1||
      typeof expectedSamples.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(expectedSamples.sha256)||
      report.input_sha256.toLowerCase()!==expectedSamples.sha256.toLowerCase())
      throw new Error('MAIN_SAMPLE_FILE_SHA256_OR_METADATA_MISMATCH');
    report.main_sample_file_audit={
      rows:Number(expectedSamples.rows),sha256:report.input_sha256,
      verified_against_census_report:true
    };
    const expectedTemporal=censusReport?.temporal_sample_file;
    if(!expectedTemporal||!Number.isInteger(Number(expectedTemporal.rows))||Number(expectedTemporal.rows)<1||
      Number(expectedTemporal.invalid_declared_sequences)!==0||
      Number(expectedTemporal.declared_sequence_count)!==Number(expectedTemporal.rows)+Number(expectedTemporal.invalid_declared_sequences)||
      expectedTemporal.sequence_steps!==24||expectedTemporal.sequence_channels!==29||
      typeof expectedTemporal.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(expectedTemporal.sha256))
      throw new Error('CENSUS_TEMPORAL_SIDECAR_METADATA_MISSING');
    const temporalSidecar=await loadTemporalSequences(temporalInput,
      expectedTemporal.sha256,Number(expectedTemporal.rows));
    report.temporal_sidecar_audit={
      rows:temporalSidecar.rows,bytes:temporalSidecar.bytes,sha256:temporalSidecar.sha256,
      coverage_pct:Number((temporalSidecar.rows/Number(expectedSamples.rows)*100).toFixed(3)),
      sequence_steps:24,sequence_channels:29,verified_against_census_report:true
    };
    for(const target of DAILY_EARLY_RISER_TARGETS_PCT){
      const loaded=await loadTargetSamples(input,target,temporalSidecar.by_id);
      if(loaded.lines_read!==Number(expectedSamples.rows)||loaded.samples.length!==Number(expectedSamples.rows)||
        loaded.malformed_lines!==0||loaded.missing_target_rows!==0)
        throw new Error('MAIN_SAMPLE_FILE_ROW_COUNT_PARSE_OR_TARGET_MISMATCH:'+target);
      if(loaded.temporal_identity_mismatch!==0||loaded.temporal_flagged_missing!==0||
        loaded.temporal_unexpected!==0||loaded.temporal_attached!==temporalSidecar.rows||
        loaded.temporal_flagged_available!==Number(expectedTemporal.declared_sequence_count))
        throw new Error('TEMPORAL_SEQUENCE_SAMPLE_IDENTITY_OR_COVERAGE_MISMATCH:'+target);
      const result=benchmarkDailyEarlyRiserTarget(loaded.samples,target);
      report.target_results[String(target)+'_PCT']={
        ...compactTarget(result),
        source_rows:{
          lines_read:loaded.lines_read,
          malformed_lines:loaded.malformed_lines,
          missing_target_rows:loaded.missing_target_rows,
          temporal_attached:loaded.temporal_attached,
          temporal_missing:loaded.temporal_missing,
          temporal_identity_mismatch:loaded.temporal_identity_mismatch,
          temporal_flagged_available:loaded.temporal_flagged_available,
          temporal_flagged_missing:loaded.temporal_flagged_missing,
          temporal_unexpected:loaded.temporal_unexpected
        }
      };
      const neural=result.neural_network||{};
      const boosted=result.boosted_tree_model||{};
      const hybrid=result.hybrid_model||{};
      const tcn=result.temporal_tcn||{};
      const tree=result.temporal_tree_challenger||{};
      const localTcn=result.temporal_regime_local_tcn_challenger||{};
      const regimeSummary=Object.fromEntries(Object.entries(tcn.regime_specialists||{})
        .map(([regime,value])=>[regime,{
          status:value?.status??null,
          training_samples:value?.training_samples??0,
          training_positive_samples:value?.training_positive_samples??0,
          training_negative_samples:value?.training_negative_samples??0,
          selection_samples:value?.member_selection_samples??0,
          selection_positive_samples:value?.selection_positive_samples??0,
          selection_negative_samples:value?.selection_negative_samples??0,
          validation_samples:value?.validation_samples??0,
          holdout_samples:value?.holdout_samples??0,
          selected:value?.selected===true,
          validation_passed:value?.selected===true,
          holdout_passed:value?.probability_ready===true,
          validation_brier:value?.validation_brier??null,
          validation_logistic_brier:value?.validation_pooled_logistic_brier??null,
          holdout_brier:value?.holdout_brier??null,
          holdout_logistic_brier:value?.holdout_pooled_logistic_brier??null,
          support_gaps:value?.support_gaps??[]
        }]));
      console.log('[DAILY_NEURAL_TARGET_COMPLETE] '+JSON.stringify({
        target_pct:target,
        feature_schema:result.feature_schema,
        feature_count:result.feature_names?.length??null,
        samples:result.samples.accepted,
        training:result.chronology.training_samples,
        validation:result.chronology.validation_samples,
        holdout:result.chronology.holdout_samples,
        neural:{
          status:neural.status??null,trained:neural.trained===true,
          preselection_training_samples:neural.preselection_training_samples??0,
          fitted_training_samples:neural.training_samples??0,
          required_training_samples:neural.samples_required??null,
          selection:{
            samples:neural.selection_samples??0,
            positive:neural.selection_positive_samples??neural.inner_selection_diagnostics?.selection_positive_samples??0,
            negative:neural.selection_negative_samples??neural.inner_selection_diagnostics?.selection_negative_samples??0,
            required_samples:neural.required_selection_samples??null,
            required_positive:neural.required_selection_positive_samples??null,
            required_negative:neural.required_selection_negative_samples??null,
            support_ready:neural.selection_support_ready===true,
            inner_selection_required_margin:neural.inner_selection_diagnostics?.required_brier_margin??null,
            outer_validation_required_margin:neural.inner_selection_diagnostics?.outer_validation_required_margin??null,
            diagnostics:neural.inner_selection_diagnostics??null
          },
          anchor_adaptation_requested:neural.anchor_adaptation_requested??null,
          anchor_adaptation:neural.anchor_adaptation??'NOT_REPORTED',
          anchor_trust_radius:neural.anchor_trust_radius??null,
          anchor_bias_trust_radius:neural.anchor_bias_trust_radius??null,
          anchor_tether_strength:neural.anchor_tether_strength??null,
          anchor_learning_rate_scale:neural.anchor_learning_rate_scale??null,
          max_anchor_skip_delta:neural.max_anchor_skip_delta??null,
          anchor_output_bias_delta:neural.anchor_output_bias_delta??null,
          selected_member_index:neural.selected_member_index??null,
          selected_residual_scale:neural.selected_residual_scale??null,
          member_selection_brier_scores:neural.member_selection_brier_scores??[],
          probability_calibration:neural.probability_calibration??null,
          failure_reason:neural.inner_selection_diagnostics?.failure_reason??null,
          validation_brier:neural.validation?.model_brier_score??null,
          validation_same_window_logistic_brier:neural.validation_comparison?.same_window_logistic_brier_score??null,
          holdout_brier:neural.holdout?.model_brier_score??null,
          holdout_same_window_logistic_brier:neural.holdout_comparison?.same_window_logistic_brier_score??null,
          holdout_comparison_passed:neural.holdout_comparison?.passed===true
        },
        gbdt:{
          status:boosted.status??null,trained:boosted.trained===true,
          training_samples:boosted.training_samples??0,
          selection_training_samples:boosted.selection_training_samples??0,
          selection_samples:boosted.selection_sample_count??0,
          training_support_ready:boosted.training_support_ready===true,
          selection_support_ready:boosted.selection_support_ready===true,
          fit_failure_reason:boosted.fit_failure_reason??null,
          selection_logistic_brier:boosted.selection_logistic?.model_brier_score??null,
          validation_brier:boosted.validation?.model_brier_score??null,
          same_window_logistic_validation_brier:boosted.same_window_logistic_validation?.model_brier_score??null,
          holdout_brier:boosted.holdout?.model_brier_score??null,
          same_window_logistic_holdout_brier:boosted.same_window_logistic_holdout?.model_brier_score??null
        },
        hybrid:{
          status:hybrid.status??null,trained:hybrid.trained===true,
          selected:hybrid.selected===true,selected_candidate:hybrid.selected_candidate??null,
          boosted_weight:hybrid.boosted_weight??null,
          candidates:hybrid.candidate_selection_metrics??[]
        },
        tcn:{
          status:tcn.status??null,trained:tcn.trained===true,
          sequence_samples:result.temporal_tcn_sequence_samples??0,
          training_samples:tcn.training_samples??0,
          training_sample_budget:tcn.training_sample_budget??null,
          shared_model_training_samples:tcn.shared_training_samples??tcn.shared_model_training_samples??0,
          selection_samples:tcn.selection_samples??0,
          supported_regimes:tcn.supported_regimes??[],
          selected_regimes:tcn.selected_regimes??[],
          regimes:regimeSummary,
          validation:tcn.validation??null,
          holdout:tcn.holdout??null,
          holdout_comparison:tcn.holdout_comparison??null
        },
        regime_local_tcn:{
          status:localTcn.status??null,
          trained:localTcn.trained===true,
          training_sample_budget:localTcn.training_sample_budget??0,
          training_samples:localTcn.training_samples??0,
          supported_regimes:localTcn.supported_regimes??[],
          validation_selected_regimes:localTcn.validation_selected_regimes??[],
          selected_regimes:localTcn.selected_regimes??[],
          validation:localTcn.validation??null,
          validation_logistic:localTcn.validation_logistic??null,
          holdout:localTcn.holdout??null,
          holdout_logistic:localTcn.holdout_logistic??null,
          holdout_comparison:localTcn.holdout_comparison??null,
          regimes:localTcn.regime_specialists??{}
        },
        temporal_tree:{
          status:tree.status??null,trained:tree.trained===true,
          training_samples:tree.training_samples??0,
          selection_samples:tree.selection_samples??0,
          validation:tree.validation??null,
          validation_logistic:tree.validation_logistic??null,
          holdout:tree.holdout??null,
          holdout_logistic:tree.holdout_logistic??null,
          holdout_comparison:tree.holdout_comparison??null
        },
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
