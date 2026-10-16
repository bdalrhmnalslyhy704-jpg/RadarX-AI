#!/usr/bin/env node
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {
  buildHistoricalLearningDataset,evaluateHistoricalLearningMetrics,
  splitHistoricalLearningRows,auditHistoricalMatrixCoverage,
  HISTORICAL_LEARNING_LAB_DEFAULTS
} from '../core/historical-learning-lab.mjs';
import {HISTORICAL_MATRIX_DEFAULT_SYMBOLS,HISTORICAL_MATRIX_REQUIRED_REGIMES} from '../core/historical-replay-matrix.mjs';

function flag(args,name,fallback=null){const index=args.indexOf(name);return index<0?fallback:(args[index+1]??fallback);}
function listArg(raw){return String(raw??'').split(',').map(x=>x.trim()).filter(Boolean);}
function numArg(raw,fallback,min,max,label){
  const value=Number(raw??fallback);
  if(!Number.isFinite(value)||value<min||value>max)throw new Error('INVALID_'+label.toUpperCase().replace(/[^A-Z0-9]+/g,'_'));
  return value;
}
async function readJson(path){
  const absolute=resolve(path);
  const text=await readFile(absolute,'utf8');
  return {path:absolute,value:JSON.parse(text)};
}
function startMs(report){
  const window=report?.window??report?.range??{};
  const numeric=Number(window.start??window.start_time);
  if(Number.isFinite(numeric)&&numeric>0)return numeric;
  const parsed=Date.parse(String(window.start_iso??window.start_time_iso??window.start??window.start_time??''));
  return Number.isFinite(parsed)?parsed:null;
}
function stableWindowId(report){
  return String(report?.id??report?.window_id??report?.window?.id??report?.window?.start_time??report?.window?.start??report?.window?.start_iso??'UNSPECIFIED_WINDOW');
}
async function expandReports(paths){
  const reports=[],sources=[],windowMetadata={},matrixWindows=[];
  for(const path of paths){
    const loaded=await readJson(path),doc=loaded.value;
    sources.push(loaded.path);
    if(Array.isArray(doc?.windows)&&!Array.isArray(doc?.results)){
      const baseDir=dirname(loaded.path);
      for(const win of doc.windows){
        const reportPath=win.report_path?resolve(baseDir,win.report_path):null;
        if(!reportPath)continue;
        const raw=await readJson(reportPath);
        const id=String(win.id??win.window_id??stableWindowId(raw.value));
        const report={...raw.value,id,window:{...(raw.value.window??{}),id}};
        const metadata={window_id:id,market_regime:win.market_regime?.regime??win.market_regime??'UNKNOWN'};
        reports.push(report);windowMetadata[id]=metadata;
        matrixWindows.push({id,window:win.window??report.window,market_regime:win.market_regime,results:report.results});
        sources.push(raw.path);
      }
    }else if(Array.isArray(doc?.results)){
      const id=String(doc.id??stableWindowId(doc));
      const report={...doc,id,window:{...(doc.window??doc.range??{}),id}};
      reports.push(report);
      const regime=doc.market_regime?.regime??doc.market_regime??'UNKNOWN';
      windowMetadata[id]={window_id:id,market_regime:regime};
      matrixWindows.push({id,window:report.window,market_regime:regime,results:report.results});
    }else{
      throw new Error('REPORT_SCHEMA_NOT_SUPPORTED:'+loaded.path);
    }
  }
  if(!reports.length)throw new Error('NO_HISTORICAL_REPLAY_REPORTS_FOUND');
  return {reports,sources:[...new Set(sources)],windowMetadata,matrixWindows};
}
async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')||args.includes('-h')){
    process.stdout.write([
      'RadarX historical learning lab — outcome labels, audit metrics and chronological evaluation.',
      'Usage: node phase2/tools/historical-learning-lab.mjs --reports report1.json,report2.json',
      '       [--matrix-summary reports/matrix-summary.json] [--expected-symbols BTCUSDT,ETHUSDT]',
      '       [--expected-windows bull,bear,sideways] [--regime-map regimes.json]',
      '       [--moderate-move-pct 5] [--strong-move-pct 15] [--train-fraction 0.6]',
      '       [--validation-fraction 0.2] [--embargo-hours 24] [--output path.json]',
      'Move thresholds are configurable definitions, not reported findings. No live thresholds are changed.'
    ].join('\n')+'\n');return;
  }
  const moderateMovePct=numArg(flag(args,'--moderate-move-pct'),HISTORICAL_LEARNING_LAB_DEFAULTS.moderate_move_pct,0.1,500,'moderate-move-pct');
  const strongMovePct=numArg(flag(args,'--strong-move-pct'),HISTORICAL_LEARNING_LAB_DEFAULTS.strong_move_pct,moderateMovePct,1000,'strong-move-pct');
  const trainFraction=numArg(flag(args,'--train-fraction'),HISTORICAL_LEARNING_LAB_DEFAULTS.train_fraction,0.1,0.8,'train-fraction');
  const validationFraction=numArg(flag(args,'--validation-fraction'),HISTORICAL_LEARNING_LAB_DEFAULTS.validation_fraction,0.1,0.5,'validation-fraction');
  if(trainFraction+validationFraction>=0.95)throw new Error('TEMPORAL_SPLIT_FRACTIONS_INVALID');
  const embargoHours=numArg(flag(args,'--embargo-hours'),24,0,168,'embargo-hours');
  const reportsArg=flag(args,'--reports');
  const matrixArg=flag(args,'--matrix-summary');
  const expectedSymbolsArg=flag(args,'--expected-symbols');
  const expectedWindowsArg=flag(args,'--expected-windows');
  const regimeMapArg=flag(args,'--regime-map');
  const output=resolve(flag(args,'--output','./reports/radarx-historical-learning-lab-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'));
  const defaultDatasetOutput=/\.json$/i.test(output)?output.replace(/\.json$/i,'-dataset.json'):output+'-dataset.json';
  const datasetOutput=resolve(flag(args,'--dataset-output',defaultDatasetOutput));
  if(args.includes('--dry-run')){
    process.stdout.write(JSON.stringify({
      status:'DRY_RUN_NO_NETWORK',
      required_inputs:['--reports path1.json,path2.json'],
      reports:reportsArg?listArg(reportsArg):[],
      matrix_summary:matrixArg,
      expected_symbols_explicit:Boolean(expectedSymbolsArg),
      expected_windows_explicit:Boolean(expectedWindowsArg),
      thresholds:{moderate_move_pct:moderateMovePct,strong_move_pct:strongMovePct},
      temporal_split:{train_fraction:trainFraction,validation_fraction:validationFraction,test_fraction:Number((1-trainFraction-validationFraction).toFixed(4)),embargo_hours:embargoHours,chronological:true},
      output,dataset_output:datasetOutput,
      policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',live_threshold_updates:false}
    },null,2)+'\n');return;
  }
  if(!reportsArg&&!matrixArg)throw new Error('HISTORICAL_REPLAY_REPORTS_REQUIRED');
  const loadPaths=reportsArg?listArg(reportsArg):[matrixArg];
  const expanded=await expandReports(loadPaths);
  const loadedMatrixSummary=matrixArg?(await readJson(matrixArg)).value:null;
  const reportMetadata={...expanded.windowMetadata};
  if(regimeMapArg){
    const regimeDoc=(await readJson(regimeMapArg)).value;
    if(!regimeDoc||typeof regimeDoc!=='object'||Array.isArray(regimeDoc))throw new Error('REGIME_MAP_MUST_BE_OBJECT');
    for(const [id,value] of Object.entries(regimeDoc)){
      reportMetadata[id]={...(reportMetadata[id]??{}),window_id:id,market_regime:value?.regime??value};
    }
  }
  let matrixMetadata=expanded.matrixWindows;
  if(Array.isArray(loadedMatrixSummary?.windows)){
    matrixMetadata=loadedMatrixSummary.windows.map(win=>{
      const id=String(win.id??win.window_id??'');
      const start=startMs({window:win.window??win});
      const matching=expanded.matrixWindows.find(other=>start!==null&&startMs(other)===start);
      const report=expanded.reports.find(item=>start!==null&&startMs(item)===start);
      if(report){
        report.id=id;
        report.window={...(report.window??report.range??{}),id};
        reportMetadata[id]={...(reportMetadata[id]??{}),window_id:id,market_regime:win.market_regime?.regime??win.market_regime??'UNKNOWN'};
      }
      return {...(matching??{}),...win,id,window:win.window??matching?.window??report?.window??{},
        results:matching?.results??report?.results??[],market_regime:win.market_regime??reportMetadata[id]?.market_regime??'UNKNOWN'};
    });
  }
  const reports=expanded.reports.map(report=>{
    const id=String(report.id??stableWindowId(report));
    return {...report,id,window:{...(report.window??report.range??{}),id},
      market_regime:reportMetadata[id]?.market_regime??report.market_regime??'UNKNOWN'};
  });
  const dataset=buildHistoricalLearningDataset(reports,{moderateMovePct,strongMovePct,reportMetadata});
  const metrics=evaluateHistoricalLearningMetrics(dataset,{moderateMovePct,strongMovePct});
  const symbols=listArg(expectedSymbolsArg).map(x=>x.toUpperCase());
  const windows=listArg(expectedWindowsArg);
  const inferredSymbols=[...new Set(reports.flatMap(report=>(report.results??[]).map(row=>String(row.symbol??'').toUpperCase())).filter(Boolean))];
  const inferredWindows=[...new Set(reports.map(stableWindowId))];
  const plannedSymbols=Array.isArray(loadedMatrixSummary?.symbols)?loadedMatrixSummary.symbols.map(x=>String(x).toUpperCase()):[];
  const plannedWindows=Array.isArray(loadedMatrixSummary?.windows)?loadedMatrixSummary.windows.map(w=>String(w.id??w.window_id??'' )).filter(Boolean):[];
  const expectedSymbols=symbols.length?symbols:(plannedSymbols.length?plannedSymbols:inferredSymbols);
  const expectedWindows=windows.length?windows:(plannedWindows.length?plannedWindows:inferredWindows);
  const expectationsExplicit=Boolean((expectedSymbolsArg||plannedSymbols.length)&&(expectedWindowsArg||plannedWindows.length));
  const coverage=auditHistoricalMatrixCoverage({windows:matrixMetadata},{
    expectedSymbols,expectedWindows,requiredRegimes:HISTORICAL_MATRIX_REQUIRED_REGIMES
  });
  const coverageGate={
    ...coverage,
    expectations_explicit:expectationsExplicit,
    release_grade:expectationsExplicit&&coverage.complete,
    status:expectationsExplicit?coverage.status:'EXPECTATIONS_INFERRED_NOT_RELEASE_GRADE'
  };
  const split=splitHistoricalLearningRows(dataset.rows,{
    trainFraction,validationFraction,embargoMs:embargoHours*60*60*1000
  });
  const walkForward={
    status:split.status,
    temporal_order_enforced:split.temporal_order_enforced===true,
    no_random_split:split.no_random_split===true,
    boundaries:split.boundaries,
    purged_rows:split.purged_rows,
    embargo_ms:split.embargo_ms,
    train_count:split.train_count,
    validation_count:split.validation_count,
    test_count:split.test_count,
    metrics:{
      train:evaluateHistoricalLearningMetrics({rows:split.train_rows??[]}),
      validation:evaluateHistoricalLearningMetrics({rows:split.validation_rows??[]}),
      test:evaluateHistoricalLearningMetrics({rows:split.test_rows??[]})
    }
  };
  const summary={
    schema_version:'RADARX_HISTORICAL_LEARNING_LAB_REPORT_V1',
    generated_at:new Date().toISOString(),
    source_reports:expanded.sources,
    outcome_definition:{moderate_move_pct:moderateMovePct,strong_move_pct:strongMovePct,outcome_horizon_hours:'as-recorded-per-replay-step'},
    dataset_summary:dataset.dataset_summary,
    metrics,
    coverage_gate:coverageGate,
    walk_forward:walkForward,
    thresholds_updated:false,
    interpretation:'Audit-only report. Review train/validation to design changes; use untouched test results for final comparison. Heuristic scores are not probabilities.',
    policy:dataset.policy
  };
  await mkdir(dirname(output),{recursive:true});
  await mkdir(dirname(datasetOutput),{recursive:true});
  await writeFile(output,JSON.stringify(summary,null,2)+'\n',{encoding:'utf8'});
  await writeFile(datasetOutput,JSON.stringify(dataset,null,2)+'\n',{encoding:'utf8'});
  process.stdout.write(JSON.stringify({
    output,dataset_output:datasetOutput,
    status:coverageGate.release_grade?'COVERAGE_AUDITED':coverageGate.status,
    decision_rows:dataset.dataset_summary.decision_rows,
    evaluable_decisions:metrics.evaluable_decisions,
    successful_alerts:metrics.successful_alerts,
    false_alerts:metrics.false_alerts,
    missed_move_events:metrics.missed_move_events,
    median_lead_time_minutes:metrics.median_lead_time_minutes,
    calibration:metrics.calibration.status,
    walk_forward:{status:walkForward.status,train:walkForward.train_count,validation:walkForward.validation_count,test:walkForward.test_count,purged_rows:walkForward.purged_rows},
    thresholds_updated:false,
    policy:summary.policy
  },null,2)+'\n');
  if(dataset.dataset_summary.decision_rows===0)process.exitCode=2;
}
main().catch(error=>{process.stderr.write('[HISTORICAL_LEARNING_LAB_ERROR] '+String(error?.stack??error)+'\n');process.exitCode=1;});
