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
function rankingSlice(rows,fraction){
  const count=Math.max(1,Math.min(rows.length,Math.ceil(rows.length*fraction)));
  const selected=rows.slice(0,count);
  const positives=selected.filter(row=>row.row.outcome==='UP').length;
  const totalPositive=rows.filter(row=>row.row.outcome==='UP').length;
  const prevalenceAll=totalPositive/Math.max(1,rows.length);
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
  const ranked=observed.map(row=>{
    const score=finite(scoreSelector(row));
    return {row,score:score===null?Number.NEGATIVE_INFINITY:score,has_score:score!==null};
  }).sort((a,b)=>b.score-a.score||stableTieBreak(a,b));
  const directional=ranked.filter(item=>item.row.outcome==='UP'||item.row.outcome==='DOWN');
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
    missing_score_samples:observed.filter(row=>finite(scoreSelector(row))===null).length,
    score_coverage_pct:observed.length
      ?Number((ranked.filter(item=>item.has_score).length/observed.length*100).toFixed(3)):0,
    auc_roc:auc===null?null:Number(auc.toFixed(6)),
    top_10_pct:ranked.length?rankingSlice(ranked,0.10):null,
    top_20_pct:ranked.length?rankingSlice(ranked,0.20):null,
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
