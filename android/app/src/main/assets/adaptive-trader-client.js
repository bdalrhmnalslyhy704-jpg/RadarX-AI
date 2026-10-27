const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const COST_PCT = 0.30;

export function createPaperPortfolio(startingBalance = 10000) {
  const n = finite(startingBalance);
  const amount = n !== null && n > 0 ? n : 10000;
  return {
    version: 1,
    mode: 'PAPER_ONLY',
    enabled: false,
    starting_balance: amount,
    cash: amount,
    open_positions: [],
    closed_trades: [],
    created_at: Date.now(),
    paper_trading: true,
    real_order_execution: false
  };
}

export function buildAdaptiveLearningProfile(samples = [], { minSamples = 30, minimumBucket = 8 } = {}) {
  const rows = (Array.isArray(samples) ? samples : []).filter(row =>
    row && ['UP', 'DOWN', 'FLAT'].includes(row.outcome) && row.features && typeof row.features === 'object');
  const wins = rows.filter(row => row.outcome === 'UP').length;
  const baseline = (wins + 2) / (rows.length + 4);
  const matchers = {
    volume: row => finite(row.features.volume_ratio) !== null && Number(row.features.volume_ratio) >= 1.5,
    buyer_flow: row => finite(row.features.taker_buy_ratio) !== null && Number(row.features.taker_buy_ratio) >= 0.52,
    structure: row => row.features.higher_low === true || row.features.breakout_above_prior_high === true,
    compression: row => finite(row.features.compression_ratio) !== null && Number(row.features.compression_ratio) <= 0.8
  };
  const buckets = {};
  const raw = {};
  for (const [name, match] of Object.entries(matchers)) {
    const subset = rows.filter(match);
    const bucketWins = subset.filter(row => row.outcome === 'UP').length;
    const rate = (bucketWins + 2) / (subset.length + 4);
    buckets[name] = { samples: subset.length, wins: bucketWins, positive_rate_pct: Number((rate * 100).toFixed(1)) };
    raw[name] = subset.length >= minimumBucket ? Number(clamp((rate - baseline) * 20, -4, 4).toFixed(2)) : 0;
  }
  const ready = rows.length >= minSamples && Object.values(buckets).filter(row => row.samples >= minimumBucket).length >= 3;
  return {
    ready,
    resolved_samples: rows.length,
    required_samples: minSamples,
    positive_outcome_rate_pct: Number((baseline * 100).toFixed(1)),
    adjustments: ready ? raw : { volume: 0, buyer_flow: 0, structure: 0, compression: 0 },
    buckets,
    note: ready ? 'CALIBRATION_ONLY_NO_AUTOMATIC_RULE_OR_EXECUTION_CHANGES' : 'INSUFFICIENT_OUTCOMES_NO_LEARNING_ADJUSTMENT_APPLIED'
  };
}

export function applyAdaptiveLearning(baseScore, features = {}, profile = {}) {
  const base = finite(baseScore);
  if (base === null) return null;
  if (profile?.ready !== true) return Number(clamp(base, 0, 100).toFixed(1));
  const active = [];
  if (finite(features.volume_ratio) !== null && Number(features.volume_ratio) >= 1.5) active.push(finite(profile.adjustments?.volume) || 0);
  if (finite(features.taker_buy_ratio) !== null && Number(features.taker_buy_ratio) >= 0.52) active.push(finite(profile.adjustments?.buyer_flow) || 0);
  if (features.higher_low === true || features.breakout_above_prior_high === true) active.push(finite(profile.adjustments?.structure) || 0);
  if (finite(features.compression_ratio) !== null && Number(features.compression_ratio) <= 0.8) active.push(finite(profile.adjustments?.compression) || 0);
  const delta = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  return Number(clamp(base + clamp(delta, -4, 4), 0, 100).toFixed(1));
}

export function findMissedMoverEvents({ history = [], currentPrices = [], now = Date.now(), thresholdPct = 5, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const current = new Map((Array.isArray(currentPrices) ? currentPrices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price ?? row?.lastPrice)]));
  const latestBySymbol = new Map();
  for (const row of (Array.isArray(history) ? history : [])) {
    const symbol = String(row?.symbol || '').toUpperCase();
    const at = finite(row?.at), price = finite(row?.price);
    if (!symbol || at === null || price === null || price <= 0 || at >= Number(now) ||
        Number(now) - at < 15 * 60 * 1000 || Number(now) - at > maxAgeMs) continue;
    const old = latestBySymbol.get(symbol);
    if (!old || at > old.at) latestBySymbol.set(symbol, { ...row, symbol, at, price });
  }
  const events = [];
  for (const [symbol, previous] of latestBySymbol) {
    const price = current.get(symbol);
    if (price === undefined || price === null || price <= 0) continue;
    const move = (price / previous.price - 1) * 100;
    if (move < thresholdPct) continue;
    const previousTier = String(previous.tier || 'NOT_EVALUATED');
    events.push({
      id: symbol + ':' + String(previous.at),
      symbol,
      baseline_at: new Date(previous.at).toISOString(),
      baseline_price: previous.price,
      current_price: price,
      move_pct: Number(move.toFixed(2)),
      baseline_tier: previousTier,
      classification: previous.evaluated !== true ? 'UNASSESSED_MOVE' : ['EARLY_SETUP', 'WATCH'].includes(previousTier) ? 'FOLLOW_UP_MOVE' : 'POTENTIAL_MISSED_MOVER',
    baseline_was_evaluated: previous.evaluated === true,
      diagnostic_only: true,
      reason: 'OBSERVED_PRICE_MOVED_AFTER_PRIOR_SNAPSHOT'
    });
  }
  return events.sort((a, b) => b.move_pct - a.move_pct);
}

export function estimatePaperEquity(portfolio) {
  const cash = finite(portfolio?.cash) || 0;
  const marked = (Array.isArray(portfolio?.open_positions) ? portfolio.open_positions : []).reduce((sum, position) => {
    const entry = finite(position.entry_price);
    const mark = finite(position.mark_price) || entry;
    return sum + (entry > 0 ? (Number(position.notional) || 0) * mark / entry : 0);
  }, 0);
  const costs = (Array.isArray(portfolio?.open_positions) ? portfolio.open_positions : []).reduce((sum, position) =>
    sum + (Number(position.notional) || 0) * 0.0015, 0);
  return Number((cash + marked - costs).toFixed(2));
}

export function openPaperPosition(portfolio, candidate, now = Date.now()) {
  if (!portfolio || portfolio.enabled !== true || portfolio.real_order_execution !== false) {
    return { opened: false, reason: 'PAPER_MODE_DISABLED' };
  }
  if (!candidate || candidate.data_valid !== true || candidate.data_stale === true ||
      candidate.closed_candles_only !== true || candidate.real_order_execution !== false ||
      candidate.tier !== 'EARLY_SETUP' || candidate.paper_candidate !== true ||
      candidate.entry_eligible !== false || candidate.thresholds?.no_chase !== true ||
      !candidate.features || Number(candidate.score) < 68 ||
      Number(candidate.features.volume_ratio) < 1.5 ||
      Number(candidate.features.trade_ratio) < 1.25 ||
      Number(candidate.features.taker_buy_ratio) < 0.52 ||
      Number(candidate.features.close_location) < 0.58 ||
      Number(candidate.quote_volume_24h) < 750000) {
    return { opened: false, reason: 'STRICT_PAPER_SETUP_GATE_FAILED' };
  }
  const symbol = String(candidate.symbol || '').toUpperCase();
  const price = finite(candidate.price);
  if (!symbol.endsWith('USDT') || !(price > 0)) return { opened: false, reason: 'PAPER_SYMBOL_OR_PRICE_INVALID' };
  if ((portfolio.open_positions || []).some(row => row.symbol === symbol)) return { opened: false, reason: 'PAPER_POSITION_ALREADY_OPEN' };
  if ((portfolio.open_positions || []).length >= 3) return { opened: false, reason: 'PAPER_POSITION_LIMIT' };
  const equity = estimatePaperEquity(portfolio);
  const notional = Math.min(Number(portfolio.cash) || 0, equity * 0.05);
  if (!(notional > 0)) return { opened: false, reason: 'PAPER_CASH_EXHAUSTED' };
  const position = {
    id: 'PAPER:' + symbol + ':' + String(now), symbol, entry_price: price, mark_price: price,
    quantity: notional / price, notional, opened_at: Number(now), entry_score: Number(candidate.score),
    entry_features: { ...candidate.features }, mode: 'PAPER_ONLY', paper_trading: true, real_order_execution: false
  };
  portfolio.cash = Number(portfolio.cash) - notional;
  portfolio.open_positions = [...(portfolio.open_positions || []), position];
  return { opened: true, reason: null, position: { ...position }, portfolio };
}

export function advancePaperPortfolio(portfolio, currentPrices = [], now = Date.now()) {
  if (!portfolio || portfolio.real_order_execution !== false || portfolio.mode !== 'PAPER_ONLY') {
    throw new Error('PAPER_PORTFOLIO_POLICY_VIOLATION');
  }
  const prices = new Map((Array.isArray(currentPrices) ? currentPrices : [])
    .map(row => [String(row?.symbol || '').toUpperCase(), finite(row?.price)]));
  const remaining = [], closed = [];
  for (const position of (portfolio.open_positions || [])) {
    const current = prices.get(String(position.symbol || '').toUpperCase());
    const mark = current !== null && current !== undefined && current > 0
      ? current : finite(position.mark_price) || finite(position.entry_price);
    const entry = finite(position.entry_price);
    const age = Number(now) - Number(position.opened_at);
    const gross = entry > 0 ? (mark / entry - 1) * 100 : 0;
    const reason = gross >= 3 ? 'PAPER_TAKE_PROFIT' : gross <= -2 ? 'PAPER_STOP_LOSS'
      : age >= 4 * 60 * 60 * 1000 ? 'PAPER_TIME_EXIT' : null;
    if (reason) {
      const notional = Number(position.notional) || 0;
      const pnl = notional * (gross - COST_PCT) / 100;
      portfolio.cash = Number(portfolio.cash) + notional + pnl;
      closed.push({ ...position, exit_price: mark, closed_at: Number(now),
        gross_return_pct: Number(gross.toFixed(3)), net_pnl: Number(pnl.toFixed(4)),
        net_return_pct: Number((gross - COST_PCT).toFixed(3)), exit_reason: reason,
        paper_trading: true, real_order_execution: false });
    } else {
      remaining.push({ ...position, mark_price: mark, gross_return_pct: Number(gross.toFixed(3)),
        estimated_net_pnl: Number((Number(position.notional) * (gross - 0.15) / 100).toFixed(4)),
        age_ms: Math.max(0, age) });
    }
  }
  portfolio.open_positions = remaining;
  portfolio.closed_trades = [...(portfolio.closed_trades || []), ...closed].slice(-2000);
  portfolio.updated_at = Number(now);
  return { portfolio, newlyClosed: closed, equity: estimatePaperEquity(portfolio), real_order_execution: false };
}
