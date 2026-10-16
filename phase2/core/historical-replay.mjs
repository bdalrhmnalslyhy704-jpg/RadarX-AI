const MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * MINUTE_MS;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function validCandle(c, endTime = Infinity) {
  const openTime = finite(c?.openTime), closeTime = finite(c?.closeTime);
  const open = finite(c?.open), high = finite(c?.high), low = finite(c?.low), close = finite(c?.close);
  const volume = finite(c?.volume), quoteVolume = finite(c?.quoteVolume), tradeCount = finite(c?.tradeCount);
  if (c?.closed === false || openTime === null || closeTime === null || closeTime > endTime ||
      openTime > closeTime || closeTime < openTime || closeTime > Date.now() + 60_000 ||
      open === null || high === null || low === null || close === null || volume === null ||
      open <= 0 || close <= 0 || low <= 0 || high < low || high < open || high < close ||
      low > open || low > close || volume < 0) return null;
  return {
    ...c, openTime, closeTime, open, high, low, close, volume,
    quoteVolume: quoteVolume === null ? null : Math.max(0, quoteVolume),
    tradeCount: tradeCount === null ? null : Math.max(0, tradeCount),
    closed: true
  };
}
export function normalizeHistoricalCandles(rows, {endTime = Infinity} = {}) {
  const byOpen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const candle = validCandle(row, endTime);
    if (!candle) continue;
    const previous = byOpen.get(candle.openTime);
    if (!previous || candle.closeTime > previous.closeTime) byOpen.set(candle.openTime, candle);
  }
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Aggregate only groups with all five contiguous closed 1m candles. */
export function aggregateFiveMinuteCandles(oneMinuteRows) {
  const rows = normalizeHistoricalCandles(oneMinuteRows);
  const groups = new Map();
  for (const candle of rows) {
    const start = Math.floor(candle.openTime / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(candle);
  }
  const out = [];
  for (const [start, unsorted] of groups) {
    const group = unsorted.sort((a, b) => a.openTime - b.openTime);
    if (group.length !== 5) continue;
    let complete = true;
    for (let i = 0; i < 5; i++) {
      if (group[i].openTime !== start + i * MINUTE_MS ||
          (i > 0 && group[i].openTime !== group[i - 1].openTime + MINUTE_MS)) {
        complete = false; break;
      }
    }
    if (!complete) continue;
    const first = group[0], last = group[4];
    out.push({
      openTime: first.openTime, closeTime: last.closeTime,
      open: first.open, high: Math.max(...group.map(x => x.high)),
      low: Math.min(...group.map(x => x.low)), close: last.close,
      volume: group.reduce((sum, x) => sum + x.volume, 0),
      quoteVolume: group.every(x => Number.isFinite(x.quoteVolume))
        ? group.reduce((sum, x) => sum + x.quoteVolume, 0) : null,
      tradeCount: group.every(x => Number.isFinite(x.tradeCount))
        ? group.reduce((sum, x) => sum + x.tradeCount, 0) : null,
      takerBuyBaseVolume: group.every(x => Number.isFinite(Number(x.takerBuyBaseVolume)))
        ? group.reduce((sum, x) => sum + Number(x.takerBuyBaseVolume), 0) : null,
      takerBuyQuoteVolume: group.every(x => Number.isFinite(Number(x.takerBuyQuoteVolume)))
        ? group.reduce((sum, x) => sum + Number(x.takerBuyQuoteVolume), 0) : null,
      closed: true, source: "AGGREGATED_CLOSED_1M_CANDLES"
    });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
}

function normalizeTrades(rows, endTime) {
  const byId = new Map();
  let fallback = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = finite(row?.T ?? row?.time ?? row?.timestamp);
    const price = finite(row?.p ?? row?.price), quantity = finite(row?.q ?? row?.quantity);
    const maker = row?.m ?? row?.buyerIsMaker;
    if (at === null || at > endTime || price === null || price <= 0 ||
        quantity === null || quantity <= 0 ||
        !(typeof maker === "boolean" || maker === 0 || maker === 1 || maker === "0" ||
          maker === "1" || maker === "true" || maker === "false")) continue;
    const id = finite(row?.a ?? row?.id);
    const key = id === null ? ("time:" + at + ":" + fallback++) : ("id:" + id);
    if (byId.has(key)) continue;
    byId.set(key, {...row, T: at, p: price, q: quantity, m: maker});
  }
  return [...byId.values()].sort((a, b) => a.T - b.T || (finite(a.a) ?? 0) - (finite(b.a) ?? 0));
}
function derivedTicker(history, symbol, at) {
  if (!history.length) return {symbol, lastPrice: null, priceChange24h: null, quoteVolume24h: null, tradeCount24h: null};
  const nowPrice = history[history.length - 1].close;
  const cutoff = at - 24 * 60 * MINUTE_MS;
  const day = history.filter(x => x.openTime >= cutoff && x.closeTime <= at);
  const first = day[0] ?? history[0];
  const q = day.map(x => x.quoteVolume);
  return {
    symbol, lastPrice: nowPrice,
    priceChange24h: first.open > 0 ? (nowPrice - first.open) / first.open * 100 : null,
    quoteVolume24h: q.length && q.every(Number.isFinite) ? q.reduce((s, x) => s + x, 0) : null,
    tradeCount24h: day.every(x => Number.isFinite(x.tradeCount)) ? day.reduce((s, x) => s + x.tradeCount, 0) : null,
    ticker_is_derived_from_closed_candles: true
  };
}
function outcomeAtPrice(futureRows, target, until) {
  const row = futureRows.find(x => x.openTime <= until && x.high >= target);
  return row ? row.closeTime : null;
}
function isContiguousHorizonObserved(candles,index,decisionAt,horizonMs,observationEndTime){
  const targetAt=decisionAt+horizonMs;
  if(horizonMs<=0)return true;
  if(observationEndTime<targetAt-1)return false;
  let expectedOpen=Number(candles[index]?.openTime)+MINUTE_MS;
  if(!Number.isFinite(expectedOpen))return false;
  for(let i=index+1;i<candles.length;i++){
    const candle=candles[i];
    if(candle.closeTime>targetAt-1)return false;
    if(candle.openTime!==expectedOpen)return false;
    expectedOpen=candle.openTime+MINUTE_MS;
    if(candle.closeTime>=targetAt-1)return true;
  }
  return false;
}
function adverseExcursionBeforeTarget(futureRows,entryPrice,targetPrice,until){
  const inHorizon=futureRows.filter(row=>row.openTime<=until);
  const hitIndex=inHorizon.findIndex(row=>row.high>=targetPrice);
  // Include the target candle low conservatively because OHLC does not reveal
  // whether the high or low happened first inside the same one-minute candle.
  const rows=hitIndex>=0?inHorizon.slice(0,hitIndex+1):inHorizon;
  if(!rows.length||!(entryPrice>0))return null;
  const lowest=Math.min(...rows.map(row=>row.low));
  return Number(((lowest-entryPrice)/entryPrice*100).toFixed(4));
}
function reasonsFrom(result) {
  const values = result?.reason_codes ?? result?.notificationGate?.failures ??
    result?.notification_gate?.failures ?? result?.gate?.failures ??
    result?.alert?.notification_gate?.failures ?? result?.alert?.risk_flags ?? [];
  return [...new Set((Array.isArray(values) ? values : []).map(x => String(x).slice(0, 120)))].slice(0, 20);
}
function stageFrom(result) {
  return result?.stage ?? result?.stage_observed ?? result?.alert?.potential_label ??
    result?.alert?.strong_move?.stage ?? result?.alert?.stage ?? "UNKNOWN";
}

/**
 * Event-by-event replay. Future candles are used only to score labeled outcomes after the
 * evaluator has returned; they are never passed to the evaluator or used in a gate.
 */
export function runHistoricalReplay({
  symbol, oneMinuteCandles, aggTrades = [], startTime, endTime, evaluate,
  tradeCoverageComplete = false, tradeCoverage = null, allowCandleOnlyFallback = false,
  alertCooldownMs = 12 * 60 * 1000, outcomeHorizonMs = 24 * 60 * 60 * 1000,
  outcomeEndTime = null
} = {}) {
  const start = finite(startTime), end = finite(endTime);
  if (!/^[A-Z0-9]{5,20}$/.test(String(symbol ?? "").toUpperCase())) throw new Error("INVALID_SYMBOL");
  if (start === null || end === null || end <= start) throw new Error("INVALID_REPLAY_WINDOW");
  if (typeof evaluate !== "function") throw new Error("REPLAY_EVALUATOR_REQUIRED");
  if (end > Date.now() + MINUTE_MS) throw new Error("REPLAY_END_IN_FUTURE");
  if (end - start > 7 * 24 * 60 * MINUTE_MS) throw new Error("REPLAY_WINDOW_EXCEEDS_7_DAYS");
  const observationEnd = finite(outcomeEndTime) ?? end;
  if (observationEnd < end) throw new Error("OUTCOME_OBSERVATION_END_BEFORE_REPLAY_END");
  if (observationEnd > Date.now() + MINUTE_MS) throw new Error("OUTCOME_OBSERVATION_END_IN_FUTURE");
  if (observationEnd - end > 7 * 24 * 60 * MINUTE_MS) throw new Error("OUTCOME_OBSERVATION_WINDOW_EXCEEDS_7_DAYS");
  const sym = String(symbol).toUpperCase();
  const candles = normalizeHistoricalCandles(oneMinuteCandles, {endTime: observationEnd});
  const five = aggregateFiveMinuteCandles(candles).filter(x => x.closeTime <= observationEnd);
  const trades = normalizeTrades(aggTrades, observationEnd);
  // Missing aggregate-trade history must remain explicitly partial. In the opt-in
  // fallback mode, evaluate only verified closed candles and never substitute fake trades.
  const candleOnlyFallback = !tradeCoverageComplete && allowCandleOnlyFallback === true && candles.length > 0;
  const activeIndices = [];
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].closeTime >= start && candles[i].closeTime <= end) activeIndices.push(i);
  }
  const windowStartRow = candles.find(x => x.openTime >= start && x.closeTime <= end) ?? null;
  const windowBaseline = finite(windowStartRow?.open);
  const actual50CandleCloseAt = windowBaseline === null ? null : candles.find(x =>
    x.openTime >= start && x.closeTime <= end && x.high >= windowBaseline * 1.5)?.closeTime ?? null;
  const actual70CandleCloseAt = windowBaseline === null ? null : candles.find(x =>
    x.openTime >= start && x.closeTime <= end && x.high >= windowBaseline * 1.7)?.closeTime ?? null;
  const actual5CandleCloseAt = windowBaseline === null ? null : candles.find(x =>
    x.openTime >= start && x.closeTime <= end && x.high >= windowBaseline * 1.05)?.closeTime ?? null;
  const actual15CandleCloseAt = windowBaseline === null ? null : candles.find(x =>
    x.openTime >= start && x.closeTime <= end && x.high >= windowBaseline * 1.15)?.closeTime ?? null;
  // Exact crossing times come from public aggTrades, not minute-candle close times.
  // Incomplete trade history makes the exact timestamp unknown rather than guessed.
  const firstTradeAtTarget = target => trades.find(x =>
    x.T >= start && x.T <= end && Number(x.p) >= target)?.T ?? null;
  const actual50At = windowBaseline === null || !tradeCoverageComplete
    ? null : firstTradeAtTarget(windowBaseline * 1.5);
  const actual70At = windowBaseline === null || !tradeCoverageComplete
    ? null : firstTradeAtTarget(windowBaseline * 1.7);
  const actual5At = windowBaseline === null || !tradeCoverageComplete
    ? null : firstTradeAtTarget(windowBaseline * 1.05);
  const actual15At = windowBaseline === null || !tradeCoverageComplete
    ? null : firstTradeAtTarget(windowBaseline * 1.15);
  const targetCrossingSource = !tradeCoverageComplete
    ? "UNAVAILABLE_INCOMPLETE_TRADE_COVERAGE" : "BINANCE_PUBLIC_AGG_TRADES";
  const actual50Alignment = !tradeCoverageComplete ? "TRADE_COVERAGE_INCOMPLETE" :
    actual50CandleCloseAt !== null && actual50At === null ? "CANDLE_TRADE_CROSSING_MISMATCH" :
    actual50At !== null ? "BINANCE_AGGTRADE_TIMESTAMP" : "NOT_REACHED";
  const actual70Alignment = !tradeCoverageComplete ? "TRADE_COVERAGE_INCOMPLETE" :
    actual70CandleCloseAt !== null && actual70At === null ? "CANDLE_TRADE_CROSSING_MISMATCH" :
    actual70At !== null ? "BINANCE_AGGTRADE_TIMESTAMP" : "NOT_REACHED";
  const cooldown = Math.max(0, finite(alertCooldownMs) ?? 0);
  const horizon = Math.max(0, finite(outcomeHorizonMs) ?? 0);
  const rows = [];
  let priorAcceptedAt = -Infinity;
  let fiveIndex = 0;
  let tradeIndex = 0;
  let acceptedCount = 0, rejectedCount = 0;

  for (const index of activeIndices) {
    const candle = candles[index], at = candle.closeTime + 1;
    while (fiveIndex < five.length && five[fiveIndex].closeTime <= at) fiveIndex++;
    while (tradeIndex < trades.length && trades[tradeIndex].T < Math.floor(at / 3000) * 3000 - 60_000) tradeIndex++;
    const available1m = candles.slice(Math.max(0, index - 119), index + 1);
    const tickerHistory = candles.slice(Math.max(0, index - 1440), index + 1);
    const fiveEnd = five.slice(Math.max(0, fiveIndex - 60), fiveIndex);
    const boundary = Math.floor(at / 3000) * 3000;
    const tradeWindow = [];
    for (let t = tradeIndex; t < trades.length && trades[t].T < boundary; t++) {
      if (trades[t].T >= boundary - 60_000) tradeWindow.push(trades[t]);
    }
    const ticker = derivedTicker(tickerHistory, sym, at);
    let raw = null;
    let reasons = [];
    let accepted = false;
    let failure = null;
    if (!tradeCoverageComplete && !candleOnlyFallback) {
      reasons = ["AGG_TRADES_HISTORY_INCOMPLETE"];
      failure = "AGG_TRADES_HISTORY_INCOMPLETE";
    } else {
      try {
        raw = awaitlessEvaluate(evaluate, {
          symbol: sym, now: at, oneMinute: available1m, fiveMinute: fiveEnd,
          ticker, aggTrades: tradeCoverageComplete ? tradeWindow : [], currentCandle: candle,
          source: "BINANCE_PUBLIC_HISTORICAL_REPLAY",
          dataPolicy: {
            closedCandlesOnly: true, allowFutureData: false, currentCloseTime: at,
            tradeCoverageComplete: Boolean(tradeCoverageComplete),
            replayMode: candleOnlyFallback ? "CANDLE_ONLY_FALLBACK" : "FULL_TRADE"
          }
        });
        const gate = raw?.notificationGate ?? raw?.notification_gate ?? raw?.gate;
        accepted = Boolean(raw?.accepted ?? raw?.eligible ?? gate?.eligible === true);
        reasons = reasonsFrom(raw);
        if (!accepted && !reasons.length) reasons = ["GATE_REJECTED_NO_REASON_EXPOSED"];
      } catch (error) {
        accepted = false;
        failure = String(error?.message ?? error).slice(0, 200);
        reasons = ["REPLAY_EVALUATOR_ERROR"];
      }
    }
    if (accepted && at - priorAcceptedAt < cooldown) {
      accepted = false;
      reasons = [...new Set([...reasons, "SYMBOL_ALERT_COOLDOWN"])];
    }
    if (accepted) { priorAcceptedAt = at; acceptedCount++; }
    else rejectedCount++;

    // Outcome-only fields are calculated separately, after evaluate() has finished.
    const horizonEndAt = at + horizon;
    const forwardRows = candles.slice(index + 1).filter(x => x.closeTime <= Math.min(horizonEndAt,observationEnd));
    const horizonObserved = isContiguousHorizonObserved(candles,index,at,horizon,observationEnd);
    const close = candle.close;
    const f5 = outcomeAtPrice(forwardRows, close * 1.05, horizonEndAt);
    const f15 = outcomeAtPrice(forwardRows, close * 1.15, horizonEndAt);
    const f50 = outcomeAtPrice(forwardRows, close * 1.5, horizonEndAt);
    const f70 = outcomeAtPrice(forwardRows, close * 1.7, horizonEndAt);
    const maxHigh = forwardRows.reduce((best, x) => Math.max(best, x.high), close);
    const minLow = forwardRows.reduce((best, x) => Math.min(best, x.low), close);
    const targetClose = horizonObserved ? forwardRows.findLast(x=>x.closeTime>=horizonEndAt-1)?.close : null;
    const maxAdversePct = horizonObserved&&close>0 ? Number(((minLow-close)/close*100).toFixed(4)) : null;
    const pre5DrawdownPct = (f5!==null||horizonObserved)
      ? adverseExcursionBeforeTarget(forwardRows,close,close*1.05,horizonEndAt) : null;
    const alert = raw?.alert ?? null;
    const strong = alert?.strong_move ?? {};
    const elite = alert?.elite_gate ?? raw?.eliteGate ?? {};
    const notification = raw?.notificationGate ?? raw?.notification_gate ?? raw?.gate ?? alert?.notification_gate ?? {};
    const metrics = strong?.metrics ?? {};
    const rejectionGroup = accepted ? "ACCEPTED" :
      (!tradeCoverageComplete && !candleOnlyFallback) ? "HISTORICAL_TRADE_COVERAGE_INCOMPLETE" :
      alert?.eligible === false ? "STRONG_MOVE_CORE_GATE" :
      elite?.eligible === false ? "ELITE_CONFLUENCE_GATE" :
      notification?.eligible === false ? "NOTIFICATION_GATE" :
      failure ? "REPLAY_EVALUATOR_ERROR" : "REJECTED_OTHER";
    rows.push({
      symbol: sym, timestamp: at, timestamp_iso: new Date(at).toISOString(),
      source_candle_open_time: candle.openTime, source_candle_close_at: candle.closeTime,
      price_at_decision: close, last_price_at_observation: ticker.lastPrice,
      price_change_24h_pct: finite(ticker.priceChange24h),
      stage_observed: String(stageFrom(raw)).slice(0, 80),
      strong_move_stage: strong?.stage ?? null,
      core_trigger_diagnostics: strong?.trigger_diagnostics ?? null,
      decision: accepted ? "ACCEPTED" : "REJECTED",
      accepted_mode:String(raw?.accepted_mode ?? alert?.notification_mode ?? (accepted ? "STRICT" : "NONE")),
      replay_data_mode:tradeCoverageComplete?'FULL_TRADE':(candleOnlyFallback?'CANDLE_ONLY_FALLBACK':'BLOCKED_INCOMPLETE'),
      rejection_group: rejectionGroup, reason_codes: reasons,
      strict_gate_failures:Array.isArray(raw?.strict_gate_failures)?raw.strict_gate_failures.slice(0,20):[],
      early_warning:raw?.early_warning??alert?.early_warning??null,
      early_warning_score:finite(raw?.early_warning?.score??alert?.early_warning?.score),
      score: finite(raw?.score ?? alert?.opportunity_score ?? strong?.score),
      candidate_eligible: typeof alert?.eligible === "boolean" ? alert.eligible : null,
      core_trigger_eligible: typeof strong?.eligible === "boolean" ? strong.eligible : null,
      core_reasons: Array.isArray(strong?.reasons) ? strong.reasons.slice(0, 12) : [],
      risk_flags: Array.isArray(alert?.risk_flags) ? alert.risk_flags.slice(0, 16) : [],
      elite_gate: {
        eligible: typeof elite?.eligible === "boolean" ? elite.eligible : null,
        score: finite(elite?.score), confirmations: finite(elite?.confirmations),
        category_hits: finite(elite?.category_hits),
        risk_flags: Array.isArray(elite?.risk_flags) ? elite.risk_flags.slice(0, 16) : []
      },
      notification_gate: {
        eligible: typeof notification?.eligible === "boolean" ? notification.eligible : null,
        failures: Array.isArray(notification?.failures) ? notification.failures.slice(0, 20) : reasons
      },
      signal_metrics: {
        return_1m_pct: finite(metrics?.return_1m),
        return_3m_pct: finite(metrics?.return_3m),
        acceleration: finite(metrics?.acceleration),
        volume_ratio: finite(metrics?.volume_ratio),
        trade_ratio: finite(metrics?.trade_ratio),
        taker_buy_ratio_1m_3m: finite(metrics?.taker_buy_ratio),
        taker_buy_ratio_3s: finite(metrics?.three_second_taker_buy_ratio),
        taker_buy_pressure_confirmed: typeof metrics?.taker_buy_pressure_confirmed === "boolean" ? metrics.taker_buy_pressure_confirmed : null,
        independent_confirmations: finite(metrics?.independent_confirmations),
        flash_score: finite(metrics?.flash_score),
        flash_confirmations: finite(metrics?.flash_confirmations),
        liquidity_acceleration_3m: finite(metrics?.liquidity_acceleration?.three_minute_acceleration),
        liquidity_acceleration_score: finite(metrics?.liquidity_acceleration?.score),
        breakout_up: typeof metrics?.breakout_up === "boolean" ? metrics.breakout_up : null
      },
      observed_price_change_24h_pct: finite(ticker.priceChange24h),
      liquidity_acceleration: finite(raw?.liquidity_acceleration ??
        alert?.strong_move?.metrics?.liquidity_acceleration?.three_minute_acceleration ??
        alert?.metrics?.liquidity_acceleration?.three_minute_acceleration),
      used_1m_candles: available1m.length, used_5m_candles: fiveEnd.length,
      input_max_candle_close_at: Math.max(...available1m.map(x => x.closeTime), ...fiveEnd.map(x => x.closeTime)),
      trade_window: {from: boundary - 60_000, to_exclusive: boundary, rows: tradeWindow.length, coverage_complete: Boolean(tradeCoverageComplete)},
      failure,
      outcome: {
        is_future_data_for_scoring: false,
        horizon_ms: horizon, horizon_observed: horizonObserved,
        forward_max_upside_pct_from_decision: close > 0 ? Number(((maxHigh - close) / close * 100).toFixed(4)) : null,
        forward_max_drawdown_pct_from_decision:maxAdversePct,
        max_adverse_excursion_pct_from_decision:maxAdversePct,
        max_adverse_excursion_before_moderate_target_pct:pre5DrawdownPct,
        forward_return_pct_at_horizon:targetClose!==null&&close>0?Number(((targetClose-close)/close*100).toFixed(4)):null,
        observation_end_time:observationEnd,
        first_future_hit_5pct_at:f5,
        first_future_hit_15pct_at:f15,
        first_future_hit_50pct_at: f50,
        first_future_hit_70pct_at: f70,
        minutes_to_moderate_target:f5===null?null:Math.round((f5-at)/MINUTE_MS*100)/100,
        minutes_to_strong_target:f15===null?null:Math.round((f15-at)/MINUTE_MS*100)/100,
        minutes_to_future_50pct: f50 === null ? null : Math.round((f50 - at) / MINUTE_MS * 100) / 100,
        minutes_to_future_70pct: f70 === null ? null : Math.round((f70 - at) / MINUTE_MS * 100) / 100,
        window_baseline_price: windowBaseline,
        actual_window_5pct_at:actual5At,actual_window_15pct_at:actual15At,
        actual_window_5pct_candle_close_at:actual5CandleCloseAt,
        actual_window_15pct_candle_close_at:actual15CandleCloseAt,
        actual_window_5pct_timestamp_source:!tradeCoverageComplete?'UNAVAILABLE_INCOMPLETE_TRADE_COVERAGE':'BINANCE_PUBLIC_AGG_TRADES',
        actual_window_15pct_timestamp_source:!tradeCoverageComplete?'UNAVAILABLE_INCOMPLETE_TRADE_COVERAGE':'BINANCE_PUBLIC_AGG_TRADES',
        actual_window_50pct_at: actual50At, actual_window_70pct_at: actual70At,
        actual_window_50pct_candle_close_at: actual50CandleCloseAt,
        actual_window_70pct_candle_close_at: actual70CandleCloseAt,
        actual_window_50pct_timestamp_source: targetCrossingSource,
        actual_window_70pct_timestamp_source: targetCrossingSource,
        actual_window_50pct_alignment: actual50Alignment,
        actual_window_70pct_alignment: actual70Alignment,
        minutes_before_actual_window_50pct: actual50At === null ? null : Math.round((actual50At - at) / MINUTE_MS * 100) / 100,
        minutes_before_actual_window_70pct: actual70At === null ? null : Math.round((actual70At - at) / MINUTE_MS * 100) / 100
      }
    });
  }
  const firstAcceptedAt=rows.find(x=>x.decision==="ACCEPTED")?.timestamp??null;
  const firstEarlyWarningAcceptedAt=rows.find(x=>x.decision==="ACCEPTED"&&x.accepted_mode==="DYNAMIC_EARLY_WARNING")?.timestamp??null;
  const firstStrictAcceptedAt=rows.find(x=>x.decision==="ACCEPTED"&&x.accepted_mode==="STRICT")?.timestamp??null;
  const acceptedModeCounts=Object.entries(rows.filter(x=>x.decision==="ACCEPTED").reduce((counts,row)=>{
    counts[row.accepted_mode]=(counts[row.accepted_mode]||0)+1;return counts;
  },{})).map(([mode,count])=>({mode,count}));
  const firstCoreTriggerAt=rows.find(x=>x.core_trigger_eligible===true)?.timestamp??null;
  const premove50Status=!tradeCoverageComplete
    ? "TRADE_COVERAGE_INCOMPLETE"
    : actual50CandleCloseAt!==null&&actual50At===null
      ? "CANDLE_TRADE_CROSSING_MISMATCH"
      : actual50At===null
        ? "NO_PLUS_50_PERCENT_EVENT_IN_WINDOW"
        : firstAcceptedAt!==null&&firstAcceptedAt<actual50At
          ? "PREMOVE_ALERT_ACCEPTED"
          : firstCoreTriggerAt!==null&&firstCoreTriggerAt<actual50At
            ? "CORE_TRIGGER_SEEN_BUT_FINAL_GATE_BLOCKED"
            : firstCoreTriggerAt!==null
              ? "CORE_TRIGGER_AFTER_PLUS_50_PERCENT"
              : "NO_CORE_TRIGGER_BEFORE_PLUS_50_PERCENT";
  return {
    engine: "RADARX_HISTORICAL_REPLAY_V1",
    symbol: sym,
    range: {start_time: start, start_time_iso: new Date(start).toISOString(), end_time: end, end_time_iso: new Date(end).toISOString()},
    data_quality: {
      source: "BINANCE_PUBLIC_REST", real_market_data_required: true, synthetic_data_used: false,
      replay_mode: tradeCoverageComplete ? "FULL_TRADE" : (candleOnlyFallback ? "CANDLE_ONLY_FALLBACK" : "BLOCKED_INCOMPLETE"),
      candle_only_fallback_used: Boolean(candleOnlyFallback),
      closed_1m_candles: candles.length, complete_5m_candles: five.length,
      aggregate_trades: tradeCoverageComplete ? trades.length : 0, trade_coverage_complete: Boolean(tradeCoverageComplete),
      target_crossing_timestamp_source: targetCrossingSource,
      target_crossing_alignment: {plus_50:actual50Alignment,plus_70:actual70Alignment},
      trade_coverage: tradeCoverage, outcome_observation_end_time:observationEnd,
      outcome_horizon_ms:horizon, outcome_future_candles_loaded:candles.filter(x=>x.openTime>end).length,
      lookahead_guard: "evaluator receives only candles/trades timestamped before or at each decision; forward outcomes are calculated afterward"
    },
    summary: {
      replay_steps: rows.length, accepted: acceptedCount, rejected: rejectedCount,
      premove_50_status: premove50Status,
      first_accepted_at: firstAcceptedAt,
      first_early_warning_accepted_at:firstEarlyWarningAcceptedAt,
      first_strict_accepted_at:firstStrictAcceptedAt,
      accepted_mode_counts:acceptedModeCounts,
      first_core_trigger_at: firstCoreTriggerAt,
      first_candidate_eligible_at: rows.find(x => x.candidate_eligible === true)?.timestamp ?? null,
      first_elite_gate_eligible_at: rows.find(x => x.elite_gate.eligible === true)?.timestamp ?? null,
      first_observed_score_ge_86_at: rows.find(x => Number(x.score) >= 86)?.timestamp ?? null,
      maximum_score: rows.reduce((best, row) => Number.isFinite(row.score) && (best === null || row.score > best) ? row.score : best, null),
      maximum_score_at: rows.reduce((best, row) => Number.isFinite(row.score) && (!best || row.score > best.score) ? {score: row.score, timestamp: row.timestamp} : best, null)?.timestamp ?? null,
      rejection_groups: Object.entries(rows.reduce((groups, row) => {
        groups[row.rejection_group] = (groups[row.rejection_group] || 0) + 1; return groups;
      }, {})).map(([group, count]) => ({group, count})).sort((a,b) => b.count - a.count),
      core_trigger_failure_counts: Object.entries(rows.reduce((counts, row) => {
        for (const code of row.core_trigger_diagnostics?.failed_checks ?? []) counts[code] = (counts[code] || 0) + 1;
        return counts;
      }, {})).map(([code, count]) => ({code, count})).sort((a,b) => b.count - a.count),
      first_actual_window_5pct_at:actual5At,first_actual_window_15pct_at:actual15At,
      first_actual_window_5pct_candle_close_at:actual5CandleCloseAt,
      first_actual_window_15pct_candle_close_at:actual15CandleCloseAt,
      first_actual_window_50pct_at: actual50At, first_actual_window_70pct_at: actual70At,
      first_actual_window_50pct_candle_close_at:actual50CandleCloseAt,
      first_actual_window_70pct_candle_close_at:actual70CandleCloseAt,
      actual_window_50pct_timestamp_source:targetCrossingSource,
      actual_window_70pct_timestamp_source:targetCrossingSource,
      actual_window_50pct_alignment:actual50Alignment,
      actual_window_70pct_alignment:actual70Alignment,
      minutes_from_first_accepted_to_actual_50pct: rows.find(x => x.decision === "ACCEPTED") && actual50At !== null
        ? Math.round((actual50At - rows.find(x => x.decision === "ACCEPTED").timestamp) / MINUTE_MS * 100) / 100 : null,
      minutes_from_first_core_trigger_to_actual_50pct: rows.find(x => x.core_trigger_eligible === true) && actual50At !== null
        ? Math.round((actual50At - rows.find(x => x.core_trigger_eligible === true).timestamp) / MINUTE_MS * 100) / 100 : null
    },
    steps: rows,
    policy: {market: "SPOT", paper_trading: true, real_order_execution: false, confidence_score: "UNKNOWN"}
  };
}
function awaitlessEvaluate(evaluate, input) {
  const result = evaluate(input);
  if (result && typeof result.then === "function") throw new Error("REPLAY_EVALUATOR_MUST_BE_SYNCHRONOUS");
  const maxInputClose = Math.max(-Infinity, ...input.oneMinute.map(x => x.closeTime), ...input.fiveMinute.map(x => x.closeTime));
  if (maxInputClose > input.now) throw new Error("LOOKAHEAD_DATA_REJECTED");
  return result;
}
