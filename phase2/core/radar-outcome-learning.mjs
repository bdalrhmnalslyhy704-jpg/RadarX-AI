import {
  buildCognitiveLearningProfile,
  applyCognitiveRankAdjustment
} from './cognitive-brain.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HORIZONS = Object.freeze([
  Object.freeze({
    key:'60m', horizon_ms:HOUR_MS, outcome_source:'RADAR_OUTCOME_CLOSED_OHLC_60M',
    threshold_pct:0.5, minimum_samples:60, weight:0.4
  }),
  Object.freeze({
    key:'24h', horizon_ms:DAY_MS, outcome_source:'RADAR_OUTCOME_CLOSED_OHLC_24H',
    threshold_pct:1.5, minimum_samples:60, weight:0.6
  })
]);
const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));

function classifyReturn(value, threshold) {
  const ret = finite(value);
  if (ret === null) return null;
  if (ret >= threshold) return 'UP';
  if (ret <= -threshold) return 'DOWN';
  return 'FLAT';
}
function outcomeReady(outcome, horizon, now) {
  const row = object(outcome);
  const knownAt = finite(row.updated_at);
  const completeThrough = finite(row.horizon_window_complete_through ?? row.last_close_time);
  return row.status === 'COMPLETE' &&
    row.sample_quality === 'HISTORICAL_CLOSED_OHLC' &&
    row.source === 'BINANCE_PUBLIC_CLOSED_OHLC' &&
    finite(row.horizon_ms) === horizon.horizon_ms &&
    knownAt !== null && knownAt <= now &&
    completeThrough !== null && completeThrough <= now &&
    finite(row.close_return_pct) !== null;
}
function buildTrainingSample(record, outcome, horizon, now) {
  const features = object(record.features);
  const available = finite(record.feature_snapshot_available_count) ??
    finite(features.feature_snapshot_available_count) ?? 0;
  const symbol = String(record.symbol || '').trim().toUpperCase();
  const radar = String(record.radar || '').trim().toUpperCase();
  const at = finite(record.detected_at);
  const price = finite(record.entry_price);
  const resolvedAt = finite(outcome.updated_at);
  const target = classifyReturn(outcome.close_return_pct,horizon.threshold_pct);
  if (record.baseline_status !== 'COMPLETE' || !/^[A-Z0-9]{2,26}USDT$/.test(symbol) ||
      !radar || at === null || at <= 0 || at > now || price === null || price <= 0 ||
      available < 4 || resolvedAt === null || resolvedAt < at + horizon.horizon_ms ||
      target === null || !outcomeReady(outcome,horizon,now)) return null;
  return {
    id:String(record.signal_id || [radar,symbol,at].join(':'))+':'+horizon.key,
    symbol,radar,at:Math.trunc(at),price,
    resolved_at:Math.trunc(resolvedAt),
    horizon_ms:horizon.horizon_ms,
    outcome:target,
    return_pct:Number(Number(outcome.close_return_pct).toFixed(5)),
    outcome_source:horizon.outcome_source,
    training_eligible:true,radar_outcome_baseline:true,closed_candle_baseline:true,
    features:{...features}
  };
}
function fitProfile(samples,horizon) {
  const profile = buildCognitiveLearningProfile(samples,{
    minTrainingSamples:60,
    minimumBucket:8,
    minimumValidationSamples:20,
    minimumHoldoutSamples:20,
    outcomeHorizonMs:horizon.horizon_ms,
    allowResolutionLag:true,
    allowedOutcomeSources:[horizon.outcome_source],
    iterations:240,
    learningRate:0.12,
    l2:0.12,
    maxResolvedSamples:900
  });
  return {
    ...profile,
    horizon:horizon.key,
    outcome_threshold_pct:horizon.threshold_pct,
    source:'BINANCE_PUBLIC_CLOSED_OHLC',
    ranking_adjustments_enabled:profile.probability_ready===true
  };
}
function failureReasons(record,outcomes) {
  const f=object(record.features),reasons=[];
  const volume=finite(f.volume_ratio),trades=finite(f.trade_ratio),buy=finite(f.taker_buy_ratio);
  const close=finite(f.close_location),upper=finite(f.upper_wick_pct),range=finite(f.current_range_pct);
  const relative=finite(f.relative_strength_vs_btc_pct);
  if(volume!==null&&volume>=1.5&&(buy===null||buy<0.48))
    reasons.push('HIGH_VOLUME_WITH_WEAK_TAKER_BUY_FLOW');
  if(trades!==null&&trades<1.0)reasons.push('TRADE_COUNT_DID_NOT_CONFIRM');
  if(relative!==null&&relative<-1)reasons.push('UNDERPERFORMED_BTC');
  if(upper!==null&&range!==null&&range>0&&upper/range>0.55)
    reasons.push('UPPER_WICK_REJECTION');
  if(close!==null&&close<0.45)reasons.push('WEAK_CANDLE_CLOSE_LOCATION');
  if(f.higher_low!==true&&f.breakout_above_prior_high!==true)
    reasons.push('NO_CONFIRMED_HIGHER_LOW_OR_BREAKOUT');
  const oneHour=outcomes['60m'],day=outcomes['24h'];
  if(oneHour?.status==='COMPLETE'&&finite(oneHour.close_return_pct)!==null&&oneHour.close_return_pct<=-0.5)
    reasons.push('ONE_HOUR_CLOSE_FAILED_TO_HOLD_SIGNAL_PRICE');
  if(day?.status==='COMPLETE'&&finite(day.close_return_pct)!==null&&day.close_return_pct<=-1.5)
    reasons.push('TWENTY_FOUR_HOUR_DOWNSIDE_CONFIRMED');
  if(!reasons.length)reasons.push('NO_SINGLE_CAUSAL_FAILURE_ESTABLISHED');
  return reasons.slice(0,8);
}
function caseStudy(record,now) {
  const outcomes=object(record.outcomes);
  const safeOutcome=(value,key)=>{
    const row=object(value),horizon=HORIZONS.find(item=>item.key===key);
    const knownAt=finite(row.updated_at),closedThrough=finite(row.horizon_window_complete_through);
    return horizon&&row.status==='COMPLETE'&&row.source==='BINANCE_PUBLIC_CLOSED_OHLC'&&
      row.sample_quality==='HISTORICAL_CLOSED_OHLC'&&knownAt!==null&&knownAt<=now&&
      closedThrough!==null&&closedThrough<=now?row:{status:'PENDING',close_return_pct:null,
        max_favorable_pct:null,max_adverse_pct:null,horizon_window_complete_through:null,updated_at:null};
  };
  const oneHour=safeOutcome(outcomes['60m'],'60m'),day=safeOutcome(outcomes['24h'],'24h');
  const knownTimes=[finite(oneHour.updated_at),finite(day.updated_at)].filter(x=>x!==null);
  return {
    id:String(record.signal_id||'').slice(0,240),
    radar:String(record.radar||'UNKNOWN'),
    symbol:String(record.symbol||'UNKNOWN'),
    stage:String(record.stage||'UNKNOWN'),
    detected_at:finite(record.detected_at),
    entry_price:finite(record.entry_price),
    feature_snapshot_available_count:finite(record.feature_snapshot_available_count)??0,
    one_hour:{status:oneHour.status||'PENDING',close_return_pct:finite(oneHour.close_return_pct),
      max_favorable_pct:finite(oneHour.max_favorable_pct),max_adverse_pct:finite(oneHour.max_adverse_pct),
      outcome:oneHour.status==='COMPLETE'?classifyReturn(oneHour.close_return_pct,0.5):null,
      observed_through:finite(oneHour.horizon_window_complete_through)},
    twenty_four_hour:{status:day.status||'PENDING',close_return_pct:finite(day.close_return_pct),
      max_favorable_pct:finite(day.max_favorable_pct),max_adverse_pct:finite(day.max_adverse_pct),
      outcome:day.status==='COMPLETE'?classifyReturn(day.close_return_pct,1.5):null,
      observed_through:finite(day.horizon_window_complete_through)},
    reason_codes:Array.isArray(record.reason_codes)?record.reason_codes.slice(0,8):[],
    retrospective_review_reasons:failureReasons(record,outcomes),
    recorded_at:knownTimes.length?Math.max(...knownTimes):finite(record.updated_at),
    no_future_data_used:true,
    causality:'CORRELATIONAL_CASE_STUDY_NOT_PROOF_OF_WHALE_INTENT',
    training_eligible:finite(record.feature_snapshot_available_count)>=4 &&
      (oneHour.status==='COMPLETE'||day.status==='COMPLETE'),
    paper_trading:true,real_order_execution:false
  };
}

/**
 * Join the durable 12-radar closed-candle outcome ledger to the cognitive
 * learner. Outcomes only become training labels after the full 1h/24h window
 * is closed and the ledger has recorded that result. Incomplete evidence is
 * still retained as a case study but never trained as a loss or a win.
 */
export function buildRadarOutcomeLearningSnapshot(state={},now=Date.now()) {
  const records=Array.isArray(state?.records)?state.records:[];
  const cases=records.map(row=>caseStudy(object(row),now))
    .filter(row=>row.detected_at!==null&&row.detected_at<=now)
    .sort((a,b)=>(b.detected_at||0)-(a.detected_at||0));
  const profiles={},capture={},samplesByHorizon={};
  for(const horizon of HORIZONS) {
    const resolvedOutcomes=records.map(record=>{
      const row=object(record);
      const outcome=object(object(row.outcomes)[horizon.key]);
      const symbol=String(row.symbol||'').trim().toUpperCase();
      const at=finite(row.detected_at),price=finite(row.entry_price);
      const resolvedAt=finite(outcome.updated_at);
      if(row.baseline_status!=='COMPLETE'||!/^[A-Z0-9]{2,26}USDT$/.test(symbol)||
         at===null||at<=0||at>now||!(price>0)||resolvedAt===null||
         resolvedAt<at+horizon.horizon_ms||!outcomeReady(outcome,horizon,now))return null;
      const label=classifyReturn(outcome.close_return_pct,horizon.threshold_pct);
      return label?{symbol,at:Math.trunc(at),outcome:label,return_pct:Number(outcome.close_return_pct)}:null;
    }).filter(Boolean);
    const samples=records.map(record=>{
      const outcome=object(record?.outcomes)[horizon.key];
      return outcomeReady(outcome,horizon,now)?buildTrainingSample(record,outcome,horizon,now):null;
    }).filter(Boolean);
    const profile=fitProfile(samples,horizon);
    profiles[horizon.key]=profile;
    samplesByHorizon[horizon.key]=samples;
    capture[horizon.key]={
      source_records:records.length,
      complete_closed_candle_outcomes:resolvedOutcomes.length,
      eligible_feature_snapshots:samples.length,
      missing_feature_snapshots:Math.max(0,resolvedOutcomes.length-samples.length),
      excluded_incomplete_or_untrusted:Math.max(0,records.length-resolvedOutcomes.length),
      threshold_pct:horizon.threshold_pct,
      outcome_counts:{
        up:resolvedOutcomes.filter(x=>x.outcome==='UP').length,
        down:resolvedOutcomes.filter(x=>x.outcome==='DOWN').length,
        flat:resolvedOutcomes.filter(x=>x.outcome==='FLAT').length
      },
      ranking_ready:profile.ranking_ready===true,
      probability_ready:profile.probability_ready===true,
      reason:profile.probability_ready===true?'NESTED_VALIDATION_AND_UNTOUCHED_HOLDOUT_BEAT_BASE_RATE':
        'NO_AUTOMATIC_RANKING_CHANGE_UNTIL_SAMPLE_AND_HOLDOUT_REQUIREMENTS_PASS'
    };
  }
  return {
    version:'RADARX_RADAR_OUTCOME_COGNITIVE_MEMORY_V1',
    at:Number(now),
    source:'BINANCE_PUBLIC_CLOSED_OHLC',
    scope:'TWELVE_RADARS_SPOT_USDT',
    horizon_profiles:profiles,
    capture,
    case_studies:cases.slice(0,100),
    case_study_count:cases.length,
    records_with_feature_snapshots:records.filter(row=>
      (finite(row?.feature_snapshot_available_count)??finite(row?.features?.feature_snapshot_available_count)??0)>=4).length,
    training_records:{
      '60m':samplesByHorizon['60m'].length,
      '24h':samplesByHorizon['24h'].length
    },
    policy:{
      automatic_weight_update:profiles['60m']?.probability_ready===true||profiles['24h']?.probability_ready===true,
      entry_gate_changes:false,radar_threshold_changes:false,real_order_execution:false,paper_trading:true,
      labels:'CLOSED_CANDLE_CLOSE_RETURN_WITH_FIXED_HORIZON_THRESHOLDS',
      note:'A model that fails temporal validation or holdout remains observational and cannot alter ranking.'
    }
  };
}

export function applyRadarOutcomeLearningAdjustment(baseScore,features={},snapshot={}) {
  const score=finite(baseScore);
  if(score===null)return {score:null,adjustment:0,used_horizons:[],status:'BASE_SCORE_UNAVAILABLE'};
  const profiles=object(snapshot?.horizon_profiles);
  const parts=[];
  for(const horizon of HORIZONS) {
    const profile=profiles[horizon.key];
    if(profile?.probability_ready!==true)continue;
    const ranked=applyCognitiveRankAdjustment(score,features,profile);
    if(ranked===null)continue;
    parts.push({key:horizon.key,weight:horizon.weight,adjustment:ranked-score});
  }
  if(!parts.length)return {score:Number(clamp(score,0,100).toFixed(1)),adjustment:0,used_horizons:[],
    status:'OBSERVATION_ONLY_UNTIL_OUT_OF_SAMPLE_VALIDATION'};
  const totalWeight=parts.reduce((sum,row)=>sum+row.weight,0);
  const raw=parts.reduce((sum,row)=>sum+row.adjustment*row.weight,0)/Math.max(1e-9,totalWeight);
  const adjustment=Number(clamp(raw,-2.5,2.5).toFixed(2));
  return {
    score:Number(clamp(score+adjustment,0,100).toFixed(1)),
    adjustment,used_horizons:parts.map(row=>row.key),
    status:'OUT_OF_SAMPLE_VALIDATED_RANKING_ONLY',
    entry_eligible:false,paper_trading:true,real_order_execution:false
  };
}

export const RADAR_OUTCOME_COGNITIVE_HORIZONS=HORIZONS;
