const DIRECTION_VALUES = new Set(['ALL','LONG','BEARISH']);
const STATUS_VALUES = new Set(['ALL','CONFIRMED','CANDIDATE']);

export function normalizeMarketRadarResponse(response, requestedLimit = 20) {
  const body = response && response.body && typeof response.body === 'object' ? response.body : null;
  const candidates = Array.isArray(body && body.candidates) ? body.candidates : [];
  const requested = Number(requestedLimit);
  const requestedPairs = Number.isInteger(requested) && requested > 0 ? requested : 20;
  const universe = body && body.universe && typeof body.universe === 'object' ? body.universe : {};
  const freshValidCount = candidates.filter(isCandidateEligible).length;
  const excludedCount = Math.max(0, candidates.length - freshValidCount);
  return {
    status: Number(response && response.status) || 0,
    ok: response && response.ok === true,
    error: response && response.error || null,
    live: body && body.meta && body.meta.live === true,
    paperTrading: body && body.meta && body.meta.paper_trading === true,
    realOrderExecution: body && body.meta && body.meta.real_order_execution === false,
    confidenceScore: body && body.meta && body.meta.confidence_score === 'UNKNOWN',
    updatedAt: body && body.as_of || null,
    requestedPairs,
    scannedPairs: Number(universe.scanned || body && body.meta && body.meta.scanned || 0),
    candidateCount: Number(universe.returned || universe.candidates || body && body.meta && body.meta.candidates || candidates.length),
    freshValidCount,
    excludedCount,
    candidates
  };
}

function hasClearStaleReason(response) {
  const body = response && response.body && typeof response.body === 'object' ? response.body : {};
  const values = [body.error, body.reason, body.code, body.message]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toUpperCase());
  return values.some(value =>
    value === 'DATA_STALE' ||
    value === 'SNAPSHOT_STALE' ||
    value === 'STALE_SNAPSHOT' ||
    /(?:SNAPSHOT|DATA|CACHE).*(?:STALE|OUTDATED)|(?:STALE|OUTDATED).*(?:SNAPSHOT|DATA|CACHE)/.test(value)
  ) || Array.isArray(body.candidates) && body.candidates.some(candidate => candidate && candidate.data_status && candidate.data_status.data_stale === true);
}

export function hasValidSignalState(candidate) {
  return candidate && candidate.signal_state === 'CANDIDATE' || candidate && candidate.signal_state === 'CONFIRMED';
}

export function isCandidateFresh(candidate) {
  return candidate && candidate.data_status && candidate.data_status.data_stale === false &&
    candidate && candidate.data_status && candidate.data_status.data_valid === true;
}

export function isCandidateEligible(candidate) {
  return isCandidateFresh(candidate) &&
    hasValidSignalState(candidate) &&
    Number(candidate && candidate.data_quality) > 0 &&
    Number(candidate && candidate.coverage && candidate.coverage.ratio) >= 1 &&
    Number.isFinite(Number(candidate && candidate.overall_score)) &&
    Array.isArray(candidate && candidate.accepted_strategies) &&
    candidate.accepted_strategies.length > 0 &&
    Array.isArray(candidate && candidate.strategies) &&
    candidate.strategies.some(strategy => strategy && strategy.hard_gates_passed === true);
}

export function candidateDataState(candidate) {
  if (isCandidateEligible(candidate)) return 'LIVE_DATA';
  if (candidate && candidate.data_status && candidate.data_status.data_stale === true) return 'DATA_STALE';
  return 'DATA_INVALID';
}

export function normalizeCandidateForDisplay(candidate) {
  if (isCandidateEligible(candidate)) return {...candidate};
  return {
    ...candidate,
    raw_overall_score: candidate && candidate.overall_score || null,
    raw_direction: candidate && candidate.direction || null,
    raw_signal_state: candidate && candidate.signal_state || null,
    overall_score: null,
    direction: null,
    best_strategy: null,
    signal_state: candidateDataState(candidate)
  };
}

export function classifyCandidateOverallState(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const eligible = list.filter(isCandidateEligible).length;
  if (eligible === 0) return list.length ? 'DATA_STALE' : 'NO_VALID_CANDIDATES';
  if (eligible === list.length) return 'LIVE_DATA';
  return 'PARTIAL_DATA';
}

export function classifyMarketRadarResponse(response, online = true) {
  if (!online) return 'OFFLINE';
  if (!response || Number(response.status) === 0) return 'RETRY';

  const normalized = normalizeMarketRadarResponse(response);
  if (normalized.status === 503) {
    return hasClearStaleReason(response) ? 'DATA_STALE' : 'DATA_UNAVAILABLE';
  }

  if (normalized.status === 200 && normalized.ok) {
    const body = response && response.body && typeof response.body === 'object' ? response.body : {};
    if (body.error) return 'DATA_UNAVAILABLE';
    return classifyCandidateOverallState(normalized.candidates);
  }

  return 'DATA_UNAVAILABLE';
}

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function filterCandidates(candidates, filters = {}) {
  const direction = DIRECTION_VALUES.has(filters.direction) ? filters.direction : 'ALL';
  const strategy = String(filters.strategy || 'ALL');
  const signalState = STATUS_VALUES.has(filters.signalState) ? filters.signalState : 'ALL';
  return (Array.isArray(candidates) ? candidates : []).filter(candidate => {
    if (!isCandidateEligible(candidate)) return false;
    if (direction !== 'ALL' && candidate && candidate.direction !== direction) return false;
    if (strategy !== 'ALL' && !candidate && candidate.strategies && candidate.strategies.some(s => s && s.id === strategy && s && s.hard_gates_passed === true)) return false;
    if (signalState !== 'ALL' && candidate && candidate.signal_state !== signalState) return false;
    return true;
  });
}

export function sortCandidates(candidates, sort = 'strongest') {
  const list = (Array.isArray(candidates) ? candidates : []).filter(isCandidateEligible);
  const value = (candidate, key) => {
    if (key === 'liquidity') return numeric(candidate && candidate.liquidity_quality) || -1;
    if (key === 'volume') return numeric(candidate && candidate.quote_volume_24h) || -1;
    if (key === 'strongest') return numeric(candidate && candidate.overall_score) || -1;
    return -1;
  };
  return list.sort((a, b) => {
    const delta = value(b, sort) - value(a, sort);
    return delta || String(a && a.symbol || '').localeCompare(String(b && b.symbol || ''));
  });
}

export function sortExcludedCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => !isCandidateEligible(candidate))
    .sort((a, b) => {
      const sa = candidateDataState(a) === 'DATA_STALE' ? 0 : 1;
      const sb = candidateDataState(b) === 'DATA_STALE' ? 0 : 1;
      return sa - sb || String(a && a.symbol || '').localeCompare(String(b && b.symbol || ''));
    });
}

export function splitCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return {
    valid: list.filter(isCandidateEligible),
    excluded: sortExcludedCandidates(list)
  };
}

export function getStrategyOptions(candidates) {
  const ids = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const strategy of Array.isArray(candidate && candidate.strategies) ? candidate.strategies : []) {
      if (strategy && strategy.id) ids.add(String(strategy.id));
    }
  }
  return [...ids].sort();
}

export function candidateReason(candidate) {
  const accepted = Array.isArray(candidate && candidate.accepted_strategies) ? candidate.accepted_strategies : [];
  const reasons = Array.isArray(candidate && candidate.reason_codes) ? candidate.reason_codes : [];
  if (accepted.length) return accepted.join(', ');
  return reasons.length ? reasons.join(' · ') : 'No qualifying strategy';
}

export function normalizeStrategyRows(candidate) {
  return (Array.isArray(candidate && candidate.strategies) ? candidate.strategies : []).map(strategy => ({
    id: strategy && strategy.id || 'UNKNOWN',
    name: strategy && strategy.name || strategy && strategy.id || 'UNKNOWN',
    state: strategy && strategy.signal_state || strategy && strategy.state || 'UNKNOWN',
    direction: strategy && strategy.direction || 'NONE',
    score: numeric(strategy && strategy.score && strategy.score.value),
    coverage: numeric(strategy && strategy.score && strategy.score.coverage),
    hardGatesPassed: strategy && strategy.hard_gates_passed === true,
    hardGateStatus: strategy && strategy.hard_gate_status || {passed: strategy && strategy.hard_gates_passed === true, failed: []},
    reasonCodes: Array.isArray(strategy && strategy.reason_codes) ? strategy.reason_codes : [],
    evidence: strategy && strategy.evidence && typeof strategy.evidence === 'object' ? strategy.evidence : {},
    invalidation: Array.isArray(strategy && strategy.invalidation) ? strategy.invalidation : [],
    requiredData: Array.isArray(strategy && strategy.required_data) ? strategy.required_data : [],
    missingRequiredData: Array.isArray(strategy && strategy.missing_required_data) ? strategy.missing_required_data : [],
    confidenceScore: strategy && strategy.confidence_score || 'UNKNOWN'
  }));
}

export async function fetchMarketRadarWithRetry(client, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? Math.max(0, options.attempts) : 2;
  const sleep = typeof options.sleepFn === 'function'
    ? options.sleepFn
    : (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let last = null;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    last = await client.getMarketRadar({
      quote: options.quote || 'USDT',
      limit: options.limit || 20
    });
    if (last && last.ok === true) return {response: last, attempts: attempt + 1};
    const retryable = !last || Number(last.status) === 0 || Number(last.status) === 429 || Number(last.status) >= 500;
    if (!retryable || attempt >= attempts) return {response: last, attempts: attempt + 1};
    await sleep(Math.min(1500, 300 * (2 ** attempt)));
  }
  return {response: last, attempts: attempts + 1};
}
