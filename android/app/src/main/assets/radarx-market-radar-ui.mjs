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

function hasClearStaleReason(response) {
  const body = response?.body && typeof response.body === 'object' ? response.body : {};
  const values = [body.error, body.reason, body.code, body.message]
    .filter(value => typeof value === 'string')
    .map(value => value.trim().toUpperCase());
  return values.some(value =>
    value === 'DATA_STALE' ||
    value === 'SNAPSHOT_STALE' ||
    value === 'STALE_SNAPSHOT' ||
    /(?:SNAPSHOT|DATA|CACHE).*(?:STALE|OUTDATED)|(?:STALE|OUTDATED).*(?:SNAPSHOT|DATA|CACHE)/.test(value)
  ) || Array.isArray(body.candidates) && body.candidates.some(candidate => candidate?.data_status?.data_stale === true);
}

export function candidateDataState(candidate) {
  if (isCandidateFresh(candidate)) return 'LIVE_DATA';
  if (candidate?.data_status?.data_stale === true) return 'DATA_STALE';
  return 'DATA_INVALID';
}

export function normalizeCandidateForDisplay(candidate) {
  if (candidateDataState(candidate) !== 'DATA_STALE') return {...candidate};
  return {
    ...candidate,
    signal_state: 'DATA_STALE',
    overall_score: null,
    data_status: {
      ...(candidate?.data_status || {}),
      data_stale: true
    }
  };
}

export function classifyCandidateOverallState(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const freshCount = list.filter(isCandidateFresh).length;
  if (list.length > 0 && freshCount === list.length) return 'LIVE_DATA';
  if (freshCount > 0) return 'PARTIAL_DATA';
  return 'DATA_STALE';
}

export function classifyMarketRadarResponse(response, online = true) {
  if (!online) return 'OFFLINE';
  if (!response || Number(response.status) === 0) return 'RETRY';

  const normalized = normalizeMarketRadarResponse(response);
  const status = normalized.status;

  if (status === 503) {
    return hasClearStaleReason(response) ? 'DATA_STALE' : 'DATA_UNAVAILABLE';
  }

  if (status === 200 && normalized.ok) {
    const body = response?.body && typeof response.body === 'object' ? response.body : {};
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
    if (direction !== 'ALL' && candidate?.direction !== direction) return false;
    if (strategy !== 'ALL' && !candidate?.strategies?.some(s => s?.id === strategy)) return false;
    if (signalState !== 'ALL' && candidate?.signal_state !== signalState) return false;
    return true;
  });
}

export function sortCandidates(candidates, sort = 'strongest') {
  const list = [...(Array.isArray(candidates) ? candidates : [])];
  const fresh = list.filter(isCandidateFresh);
  const nonFresh = list.filter(candidate => !isCandidateFresh(candidate));
  const value = (candidate, key) => {
    if (key === 'liquidity') return numeric(candidate?.liquidity_quality) ?? -1;
    if (key === 'volume') return numeric(candidate?.quote_volume_24h) ?? -1;
    if (key === 'strongest') return numeric(candidate?.overall_score) ?? -1;
    return -1;
  };
  fresh.sort((a, b) => {
    const delta = value(b, sort) - value(a, sort);
    return delta || String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
  });
  return fresh.concat(nonFresh);
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
