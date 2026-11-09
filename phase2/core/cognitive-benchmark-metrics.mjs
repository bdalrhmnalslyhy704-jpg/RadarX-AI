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
 * Audit two distinct data contracts:
 * 1) closed-candle feature samples, usable by the MLP/GBDT cognitive models;
 * 2) complete 24x29 temporal tensors, additionally required by the TCN.
 *
 * A missing/incomplete tensor is reported as a temporal exclusion, not as a
 * corrupt price label. Rows with invalid identities, labels, horizons or
 * feature payloads remain hard failures. The temporal cohort is returned as
 * an explicit intersection so all model-family comparisons can still use the
 * exact same outer sample identities.
 */
export function auditCognitiveTrainingSampleCohorts(rows, {
  targetDefinition,
  outcomeSource = 'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1',
  horizonMs = 4 * 60 * 60 * 1000,
  sequenceSteps = 24,
  sequenceChannels = 29,
  maxAbsoluteSequenceValue = 4
} = {}) {
  const featureSamples = [];
  const temporalSamples = [];
  const seenIds = new Set();
  const seenBaselines = new Set();
  const bySymbol = new Map();
  const reasonCounts = {};
  const invalidExamples = [];
  const sequenceExclusions = {
    missing: 0,
    invalid_shape: 0,
    non_finite: 0,
    out_of_range: 0
  };
  let duplicateIds = 0;
  let duplicateBaselines = 0;
  const increment = (map, key) => { map[key] = (map[key] || 0) + 1; };
  const safeFinite = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const isPlainFeatures = value => value && typeof value === 'object' &&
    !Array.isArray(value);
  const isValidFeatureLabel = row => {
    const reasons = [];
    const id = String(row?.id || '');
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    const at = safeFinite(row?.at);
    const resolvedAt = safeFinite(row?.resolved_at);
    if (row?.training_eligible !== true) reasons.push('TRAINING_NOT_ELIGIBLE');
    if (row?.historical_baseline !== true) reasons.push('NOT_HISTORICAL_BASELINE');
    if (row?.target_definition !== targetDefinition) reasons.push('TARGET_DEFINITION_MISMATCH');
    if (row?.outcome_source !== outcomeSource) reasons.push('OUTCOME_SOURCE_MISMATCH');
    if (!['UP', 'DOWN', 'FLAT'].includes(row?.outcome)) reasons.push('OUTCOME_INVALID');
    if (row?.first_passage?.path_resolution !== '15M') reasons.push('FIRST_PASSAGE_RESOLUTION_INVALID');
    if (row?.first_passage?.outcome !== row?.outcome) reasons.push('FIRST_PASSAGE_OUTCOME_MISMATCH');
    if (!id) reasons.push('SAMPLE_ID_MISSING');
    if (!/^[A-Z0-9]{5,30}$/.test(symbol)) reasons.push('SYMBOL_INVALID');
    if (at === null || at <= 0) reasons.push('BASELINE_TIME_INVALID');
    if (resolvedAt === null || at === null || resolvedAt - at !== horizonMs)
      reasons.push('RESOLUTION_HORIZON_MISMATCH');
    if (safeFinite(row?.horizon_ms) !== horizonMs) reasons.push('HORIZON_FIELD_MISMATCH');
    if (!isPlainFeatures(row?.features)) reasons.push('FEATURE_PAYLOAD_INVALID');
    return {valid: reasons.length === 0, reasons, id, symbol, at};
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const checked = isValidFeatureLabel(row);
    if (!checked.valid) {
      for (const reason of checked.reasons) increment(reasonCounts, reason);
      if (invalidExamples.length < 12) invalidExamples.push({
        id: String(row?.id || '').slice(0, 120),
        symbol: String(row?.symbol || '').slice(0, 30),
        reasons: checked.reasons
      });
      continue;
    }
    if (seenIds.has(checked.id)) {
      duplicateIds++;
      continue;
    }
    seenIds.add(checked.id);
    const baselineKey = checked.symbol + ':' + String(Math.trunc(checked.at));
    if (seenBaselines.has(baselineKey)) {
      duplicateBaselines++;
      continue;
    }
    seenBaselines.add(baselineKey);
    featureSamples.push(row);
    if (!bySymbol.has(checked.symbol)) bySymbol.set(checked.symbol, []);
    bySymbol.get(checked.symbol).push(checked.at);

    const sequence = row?.temporal_sequence;
    let sequenceFailure = null;
    if (!Array.isArray(sequence)) sequenceFailure = 'missing';
    else if (sequence.length !== sequenceSteps ||
      sequence.some(step => !Array.isArray(step) || step.length !== sequenceChannels))
      sequenceFailure = 'invalid_shape';
    else if (sequence.some(step => step.some(value => safeFinite(value) === null)))
      sequenceFailure = 'non_finite';
    else if (sequence.some(step => step.some(value =>
      Math.abs(Number(value)) > maxAbsoluteSequenceValue)))
      sequenceFailure = 'out_of_range';
    if (sequenceFailure) {
      sequenceExclusions[sequenceFailure]++;
      continue;
    }
    temporalSamples.push(row);
  }
  let spacingViolations = 0;
  for (const times of bySymbol.values()) {
    times.sort((a, b) => a - b);
    for (let index = 1; index < times.length; index++) {
      if (times[index] - times[index - 1] < horizonMs) spacingViolations++;
    }
  }
  const temporalCoverage = featureSamples.length
    ? temporalSamples.length / featureSamples.length : 0;
  return {
    feature_samples: featureSamples,
    temporal_samples: temporalSamples,
    observed_rows: Array.isArray(rows) ? rows.length : 0,
    feature_eligible_samples: featureSamples.length,
    temporal_eligible_samples: temporalSamples.length,
    invalid_samples: Object.values(reasonCounts).reduce((sum, count) => sum + count, 0),
    invalid_feature_reason_counts: Object.fromEntries(
      Object.entries(reasonCounts).sort((a, b) => a[0].localeCompare(b[0]))
    ),
    invalid_feature_examples: invalidExamples,
    duplicate_ids: duplicateIds,
    duplicate_baselines: duplicateBaselines,
    sequence_exclusions: sequenceExclusions,
    temporal_sequence_coverage_ratio: Number(temporalCoverage.toFixed(6)),
    temporal_sequence_coverage_pct: Number((temporalCoverage * 100).toFixed(3)),
    per_symbol_4h_spacing_violations: spacingViolations,
    symbols_with_feature_samples: bySymbol.size,
    symbols_with_samples: new Set(temporalSamples.map(row =>
      String(row.symbol || '').toUpperCase())).size,
    outcome_counts: outcomeRows(temporalSamples).reduce((counts, row) => {
      counts[row.outcome] = (counts[row.outcome] || 0) + 1;
      return counts;
    }, {}),
    sample_month_counts: temporalSamples.reduce((counts, row) => {
      const key = new Date(Number(row.at)).toISOString().slice(0, 7);
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {})
  };
}
