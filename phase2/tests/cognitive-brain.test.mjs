import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCognitiveLearningProfile,
  buildCognitivePrequentialProfile,
  assessCognitiveCandidate,
  applyCognitiveRankAdjustment
} from '../core/cognitive-brain.mjs';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const BASE_TIME = 1_700_000_000_000;

function sample(index, outcome, features = {}) {
  const at = BASE_TIME + index * 15 * 60 * 1000;
  return {
    id: 'MEMORY-' + String(index),
    symbol: 'MEMORYUSDT',
    at,
    resolved_at: at + FOUR_HOURS,
    horizon_ms: FOUR_HOURS,
    outcome_source: 'CLOSED_CANDLE_4H',
    training_eligible: true,
    closed_candle_baseline: true,
    outcome,
    return_pct: outcome === 'UP' ? 2.5 : outcome === 'DOWN' ? -2.5 : 0,
    features: {
      volume_ratio: 1.8,
      trade_ratio: 1.5,
      taker_buy_ratio: 0.58,
      close_location: 0.72,
      higher_low: true,
      compression_ratio: 0.7,
      relative_strength_vs_btc_pct: 0.8,
      recent_15m_return_pct: 0.6,
      trend_aligned: true,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: 0.59,
      ...features
    }
  };
}

function candidate(overrides = {}) {
  return {
    symbol: 'EARLYUSDT',
    price: 0.42,
    change_24h_pct: 2.1,
    score: 74,
    tier: 'WATCH',
    data_valid: true,
    data_stale: false,
    closed_candles_only: true,
    candle_age_ms: 60_000,
    features: {
      volume_ratio: 2.2,
      trade_ratio: 1.7,
      taker_buy_ratio: 0.61,
      close_location: 0.8,
      higher_low: true,
      breakout_above_prior_high: true,
      compression_ratio: 0.72,
      relative_strength_vs_btc_pct: 1.2,
      recent_15m_return_pct: 0.7,
      trend_aligned: true,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: 0.58,
      micro_5m_return_pct: 0.4
    },
    ...overrides
  };
}

function behavioralSamples({ seed = 0, reverse = false, count = 240 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const n = i + seed;
    const volumeOn = n % 2 === 0;
    const buyerOn = Math.floor(n / 2) % 2 === 0;
    const structureOn = Math.floor(n / 4) % 2 === 0;
    const signal = volumeOn && buyerOn && structureOn;
    const tradeOn = (n * 7) % 5 < 3;
    const compressionOn = (n * 3) % 4 < 2;
    const relativeOn = n % 3 === 0;
    const trendOn = n % 2 === 0;
    const microOn = n % 4 < 2;
    const features = {
      volume_ratio: volumeOn ? 2.2 : 0.8,
      trade_ratio: tradeOn ? 1.7 : 0.85,
      taker_buy_ratio: buyerOn ? 0.62 : 0.44,
      close_location: structureOn ? 0.78 : 0.35,
      higher_low: structureOn,
      breakout_above_prior_high: false,
      compression_ratio: compressionOn ? 0.68 : 1.12,
      relative_strength_vs_btc_pct: relativeOn ? 0.9 : -0.45,
      recent_15m_return_pct: n % 3 === 0 ? 0.7 : -0.2,
      return_3h_pct: trendOn ? 1.1 : -0.4,
      trend_aligned: trendOn,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: microOn ? 0.61 : 0.43,
      micro_5m_return_pct: 0.2
    };
    const isPositive = reverse ? !signal : signal;
    const outcome = isPositive
      ? (i % 5 === 0 ? 'FLAT' : 'UP')
      : (i % 7 === 0 ? 'FLAT' : 'DOWN');
    const at = BASE_TIME + i * 5 * 60 * 60 * 1000;
    rows.push({
      id: 'EXAMPLE-' + seed + '-' + i,
      symbol: 'PAIR' + String(i % 13).padStart(2, '0') + 'USDT',
      at,
      resolved_at: at + FOUR_HOURS,
      horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H',
      training_eligible: true,
      closed_candle_baseline: true,
      outcome,
      return_pct: outcome === 'UP' ? 2.8 : outcome === 'DOWN' ? -2.6 : 0,
      features
    });
  }
  return rows;
}

test('learner rejects unresolved, duplicate and non-training observations', () => {
  const good = sample(1, 'UP');
  const rows = [
    good,
    { ...sample(2, 'DOWN'), training_eligible: false },
    { ...sample(3, 'FLAT'), outcome: null },
    { ...sample(4, 'DOWN'), resolved_at: null },
    good
  ];
  const profile = buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples, 1);
  assert.equal(profile.probability_ready, false);
  assert.equal(profile.identifier_features_used, false);
});

test('live and historical copies of the same symbol/candle count as one training event', () => {
  const live = sample(12, 'UP');
  const backfill = {
    ...live,
    id: 'HISTORICAL_CLOSED_CANDLE:MEMORYUSDT:' + String(live.at),
    closed_candle_baseline: false,
    historical_baseline: true,
    outcome_source: 'HISTORICAL_CLOSED_CANDLE',
    outcome: 'DOWN',
    return_pct: -2.5
  };
  const invalidSource = { ...sample(13, 'UP'), outcome_source: 'LIVE_TICKER_PRICE' };
  const profile = buildCognitiveLearningProfile([live, backfill, invalidSource]);
  assert.equal(profile.resolved_samples, 1);
  assert.equal(profile.outcome_counts.up, 1);
  assert.equal(profile.outcome_counts.down, 0);
});

test('nested chronological validation purges labels crossing both validation and untouched test boundaries', () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    sample(index, index % 2 === 0 ? 'UP' : 'DOWN'));
  const profile = buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples, 200);
  assert.equal(profile.training_samples, 104);
  assert.equal(profile.validation_samples, 24);
  assert.equal(profile.holdout_samples, 40);
  assert.equal(profile.purged_overlap_samples, 32);
  assert.equal(profile.validation_purged_samples, 16);
  assert.ok(profile.max_training_outcome_resolved_at < profile.validation_start_at);
  assert.ok(profile.validation_start_at < profile.holdout_start_at);
  assert.equal(profile.holdout.evaluated, true);
  assert.equal(profile.method, 'NESTED_PURGED_WALK_FORWARD_ADAPTIVE_EVIDENCE_MODEL_V3');
});

test('the model generalizes from market evidence to unseen pair identifiers across repeated datasets', () => {
  for (const seed of [0, 3, 7]) {
    const profile = buildCognitiveLearningProfile(behavioralSamples({ seed }));
    assert.equal(profile.ranking_ready, true, 'both present and absent evidence buckets must be covered');
    assert.equal(profile.holdout.evaluated, true);
    assert.equal(profile.probability_ready, true,
      'the model must beat the chronological baseline before publishing probabilities');
    assert.ok(profile.holdout.model_brier_score < profile.holdout.base_rate_brier_score);
    assert.equal(profile.identifier_features_used, false);

    const highEvidence = candidate();
    const renamedPair = candidate({ symbol: 'UNSEENPAIRUSDT' });
    const highProbability = assessCognitiveCandidate(highEvidence, profile, BASE_TIME + 20_000);
    const renamedProbability = assessCognitiveCandidate(renamedPair, profile, BASE_TIME + 20_000);
    assert.equal(highProbability.predicted_up_probability, renamedProbability.predicted_up_probability);
    assert.equal(highProbability.probability_status, 'OUT_OF_SAMPLE_VALIDATED');
    assert.ok(highProbability.counterfactual_evidence.length > 0);
  }
});

test('the learner changes its conclusion when the same evidence leads to opposite matured outcomes', () => {
  const normal = buildCognitiveLearningProfile(behavioralSamples({ seed: 2, reverse: false }));
  const reversed = buildCognitiveLearningProfile(behavioralSamples({ seed: 2, reverse: true }));
  assert.equal(normal.probability_ready, true);
  assert.equal(reversed.probability_ready, true);
  const evidence = candidate().features;
  const normalProbability = assessCognitiveCandidate(candidate(), normal, BASE_TIME + 20_000)
    .predicted_up_probability;
  const reversedProbability = assessCognitiveCandidate(candidate(), reversed, BASE_TIME + 20_000)
    .predicted_up_probability;
  assert.ok(normalProbability > reversedProbability + 15,
    'same pattern must receive a different estimate after the learned outcome relationship reverses; normal=' + normalProbability + ', reversed=' + reversedProbability);
  assert.ok(applyCognitiveRankAdjustment(70, evidence, normal) >
    applyCognitiveRankAdjustment(70, evidence, reversed));
});

test('candidate reasoning shows hypotheses and contradictions without claiming certainty', () => {
  const assessment = assessCognitiveCandidate(candidate(), buildCognitiveLearningProfile([]), BASE_TIME);
  assert.equal(assessment.decision, 'EARLY_SETUP_REVIEW');
  assert.equal(assessment.entry_eligible, false);
  assert.equal(assessment.real_order_execution, false);
  assert.equal(assessment.paper_trading, true);
  assert.equal(assessment.predicted_up_probability, null);
  assert.ok(assessment.hypotheses.some(row => row.key === 'BUYER_ACCUMULATION' && row.supported));
  assert.ok(assessment.hypotheses.some(row => row.key === 'PRICE_STRUCTURE' && row.supported));
  assert.equal(assessment.confidence_label, 'UNKNOWN');
});

test('a late or contradictory market move is not rescued by a high learned probability', () => {
  const profile = buildCognitiveLearningProfile(behavioralSamples());
  const late = assessCognitiveCandidate(candidate({
    change_24h_pct: 11,
    tier: 'LATE_MOVE',
    features: { ...candidate().features, hourly_return_pct: 5.5 }
  }), profile, BASE_TIME);
  assert.equal(late.decision, 'AVOID_CHASING');
  assert.equal(late.entry_eligible, false);
  assert.ok(late.reason_codes.includes('ANTI_CHASE_REVIEW_REQUIRED'));

  const contradictory = assessCognitiveCandidate(candidate({
    features: { ...candidate().features, taker_buy_ratio: 0.43, upper_wick_pct: 0.8, current_range_pct: 1 }
  }), profile, BASE_TIME);
  assert.ok(contradictory.contradictions.length > 0);
  assert.equal(contradictory.entry_eligible, false);
});

test('ranking adjustment stays disabled until independent holdout validation succeeds', () => {
  const profile = buildCognitiveLearningProfile(Array.from({ length: 40 }, (_, index) =>
    sample(index, index % 2 ? 'UP' : 'DOWN')));
  assert.equal(profile.probability_ready, false);
  assert.equal(applyCognitiveRankAdjustment(72, candidate().features, profile), null);
});

function regimeDriftSamples({ count = 360, changeAt = 96 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const signal = i % 4 < 2;
    const features = {
      volume_ratio: signal ? 2.2 : 0.8,
      trade_ratio: signal ? 1.7 : 0.85,
      taker_buy_ratio: signal ? 0.62 : 0.44,
      close_location: signal ? 0.78 : 0.35,
      higher_low: signal,
      breakout_above_prior_high: false,
      compression_ratio: signal ? 0.68 : 1.12,
      relative_strength_vs_btc_pct: signal ? 0.9 : -0.45,
      recent_15m_return_pct: signal ? 0.7 : -0.2,
      return_3h_pct: signal ? 1.1 : -0.4,
      trend_aligned: signal,
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: signal ? 0.61 : 0.43
    };
    const oldRegimeUp = signal;
    const newRegimeUp = !signal;
    const up = i < changeAt ? oldRegimeUp : newRegimeUp;
    const outcome = i % 8 === 0 ? 'FLAT' : up ? 'UP' : 'DOWN';
    const at = BASE_TIME + i * 5 * 60 * 60 * 1000;
    rows.push({
      id: 'DRIFT-' + i,
      symbol: 'DRIFT' + String(i % 19).padStart(2, '0') + 'USDT',
      at,
      resolved_at: at + FOUR_HOURS,
      horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H',
      training_eligible: true,
      closed_candle_baseline: true,
      outcome,
      return_pct: outcome === 'UP' ? 2.8 : outcome === 'DOWN' ? -2.6 : 0,
      features
    });
  }
  return rows;
}

function noSignalSamples({ count = 320 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const block = Math.floor(i / 8);
    const combo = i % 8;
    const features = {
      volume_ratio: combo & 1 ? 2.2 : 0.8,
      trade_ratio: combo & 2 ? 1.7 : 0.85,
      taker_buy_ratio: combo & 4 ? 0.62 : 0.44,
      close_location: combo & 1 ? 0.78 : 0.35,
      higher_low: Boolean(combo & 1),
      breakout_above_prior_high: false,
      compression_ratio: combo & 2 ? 0.68 : 1.12,
      relative_strength_vs_btc_pct: combo & 4 ? 0.9 : -0.45,
      recent_15m_return_pct: combo & 1 ? 0.7 : -0.2,
      return_3h_pct: combo & 2 ? 1.1 : -0.4,
      trend_aligned: Boolean(combo & 2),
      micro_5m_available: true,
      micro_5m_taker_buy_ratio: combo & 4 ? 0.61 : 0.43
    };
    const outcome = block % 2 === 0 ? 'UP' : 'DOWN';
    const at = BASE_TIME + i * 5 * 60 * 60 * 1000;
    rows.push({
      id: 'NO-SIGNAL-' + i,
      symbol: 'IDENTITY' + String(block).padStart(2, '0') + 'USDT',
      at,
      resolved_at: at + FOUR_HOURS,
      horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H',
      training_eligible: true,
      closed_candle_baseline: true,
      outcome,
      return_pct: outcome === 'UP' ? 2.2 : -2.2,
      features
    });
  }
  return rows;
}

test('recent challenger adapts to a reversed market relationship only after middle-window validation', () => {
  const profile = buildCognitiveLearningProfile(regimeDriftSamples());
  assert.equal(profile.probability_ready, true);
  assert.equal(profile.model_selection.selected_model, 'RECENT_WINDOW');
  assert.equal(profile.regime_adaptation.status, 'RECENT_WINDOW_SELECTED');
  assert.ok(profile.model_selection.recent_validation_brier_score <
    profile.model_selection.global_validation_brier_score);
  const sameEvidence = candidate().features;
  const prediction = assessCognitiveCandidate(candidate(), profile, BASE_TIME + 999_999)
    .predicted_up_probability;
  assert.ok(prediction < 50,
    'the current regime reverses the earlier evidence relationship, so the same evidence must now be judged bearish');
});

test('the model refuses to claim learning when labels are unrelated to market evidence', () => {
  const profile = buildCognitiveLearningProfile(noSignalSamples());
  assert.equal(profile.identifier_features_used, false);
  assert.equal(profile.probability_ready, false,
    'a model that memorizes alternating pair identities must not pass evidence-only validation');
  assert.ok(['NO_VALIDATED_MODEL', 'GLOBAL_HISTORY_RETAINED'].includes(profile.regime_adaptation.status));
});

test('prequential audit scores only immutable, matured V2 forecasts and detects sustained degradation', () => {
  const journal = Array.from({ length: 60 }, (_, index) => {
    const outcome = index % 2 === 0 ? 'UP' : 'DOWN';
    const predictionIsCorrect = index < 30;
    const predicted = predictionIsCorrect
      ? (outcome === 'UP' ? 90 : 10)
      : (outcome === 'UP' ? 10 : 90);
    const at = BASE_TIME + index * 5 * 60 * 60 * 1000;
    return {
      id: 'FORWARD-' + index, model_version: 2, at,
      resolved_at: at + FOUR_HOURS, horizon_ms: FOUR_HOURS,
      outcome_source: 'CLOSED_CANDLE_4H', outcome,
      predicted_up_probability: predicted
    };
  });
  journal.push({ ...journal[0], id: 'OLD-V1', model_version: 1 });
  journal.push({ ...journal[0], id: 'UNRESOLVED', outcome: null });
  const audit = buildCognitivePrequentialProfile(journal, { minimumWindowSamples: 20, windowSize: 30 });
  assert.equal(audit.resolved_forecasts, 60);
  assert.equal(audit.previous_window.sample_count, 30);
  assert.equal(audit.recent_window.sample_count, 30);
  assert.equal(audit.drift_detected, true);
  assert.equal(audit.reassessment_required, true);
  assert.equal(audit.status, 'FORWARD_PERFORMANCE_DEGRADING');
});

