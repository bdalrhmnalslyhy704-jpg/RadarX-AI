function finite(value){
  if(value===null||value===undefined||value==='')return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?parsed:null;
}
function outcomeRows(rows){
  return (Array.isArray(rows)?rows:[]).filter(row=>
    row&&['UP','DOWN','FLAT'].includes(row.outcome));
}
function stableTieBreak(a,b){
  return Number(a.row.at)-Number(b.row.at)||
    String(a.row.symbol||'').localeCompare(String(b.row.symbol||''))||
    String(a.row.id||'').localeCompare(String(b.row.id||''));
}
function rankingSlice(rows,fraction,totalOutcomeCount){
  const count=Math.max(1,Math.min(rows.length,Math.ceil(rows.length*fraction)));
  const selected=rows.slice(0,count);
  const positives=selected.filter(row=>row.row.outcome==='UP').length;
  const totalPositive=rows.filter(row=>row.row.outcome==='UP').length;
  const prevalenceAll=totalPositive/Math.max(1,totalOutcomeCount);
  const directionalCount=rows.filter(row=>row.row.outcome==='UP'||row.row.outcome==='DOWN').length;
  const prevalenceDirectional=totalPositive/Math.max(1,directionalCount);
  const precision=positives/count;
  const recall=totalPositive?positives/totalPositive:null;
  return {
    selected_count:count,positive_count:positives,
    precision_pct:Number((precision*100).toFixed(3)),
    recall_pct:recall===null?null:Number((recall*100).toFixed(3)),
    lift_vs_all_outcome_prevalence:prevalenceAll>0?Number((precision/prevalenceAll).toFixed(5)):null,
    lift_vs_directional_prevalence:prevalenceDirectional>0
      ?Number((precision/prevalenceDirectional).toFixed(5)):null
  };
}

/**
 * Evaluate a frozen, non-probabilistic ranking signal on a fixed chronological
 * slice. FLAT is excluded from AUC pairs but retained in the all-outcome
 * prevalence denominator to stay comparable with the cognitive model's
 * existing ranking diagnostics. Missing scores are kept at the bottom,
 * never silently dropped from recall or coverage denominators.
 */
export function evaluateFrozenRankingSignal(rows,scoreSelector){
  if(typeof scoreSelector!=='function')throw new Error('SCORE_SELECTOR_REQUIRED');
  const observed=outcomeRows(rows);
  const scored=observed.map(row=>{
    const score=finite(scoreSelector(row));
    return {row,score:score===null?Number.NEGATIVE_INFINITY:score,has_score:score!==null};
  });
  const ranked=scored.filter(item=>item.row.outcome==='UP'||item.row.outcome==='DOWN')
    .sort((a,b)=>b.score-a.score||stableTieBreak(a,b));
  const directional=ranked;
  const positives=directional.filter(item=>item.row.outcome==='UP').length;
  const negatives=directional.length-positives;
  // Mann-Whitney/rank-sum AUC with average ranks for ties, O(n log n).
  const ascending=directional.slice().sort((a,b)=>a.score-b.score||stableTieBreak(a,b));
  let positiveRankSum=0;
  for(let start=0;start<ascending.length;){
    let end=start+1;
    while(end<ascending.length&&ascending[end].score===ascending[start].score)end++;
    const averageRank=((start+1)+end)/2;
    let groupPositive=0;
    for(let index=start;index<end;index++)
      if(ascending[index].row.outcome==='UP')groupPositive++;
    positiveRankSum+=groupPositive*averageRank;
    start=end;
  }
  const pairs=positives*negatives;
  const auc=pairs>0
    ?(positiveRankSum-positives*(positives+1)/2)/pairs:null;
  return {
    evaluated:observed.length>0,
    sample_count:observed.length,
    directional_sample_count:directional.length,
    positive_samples:positives,negative_samples:negatives,
    missing_score_samples:scored.filter(item=>!item.has_score).length,
    score_coverage_pct:observed.length
      ?Number((scored.filter(item=>item.has_score).length/observed.length*100).toFixed(3)):0,
    directional_score_coverage_pct:directional.length
      ?Number((directional.filter(item=>item.has_score).length/directional.length*100).toFixed(3)):0,
    auc_roc:auc===null?null:Number(auc.toFixed(6)),
    top_10_pct:ranked.length?rankingSlice(ranked,0.10,observed.length):null,
    top_20_pct:ranked.length?rankingSlice(ranked,0.20,observed.length):null,
    score_direction:'HIGHER_IS_MORE_BULLISH',
    no_probability_calibration_claim:true
  };
}

/**
 * Produces apples-to-apples rankings for the existing deterministic engine:
 * raw score, score with explicit LATE_MOVE exclusion, early-setup-only gate,
 * and a simple 1h momentum baseline. All use identical rows and labels.
 */
export function evaluateExistingEngineBaselines(rows){
  const observed=outcomeRows(rows);
  return {
    current_engine_base_score:evaluateFrozenRankingSignal(observed,row=>row.base_score),
    current_engine_score_excluding_late_move:evaluateFrozenRankingSignal(
      observed,row=>String(row.tier||'').toUpperCase()==='LATE_MOVE'?null:row.base_score
    ),
    existing_early_setup_gate:evaluateFrozenRankingSignal(
      observed,row=>String(row.tier||'').toUpperCase()==='EARLY_SETUP'?row.base_score:null
    ),
    simple_hourly_momentum:evaluateFrozenRankingSignal(
      observed,row=>row.features?.hourly_return_pct
    )
  };
}

/**
 * Serialize structured audit rows as valid JSON Lines. A literal "\\n" is
 * not a line break; use the newline character so each record can be parsed
 * independently by downstream audit tooling.
 */
export function serializeJsonlRows(rows) {
  const values=Array.isArray(rows)?rows:[];
  if(values.length===0)return '';
  return values.map(row=>{
    const encoded=JSON.stringify(row);
    if(typeof encoded!=='string')throw new Error('JSONL_ROW_NOT_SERIALIZABLE');
    return encoded;
  }).join(String.fromCharCode(10))+String.fromCharCode(10);
}


/**
 * Measures detection of +5/+10/+15% moves reached before a -2% adverse
 * excursion within four hours. Ambiguous same-bar target/stop events are
 * excluded; missing scores remain at the bottom so misses are not hidden.
 */
export function evaluateForwardMoveDiscovery(rows,scoreSelector){
  if(typeof scoreSelector!=='function')throw new Error('SCORE_SELECTOR_REQUIRED');
  const thresholds=[5,10,15];
  const result={method:'15M_FIRST_PASSAGE_UPSIDE_BEFORE_MINUS_2_STOP_V1',
    horizon_ms:4*60*60*1000,bar_interval_ms:15*60*1000,
    score_direction:'HIGHER_IS_MORE_BULLISH',thresholds:{}};
  for(const threshold of thresholds){
    const key=String(threshold);
    const candidates=(Array.isArray(rows)?rows:[]).map(row=>({
      row,label:row?.forward_move_thresholds?.[key]||null,
      score:finite(scoreSelector(row))
    })).filter(item=>item.row&&item.label&&
      ['HIT_BEFORE_MINUS_2_STOP','MINUS_2_STOP_FIRST','NOT_REACHED_WITHIN_4H',
        'AMBIGUOUS_BOTH_LEVELS_SAME_CANDLE'].includes(item.label.status));
    const ambiguous=candidates.filter(item=>item.label.status==='AMBIGUOUS_BOTH_LEVELS_SAME_CANDLE').length;
    const eligible=candidates.filter(item=>item.label.status!=='AMBIGUOUS_BOTH_LEVELS_SAME_CANDLE')
      .sort((a,b)=>(b.score??Number.NEGATIVE_INFINITY)-(a.score??Number.NEGATIVE_INFINITY)||
        Number(a.row.at)-Number(b.row.at)||
        String(a.row.symbol||'').localeCompare(String(b.row.symbol||''))||
        String(a.row.id||'').localeCompare(String(b.row.id||'')));
    const positives=eligible.filter(item=>item.label.status==='HIT_BEFORE_MINUS_2_STOP');
    const times=positives.map(item=>Number(item.label.time_to_hit_ms)/60_000)
      .filter(value=>Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
    const quantile=(values,q)=>values.length?values[Math.min(values.length-1,
      Math.max(0,Math.ceil(values.length*q)-1))]:null;
    const median=values=>quantile(values,0.5);
    const top=(fraction)=>{
      if(!eligible.length)return {selected_count:0,detected_count:0,false_candidate_count:0,
        missed_move_count:positives.length,precision_pct:null,recall_pct:null,
        false_candidate_rate_pct:null,score_coverage_pct:0,
        detected_median_time_to_hit_minutes:null};
      const count=Math.max(1,Math.ceil(eligible.length*fraction));
      const selected=eligible.slice(0,count);
      const detected=selected.filter(item=>item.label.status==='HIT_BEFORE_MINUS_2_STOP');
      const falseCandidates=count-detected.length;
      const detectedTimes=detected.map(item=>Number(item.label.time_to_hit_ms)/60_000)
        .filter(value=>Number.isFinite(value)&&value>=0).sort((a,b)=>a-b);
      return {
        selected_count:count,detected_count:detected.length,
        false_candidate_count:falseCandidates,
        missed_move_count:Math.max(0,positives.length-detected.length),
        precision_pct:Number((detected.length/count*100).toFixed(3)),
        recall_pct:positives.length?Number((detected.length/positives.length*100).toFixed(3)):null,
        false_candidate_rate_pct:Number((falseCandidates/count*100).toFixed(3)),
        score_coverage_pct:Number((selected.filter(item=>item.score!==null).length/count*100).toFixed(3)),
        detected_median_time_to_hit_minutes:median(detectedTimes)
      };
    };
    result.thresholds[key]={
      threshold_pct:threshold,
      candidate_rows:candidates.length,
      eligible_rows:eligible.length,
      positive_moves_before_stop:positives.length,
      stop_first_count:eligible.filter(item=>item.label.status==='MINUS_2_STOP_FIRST').length,
      not_reached_count:eligible.filter(item=>item.label.status==='NOT_REACHED_WITHIN_4H').length,
      ambiguous_excluded_count:ambiguous,
      event_rate_pct:eligible.length?Number((positives.length/eligible.length*100).toFixed(3)):null,
      median_time_to_hit_minutes:median(times),
      p25_time_to_hit_minutes:quantile(times,0.25),
      p75_time_to_hit_minutes:quantile(times,0.75),
      top_10_pct:top(0.10),
      top_20_pct:top(0.20),
      total_missed_if_ranked_top_10:top(0.10).missed_move_count,
      score_coverage_pct:eligible.length?Number((eligible.filter(item=>item.score!==null).length/eligible.length*100).toFixed(3)):0
    };
  }
  result.evaluated=Object.values(result.thresholds).some(row=>row.eligible_rows>0);
  result.sample_count=Math.max(0,...Object.values(result.thresholds).map(row=>row.eligible_rows));
  return result;
}
