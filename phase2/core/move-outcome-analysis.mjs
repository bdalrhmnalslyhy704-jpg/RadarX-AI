const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const unique = rows => [...new Set((Array.isArray(rows) ? rows : [])
  .map(x => String(x ?? '').trim()).filter(Boolean))];

function actualMove(replay, targetPct) {
  const s = replay?.summary || {};
  const q = replay?.data_quality || {};
  const key = targetPct === 5 ? '5pct' : '15pct';
  const exact = finite(s['first_actual_window_' + key + '_at']);
  const candle = finite(s['first_actual_window_' + key + '_candle_close_at']);
  if (exact !== null) return {at: exact, source: q.trade_coverage_complete === true ? 'BINANCE_PUBLIC_AGG_TRADES' : 'EXACT_TIMESTAMP_SOURCE_UNDECLARED'};
  if (candle !== null && q.candle_fetch_complete === true) return {at: candle, source: 'BINANCE_CLOSED_CANDLE_CLOSE_APPROXIMATION'};
  return {at: null, source: q.candle_fetch_complete === true ? 'NO_MOVE_OBSERVED_IN_WINDOW' : 'INCOMPLETE_CANDLE_COVERAGE'};
}

function rejectionEvidence(step) {
  if (!step) return [];
  const rows = [
    ...(Array.isArray(step.reason_codes) ? step.reason_codes : []),
    ...(Array.isArray(step.strict_gate_failures) ? step.strict_gate_failures : []),
    ...(Array.isArray(step.core_trigger_diagnostics?.failed_checks) ? step.core_trigger_diagnostics.failed_checks : []),
    ...(Array.isArray(step.notification_gate?.failures) ? step.notification_gate.failures : []),
    ...(Array.isArray(step.early_warning?.failures) ? step.early_warning.failures : []),
    ...(Array.isArray(step.elite_gate?.failures) ? step.elite_gate.failures : []),
    ...(Array.isArray(step.risk_flags) ? step.risk_flags : []),
    ...(Array.isArray(step.elite_gate?.risk_flags) ? step.elite_gate.risk_flags : [])
  ];
  return unique(rows).slice(0, 24);
}

function lastRejectedBefore(steps, at) {
  const rows = (Array.isArray(steps) ? steps : [])
    .filter(x => x?.decision === 'REJECTED' && finite(x.timestamp) !== null && Number(x.timestamp) < at)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const row = rows.at(-1) || null;
  if (!row) return null;
  return {
    at: finite(row.timestamp),
    at_iso: row.timestamp_iso || (finite(row.timestamp) !== null ? new Date(Number(row.timestamp)).toISOString() : null),
    rejection_group: row.rejection_group || 'REJECTED_OTHER',
    stage: row.stage_observed || null,
    score: finite(row.score),
    core_trigger_eligible: typeof row.core_trigger_eligible === 'boolean' ? row.core_trigger_eligible : null,
    candidate_eligible: typeof row.candidate_eligible === 'boolean' ? row.candidate_eligible : null,
    market_evidence:row.market_evidence&&typeof row.market_evidence==='object'?row.market_evidence:null,
    signal_metrics:row.signal_metrics&&typeof row.signal_metrics==='object'?row.signal_metrics:null,
    gate_failure_layers:{
      core_trigger:{eligible:typeof row.core_trigger_eligible==='boolean'?row.core_trigger_eligible:null,
        failures:unique(row.core_trigger_diagnostics?.failed_checks||[]).slice(0,16)},
      elite_confluence:{eligible:typeof row.elite_gate?.eligible==='boolean'?row.elite_gate.eligible:null,
        score:finite(row.elite_gate?.score),failures:unique(row.elite_gate?.failures||[]).slice(0,16),
        risk_flags:unique(row.elite_gate?.risk_flags||[]).slice(0,12)},
      notification:{eligible:typeof row.notification_gate?.eligible==='boolean'?row.notification_gate.eligible:null,
        failures:unique(row.notification_gate?.failures||[]).slice(0,16)},
      dynamic_early_warning:{eligible:typeof row.early_warning?.eligible==='boolean'?row.early_warning.eligible:null,
        score:finite(row.early_warning?.score),failures:unique(row.early_warning?.failures||[]).slice(0,16)}
    },
    failed_checks: rejectionEvidence(row)
  };
}

/**
 * Converts a replay timeline into three actionable audit groups:
 * missed historical moves, accepted setups with weak follow-through, and early detections.
 * Labels are descriptive measurements, not claims of guaranteed profitability.
 */
export function buildMoveOutcomeAnalysis(replay = {}, {
  moderateTargetPct = 5,
  strongTargetPct = 15,
  maxAcceptedFollowThroughPct = 5
} = {}) {
  const steps = (Array.isArray(replay?.steps) ? replay.steps : [])
    .filter(x => x && finite(x.timestamp) !== null)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const quality = replay?.data_quality || {};
  const completeCandles = quality.candle_fetch_complete === true &&
    quality.synthetic_data_used !== true &&
    ['FULL_TRADE', 'CANDLE_ONLY_FALLBACK'].includes(quality.replay_mode);
  const moderate = actualMove(replay, moderateTargetPct);
  const strong = actualMove(replay, strongTargetPct);
  const accepted = steps.filter(x => x.decision === 'ACCEPTED');
  const candidates = steps.filter(x => x.candidate_detected === true);
  const maturedCandidates = candidates.filter(x => x.outcome?.horizon_observed === true &&
    finite(x.outcome?.forward_max_upside_pct_from_decision) !== null &&
    finite(x.outcome?.forward_max_drawdown_pct_from_decision) !== null &&
    finite(x.outcome?.forward_return_pct_at_horizon) !== null);
  const maturedAccepted = accepted.filter(x => x.outcome?.horizon_observed === true &&
    finite(x.outcome?.forward_max_upside_pct_from_decision) !== null &&
    finite(x.outcome?.forward_max_drawdown_pct_from_decision) !== null &&
    finite(x.outcome?.forward_return_pct_at_horizon) !== null);

  const firstAcceptedBefore = moveAt => moveAt === null ? null :
    accepted.find(x => Number(x.timestamp) < moveAt) || null;
  const moderateFirst = firstAcceptedBefore(moderate.at);
  const strongFirst = firstAcceptedBefore(strong.at);
  const firstCandidateBefore = moveAt => moveAt === null ? null :
    candidates.find(x => Number(x.timestamp) < moveAt) || null;
  const firstCandidateAtOrAfter = moveAt => moveAt === null ? null :
    candidates.find(x => Number(x.timestamp) >= moveAt) || null;
  const candidate5 = firstCandidateBefore(moderate.at);
  const candidate15 = firstCandidateBefore(strong.at);
  const lateCandidate5 = firstCandidateAtOrAfter(moderate.at);
  const lateCandidate15 = firstCandidateAtOrAfter(strong.at);
  const moderateWasObserved = moderate.at !== null && completeCandles;
  const strongWasObserved = strong.at !== null && completeCandles;
  const moderateStatus = !completeCandles
    ? 'INCOMPLETE_MARKET_DATA'
    : moderate.at === null
      ? 'NO_PLUS_5_PERCENT_MOVE_OBSERVED'
      : moderateFirst
        ? 'EARLY_DETECTION_BEFORE_PLUS_5_PERCENT'
        : accepted.some(x => Number(x.timestamp) >= moderate.at)
          ? 'LATE_DETECTION_AFTER_PLUS_5_PERCENT'
          : 'MISSED_PLUS_5_PERCENT_MOVE';
  const strongStatus = !completeCandles
    ? 'INCOMPLETE_MARKET_DATA'
    : strong.at === null
      ? 'NO_PLUS_15_PERCENT_MOVE_OBSERVED'
      : strongFirst
        ? 'EARLY_DETECTION_BEFORE_PLUS_15_PERCENT'
        : accepted.some(x => Number(x.timestamp) >= strong.at)
          ? 'LATE_DETECTION_AFTER_PLUS_15_PERCENT'
          : 'MISSED_PLUS_15_PERCENT_MOVE';

  const describeHit = (hit, move, status) => {
    if (!hit) return null;
    const lead = move.at === null ? null : Number(((move.at - Number(hit.timestamp)) / 60_000).toFixed(2));
    return {
      at: finite(hit.timestamp),
      at_iso: hit.timestamp_iso || new Date(Number(hit.timestamp)).toISOString(),
      mode: hit.accepted_mode || 'UNKNOWN',
      score: finite(hit.score),
      minutes_before_move: lead,
      source_move_timestamp: move.source,
      forward_max_upside_pct: finite(hit.outcome?.forward_max_upside_pct_from_decision),
      forward_max_drawdown_pct: finite(hit.outcome?.forward_max_drawdown_pct_from_decision),
      forward_return_pct_at_horizon: finite(hit.outcome?.forward_return_pct_at_horizon),
      outcome_horizon_observed: hit.outcome?.horizon_observed === true,
      classification: status
    };
  };

  const missedModerate = moderateWasObserved && !moderateFirst ? {
    target_pct: moderateTargetPct,
    move_at: moderate.at,
    move_at_iso: new Date(moderate.at).toISOString(),
    timestamp_source: moderate.source,
    classification: moderateStatus,
    first_late_acceptance: accepted.find(x => Number(x.timestamp) >= moderate.at)
      ? describeHit(accepted.find(x => Number(x.timestamp) >= moderate.at), moderate, 'LATE_DETECTION')
      : null,
    last_rejection_before_move: lastRejectedBefore(steps, moderate.at)
  } : null;
  const missedStrong = strongWasObserved && !strongFirst ? {
    target_pct: strongTargetPct,
    move_at: strong.at,
    move_at_iso: new Date(strong.at).toISOString(),
    timestamp_source: strong.source,
    classification: strongStatus,
    first_late_acceptance: accepted.find(x => Number(x.timestamp) >= strong.at)
      ? describeHit(accepted.find(x => Number(x.timestamp) >= strong.at), strong, 'LATE_DETECTION')
      : null,
    last_rejection_before_move: lastRejectedBefore(steps, strong.at)
  } : null;

  const lowFollowThroughCandidates = maturedCandidates.filter(x => {
    const upside = Number(x.outcome.forward_max_upside_pct_from_decision);
    const terminal = Number(x.outcome.forward_return_pct_at_horizon);
    const drawdown = Number(x.outcome.forward_max_drawdown_pct_from_decision);
    return upside < maxAcceptedFollowThroughPct && terminal <= 0 && drawdown <= -1;
  }).map(x => ({
    at: finite(x.timestamp),
    at_iso: x.timestamp_iso || new Date(Number(x.timestamp)).toISOString(),
    candidate_mode: x.candidate_mode || 'CANDIDATE_SHADOW',
    score: finite(x.score),
    forward_max_upside_pct: finite(x.outcome.forward_max_upside_pct_from_decision),
    forward_max_drawdown_pct: finite(x.outcome.forward_max_drawdown_pct_from_decision),
    forward_return_pct_at_horizon: finite(x.outcome.forward_return_pct_at_horizon),
    horizon_ms: finite(x.outcome.horizon_ms),
    classification: 'LOW_FOLLOW_THROUGH_CANDIDATE',
    not_a_notification: true
  }));

  const lowFollowThrough = maturedAccepted.filter(x => {
    const upside = Number(x.outcome.forward_max_upside_pct_from_decision);
    const terminal = Number(x.outcome.forward_return_pct_at_horizon);
    const drawdown = Number(x.outcome.forward_max_drawdown_pct_from_decision);
    return upside < maxAcceptedFollowThroughPct && terminal <= 0 && drawdown <= -1;
  }).map(x => ({
    at: finite(x.timestamp),
    at_iso: x.timestamp_iso || new Date(Number(x.timestamp)).toISOString(),
    accepted_mode: x.accepted_mode || 'UNKNOWN',
    score: finite(x.score),
    forward_max_upside_pct: finite(x.outcome.forward_max_upside_pct_from_decision),
    forward_max_drawdown_pct: finite(x.outcome.forward_max_drawdown_pct_from_decision),
    forward_return_pct_at_horizon: finite(x.outcome.forward_return_pct_at_horizon),
    horizon_ms: finite(x.outcome.horizon_ms),
    classification: 'LOW_FOLLOW_THROUGH_OR_ADVERSE_MOVE'
  }));

  const missedMoveFailures = unique([
    ...(missedModerate?.last_rejection_before_move?.failed_checks || []),
    ...(missedStrong?.last_rejection_before_move?.failed_checks || [])
  ]).slice(0, 24);
  const earlyModerate = describeHit(moderateFirst, moderate, moderateStatus);
  const earlyStrong = describeHit(strongFirst, strong, strongStatus);
  const horizonObserved = completeCandles && steps.length > 0 &&
    steps.every(x => x.outcome?.horizon_observed === true);
  const candidateStatus=(move,first,late,target)=>!completeCandles
    ?'INCOMPLETE_MARKET_DATA'
    :move.at===null?'NO_PLUS_'+target+'_PERCENT_MOVE_OBSERVED'
    :first?'EARLY_CANDIDATE_BEFORE_PLUS_'+target+'_PERCENT'
    :late?'LATE_CANDIDATE_AFTER_PLUS_'+target+'_PERCENT'
    :'MISSED_PLUS_'+target+'_PERCENT_CANDIDATE';
  const candidate5Status=candidateStatus(moderate,candidate5,lateCandidate5,5);
  const candidate15Status=candidateStatus(strong,candidate15,lateCandidate15,15);
  const describeCandidate=(hit,move,status)=>hit?{
    at:finite(hit.timestamp),
    at_iso:hit.timestamp_iso||new Date(Number(hit.timestamp)).toISOString(),
    mode:hit.candidate_mode||'CANDIDATE_SHADOW',
    score:finite(hit.score),
    minutes_before_move:move.at===null?null:Number(((move.at-Number(hit.timestamp))/60_000).toFixed(2)),
    source_move_timestamp:move.source,
    forward_max_upside_pct:finite(hit.outcome?.forward_max_upside_pct_from_decision),
    forward_max_drawdown_pct:finite(hit.outcome?.forward_max_drawdown_pct_from_decision),
    forward_return_pct_at_horizon:finite(hit.outcome?.forward_return_pct_at_horizon),
    outcome_horizon_observed:hit.outcome?.horizon_observed===true,
    classification:status,
    not_a_notification:true
  }:null;
  const candidateFailures=unique([
    ...(moderateWasObserved&&!candidate5?lastRejectedBefore(steps,moderate.at)?.failed_checks||[]:[]),
    ...(strongWasObserved&&!candidate15?lastRejectedBefore(steps,strong.at)?.failed_checks||[]:[])
  ]).slice(0,24);
  return {
    version: 'RADARX_MOVE_OUTCOME_ANALYSIS_V1',
    symbol: String(replay?.symbol || '').toUpperCase(),
    observation: {
      candle_coverage_complete: completeCandles,
      replay_mode: quality.replay_mode || 'UNKNOWN',
      trade_coverage_complete: quality.trade_coverage_complete === true,
      synthetic_data_used: quality.synthetic_data_used === true,
      outcomes_matured_for_all_steps: horizonObserved,
      steps: steps.length,
      accepted: accepted.length,
      accepted_with_matured_outcomes: maturedAccepted.length
    },
    moderate_move: {
      target_pct: moderateTargetPct,
      observed_at: moderate.at,
      observed_at_iso: moderate.at === null ? null : new Date(moderate.at).toISOString(),
      timestamp_source: moderate.source,
      classification: moderateStatus,
      detected_early: Boolean(moderateFirst),
      minutes_before_move: earlyModerate?.minutes_before_move ?? null,
      first_early_detection: earlyModerate,
      missed_move: missedModerate
    },
    strong_move: {
      target_pct: strongTargetPct,
      observed_at: strong.at,
      observed_at_iso: strong.at === null ? null : new Date(strong.at).toISOString(),
      timestamp_source: strong.source,
      classification: strongStatus,
      detected_early: Boolean(strongFirst),
      minutes_before_move: earlyStrong?.minutes_before_move ?? null,
      first_early_detection: earlyStrong,
      missed_move: missedStrong
    },
    candidate_detection: {
      mode:'CANDIDATE_SHADOW_NOT_NOTIFICATION',
      candidate_count:candidates.length,
      candidate_with_matured_outcomes:maturedCandidates.length,
      low_follow_through_candidates:lowFollowThroughCandidates,
      low_follow_through_candidate_count:lowFollowThroughCandidates.length,
      low_follow_through_candidate_rate_pct:maturedCandidates.length
        ? Number((lowFollowThroughCandidates.length/maturedCandidates.length*100).toFixed(2)) : null,
      moderate_move:{
        target_pct:moderateTargetPct,
        observed_at:moderate.at,
        timestamp_source:moderate.source,
        classification:candidate5Status,
        detected_early:Boolean(candidate5),
        minutes_before_move:describeCandidate(candidate5,moderate,candidate5Status)?.minutes_before_move??null,
        first_candidate_before_move:describeCandidate(candidate5,moderate,candidate5Status),
        first_candidate_after_move:describeCandidate(lateCandidate5,moderate,'LATE_CANDIDATE'),
        last_rejection_before_move:moderateWasObserved&&!candidate5?lastRejectedBefore(steps,moderate.at):null
      },
      strong_move:{
        target_pct:strongTargetPct,
        observed_at:strong.at,
        timestamp_source:strong.source,
        classification:candidate15Status,
        detected_early:Boolean(candidate15),
        minutes_before_move:describeCandidate(candidate15,strong,candidate15Status)?.minutes_before_move??null,
        first_candidate_before_move:describeCandidate(candidate15,strong,candidate15Status),
        first_candidate_after_move:describeCandidate(lateCandidate15,strong,'LATE_CANDIDATE'),
        last_rejection_before_move:strongWasObserved&&!candidate15?lastRejectedBefore(steps,strong.at):null
      },
      missed_move_failure_codes:candidateFailures
    },
    low_follow_through_acceptances: lowFollowThrough,
    missed_move_failure_codes: missedMoveFailures,
    summary: {
      accepted_count: accepted.length,
      mature_accepted_count: maturedAccepted.length,
      candidate_detection_count:candidates.length,
      matured_candidate_count:maturedCandidates.length,
      low_follow_through_candidate_count:lowFollowThroughCandidates.length,
      low_follow_through_candidate_rate_pct:maturedCandidates.length
        ? Number((lowFollowThroughCandidates.length/maturedCandidates.length*100).toFixed(2)) : null,
      candidate_early_5pct_detection:Boolean(candidate5),
      candidate_early_15pct_detection:Boolean(candidate15),
      candidate_missed_5pct_move:Boolean(moderateWasObserved&&!candidate5),
      candidate_missed_15pct_move:Boolean(strongWasObserved&&!candidate15),
      early_5pct_detection: Boolean(moderateFirst),
      early_15pct_detection: Boolean(strongFirst),
      missed_5pct_move: Boolean(missedModerate),
      missed_15pct_move: Boolean(missedStrong),
      low_follow_through_count: lowFollowThrough.length
    },
    policy: {market: 'BINANCE_SPOT_USDT', paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'}
  };
}

/** Aggregate measured results across symbol replays without treating missing coverage as a negative result. */
export function summarizeMoveOutcomeAnalyses(replays = []) {
  const rows = (Array.isArray(replays) ? replays : []).map(x =>
    x?.evaluation?.version === 'RADARX_MOVE_OUTCOME_ANALYSIS_V1' ? x.evaluation :
      (x?.version === 'RADARX_MOVE_OUTCOME_ANALYSIS_V1' ? x : null)
  ).filter(Boolean);
  const complete = rows.filter(x => x.observation?.candle_coverage_complete === true);
  const moderateObserved = complete.filter(x => x.moderate_move?.observed_at !== null && x.moderate_move?.observed_at !== undefined);
  const strongObserved = complete.filter(x => x.strong_move?.observed_at !== null && x.strong_move?.observed_at !== undefined);
  const early5 = moderateObserved.filter(x => x.moderate_move?.detected_early === true);
  const early15 = strongObserved.filter(x => x.strong_move?.detected_early === true);
  const candidate5Observed=complete.filter(x=>x.moderate_move?.observed_at!==null&&x.moderate_move?.observed_at!==undefined);
  const candidate15Observed=complete.filter(x=>x.strong_move?.observed_at!==null&&x.strong_move?.observed_at!==undefined);
  const candidateEarly5=candidate5Observed.filter(x=>x.candidate_detection?.moderate_move?.detected_early===true);
  const candidateEarly15=candidate15Observed.filter(x=>x.candidate_detection?.strong_move?.detected_early===true);
  const lowFollowRows = complete.flatMap(x => Array.isArray(x.low_follow_through_acceptances) ? x.low_follow_through_acceptances : []);
  const lowFollowCandidateRows = complete.flatMap(x => Array.isArray(x.candidate_detection?.low_follow_through_candidates)
    ? x.candidate_detection.low_follow_through_candidates : []);
  const maturedCandidateCount = complete.reduce((n,x)=>n+(Number(x.candidate_detection?.candidate_with_matured_outcomes)||0),0);
  const candidateFailureCounts = new Map();
  for(const row of complete){
    for(const code of Array.isArray(row.candidate_detection?.missed_move_failure_codes)?row.candidate_detection.missed_move_failure_codes:[]){
      candidateFailureCounts.set(code,(candidateFailureCounts.get(code)||0)+1);
    }
  }
  const failureCounts = new Map();
  for (const row of complete) {
    for (const code of Array.isArray(row.missed_move_failure_codes) ? row.missed_move_failure_codes : []) {
      failureCounts.set(code, (failureCounts.get(code) || 0) + 1);
    }
  }
  const median = xs => {
    const a = xs.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    if (!a.length) return null;
    const mid = Math.floor(a.length/2);
    return Number((a.length%2 ? a[mid] : (a[mid-1]+a[mid])/2).toFixed(2));
  };
  return {
    version: 'RADARX_MOVE_OUTCOME_SUMMARY_V1',
    symbols_requested: rows.length,
    candle_coverage_complete_symbols: complete.length,
    coverage_incomplete_symbols: rows.length - complete.length,
    moderate_moves_observed: moderateObserved.length,
    early_detections_before_5pct: early5.length,
    missed_or_late_5pct_moves: moderateObserved.length - early5.length,
    early_5pct_detection_rate_pct: moderateObserved.length ? Number((early5.length/moderateObserved.length*100).toFixed(2)) : null,
    median_minutes_before_5pct: median(early5.map(x=>x.moderate_move.minutes_before_move)),
    strong_moves_observed: strongObserved.length,
    early_detections_before_15pct: early15.length,
    missed_or_late_15pct_moves: strongObserved.length - early15.length,
    early_15pct_detection_rate_pct: strongObserved.length ? Number((early15.length/strongObserved.length*100).toFixed(2)) : null,
    median_minutes_before_15pct: median(early15.map(x=>x.strong_move.minutes_before_move)),
    candidate_detections:complete.reduce((n,x)=>n+(Number(x.candidate_detection?.candidate_count)||0),0),
    matured_candidate_detections:maturedCandidateCount,
    low_follow_through_candidate_count:lowFollowCandidateRows.length,
    low_follow_through_candidate_rate_pct:maturedCandidateCount
      ? Number((lowFollowCandidateRows.length/maturedCandidateCount*100).toFixed(2)) : null,
    candidate_early_detections_before_5pct:candidateEarly5.length,
    candidate_missed_or_late_5pct_moves:candidate5Observed.length-candidateEarly5.length,
    candidate_early_5pct_detection_rate_pct:candidate5Observed.length?Number((candidateEarly5.length/candidate5Observed.length*100).toFixed(2)):null,
    candidate_median_minutes_before_5pct:median(candidateEarly5.map(x=>x.candidate_detection?.moderate_move?.minutes_before_move)),
    candidate_early_detections_before_15pct:candidateEarly15.length,
    candidate_missed_or_late_15pct_moves:candidate15Observed.length-candidateEarly15.length,
    candidate_early_15pct_detection_rate_pct:candidate15Observed.length?Number((candidateEarly15.length/candidate15Observed.length*100).toFixed(2)):null,
    candidate_median_minutes_before_15pct:median(candidateEarly15.map(x=>x.candidate_detection?.strong_move?.minutes_before_move)),
    most_common_candidate_miss_reasons:[...candidateFailureCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([code,count])=>({code,count})),
    accepted_with_matured_outcomes: complete.reduce((n,x)=>n+(Number(x.observation?.accepted_with_matured_outcomes)||0),0),
    low_follow_through_count: lowFollowRows.length,
    low_follow_through_share_pct: complete.reduce((n,x)=>n+(Number(x.summary?.mature_accepted_count)||0),0)
      ? Number((lowFollowRows.length/complete.reduce((n,x)=>n+(Number(x.summary?.mature_accepted_count)||0),0)*100).toFixed(2)) : null,
    most_common_missed_move_failures: [...failureCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([code,count])=>({code,count})),
    definitions: {
      moderate_move: 'Observed +5% intrawindow high from the first in-window candle baseline.',
      strong_move: 'Observed +15% intrawindow high from the first in-window candle baseline.',
      early_detection: 'At least one accepted replay decision strictly before the observed threshold crossing.',
      low_follow_through: 'Matured accepted decision with <5% future maximum upside, non-positive horizon return, and at least 1% adverse excursion.',
      low_follow_through_candidate: 'Proxy false-positive candidate, not an actual alert: matured shadow candidate with <5% future maximum upside, non-positive horizon return, and at least 1% adverse excursion.',
      incomplete_coverage: 'Excluded from hit/miss rates when closed-candle coverage or replay mode is incomplete.'
    },
    policy: {market:'BINANCE_SPOT_USDT',paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}
  };
}
