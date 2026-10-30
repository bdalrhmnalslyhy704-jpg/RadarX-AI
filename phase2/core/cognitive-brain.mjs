/**
 * RadarX Build 224 — Cognitive Agent V3
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
  'compression_x_structure',
  'volume_x_buyer_x_structure',
  'trade_x_buyer',
  'volume_buyer_structure_confluence'
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
  const coreConfluence = volRaw !== null && volRaw >= 1.5 && buyerRaw !== null && buyerRaw >= 0.52 && structure === 1 ? 1 : 0;

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
    compression * structure,
    volume * buyer * structure,
    trades * buyer,
    coreConfluence
  ];
}

function validResolvedSamples(samples) {
  const seenIds = new Set();
  const seenBaselines = new Set();
  return (Array.isArray(samples) ? samples : [])
    .filter(row => {
      if (!row || row.training_eligible !== true ||
          (row.closed_candle_baseline !== true && row.historical_baseline !== true) ||
          !['UP', 'DOWN', 'FLAT'].includes(row.outcome) ||
          !row.features || typeof row.features !== 'object') return false;
      const id = String(row.id || '');
      const symbol = String(row.symbol || '').trim().toUpperCase();
      const at = finite(row.at);
      const resolvedAt = finite(row.resolved_at);
      const horizon = finite(row.horizon_ms);
      const expectedSource = row.historical_baseline === true
        ? 'HISTORICAL_CLOSED_CANDLE' : 'CLOSED_CANDLE_4H';
      if (!id || !symbol || at === null || at <= 0 ||
          resolvedAt === null || resolvedAt - at !== MIN_OUTCOME_HORIZON_MS ||
          horizon !== MIN_OUTCOME_HORIZON_MS ||
          row.outcome_source !== expectedSource) return false;
      const baselineKey = symbol + ':' + String(Math.trunc(at));
      // A live observation and a later historical backfill can describe the
      // exact same pair/candle under different IDs. Count that market event once.
      if (seenIds.has(id) || seenBaselines.has(baselineKey)) return false;
      seenIds.add(id);
      seenBaselines.add(baselineKey);
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

function fitLogisticModel(training, { l2 = 0.08, iterations = 900, learningRate = 0.12 } = {}) {
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
    base_rate_brier_score: null, log_loss: null, accuracy_directional_pct: null,
    expected_calibration_error: null, beat_base_rate: false,
    reason: 'HOLDOUT_REQUIRES_20_OUTCOMES'
  };
  const base = fit.base_rate;
  const predictions = rows.map(row => predictFromFit(row.features, fit));
  const targets = rows.map(row => row.target);
  const modelBrier = mean(predictions.map((p, index) => (p - targets[index]) ** 2));
  const baselineBrier = mean(targets.map(target => (base - target) ** 2));
  const logLoss = mean(predictions.map((p, index) => {
    const probability = clamp(p, 0.001, 0.999);
    const target = targets[index];
    return -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability));
  }));
  let directionalCorrect = 0, directionalCount = 0;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].outcome === 'FLAT') continue;
    directionalCount++;
    if ((predictions[index] >= 0.5) === (rows[index].outcome === 'UP')) directionalCorrect++;
  }
  let calibrationError = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, predicted: 0, observed: 0 }));
  for (let index = 0; index < rows.length; index++) {
    const bin = bins[Math.min(9, Math.floor(predictions[index] * 10))];
    bin.count++;
    bin.predicted += predictions[index];
    bin.observed += targets[index];
  }
  for (const bin of bins) {
    if (!bin.count) continue;
    calibrationError += (bin.count / rows.length) *
      Math.abs(bin.predicted / bin.count - bin.observed / bin.count);
  }
  return {
    sample_count: rows.length,
    evaluated: true,
    model_brier_score: Number(modelBrier.toFixed(5)),
    base_rate_brier_score: Number(baselineBrier.toFixed(5)),
    log_loss: Number(logLoss.toFixed(5)),
    accuracy_directional_pct: directionalCount
      ? Number((directionalCorrect / directionalCount * 100).toFixed(1)) : null,
    expected_calibration_error: Number(calibrationError.toFixed(5)),
    beat_base_rate: modelBrier + 0.002 < baselineBrier,
    improvement_vs_base_rate: Number((baselineBrier - modelBrier).toFixed(5))
  };
}

/**
 * Uses three chronological blocks. The middle block chooses between the
 * all-history model and a recent-window challenger; the final block is never
 * used for model selection. Labels whose four-hour outcome crosses either
 * boundary are purged from the earlier block.
 */
export function buildCognitiveLearningProfile(samples = [], {
  minTrainingSamples = 60, minimumBucket = 8,
  minimumValidationSamples = 20, minimumHoldoutSamples = 20,
  validationFraction = 0.2, holdoutFraction = 0.2,
  recentWindowFraction = 0.6, recentSelectionMargin = 0.005, l2 = 0.08
} = {}) {
  const resolved = validResolvedSamples(samples);
  const uniqueTimes = [...new Set(resolved.map(row => row.at))].sort((a, b) => a - b);
  const holdoutCount = Math.max(minimumHoldoutSamples, Math.floor(uniqueTimes.length * holdoutFraction));
  const validationCount = Math.max(minimumValidationSamples, Math.floor(uniqueTimes.length * validationFraction));
  const trainingEndIndex = uniqueTimes.length - holdoutCount - validationCount;
  const canSplit = uniqueTimes.length >= 3 && trainingEndIndex > 0;

  if (!canSplit) {
    const fit = fitLogisticModel(resolved, { l2 });
    const evidence = factorEvidence(resolved, { minimumBucket });
    return {
      method: 'NESTED_PURGED_WALK_FORWARD_ADAPTIVE_EVIDENCE_MODEL_V3',
      ranking_ready: false, probability_ready: false, ready: false,
      resolved_samples: resolved.length, training_samples: resolved.length,
      fit_samples: resolved.length, validation_samples: 0, holdout_samples: 0,
      purged_overlap_samples: 0, validation_purged_samples: 0,
      required_training_samples: minTrainingSamples,
      required_validation_samples: minimumValidationSamples,
      required_holdout_samples: minimumHoldoutSamples,
      required_factor_buckets: 4, covered_factor_buckets: evidence.covered_factor_buckets,
      validation_start_at: null, holdout_start_at: null,
      max_training_outcome_resolved_at: resolved.length
        ? Math.max(...resolved.map(row => row.resolved_at)) : null,
      outcome_counts: {
        up: resolved.filter(row => row.outcome === 'UP').length,
        down: resolved.filter(row => row.outcome === 'DOWN').length,
        flat: resolved.filter(row => row.outcome === 'FLAT').length
      },
      training_positive_rate_pct: Number((fit.base_rate * 100).toFixed(1)),
      validation: { evaluated: false, reason: 'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED' },
      holdout: { evaluated: false, reason: 'THREE_CHRONOLOGICAL_BLOCKS_REQUIRED' },
      model_selection: {
        selected_model: 'NONE',
        reason: 'INSUFFICIENT_CHRONOLOGICAL_DATA',
        global_validation_brier_score: null,
        recent_validation_brier_score: null
      },
      regime_adaptation: { status: 'INSUFFICIENT_DATA', recent_window_samples: 0 },
      factor_evidence: evidence.factors,
      feature_names: [...FEATURE_NAMES],
      identifier_features_used: false,
      note: 'INSUFFICIENT_CHRONOLOGICAL_DATA_FOR_NESTED_VALIDATION',
      _fit: fit
    };
  }

  const validationStartAt = uniqueTimes[trainingEndIndex];
  const holdoutStartAt = uniqueTimes[uniqueTimes.length - holdoutCount];
  const trainingPool = resolved.filter(row => row.at < validationStartAt);
  const training = trainingPool.filter(row => row.resolved_at < validationStartAt);
  const purgedTraining = trainingPool.length - training.length;
  const validationPool = resolved.filter(row => row.at >= validationStartAt && row.at < holdoutStartAt);
  const validation = validationPool.filter(row => row.resolved_at < holdoutStartAt);
  const purgedValidation = validationPool.length - validation.length;
  const holdout = resolved.filter(row => row.at >= holdoutStartAt);
  const globalFit = fitLogisticModel(training, { l2 });
  const globalValidation = evaluateHoldout(validation, globalFit);

  const trainingTimes = [...new Set(training.map(row => row.at))].sort((a, b) => a - b);
  const recentStartIndex = Math.max(0,
    Math.min(trainingTimes.length - 1, Math.floor(trainingTimes.length * (1 - recentWindowFraction))));
  const recentStartAt = trainingTimes[recentStartIndex] ?? null;
  const recentTraining = recentStartAt === null
    ? [] : training.filter(row => row.at >= recentStartAt);
  const recentFit = recentTraining.length >= minTrainingSamples
    ? fitLogisticModel(recentTraining, { l2 }) : null;
  const recentValidation = recentFit ? evaluateHoldout(validation, recentFit) : {
    evaluated: false, reason: 'RECENT_WINDOW_REQUIRES_MINIMUM_TRAINING_SAMPLES',
    sample_count: validation.length, model_brier_score: null, base_rate_brier_score: null,
    beat_base_rate: false
  };

  let selectedModel = 'GLOBAL_HISTORY';
  let selectedFit = globalFit;
  let selectedTraining = training;
  let selectedValidation = globalValidation;
  let selectionReason = globalValidation.beat_base_rate
    ? 'GLOBAL_MODEL_VALIDATED_ON_MIDDLE_WINDOW'
    : 'NO_CHALLENGER_VALIDATED_ON_MIDDLE_WINDOW';

  const recentWins = recentValidation.evaluated === true &&
    recentValidation.beat_base_rate === true &&
    (globalValidation.beat_base_rate !== true ||
      recentValidation.model_brier_score + recentSelectionMargin < globalValidation.model_brier_score);
  if (recentWins) {
    selectedModel = 'RECENT_WINDOW';
    selectedFit = recentFit;
    selectedTraining = recentTraining;
    selectedValidation = recentValidation;
    selectionReason = 'RECENT_MODEL_BEAT_GLOBAL_MODEL_ON_MIDDLE_WINDOW';
  }

  const holdoutMetrics = evaluateHoldout(holdout, selectedFit);
  const evidence = factorEvidence(selectedTraining, { minimumBucket });
  const rankingReady = training.length >= minTrainingSamples &&
    validation.length >= minimumValidationSamples &&
    holdout.length >= minimumHoldoutSamples &&
    evidence.covered_factor_buckets >= 4;
  const probabilityReady = rankingReady &&
    selectedValidation.evaluated === true && selectedValidation.beat_base_rate === true &&
    holdoutMetrics.evaluated === true && holdoutMetrics.beat_base_rate === true;
  const outcomes = {
    up: training.filter(row => row.outcome === 'UP').length,
    down: training.filter(row => row.outcome === 'DOWN').length,
    flat: training.filter(row => row.outcome === 'FLAT').length
  };
  const selectedMaxResolvedAt = selectedTraining.length
    ? Math.max(...selectedTraining.map(row => row.resolved_at)) : null;
  const recentGain = globalValidation.evaluated && recentValidation.evaluated
    ? Number((globalValidation.model_brier_score - recentValidation.model_brier_score).toFixed(5))
    : null;

  return {
    method: 'NESTED_PURGED_WALK_FORWARD_ADAPTIVE_EVIDENCE_MODEL_V3',
    ranking_ready: rankingReady,
    probability_ready: probabilityReady,
    ready: rankingReady,
    resolved_samples: resolved.length,
    training_samples: training.length,
    fit_samples: selectedTraining.length,
    validation_samples: validation.length,
    holdout_samples: holdout.length,
    purged_overlap_samples: purgedTraining + purgedValidation,
    validation_purged_samples: purgedValidation,
    required_training_samples: minTrainingSamples,
    required_validation_samples: minimumValidationSamples,
    required_holdout_samples: minimumHoldoutSamples,
    required_factor_buckets: 4,
    covered_factor_buckets: evidence.covered_factor_buckets,
    validation_start_at: validationStartAt,
    holdout_start_at: holdoutStartAt,
    max_training_outcome_resolved_at: selectedMaxResolvedAt,
    outcome_counts: outcomes,
    training_positive_rate_pct: Number((selectedFit.base_rate * 100).toFixed(1)),
    validation: selectedValidation,
    holdout: holdoutMetrics,
    model_selection: {
      selected_model: selectedModel,
      reason: selectionReason,
      recent_window_samples: recentTraining.length,
      global_validation_brier_score: globalValidation.model_brier_score,
      global_validation_base_rate_brier_score: globalValidation.base_rate_brier_score,
      global_validation_beats_base_rate: globalValidation.beat_base_rate === true,
      recent_validation_brier_score: recentValidation.model_brier_score ?? null,
      recent_validation_base_rate_brier_score: recentValidation.base_rate_brier_score ?? null,
      recent_validation_beats_base_rate: recentValidation.beat_base_rate === true,
      recent_validation_gain: recentGain
    },
    regime_adaptation: {
      status: recentWins ? 'RECENT_WINDOW_SELECTED' :
        globalValidation.beat_base_rate ? 'GLOBAL_HISTORY_RETAINED' : 'NO_VALIDATED_MODEL',
      recent_window_samples: recentTraining.length,
      validation_improvement: recentGain,
      validated_on_middle_window: selectedValidation.beat_base_rate === true
    },
    factor_evidence: evidence.factors,
    feature_names: [...FEATURE_NAMES],
    identifier_features_used: false,
    note: probabilityReady
      ? 'SELECTED_MODEL_BEAT_VALIDATION_AND_UNTOUCHED_CHRONOLOGICAL_HOLDOUT_BASE_RATES'
      : rankingReady
        ? 'RANKING_EVIDENCE_READY_BUT_NESTED_VALIDATION_NOT_PASSED'
        : 'INSUFFICIENT_MATURED_OUTCOMES_OR_FACTOR_COVERAGE_AFTER_PURGING',
    _fit: selectedFit
  };
}

/**
 * Scores only immutable, matured forecasts produced before their outcomes
 * were known. This is the live prequential check, separate from historical
 * train/validation/test splits.
 */
export function buildCognitivePrequentialProfile(journal = [], {
  minimumWindowSamples = 20, windowSize = 40
} = {}) {
  const rows = (Array.isArray(journal) ? journal : [])
    .filter(row => row && Number(row.model_version) === 3 &&
      finite(row.predicted_up_probability) !== null &&
      Number(row.predicted_up_probability) >= 0 && Number(row.predicted_up_probability) <= 100 &&
      ['UP', 'DOWN', 'FLAT'].includes(row.outcome) &&
      ['CLOSED_CANDLE_4H', 'HISTORICAL_CLOSED_CANDLE'].includes(row.outcome_source) &&
      finite(row.at) !== null && finite(row.resolved_at) !== null &&
      finite(row.trained_through_at) !== null &&
      Number(row.trained_through_at) < Number(row.at) &&
      Number(row.resolved_at) - Number(row.at) === MIN_OUTCOME_HORIZON_MS)
    .map(row => ({
      ...row,
      prediction: clamp(Number(row.predicted_up_probability) / 100, 0.001, 0.999),
      target: row.outcome === 'UP' ? 1 : row.outcome === 'DOWN' ? 0 : 0.5
    }))
    .sort((a, b) => Number(a.at) - Number(b.at) || String(a.id).localeCompare(String(b.id)));

  const score = subset => {
    if (!subset.length) return {
      sample_count: 0, brier_score: null, log_loss: null,
      directional_accuracy_pct: null, high_confidence_error_count: 0,
      high_confidence_error_rate_pct: null, error_patterns: []
    };
    const brier = mean(subset.map(row => (row.prediction - row.target) ** 2));
    const logLoss = mean(subset.map(row =>
      -(row.target * Math.log(row.prediction) + (1 - row.target) * Math.log(1 - row.prediction))));
    const directional = subset.filter(row => row.outcome !== 'FLAT');
    const accuracy = directional.length
      ? mean(directional.map(row => (row.prediction >= 0.5) === (row.outcome === 'UP') ? 1 : 0))
      : null;
    const confident = directional.filter(row => row.prediction >= 0.8 || row.prediction <= 0.2);
    const confidentErrors = confident.filter(row =>
      (row.prediction >= 0.8 && row.outcome === 'DOWN') ||
      (row.prediction <= 0.2 && row.outcome === 'UP'));
    const reasons = new Map();
    for (const row of subset) {
      for (const reason of new Set(Array.isArray(row.reason_codes) ? row.reason_codes.map(String) : [])) {
        if (!reasons.has(reason)) reasons.set(reason, []);
        reasons.get(reason).push(row);
      }
    }
    const errorPatterns = [...reasons.entries()].map(([reasonCode, group]) => {
      const groupBrier = mean(group.map(row => (row.prediction - row.target) ** 2));
      const groupConfident = group.filter(row => row.outcome !== 'FLAT' &&
        (row.prediction >= 0.8 || row.prediction <= 0.2));
      const groupConfidentErrors = groupConfident.filter(row =>
        (row.prediction >= 0.8 && row.outcome === 'DOWN') ||
        (row.prediction <= 0.2 && row.outcome === 'UP'));
      return {
        reason_code: reasonCode,
        sample_count: group.length,
        brier_score: Number(groupBrier.toFixed(5)),
        high_confidence_errors: groupConfidentErrors.length,
        high_confidence_error_rate_pct: groupConfident.length
          ? Number((groupConfidentErrors.length / groupConfident.length * 100).toFixed(1)) : null
      };
    }).filter(row => row.sample_count >= 3)
      .sort((left, right) => right.brier_score - left.brier_score ||
        right.high_confidence_errors - left.high_confidence_errors)
      .slice(0, 8);
    return {
      sample_count: subset.length,
      brier_score: Number(brier.toFixed(5)),
      log_loss: Number(logLoss.toFixed(5)),
      directional_accuracy_pct: accuracy === null ? null : Number((accuracy * 100).toFixed(1)),
      high_confidence_error_count: confidentErrors.length,
      high_confidence_error_rate_pct: confident.length
        ? Number((confidentErrors.length / confident.length * 100).toFixed(1)) : null,
      error_patterns: errorPatterns
    };
  };

  const recent = rows.slice(-Math.max(minimumWindowSamples, windowSize));
  const previousEnd = Math.max(0, rows.length - recent.length);
  const previous = rows.slice(Math.max(0, previousEnd - Math.max(minimumWindowSamples, windowSize)), previousEnd);
  const recentMetrics = score(recent);
  const previousMetrics = score(previous);
  const enough = recent.length >= minimumWindowSamples && previous.length >= minimumWindowSamples;
  const degradation = enough
    ? Number((recentMetrics.brier_score - previousMetrics.brier_score).toFixed(5)) : null;
  const driftDetected = enough &&
    degradation >= 0.08 &&
    recentMetrics.brier_score >= previousMetrics.brier_score * 1.5;
  return {
    method: 'IMMUTABLE_FORWARD_FORECAST_PREQUENTIAL_AUDIT_V2',
    status: !enough ? 'INSUFFICIENT_FORWARD_PREDICTIONS' :
      driftDetected ? 'FORWARD_PERFORMANCE_DEGRADING' : 'FORWARD_MONITORING_STABLE',
    resolved_forecasts: rows.length,
    minimum_window_samples: minimumWindowSamples,
    previous_window: previousMetrics,
    recent_window: recentMetrics,
    brier_degradation: degradation,
    drift_detected: driftDetected,
    reassessment_required: driftDetected,
    note: driftDetected
      ? 'RECENT_IMMUTABLE_FORECASTS_DEGRADED_VS_PRIOR_WINDOW'
      : 'ONLY_FIRST_RECORDED_MODEL_V3_FORECAST_PER_CLOSED_CANDLE_IS_SCORED'
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
    version: 3,
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
    confidence_label: predicted === null ? 'UNKNOWN' : 'VALIDATED_ON_NESTED_WALK_FORWARD_HOLDOUT',
    learning_samples: Number(profile?.resolved_samples) || 0,
    counterfactual_evidence: counterfactuals,
    entry_eligible: false,
    paper_trading: true,
    real_order_execution: false
  };
}
