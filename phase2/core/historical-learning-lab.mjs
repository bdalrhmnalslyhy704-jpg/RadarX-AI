export const HISTORICAL_LEARNING_LAB_DEFAULTS=Object.freeze({
  moderate_move_pct:5,
  strong_move_pct:15,
  max_drawdown_pct:3,
  outcome_horizon_ms:24*60*60*1000,
  train_fraction:0.6,
  validation_fraction:0.2,
  embargo_ms:24*60*60*1000
});

const finite=value=>{
  if(value===null||value===undefined||value===''||typeof value==='boolean')return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
};
const arr=value=>Array.isArray(value)?value:[];
const clamp=(value,min,max,fallback)=>{
  const n=finite(value);
  return n===null?fallback:Math.max(min,Math.min(max,n));
};
const median=values=>{
  const xs=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!xs.length)return null;
  const mid=Math.floor(xs.length/2);
  return xs.length%2?xs[mid]:(xs[mid-1]+xs[mid])/2;
};
const mean=values=>{
  const xs=values.map(Number).filter(Number.isFinite);
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
};
const pct=(n,d)=>d>0?Number((n/d*100).toFixed(4)):null;
const normSymbol=value=>String(value??'').trim().toUpperCase();
const timeOf=row=>finite(row?.timestamp??row?.decision_at??row?.at);
const regimeOf=(row,fallback='UNKNOWN')=>String(row?.market_regime??row?.regime??fallback??'UNKNOWN').toUpperCase();

function integrityIssues(row){
  const issues=[];
  const at=timeOf(row);
  const inputClose=finite(row?.input_max_candle_close_at);
  const tradeTo=finite(row?.trade_window?.to_exclusive);
  if(at===null)issues.push('DECISION_TIMESTAMP_MISSING');
  if(inputClose===null)issues.push('INPUT_CANDLE_WATERMARK_MISSING');
  else if(at!==null&&inputClose>at)issues.push('FUTURE_CANDLE_LEAKAGE');
  if(tradeTo!==null&&at!==null&&tradeTo>at)issues.push('FUTURE_TRADE_WINDOW_LEAKAGE');
  if(row?.outcome?.is_future_data_for_scoring!==false)issues.push('OUTCOME_ISOLATION_NOT_PROVEN');
  if(!normSymbol(row?.symbol))issues.push('SYMBOL_MISSING');
  return issues;
}

export function classifyHistoricalLearningRow(row={},{
  moderateMovePct=HISTORICAL_LEARNING_LAB_DEFAULTS.moderate_move_pct,
  strongMovePct=HISTORICAL_LEARNING_LAB_DEFAULTS.strong_move_pct
}={}){
  const moderate=clamp(moderateMovePct,0.1,500,HISTORICAL_LEARNING_LAB_DEFAULTS.moderate_move_pct);
  const strong=Math.max(moderate,clamp(strongMovePct,0.1,1000,HISTORICAL_LEARNING_LAB_DEFAULTS.strong_move_pct));
  const issues=integrityIssues(row);
  const outcome=row?.outcome??{};
  const move=finite(outcome.forward_max_upside_pct_from_decision);
  const horizonObserved=outcome.horizon_observed===true;
  const accepted=String(row?.decision??'').toUpperCase()==='ACCEPTED';
  const acceptedMode=String(row?.accepted_mode??'').toUpperCase();
  const hasEarlyStage=/EARLY|PRE_EXPANSION|PRE_BREAKOUT|WATCH/.test(String(row?.stage_observed??'').toUpperCase())||
    /EARLY|PRE_EXPANSION/.test(acceptedMode);
  let outcomeClass='OUTCOME_UNAVAILABLE',moveClass='UNKNOWN';
  if(issues.length){
    outcomeClass='DATA_INTEGRITY_REJECTED';
  }else if(move!==null&&move>=strong){
    moveClass='STRONG_MOVE';
    outcomeClass=accepted?'EARLY_SIGNAL_SUCCESS':'MISSED_MOVE_DECISION';
  }else if(move!==null&&move>=moderate){
    moveClass='MODERATE_MOVE';
    outcomeClass=accepted?'EARLY_SIGNAL_SUCCESS':'MISSED_MOVE_DECISION';
  }else if(horizonObserved&&move!==null){
    moveClass='NO_TARGET_MOVE';
    outcomeClass=accepted?(hasEarlyStage?'EARLY_SIGNAL_FAILED':'FALSE_ALERT'):'CORRECT_REJECTION';
  }
  const calibratedProbability=finite(row?.calibrated_probability??row?.confidence_probability);
  const probabilityValid=calibratedProbability!==null&&calibratedProbability>=0&&calibratedProbability<=1;
  const success=moveClass==='STRONG_MOVE'||moveClass==='MODERATE_MOVE';
  return {
    symbol:normSymbol(row?.symbol),
    timestamp:timeOf(row),
    window_id:String(row?.window_id??row?.windowId??row?.report_window_id??'UNSPECIFIED_WINDOW'),
    radar:String(row?.radar??row?.radar_id??row?.radar_name??'UNKNOWN_RADAR').slice(0,80),
    market_regime:regimeOf(row),
    decision:accepted?'ACCEPTED':'REJECTED',
    accepted_mode:String(row?.accepted_mode??'NONE').slice(0,60),
    score:finite(row?.score),
    move_class:moveClass,
    outcome_class:outcomeClass,
    horizon_observed:horizonObserved,
    forward_max_upside_pct_from_decision:move,
    max_adverse_excursion_pct_from_decision:finite(outcome.max_adverse_excursion_pct_from_decision),
    max_adverse_excursion_before_moderate_target_pct:finite(outcome.max_adverse_excursion_before_moderate_target_pct),
    minutes_to_moderate_target:finite(outcome.minutes_to_moderate_target),
    minutes_to_strong_target:finite(outcome.minutes_to_strong_target),
    actual_window_moderate_target_at:finite(outcome.actual_window_moderate_target_candle_close_at??outcome.actual_window_5pct_candle_close_at),
    actual_window_strong_target_at:finite(outcome.actual_window_strong_target_candle_close_at??outcome.actual_window_15pct_candle_close_at),
    actual_window_moderate_target_exact_at:finite(outcome.actual_window_moderate_target_at??outcome.actual_window_5pct_at),
    target_timestamp_source:String(outcome.actual_window_moderate_target_timestamp_source??outcome.actual_window_5pct_timestamp_source??'UNAVAILABLE'),
    calibrated_probability:probabilityValid?calibratedProbability:null,
    success_label:issues.length?null:success,
    integrity_issues:issues
  };
}

function extractReportRows(report,metadata={}){
  const reportWindow=report?.window??report?.range??{};
  const results=arr(report?.results);
  const output=[];
  for(const result of results){
    const steps=arr(result?.steps);
    const windowId=String(metadata.window_id??report?.window_id??report?.id??reportWindow?.id??reportWindow?.start_time??reportWindow?.start??'UNSPECIFIED_WINDOW');
    for(const row of steps){
      output.push({
        ...row,
        symbol:row?.symbol??result?.symbol,
        radar:row?.radar??metadata.radar??'STRONG_MOVE_RADAR',
        window_id:row?.window_id??windowId,
        market_regime:row?.market_regime??metadata.market_regime??report?.market_regime??'UNKNOWN',
        timestamp:row?.timestamp??row?.decision_at,
        outcome:{...(row?.outcome??{}),
          actual_window_5pct_candle_close_at:row?.outcome?.actual_window_5pct_candle_close_at??result?.summary?.first_actual_window_5pct_candle_close_at,
          actual_window_15pct_candle_close_at:row?.outcome?.actual_window_15pct_candle_close_at??result?.summary?.first_actual_window_15pct_candle_close_at,
          actual_window_5pct_at:row?.outcome?.actual_window_5pct_at??result?.summary?.first_actual_window_5pct_at,
          actual_window_15pct_at:row?.outcome?.actual_window_15pct_at??result?.summary?.first_actual_window_15pct_at
        }
      });
    }
  }
  return output;
}

export function buildHistoricalLearningDataset(reports=[],{
  moderateMovePct=HISTORICAL_LEARNING_LAB_DEFAULTS.moderate_move_pct,
  strongMovePct=HISTORICAL_LEARNING_LAB_DEFAULTS.strong_move_pct,
  reportMetadata={}
}={}){
  const rows=[];
  for(const report of arr(reports)){
    const metadata=reportMetadata?.[String(report?.id??report?.window?.id??report?.window?.start??'')]??{};
    rows.push(...extractReportRows(report,metadata));
  }
  const classified=rows.map(row=>classifyHistoricalLearningRow(row,{moderateMovePct,strongMovePct}));
  const byDecisionTime=classified.slice().sort((a,b)=>(a.timestamp??Infinity)-(b.timestamp??Infinity)||a.symbol.localeCompare(b.symbol));
  const counts={STRONG_MOVE:0,MODERATE_MOVE:0,NO_TARGET_MOVE:0,UNKNOWN:0};
  const decisions={EARLY_SIGNAL_SUCCESS:0,EARLY_SIGNAL_FAILED:0,FALSE_ALERT:0,MISSED_MOVE_DECISION:0,CORRECT_REJECTION:0,OUTCOME_UNAVAILABLE:0,DATA_INTEGRITY_REJECTED:0};
  for(const row of classified){
    counts[row.move_class]=(counts[row.move_class]??0)+1;
    decisions[row.outcome_class]=(decisions[row.outcome_class]??0)+1;
  }
  return {
    schema_version:'RADARX_HISTORICAL_LEARNING_DATASET_V1',
    generated_at:new Date().toISOString(),
    rows:byDecisionTime,
    dataset_summary:{
      decision_rows:byDecisionTime.length,
      integrity_rejected_rows:byDecisionTime.filter(x=>x.integrity_issues.length>0).length,
      outcome_labeled_rows:byDecisionTime.filter(x=>['STRONG_MOVE','MODERATE_MOVE','NO_TARGET_MOVE'].includes(x.move_class)).length,
      outcome_unavailable_rows:byDecisionTime.filter(x=>x.outcome_class==='OUTCOME_UNAVAILABLE').length,
      move_class_counts:counts,
      decision_outcome_counts:decisions,
      thresholds:{moderate_move_pct:Math.max(0.1,Number(moderateMovePct)||5),strong_move_pct:Math.max(Number(moderateMovePct)||5,Number(strongMovePct)||15)},
      notes:[
        'Move thresholds are explicit test definitions, not learned findings.',
        'A rejected step during a later move is a missed-move decision, not automatically a unique missed market event.',
        'Scores are not treated as probabilities unless a separate calibrated_probability or confidence_probability field is present.',
        'Rows with look-ahead or unproven future-data isolation are excluded from metric denominators.'
      ]
    },
    policy:{market:'BINANCE_SPOT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN',live_threshold_updates:false}
  };
}

function validMetricRows(dataset){
  return arr(dataset?.rows).filter(row=>row.integrity_issues?.length===0&&row.outcome_class!=='OUTCOME_UNAVAILABLE'&&row.timestamp!==null);
}

function groupMarketEvents(rows,moderateMovePct,strongMovePct){
  const groups=new Map();
  for(const row of rows){
    const eventAt=row.actual_window_moderate_target_at;
    const strongAt=row.actual_window_strong_target_at;
    const key=row.window_id+'|'+row.symbol;
    if(!groups.has(key))groups.set(key,{key,window_id:row.window_id,symbol:row.symbol,moderate_at:eventAt,strong_at:strongAt,rows:[]});
    const group=groups.get(key);
    if(group.moderate_at===null&&eventAt!==null)group.moderate_at=eventAt;
    if(group.strong_at===null&&strongAt!==null)group.strong_at=strongAt;
    group.rows.push(row);
  }
  return [...groups.values()].map(group=>{
    const moderate=group.moderate_at!==null;
    const strong=group.strong_at!==null;
    const eventAt=group.moderate_at??group.strong_at;
    const before=eventAt===null?[]:group.rows.filter(row=>row.decision==='ACCEPTED'&&row.timestamp<eventAt);
    const first=before.sort((a,b)=>a.timestamp-b.timestamp)[0]??null;
    const exactSource=group.rows.find(row=>row.target_timestamp_source==='BINANCE_PUBLIC_AGG_TRADES')!==undefined;
    return {
      event_id:group.key,
      symbol:group.symbol,window_id:group.window_id,
      move_class:strong?'STRONG_MOVE':moderate?'MODERATE_MOVE':'NO_OBSERVED_TARGET',
      event_at:eventAt,
      exact_event_time_available:exactSource,
      first_accepted_before_event_at:first?.timestamp??null,
      captured_before_event:Boolean(first),
      lead_time_minutes:first&&eventAt!==null?Number(((eventAt-first.timestamp)/60000).toFixed(2)):null,
      decision_rows:group.rows.length
    };
  });
}

export function evaluateHistoricalLearningMetrics(dataset,{moderateMovePct=5,strongMovePct=15,calibrationBins=10}={}){
  const all=arr(dataset?.rows);
  const evaluable=validMetricRows(dataset);
  const accepted=evaluable.filter(row=>row.decision==='ACCEPTED');
  const alertsWithMove=accepted.filter(row=>row.success_label===true);
  const falseAlerts=accepted.filter(row=>row.success_label===false);
  const missedMoveDecisions=evaluable.filter(row=>row.decision==='REJECTED'&&row.success_label===true);
  const events=groupMarketEvents(evaluable,moderateMovePct,strongMovePct).filter(event=>event.event_at!==null);
  const captured=events.filter(event=>event.captured_before_event);
  const misses=events.filter(event=>!event.captured_before_event);
  const leadTimes=captured.map(event=>event.lead_time_minutes).filter(Number.isFinite);
  const drawdowns=accepted.map(row=>row.max_adverse_excursion_pct_from_decision).filter(Number.isFinite);
  const preTargetDrawdowns=alertsWithMove.map(row=>row.max_adverse_excursion_before_moderate_target_pct).filter(Number.isFinite);
  const calibrationRows=evaluable.filter(row=>row.calibrated_probability!==null&&row.success_label!==null);
  const bins=Array.from({length:Math.max(2,Math.min(50,Math.trunc(Number(calibrationBins)||10)))},(_,index)=>({index,lower:index/Math.max(2,Math.min(50,Math.trunc(Number(calibrationBins)||10))),upper:(index+1)/Math.max(2,Math.min(50,Math.trunc(Number(calibrationBins)||10))),count:0,probability_sum:0,successes:0}));
  let brierSum=0;
  for(const row of calibrationRows){
    const p=row.calibrated_probability,y=row.success_label?1:0;
    brierSum+=(p-y)**2;
    const index=Math.min(bins.length-1,Math.floor(p*bins.length));
    bins[index].count++;bins[index].probability_sum+=p;bins[index].successes+=y;
  }
  const populated=bins.filter(bin=>bin.count>0).map(bin=>({
    ...bin,mean_probability:Number((bin.probability_sum/bin.count).toFixed(6)),
    observed_success_rate:Number((bin.successes/bin.count).toFixed(6)),
    absolute_calibration_error:Number(Math.abs(bin.probability_sum/bin.count-bin.successes/bin.count).toFixed(6))
  }));
  const ece=calibrationRows.length?populated.reduce((sum,bin)=>sum+bin.count/calibrationRows.length*bin.absolute_calibration_error,0):null;
  const byRadar={};
  const byRegime={};
  for(const row of evaluable){
    const radar=row.radar||'UNKNOWN_RADAR',regime=row.market_regime||'UNKNOWN';
    if(!byRadar[radar])byRadar[radar]={rows:0,accepted:0,successes:0,false_alerts:0,missed_move_decisions:0,unavailable:0};
    const rr=byRadar[radar];rr.rows++;if(row.decision==='ACCEPTED')rr.accepted++;
    if(row.outcome_class==='EARLY_SIGNAL_SUCCESS')rr.successes++;
    if(['FALSE_ALERT','EARLY_SIGNAL_FAILED'].includes(row.outcome_class))rr.false_alerts++;
    if(row.outcome_class==='MISSED_MOVE_DECISION')rr.missed_move_decisions++;
    if(!row.horizon_observed)rr.unavailable++;
    if(!byRegime[regime])byRegime[regime]={rows:0,accepted:0,successful_alerts:0,false_alerts:0,missed_move_decisions:0};
    const rg=byRegime[regime];rg.rows++;if(row.decision==='ACCEPTED')rg.accepted++;
    if(row.outcome_class==='EARLY_SIGNAL_SUCCESS')rg.successful_alerts++;
    if(['FALSE_ALERT','EARLY_SIGNAL_FAILED'].includes(row.outcome_class))rg.false_alerts++;
    if(row.outcome_class==='MISSED_MOVE_DECISION')rg.missed_move_decisions++;
  }
  for(const [radar,value] of Object.entries(byRadar)){
    value.precision_pct=pct(value.successes,value.successes+value.false_alerts);
    value.false_alert_rate_pct=pct(value.false_alerts,value.successes+value.false_alerts);
  }
  for(const value of Object.values(byRegime)){
    value.precision_pct=pct(value.successful_alerts,value.successful_alerts+value.false_alerts);
  }
  return {
    schema_version:'RADARX_HISTORICAL_LEARNING_METRICS_V1',
    dataset_rows:all.length,evaluable_decisions:evaluable.length,
    outcome_coverage_pct:pct(evaluable.length,Math.max(1,all.length)),
    accepted_decisions:accepted.length,
    successful_alerts:alertsWithMove.length,
    false_alerts:falseAlerts.length,
    early_signal_failed:accepted.filter(row=>row.outcome_class==='EARLY_SIGNAL_FAILED').length,
    missed_move_decisions:missedMoveDecisions.length,
    correct_rejections:evaluable.filter(row=>row.outcome_class==='CORRECT_REJECTION').length,
    precision_pct:pct(alertsWithMove.length,accepted.length),
    false_alert_rate_pct:pct(falseAlerts.length+accepted.filter(row=>row.outcome_class==='EARLY_SIGNAL_FAILED').length,accepted.length),
    missed_move_events:misses.length,
    observed_move_events:events.length,
    move_event_capture_pct:pct(captured.length,events.length),
    median_lead_time_minutes:median(leadTimes),
    mean_lead_time_minutes:mean(leadTimes),
    median_max_drawdown_pct:median(drawdowns),
    worst_max_drawdown_pct:drawdowns.length?Math.min(...drawdowns):null,
    median_drawdown_before_target_pct:median(preTargetDrawdowns),
    calibration:{
      status:calibrationRows.length?'ESTIMATED_FROM_EXPLICIT_PROBABILITIES':'NOT_ESTIMABLE_NO_EXPLICIT_PROBABILITY',
      samples:calibrationRows.length,
      brier_score:calibrationRows.length?Number((brierSum/calibrationRows.length).toFixed(6)):null,
      expected_calibration_error:ece===null?null:Number(ece.toFixed(6)),
      bins:populated.map(bin=>({lower:bin.lower,upper:bin.upper,count:bin.count,mean_probability:bin.mean_probability,observed_success_rate:bin.observed_success_rate,absolute_calibration_error:bin.absolute_calibration_error}))
    },
    by_radar:byRadar,
    by_market_regime:byRegime,
    market_events:events,
    limitations:[
      'Precision is computed only for accepted decisions with a fully observed outcome horizon.',
      'Missed-move decisions are decision-level counts; unique missed events are counted separately by symbol and replay window.',
      'An exact event timestamp is reported only when complete public aggregate-trade coverage exists; closed-candle close time is separately tracked.',
      'The evaluator receives no forward candles. Forward outcome fields are post-decision labels only.',
      'No live radar threshold is changed by this report.'
    ]
  };
}

function temporalSplit(rows,{trainFraction=0.6,validationFraction=0.2,embargoMs=HISTORICAL_LEARNING_LAB_DEFAULTS.embargo_ms??24*60*60*1000}={}){
  const sorted=arr(rows).filter(row=>timeOf(row)!==null).slice().sort((a,b)=>timeOf(a)-timeOf(b));
  const uniqueTimes=[...new Set(sorted.map(timeOf))].sort((a,b)=>a-b);
  if(uniqueTimes.length<3)return {status:'INSUFFICIENT_TEMPORAL_COVERAGE',train:[],validation:[],test:[],boundaries:null,purged_rows:0};
  const train=clamp(trainFraction,0.1,0.8,0.6);
  const valid=clamp(validationFraction,0.1,0.5,0.2);
  if(train+valid>=0.95)throw new Error('TEMPORAL_SPLIT_FRACTIONS_INVALID');
  const trainIndex=Math.max(1,Math.min(uniqueTimes.length-2,Math.floor(uniqueTimes.length*train)));
  const testIndex=Math.max(trainIndex+1,Math.min(uniqueTimes.length-1,Math.floor(uniqueTimes.length*(train+valid))));
  const validationStart=uniqueTimes[trainIndex],testStart=uniqueTimes[testIndex];
  const trainEnd=validationStart-1,validationEnd=testStart-1;
  const split={
    train:[],validation:[],test:[],boundaries:{train_start:uniqueTimes[0],train_end:trainEnd,validation_start:validationStart,validation_end:validationEnd,test_start:testStart,test_end:uniqueTimes.at(-1)},
    purged_rows:0,embargo_ms:Math.max(0,Number(embargoMs)||0)
  };
  for(const row of sorted){
    const at=timeOf(row),horizon=Math.max(0,finite(row?.outcome?.horizon_ms)??0);
    const labelEnd=at+horizon;
    if(at<validationStart){
      if(labelEnd+split.embargo_ms>=validationStart){split.purged_rows++;continue;}
      split.train.push(row);
    }else if(at<testStart){
      if(labelEnd+split.embargo_ms>=testStart){split.purged_rows++;continue;}
      split.validation.push(row);
    }else{
      split.test.push(row);
    }
  }
  return {
    status:split.train.length&&split.validation.length&&split.test.length?'READY':'INSUFFICIENT_AFTER_PURGE',
    train:split.train,validation:split.validation,test:split.test,
    boundaries:split.boundaries,purged_rows:split.purged_rows,embargo_ms:split.embargo_ms,
    no_random_split:true,temporal_order_enforced:true
  };
}

export function splitHistoricalLearningRows(rows,options={}){
  const result=temporalSplit(rows,options);
  return {...result,train_count:result.train.length,validation_count:result.validation.length,test_count:result.test.length,
    train:result.train.map(row=>row.timestamp),validation:result.validation.map(row=>row.timestamp),test:result.test.map(row=>row.timestamp)};
}

export function auditHistoricalMatrixCoverage(matrixReport,{expectedSymbols=[],expectedWindows=[],requiredRegimes=['BULL_TREND','BEAR_TREND','SIDEWAYS']}={}){
  const windows=arr(matrixReport?.windows??matrixReport?.window_reports);
  const symbols=[...new Set(arr(expectedSymbols).map(normSymbol).filter(Boolean))];
  const windowsWanted=[...new Set(arr(expectedWindows).map(x=>String(typeof x==='object'?(x.id??x.window_id??x.start??''):x)).filter(Boolean))];
  const seenPairs=new Set(),missingPairs=[];
  const windowById=new Map(windows.map(w=>[String(w.id??w.window_id??w.window?.id??w.window?.start??w.window?.start_time??''),w]));
  const regimes=new Set(windows.map(w=>String(w.market_regime?.regime??w.market_regime??'UNKNOWN').toUpperCase()));
  for(const symbol of symbols){
    for(const id of windowsWanted){
      const w=windowById.get(id);
      const rows=arr(w?.report?.results??w?.results);
      const found=rows.find(x=>normSymbol(x.symbol)===symbol);
      if(found&&found.data_quality?.candle_fetch_complete===true&&found.data_quality?.synthetic_data_used===false&&['FULL_TRADE','CANDLE_ONLY_FALLBACK'].includes(found.data_quality?.replay_mode)){
        seenPairs.add(symbol+'|'+id);
      }else missingPairs.push({symbol,window_id:id,reason:found?'DATA_COVERAGE_INVALID':'SYMBOL_WINDOW_RESULT_MISSING'});
    }
  }
  const expectedPairCount=symbols.length*windowsWanted.length;
  const missingRegimes=requiredRegimes.map(x=>String(x).toUpperCase()).filter(x=>!regimes.has(x));
  return {
    status:missingPairs.length?'INCOMPLETE_OR_PARTIAL':missingRegimes.length?'INCOMPLETE_REGIME_COVERAGE':'COMPLETE',
    expected_symbols:symbols.length,expected_windows:windowsWanted.length,expected_symbol_window_pairs:expectedPairCount,
    covered_symbol_window_pairs:seenPairs.size,missing_symbol_window_pairs:missingPairs.length,missing_pairs:missingPairs.slice(0,500),
    regimes_observed:[...regimes].sort(),required_regimes:requiredRegimes,missing_required_regimes:missingRegimes,
    complete:missingPairs.length===0&&missingRegimes.length===0
  };
}

function _unusedPlaceholder(){return null;}
