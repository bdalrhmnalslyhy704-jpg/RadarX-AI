/**
 * RadarX Build 224 — Cognitive Agent V2
 *
 * An interpretable, feedback-driven research model. It learns relationships
 * between market evidence and matured closed-candle outcomes, checks itself
 * against a purged chronological holdout, and exposes counterfactual evidence.
 * It is not consciousness, does not claim human-level reasoning, and cannot
 * create exchange orders or change radar configuration.
 */

const MIN_OUTCOME_HORIZON_MS = 4 * 60 * 60 * 1000;
const FEATURE_NAMES = Object.freeze([
  'volume_expansion',
  'trade_expansion',
  'buyer_pressure',
  'price_structure',
  'volatility_compression',
  'relative_strength',
  'short_momentum',
  'multi_hour_trend',
  'micro_buy_pressure',
  'close_location',
  'upper_wick_rejection',
  'volume_x_buyer',
  'structure_x_buyer',
  'relative_x_trend',
  'compression_x_structure'
]);

const FACTORS = Object.freeze([
  { key: 'volume_expansion', label_ar: 'تسارع حجم التداول', test: f => finite(f.volume_ratio) !== null && Number(f.volume_ratio) >= 1.5 },
  { key: 'trade_expansion', label_ar: 'تسارع عدد الصفقات', test: f => finite(f.trade_ratio) !== null && Number(f.trade_ratio) >= 1.25 },
  { key: 'buyer_flow', label_ar: 'ضغط المشترين', test: f => finite(f.taker_buy_ratio) !== null && Number(f.taker_buy_ratio) >= 0.52 },
  { key: 'price_structure', label_ar: 'قاع أعلى أو اختراق مغلق', test: f => f.higher_low === true || f.breakout_above_prior_high === true },
  { key: 'volatility_compression', label_ar: 'انكماش التذبذب', test: f => finite(f.compression_ratio) !== null && Number(f.compression_ratio) <= 0.8 },
  { key: 'relative_strength', label_ar: 'قوة نسبية مقابل BTC', test: f => finite(f.relative_strength_vs_btc_pct) !== null && Number(f.relative_strength_vs_btc_pct) >= 0.25 },
  { key: 'short_momentum', label_ar: 'زخم قصير غير ممتد', test: f => {
    const value = finite(f.recent_15m_return_pct) ?? finite(f.price_change_15m_pct);
    return value !== null && value >= 0 && value <= 1.5;
  }},
  { key: 'multi_hour_trend', label_ar: 'اتجاه متعدد الساعات', test: f => f.trend_aligned === true ||
    (finite(f.return_3h_pct) !== null && Number(f.return_3h_pct) > 0) },
  { key: 'five_minute_flow', label_ar: 'ضغط شراء على 5 دقائق', test: f => f.micro_5m_available === true &&
    finite(f.micro_5m_taker_buy_ratio) !== null && Number(f.micro_5m_taker_buy_ratio) >= 0.55 }
]);

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const logit = p => Math.log(clamp(p, 0.001, 0.999) / (1 - clamp(p, 0.001, 0.999)));
const logistic = value => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
const betaRate = (sum, count) => (sum + 2) / (count + 4);
const targetOf = row => row.outcome === 'UP' ? 1 : row.outcome === 'DOWN' ? 0 : 0.5;

function factorValues(features = {}) {
  return Object.fromEntries(FACTORS.map(factor => [factor.key, Boolean(factor.test(features || {}))]));
}

function normalizedFeatures(features = {}) {
  const f = features || {};
  const volRaw = finite(f.volume_ratio);
  const tradeRaw = finite(f.trade_ratio);
  const buyerRaw = finite(f.taker_buy_ratio);
  const compressionRaw = finite(f.compression_ratio);
  const relativeRaw = finite(f.relative_strength_vs_btc_pct);
  const momentumRaw = finite(f.recent_15m_return_pct) ?? finite(f.price_change_15m_pct);
  const microRaw = finite(f.micro_5m_taker_buy_ratio);
  const closeRaw = finite(f.close_location);
  const rangeRaw = finite(f.current_range_pct);
  const wickRaw = finite(f.upper_wick_pct);

  const volume = volRaw === null ? 0 : clamp(Math.log(clamp(volRaw, 0.05, 20)) / Math.log(2), -2, 2);
  const trades = tradeRaw === null ? 0 : clamp(Math.log(clamp(tradeRaw, 0.05, 20)) / Math.log(2), -2, 2);
  const buyer = buyerRaw === null ? 0 : clamp((buyerRaw - 0.5) / 0.1, -2, 2);
  const structure = f.higher_low === true || f.breakout_above_prior_high === true ? 1 : 0;
  const compression = compressionRaw === null ? 0 : clamp((1 - compressionRaw) / 0.4, -2, 2);
  const relative = relativeRaw === null ? 0 : clamp(relativeRaw / 1.5, -2, 2);
  const momentum = momentumRaw === null ? 0 : clamp(momentumRaw / 1.5, -2, 2);
  const trend = f.trend_aligned === true || (finite(f.return_3h_pct) !== null && Number(f.return_3h_pct) > 0) ? 1 : 0;
  const micro = f.micro_5m_available === true && microRaw !== null
    ? clamp((microRaw - 0.5) / 0.1, -2, 2) : 0;
  const close = closeRaw === null ? 0 : clamp((closeRaw - 0.5) * 2, -1, 1);
  const wickRatio = wickRaw !== null && rangeRaw !== null && rangeRaw > 0 ? wickRaw / rangeRaw : null;
  const wickPenalty = wickRatio === null ? 0 : -clamp((wickRatio - 0.35) / 0.35, 0, 2);

  return [
    volume,
    trades,
    buyer,
    structure,
    compression,
    relative,
    momentum,
    trend,
    micro,
    close,
    wickPenalty,
    volume * buyer,
    structure * buyer,
    relative * trend,
    compression * structure
  ];
}

function validResolvedSamples(samples) {
  const seen = new Set();
  return (Array.isArray(samples) ? samples : [])
    .filter(row => {
      if (!row || row.training_eligible !== true ||
          (row.closed_candle_baseline !== true && row.historical_baseline !== true) ||
          !['UP', 'DOWN', 'FLAT'].includes(row.outcome) ||
          !row.features || typeof row.features !== 'object') return false;
      const id = String(row.id || '');
      const at = finite(row.at);
      const resolvedAt = finite(row.resolved_at);
      const horizon = finite(row.horizon_ms);
      if (!id || seen.has(id) || at === null || at <= 0 ||
          resolvedAt === null || resolvedAt - at < MIN_OUTCOME_HORIZON_MS ||
          (horizon !== null && horizon < MIN_OUTCOME_HORIZON_MS)) return false;
      seen.add(id);
      return true;
    })
    .map(row => ({
      ...row,
      at: Number(row.at),
      resolved_at: Number(row.resolved_at),
      target: targetOf(row),
      vector: normalizedFeatures(row.features)
    }))
    .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
}

function fitLogisticModel(training, { l2 = 0.18, iterations = 700, learningRate = 0.12 } = {}) {
  const targets = training.map(row => row.target);
  const baseRate = betaRate(targets.reduce((sum, value) => sum + value, 0), targets.length);
  const weights = Array(FEATURE_NAMES.length).fill(0);
  let intercept = logit(baseRate);
  const n = Math.max(1, training.length);

  // Deterministic full-batch gradient descent: reproducible tests and no random seed.
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradients = Array(FEATURE_NAMES.length).fill(0);
    let interceptGradient = 0;
    for (const row of training) {
      let linear = intercept;
      for (let i = 0; i < weights.length; i++) linear += weights[i] * row.vector[i];
      const error = logistic(linear) - row.target;
      interceptGradient += error;
      for (let i = 0; i < weights.length; i++) gradients[i] += error * row.vector[i];
    }
    intercept -= learningRate * interceptGradient / n;
    for (let i = 0; i < weights.length; i++) {
      const gradient = gradients[i] / n + l2 * weights[i];
      weights[i] = clamp(weights[i] - learningRate * gradient, -4, 4);
    }
  }
  return { intercept, weights, base_rate: baseRate, feature_names: [...FEATURE_NAMES], l2 };
}

function predictFromFit(features, fit) {
  if (!fit || !Array.isArray(fit.weights) || fit.weights.length !== FEATURE_NAMES.length) return null;
  const vector = normalizedFeatures(features);
  let value = Number(fit.intercept) || 0;
  for (let i = 0; i < fit.weights.length; i++) value += Number(fit.weights[i] || 0) * vector[i];
  return clamp(logistic(value), 0.02, 0.98);
}

function factorEvidence(training, { minimumBucket = 8 } = {}) {
  const output = {};
  let covered = 0;
  for (const factor of FACTORS) {
    const active = training.filter(row => factor.test(row.features || {}));
    const inactive = training.filter(row => !factor.test(row.features || {}));
    const activeMean = active.length ? mean(active.map(row => row.target)) : null;
    const inactiveMean = inactive.length ? mean(inactive.map(row => row.target)) : null;
    const ready = active.length >= minimumBucket && inactive.length >= minimumBucket;
    if (ready) covered++;
    output[factor.key] = {
      label_ar: factor.label_ar,
      present_samples: active.length,
      absent_samples: inactive.length,
      present_up_rate_pct: activeMean === null ? null : Number((activeMean * 100).toFixed(1)),
      absent_up_rate_pct: inactiveMean === null ? null : Number((inactiveMean * 100).toFixed(1)),
      lift_percentage_points: activeMean === null || inactiveMean === null
        ? null : Number(((activeMean - inactiveMean) * 100).toFixed(1)),
      evidence_ready: ready
    };
  }
  return { factors: output, covered_factor_buckets: covered };
}

function evaluateHoldout(rows, fit) {
  if (rows.length < 20) return {
    sample_count: rows.length, evaluated: false, model_brier_score: null,
    base_rate_brier_score: null, accuracy_directional_pct: null,
    beat_base_rate: false, reason: 'HOLDOUT_REQUIRES_20_OUTCOMES'
  };
  const base = fit.base_rate;
  const predictions = rows.map(row => predictFromFit(row.features, fit));
  const targets = rows.map(row => row.target);
  const modelBrier = mean(predictions.map((p, index) => (p - targets[index]) ** 2));
  const baselineBrier = mean(targets.map(target => (base - target) ** 2));
  const directional = rows.filter(row => row.outcome !== 'FLAT');
  const accuracy = directional.length
    ? mean(directional.map((row, index) => {
      const prediction = predictions[rows.indexOf(row)] >= 0.5;
      return prediction === (row.outcome === 'UP') ? 1 : 0;
    })) : null;
  return {
    sample_count: rows.length,
    evaluated: true,
    model_brier_score: Number(modelBrier.toFixed(5)),
    base_rate_brier_score: Number(baselineBrier.toFixed(5)),
    accuracy_directional_pct: accuracy === null ? null : Number((accuracy * 100).toFixed(1)),
    beat_base_rate: modelBrier + 0.002 < baselineBrier,
    improvement_vs_base_rate: Number((baselineBrier - modelBrier).toFixed(5))
  };
}

/**
 * Fits on earlier examples only. Later examples are isolated as a holdout.
 * Any training label that resolves at or after the first holdout timestamp is
 * purged, preventing the +4h outcome window from leaking into holdout features.
 */
export function buildCognitiveLearningProfile(samples = [], {
  minTrainingSamples = 60, minimumBucket = 8, minimumHoldoutSamples = 20,
  holdoutFraction = 0.2, l2 = 0.18
} = {}) {
  const resolved = validResolvedSamples(samples);
  const uniqueTimes = [...new Set(resolved.map(row => row.at))].sort((a, b) => a - b);
  const enoughForHoldout = resolved.length >= minTrainingSamples + minimumHoldoutSamples && uniqueTimes.length >= 2;
  const splitIndex = enoughForHoldout
    ? Math.max(1, Math.min(uniqueTimes.length - 1, Math.floor(uniqueTimes.length * (1 - holdoutFraction))))
    : uniqueTimes.length;
  const holdoutStartAt = enoughForHoldout ? uniqueTimes[splitIndex] : null;
  const holdout = holdoutStartAt === null ? [] : resolved.filter(row => row.at >= holdoutStartAt);
  const beforeCutoff = holdoutStartAt === null ? resolved : resolved.filter(row => row.at < holdoutStartAt);
  const training = holdoutStartAt === null ? resolved : beforeCutoff.filter(row => row.resolved_at < holdoutStartAt);
  const purged = holdoutStartAt === null ? [] : beforeCutoff.filter(row => row.resolved_at >= holdoutStartAt);
  const fitted = fitLogisticModel(training, { l2 });
  const evidence = factorEvidence(training, { minimumBucket });
  const rankingReady = training.length >= minTrainingSamples && evidence.covered_factor_buckets >= 4;
  const holdoutMetrics = evaluateHoldout(holdout, fitted);
  const probabilityReady = rankingReady && holdoutMetrics.evaluated === true &&
    holdoutMetrics.beat_base_rate === true;
  const outcomes = {
    up: training.filter(row => row.outcome === 'UP').length,
    down: training.filter(row => row.outcome === 'DOWN').length,
    flat: training.filter(row => row.outcome === 'FLAT').length
  };
  return {
    method: 'REGULARIZED_INTERACTION_MODEL_WITH_PURGED_CHRONOLOGICAL_HOLDOUT_V2',
    ranking_ready: rankingReady,
    probability_ready: probabilityReady,
    ready: rankingReady,
    resolved_samples: resolved.length,
    training_samples: training.length,
    holdout_samples: holdout.length,
    purged_overlap_samples: purged.length,
    required_training_samples: minTrainingSamples,
    required_factor_buckets: 4,
    covered_factor_buckets: evidence.covered_factor_buckets,
    holdout_start_at: holdoutStartAt,
    max_training_outcome_resolved_at: training.length ? Math.max(...training.map(row => row.resolved_at)) : null,
    outcome_counts: outcomes,
    training_positive_rate_pct: Number((fitted.base_rate * 100).toFixed(1)),
    holdout: holdoutMetrics,
    factor_evidence: evidence.factors,
    feature_names: [...FEATURE_NAMES],
    identifier_features_used: false,
    note: probabilityReady
      ? 'MODEL_BEAT_PURGED_CHRONOLOGICAL_HOLDOUT_BASE_RATE'
      : rankingReady
        ? 'RANKING_EVIDENCE_READY_BUT_PROBABILITY_NOT_VALIDATED_OUT_OF_SAMPLE'
        : 'INSUFFICIENT_MATURED_CLOSED_CANDLE_OUTCOMES_OR_FACTOR_COVERAGE',
    _fit: fitted
  };
}

export function applyCognitiveRankAdjustment(baseScore, features = {}, profile = {}) {
  const score = finite(baseScore);
  if (score === null || profile?.probability_ready !== true || !profile?._fit) return null;
  const probability = predictFromFit(features, profile._fit);
  if (probability === null) return null;
  const adjustment = clamp((probability - Number(profile._fit.base_rate)) * 12, -3, 3);
  return Number(clamp(score + adjustment, 0, 100).toFixed(1));
}

function counterfactualEvidence(features, fit) {
  const baseline = predictFromFit(features, fit);
  if (baseline === null) return [];
  const variants = [
    ['BUYER_PRESSURE', { taker_buy_ratio: 0.5 }],
    ['VOLUME_EXPANSION', { volume_ratio: 1 }],
    ['TRADE_EXPANSION', { trade_ratio: 1 }],
    ['PRICE_STRUCTURE', { higher_low: false, breakout_above_prior_high: false }],
    ['VOLATILITY_COMPRESSION', { compression_ratio: 1 }],
    ['RELATIVE_STRENGTH', { relative_strength_vs_btc_pct: 0 }],
    ['MULTI_HOUR_TREND', { trend_aligned: false, return_3h_pct: 0 }],
    ['MICRO_BUY_PRESSURE', { micro_5m_available: false, micro_5m_taker_buy_ratio: null }]
  ];
  return variants.map(([key, changes]) => {
    const altered = { ...features, ...changes };
    const alternative = predictFromFit(altered, fit);
    return {
      factor: key,
      probability_without_factor_pct: alternative === null ? null : Number((alternative * 100).toFixed(1)),
      contribution_percentage_points: alternative === null
        ? null : Number(((baseline - alternative) * 100).toFixed(1))
    };
  }).filter(row => row.contribution_percentage_points !== null)
    .sort((a, b) => Math.abs(b.contribution_percentage_points) - Math.abs(a.contribution_percentage_points))
    .slice(0, 6);
}

export function assessCognitiveCandidate(candidate, profile = {}, now = Date.now()) {
  const symbol = String(candidate?.symbol || '').trim().toUpperCase();
  const features = candidate?.features && typeof candidate.features === 'object' ? candidate.features : {};
  const daily = finite(candidate?.change_24h_pct);
  const hourly = finite(features.hourly_return_pct);
  const recent15 = finite(features.recent_15m_return_pct) ?? finite(features.price_change_15m_pct);
  const micro5 = finite(features.micro_5m_return_pct);
  const candleAge = finite(candidate?.candle_age_ms);
  const price = finite(candidate?.price);
  const score = finite(candidate?.score);
  const validData = /^[A-Z0-9]{5,30}$/.test(symbol) && candidate?.data_valid === true &&
    candidate?.data_stale !== true && candidate?.closed_candles_only === true &&
    price !== null && price > 0 && score !== null && candleAge !== null &&
    candleAge >= 0 && candleAge <= 20 * 60 * 1000;
  const base = {
    version: 2,
    symbol,
    assessed_at: Number(now),
    entry_eligible: false,
    paper_trading: true,
    real_order_execution: false,
    probability_status: profile?.probability_ready === true ? 'OUT_OF_SAMPLE_VALIDATED' : 'NOT_VALIDATED'
  };
  if (!validData) return {
    ...base, decision: 'DATA_UNAVAILABLE',
    summary_ar: 'لا يمكن إصدار حكم؛ بيانات السعر أو الشمعة المغلقة غير مكتملة أو قديمة.',
    reason_codes: ['FRESH_VALID_CLOSED_CANDLE_REQUIRED'],
    hypotheses: [], contradictions: [], counterfactual_evidence: [],
    predicted_up_probability: null, confidence_label: 'UNKNOWN'
  };

  const flags = factorValues(features);
  const dailyLate = daily !== null && daily >= 8;
  const late = candidate?.tier === 'LATE_MOVE' || candidate?.thresholds?.late_move === true ||
    dailyLate || (hourly !== null && hourly >= 5) ||
    (recent15 !== null && recent15 >= 2.5) || (micro5 !== null && micro5 >= 3);
  const volume = finite(features.volume_ratio);
  const buyer = finite(features.taker_buy_ratio);
  const relative = finite(features.relative_strength_vs_btc_pct);
  const upperWick = finite(features.upper_wick_pct);
  const range = finite(features.current_range_pct);
  const contradictions = [];
  if (volume !== null && volume >= 1.5 && buyer !== null && buyer < 0.48)
    contradictions.push('تزايد الحجم دون ضغط شراء مؤيد');
  if (relative !== null && relative < -1)
    contradictions.push('ضعف نسبي واضح مقابل BTC');
  if (upperWick !== null && range !== null && range > 0 && upperWick / range > 0.55)
    contradictions.push('ذيل علوي كبير قد يدل على رفض الأسعار الأعلى');
  if (daily !== null && daily < -5)
    contradictions.push('ضغط هبوطي يومي مرتفع');

  const activityEvidence = [flags.volume_expansion, flags.trade_expansion, flags.buyer_flow].filter(Boolean).length;
  const supportingDomains = Object.values(flags).filter(Boolean).length;
  const hypotheses = [
    { key: 'BUYER_ACCUMULATION', label_ar: 'تراكم وضغط شراء',
      supported: activityEvidence >= 2 && flags.buyer_flow, evidence: activityEvidence, required: 2 },
    { key: 'VOLATILITY_COMPRESSION', label_ar: 'قاعدة هادئة وانكماش تذبذب',
      supported: flags.volatility_compression, evidence: flags.volatility_compression ? 1 : 0, required: 1 },
    { key: 'PRICE_STRUCTURE', label_ar: 'تحسن بنية السعر',
      supported: flags.price_structure, evidence: flags.price_structure ? 1 : 0, required: 1 },
    { key: 'RELATIVE_STRENGTH', label_ar: 'تفوق نسبي على BTC',
      supported: flags.relative_strength, evidence: flags.relative_strength ? 1 : 0, required: 1 },
    { key: 'MULTI_TIMEFRAME_TREND', label_ar: 'اتجاه متوافق على أكثر من إطار',
      supported: flags.multi_hour_trend && flags.short_momentum,
      evidence: [flags.multi_hour_trend, flags.short_momentum].filter(Boolean).length, required: 2 }
  ];
  const noChase = (daily === null || daily <= 7) &&
    (hourly === null || hourly <= 3.5) &&
    (recent15 === null || recent15 <= 1.5) &&
    (micro5 === null || micro5 <= 1.8);
  const predicted = profile?.probability_ready === true
    ? predictFromFit(features, profile._fit) : null;
  const reasons = [];
  if (flags.volume_expansion) reasons.push('VOLUME_EXPANSION');
  if (flags.trade_expansion) reasons.push('TRADE_ACTIVITY_EXPANSION');
  if (flags.buyer_flow) reasons.push('BUYER_FLOW_SUPPORT');
  if (flags.price_structure) reasons.push('CLOSED_CANDLE_PRICE_STRUCTURE');
  if (flags.volatility_compression) reasons.push('VOLATILITY_COMPRESSION');
  if (flags.relative_strength) reasons.push('RELATIVE_STRENGTH_VS_BTC');
  if (!noChase) reasons.push('ANTI_CHASE_REVIEW_REQUIRED');
  if (contradictions.length) reasons.push('CONTRADICTORY_EVIDENCE_PRESENT');

  let decision = 'NO_SETUP';
  let summary = 'الأدلة الحالية لا تكفي لتصنيف فرصة مبكرة؛ يواصل المراقبة ولا يفتح أي صفقة.';
  if (late || !noChase) {
    decision = 'AVOID_CHASING';
    summary = 'الحركة امتدت؛ يتجنب مطاردة السعر وينتظر قاعدة وإشارة جديدة.';
  } else if (activityEvidence >= 2 && flags.price_structure && supportingDomains >= 4 &&
      contradictions.length === 0 && (predicted === null || predicted >= 0.55)) {
    decision = 'EARLY_SETUP_REVIEW';
    summary = predicted === null
      ? 'تجمعت أدلة مبكرة مستقلة؛ المراجعة والمحاكاة فقط حتى يثبت النموذج تعلمه خارج العينة.'
      : 'الأدلة المبكرة متوافقة، والنموذج المتعلم يدعمها في اختبار زمني مستقل؛ مراجعة ومحاكاة فقط.';
  } else if (supportingDomains >= 2 || contradictions.length > 0 || (predicted !== null && predicted < 0.48)) {
    decision = 'WATCH_AND_REASSESS';
    summary = contradictions.length
      ? 'الأدلة متعارضة؛ يخفض الثقة ويعيد الفحص بعد شمعة مغلقة جديدة.'
      : 'بعض الأدلة موجودة لكنّها لا تكفي؛ ينتظر معلومات جديدة ولا يتعجل.';
  }
  const counterfactuals = predicted === null ? [] : counterfactualEvidence(features, profile._fit);
  return {
    ...base,
    decision,
    summary_ar: summary,
    reason_codes: reasons.length ? reasons : ['INSUFFICIENT_CONFLUENT_EVIDENCE'],
    hypotheses,
    contradictions,
    evidence_domains: supportingDomains,
    activity_evidence: activityEvidence,
    anti_chase_passed: noChase,
    predicted_up_probability: predicted === null ? null : Number((predicted * 100).toFixed(1)),
    confidence_label: predicted === null ? 'UNKNOWN' : 'VALIDATED_ON_PURGED_CHRONOLOGICAL_HOLDOUT',
    learning_samples: Number(profile?.resolved_samples) || 0,
    counterfactual_evidence: counterfactuals,
    entry_eligible: false,
    paper_trading: true,
    real_order_execution: false
  };
}
