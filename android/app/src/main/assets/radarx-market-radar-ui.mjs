const DIRECTION_VALUES = new Set(['ALL','LONG','BEARISH']);
const STATUS_VALUES = new Set(['ALL','CONFIRMED','CANDIDATE','NO_SIGNAL','INSUFFICIENT_DATA','REJECTED','DATA_STALE']);

export function normalizeMarketRadarResponse(response, requestedLimit = 20) {
  const body = response?.body && typeof response.body === 'object' ? response.body : null;
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  const requested = Number(requestedLimit);
  const requestedPairs = Number.isInteger(requested) && requested > 0 ? requested : 20;
  const universe = body?.universe && typeof body.universe === 'object' ? body.universe : {};
  return {
    status: Number(response?.status) || 0,
    ok: response?.ok === true,
    error: response?.error || null,
    live: body?.meta?.live === true,
    paperTrading: body?.meta?.paper_trading === true,
    realOrderExecution: body?.meta?.real_order_execution === false,
    confidenceScore: body?.meta?.confidence_score === 'UNKNOWN',
    updatedAt: body?.as_of || null,
    requestedPairs,
    scannedPairs: Number(universe.scanned ?? body?.meta?.scanned ?? candidates.length),
    candidateCount: Number(universe.candidates ?? body?.meta?.candidates ?? candidates.length),
    candidates
  };
}

export function classifyMarketRadarResponse(response, online = true) {
  if (!online) return 'OFFLINE';
  if (!response || Number(response.status) === 0) return 'RETRY';
  const normalized = normalizeMarketRadarResponse(response);
  if (normalized.status === 200 && normalized.live) return 'LIVE_DATA';
  const stale = normalized.status === 503 ||
    response?.body?.reason === 'SNAPSHOT_STALE' ||
    normalized.candidates.some(c => c?.data_status?.data_stale === true);
  if (stale) return 'DATA_STALE';
  if (normalized.status === 200 && normalized.candidates.length === 0) return 'NO_CANDIDATES';
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
    if (direction !== 'ALL' && candidate?.direction !== direction) return false;
    if (strategy !== 'ALL' && !candidate?.strategies?.some(s => s?.id === strategy)) return false;
    if (signalState !== 'ALL' && candidate?.signal_state !== signalState) return false;
    return true;
  });
}

export function sortCandidates(candidates, sort = 'strongest') {
  const list = [...(Array.isArray(candidates) ? candidates : [])];
  const value = (candidate, key) => {
    if (key === 'liquidity') return numeric(candidate?.liquidity_quality) ?? -1;
    if (key === 'volume') return numeric(candidate?.quote_volume_24h) ?? -1;
    if (key === 'strongest') return numeric(candidate?.overall_score) ?? -1;
    return -1;
  };
  return list.sort((a, b) => {
    const delta = value(b, sort) - value(a, sort);
    return delta || String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
  });
}

export function getStrategyOptions(candidates) {
  const ids = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    for (const strategy of Array.isArray(candidate?.strategies) ? candidate.strategies : []) {
      if (strategy?.id) ids.add(String(strategy.id));
    }
  }
  return [...ids].sort();
}

export function isCandidateFresh(candidate) {
  return candidate?.data_status?.data_stale === false &&
    candidate?.data_status?.data_valid === true;
}

export function candidateReason(candidate) {
  const accepted = Array.isArray(candidate?.accepted_strategies) ? candidate.accepted_strategies : [];
  const reasons = Array.isArray(candidate?.reason_codes) ? candidate.reason_codes : [];
  if (accepted.length) return 'Accepted strategies: ' + accepted.join(', ');
  return reasons.length ? reasons.join(' · ') : 'No qualifying strategy';
}

export function normalizeStrategyRows(candidate) {
  return (Array.isArray(candidate?.strategies) ? candidate.strategies : []).map(strategy => ({
    id: strategy?.id || 'UNKNOWN',
    name: strategy?.name || strategy?.id || 'UNKNOWN',
    state: strategy?.signal_state || strategy?.state || 'UNKNOWN',
    direction: strategy?.direction || 'NONE',
    score: numeric(strategy?.score?.value),
    coverage: numeric(strategy?.score?.coverage),
    hardGatesPassed: strategy?.hard_gates_passed === true,
    hardGateStatus: strategy?.hard_gate_status || {passed: strategy?.hard_gates_passed === true, failed: []},
    reasonCodes: Array.isArray(strategy?.reason_codes) ? strategy.reason_codes : [],
    evidence: strategy?.evidence && typeof strategy.evidence === 'object' ? strategy.evidence : {},
    invalidation: Array.isArray(strategy?.invalidation) ? strategy.invalidation : [],
    requiredData: Array.isArray(strategy?.required_data) ? strategy.required_data : [],
    missingRequiredData: Array.isArray(strategy?.missing_required_data) ? strategy.missing_required_data : [],
    confidenceScore: strategy?.confidence_score || 'UNKNOWN'
  }));
}

export async function fetchMarketRadarWithRetry(client, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? Math.max(0, options.attempts) : 2;
  const sleep = typeof options.sleepFn === 'function' ? options.sleepFn : (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let last = null;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    last = await client.getMarketRadar({
      quote: options.quote || 'USDT',
      limit: options.limit || 20
    });
    if (last?.ok === true) return {response: last, attempts: attempt + 1};
    const retryable = !last || Number(last.status) === 0 || Number(last.status) === 429 || Number(last.status) >= 500;
    if (!retryable || attempt >= attempts) return {response: last, attempts: attempt + 1};
    await sleep(Math.min(1500, 300 * (2 ** attempt)));
  }
  return {response: last, attempts: attempts + 1};
}
