/**
 * Cognitive research layer for the isolated Build 224 Adaptive Trader.
 *
 * This is an auditable decision-support model, not consciousness or a human brain.
 * It forms multiple evidence hypotheses, learns from matured closed-candle outcomes,
 * and only exposes probabilities after a chronological holdout beats a base-rate model.
 * It never creates exchange orders and never writes to radar configuration.
 */

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const logit = p => Math.log(clamp(p, 0.001, 0.999) / (1 - clamp(p, 0.001, 0.999)));
const logistic = value => 1 / (1 + Math.exp(-clamp(value, -8, 8)));

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

function factorValues(features = {}) {
  return Object.fromEntries(FACTORS.map(factor => [factor.key, Boolean(factor.test(features || {}))]));
}

function validResolvedSamples(samples) {
  const seen = new Set();
  return (Array.isArray(samples) ? samples : [])
    .filter(row => {
      if (!row || row.training_eligible !== true ||
          !['UP', 'DOWN', 'FLAT'].includes(row.outcome) ||
          !row.features || typeof row.features !== 'object') return false;
      const id = String(row.id || '');
      if (!id || seen.has(id)) return false;
      const at = finite(row.at);
      if (at === null || at <= 0) return false;
      seen.add(id);
      return true;
    })
    .map(row => ({ ...row, at: Number(row.at), factors: factorValues(row.features) }))
    .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
}

function betaRate(wins, count) {
  // Beta(2,2) smoothing prevents tiny buckets from appearing certain.
  return (wins + 2) / (count + 4);
}

function fitProfile(training, { minimumBucket = 8 } = {}) {
  const up = training.filter(row => row.outcome === 'UP').length;
  const baseRate = betaRate(up, training.length);
  const baseLogit = logit(baseRate);
  const factors = {};
  let covered = 0;
  for (const factor of FACTORS) {
    const rows = training.filter(row => row.factors[factor.key]);
    const wins = rows.filter(row => row.outcome === 'UP').length;
    const posterior = betaRate(wins, rows.length);
    const shrink = rows.length / (rows.length + 20);
    const logOddsLift = clamp((logit(posterior) - baseLogit) * shrink, -0.45, 0.45);
    const scoreAdjustment = rows.length >= minimumBucket
      ? clamp((posterior - baseRate) * 12 * shrink, -1.5, 1.5) : 0;
    if (rows.length >= minimumBucket) covered++;
    factors[factor.key] = {
      label_ar: factor.label_ar,
      samples: rows.length,
      up: wins,
      down: rows.filter(row => row.outcome === 'DOWN').length,
      flat: rows.filter(row => row.outcome === 'FLAT').length,
      posterior_up_rate_pct: Number((posterior * 100).toFixed(1)),
      log_odds_lift: Number(logOddsLift.toFixed(4)),
      ranking_adjustment: Number(scoreAdjustment.toFixed(2)),
      evidence_ready: rows.length >= minimumBucket
    };
  }
  return { base_rate: baseRate, base_logit: baseLogit, factors, covered_factor_buckets: covered };
}

function predictFromFit(features, fit) {
  let value = fit.base_logit;
  const flags = factorValues(features);
  for (const factor of FACTORS) {
    if (flags[factor.key]) value += Number(fit.factors[factor.key]?.log_odds_lift) || 0;
  }
  return clamp(logistic(value), 0.03, 0.97);
}

function evaluateHoldout(rows, fit) {
  if (rows.length < 20) return {
    sample_count: rows.length, evaluated: false, model_brier_score: null,
    base_rate_brier_score: null, accuracy_at_50_pct: null,
    reason: 'HOLDOUT_REQUIRES_20_OUTCOMES'
  };
  const base = fit.base_rate;
  const actuals = rows.map(row => row.outcome === 'UP' ? 1 : 0);
  const predictions = rows.map(row => predictFromFit(row.features, fit));
  const modelBrier = mean(predictions.map((p, index) => (p - actuals[index]) ** 2));
  const baselineBrier = mean(actuals.map(actual => (base - actual) ** 2));
  const accuracy = mean(predictions.map((p, index) => (p >= 0.5 ? 1 : 0) === actuals[index] ? 1 : 0));
  return {
    sample_count: rows.length,
    evaluated: true,
    model_brier_score: Number(modelBrier.toFixed(4)),
    base_rate_brier_score: Number(baselineBrier.toFixed(4)),
    accuracy_at_50_pct: Number((accuracy * 100).toFixed(1)),
    beat_base_rate: modelBrier + 0.005 < baselineBrier
  };
}

/**
 * Uses a chronological split: earlier resolved examples fit the model; the latest
 * 20% are kept out of fitting and used only for the model-vs-base-rate check.
 */
export function buildCognitiveLearningProfile(samples = [], {
  minTrainingSamples = 60, minimumBucket = 8, minimumHoldoutSamples = 20
} = {}) {
  const resolved = validResolvedSamples(samples);
  const holdoutCount = resolved.length >= minTrainingSamples + minimumHoldoutSamples
    ? Math.max(minimumHoldoutSamples, Math.floor(resolved.length * 0.2)) : 0;
  const training = holdoutCount ? resolved.slice(0, -holdoutCount) : resolved;
  const holdout = holdoutCount ? resolved.slice(-holdoutCount) : [];
  const fit = fitProfile(training, { minimumBucket });
  const rankingReady = training.length >= minTrainingSamples && fit.covered_factor_buckets >= 4;
  const holdoutMetrics = evaluateHoldout(holdout, fit);
  const probabilityReady = rankingReady && holdoutMetrics.evaluated === true &&
    holdoutMetrics.beat_base_rate === true;
  return {
    method: 'BAYESIAN_FACTOR_EVIDENCE_WITH_CHRONOLOGICAL_HOLDOUT_V1',
    ranking_ready: rankingReady,
    probability_ready: probabilityReady,
    ready: rankingReady,
    resolved_samples: resolved.length,
    training_samples: training.length,
    holdout_samples: holdout.length,
    required_training_samples: minTrainingSamples,
    required_factor_buckets: 4,
    covered_factor_buckets: fit.covered_factor_buckets,
    outcome_counts: {
      up: training.filter(row => row.outcome === 'UP').length,
      down: training.filter(row => row.outcome === 'DOWN').length,
      flat: training.filter(row => row.outcome === 'FLAT').length
    },
    training_positive_rate_pct: Number((fit.base_rate * 100).toFixed(1)),
    holdout: holdoutMetrics,
    factors: fit.factors,
    note: probabilityReady
      ? 'PROBABILITY_MODEL_BEAT_CHRONOLOGICAL_BASE_RATE_HOLDOUT'
      : rankingReady
        ? 'RANKING_EVIDENCE_READY_BUT_PROBABILITY_NOT_VALIDATED_OUT_OF_SAMPLE'
        : 'INSUFFICIENT_MATURED_CLOSED_CANDLE_OUTCOMES_OR_FACTOR_COVERAGE',
    _fit: fit
  };
}

export function applyCognitiveRankAdjustment(baseScore, features = {}, profile = {}) {
  const score = finite(baseScore);
  if (score === null || profile?.ranking_ready !== true || !profile?._fit?.factors) return score;
  const active = FACTORS.filter(factor => factor.test(features || {}))
    .map(factor => Number(profile._fit.factors[factor.key]?.ranking_adjustment) || 0);
  if (!active.length) return Number(clamp(score, 0, 100).toFixed(1));
  const meanAdjustment = active.reduce((sum, value) => sum + value, 0) / active.length;
  return Number(clamp(score + clamp(meanAdjustment, -2, 2), 0, 100).toFixed(1));
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
    version: 1,
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
    hypotheses: [], contradictions: ['البيانات غير صالحة للتحليل'],
    predicted_up_probability: null, confidence_label: 'UNKNOWN'
  };

  const flags = factorValues(features);
  const dailyLate = daily !== null && daily >= 8;
  const late = candidate?.tier === 'LATE_MOVE' || candidate?.thresholds?.late_move === true ||
    dailyLate || (hourly !== null && hourly >= 5) ||
    (recent15 !== null && recent15 >= 2.5) || (micro5 !== null && micro5 >= 3);
  const volume = finite(features.volume_ratio);
  const trades = finite(features.trade_ratio);
  const buyer = finite(features.taker_buy_ratio);
  const relative = finite(features.relative_strength_vs_btc_pct);
  const compression = finite(features.compression_ratio);
  const upperWick = finite(features.upper_wick_pct);
  const range = finite(features.current_range_pct);
  const contradictions = [];
  if (volume !== null && volume >= 1.5 && buyer !== null && buyer < 0.48)
    contradictions.push('تزايد الحجم دون ضغط شراء مؤيد');
  if (relative !== null && relative < -1)
    contradictions.push('ضعف نسبي واضح مقابل BTC');
  if (upperWick !== null && range !== null && range > 0 && upperWick / range > 0.55)
    contradictions.push('ذيل علوي كبير قد يدل على رفض الأسعار الأعلى');
  if (daily !== null && daily < -5) contradictions.push('ضغط هبوطي يومي مرتفع');

  const activityEvidence = [flags.volume_expansion, flags.trade_expansion, flags.buyer_flow].filter(Boolean).length;
  const structureEvidence = flags.price_structure ? 1 : 0;
  const supportingDomains = Object.values(flags).filter(Boolean).length;
  const hypotheses = [
    { key: 'BUYER_ACCUMULATION', label_ar: 'تراكم وضغط شراء', supported: activityEvidence >= 2 && flags.buyer_flow,
      evidence: activityEvidence, required: 2 },
    { key: 'VOLATILITY_COMPRESSION', label_ar: 'قاعدة هادئة وانكماش تذبذب',
      supported: flags.volatility_compression, evidence: compression === null ? 0 : 1, required: 1 },
    { key: 'PRICE_STRUCTURE', label_ar: 'تحسن بنية السعر',
      supported: flags.price_structure, evidence: structureEvidence, required: 1 },
    { key: 'RELATIVE_STRENGTH', label_ar: 'تفوق نسبي على BTC',
      supported: flags.relative_strength, evidence: relative === null ? 0 : 1, required: 1 },
    { key: 'MULTI_TIMEFRAME_TREND', label_ar: 'اتجاه متوافق على أكثر من إطار',
      supported: flags.multi_hour_trend && flags.short_momentum,
      evidence: [flags.multi_hour_trend, flags.short_momentum].filter(Boolean).length, required: 2 }
  ];
  const noChase = (daily === null || daily <= 7) &&
    (hourly === null || hourly <= 3.5) &&
    (recent15 === null || recent15 <= 1.5) &&
    (micro5 === null || micro5 <= 1.8);
  const contradictionsCount = contradictions.length;
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
  if (contradictionsCount) reasons.push('CONTRADICTORY_EVIDENCE_PRESENT');

  let decision = 'NO_SETUP';
  let summary = 'الأدلة الحالية لا تكفي لتصنيف فرصة مبكرة؛ يواصل المراقبة ولا يفتح أي صفقة.';
  if (late || !noChase) {
    decision = 'AVOID_CHASING';
    summary = 'الحركة ممتدة؛ يتجنب مطاردة السعر وينتظر قاعدة وإشارة جديدة.';
  } else if (activityEvidence >= 2 && flags.price_structure && supportingDomains >= 4 && contradictionsCount === 0) {
    decision = 'EARLY_SETUP_REVIEW';
    summary = 'تجمّعت أدلة مبكرة مستقلة؛ تُرفع للمراجعة والمحاكاة فقط وليست أمر شراء.';
  } else if (supportingDomains >= 2 || contradictionsCount > 0) {
    decision = 'WATCH_AND_REASSESS';
    summary = contradictionsCount
      ? 'توجد أدلة متعارضة؛ يخفض الثقة ويعيد الفحص بعد شمعة مغلقة جديدة.'
      : 'ظهرت بعض العلامات، لكنها لا تكفي؛ يستمر في المراقبة دون دخول.';
  }
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
    confidence_label: predicted === null ? 'UNKNOWN' : 'VALIDATED_ON_CHRONOLOGICAL_HOLDOUT',
    learning_samples: Number(profile?.resolved_samples) || 0,
    paper_trading: true,
    real_order_execution: false
  };
}
