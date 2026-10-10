const known = value => value !== null && value !== undefined &&
  !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));
const num = value => known(value) ? Number(value) : null;
const mean = values => {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
};
const median = values => {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
};
const round = (value, digits = 4) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export const QUIET_BASE_PRE_EXPANSION_DEFAULTS = Object.freeze({
  minClosedCandles: 60,
  candleStepMs: 5 * 60_000,
  freshness5mMs: 8 * 60_000,
  maxQuietMove24hPct: 8,
  maxMove5mPct: 2.5,
  maxMove15mPct: 6,
  maxBaseRangePct: 2.5,
  maxAtrRatio: 0.85,
  maxBollingerWidthRatio: 0.88,
  maxResistanceDistancePct: 2.5,
  maxSupportUndercutPct: 0.3,
  minParticipationRatio: 1.08,
  minMiddleParticipationRatio: 0.98,
  minStepParticipationRatio: 1.01
});

function validClosedCandles(input, now) {
  return (Array.isArray(input) ? input : [])
    .filter(candle =>
      candle && candle.closed !== false &&
      Number.isFinite(Number(candle.openTime)) &&
      Number.isFinite(Number(candle.closeTime)) &&
      Number(candle.closeTime) <= now &&
      Number(candle.open) > 0 && Number(candle.close) > 0 &&
      Number(candle.high) >= Math.max(Number(candle.open), Number(candle.close)) &&
      Number(candle.low) <= Math.min(Number(candle.open), Number(candle.close)) &&
      Number(candle.low) > 0 && Number(candle.volume) >= 0
    )
    .sort((a, b) => Number(a.openTime) - Number(b.openTime));
}

function candleRangePct(candles) {
  if (!candles.length) return null;
  const high = Math.max(...candles.map(row => Number(row.high)));
  const low = Math.min(...candles.map(row => Number(row.low)));
  const close = mean(candles.map(row => Number(row.close)));
  return close > 0 ? (high - low) / close * 100 : null;
}

function trueRange(previous, current) {
  const high = Number(current.high), low = Number(current.low), close = Number(previous.close);
  return Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
}

function bollingerWidth(candles) {
  if (candles.length !== 20) return null;
  const closes = candles.map(row => Number(row.close));
  const mid = mean(closes);
  if (!(mid > 0)) return null;
  const variance = mean(closes.map(value => (value - mid) ** 2));
  return variance >= 0 ? (4 * Math.sqrt(variance) / mid) * 100 : null;
}

function participationTrend(candles, field, cfg) {
  const last12 = candles.slice(-12);
  const baselineRows = candles.slice(-32, -12);
  const values = row => {
    const value = num(row[field]);
    return value !== null && value >= 0 ? value : null;
  };
  const baseline = median(baselineRows.map(values).filter(Number.isFinite));
  const buckets = [last12.slice(0, 4), last12.slice(4, 8), last12.slice(8, 12)]
    .map(bucket => median(bucket.map(values).filter(Number.isFinite)));
  const [oldest, middle, recent] = buckets;
  const ratio = baseline > 0 && recent !== null ? recent / baseline : null;
  const middleRatio = oldest > 0 && middle !== null ? middle / oldest : null;
  const stepRatio = middle > 0 && recent !== null ? recent / middle : null;
  const sampleCount = last12.map(values).filter(Number.isFinite).length;
  const available = sampleCount === 12 && baseline > 0 &&
    Number.isFinite(oldest) && oldest > 0 &&
    Number.isFinite(middle) && middle > 0 &&
    Number.isFinite(recent);
  const improving = available &&
    ratio >= cfg.minParticipationRatio &&
    middleRatio >= cfg.minMiddleParticipationRatio &&
    stepRatio >= cfg.minStepParticipationRatio;
  return {
    available, samples: sampleCount,
    baseline: round(baseline, 6), oldest_bucket: round(oldest, 6),
    middle_bucket: round(middle, 6), recent_bucket: round(recent, 6),
    recent_vs_self_baseline: round(ratio, 4),
    middle_vs_oldest: round(middleRatio, 4),
    recent_vs_middle: round(stepRatio, 4),
    improving: Boolean(improving)
  };
}

function makeEvidence(key, value, threshold, passed, acceptedReason, rejectedReason, candleCloseTime) {
  return {
    key, value, threshold, passed: Boolean(passed),
    reason: passed ? acceptedReason : rejectedReason,
    used_through_candle_close_time_ms: candleCloseTime,
    used_through_candle_close_time: Number.isFinite(candleCloseTime) ? new Date(candleCloseTime).toISOString() : null
  };
}

/**
 * Radar 8-only early fingerprint. Inputs are public Spot OHLCV/trade-count
 * candles and ticker data. It uses completed 5m candles only and never reads
 * candles whose close time is after the supplied as-of time.
 */
export function assessQuietBasePreExpansion({
  fiveMinute = [], ticker = {}, now = Date.now(), dataReady = true,
  dataIssues = [], config = {}
} = {}) {
  const cfg = { ...QUIET_BASE_PRE_EXPANSION_DEFAULTS, ...config };
  const asOf = Number(now);
  const rows = validClosedCandles(fiveMinute, asOf);
  const last = rows.at(-1) || null;
  const closeTime = last ? Number(last.closeTime) : null;
  const dailyMove = num(ticker?.priceChange24h);
  const closeTsFresh = Number.isFinite(closeTime) && Number.isFinite(asOf) &&
    asOf >= closeTime && asOf - closeTime <= Number(cfg.freshness5mMs);
  const invalidIssues = (Array.isArray(dataIssues) ? dataIssues : [])
    .filter(issue => /STALE|FUTURE|GAP|MISSING_TIMEFRAME|INVALID|INCOMPLETE/i.test(String(issue)));
  const fatalData = dataReady !== true || invalidIssues.length > 0 ||
    rows.length < Number(cfg.minClosedCandles) || !closeTsFresh ||
    dailyMove === null || !(num(ticker?.lastPrice) > 0);
  const result = {
    fingerprint: 'QUIET_BASE_PRE_EXPANSION',
    classification: 'DATA_INSUFFICIENT',
    reason: 'REQUIRED_DATA_MISSING_OR_STALE',
    flow_state: 'UNKNOWN_FLOW',
    detected: false,
    closed_candles_only: true,
    used_candles: rows.length,
    required_candles: Number(cfg.minClosedCandles),
    candle_close_time_ms: closeTime,
    candle_close_time: Number.isFinite(closeTime) ? new Date(closeTime).toISOString() : null,
    evidence: [],
    metrics: {
      daily_change_24h_pct: dailyMove,
      closed_candles: rows.length,
      latest_close_time_ms: closeTime,
      latest_candle_age_ms: Number.isFinite(closeTime) && Number.isFinite(asOf) ? Math.max(0, asOf - closeTime) : null,
      stale: !closeTsFresh,
      data_issues: invalidIssues
    }
  };
  if (fatalData) {
    result.evidence.push(makeEvidence(
      'data_quality',
      { data_ready: dataReady === true, closed_candles: rows.length, daily_change_24h_pct: dailyMove, fresh: closeTsFresh, issues: invalidIssues },
      { minimum_closed_candles: Number(cfg.minClosedCandles), maximum_age_ms: Number(cfg.freshness5mMs), future_candles_excluded: true },
      false, 'REQUIRED_DATA_VALID', rows.length < Number(cfg.minClosedCandles) ? 'TOO_FEW_CLOSED_CANDLES' :
        (!closeTsFresh ? 'STALE_OR_INVALID_CANDLE_TIME' : dailyMove === null ? 'DAILY_CHANGE_UNKNOWN' : 'DATA_GATE_REJECTED'),
      closeTime
    ));
    return result;
  }

  const candleStep = Number(cfg.candleStepMs);
  const recent60 = rows.slice(-Number(cfg.minClosedCandles));
  let gapCount = 0;
  for (let i = 1; i < recent60.length; i++) {
    const delta = Number(recent60[i].openTime) - Number(recent60[i - 1].openTime);
    if (Math.abs(delta - candleStep) > 1000) gapCount++;
  }
  if (gapCount > 0) {
    result.reason = 'CLOSED_CANDLE_SEQUENCE_HAS_GAPS';
    result.metrics.gap_count = gapCount;
    result.evidence.push(makeEvidence('closed_candle_continuity', gapCount, 0, false,
      'CONTIGUOUS_CLOSED_CANDLES', 'MISSING_OR_DUPLICATE_CANDLES', closeTime));
    return result;
  }

  const recent12 = rows.slice(-12);
  const baseRangePct = candleRangePct(recent12);
  const trueRanges = [];
  for (let i = 1; i < rows.length; i++) trueRanges.push(trueRange(rows[i - 1], rows[i]));
  const recentAtr = mean(trueRanges.slice(-14));
  const baselineAtr = mean(trueRanges.slice(-28, -14));
  const atrRatio = baselineAtr > 0 && recentAtr !== null ? recentAtr / baselineAtr : null;
  const currentBbWidth = bollingerWidth(rows.slice(-20));
  const oldBbWidths = [];
  for (let end = 20; end <= rows.length - 20; end++) {
    const width = bollingerWidth(rows.slice(end - 20, end));
    if (Number.isFinite(width)) oldBbWidths.push(width);
  }
  const baselineBbWidth = median(oldBbWidths);
  const bbRatio = baselineBbWidth > 0 && currentBbWidth !== null ? currentBbWidth / baselineBbWidth : null;

  const firstHalfLow = Math.min(...recent12.slice(0, 6).map(row => Number(row.low)));
  const secondHalfLow = Math.min(...recent12.slice(6).map(row => Number(row.low)));
  const lastClose = Number(last.close);
  const supportUndercutPct = firstHalfLow > 0 ? (firstHalfLow - secondHalfLow) / firstHalfLow * 100 : null;
  const higherLows = Number.isFinite(supportUndercutPct) && supportUndercutPct <= -0.02;
  const supportStable = firstHalfLow > 0 && Number.isFinite(supportUndercutPct) &&
    supportUndercutPct <= Number(cfg.maxSupportUndercutPct);
  const supportPassed = higherLows || supportStable;

  const priorResistanceRows = rows.slice(-25, -1);
  const resistance = priorResistanceRows.length ? Math.max(...priorResistanceRows.map(row => Number(row.high))) : null;
  const resistanceDistancePct = Number.isFinite(resistance) && lastClose > 0
    ? (resistance - lastClose) / lastClose * 100 : null;
  const nearResistance = Number.isFinite(resistanceDistancePct) &&
    resistanceDistancePct >= -0.1 && resistanceDistancePct <= Number(cfg.maxResistanceDistancePct);

  const volumeTrend = participationTrend(rows, 'volume', cfg);
  const tradeField = rows.every(row => known(row.tradeCount ?? row.count)) ? 'tradeCount' : 'count';
  const tradeTrend = participationTrend(rows.map(row => ({ ...row, tradeCount: row.tradeCount ?? row.count })), 'tradeCount', cfg);
  const volumeImproving = volumeTrend.available && volumeTrend.improving;
  const tradesImproving = tradeTrend.available && tradeTrend.improving;
  const narrowBase = Number.isFinite(baseRangePct) && baseRangePct <= Number(cfg.maxBaseRangePct);
  const atrContracting = Number.isFinite(atrRatio) && atrRatio <= Number(cfg.maxAtrRatio);
  const bbContracting = Number.isFinite(bbRatio) && bbRatio <= Number(cfg.maxBollingerWidthRatio);
  const compressionConfirmed = narrowBase && atrContracting && bbContracting;
  const structureConfirmed = supportPassed;
  const participationConfirmed = volumeImproving && tradesImproving;
  const someParticipation = volumeImproving || tradesImproving;

  const recentVolume = mean(recent12.map(row => Math.max(0, Number(row.volume) || 0)));
  const recentTakerBuy = mean(recent12.map(row => {
    const volume = Number(row.volume), buy = num(row.takerBuyBaseVolume);
    return volume > 0 && buy !== null ? buy / volume : null;
  }).filter(Number.isFinite));
  if (recentTakerBuy !== null && recentTakerBuy < 0.5 &&
      volumeTrend.recent_vs_self_baseline >= Number(cfg.minParticipationRatio) &&
      narrowBase) result.flow_state = 'POSSIBLE_ABSORPTION';
  else result.flow_state = 'UNKNOWN_FLOW';

  const move5m = Math.abs((lastClose / Number(rows.at(-2).close) - 1) * 100);
  const move15m = Math.abs((lastClose / Number(rows.at(-4).close) - 1) * 100);
  const extended = Math.abs(dailyMove) >= Number(cfg.maxQuietMove24hPct) ||
    move5m >= Number(cfg.maxMove5mPct) || move15m >= Number(cfg.maxMove15mPct);
  const evidence = [
    makeEvidence('narrow_price_base_range_pct', round(baseRangePct), { max_pct: Number(cfg.maxBaseRangePct) }, narrowBase, 'PRICE_BASE_IS_TIGHT', 'PRICE_BASE_TOO_WIDE', closeTime),
    makeEvidence('atr_contraction_ratio', round(atrRatio), { max_ratio: Number(cfg.maxAtrRatio) }, atrContracting, 'ATR_CONTRACTING_VS_PRIOR_SELF_BASELINE', 'ATR_CONTRACTION_NOT_CONFIRMED', closeTime),
    makeEvidence('bollinger_width_ratio', round(bbRatio), { max_ratio: Number(cfg.maxBollingerWidthRatio) }, bbContracting, 'BOLLINGER_WIDTH_CONTRACTING_VS_PRIOR_SELF_BASELINE', 'BOLLINGER_CONTRACTION_NOT_CONFIRMED', closeTime),
    makeEvidence('higher_lows_or_stable_support', { higher_lows: higherLows, support_stable: supportStable, first_half_support: round(firstHalfLow), second_half_support: round(secondHalfLow), support_undercut_pct: round(supportUndercutPct) }, { max_support_undercut_pct: Number(cfg.maxSupportUndercutPct) }, structureConfirmed, 'HIGHER_LOWS_OR_SUPPORT_HOLDS', 'SUPPORT_STRUCTURE_NOT_CONFIRMED', closeTime),
    makeEvidence('resistance_proximity_pct', round(resistanceDistancePct), { min_pct: -0.1, max_pct: Number(cfg.maxResistanceDistancePct) }, nearResistance, 'PRICE_NEAR_PRIOR_RESISTANCE', 'RESISTANCE_NOT_NEAR_OR_ALREADY_CROSSED', closeTime),
    makeEvidence('gradual_volume_vs_same_coin', volumeTrend, { min_recent_vs_baseline: Number(cfg.minParticipationRatio), min_middle_vs_oldest: Number(cfg.minMiddleParticipationRatio), min_recent_vs_middle: Number(cfg.minStepParticipationRatio) }, volumeImproving, 'VOLUME_GRADUALLY_IMPROVING_VS_OWN_BASELINE', 'VOLUME_TREND_NOT_GRADUALLY_IMPROVING', closeTime),
    makeEvidence('gradual_trades_vs_same_coin', tradeTrend, { min_recent_vs_baseline: Number(cfg.minParticipationRatio), min_middle_vs_oldest: Number(cfg.minMiddleParticipationRatio), min_recent_vs_middle: Number(cfg.minStepParticipationRatio) }, tradesImproving, 'TRADE_COUNT_GRADUALLY_IMPROVING_VS_OWN_BASELINE', 'TRADE_COUNT_TREND_NOT_GRADUALLY_IMPROVING', closeTime),
    makeEvidence('anti_chase', { daily_change_24h_pct: round(dailyMove), move_5m_pct: round(move5m), move_15m_pct: round(move15m) }, { max_abs_24h_pct: Number(cfg.maxQuietMove24hPct), max_abs_5m_pct: Number(cfg.maxMove5mPct), max_abs_15m_pct: Number(cfg.maxMove15mPct) }, !extended, 'MOVE_NOT_EXTENDED', 'ALREADY_EXTENDED', closeTime)
  ];
  result.evidence = evidence;
  result.metrics = {
    daily_change_24h_pct: round(dailyMove), move_5m_pct: round(move5m), move_15m_pct: round(move15m),
    narrow_base_range_pct: round(baseRangePct), atr_current: round(recentAtr, 8), atr_baseline: round(baselineAtr, 8),
    atr_ratio: round(atrRatio), bollinger_width_pct: round(currentBbWidth), bollinger_width_baseline_pct: round(baselineBbWidth),
    bollinger_width_ratio: round(bbRatio), higher_lows: higherLows, support_stable: supportStable,
    support_low_first_half: round(firstHalfLow), support_low_second_half: round(secondHalfLow),
    resistance_price: round(resistance, 8), resistance_distance_pct: round(resistanceDistancePct),
    volume_trend: volumeTrend, trades_trend: tradeTrend, flow_state: result.flow_state,
    future_candles_excluded: (Array.isArray(fiveMinute) ? fiveMinute.length : 0) - rows.length,
    last_closed_price: round(lastClose, 8), last_closed_volume: round(Number(last.volume)),
    last_closed_trade_count: num(last.tradeCount ?? last.count),
    recent_volume_mean: round(recentVolume)
  };
  const coreBase = compressionConfirmed && structureConfirmed && nearResistance;
  if (extended) {
    result.classification = 'ALREADY_EXTENDED';
    result.reason = 'ANTI_CHASE_MOVE_ALREADY_EXTENDED';
  } else if (coreBase && participationConfirmed) {
    result.classification = 'PRE_EXPANSION';
    result.reason = 'QUIET_COMPRESSED_BASE_WITH_GRADUAL_VOLUME_AND_TRADE_BUILD';
    result.detected = true;
  } else if (coreBase && someParticipation) {
    result.classification = 'WATCH_EARLY';
    result.reason = 'QUIET_BASE_CONFIRMED_BUT_PARTICIPATION_IS_PARTIAL';
  } else {
    result.classification = 'NO_SIGNAL';
    result.reason = !compressionConfirmed ? 'PRICE_ATR_OR_BOLLINGER_COMPRESSION_NOT_CONFIRMED' :
      !structureConfirmed ? 'SUPPORT_STRUCTURE_NOT_CONFIRMED' :
      !nearResistance ? 'RESISTANCE_NOT_NEAR' : 'GRADUAL_PARTICIPATION_NOT_CONFIRMED';
  }
  return result;
}
