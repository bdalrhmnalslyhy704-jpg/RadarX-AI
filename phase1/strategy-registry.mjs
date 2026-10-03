import {
  evaluateMTFTrend,
  evaluateBreakout,
  evaluateMeanReversion
} from './radarx-phase1-engine.mjs';
import {
  evaluateEMARibbonAlignment,
  evaluateADXTrendStrength,
  evaluateMACDTrendContinuation,
  evaluateBollingerBandReversion,
  evaluateVWAPReversion,
  evaluateRelativeVolumeSurge,
  evaluateATRExpansion
} from './strategy-batch1.mjs';
import { evaluateVCP } from './vcp-strategy.mjs';
import {
  evaluateFractalMABottomReversal,
  evaluateFractalMABreakout,
  evaluateFractalMATrendShift
} from './strategy-fractal-ma.mjs';

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
  }),
  VCP_PRE_BREAKOUT: Object.freeze({
    id: 'VCP_PRE_BREAKOUT', name: 'Volatility Contraction Pattern', family: 'BREAKOUT', status: ACTIVE,
    requiredData: Object.freeze(['15m']), evaluator: evaluateVCP,
    scoreDimensions: Object.freeze(['vcpScore']),
    hardGates: Object.freeze(['CLOSED_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','VCP_CONTRACTION','VOLUME_DRY_UP']),
    reasonCodes: Object.freeze(['VCP_CONTRACTIONS','SUCCESSIVE_TIGHTENING','VOLUME_DRY_UP','RANGE_CONTRACTION','CONSTRUCTIVE_TREND','NEAR_BREAKOUT_PIVOT','VCP_BREAKOUT_CONFIRMED','INSUFFICIENT_VCP_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','FRESH_DATA_REQUIRED','VCP_GATE_NOT_MET']),
    testReference: 'phase2/tests/market-radar.test.mjs'
  }),
  EMA_RIBBON_ALIGNMENT: Object.freeze({
    id: 'EMA_RIBBON_ALIGNMENT', name: 'EMA Ribbon Alignment', family: 'TREND_FOLLOWING', status: ACTIVE,
    requiredData: Object.freeze(['1h', 'EMA20', 'EMA50', 'EMA100', 'EMA200']), evaluator: evaluateEMARibbonAlignment,
    scoreDimensions: Object.freeze(['alignment','separation','priceLocation']),
    hardGates: Object.freeze(['CLOSED_1H_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','RIBBON_SEPARATION']),
    reasonCodes: Object.freeze(['BULLISH_RIBBON','BEARISH_RIBBON','EMA20_ABOVE_50_ABOVE_100_ABOVE_200','EMA20_BELOW_50_BELOW_100_BELOW_200','PRICE_ABOVE_RIBBON','PRICE_BELOW_RIBBON','RIBBON_SEPARATION_TOO_SMALL','RIBBON_ALIGNMENT_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','RIBBON_ALIGNMENT_LOST','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  ADX_TREND_STRENGTH: Object.freeze({
    id: 'ADX_TREND_STRENGTH', name: 'ADX Trend Strength', family: 'TREND_FILTER', status: ACTIVE,
    requiredData: Object.freeze(['1h', 'ADX14', '+DI14', '-DI14', 'EMA50']), evaluator: evaluateADXTrendStrength,
    scoreDimensions: Object.freeze(['adxStrength','diSeparation','priceTrend']),
    hardGates: Object.freeze(['CLOSED_1H_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','MIN_ADX','DIRECTION_CONFIRMATION']),
    reasonCodes: Object.freeze(['ADX_STRONG','PLUS_DI_DOMINANT','MINUS_DI_DOMINANT','PRICE_ABOVE_EMA50','PRICE_BELOW_EMA50','ADX_TOO_WEAK','ADX_IS_CONFIRMATION_NOT_ENTRY','ADX_DIRECTION_CONFIRMATION_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','ADX_LOSES_STRENGTH','DI_DIRECTION_FLIPS','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  MACD_TREND_CONTINUATION: Object.freeze({
    id: 'MACD_TREND_CONTINUATION', name: 'MACD Trend Continuation', family: 'MOMENTUM', status: ACTIVE,
    requiredData: Object.freeze(['1h','4h','MACD12_26_9']), evaluator: evaluateMACDTrendContinuation,
    scoreDimensions: Object.freeze(['macdAlignment','histogram','higherTimeframeConfirmation']),
    hardGates: Object.freeze(['CLOSED_1H_4H_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','HIGHER_TF_CONFIRMATION']),
    reasonCodes: Object.freeze(['MACD_BULLISH_CONTINUATION','MACD_BEARISH_CONTINUATION','HIGHER_TF_CONFIRMATION','MACD_WEAKENING_OR_DIVERGENCE','MACD_CONFIRMATION_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','MACD_CROSS_FAILURE','MACD_WEAKENING_OR_DIVERGENCE','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  BOLLINGER_BAND_REVERSION: Object.freeze({
    id: 'BOLLINGER_BAND_REVERSION', name: 'Bollinger Band Reversion', family: 'MEAN_REVERSION', status: ACTIVE,
    requiredData: Object.freeze(['1h','BB20_2','RSI14']), evaluator: evaluateBollingerBandReversion,
    scoreDimensions: Object.freeze(['bandLocation','rsi','reversal','regimeFilter']),
    hardGates: Object.freeze(['CLOSED_1H_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','REGIME_FILTER','PANIC_VOLUME_FILTER']),
    reasonCodes: Object.freeze(['LOWER_BAND_TOUCH','UPPER_BAND_TOUCH','RSI_OVERSOLD','RSI_OVERBOUGHT','BULLISH_CANDLE_REVERSAL','BEARISH_CANDLE_REVERSAL','REGIME_FILTER_OK','PANIC_VOLUME_REJECTION','BOLLINGER_REVERSION_FILTER_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','REGIME_TREND_TOO_STRONG','PANIC_VOLUME_REJECTION','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  VWAP_REVERSION: Object.freeze({
    id: 'VWAP_REVERSION', name: 'VWAP Reversion', family: 'MEAN_REVERSION', status: ACTIVE,
    requiredData: Object.freeze(['15m','DAILY_VWAP']), evaluator: evaluateVWAPReversion,
    scoreDimensions: Object.freeze(['vwapDeviation','returnToVwap','candleConfirmation','liquidity']),
    hardGates: Object.freeze(['CLOSED_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','LIQUIDITY_GATE','RETURN_CONFIRMATION']),
    reasonCodes: Object.freeze(['VWAP_UNDERSHOOT','VWAP_OVERSHOOT','RETURN_TOWARD_VWAP','BULLISH_REVERSAL_CANDLE','BEARISH_REVERSAL_CANDLE','LOW_LIQUIDITY','VWAP_DEVIATION_TOO_SMALL','VWAP_RETURN_CONFIRMATION_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','LIQUIDITY_LOST','RETURN_TO_VWAP_FAILS','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  RELATIVE_VOLUME_SURGE: Object.freeze({
    id: 'RELATIVE_VOLUME_SURGE', name: 'Relative Volume Surge', family: 'VOLUME', status: ACTIVE,
    requiredData: Object.freeze(['15m','RVOL20','PRICE_ACTION']), evaluator: evaluateRelativeVolumeSurge,
    scoreDimensions: Object.freeze(['rvol','priceAction','trendContext']),
    hardGates: Object.freeze(['CLOSED_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','RVOL_THRESHOLD','PRICE_ACTION_CONFIRMATION']),
    reasonCodes: Object.freeze(['RVOL_SURGE','BULLISH_PRICE_ACTION','BEARISH_PRICE_ACTION','EMA20_CONTEXT','RVOL_THRESHOLD_NOT_MET','PRICE_ACTION_TOO_WEAK','PRICE_DIRECTION_CONTEXT_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','RVOL_NORMALIZES','PRICE_ACTION_FAILS','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  ATR_EXPANSION: Object.freeze({
    id: 'ATR_EXPANSION', name: 'ATR Expansion', family: 'VOLATILITY', status: ACTIVE,
    requiredData: Object.freeze(['15m','ATR14','ATR_BASELINE20','PRICE_CONFIRMATION']), evaluator: evaluateATRExpansion,
    scoreDimensions: Object.freeze(['expansionRatio','priceConfirmation','liquidity']),
    hardGates: Object.freeze(['CLOSED_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','ATR_EXPANSION','LIQUIDITY_GATE','PRICE_CONFIRMATION']),
    reasonCodes: Object.freeze(['ATR_EXPANDING','BULLISH_PRICE_CONFIRMATION','BEARISH_PRICE_CONFIRMATION','LIQUIDITY_OK','LOW_LIQUIDITY','ATR_EXPANSION_NOT_MET','PRICE_CONFIRMATION_WEAK','PRICE_DIRECTION_CONTEXT_NOT_MET','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','ATR_CONTRACTION','LIQUIDITY_LOST','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-batch1.test.mjs'
  }),
  FRACTAL_MA_BOTTOM_REVERSAL: Object.freeze({
    id: 'FRACTAL_MA_BOTTOM_REVERSAL', name: 'Fractal + EMA Bottom Reversal', family: 'BOTTOM_REVERSAL', status: ACTIVE,
    requiredData: Object.freeze(['1h','EMA20','EMA50']), evaluator: evaluateFractalMABottomReversal,
    scoreDimensions: Object.freeze(['higherLow','emaReclaim','maSlope','rvol']),
    hardGates: Object.freeze(['CLOSED_1H_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','FRACTAL_STRUCTURE','EMA20_RECLAIM']),
    reasonCodes: Object.freeze(['HIGHER_LOW','EMA20_RECLAIM_OR_NEAR_RECLAIM','PRICE_ABOVE_EMA50','RVOL_SUPPORT','FRACTAL_MA_BOTTOM_NOT_CONFIRMED','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','FRACTAL_STRUCTURE_LOST','EMA20_RECLAIM_LOST','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-fractal-ma.test.mjs'
  }),
  FRACTAL_MA_BREAKOUT: Object.freeze({
    id: 'FRACTAL_MA_BREAKOUT', name: 'Fractal + EMA Breakout', family: 'BREAKOUT', status: ACTIVE,
    requiredData: Object.freeze(['15m','EMA20','EMA50']), evaluator: evaluateFractalMABreakout,
    scoreDimensions: Object.freeze(['fractalBreak','maAlignment','higherLow','rvol']),
    hardGates: Object.freeze(['CLOSED_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','FRACTAL_BREAKOUT','MA_ALIGNMENT']),
    reasonCodes: Object.freeze(['FRACTAL_HIGH_BREAKOUT_OR_NEAR_BREAKOUT','EMA20_ABOVE_OR_NEAR_EMA50','HIGHER_LOW_STRUCTURE','RVOL_BREAKOUT','FRACTAL_BREAKOUT_NOT_CONFIRMED','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','FRACTAL_BREAKOUT_FAILURE','MA_ALIGNMENT_LOST','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-fractal-ma.test.mjs'
  }),
  FRACTAL_MA_TREND_SHIFT: Object.freeze({
    id: 'FRACTAL_MA_TREND_SHIFT', name: 'Fractal + EMA Multi-Timeframe Trend Shift', family: 'TREND_TRANSITION', status: ACTIVE,
    requiredData: Object.freeze(['1h','15m','EMA20','EMA50']), evaluator: evaluateFractalMATrendShift,
    scoreDimensions: Object.freeze(['multiTfStructure','maShift','priceConfirm','momentum']),
    hardGates: Object.freeze(['CLOSED_1H_15M_DATA','VALID_SERIES','FRESH_DATA','NO_FUTURE_DATA','MIN_HISTORY','FRACTAL_STRUCTURE','MA_SHIFT']),
    reasonCodes: Object.freeze(['MULTI_TIMEFRAME_FRACTAL_STRUCTURE','EMA20_EMA50_TREND_SHIFT','PRICE_ABOVE_EMA50','15M_MOMENTUM_CONFIRMATION','FRACTAL_MA_TREND_SHIFT_NOT_CONFIRMED','INSUFFICIENT_DATA']),
    invalidationRules: Object.freeze(['CLOSED_CANDLE_REQUIRED','FRACTAL_STRUCTURE_LOST','MA_SHIFT_REVERSED','FRESH_DATA_REQUIRED']),
    testReference: 'phase1/tests/strategy-fractal-ma.test.mjs'
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
export function normalizeStrategyResult(id, result, { coverage = 1, hardGatesPassed = undefined, dataQuality = undefined } = {}) {
  const strategy = getStrategyDefinition(id); const c = coverageInfo(coverage);
  const gatesPassed = hardGatesPassed === undefined ? result?.hardGatesPassed !== false : hardGatesPassed === true;
  const qualitySource = dataQuality === undefined ? result?.dataQuality : dataQuality;
  const quality = Math.max(0, Math.min(100, Number(qualitySource) || 0));
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
  const entries = Object.values(STRATEGY_REGISTRY);
  const allowedActive = new Set(['MTF_TREND','CONFIRMED_BREAKOUT','MEAN_REVERSION','VCP_PRE_BREAKOUT','EMA_RIBBON_ALIGNMENT','ADX_TREND_STRENGTH','MACD_TREND_CONTINUATION','BOLLINGER_BAND_REVERSION','VWAP_REVERSION','RELATIVE_VOLUME_SURGE','ATR_EXPANSION','FRACTAL_MA_BOTTOM_REVERSAL','FRACTAL_MA_BREAKOUT','FRACTAL_MA_TREND_SHIFT']);
  if (entries.length !== allowedActive.size) throw new Error('REGISTRY_ACTIVE_SET_SIZE_MISMATCH');
  for (const strategy of entries) {
    if (strategy.status !== ACTIVE || !allowedActive.has(strategy.id)) throw new Error('STRATEGY_NOT_ACTIVE:' + strategy.id);
    if (typeof strategy.evaluator !== 'function') throw new Error('MISSING_EVALUATOR:' + strategy.id);
    if (!Array.isArray(strategy.requiredData) || !strategy.requiredData.length) throw new Error('MISSING_REQUIRED_DATA:' + strategy.id);
    if (!Array.isArray(strategy.hardGates) || !strategy.hardGates.length) throw new Error('MISSING_HARD_GATES:' + strategy.id);
    if (!Array.isArray(strategy.reasonCodes) || !strategy.reasonCodes.length) throw new Error('MISSING_REASON_CODES:' + strategy.id);
    if (!Array.isArray(strategy.invalidationRules) || !strategy.invalidationRules.length) throw new Error('MISSING_INVALIDATION_RULES:' + strategy.id);
  }
}
validateRegistry();
export { STRATEGY_REGISTRY };
