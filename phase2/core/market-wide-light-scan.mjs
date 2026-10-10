const KNOWN = value => value !== null && value !== undefined &&
  !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value));
const numberOrNull = value => KNOWN(value) ? Number(value) : null;
const mean = values => {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
};
const median = values => {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
};
const clamp = value => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
const symbolOf = row => String(row?.symbol || '').trim().toUpperCase();

export const MARKET_WIDE_LIGHT_SCAN_DEFAULTS = Object.freeze({
  minClosedCandles: 60,
  maxClosedCandles: 96,
  maxCandleAgeMs: 8 * 60_000,
  candleStepMs: 5 * 60_000,
  continuityToleranceMs: 1000,
  maxBaseRangePct: 2.5,
  maxAtrRatio: 0.85,
  maxBollingerWidthRatio: 0.88,
  maxResistanceDistancePct: 2.5,
  maxSupportUndercutPct: 0.3,
  minParticipationRatio: 1.08,
  minMiddleParticipationRatio: 0.98,
  minStepParticipationRatio: 1.01,
  candidateLimit: 48,
  rotationReserve: 12,
  minimumReadyCandidates: 24,
  maxEligibleSymbols: 1200
});

function validateCandles(input, now, cfg) {
  const all = Array.isArray(input) ? input : [];
  const closed = [];
  let futureExcluded = 0;
  let malformedClosed = 0;
  for (const candle of all) {
    if (!candle || candle.closed !== true) continue;
    const openTime = numberOrNull(candle.openTime), closeTime = numberOrNull(candle.closeTime);
    const open = numberOrNull(candle.open), high = numberOrNull(candle.high);
    const low = numberOrNull(candle.low), close = numberOrNull(candle.close);
    if (closeTime !== null && closeTime > now) {
      futureExcluded++;
      continue;
    }
    if (openTime === null || closeTime === null || closeTime < openTime ||
        open === null || high === null || low === null || close === null ||
        !(open > 0) || !(close > 0) || !(low > 0) ||
        high < Math.max(open, close) || low > Math.min(open, close)) {
      malformedClosed++;
      continue;
    }
    const volume = numberOrNull(candle.volume);
    const tradeCount = numberOrNull(candle.tradeCount);
    if ((volume !== null && volume < 0) || (tradeCount !== null && tradeCount < 0)) {
      malformedClosed++;
      continue;
    }
    closed.push({...candle, openTime, closeTime, open, high, low, close, volume, tradeCount});
  }
  closed.sort((a, b) => a.openTime - b.openTime);
  const unique = [];
  const seenTimes = new Set();
  for (const candle of closed) {
    if (seenTimes.has(candle.openTime)) {
      unique[unique.length - 1] = candle;
      continue;
    }
    seenTimes.add(candle.openTime);
    unique.push(candle);
  }
  const rows = unique.slice(-Math.max(cfg.minClosedCandles, cfg.maxClosedCandles));
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs((rows[i].openTime - rows[i - 1].openTime) - cfg.candleStepMs) > cfg.continuityToleranceMs) gaps++;
  }
  return {rows, futureExcluded, malformedClosed, gaps};
}

function trueRanges(rows) {
  const values = [];
  for (let i = 1; i < rows.length; i++) {
    const current = rows[i], previous = rows[i - 1];
    values.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return values;
}

function bollingerWidth(rows) {
  if (rows.length !== 20) return null;
  const closes = rows.map(row => row.close);
  const mid = mean(closes);
  if (!(mid > 0)) return null;
  const variance = mean(closes.map(value => (value - mid) ** 2));
  return variance !== null ? 4 * Math.sqrt(variance) / mid * 100 : null;
}

function gradualParticipation(rows, field, cfg) {
  const values = rows.map(row => numberOrNull(row[field]));
  if (values.length < 32 || values.some(value => value === null || value < 0)) {
    return {available: false, reason: 'PARTICIPATION_FIELD_MISSING', baseline: null, recentRatio: null,
      middleRatio: null, stepRatio: null, improving: null};
  }
  const baseline = median(values.slice(-32, -12));
  const last12 = values.slice(-12);
  const buckets = [
    median(last12.slice(0, 4)),
    median(last12.slice(4, 8)),
    median(last12.slice(8, 12))
  ];
  const [oldest, middle, recent] = buckets;
  if (!(baseline > 0) || !(oldest > 0) || !(middle > 0) || !(recent >= 0)) {
    return {available: false, reason: 'PARTICIPATION_BASELINE_UNAVAILABLE', baseline: null, recentRatio: null,
      middleRatio: null, stepRatio: null, improving: null};
  }
  const recentRatio = recent / baseline, middleRatio = middle / oldest, stepRatio = recent / middle;
  return {
    available: true, reason: 'PARTICIPATION_AVAILABLE', baseline,
    oldestBucket: oldest, middleBucket: middle, recentBucket: recent,
    recentRatio, middleRatio, stepRatio,
    improving: recentRatio >= cfg.minParticipationRatio &&
      middleRatio >= cfg.minMiddleParticipationRatio && stepRatio >= cfg.minStepParticipationRatio
  };
}

/** Light ranking only. It never emits, stores, or authorizes a trading alert. */
export function evaluateMarketWideLightCandidate({
  symbol, series = null, now = Date.now(), config = {}
} = {}) {
  const cfg = {...MARKET_WIDE_LIGHT_SCAN_DEFAULTS, ...config};
  const key = String(symbol || series?.symbol || '').trim().toUpperCase();
  if (!key) return insufficient('', series, Number(now), 'INVALID_SYMBOL');
  const at = Number(now);
  if (!Number.isFinite(at)) return insufficient(key, series, Date.now(), 'INVALID_SCAN_TIME');
  if (!series || !Array.isArray(series.candles)) return insufficient(key, series, at, 'CANDLE_CACHE_MISSING');
  const normalized = validateCandles(series.candles, at, cfg);
  const rows = normalized.rows;
  const last = rows.at(-1) || null;
  const age = last ? Math.max(0, at - last.closeTime) : null;
  const source = String(series.source || last?.source || 'UNKNOWN_SOURCE');
  const dataDetails = {
    closed_candles: rows.length,
    futureExcluded: normalized.futureExcluded,
    malformedClosed: normalized.malformedClosed,
    gap_count: normalized.gaps,
    latest_close_time_ms: last?.closeTime ?? null,
    maximum_age_ms: cfg.maxCandleAgeMs
  };
  if (!last) return insufficient(key, series, at, 'NO_VALID_CLOSED_5M_CANDLES', dataDetails);
  if (age > cfg.maxCandleAgeMs) return insufficient(key, series, at, 'STALE_CLOSED_5M_CACHE', dataDetails);
  if (normalized.malformedClosed > 0) return insufficient(key, series, at, 'INVALID_CLOSED_CANDLE', dataDetails);
  if (normalized.gaps > 0) return insufficient(key, series, at, 'CLOSED_CANDLE_SEQUENCE_HAS_GAPS', dataDetails);
  if (rows.length < cfg.minClosedCandles) return insufficient(key, series, at, 'INSUFFICIENT_CLOSED_5M_CANDLES', dataDetails);
  if (!['BINANCE_PUBLIC_WS', 'BINANCE_PUBLIC_REST', 'BINANCE_PUBLIC_REST_CACHE'].includes(source) &&
      !rows.some(row => ['BINANCE_PUBLIC_WS', 'BINANCE_PUBLIC_REST', 'BINANCE_PUBLIC_REST_CACHE'].includes(String(row.source)))) {
    return insufficient(key, series, at, 'UNVERIFIED_CANDLE_SOURCE', dataDetails);
  }

  const recent12 = rows.slice(-12);
  const baseHigh = Math.max(...recent12.map(row => row.high));
  const baseLow = Math.min(...recent12.map(row => row.low));
  const meanClose = mean(recent12.map(row => row.close));
  const baseRangePct = meanClose > 0 ? (baseHigh - baseLow) / meanClose * 100 : null;

  const trs = trueRanges(rows);
  const recentAtr = mean(trs.slice(-14));
  const baselineAtr = mean(trs.slice(-28, -14));
  const atrRatio = baselineAtr > 0 && recentAtr !== null ? recentAtr / baselineAtr : null;

  const currentWidth = bollingerWidth(rows.slice(-20));
  const oldWidths = [];
  for (let end = 20; end <= rows.length - 20; end++) {
    const width = bollingerWidth(rows.slice(end - 20, end));
    if (Number.isFinite(width)) oldWidths.push(width);
  }
  const baselineWidth = median(oldWidths);
  const bollingerWidthRatio = baselineWidth > 0 && currentWidth !== null ? currentWidth / baselineWidth : null;

  const firstHalfLow = Math.min(...recent12.slice(0, 6).map(row => row.low));
  const secondHalfLow = Math.min(...recent12.slice(6).map(row => row.low));
  const supportUndercutPct = firstHalfLow > 0 ? (firstHalfLow - secondHalfLow) / firstHalfLow * 100 : null;
  const higherLows = supportUndercutPct !== null && supportUndercutPct <= -0.02;
  const stableSupport = supportUndercutPct !== null && supportUndercutPct <= cfg.maxSupportUndercutPct;
  const supportConfirmed = higherLows || stableSupport;

  const resistanceRows = rows.slice(-25, -1);
  const resistance = resistanceRows.length ? Math.max(...resistanceRows.map(row => row.high)) : null;
  const lastClose = Number(last.close);
  const resistanceDistancePct = resistance !== null && lastClose > 0 ? (resistance - lastClose) / lastClose * 100 : null;
  const nearResistance = Number.isFinite(resistanceDistancePct) &&
    resistanceDistancePct >= -0.1 && resistanceDistancePct <= cfg.maxResistanceDistancePct;

  // Missing volume/trade-count data are explicitly marked and never replaced with zero or synthetic values.
  const volumeParticipation = gradualParticipation(rows, 'volume', cfg);
  const tradeParticipation = gradualParticipation(rows, 'tradeCount', cfg);
  const rangeScore = baseRangePct === null ? null : clamp(100 * (1 - baseRangePct / cfg.maxBaseRangePct));
  const atrScore = atrRatio === null ? null : clamp(100 * (1 - atrRatio / 1.3));
  const bbScore = bollingerWidthRatio === null ? null : clamp(100 * (1 - bollingerWidthRatio / 1.3));
  const compressionScore = atrScore === null && bbScore === null ? null :
    Math.max(atrScore ?? -1, bbScore ?? -1);
  const structureScore = higherLows ? 100 : stableSupport ? 70 : 0;
  const resistanceScore = nearResistance ? clamp(100 * (1 - Math.max(0, resistanceDistancePct) / cfg.maxResistanceDistancePct)) : 0;
  const participationScores = [];
  if (volumeParticipation.available) participationScores.push(volumeParticipation.improving ? 100 : clamp(100 * volumeParticipation.recentRatio / cfg.minParticipationRatio));
  if (tradeParticipation.available) participationScores.push(tradeParticipation.improving ? 100 : clamp(100 * tradeParticipation.recentRatio / cfg.minParticipationRatio));
  const parts = [
    [rangeScore, 0.25], [compressionScore, 0.25],
    [structureScore, 0.20], [resistanceScore, 0.20],
    [participationScores.length ? mean(participationScores) : null, 0.10]
  ].filter(([score]) => score !== null);
  const weight = parts.reduce((sum, [, w]) => sum + w, 0);
  const score = weight > 0 ? parts.reduce((sum, [partScore, w]) => sum + partScore * w, 0) / weight : null;
  const compressionConfirmed = (atrRatio !== null && atrRatio <= cfg.maxAtrRatio) ||
    (bollingerWidthRatio !== null && bollingerWidthRatio <= cfg.maxBollingerWidthRatio);
  const coreConditions = {
    narrow_base: baseRangePct !== null && baseRangePct <= cfg.maxBaseRangePct,
    volatility_compression: compressionConfirmed,
    support_structure: supportConfirmed,
    resistance_proximity: nearResistance
  };
  const candidate = Object.values(coreConditions).filter(Boolean).length >= 2 ||
    (coreConditions.narrow_base && coreConditions.volatility_compression && coreConditions.support_structure) ||
    (coreConditions.narrow_base && coreConditions.support_structure && coreConditions.resistance_proximity);
  const failedConditions = Object.entries(coreConditions).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    symbol: key, layer_visited: true, evaluated: true, scanned: true, scanned_at: at,
    source, data_age_ms: age, latest_candle_close_time_ms: last.closeTime,
    result: candidate ? 'LIGHT_CANDIDATE' : 'LIGHT_REJECTED',
    reason: candidate ? 'LIGHT_FEATURES_RANK_ONLY' : 'INSUFFICIENT_LIGHT_CONFLUENCE',
    rejection_reason: candidate ? null : (failedConditions[0] || 'INSUFFICIENT_LIGHT_CONFLUENCE'),
    candidate, candidate_score: score === null ? null : Number(score.toFixed(4)), light_rank: null, rank_basis: 'LIGHT_EVIDENCE', candidate_rank: null,
    closed_candles_only: true, future_candles_excluded: normalized.futureExcluded,
    metrics: {
      bars_used: rows.length,
      last_candle_close_time_ms: last.closeTime,
      base_range_pct: baseRangePct,
      atr_ratio: atrRatio,
      bollinger_width_ratio: bollingerWidthRatio,
      higher_lows: higherLows,
      stable_support: stableSupport,
      support_undercut_pct: supportUndercutPct,
      resistance_distance_pct: resistanceDistancePct,
      volume_participation: volumeParticipation,
      trade_count_participation: tradeParticipation,
      core_conditions: coreConditions,
      optional_participation_available: volumeParticipation.available || tradeParticipation.available
    },
    details: dataDetails
  };
}

function insufficient(symbol, series, now, reason, details = {}) {
  const candles = Array.isArray(series?.candles) ? series.candles : [];
  const lastClosed = candles.filter(x => x?.closed === true && KNOWN(x.closeTime) && Number(x.closeTime) <= now)
    .sort((a, b) => Number(a.closeTime) - Number(b.closeTime)).at(-1) || null;
  return {
    symbol, layer_visited: true, evaluated: false, scanned: false, scanned_at: now,
    source: String(series?.source || lastClosed?.source || 'NO_CACHE'),
    data_age_ms: lastClosed ? Math.max(0, now - Number(lastClosed.closeTime)) : null,
    latest_candle_close_time_ms: lastClosed?.closeTime ?? null,
    result: 'DATA_INSUFFICIENT', reason, rejection_reason: reason,
    candidate: false, candidate_score: null, light_rank: null, rank_basis: 'NO_VALID_LIGHT_DATA', candidate_rank: null,
    closed_candles_only: true, future_candles_excluded: Number(details.futureExcluded || 0),
    metrics: null, details
  };
}

/**
 * Every eligible symbol is audited once. Candidate selection is a prefilter,
 * not an alert decision. Exceptional and rotation lanes are independent of
 * light score, so cold-cache symbols can still reach Micro for cache seeding.
 */
export class MarketWideLightScan {
  constructor({config = {}, clock = () => Date.now()} = {}) {
    this.config = {...MARKET_WIDE_LIGHT_SCAN_DEFAULTS, ...config};
    this.clock = clock;
    this.lastCandidateCycleBySymbol = new Map();
  }

  scan({
    eligible = [], getSeries = () => null, now = this.clock(), cycle = 0,
    isExceptional = () => false, lastMicroScannedAt = () => null
  } = {}) {
    const at = Number(now), cycleNumber = Math.max(0, Math.trunc(Number(cycle) || 0));
    const uniqueRows = [], duplicateSymbols = [];
    const seen = new Set();
    for (const row of Array.isArray(eligible) ? eligible : []) {
      const symbol = symbolOf(row);
      if (!symbol) continue;
      if (seen.has(symbol)) { duplicateSymbols.push(symbol); continue; }
      seen.add(symbol); uniqueRows.push(row);
    }
    const eligibleTotal = uniqueRows.length;
    const maxSymbols = Math.max(1, Math.trunc(Number(this.config.maxEligibleSymbols) || 1200));
    if (eligibleTotal > maxSymbols) throw new Error('MARKET_WIDE_LIGHT_ELIGIBLE_LIMIT_EXCEEDED');

    const audit = new Map();
    const evaluated = [];
    const exceptional = [];
    for (const row of uniqueRows) {
      const symbol = symbolOf(row);
      const series = getSeries(symbol);
      const result = evaluateMarketWideLightCandidate({symbol, series, now: at, config: this.config});
      const exceptionalFlag = Boolean(isExceptional(row));
      const microAtRaw = lastMicroScannedAt(symbol);
      result.exceptional_priority = exceptionalFlag;
      result.last_micro_scanned_at = KNOWN(microAtRaw) ? Number(microAtRaw) : null;
      result.last_light_candidate_cycle = this.lastCandidateCycleBySymbol.get(symbol) ?? null;
      result.candidate_selected = false;
      result.candidate_selection_reason = null;
      audit.set(symbol, result);
      if (result.evaluated) evaluated.push({row, result, symbol});
      if (exceptionalFlag) exceptional.push({row, result, symbol});
    }

    const limit = Math.min(eligibleTotal, Math.max(1, Math.trunc(Number(this.config.candidateLimit) || 48)));
    const rotationReserve = Math.min(Math.max(0, Math.trunc(Number(this.config.rotationReserve) || 0)), Math.max(0, limit - 1));
    const selected = [], selectedSymbols = new Set();
    const add = (item, reason) => {
      if (!item || selected.length >= limit || selectedSymbols.has(item.symbol)) return false;
      selectedSymbols.add(item.symbol);
      selected.push({...item, selectionReason: reason});
      const entry = audit.get(item.symbol);
      if (entry) {
        entry.candidate_selected = true;
        entry.candidate_selection_reason = reason;
      }
      return true;
    };
    const lastMicro = item => item.result.last_micro_scanned_at;
    const lastCandidate = item => this.lastCandidateCycleBySymbol.get(item.symbol) ?? -Infinity;
    const fairOrder = (a, b) =>
      Number(b.result.exceptional_priority) - Number(a.result.exceptional_priority) ||
      Number(lastMicro(a) !== null) - Number(lastMicro(b) !== null) ||
      (lastMicro(a) ?? -Infinity) - (lastMicro(b) ?? -Infinity) ||
      lastCandidate(a) - lastCandidate(b) ||
      a.symbol.localeCompare(b.symbol);

    const exceptionLimit = Math.min(
      exceptional.length,
      Math.max(0, limit - rotationReserve),
      Math.max(1, Math.min(4, Math.floor(limit * 0.2)))
    );
    for (const item of [...exceptional].sort(fairOrder)) {
      if (selected.filter(row => row.selectionReason === 'EXCEPTIONAL_PRESERVED').length >= exceptionLimit) break;
      add(item, 'EXCEPTIONAL_PRESERVED');
    }

    const rotationCount = Math.min(rotationReserve, Math.max(0, limit - selected.length));
    const scoreLimit = Math.max(0, limit - rotationReserve);
    const ranked = [...evaluated].sort((a, b) =>
      Number(b.result.candidate) - Number(a.result.candidate) ||
      Number(b.result.candidate_score ?? -1) - Number(a.result.candidate_score ?? -1) ||
      Number(b.result.metrics?.optional_participation_available) - Number(a.result.metrics?.optional_participation_available) ||
      fairOrder(a, b));
    for (const item of ranked) {
      if (selected.length >= scoreLimit) break;
      add(item, item.result.candidate ? 'LIGHT_SCORE_CANDIDATE' : 'LIGHT_SCORE_FILL');
    }
    ranked.forEach((item, index) => {
      const entry = audit.get(item.symbol);
      if (entry) { entry.light_rank = index + 1; entry.rank_basis = 'LIGHT_EVIDENCE'; }
    });
    const rotationPool = [...uniqueRows].map(row => {
      const symbol = symbolOf(row);
      return {row, symbol, result: audit.get(symbol), _priority: 0};
    }).sort(fairOrder);
    rotationPool.forEach((item, index) => {
      const entry = audit.get(item.symbol);
      if (entry && entry.light_rank === null) {
        entry.light_rank = ranked.length + index + 1;
        entry.rank_basis = item.result?.evaluated ? 'LIGHT_SCORE_FALLBACK' : 'FAIR_ROTATION_NO_VALID_LIGHT_DATA';
      }
    });
    for (const item of rotationPool) {
      if (selected.length >= limit) break;
      add(item, item.result?.evaluated ? 'FAIR_ROTATION_VALID_DATA' : 'FAIR_ROTATION_CACHE_WARMUP');
    }
    for (const item of ranked) {
      if (selected.length >= limit) break;
      add(item, 'LIGHT_RANK_FILL');
    }

    selected.forEach((item, index) => {
      const entry = audit.get(item.symbol);
      if (entry) entry.candidate_rank = index + 1;
      this.lastCandidateCycleBySymbol.set(item.symbol, cycleNumber);
    });
    const evaluatedTotal = evaluated.length;
    const validCandidateTotal = evaluated.filter(item => item.result.candidate).length;
    const minimumReady = Math.max(1, Math.trunc(Number(this.config.minimumReadyCandidates) || 24));
    const coverageReady = eligibleTotal > 0 && evaluatedTotal === eligibleTotal;
    const selectedExceptional = selected.filter(item => item.selectionReason === 'EXCEPTIONAL_PRESERVED').length;
    const summary = {
      eligible_total: eligibleTotal,
      duplicate_symbol_total: duplicateSymbols.length,
      duplicate_symbols: [...new Set(duplicateSymbols)],
      evaluated_total: evaluatedTotal,
      not_evaluated_total: eligibleTotal - evaluatedTotal,
      fresh_cache_coverage_ratio: eligibleTotal ? evaluatedTotal / eligibleTotal : 0,
      stale_total: [...audit.values()].filter(item => item.reason === 'STALE_CLOSED_5M_CACHE').length,
      invalid_total: [...audit.values()].filter(item => item.reason === 'INVALID_CLOSED_CANDLE' || item.reason === 'CLOSED_CANDLE_SEQUENCE_HAS_GAPS').length,
      light_candidate_total: validCandidateTotal,
      micro_candidate_pool_total: selected.length,
      rotation_reserve_configured: rotationReserve,
      exceptional_preserved_total: selectedExceptional,
      cache_coverage_ready: coverageReady,
      selection_mode: coverageReady ? 'MARKET_WIDE_CANDIDATE_POOL' : 'BOOTSTRAP_FULL_UNIVERSE',
      candidate_to_micro_total: null,
      candidate_to_deep_total: null,
      micro_pre_expansion_total: null,
      deep_pre_expansion_total: null,
      scan_duration_ms: null,
      binance_rest_calls_added_by_light_scan: 0
    };
    const candidateRows = selected.map(item => ({
      ...item.row,
      _marketWideLightScan: audit.get(item.symbol),
      _marketWideLightScore: item.result?.candidate_score ?? null,
      _marketWideLightFallback: item.result?.evaluated !== true,
      _marketWideLightSelectionReason: item.selectionReason,
      _marketWideLightRank: audit.get(item.symbol)?.light_rank ?? null,
      _marketWideLightPoolRank: audit.get(item.symbol)?.candidate_rank ?? null
    }));
    return {
      summary, audit, candidateRows,
      candidateSymbols: selected.map(item => item.symbol),
      selected, uniqueRows, eligibleTotal, evaluatedTotal,
      coverageReady, scannedAt: at, cycle: cycleNumber
    };
  }
}
