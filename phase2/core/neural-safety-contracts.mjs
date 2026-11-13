const DEFAULT_STEPS = 24;
const DEFAULT_CHANNELS = 29;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const EPSILON = 1e-12;

const finite = value => value !== null && value !== undefined &&
  value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const softplus = value => value > 30 ? value : Math.log1p(Math.exp(Math.max(-30, value)));

export function validateTemporalSequenceAlignment({
  id, symbol, at, resolved_at, horizon_ms,
  temporal_sequence, temporal_sequence_timestamps,
  feature_information_cutoff_at = at,
  expectedSteps = DEFAULT_STEPS,
  expectedChannels = DEFAULT_CHANNELS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requireSequenceTimestamps = true
} = {}) {
  const fail = reason => ({
    valid: false, reason, cadence_verified: false,
    steps: Array.isArray(temporal_sequence) ? temporal_sequence.length : 0,
    channels: Array.isArray(temporal_sequence?.[0]) ? temporal_sequence[0].length : 0
  });
  if (typeof id !== 'string' || !id.trim()) return fail('TEMPORAL_ID_MISSING');
  if (typeof symbol !== 'string' || !symbol.trim()) return fail('TEMPORAL_SYMBOL_MISSING');
  if (![at, resolved_at, horizon_ms, feature_information_cutoff_at].every(finite))
    return fail('TEMPORAL_EVENT_TIME_NON_FINITE');
  if (Number(feature_information_cutoff_at) !== Number(at))
    return fail('FEATURE_CUTOFF_DIFFERS_FROM_BASELINE');
  if (Number(resolved_at) - Number(at) !== Number(horizon_ms))
    return fail('OUTCOME_MATURITY_DOES_NOT_MATCH_HORIZON');
  if (!Array.isArray(temporal_sequence) || temporal_sequence.length !== expectedSteps)
    return fail('TEMPORAL_SEQUENCE_STEP_COUNT_MISMATCH');
  for (let step = 0; step < temporal_sequence.length; step++) {
    const row = temporal_sequence[step];
    if (!Array.isArray(row) || row.length !== expectedChannels)
      return fail('TEMPORAL_SEQUENCE_CHANNEL_COUNT_MISMATCH:' + step);
    if (row.some(value => !finite(value) || Math.abs(Number(value)) > 4))
      return fail('TEMPORAL_SEQUENCE_VALUE_NON_FINITE_OR_OUT_OF_RANGE:' + step);
  }
  if (!Array.isArray(temporal_sequence_timestamps)) {
    return requireSequenceTimestamps
      ? fail('TEMPORAL_SEQUENCE_TIMESTAMPS_MISSING')
      : {
          valid: true, reason: 'LEGACY_ANCHOR_ONLY_TIMESTAMP_AUDIT',
          cadence_verified: false, legacy_untimed: true,
          steps: expectedSteps, channels: expectedChannels
        };
  }
  if (temporal_sequence_timestamps.length !== expectedSteps ||
      temporal_sequence_timestamps.some(value => !finite(value)))
    return fail('TEMPORAL_SEQUENCE_TIMESTAMP_COUNT_OR_VALUE_INVALID');
  const times = temporal_sequence_timestamps.map(Number);
  for (let step = 1; step < times.length; step++) {
    if (times[step] - times[step - 1] !== intervalMs)
      return fail('TEMPORAL_SEQUENCE_TIMESTAMP_GAP_OR_REORDER:' + step);
  }
  if (times.at(-1) !== Number(at))
    return fail('TEMPORAL_SEQUENCE_LAST_CLOSE_DIFFERS_FROM_BASELINE');
  return {
    valid: true, reason: 'EXACT_CAUSAL_15M_SEQUENCE_ALIGNMENT',
    cadence_verified: true, legacy_untimed: false,
    first_close_time: times[0], last_close_time: times.at(-1),
    steps: expectedSteps, channels: expectedChannels,
    interval_ms: intervalMs
  };
}

/**
 * Construct an exact causal grid. Only explicitly allow-listed sparse feature
 * channels may be carried forward. Prices/OHLC must never be forward-filled.
 * Every imputation gets a separate mask and a maximum consecutive-gap limit.
 */
export function causalForwardFillWindow(observations, {
  endTimestamp, expectedSteps = DEFAULT_STEPS, intervalMs = DEFAULT_INTERVAL_MS,
  expectedChannels = DEFAULT_CHANNELS, allowedSparseChannels = [],
  maxGapIntervals = 1
} = {}) {
  if (!Array.isArray(observations) || observations.length === 0)
    throw new TypeError('FORWARD_FILL_OBSERVATIONS_REQUIRED');
  if (!finite(endTimestamp) || !Number.isInteger(expectedSteps) || expectedSteps < 1 ||
      !Number.isInteger(intervalMs) || intervalMs < 1 ||
      !Number.isInteger(expectedChannels) || expectedChannels < 1 ||
      !Number.isInteger(maxGapIntervals) || maxGapIntervals < 0)
    throw new TypeError('FORWARD_FILL_CONFIGURATION_INVALID');
  const allowed = new Set(allowedSparseChannels);
  for (const channel of allowed) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= expectedChannels)
      throw new TypeError('FORWARD_FILL_ALLOWLIST_CHANNEL_INVALID:' + channel);
  }
  const grid = Array.from({ length: expectedSteps }, (_, index) =>
    Number(endTimestamp) - (expectedSteps - 1 - index) * intervalMs);
  const byTime = new Map();
  for (const row of observations) {
    if (!row || !finite(row.timestamp))
      throw new TypeError('FORWARD_FILL_OBSERVATION_TIMESTAMP_INVALID');
    const timestamp = Number(row.timestamp);
    if (timestamp > Number(endTimestamp))
      throw new TypeError('FORWARD_FILL_FUTURE_OBSERVATION_FORBIDDEN');
    if (!grid.includes(timestamp))
      throw new TypeError('FORWARD_FILL_OBSERVATION_OFF_GRID:' + timestamp);
    if (byTime.has(timestamp))
      throw new TypeError('FORWARD_FILL_DUPLICATE_TIMESTAMP:' + timestamp);
    if (row.values !== null && row.values !== undefined &&
        (!Array.isArray(row.values) || row.values.length !== expectedChannels))
      throw new TypeError('FORWARD_FILL_OBSERVATION_SHAPE_INVALID');
    byTime.set(timestamp, row.values ?? null);
  }
  const output = [], masks = [];
  const lastValue = Array(expectedChannels).fill(null);
  const gapLength = Array(expectedChannels).fill(0);
  let imputedValues = 0;
  for (const timestamp of grid) {
    const source = byTime.get(timestamp) ?? null;
    const values = Array(expectedChannels);
    const mask = Array(expectedChannels).fill(0);
    for (let channel = 0; channel < expectedChannels; channel++) {
      const raw = source?.[channel];
      if (finite(raw)) {
        values[channel] = Number(raw);
        lastValue[channel] = Number(raw);
        gapLength[channel] = 0;
        mask[channel] = 1;
        continue;
      }
      if (!allowed.has(channel))
        throw new TypeError('FORWARD_FILL_NOT_ALLOWED_FOR_CHANNEL:' + channel + '@' + timestamp);
      gapLength[channel]++;
      if (lastValue[channel] === null || gapLength[channel] > maxGapIntervals)
        throw new TypeError('FORWARD_FILL_GAP_EXCEEDS_SAFE_LIMIT:' + channel + '@' + timestamp);
      values[channel] = lastValue[channel];
      mask[channel] = 0;
      imputedValues++;
    }
    output.push(values);
    masks.push(mask);
  }
  return {
    timestamps: grid, values: output, observation_masks: masks,
    imputed_values: imputedValues, imputation_policy: 'CAUSAL_ALLOWLISTED_FEATURE_CHANNELS_ONLY_V1'
  };
}

export function prequalifyHybridComponent({
  name, fitValid, selection = {}, requiredMargin = 0.00025,
  minimumSamples = 40, minimumPositive = 3, minimumNegative = 8
} = {}) {
  const samples = Number(selection.samples);
  const positives = Number(selection.positive);
  const negatives = Number(selection.negative);
  const model = Number(selection.candidateBrier);
  const logistic = Number(selection.logisticBrier);
  const finiteMetrics = [samples, positives, negatives, model, logistic, requiredMargin]
    .every(Number.isFinite);
  const support = finiteMetrics && samples >= minimumSamples &&
    positives >= minimumPositive && negatives >= minimumNegative &&
    positives + negatives === samples;
  const improvement = finiteMetrics ? logistic - model : null;
  const passed = fitValid === true && support &&
    improvement !== null && improvement - requiredMargin > 1e-12;
  return {
    name: String(name || 'UNNAMED_COMPONENT'),
    evaluated: finiteMetrics,
    fit_valid: fitValid === true,
    support_ready: support,
    samples: finiteMetrics ? samples : null,
    positive_samples: finiteMetrics ? positives : null,
    negative_samples: finiteMetrics ? negatives : null,
    candidate_brier: finiteMetrics ? model : null,
    same_window_logistic_brier: finiteMetrics ? logistic : null,
    improvement,
    required_margin: requiredMargin,
    qualified: passed,
    reason: passed ? 'STANDALONE_INNER_OOS_BEAT_LOGISTIC' :
      fitValid !== true ? 'COMPONENT_FIT_INVALID' :
      !finiteMetrics ? 'COMPONENT_SELECTION_METRICS_MISSING_OR_NON_FINITE' :
      !support ? 'COMPONENT_SELECTION_CLASS_SUPPORT_INSUFFICIENT' :
      'COMPONENT_DID_NOT_BEAT_SAME_WINDOW_LOGISTIC_BY_REQUIRED_MARGIN'
  };
}

export function prequalifyHybridComponents(components, {
  requiredMargin = 0.00025, minimumQualified = 2
} = {}) {
  const audits = (Array.isArray(components) ? components : []).map(component =>
    prequalifyHybridComponent({ ...component, requiredMargin }));
  const qualified = audits.filter(row => row.qualified);
  return {
    qualified: qualified.length >= minimumQualified,
    required_qualified_components: minimumQualified,
    qualified_component_count: qualified.length,
    components: audits,
    reason: qualified.length >= minimumQualified
      ? 'MINIMUM_STANDALONE_COMPONENTS_QUALIFIED'
      : 'HYBRID_COMPONENT_STARVATION_PREVENTS_FUSION'
  };
}

/**
 * Proper Brier base + within-timestamp pairwise ranking + false-positive
 * confidence penalty + a training-only hinge toward the same-window Logistic
 * Brier. This guides optimization; it cannot guarantee external superiority.
 */
export function calculateAsymmetricDirectionalRankingLoss({
  logits, targets, timestamps, symbols = [], baselineLogits,
  sampleWeights = [], config = {}
} = {}) {
  if (!Array.isArray(logits) || !Array.isArray(targets) || logits.length === 0 ||
      targets.length !== logits.length || !Array.isArray(baselineLogits) ||
      baselineLogits.length !== logits.length)
    throw new TypeError('DIRECTIONAL_LOSS_VECTOR_SHAPE_INVALID');
  const n = logits.length;
  if (logits.some(value => !finite(value)) ||
      baselineLogits.some(value => !finite(value)) ||
      targets.some(value => value !== 0 && value !== 1))
    throw new TypeError('DIRECTIONAL_LOSS_INPUT_NON_FINITE_OR_NON_BINARY');
  if (!Array.isArray(timestamps) || timestamps.length !== n ||
      timestamps.some(value => !finite(value)))
    throw new TypeError('DIRECTIONAL_LOSS_TIMESTAMP_VECTOR_INVALID');
  if (symbols.length && (!Array.isArray(symbols) || symbols.length !== n))
    throw new TypeError('DIRECTIONAL_LOSS_SYMBOL_VECTOR_INVALID');
  const weights = sampleWeights.length ? sampleWeights : Array(n).fill(1);
  if (!Array.isArray(weights) || weights.length !== n ||
      weights.some(value => !finite(value) || Number(value) <= 0))
    throw new TypeError('DIRECTIONAL_LOSS_SAMPLE_WEIGHTS_INVALID');
  const cfg = {
    brierWeight: 1,
    rankingWeight: 0.25,
    falsePositiveWeight: 0.5,
    baselineGapWeight: 0.2,
    pairMargin: 0.1,
    pairTemperature: 0.5,
    falsePositiveProbabilityThreshold: 0.7,
    requiredBaselineImprovement: 0.00025,
    maxPairsPerTimestamp: 256,
    ...config
  };
  for (const [key, value] of Object.entries(cfg)) {
    if (!finite(value) || Number(value) < 0)
      throw new TypeError('DIRECTIONAL_LOSS_CONFIG_INVALID:' + key);
  }
  if (cfg.pairTemperature <= 0 || cfg.falsePositiveProbabilityThreshold >= 1 ||
      cfg.maxPairsPerTimestamp < 1)
    throw new TypeError('DIRECTIONAL_LOSS_CONFIG_OUT_OF_RANGE');
  const probs = logits.map(value => sigmoid(Number(value)));
  const baselineProbs = baselineLogits.map(value => sigmoid(Number(value)));
  const weightSum = weights.reduce((sum, value) => sum + Number(value), 0);
  if (!(weightSum > 0)) throw new TypeError('DIRECTIONAL_LOSS_WEIGHT_SUM_INVALID');
  const candidateBrier = probs.reduce((sum, p, i) =>
    sum + Number(weights[i]) * (p - targets[i]) ** 2, 0) / weightSum;
  const baselineBrier = baselineProbs.reduce((sum, p, i) =>
    sum + Number(weights[i]) * (p - targets[i]) ** 2, 0) / weightSum;
  const gradient = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    gradient[i] += cfg.brierWeight * 2 * (probs[i] - targets[i]) *
      probs[i] * (1 - probs[i]) * Number(weights[i]) / weightSum;
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const key = String(Number(timestamps[i]));
    if (!groups.has(key)) groups.set(key, { positive: [], negative: [] });
    groups.get(key)[targets[i] === 1 ? 'positive' : 'negative'].push(i);
  }
  const pairs = [];
  for (const [timestamp, group] of groups) {
    const candidates = [];
    for (const positive of group.positive) {
      for (const negative of group.negative) {
        if (symbols.length && String(symbols[positive]) === String(symbols[negative])) continue;
        candidates.push([positive, negative]);
      }
    }
    const cap = Math.trunc(cfg.maxPairsPerTimestamp);
    if (candidates.length <= cap) pairs.push(...candidates.map(pair => ({ timestamp, pair })));
    else {
      // Deterministic even coverage across the full pair list; no random seed
      // or label-dependent post-hoc sampling.
      for (let slot = 0; slot < cap; slot++) {
        const index = Math.floor(slot * (candidates.length - 1) / Math.max(1, cap - 1));
        pairs.push({ timestamp, pair: candidates[index] });
      }
    }
  }
  let rankingLoss = 0;
  for (const item of pairs) {
    const [positive, negative] = item.pair;
    const pairWeight = Math.sqrt(Number(weights[positive]) * Number(weights[negative]));
    const difference = Number(logits[positive]) - Number(logits[negative]);
    const scaled = (cfg.pairMargin - difference) / cfg.pairTemperature;
    const pairLoss = cfg.pairTemperature * softplus(scaled);
    rankingLoss += pairWeight * pairLoss;
    const derivative = -sigmoid(scaled) * pairWeight;
    // Equal-and-opposite derivatives preserve the timestamp-local ranking objective.
    gradient[positive] += cfg.rankingWeight * derivative / Math.max(EPSILON, pairs.length);
    gradient[negative] -= cfg.rankingWeight * derivative / Math.max(EPSILON, pairs.length);
  }
  rankingLoss = pairs.length
    ? rankingLoss / Math.max(EPSILON, pairs.reduce((sum, item) => {
        const [positive, negative] = item.pair;
        return sum + Math.sqrt(Number(weights[positive]) * Number(weights[negative]));
      }, 0))
    : 0;
  let falsePositivePenalty = 0, negativeWeight = 0;
  for (let i = 0; i < n; i++) {
    if (targets[i] !== 0) continue;
    negativeWeight += Number(weights[i]);
    const excess = Math.max(0, probs[i] - cfg.falsePositiveProbabilityThreshold);
    falsePositivePenalty += Number(weights[i]) * excess ** 2;
    gradient[i] += cfg.falsePositiveWeight * 2 * excess * probs[i] *
      (1 - probs[i]) * Number(weights[i]) / Math.max(EPSILON, weightSum);
  }
  falsePositivePenalty /= Math.max(EPSILON, weightSum);
  const deficit = Math.max(0, cfg.requiredBaselineImprovement - (baselineBrier - candidateBrier));
  const baselineGapPenalty = deficit ** 2;
  if (deficit > 0) {
    for (let i = 0; i < n; i++) {
      gradient[i] += cfg.baselineGapWeight * 2 * deficit *
        2 * (probs[i] - targets[i]) * probs[i] * (1 - probs[i]) *
        Number(weights[i]) / weightSum;
    }
  }
  const brierLoss = cfg.brierWeight * candidateBrier;
  const totalLoss = brierLoss + cfg.rankingWeight * rankingLoss +
    cfg.falsePositiveWeight * falsePositivePenalty +
    cfg.baselineGapWeight * baselineGapPenalty;
  if (!Number.isFinite(totalLoss) || gradient.some(value => !Number.isFinite(value)))
    throw new TypeError('DIRECTIONAL_LOSS_NON_FINITE_RESULT');
  return {
    loss: totalLoss,
    gradient_logits: gradient,
    metrics: {
      candidate_brier: candidateBrier,
      baseline_brier: baselineBrier,
      improvement_vs_logistic: baselineBrier - candidateBrier,
      same_timestamp_pair_count: pairs.length,
      timestamp_group_count: groups.size,
      pairwise_ranking_loss: rankingLoss,
      false_positive_confidence_penalty: falsePositivePenalty,
      negative_sample_weight: negativeWeight,
      baseline_gap_penalty: baselineGapPenalty,
      components: {
        brier: brierLoss,
        ranking: cfg.rankingWeight * rankingLoss,
        false_positive: cfg.falsePositiveWeight * falsePositivePenalty,
        baseline_gap: cfg.baselineGapWeight * baselineGapPenalty
      }
    }
  };
}
