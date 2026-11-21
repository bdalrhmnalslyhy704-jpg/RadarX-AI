import {createHash} from 'node:crypto';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEQUENCE_STEPS = 24;
const SEQUENCE_CHANNELS = 29;

/**
 * Retain training rows fairly across symbols. The previous append-order slice
 * could let the most recently scanned priority lane evict entire earlier
 * symbols. Balanced chronological quantiles preserve symbol diversity and
 * early/middle/recent market regimes while keeping memory bounded.
 */
export function retainBalancedAdaptiveSamples(samples = [], {
  maxSamples = 6000,
  maxTrainingSamples = 5000
} = {}) {
  const totalLimit = Math.max(0, Math.trunc(Number(maxSamples) || 0));
  const trainingLimit = Math.min(totalLimit, Math.max(0, Math.trunc(Number(maxTrainingSamples) || 0)));
  if (!totalLimit) return [];
  const uniqueById = new Map();
  for (const row of Array.isArray(samples) ? samples : []) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '');
    if (id) uniqueById.set(id, row);
  }
  const unique = [...uniqueById.values()];
  const groups = new Map();
  const auditRows = [];
  for (const row of unique) {
    if (row.training_eligible === true &&
        (row.closed_candle_baseline === true || row.historical_baseline === true)) {
      const symbol = String(row.symbol || '').trim().toUpperCase() || 'UNKNOWN';
      if (!groups.has(symbol)) groups.set(symbol, []);
      groups.get(symbol).push(row);
    } else {
      auditRows.push(row);
    }
  }
  const symbols = [...groups.keys()].sort();
  for (const rows of groups.values()) rows.sort((a, b) =>
    (finite(a.at) ?? 0) - (finite(b.at) ?? 0) ||
    String(a.id || '').localeCompare(String(b.id || '')));

  // Allocate one slot per symbol in round-robin order before giving any symbol
  // a second slot. This also redistributes slots when a symbol has fewer rows.
  const quotas = new Map(symbols.map(symbol => [symbol, 0]));
  let remainingTrainingSlots = trainingLimit;
  while (remainingTrainingSlots > 0) {
    let added = false;
    for (const symbol of symbols) {
      const quota = quotas.get(symbol) || 0;
      if (quota >= groups.get(symbol).length) continue;
      quotas.set(symbol, quota + 1);
      remainingTrainingSlots--;
      added = true;
      if (remainingTrainingSlots <= 0) break;
    }
    if (!added) break;
  }

  const selectedTraining = [];
  for (const symbol of symbols) {
    const rows = groups.get(symbol);
    const quota = quotas.get(symbol) || 0;
    if (!quota) continue;
    if (rows.length <= quota) {
      selectedTraining.push(...rows);
      continue;
    }
    if (quota === 1) {
      // With one slot, keep the latest outcome so the symbol remains current.
      selectedTraining.push(rows[rows.length - 1]);
      continue;
    }
    // Choose deterministic chronological quantiles, including both ends of
    // the window. This preserves early/middle/recent regimes instead of keeping
    // only the newest append-order samples after a rolling memory cap.
    const used = new Set();
    for (let slot = 0; slot < quota; slot++) {
      const index = Math.round(slot * (rows.length - 1) / (quota - 1));
      if (used.has(index)) continue;
      used.add(index);
      selectedTraining.push(rows[index]);
    }
  }

  auditRows.sort((a, b) =>
    (finite(b.at) ?? 0) - (finite(a.at) ?? 0) ||
    String(b.id || '').localeCompare(String(a.id || '')));
  const retained = [
    ...selectedTraining,
    ...auditRows.slice(0, Math.max(0, totalLimit - selectedTraining.length))
  ];
  return retained.sort((a, b) =>
    (finite(a.at) ?? 0) - (finite(b.at) ?? 0) ||
    String(a.symbol || '').localeCompare(String(b.symbol || '')) ||
    String(a.id || '').localeCompare(String(b.id || '')));
}

export const ADAPTIVE_DATASET_SUPPORT_POLICY = Object.freeze({
  min_resolved_samples: 2000,
  min_distinct_symbols: 40,
  min_distinct_utc_days: 30,
  min_positive_samples: 150,
  min_negative_samples: 900,
  regimes: Object.freeze({
    BTC_RISK_ON: Object.freeze({
      training: Object.freeze({samples:80,positive:8,negative:20}),
      member_selection: Object.freeze({samples:10,positive:3,negative:8}),
      calibration: Object.freeze({samples:30,positive:5,negative:20}),
      validation: Object.freeze({samples:12,positive:5,negative:20}),
      holdout: Object.freeze({samples:20,positive:5,negative:20})
    }),
    BTC_RISK_OFF: Object.freeze({
      training: Object.freeze({samples:80,positive:8,negative:20}),
      member_selection: Object.freeze({samples:10,positive:3,negative:8}),
      calibration: Object.freeze({samples:30,positive:5,negative:20}),
      validation: Object.freeze({samples:12,positive:5,negative:20}),
      holdout: Object.freeze({samples:20,positive:5,negative:20})
    })
  })
});

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const emptyCounts = () => ({samples: 0, positive: 0, negative: 0, flat: 0, symbols: new Set(), days: new Set()});

function temporalSequenceRejectReason(sequence) {
  if (!Array.isArray(sequence)) return 'TEMPORAL_SEQUENCE_MISSING';
  if (sequence.length !== SEQUENCE_STEPS) return 'TEMPORAL_SEQUENCE_STEP_COUNT_INVALID';
  for (const step of sequence) {
    if (!Array.isArray(step) || step.length !== SEQUENCE_CHANNELS)
      return 'TEMPORAL_SEQUENCE_CHANNEL_COUNT_INVALID';
    for (const value of step) {
      const number=finite(value);
      if (number===null) return 'TEMPORAL_SEQUENCE_NON_FINITE_VALUE';
      if (Math.abs(number)>4) return 'TEMPORAL_SEQUENCE_VALUE_OUT_OF_RANGE';
    }
  }
  return null;
}

function phaseSupport(temporalProfile = {}) {
  const specialists = temporalProfile?.regime_specialists;
  const output = {};
  const missing = [];
  const read = (...values) => {
    for (const value of values) {
      const number = finite(value);
      if (number !== null) return number;
    }
    return 0;
  };
  for (const regime of ['BTC_RISK_ON', 'BTC_RISK_OFF']) {
    const source = specialists?.[regime];
    if (!source || typeof source !== 'object') {
      output[regime] = {available: false, passed: false, phases: {}};
      missing.push(regime + ':SPECIALIST_DIAGNOSTICS_MISSING');
      continue;
    }
    const policy = ADAPTIVE_DATASET_SUPPORT_POLICY.regimes[regime];
    // Match the TCN's real data scopes: the fit uses regime-local training,
    // shared pooled member-selection and calibration blocks, then regime-local
    // outer validation and untouched holdout blocks.
    const phases = {
      training: {
        scope: 'REGIME_LOCAL',
        samples: read(source.training_samples, source.regime_training_samples),
        positive: read(source.training_positive_samples),
        negative: read(source.training_negative_samples),
        min_samples: policy.training.samples,
        min_positive: policy.training.positive,
        min_negative: policy.training.negative
      },
      member_selection: {
        scope: 'SHARED_POOLED',
        samples: read(source.pooled_selection_diagnostic_samples, source.member_selection_samples),
        positive: read(source.pooled_selection_diagnostic_positive_samples, source.selection_positive_samples),
        negative: read(source.pooled_selection_diagnostic_negative_samples, source.selection_negative_samples),
        min_samples: policy.member_selection.samples,
        min_positive: policy.member_selection.positive,
        min_negative: policy.member_selection.negative
      },
      calibration: {
        scope: 'SHARED_POOLED',
        samples: read(source.pooled_calibration_diagnostic_samples, source.calibration_samples),
        positive: read(source.pooled_calibration_diagnostic_positive_samples,
          source.calibration_targets?.positive, source.calibration_positive_samples),
        negative: read(source.pooled_calibration_diagnostic_negative_samples,
          source.calibration_targets?.negative, source.calibration_negative_samples),
        min_samples: policy.calibration.samples,
        min_positive: policy.calibration.positive,
        min_negative: policy.calibration.negative
      },
      validation: {
        scope: 'REGIME_LOCAL_OUTER',
        samples: read(source.validation_samples),
        positive: read(source.validation_positive_samples),
        negative: read(source.validation_negative_samples),
        min_samples: policy.validation.samples,
        min_positive: policy.validation.positive,
        min_negative: policy.validation.negative
      },
      holdout: {
        scope: 'REGIME_LOCAL_UNTOUCHED',
        samples: read(source.holdout_samples),
        positive: read(source.holdout_positive_samples),
        negative: read(source.holdout_negative_samples),
        min_samples: policy.holdout.samples,
        min_positive: policy.holdout.positive,
        min_negative: policy.holdout.negative
      }
    };
    const gaps = [];
    for (const [phase, counts] of Object.entries(phases)) {
      if (counts.samples < counts.min_samples) gaps.push(phase + ':SAMPLE_SUPPORT');
      if (counts.positive < counts.min_positive) gaps.push(phase + ':POSITIVE_SUPPORT');
      if (counts.negative < counts.min_negative) gaps.push(phase + ':NEGATIVE_SUPPORT');
    }
    output[regime] = {
      available: true,
      passed: gaps.length === 0,
      gaps,
      phases
    };
    for (const gap of gaps) missing.push(regime + ':' + gap);
  }
  return {regimes: output, passed: missing.length === 0, gaps: missing};
}

/**
 * Audits the exact first-passage rows handed to the V5/TCN training pipeline.
 * This is a data-support gate only; it does not measure model skill or authorize
 * live probabilities. Unresolved, malformed, duplicate, mixed-horizon, and
 * non-15m-label rows never enter the coverage or class-balance denominators.
 */
export function buildAdaptiveDatasetQualityAudit(samples = [], {
  temporalProfile = null,
  now = Date.now()
} = {}) {
  const input = Array.isArray(samples) ? samples : [];
  const nowAt = finite(now) ?? Date.now();
  const rejectionCounts = {};
  const reject = code => { rejectionCounts[code] = (rejectionCounts[code] || 0) + 1; };
  const seenIds = new Set();
  const seenBaselines = new Set();
  const valid = [];
  let unresolved = 0;
  let sequenceMissing = 0;
  const sequenceQualityCounts={missing:0,step_count_invalid:0,channel_count_invalid:0,non_finite_value:0,value_out_of_range:0};
  let duplicateRows = 0;
  const outcomeCounts = {UP: 0, DOWN: 0, FLAT: 0};
  const byRegime = {
    BTC_RISK_ON: emptyCounts(),
    BTC_RISK_OFF: emptyCounts(),
    UNKNOWN: emptyCounts()
  };
  const bySymbol = new Map();
  const byUtcDay = new Map();
  const byUtcMonth = new Map();
  let microAvailableSteps = 0;
  let microTotalSteps = 0;

  for (const row of input) {
    if (!row || row.training_eligible !== true ||
        (row.closed_candle_baseline !== true && row.historical_baseline !== true)) {
      reject('NOT_TRAINING_ELIGIBLE');
      continue;
    }
    if (row.target_definition !== 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2') {
      reject('TARGET_DEFINITION_MISMATCH');
      continue;
    }
    const id = String(row.id || '');
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const at = finite(row.at);
    const resolvedAt = finite(row.resolved_at);
    if (!id) { reject('MISSING_SAMPLE_ID'); continue; }
    if (!/^[A-Z0-9]{1,30}USDT$/.test(symbol)) { reject('INVALID_SPOT_SYMBOL'); continue; }
    if (at === null || at <= 0 || !Number.isSafeInteger(Math.trunc(at)) || !Number.isFinite(new Date(at).getTime())) {
      reject('INVALID_SAMPLE_TIME'); continue;
    }
    const baselinePrice=finite(row.price);
    if (baselinePrice===null || baselinePrice<=0) { reject('INVALID_BASELINE_PRICE'); continue; }
    if (!['UP', 'DOWN', 'FLAT'].includes(row.outcome)) {
      reject('OUTCOME_UNAVAILABLE'); unresolved++; continue;
    }
    if (resolvedAt === null) { reject('INVALID_RESOLUTION_TIMESTAMP'); continue; }
    if (resolvedAt > nowAt + 5000) { reject('OUTCOME_NOT_MATURED'); unresolved++; continue; }
    if (resolvedAt - at !== FOUR_HOURS_MS || finite(row.horizon_ms) !== FOUR_HOURS_MS) {
      reject('HORIZON_MISMATCH'); continue;
    }
    if (row.first_passage?.path_resolution !== '15M' ||
        row.first_passage?.outcome !== row.outcome) {
      reject('FIRST_PASSAGE_LABEL_INVALID'); continue;
    }
    const expectedSource = row.historical_baseline === true
      ? 'HISTORICAL_CLOSED_CANDLE_FIRST_PASSAGE_V1'
      : 'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1';
    if (row.outcome_source !== expectedSource) {
      reject('OUTCOME_SOURCE_MISMATCH'); continue;
    }
    const sequenceRejectReason=temporalSequenceRejectReason(row.temporal_sequence);
    if(sequenceRejectReason){
      reject(sequenceRejectReason);
      sequenceMissing++;
      if(sequenceRejectReason==='TEMPORAL_SEQUENCE_MISSING')sequenceQualityCounts.missing++;
      else if(sequenceRejectReason==='TEMPORAL_SEQUENCE_STEP_COUNT_INVALID')sequenceQualityCounts.step_count_invalid++;
      else if(sequenceRejectReason==='TEMPORAL_SEQUENCE_CHANNEL_COUNT_INVALID')sequenceQualityCounts.channel_count_invalid++;
      else if(sequenceRejectReason==='TEMPORAL_SEQUENCE_NON_FINITE_VALUE')sequenceQualityCounts.non_finite_value++;
      else if(sequenceRejectReason==='TEMPORAL_SEQUENCE_VALUE_OUT_OF_RANGE')sequenceQualityCounts.value_out_of_range++;
      continue;
    }

    const baselineKey = symbol + ':' + String(Math.trunc(at));
    if (seenIds.has(id) || seenBaselines.has(baselineKey)) {
      reject('DUPLICATE_SAMPLE');
      duplicateRows++;
      continue;
    }
    seenIds.add(id);
    seenBaselines.add(baselineKey);
    valid.push(row);
    outcomeCounts[row.outcome]++;

    const lastStep = row.temporal_sequence[SEQUENCE_STEPS - 1];
    const regimeValue = finite(lastStep?.[19]);
    const regime = regimeValue === null ? 'UNKNOWN' :
      regimeValue >= 0 ? 'BTC_RISK_ON' : 'BTC_RISK_OFF';
    const day = new Date(at).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, emptyCounts());
    const symbolBucket = bySymbol.get(symbol);
    const dayBucket = byUtcDay.get(day) || {samples: 0, positive: 0, negative: 0};
    const monthBucket = byUtcMonth.get(month) || {samples: 0, positive: 0, negative: 0};
    const regimeBucket = byRegime[regime];
    const positive = row.outcome === 'UP';
    for (const bucket of [symbolBucket, regimeBucket]) {
      bucket.samples++;
      bucket.symbols.add(symbol);
      bucket.days.add(day);
      if (positive) bucket.positive++;
      else bucket.negative++;
      if (row.outcome === 'FLAT') bucket.flat++;
    }
    dayBucket.samples++;
    if (positive) dayBucket.positive++; else dayBucket.negative++;
    monthBucket.samples++;
    if (positive) monthBucket.positive++; else monthBucket.negative++;
    byUtcDay.set(day, dayBucket);
    byUtcMonth.set(month, monthBucket);
    for (const step of row.temporal_sequence) {
      microTotalSteps++;
      if (Number(step[28]) >= 0.5) microAvailableSteps++;
    }
  }

  const sorted = valid.slice().sort((a, b) => Number(a.at) - Number(b.at) ||
    String(a.id).localeCompare(String(b.id)));
  const identityHasher = createHash('sha256');
  const modelInputHasher = createHash('sha256');
  for (const row of sorted) {
    const identity = [String(row.id),String(row.symbol).toUpperCase(),Number(row.at),
      Number(row.resolved_at),String(row.outcome),String(row.target_definition)];
    identityHasher.update(JSON.stringify(identity) + '\\n');
    modelInputHasher.update(JSON.stringify([
      identity,finite(row.price),finite(row.return_pct),finite(row.close_return_pct),
      row.first_passage || null,row.features || null,row.temporal_sequence
    ]) + '\\n');
  }
  const symbols = [...bySymbol.keys()].sort();
  const days = [...byUtcDay.keys()].sort();
  const months = [...byUtcMonth.keys()].sort();
  const positive = outcomeCounts.UP;
  const negative = outcomeCounts.DOWN + outcomeCounts.FLAT;
  const earliestAt = sorted.length ? Number(sorted[0].at) : null;
  const latestAt = sorted.length ? Number(sorted[sorted.length - 1].at) : null;
  const phase = phaseSupport(temporalProfile || {});
  const gaps = [];
  const policy = ADAPTIVE_DATASET_SUPPORT_POLICY;

  if (valid.length < policy.min_resolved_samples) gaps.push('TOTAL_RESOLVED_SAMPLES_BELOW_MINIMUM');
  if (symbols.length < policy.min_distinct_symbols) gaps.push('DISTINCT_SYMBOL_COVERAGE_BELOW_MINIMUM');
  if (days.length < policy.min_distinct_utc_days) gaps.push('CHRONOLOGICAL_DAY_COVERAGE_BELOW_MINIMUM');
  if (positive < policy.min_positive_samples) gaps.push('POSITIVE_CLASS_SUPPORT_BELOW_MINIMUM');
  if (negative < policy.min_negative_samples) gaps.push('NEGATIVE_CLASS_SUPPORT_BELOW_MINIMUM');
  if (!phase.passed) gaps.push('REGIME_PHASE_CLASS_SUPPORT_BELOW_MINIMUM');

  const symbolRows = [...bySymbol.entries()].map(([symbol, counts]) => ({
    symbol, samples: counts.samples, positive: counts.positive, negative: counts.negative,
    positive_rate_pct: counts.samples ? Number((counts.positive / counts.samples * 100).toFixed(2)) : null,
    utc_days: counts.days.size
  })).sort((a, b) => a.samples - b.samples || a.symbol.localeCompare(b.symbol));
  const regimeRows = Object.fromEntries(Object.entries(byRegime).map(([regime, counts]) => [regime, {
    samples: counts.samples, positive: counts.positive, negative: counts.negative,
    symbols: counts.symbols.size, utc_days: counts.days.size,
    positive_rate_pct: counts.samples ? Number((counts.positive / counts.samples * 100).toFixed(2)) : null
  }]));

  return {
    schema_version: 'RADARX_ADAPTIVE_DATASET_QUALITY_AUDIT_V1',
    target_definition: 'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
    evaluated_at: new Date(nowAt).toISOString(),
    data_support_ready: gaps.length === 0,
    status: gaps.length ? 'ADDITIONAL_VERIFIED_DATA_REQUIRED' : 'MINIMUM_DATA_SUPPORT_PRESENT',
    fingerprints: {
      sample_identity_sha256: identityHasher.digest('hex'),
      model_input_sha256: modelInputHasher.digest('hex')
    },
    blocking_reasons: gaps,
    counts: {
      input_training_rows: input.length,
      valid_resolved_rows: valid.length,
      unresolved_rows: unresolved,
      rejected_rows: Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0),
      duplicate_rows: duplicateRows,
      sequence_missing_or_invalid_rows: sequenceMissing,
      sequence_quality: {...sequenceQualityCounts},
      distinct_symbols: symbols.length,
      distinct_utc_days: days.length,
      distinct_utc_months: months.length,
      positive: outcomeCounts.UP,
      negative: negative,
      down: outcomeCounts.DOWN,
      flat: outcomeCounts.FLAT,
      positive_rate_pct: valid.length ? Number((positive / valid.length * 100).toFixed(2)) : null,
      micro_5m_sequence_coverage_pct: microTotalSteps
        ? Number((microAvailableSteps / microTotalSteps * 100).toFixed(2)) : null
    },
    time_coverage: {
      earliest_sample_at: earliestAt,
      latest_sample_at: latestAt,
      earliest_sample_utc: earliestAt === null ? null : new Date(earliestAt).toISOString(),
      latest_sample_utc: latestAt === null ? null : new Date(latestAt).toISOString(),
      span_days: earliestAt === null || latestAt === null
        ? 0 : Number(((latestAt - earliestAt) / DAY_MS).toFixed(2)),
      utc_days: days,
      utc_months: months
    },
    class_balance: outcomeCounts,
    regimes: regimeRows,
    regime_phase_support: phase.regimes,
    symbol_coverage: {
      weakest_symbols: symbolRows.slice(0, 10),
      strongest_symbols: symbolRows.slice(-10).reverse()
    },
    daily_coverage: [...byUtcDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({
      date, ...counts
    })),
    monthly_coverage: [...byUtcMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, counts]) => ({
      month, ...counts
    })),
    rejection_reasons: Object.fromEntries(Object.entries(rejectionCounts).sort((a, b) => b[1] - a[1])),
    requirements: {
      ...policy,
      regimes: Object.fromEntries(Object.entries(policy.regimes).map(([key, value]) => [key, {...value}]))
    },
    interpretation: [
      'This is a data-support audit, not evidence of predictive superiority or profitability.',
      'UP means +3% was reached before -2% within four hours on closed 15m candles; DOWN and FLAT are non-positive targets.',
      'BTC regime is read from the final 24h BTC-context channel (tensor channel 19), matching the TCN regime split.',
      'A model must still pass separate selection, calibration, outer validation, untouched holdout, and paper gates.'
    ],
    policy: {
      market: 'BINANCE_SPOT',
      candle_resolution: '15M_CLOSED_ONLY',
      paper_trading: true,
      real_order_execution: false,
      live_probability_permission: false
    }
  };
}
