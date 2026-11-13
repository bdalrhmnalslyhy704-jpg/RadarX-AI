#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const OUTER_MARGIN=0.003;
const INNER_MARGIN=0.00025;
const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const number=value=>finite(value)?Number(value):null;
const firstFinite=(...values)=>values.find(finite)===undefined?null:Number(values.find(finite));
const pick=(obj,...paths)=>{
  for(const path of paths){
    const value=path.split('.').reduce((value,key)=>value?.[key],obj);
    if(finite(value))return Number(value);
  }
  return null;
};
const score=metric=>({
  evaluated:metric?.evaluated===true||finite(metric?.model_brier_score),
  sample_count:number(metric?.sample_count),
  model_brier:number(metric?.model_brier_score),
  logistic_brier:null
});
function pairFor(model,stage,baselinePaths=[]){
  const metric=model?.[stage];
  const baseline=firstFinite(...baselinePaths.map(path=>
    path.split('.').reduce((value,key)=>value?.[key],model)));
  return {
    evaluated:metric?.evaluated===true&&finite(metric?.model_brier_score)&&baseline!==null,
    sample_count:number(metric?.sample_count),
    model_brier:number(metric?.model_brier_score),
    logistic_brier:baseline,
    improvement:baseline!==null&&finite(metric?.model_brier_score)
      ?baseline-Number(metric.model_brier_score):null,
    required_margin:OUTER_MARGIN,
    passed:baseline!==null&&metric?.evaluated===true&&
      Number(metric.model_brier_score)+OUTER_MARGIN<baseline
  };
}
function aggregateRegimes(model,stage,logisticStage){
  const regimes=model?.regime_specialists;
  if(!regimes||typeof regimes!=='object')return null;
  const keys=Object.keys(regimes);
  const values=keys.map(key=>({
    model:regimes[key]?.[stage],
    baseline:regimes[key]?.[logisticStage]
  })).filter(row=>row.model?.evaluated===true&&
    finite(row.model.model_brier_score)&&finite(row.baseline?.model_brier_score));
  if(!values.length)return null;
  const samples=values.reduce((sum,row)=>sum+Number(row.model.sample_count||0),0);
  if(!samples)return null;
  const weighted=key=>values.reduce((sum,row)=>sum+
    Number(row[key].model_brier_score)*Number(row.model.sample_count||0),0)/samples;
  const weightedLogistic=values.reduce((sum,row)=>sum+
    Number(row.baseline.model_brier_score)*Number(row.model.sample_count||0),0)/samples;
  const modelBrier=weighted('model');
  const logisticBrier=weightedLogistic;
  const allRegimesPass=values.length===keys.length&&values.every(row=>
    Number(row.model.model_brier_score)+OUTER_MARGIN<Number(row.baseline.model_brier_score));
  return {
    evaluated:values.length===keys.length&&samples>0,
    sample_count:samples,regimes_evaluated:values.length,regimes_required:keys.length,
    model_brier:modelBrier,logistic_brier:logisticBrier,
    improvement:logisticBrier-modelBrier,required_margin:OUTER_MARGIN,
    passed:allRegimesPass&&modelBrier+OUTER_MARGIN<logisticBrier
  };
}
function innerGate(model){
  const diagnostics=model?.inner_selection_diagnostics;
  if(diagnostics){
    const candidate=diagnostics.best_candidate||{};
    const modelBrier=firstFinite(candidate.brier_score);
    const logisticBrier=firstFinite(diagnostics.logistic_baseline_brier_score);
    const passed=diagnostics.passed===true&&
      modelBrier!==null&&logisticBrier!==null&&
      logisticBrier-modelBrier>INNER_MARGIN;
    return {evaluated:modelBrier!==null&&logisticBrier!==null,
      model_brier:modelBrier,logistic_brier:logisticBrier,
      improvement:modelBrier!==null&&logisticBrier!==null?logisticBrier-modelBrier:null,
      required_margin:INNER_MARGIN,passed,
      reason:diagnostics.failure_reason||null};
  }
  const candidates=Array.isArray(model?.candidate_selection_metrics)
    ?model.candidate_selection_metrics:[];
  const eligible=candidates.filter(row=>row?.selection_beats_same_window_logistic===true&&
    finite(row.selection_brier_score)&&finite(row.selection_logistic_brier_score));
  if(eligible.length){
    const best=[...eligible].sort((a,b)=>a.selection_brier_score-b.selection_brier_score)[0];
    return {evaluated:true,model_brier:Number(best.selection_brier_score),
      logistic_brier:Number(best.selection_logistic_brier_score),
      improvement:Number(best.selection_logistic_brier_score)-Number(best.selection_brier_score),
      required_margin:INNER_MARGIN,
      passed:Number(best.selection_logistic_brier_score)-Number(best.selection_brier_score)>INNER_MARGIN,
      candidate:best.name||null};
  }
  if(finite(model?.shared_model_selection_logistic_brier)){
    const candidate=firstFinite(model.shared_model_selection_candidate_brier);
    const logistic=Number(model.shared_model_selection_logistic_brier);
    return {evaluated:candidate!==null,model_brier:candidate,logistic_brier:logistic,
      improvement:candidate!==null?logistic-candidate:null,required_margin:INNER_MARGIN,
      passed:model.shared_model_selection_passed===true&&candidate!==null&&
        logistic-candidate>INNER_MARGIN};
  }
  if(model?.regime_specialists&&typeof model.regime_specialists==='object'){
    const regimes=Object.values(model.regime_specialists);
    const audits=regimes.map(regime=>{
      const candidates=Array.isArray(regime?.member_selection_scores)
        ?regime.member_selection_scores:[];
      const chosen=candidates.find(item=>item.selected===true)||
        candidates.filter(item=>item.beats_same_window_logistic===true&&
          finite(item.brier_score)).sort((a,b)=>a.brier_score-b.brier_score)[0]||null;
      const logistic=firstFinite(regime?.member_selection_logistic_brier);
      const modelScore=firstFinite(chosen?.brier_score);
      return {model_brier:modelScore,logistic_brier:logistic,
        passed:chosen!==null&&logistic!==null&&
          (chosen.beats_same_window_logistic===true||logistic-modelScore>INNER_MARGIN)};
    });
    const complete=audits.length>0&&audits.every(item=>
      item.model_brier!==null&&item.logistic_brier!==null);
    if(complete){
      const modelScore=audits.reduce((sum,item)=>sum+item.model_brier,0)/audits.length;
      const logistic=audits.reduce((sum,item)=>sum+item.logistic_brier,0)/audits.length;
      return {evaluated:true,model_brier:modelScore,logistic_brier:logistic,
        improvement:logistic-modelScore,required_margin:INNER_MARGIN,
        passed:audits.every(item=>item.passed)&&logistic-modelScore>INNER_MARGIN,
        regimes:audits};
    }
  }
  const selection=model?.selection||model?.member_selection||{};
  const modelBrier=firstFinite(selection.model_brier_score,selection.candidate_brier);
  const logisticBrier=firstFinite(selection.logistic_brier_score,selection.same_window_logistic_brier);
  if(modelBrier!==null&&logisticBrier!==null){
    return {evaluated:true,model_brier:modelBrier,logistic_brier:logisticBrier,
      improvement:logisticBrier-modelBrier,required_margin:INNER_MARGIN,
      passed:logisticBrier-modelBrier>INNER_MARGIN};
  }
  return {evaluated:false,model_brier:null,logistic_brier:null,
    improvement:null,required_margin:INNER_MARGIN,passed:false,
    reason:'INNER_SELECTION_BRIER_NOT_EXPOSED'};
}
function addRow(rows,{target,family,variant,model,selection,validation,holdout,sourceSha,sourceRun}){
  const selected=model?.selected===true||model?.selected_for_research===true||
    model?.status==='OUT_OF_SAMPLE_VALIDATED'||model?.status==='TEMPORAL_TCN_OUT_OF_SAMPLE_VALIDATED_RESEARCH_ONLY';
  const status=!validation?.evaluated?'VALIDATION_BRIER_UNAVAILABLE':
    !holdout?.evaluated?'HOLDOUT_BRIER_UNAVAILABLE':
    !selection?.evaluated?'INNER_SELECTION_BRIER_UNAVAILABLE':
    !selection.passed?'INNER_SELECTION_GATE_FAILED':
    !validation.passed?'EXTERNAL_VALIDATION_GATE_FAILED':
    !holdout.passed?'UNTOUCHED_HOLDOUT_GATE_FAILED':
    'HISTORICAL_BRIER_GATES_PASSED_REQUIRES_FORWARD_SHADOW';
  rows.push({
    target_pct:target,family,variant,selected,
    inner_selection:selection||{evaluated:false,passed:false,reason:'NOT_REPORTED'},
    external_validation:validation||{evaluated:false,passed:false},
    untouched_final_holdout:holdout||{evaluated:false,passed:false},
    historical_gate_status:status,
    source_sha256:sourceSha||null,source_run_id:sourceRun||null,
    production_approved:false
  });
}
function unwrapHybridTcnReport(root,target){
  if(!root)return null;
  const direct=root.target_results?.[String(target)]||root.target_results?.[String(target)+'_PCT']||
    root[String(target)]||root;
  const candidates=[
    direct.hybrid_tcn_attention,
    direct.hybrid_model,
    direct.model_families?.hybrid_tcn_attention,
    direct
  ].filter(Boolean);
  return candidates.find(value=>
    value.validation||value.external_validation||value.holdout||value.untouched_final_holdout)||
    candidates[0]||null;
}
export function buildBrierMatrixReport(dailyReport,{hybridTcnReport=null,denseReport=null,
  requiredTargets=[5,10,15]}={}){
  if(!dailyReport||typeof dailyReport!=='object'||!dailyReport.target_results)
    throw new TypeError('DAILY_NEURAL_REPORT_TARGET_RESULTS_REQUIRED');
  const targetEntries=Object.entries(dailyReport.target_results).map(([key,value])=>{
    const match=String(key).match(/(?:^|_)(15|10|5)_PCT/);
    return {target:match?Number(match[1]):number(value?.target_pct),value};
  }).filter(row=>row.target!==null);
  const sourceSha=dailyReport.input_sha256||dailyReport.main_sample_file_audit?.sha256||null;
  const sourceRun=dailyReport.census_source_run_id||dailyReport.source_run_id||null;
  const rows=[];
  for(const entry of targetEntries){
    const target=entry.target,root=entry.value||{};
    const neural=root.neural_network||{};
    const gbdt=root.boosted_tree_model||{};
    const hybrid=root.hybrid_model||{};
    const tcn=root.temporal_tcn||{};
    const variants=[
      {
        family:'MLP_V5',variant:'RESIDUAL_MLP_ENSEMBLE',
        model:neural,
        selection:innerGate(neural),
        validation:pairFor({validation:neural.validation,
          same:neural.validation_comparison?.same_window_logistic_brier_score},'validation',['same']),
        holdout:pairFor({holdout:neural.holdout,
          same:neural.holdout_comparison?.same_window_logistic_brier_score},'holdout',['same'])
      },
      {
        family:'GBDT_CONTROL',variant:'RESIDUAL_GBDT',
        model:gbdt,selection:innerGate(gbdt),
        validation:pairFor({validation:gbdt.validation,
          same:gbdt.same_window_logistic_validation?.model_brier_score},'validation',['same']),
        holdout:pairFor({holdout:gbdt.holdout,
          same:gbdt.same_window_logistic_holdout?.model_brier_score},'holdout',['same'])
      },
      {
        family:'HYBRID_MLP_GBDT',variant:'CALIBRATED_BRIER_BLEND',
        model:hybrid,selection:innerGate(hybrid),
        validation:pairFor({validation:hybrid.validation,
          same:gbdt.same_window_logistic_validation?.model_brier_score},'validation',['same']),
        holdout:pairFor({holdout:hybrid.holdout,
          same:hybrid.holdout_comparison?.same_window_logistic_brier_score||
            root.model_selection?.challenger_holdout_comparison?.same_window_logistic_brier_score},'holdout',['same'])
      },
      {
        family:'TCN_V8',variant:'SHARED_POOLED_TCN',
        model:tcn,selection:innerGate(tcn),
        validation:pairFor({validation:tcn.validation,
          same:tcn.validation?.pooled_logistic_brier_score},'validation',['same']),
        holdout:pairFor({holdout:tcn.holdout,
          same:tcn.holdout?.pooled_logistic_brier_score},'holdout',['same'])
      }
    ];
    const tcnVariants=[
      ['TCN_V8','REGIME_LOCAL',root.temporal_regime_local_tcn_challenger],
      ['TCN_V9','ORDERED_PYRAMID',root.temporal_regime_local_tcn_pyramid_challenger],
      ['TCN_V10','MULTISCALE',root.temporal_regime_local_tcn_multiscale_challenger],
      ['TCN_V11','LEARNED_QUERY_ATTENTION',root.temporal_regime_local_tcn_attention_challenger]
    ];
    for(const [family,variant,model] of tcnVariants){
      if(!model)continue;
      const validation=pairFor({validation:model.validation,
        same:model.validation_logistic?.model_brier_score},'validation',['same']);
      const holdout=pairFor({holdout:model.holdout,
        same:model.holdout_logistic?.model_brier_score},'holdout',['same']);
      const selection=innerGate(model);
      addRow(rows,{target,family,variant,model,selection,validation,holdout,sourceSha,sourceRun});
    }
    for(const item of variants)addRow(rows,{target,...item,sourceSha,sourceRun});
    const hybridTcn=unwrapHybridTcnReport(hybridTcnReport,target);
    if(hybridTcn){
      const validation=pairFor({
        validation:hybridTcn.validation||hybridTcn.external_validation,
        same:hybridTcn.validation_logistic?.model_brier_score||
          hybridTcn.external_validation?.same_window_logistic_brier_score
      },'validation',['same']);
      const holdout=pairFor({
        holdout:hybridTcn.holdout||hybridTcn.untouched_final_holdout,
        same:hybridTcn.holdout_logistic?.model_brier_score||
          hybridTcn.untouched_final_holdout?.same_window_logistic_brier_score
      },'holdout',['same']);
      addRow(rows,{target,family:'HYBRID_TCN_ATTENTION',variant:'TCN_ATTENTION_HYBRID',
        model:hybridTcn,selection:innerGate(hybridTcn),validation,holdout,
        sourceSha:hybridTcnReport.input_sha256||hybridTcnReport.source_sample_sha256||
          hybridTcn.source_sample_sha256||null,
        sourceRun:hybridTcn.source_run_id||hybridTcnReport.source_run_id||sourceRun});
    }else{
      addRow(rows,{target,family:'HYBRID_TCN_ATTENTION',variant:'LEGACY_PR410_REPLAY',
        model:{selected:false},selection:{evaluated:false,passed:false,
          reason:'PR410_REPORT_HAS_NET_PNL_REPLAY_NOT_COMPARABLE_BRIER_SPLITS'},
        validation:{evaluated:false,passed:false,reason:'NO_COMPARABLE_BRIER_REPORT'},
        holdout:{evaluated:false,passed:false,reason:'NO_COMPARABLE_BRIER_REPORT'},
        sourceSha,sourceRun});
    }
    if(denseReport){
      const dense= denseReport.target_results?.[String(target)]||denseReport;
      const validation=pairFor({validation:dense.validation||dense.external_validation,
        same:dense.validation_logistic_brier_score||dense.validation?.logistic_brier_score},'validation',['same']);
      const holdout=pairFor({holdout:dense.holdout||dense.untouched_final_holdout,
        same:dense.holdout_logistic_brier_score||dense.holdout?.logistic_brier_score},'holdout',['same']);
      addRow(rows,{target,family:'DENSE_PROJECTION_MLP',variant:'DENSE_24H_PROJECTION',
        model:dense,selection:innerGate(dense),validation,holdout,
        sourceSha:dense.source_sample_sha256||sourceSha,sourceRun});
    }
  }
  const scoredRows=rows.filter(row=>row.inner_selection.evaluated||
    row.external_validation.evaluated||row.untouched_final_holdout.evaluated);
  const hashes=[...new Set(scoredRows.map(row=>row.source_sha256).filter(Boolean))];
  const missingSourceHashCount=scoredRows.filter(row=>!row.source_sha256).length;
  const sourceIntegrity={same_input_sha256:hashes.length===1&&missingSourceHashCount===0,
    observed_sha256_count:hashes.length,missing_source_hash_rows:missingSourceHashCount,
    sha256_values:hashes,mixed_source_warning:hashes.length>1};
  const targetCoverage=requiredTargets.map(target=>({
    target_pct:target,present:targetEntries.some(row=>row.target===target)
  }));
  const coreFamilies=['MLP_V5','TCN_V8','TCN_V9','TCN_V10','TCN_V11',
    'HYBRID_MLP_GBDT','HYBRID_TCN_ATTENTION'];
  const familySummary=coreFamilies.map(family=>{
    const familyRows=rows.filter(row=>row.family===family);
    const allTargetsPresent=requiredTargets.every(target=>
      familyRows.some(row=>row.target_pct===target));
    const allPassed=allTargetsPresent&&familyRows.length>0&&
      familyRows.every(row=>row.selected&&row.inner_selection.passed&&
        row.external_validation.passed&&row.untouched_final_holdout.passed);
    return {family,targets_present:familyRows.map(row=>row.target_pct),
      required_targets:requiredTargets,all_required_targets_present:allTargetsPresent,
      validation_and_holdout_passed_all_targets:allPassed,
      rows:familyRows.length};
  });
  const allCoreFamiliesPassed=familySummary.every(row=>
    row.validation_and_holdout_passed_all_targets);
  const allTargetCoverage=targetCoverage.every(row=>row.present);
  const sourceConsistent=sourceIntegrity.same_input_sha256;
  const promotionEligible=allCoreFamiliesPassed&&allTargetCoverage&&sourceConsistent;
  return {
    schema:'RADARX_NEURAL_HYBRID_HEAD_TO_HEAD_BRIER_MATRIX_V1',
    created_at:new Date().toISOString(),
    source_report_status:dailyReport.status||null,
    source_sample_sha256:sourceSha,
    source_run_id:sourceRun,
    target_coverage:targetCoverage,
    thresholds:{inner_selection_strictly_greater_than:INNER_MARGIN,
      external_validation_and_final_holdout_strictly_greater_than:OUTER_MARGIN},
    source_integrity:sourceIntegrity,
    family_summary:familySummary,
    rows,
    overall_status:promotionEligible
      ?'HISTORICAL_ALL_FAMILY_GATES_PASSED_FORWARD_SHADOW_STILL_REQUIRED'
      :'NOT_PROMOTION_ELIGIBLE_ONE_OR_MORE_FAMILY_TARGET_OR_SOURCE_GATES_FAILED',
    promotion_eligible:promotionEligible,
    production_deployment_allowed:false,
    paper_trading_activation_allowed:false,
    real_order_execution:false,
    note:'Brier comparisons use only an explicitly reported same-window Logistic reference. Missing Brier evidence is NOT_EVALUATED, never inferred from PnL or base-rate Brier.'
  };
}
export function renderBrierTable(report){
  const lines=[
    '| Target | Family | Variant | Selection Δ | Validation: Model / Logistic / Δ | Holdout: Model / Logistic / Δ | Gate |',
    '|---:|---|---|---:|---:|---:|---|'
  ];
  const fmt=(value)=>finite(value)?Number(value).toFixed(5):'—';
  for(const row of report.rows){
    const s=row.inner_selection,v=row.external_validation,h=row.untouched_final_holdout;
    const val=v.evaluated?[fmt(v.model_brier)+' / '+fmt(v.logistic_brier)+' / '+fmt(v.improvement)]:'—';
    const hold=h.evaluated?[fmt(h.model_brier)+' / '+fmt(h.logistic_brier)+' / '+fmt(h.improvement)]:'—';
    const selection=s.evaluated?fmt(s.improvement):'—';
    lines.push('| '+row.target_pct+'% | '+row.family+' | '+row.variant+' | '+selection+
      ' | '+val+' | '+hold+' | '+row.historical_gate_status+' |');
  }
  return lines.join('\n');
}
function parseArgs(argv){
  const out={};
  for(let i=0;i<argv.length;i++){
    const token=argv[i];
    if(!token.startsWith('--'))continue;
    const key=token.slice(2);
    out[key]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:'true';
  }
  return out;
}
async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(!args['daily-report'])throw new Error('USAGE: --daily-report report.json [--hybrid-tcn-report report.json] [--dense-report report.json] [--output report.json]');
  const daily=JSON.parse(await readFile(resolve(args['daily-report']),'utf8'));
  const hybrid=args['hybrid-tcn-report']?JSON.parse(await readFile(resolve(args['hybrid-tcn-report']),'utf8')):null;
  const dense=args['dense-report']?JSON.parse(await readFile(resolve(args['dense-report']),'utf8')):null;
  const targets=String(args.targets||'5,10,15').split(',').map(Number).filter(Number.isFinite);
  const report=buildBrierMatrixReport(daily,{hybridTcnReport:hybrid,denseReport:dense,requiredTargets:targets});
  const output=resolve(args.output||'artifacts/neural-hybrid-head-to-head-brier-matrix.json');
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(renderBrierTable(report));
  console.log('\n[NEURAL_HYBRID_BRIER_MATRIX] '+JSON.stringify({
    status:report.overall_status,rows:report.rows.length,
    source_sha256:report.source_sample_sha256,
    promotion_eligible:report.promotion_eligible,
    output
  }));
  if(report.promotion_eligible!==true)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error('[NEURAL_HYBRID_BRIER_MATRIX_FATAL]',error?.stack||String(error));
  process.exitCode=1;
});
