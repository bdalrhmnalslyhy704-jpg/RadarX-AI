import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCognitiveLearningProfile,
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

test('chronological validation purges training labels that overlap the holdout window', () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    sample(index, index % 2 === 0 ? 'UP' : 'DOWN'));
  const profile = buildCognitiveLearningProfile(rows);
  assert.equal(profile.resolved_samples, 100);
  assert.equal(profile.holdout_samples, 20);
  assert.equal(profile.training_samples, 64);
  assert.equal(profile.purged_overlap_samples, 16);
  assert.ok(profile.max_training_outcome_resolved_at < profile.holdout_start_at);
  assert.equal(profile.holdout.evaluated, true);
  assert.equal(profile.method, 'REGULARIZED_INTERACTION_MODEL_WITH_PURGED_CHRONOLOGICAL_HOLDOUT_V2');
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
  assert.ok(normalProbability > reversedProbability + 25,
    'same pattern must receive a different estimate after the learned outcome relationship reverses');
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
