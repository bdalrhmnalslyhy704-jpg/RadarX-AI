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
  tradeCoverageComplete = true, tradeCoverage = null,
  alertCooldownMs = 12 * 60 * 1000, outcomeHorizonMs = 24 * 60 * 60 * 1000
} = {}) {
  const start = finite(startTime), end = finite(endTime);
  if (!/^[A-Z0-9]{5,20}$/.test(String(symbol ?? "").toUpperCase())) throw new Error("INVALID_SYMBOL");
  if (start === null || end === null || end <= start) throw new Error("INVALID_REPLAY_WINDOW");
  if (typeof evaluate !== "function") throw new Error("REPLAY_EVALUATOR_REQUIRED");
  if (end > Date.now() + MINUTE_MS) throw new Error("REPLAY_END_IN_FUTURE");
  if (end - start > 7 * 24 * 60 * MINUTE_MS) throw new Error("REPLAY_WINDOW_EXCEEDS_7_DAYS");
  const sym = String(symbol).toUpperCase();
  const candles = normalizeHistoricalCandles(oneMinuteCandles, {endTime: end});
  const five = aggregateFiveMinuteCandles(candles).filter(x => x.closeTime <= end);
  const trades = normalizeTrades(aggTrades, end);
  const activeIndices = [];
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].closeTime >= start && candles[i].closeTime <= end) activeIndices.push(i);
  }
  const windowStartRow = candles.find(x => x.openTime >= start && x.closeTime <= end) ?? null;
  const windowBaseline = finite(windowStartRow?.open);
  const actual50At = windowBaseline === null ? null : candles.find(x =>
    x.openTime >= start && x.closeTime <= end && x.high >= windowBaseline * 1.5)?.closeTime ?? null;
  const actual70At = windowBaseline === null ? null : candles.find(x =>
    x.openTime >= start && x.closeTime <= end && x.high >= windowBaseline * 1.7)?.closeTime ?? null;
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
    if (!tradeCoverageComplete) {
      reasons = ["AGG_TRADES_HISTORY_INCOMPLETE"];
      failure = "AGG_TRADES_HISTORY_INCOMPLETE";
    } else {
      try {
        raw = awaitlessEvaluate(evaluate, {
          symbol: sym, now: at, oneMinute: available1m, fiveMinute: fiveEnd,
          ticker, aggTrades: tradeWindow, currentCandle: candle,
          source: "BINANCE_PUBLIC_HISTORICAL_REPLAY",
          dataPolicy: {closedCandlesOnly: true, allowFutureData: false, currentCloseTime: at}
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
    const forwardRows = candles.slice(index + 1).filter(x => x.openTime <= at + horizon);
    const horizonObserved = candles.length > index + 1 && candles[candles.length - 1].closeTime >= at + horizon;
    const close = candle.close;
    const f50 = outcomeAtPrice(forwardRows, close * 1.5, at + horizon);
    const f70 = outcomeAtPrice(forwardRows, close * 1.7, at + horizon);
    const maxHigh = forwardRows.reduce((best, x) => Math.max(best, x.high), close);
    rows.push({
      symbol: sym, timestamp: at, timestamp_iso: new Date(at).toISOString(),
      source_candle_open_time: candle.openTime, source_candle_close_at: candle.closeTime,
      price_at_decision: close, last_price_at_observation: ticker.lastPrice,
      stage_observed: String(stageFrom(raw)).slice(0, 80),
      decision: accepted ? "ACCEPTED" : "REJECTED", reason_codes: reasons,
      score: finite(raw?.score ?? raw?.alert?.opportunity_score ?? raw?.alert?.strong_move?.score),
      observed_price_change_24h_pct: finite(ticker.priceChange24h),
      liquidity_acceleration: finite(raw?.liquidity_acceleration ??
        raw?.alert?.strong_move?.metrics?.liquidity_acceleration?.three_minute_acceleration ??
        raw?.alert?.metrics?.liquidity_acceleration?.three_minute_acceleration),
      used_1m_candles: available1m.length, used_5m_candles: fiveEnd.length,
      input_max_candle_close_at: Math.max(...available1m.map(x => x.closeTime), ...fiveEnd.map(x => x.closeTime)),
      trade_window: {from: boundary - 60_000, to_exclusive: boundary, rows: tradeWindow.length, coverage_complete: Boolean(tradeCoverageComplete)},
      failure,
      outcome: {
        is_future_data_for_scoring: false,
        horizon_ms: horizon, horizon_observed: horizonObserved,
        forward_max_upside_pct_from_decision: close > 0 ? (maxHigh - close) / close * 100 : null,
        first_future_hit_50pct_at: f50,
        first_future_hit_70pct_at: f70,
        minutes_to_future_50pct: f50 === null ? null : Math.round((f50 - at) / MINUTE_MS * 100) / 100,
        minutes_to_future_70pct: f70 === null ? null : Math.round((f70 - at) / MINUTE_MS * 100) / 100,
        window_baseline_price: windowBaseline,
        actual_window_50pct_at: actual50At, actual_window_70pct_at: actual70At,
        minutes_before_actual_window_50pct: actual50At === null ? null : Math.round((actual50At - at) / MINUTE_MS * 100) / 100,
        minutes_before_actual_window_70pct: actual70At === null ? null : Math.round((actual70At - at) / MINUTE_MS * 100) / 100
      }
    });
  }
  return {
    engine: "RADARX_HISTORICAL_REPLAY_V1",
    symbol: sym,
    range: {start_time: start, start_time_iso: new Date(start).toISOString(), end_time: end, end_time_iso: new Date(end).toISOString()},
    data_quality: {
      source: "BINANCE_PUBLIC_REST", real_market_data_required: true, synthetic_data_used: false,
      closed_1m_candles: candles.length, complete_5m_candles: five.length,
      aggregate_trades: trades.length, trade_coverage_complete: Boolean(tradeCoverageComplete),
      trade_coverage: tradeCoverage, lookahead_guard: "evaluator receives only candles/trades timestamped before or at each decision; forward outcomes are calculated afterward"
    },
    summary: {
      replay_steps: rows.length, accepted: acceptedCount, rejected: rejectedCount,
      first_accepted_at: rows.find(x => x.decision === "ACCEPTED")?.timestamp ?? null,
      first_actual_window_50pct_at: actual50At, first_actual_window_70pct_at: actual70At,
      minutes_from_first_accepted_to_actual_50pct: rows.find(x => x.decision === "ACCEPTED") && actual50At !== null
        ? Math.round((actual50At - rows.find(x => x.decision === "ACCEPTED").timestamp) / MINUTE_MS * 100) / 100 : null
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
