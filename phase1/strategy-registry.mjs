import {
  evaluateMTFTrend,
  evaluateBreakout,
  evaluateMeanReversion
} from './radarx-phase1-engine.mjs';

const ACTIVE = 'ACTIVE';

const STRATEGY_REGISTRY = Object.freeze({
  MTF_TREND: Object.freeze({
    id: 'MTF_TREND', name: 'Multi-Timeframe Trend', family: 'TREND_FOLLOWING', status: ACTIVE,
    requiredData: Object.freeze(['4h', '1h', '15m']), evaluator: evaluateMTFTrend,
    scoreDimensions: Object.freeze(['regime', 'alignment', 'strength', 'relativeStrength', 'volume']),
    hardGates: Object.freeze(['CLOSED_4H_1H_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','LIQUIDITY_GATE']),
    reasonCodes: Object.freeze(['4H_BULL_REGIME','4H_BEAR_REGIME','1H_ALIGNED','PULLBACK_OK','STRUCTURE_OR_TRIGGER_OK','TREND_CONFLUENCE_NOT_MET','INSUFFICIENT_CLOSED_DATA']),
    invalidationRules: Object.freeze(['CLOSED_TRIGGER_CANDLE_REQUIRED','FRESH_VALID_MARKET_DATA_REQUIRED','PRICE_STOP_LOSS']),
    testReference: 'phase1/tests/engine.test.mjs'
  }),
  CONFIRMED_BREAKOUT: Object.freeze({
    id: 'CONFIRMED_BREAKOUT', name: 'Confirmed Breakout', family: 'BREAKOUT', status: ACTIVE,
    requiredData: Object.freeze(['4h', '1h', '15m', 'depth', 'ticker24h']), evaluator: evaluateBreakout,
    scoreDimensions: Object.freeze(['priceBreak', 'volume', 'liquidity', 'context', 'retest']),
    hardGates: Object.freeze(['CLOSED_15M_CONFIRMATION','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','LIQUIDITY_GATE','VOLUME_CONFIRMATION']),
    reasonCodes: Object.freeze(['CLOSE_ABOVE_RANGE','CLOSE_BELOW_RANGE','RVOL_OK','LIQUIDITY_OK','NO_FAKEOUT','FALSE_BREAKOUT','BREAKOUT_CONFIRMATION_NOT_MET','INSUFFICIENT_CLOSED_DATA']),
    invalidationRules: Object.freeze(['CLOSED_TRIGGER_CANDLE_REQUIRED','FRESH_VALID_MARKET_DATA_REQUIRED','FALSE_BREAKOUT','PRICE_STOP_LOSS']),
    testReference: 'phase1/tests/engine.test.mjs'
  }),
  MEAN_REVERSION: Object.freeze({
    id: 'MEAN_REVERSION', name: 'Filtered Mean Reversion', family: 'MEAN_REVERSION', status: ACTIVE,
    requiredData: Object.freeze(['4h', '1h', '15m']), evaluator: evaluateMeanReversion,
    scoreDimensions: Object.freeze(['location', 'trendFilter', 'reversal', 'volatility', 'liquidity']),
    hardGates: Object.freeze(['CLOSED_4H_1H_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','LIQUIDITY_GATE','PANIC_SELL_FILTER']),
    reasonCodes: Object.freeze(['OVERSOLD','OVERBOUGHT','LOWER_BAND','UPPER_BAND','REGIME_FILTER_OK','REVERSAL_OK','BEARISH_REVERSAL','PANIC_SELL_FILTER','MEAN_REVERSION_FILTER_NOT_MET','INSUFFICIENT_CLOSED_DATA']),
    invalidationRules: Object.freeze(['CLOSED_TRIGGER_CANDLE_REQUIRED','FRESH_VALID_MARKET_DATA_REQUIRED','PANIC_SELL_FILTER','PRICE_STOP_LOSS']),
    testReference: 'phase1/tests/engine.test.mjs'
  })
});

function coverageInfo(coverage) {
  if (coverage && typeof coverage === 'object') {
    const required = Array.isArray(coverage.required) ? coverage.required : (Array.isArray(coverage.required_timeframes) ? coverage.required_timeframes : []);
    const available = Array.isArray(coverage.available) ? coverage.available : (Array.isArray(coverage.available_timeframes) ? coverage.available_timeframes : []);
    const requiredCount = Number(coverage.requiredCount ?? required.length);
    const availableCount = Number(coverage.availableCount ?? available.length);
    const ratio = Number(coverage.ratio);
    const value = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : (requiredCount > 0 ? Math.max(0, Math.min(1, availableCount / requiredCount)) : 0);
    return { value, required, available, requiredCount, availableCount };
  }
  const value = Number.isFinite(Number(coverage)) ? Math.max(0, Math.min(1, Number(coverage))) : 1;
  return { value, required: [], available: [], requiredCount: 0, availableCount: 0 };
}

function numericScore(result) {
  if (Number.isFinite(Number(result?.score?.value))) return Number(result.score.value);
  for (const value of Object.values(result?.score ?? {})) if (Number.isFinite(Number(value))) return Number(value);
  return null;
}
function decisionBand(value) {
  if (!Number.isFinite(value)) return 'insufficient';
  if (value >= 80) return 'strong'; if (value >= 65) return 'positive'; if (value >= 50) return 'watch'; if (value >= 35) return 'weak'; return 'reject';
}
function normalizeDirection(value) {
  const direction = String(value ?? 'NONE').toUpperCase();
  if (direction === 'BULLISH') return 'LONG'; if (direction === 'SHORT') return 'BEARISH'; if (!direction) return 'NONE'; return direction;
}
function normalizeState(result, coverageValue, gatesPassed) {
  const raw = String(result?.state ?? result?.signal_state ?? 'REJECTED').toUpperCase();
  if (!gatesPassed || coverageValue < 1) return (/INSUFFICIENT/.test(raw) || coverageValue < 1) ? 'INSUFFICIENT_DATA' : raw === 'REJECTED' ? 'REJECTED' : 'INSUFFICIENT_DATA';
  return ['CANDIDATE','CONFIRMED','REJECTED','INSUFFICIENT_DATA'].includes(raw) ? raw : 'REJECTED';
}
export function listActiveStrategies() { return Object.values(STRATEGY_REGISTRY).filter(x => x.status === ACTIVE); }
export function getStrategyDefinition(id) {
  const key = String(id ?? '').trim().toUpperCase(); const strategy = STRATEGY_REGISTRY[key];
  if (!strategy || strategy.status !== ACTIVE) throw new Error('STRATEGY_NOT_ACTIVE'); return strategy;
}
export function normalizeStrategyResult(id, result, { coverage = 1, hardGatesPassed = true, dataQuality = 0 } = {}) {
  const strategy = getStrategyDefinition(id); const c = coverageInfo(coverage);
  const quality = Math.max(0, Math.min(100, Number(dataQuality) || 0)); const gatesPassed = hardGatesPassed === true;
  const state = normalizeState(result, c.value, gatesPassed); const rawScore = numericScore(result);
  const scoreValue = gatesPassed && c.value >= 1 && !['REJECTED','INSUFFICIENT_DATA'].includes(state) ? Math.max(0, Math.min(100, rawScore ?? 0)) : null;
  const resultReasons = Array.isArray(result?.reasonCodes) ? result.reasonCodes : (Array.isArray(result?.reason_codes) ? result.reason_codes : []);
  return {
    id: strategy.id, name: strategy.name, family: strategy.family, status: strategy.status,
    direction: normalizeDirection(result?.direction), signal_state: state,
    score: { value: scoreValue, coverage: c.value, decision_band: scoreValue == null ? 'insufficient' : decisionBand(scoreValue) },
    evidence: result?.evidence && typeof result.evidence === 'object' ? result.evidence : {},
    reason_codes: [...new Set(resultReasons)],
    invalidation: [...new Set([...strategy.invalidationRules, ...resultReasons.filter(x => /FALSE_BREAKOUT|PANIC_SELL_FILTER/i.test(String(x)))])],
    required_data: [...strategy.requiredData], data_quality: quality, confidence_score: 'UNKNOWN', paper_trading: true, real_order_execution: false
  };
}
function validateRegistry() {
  const entries = Object.values(STRATEGY_REGISTRY); if (entries.length !== 3) throw new Error('REGISTRY_ACTIVE_SET_MUST_BE_THREE');
  for (const strategy of entries) {
    if (strategy.status !== ACTIVE) throw new Error('STRATEGY_NOT_ACTIVE:' + strategy.id);
    if (typeof strategy.evaluator !== 'function') throw new Error('MISSING_EVALUATOR:' + strategy.id);
    if (!Array.isArray(strategy.requiredData) || !strategy.requiredData.length) throw new Error('MISSING_REQUIRED_DATA:' + strategy.id);
    if (!Array.isArray(strategy.hardGates) || !strategy.hardGates.length) throw new Error('MISSING_HARD_GATES:' + strategy.id);
    if (!Array.isArray(strategy.reasonCodes) || !strategy.reasonCodes.length) throw new Error('MISSING_REASON_CODES:' + strategy.id);
    if (!Array.isArray(strategy.invalidationRules) || !strategy.invalidationRules.length) throw new Error('MISSING_INVALIDATION_RULES:' + strategy.id);
  }
}
validateRegistry();
export { STRATEGY_REGISTRY };
