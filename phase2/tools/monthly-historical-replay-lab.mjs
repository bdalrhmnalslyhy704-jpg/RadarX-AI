#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONFIG} from '../config.mjs';
import {RestClient} from '../market/binance-rest.mjs';
import {classifyBtcMarketRegime} from '../core/historical-replay-matrix.mjs';
import {
  buildHistoricalLearningDataset,evaluateHistoricalLearningMetrics,splitHistoricalLearningRows
} from '../core/historical-learning-lab.mjs';

const HOUR=60*60*1000,DAY=24*HOUR,MINUTE=60*1000;
const here=dirname(fileURLToPath(import.meta.url));
const replayScript=resolve(here,'historical-replay.mjs');
function flag(args,name,fallback=null){const i=args.indexOf(name);return i<0?fallback:(args[i+1]??fallback);}
function integer(raw,fallback,min,max,label){
  const n=Math.trunc(Number(raw??fallback));
  if(!Number.isFinite(n)||n<min||n>max)throw new Error('INVALID_'+label.toUpperCase().replace(/[^A-Z0-9]+/g,'_'));
  return n;
}
async function readJson(path){const absolute=resolve(path);return{path:absolute,value:JSON.parse(await readFile(absolute,'utf8'))};}
const HISTORICAL_PROFILE_INFO=Object.freeze({
  STRONG_MOVE_RADAR:{canonical:'STRONG_MOVE_RADAR',mode:'ACTIONABLE_GATE_REPLAY',requiredTimeframes:[]},
  RADAR8_PREMOVE_SHADOW:{canonical:'EARLY_EXPANSION_RADAR',mode:'PRE_MOVE_CANDLE_ONLY_SHADOW',requiredTimeframes:['15m','1h','4h','BTCUSDT:5m']},
  ALMUQAWIM_RADAR:{canonical:'ALMUQAWIM_RADAR',mode:'CANDLE_ONLY_CANDIDATE_SHADOW',requiredTimeframes:['15m','1h','4h']},
  DOOMSDAY_RADAR:{canonical:'DOOMSDAY_RADAR',mode:'CANDLE_ONLY_CANDIDATE_SHADOW',requiredTimeframes:['BTCUSDT:5m']},
  KAHIR_RADAR:{canonical:'KAHIR_RADAR',mode:'CANDLE_ONLY_CANDIDATE_SHADOW',requiredTimeframes:['BTCUSDT:1m']},
  ROTATION_LAG_RADAR:{canonical:'ROTATION_LAG_RADAR',mode:'CANDLE_ONLY_CANDIDATE_SHADOW',
    requiredTimeframes:['15m','1h','BTCUSDT:15m','BTCUSDT:1h','ETHUSDT:15m','ETHUSDT:1h']}
});
function historicalProfileInfo(profile){
  const item=HISTORICAL_PROFILE_INFO[String(profile||'').trim().toUpperCase()];
  if(!item)throw new Error('UNSUPPORTED_HISTORICAL_DETECTOR_PROFILE:'+profile);
  return {requested_profile:String(profile).trim().toUpperCase(),...item,
    live_notification_simulated:item.mode==='ACTIONABLE_GATE_REPLAY'};
}

function safeId(value){return String(value??'case').trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,90)||'case';}
function validSymbol(value){return /^[A-Z0-9]{5,20}$/.test(String(value??'').toUpperCase());}
function isConfirmedAnchor(caseRow){
  // The event label is derived from price action/outcome only, not from the monthly cohort.
  // A CONTROL-month coin can still contain a genuinely confirmed short-term move.
  return String(caseRow?.anchorMarker??'')==='FIRST_4PCT_RANGE_BREAK_WITH_8PCT_24H_FOLLOW_THROUGH'&&
    caseRow?.forensics?.outcomes?.complete_24h===true;
}
function childRun(args,{timeoutMs}) {
  return new Promise(resolveResult=>{
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe'],env:{...process.env}});
    let stdout='',stderr='',timedOut=false,done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolveResult(value);};
    child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>10000)stdout=stdout.slice(-10000);});
    child.stderr.on('data',b=>{stderr+=b.toString();if(stderr.length>20000)stderr=stderr.slice(-20000);});
    child.on('error',error=>finish({exitCode:1,timedOut:false,error:String(error?.message??error),stdout,stderr}));
    child.on('close',code=>finish({exitCode:code??1,timedOut,error:timedOut?'MONTHLY_REPLAY_TIMEOUT':null,stdout,stderr}));
    const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGTERM');}catch{}setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},5000).unref?.();},timeoutMs);
  });
}
function candleCoverage(report,horizonHours,detectorSpec={}){
  const rows=Array.isArray(report?.results)?report.results:[];
  if(rows.length!==1)return {complete:false,reason:'EXPECTED_EXACTLY_ONE_SYMBOL_RESULT'};
  const row=rows[0],quality=row?.data_quality??{};
  const mode=String(quality.replay_mode??'BLOCKED_INCOMPLETE');
  const requiredTimeframes=Array.isArray(detectorSpec.requiredTimeframes)?detectorSpec.requiredTimeframes:[];
  const additional=quality.additional_timeframes&&typeof quality.additional_timeframes==='object'?quality.additional_timeframes:{};
  const missingRequiredTimeframes=requiredTimeframes.filter(key=>additional[key]?.complete!==true);
  const baseComplete=quality.candle_fetch_complete===true&&quality.outcome_candle_fetch_complete===true&&
    quality.synthetic_data_used===false&&Number(row?.summary?.replay_steps)>0&&
    ['FULL_TRADE','CANDLE_ONLY_FALLBACK'].includes(mode)&&Number(quality.outcome_horizon_hours)===horizonHours;
  const complete=baseComplete&&missingRequiredTimeframes.length===0;
  const reason=complete?null:missingRequiredTimeframes.length
    ?'REQUIRED_DETECTOR_TIMEFRAME_COVERAGE_INCOMPLETE'
    :(quality.failure??'HISTORICAL_REPLAY_COVERAGE_INCOMPLETE');
  return {complete,mode,decision_candles_complete:quality.candle_fetch_complete===true,
    outcome_horizon_complete:quality.outcome_candle_fetch_complete===true,
    trade_coverage_complete:quality.trade_coverage_complete===true,
    required_timeframes:requiredTimeframes,missing_required_timeframes:missingRequiredTimeframes,
    additional_timeframe_coverage:additional,
    replay_steps:Number(row?.summary?.replay_steps)||0,reason};
}

async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')||args.includes('-h')){
    process.stdout.write([
      'RadarX monthly historical replay lab — replays the existing detector before event markers.',
      'Usage: node phase2/tools/monthly-historical-replay-lab.mjs --input monthly-move-forensics.json',
      '       [--detector-profile STRONG_MOVE_RADAR|RADAR8_PREMOVE_SHADOW|ALMUQAWIM_RADAR|DOOMSDAY_RADAR|KAHIR_RADAR|ROTATION_LAG_RADAR]',
      '       [--output-dir reports/monthly-historical-learning-lab] [--max-trade-pages 20]',
      '       [--max-trades 20000] [--outcome-horizon-hours 24] [--case-timeout-ms 1800000] [--dry-run]',
      'Only closed public Binance Spot inputs are used. Event markers/cohorts are post-decision labels and never enter evaluator inputs.',
      'Candidate-shadow profiles measure detector candidates, not actual delivered notifications; unavailable historical book/news evidence is not synthesized.'
    ].join('\n')+'\n');return;
  }
  const input=flag(args,'--input');
  const detectorProfile=String(flag(args,'--detector-profile','STRONG_MOVE_RADAR')).trim().toUpperCase();
  const detectorSpec=historicalProfileInfo(detectorProfile);
  const outputDir=resolve(flag(args,'--output-dir','reports/monthly-historical-learning-lab'));
  const maxTradePages=integer(flag(args,'--max-trade-pages','20'),20,1,1000,'max-trade-pages');
  const maxTrades=integer(flag(args,'--max-trades','20000'),20000,1000,1000000,'max-trades');
  const outcomeHorizonHours=integer(flag(args,'--outcome-horizon-hours','24'),24,1,168,'outcome-horizon-hours');
  const caseTimeoutMs=integer(flag(args,'--case-timeout-ms','1800000'),1800000,60000,7200000,'case-timeout-ms');
  const maxCases=integer(flag(args,'--max-cases','2000'),2000,1,5000,'max-cases');
  const maxInputCases=integer(flag(args,'--max-input-cases','2000'),2000,1,5000,'max-input-cases');
  if(args.includes('--dry-run')){
    process.stdout.write(JSON.stringify({
      status:'DRY_RUN_NO_NETWORK',input:input?resolve(input):null,output_dir:outputDir,
      per_case_decision_window_hours:24,outcome_horizon_hours:outcomeHorizonHours,
      max_trade_pages_per_case:maxTradePages,max_trades_per_case:maxTrades,
      max_cases:maxCases,case_timeout_ms:caseTimeoutMs,
      detector_profile:detectorSpec,
      policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',
        event_marker_is_evaluator_input:false,live_notification_simulated:detectorSpec.live_notification_simulated}
    },null,2)+'\n');return;
  }
  if(!input)throw new Error('MONTHLY_FORENSICS_INPUT_REQUIRED');
  const loaded=await readJson(input),source=loaded.value;
  if(!String(source?.schema_version??'').startsWith('radarx.monthly-move-forensics.'))throw new Error('MONTHLY_FORENSICS_SCHEMA_UNSUPPORTED');
  const allCases=Array.isArray(source.cases)?source.cases:[];
  if(!allCases.length)throw new Error('MONTHLY_FORENSICS_CASES_EMPTY');
  if(allCases.length>maxInputCases)throw new Error('MONTHLY_INPUT_CASE_COUNT_EXCEEDS_LIMIT:'+allCases.length+':'+maxInputCases);
  if(allCases.length>maxCases)throw new Error('MONTHLY_REPLAY_CASE_COUNT_EXCEEDS_LIMIT:'+allCases.length+':'+maxCases);

  await mkdir(outputDir,{recursive:true});
  const replayDir=resolve(outputDir,'replays');
  await mkdir(replayDir,{recursive:true});
  const client=new RestClient({...CONFIG.rest,baseUrls:CONFIG.rest.baseUrls??CONFIG.rest.urls});
  const btcRegimeByHour=new Map();
  async function regimeAt(anchorAt){
    const key=Math.floor(anchorAt/HOUR)*HOUR;
    if(btcRegimeByHour.has(key))return btcRegimeByHour.get(key);
    let result;
    try{
      const response=await client.klines('BTCUSDT','1h',{limit:8,startTime:key-8*HOUR,endTime:key-1});
      const candles=(Array.isArray(response?.candles)?response.candles:[]).filter(c=>
        c?.closed!==false&&Number(c?.closeTime)<key&&Number(c?.closeTime)<=anchorAt-1);
      result={...classifyBtcMarketRegime(candles),source:'BTCUSDT_CLOSED_1H_BEFORE_EVENT_ANCHOR',as_of:key};
    }catch(error){
      result={regime:'UNKNOWN',sample_count:0,reason:'BTC_REGIME_FETCH_FAILED:'+String(error?.message??error).slice(0,160),source:'BINANCE_PUBLIC_REST',as_of:key};
    }
    btcRegimeByHour.set(key,result);
    return result;
  }

  const records=[],reports=[],expectedCaseIds=[];
  let processed=0,coverageComplete=0,replayFailures=0,positiveAnchors=0,positiveAnchorsCaptured=0;
  for(let index=0;index<allCases.length;index++){
    const row=allCases[index]??{};
    const symbol=String(row.symbol??'').toUpperCase();
    const cohort=String(row.cohort??'UNKNOWN').toUpperCase();
    const anchorRaw=row?.forensics?.anchor_time;
    const anchorAt=Date.parse(String(anchorRaw??''));
    const caseId=safeId(cohort+'-'+symbol+'-'+(Number.isFinite(anchorAt)?new Date(anchorAt).toISOString():'no-anchor'));
    const anchorMarker=String(row.anchorMarker??'FAILED');
    const eventPositive=isConfirmedAnchor(row);
    const baseRecord={
      case_id:caseId,symbol,cohort,monthly_return_pct:Number.isFinite(Number(row.monthlyReturnPct))?Number(row.monthlyReturnPct):null,
      anchor_at:Number.isFinite(anchorAt)?anchorAt:null,anchor_at_iso:Number.isFinite(anchorAt)?new Date(anchorAt).toISOString():null,
      anchor_marker:anchorMarker,positive_event_label:eventPositive,market_regime:null,status:'PENDING',
      replay_path:null,coverage:null,error:null
    };
    records.push(baseRecord);expectedCaseIds.push(caseId);
    if(!validSymbol(symbol)||!Number.isFinite(anchorAt)||row.error||!row.forensics){
      baseRecord.status='SKIPPED_MISSING_SOURCE_CASE';
      baseRecord.error=String(row.error??'MONTHLY_EVENT_ANCHOR_UNAVAILABLE').slice(0,200);
      replayFailures++;continue;
    }
    const latestClosedMinuteEnd=Math.floor(Date.now()/MINUTE)*MINUTE-1;
    if(anchorAt+outcomeHorizonHours*HOUR>latestClosedMinuteEnd){
      baseRecord.status='SKIPPED_OUTCOME_NOT_MATURED';
      baseRecord.error='OUTCOME_HORIZON_NOT_FULLY_OBSERVED';
      replayFailures++;continue;
    }
    const regime=await regimeAt(anchorAt);
    baseRecord.market_regime=regime.regime;
    const start=anchorAt-DAY,end=anchorAt-1;
    const replayPath=resolve(replayDir,caseId+'.json');
    baseRecord.replay_path=replayPath;
    const child=await childRun([
      replayScript,'--symbols',symbol,'--start',String(start),'--end',String(end),
      '--outcome-horizon-hours',String(outcomeHorizonHours),
      '--detector-profile',detectorProfile,
      '--max-trade-pages',String(maxTradePages),'--max-trades',String(maxTrades),
      '--output',replayPath
    ],{timeoutMs:caseTimeoutMs});
    let report=null;
    try{report=JSON.parse(await readFile(replayPath,'utf8'));}catch(error){
      baseRecord.status='REPLAY_REPORT_UNAVAILABLE';
      baseRecord.error=(child.error??String(error?.message??error)).slice(0,240);
      replayFailures++;continue;
    }
    const coverage=candleCoverage(report,outcomeHorizonHours,detectorSpec);
    baseRecord.coverage={...coverage,process_exit_code:child.exitCode,timed_out:child.timedOut};
    if(!coverage.complete||child.exitCode!==0||child.timedOut){
      baseRecord.status='INCOMPLETE_REPLAY';
      baseRecord.error=String(child.error??coverage.reason??'HISTORICAL_REPLAY_PROCESS_FAILED').slice(0,240);
      replayFailures++;
    }else{
      baseRecord.status='COMPLETE';
      coverageComplete++;
    }
    processed++;
    const id=caseId;
    const event={
      id,at:anchorAt,cohort,is_positive:eventPositive,anchor_type:anchorMarker,
      monthly_return_pct:baseRecord.monthly_return_pct,
      label_source:'MONTHLY_MOVE_FORENSICS_EX_POST_EVENT_MARKER',
      note:'Event anchor is metadata for post-decision lead-time scoring only; it is never passed to the historical evaluator.'
    };
    report.id=id;
    report.window={id,start,end,start_time:start,end_time:end,start_iso:new Date(start).toISOString(),end_iso:new Date(end).toISOString()};
    report.market_regime=regime.regime;
    report.market_event=event;
    report.detector_replay={...detectorSpec,event_anchor_as_evaluator_input:false,replay_data_mode:coverage.mode};
    for(const result of (Array.isArray(report.results)?report.results:[])){
      for(const step of (Array.isArray(result.steps)?result.steps:[])){
        step.window_id=id;
        step.radar=detectorSpec.canonical;
        step.detector_profile=detectorProfile;
        step.detector_evaluation_mode=detectorSpec.mode;
        step.market_regime=regime.regime;
        step.market_event_at=anchorAt;
        step.market_event_cohort=cohort;
        step.market_event_is_positive=eventPositive;
        step.market_event_anchor_type=anchorMarker;
        step.market_event_monthly_return_pct=baseRecord.monthly_return_pct;
      }
    }
    await writeFile(replayPath,JSON.stringify(report,null,2)+'\n',{encoding:'utf8'});
    reports.push(report);
    if(eventPositive)positiveAnchors++;
    if(eventPositive&&baseRecord.status==='COMPLETE'&&report.results?.[0]?.summary?.first_accepted_at!==null&&report.results?.[0]?.summary?.first_accepted_at<anchorAt)positiveAnchorsCaptured++;
    process.stdout.write('[MONTHLY_REPLAY] '+(index+1)+'/'+allCases.length+' '+cohort+' '+symbol+
      ' '+baseRecord.status+' steps='+(report.results?.[0]?.summary?.replay_steps??0)+'\n');
  }

  const metadata=Object.fromEntries(reports.map(report=>[report.id,{window_id:report.id,market_regime:report.market_regime}]));
  const dataset=buildHistoricalLearningDataset(reports,{
    moderateMovePct:5,strongMovePct:15,reportMetadata:metadata
  });
  const metrics=evaluateHistoricalLearningMetrics(dataset,{moderateMovePct:5,strongMovePct:15});
  const split=splitHistoricalLearningRows(dataset.rows,{
    trainFraction:0.6,validationFraction:0.2,embargoMs:outcomeHorizonHours*HOUR
  });
  const allCasesComplete=records.length===allCases.length&&records.every(x=>x.status==='COMPLETE');
  const summary={
    schema_version:'RADARX_MONTHLY_HISTORICAL_REPLAY_LAB_V1',
    generated_at:new Date().toISOString(),
    source_monthly_forensics:loaded.path,
    source_schema:source.schema_version,
    source_window:source.window,
    detector_profile:detectorSpec,
    detector_replay_scope:{
      replayed_profiles:[detectorSpec.canonical],
      evaluation_mode:detectorSpec.mode,
      live_notification_simulated:detectorSpec.live_notification_simulated,
      supported_historical_profiles:Object.keys(HISTORICAL_PROFILE_INFO).map(key=>HISTORICAL_PROFILE_INFO[key].canonical),
      not_replayed_profiles:['EARLY_MOVE_RADAR','STRONG_MOVE_RADAR','ROTATION_LAG_RADAR','LIQUIDITY_ABSORPTION_RADAR','KAHIR_RADAR','DOOMSDAY_RADAR','PROFESSOR_RADAR','ALMUQAWIM_RADAR','EARLY_EXPANSION_RADAR','COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','FALCON_EYE_RADAR']
        .filter(profile=>profile!==detectorSpec.canonical),
      profiles_without_historical_adapters:['EARLY_MOVE_RADAR','LIQUIDITY_ABSORPTION_RADAR','PROFESSOR_RADAR','COIN_HUNTER_RADAR','WHALE_ACCUMULATION_RADAR','FALCON_EYE_RADAR'],
      note:detectorSpec.live_notification_simulated
        ?'This profile runs its strict/dynamic replay gate, but exact historical exchange depth and device push delivery are still not reproduced.'
        :'This report measures detector-candidate timing only. It must not be interpreted as a replay of actual accepted push notifications or as validation of unavailable historical order-book/news/futures evidence.'
    },
    label_definitions:{
      moderate_move_pct:5,strong_move_pct:15,outcome_horizon_hours:outcomeHorizonHours,
      positive_external_event:'STRONG/MEDIUM monthly cohort + confirmed 4% range-break marker + complete 24h monthly-forensics outcome',
      control_policy:'CONTROL anchors are not positive events; their replayed alerts contribute to cohort-specific false-alert analysis only.',
      exact_event_time:'The ex-post hourly anchor is not an exact trade-crossing timestamp.',
      thresholds_updated:false
    },
    coverage:{
      source_cases:allCases.length,expected_case_ids:expectedCaseIds.length,
      processed_cases:processed,complete_replays:coverageComplete,
      failed_or_skipped_cases:replayFailures,missing_or_failed_case_ids:records.filter(x=>x.status!=='COMPLETE').map(x=>x.case_id),
      positive_anchor_cases:positiveAnchors,positive_anchors_captured_before_anchor:positiveAnchorsCaptured,
      regime_counts:records.reduce((m,x)=>{const k=x.market_regime??'UNKNOWN';m[k]=(m[k]||0)+1;return m;},{}),
      complete:allCasesComplete
    },
    dataset_summary:dataset.dataset_summary,
    metrics,
    walk_forward:{
      status:split.status,temporal_order_enforced:split.temporal_order_enforced===true,no_random_split:split.no_random_split===true,
      boundaries:split.boundaries,purged_rows:split.purged_rows,embargo_ms:split.embargo_ms,
      train_count:split.train_count,validation_count:split.validation_count,test_count:split.test_count,
      metrics:{
        train:evaluateHistoricalLearningMetrics({rows:split.train_rows??[]}),
        validation:evaluateHistoricalLearningMetrics({rows:split.validation_rows??[]}),
        test:evaluateHistoricalLearningMetrics({rows:split.test_rows??[]})
      }
    },
    records,
    policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',live_threshold_updates:false}
  };
  const summaryPath=resolve(outputDir,'monthly-learning-summary.json');
  const datasetPath=resolve(outputDir,'monthly-learning-dataset.json');
  const indexPath=resolve(outputDir,'monthly-replay-index.json');
  const markdownPath=resolve(outputDir,'monthly-learning-summary.md');
  await writeFile(summaryPath,JSON.stringify(summary,null,2)+'\n',{encoding:'utf8'});
  await writeFile(datasetPath,JSON.stringify(dataset,null,2)+'\n',{encoding:'utf8'});
  await writeFile(indexPath,JSON.stringify({schema_version:'RADARX_MONTHLY_REPLAY_INDEX_V1',input:loaded.path,records},null,2)+'\n',{encoding:'utf8'});
  const markdown=[
    '# RadarX monthly historical replay lab','',
    '- Rolling monthly source cases: '+allCases.length,
    '- Complete detector replays: '+coverageComplete,
    '- Failed or skipped cases: '+replayFailures,
    '- Detector profile: '+detectorSpec.canonical+' (requested '+detectorProfile+')',
    '- Evaluation mode: '+detectorSpec.mode,
    '- Live notification delivery simulated: '+detectorSpec.live_notification_simulated,
    '- Confirmed positive ex-post anchors: '+positiveAnchors,
    '- Positive anchors with an accepted detector decision before anchor: '+positiveAnchorsCaptured,
    '- Accepted decisions / candidate detections: '+metrics.accepted_decisions,
    detectorSpec.live_notification_simulated
      ?'- Successful alerts on fully matured 5%/15% target labels: '+metrics.successful_alerts
      :'- Candidate matches on fully matured 5%/15% target labels (not push alerts): '+metrics.successful_alerts,
    detectorSpec.live_notification_simulated
      ?'- False alerts on fully observed horizons: '+metrics.false_alerts
      :'- Candidate classifications without follow-through (not measured false pushes): '+metrics.false_alerts,
    '- Missed-move decisions: '+metrics.missed_move_decisions,
    '- Unique missed positive event anchors: '+metrics.missed_move_events,
    '- Median lead time before confirmed event anchor (minutes): '+(metrics.median_lead_time_minutes??'not estimable'),
    '- Explicit-probability calibration: '+metrics.calibration.status,
    '- Walk-forward split: '+split.status+' (train '+split.train.length+', validation '+split.validation.length+', test '+split.test.length+').',
    '', 'The ex-post event anchor is only used for lead-time labels after replay. It is never passed into the evaluator.',
    detectorSpec.live_notification_simulated
      ?'This report replays the selected profile gate; it still does not simulate FCM delivery on a real handset.'
      :'Candidate-shadow results are not actionable push alerts. Historical order-book snapshots and any unavailable external inputs are not synthesized.',
    'Only the selected detector profile is evaluated in this report; the remaining radars must be tested in separate runs with their own required historical inputs.',
    ''
  ].join('\n');
  await writeFile(markdownPath,markdown,{encoding:'utf8'});
  process.stdout.write(JSON.stringify({
    summary:summaryPath,dataset:datasetPath,index:indexPath,markdown:markdownPath,
    status:allCasesComplete&&split.status==='READY'?'COMPLETE':'INCOMPLETE_OR_PARTIAL',
    coverage:summary.coverage,metrics:{
      accepted_decisions:metrics.accepted_decisions,successful_alerts:metrics.successful_alerts,
      false_alerts:metrics.false_alerts,missed_move_decisions:metrics.missed_move_decisions,
      missed_move_events:metrics.missed_move_events,median_lead_time_minutes:metrics.median_lead_time_minutes,
      calibration:metrics.calibration.status
    },
    walk_forward:{status:split.status,train:split.train.length,validation:split.validation.length,test:split.test.length},
    policy:summary.policy
  },null,2)+'\n');
  if(!allCasesComplete||split.status!=='READY'||dataset.dataset_summary.decision_rows===0)process.exitCode=2;
}
main().catch(error=>{process.stderr.write('[MONTHLY_HISTORICAL_REPLAY_LAB_ERROR] '+String(error?.stack??error)+'\n');process.exitCode=1;});
