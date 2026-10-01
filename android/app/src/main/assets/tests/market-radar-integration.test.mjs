import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  DEFAULT_BACKEND_BASE_URL,
  getMarketRadar,
  fetchBackendState
} from '../radarx-backend-client.mjs';
import {
  normalizeMarketRadarResponse,
  classifyMarketRadarResponse,
  classifyCandidateOverallState,
  normalizeCandidateForDisplay,
  filterCandidates,
  sortCandidates,
  getStrategyOptions,
  isCandidateFresh,
  candidateDataState,
  normalizeStrategyRows,
  fetchMarketRadarWithRetry
} from '../radarx-market-radar-ui.mjs';
import {
  validateMarketRadarContract,
  buildCandidateMarkup,
  buildCandidateDetailMarkup
} from '../radarx-market-radar-screen.mjs';

function makeStrategies() {
  const ids = [
    'MTF_TREND',
    'CONFIRMED_BREAKOUT',
    'MEAN_REVERSION',
    'EMA_RIBBON_ALIGNMENT',
    'ADX_TREND_STRENGTH',
    'MACD_TREND_CONTINUATION',
    'BOLLINGER_BAND_REVERSION',
    'VWAP_REVERSION',
    'RELATIVE_VOLUME_SURGE',
    'ATR_EXPANSION'
  ];
  return ids.map((id, i) => ({
    id,
    signal_state: i === 3 ? 'CANDIDATE' : 'REJECTED',
    direction: i === 3 ? 'LONG' : 'NONE',
    score: {
      value: i === 3 ? 82 : null,
      coverage: i === 3 ? 1 : 0.5,
      decision_band: i === 3 ? 'strong' : 'insufficient'
    },
    evidence: {test: i},
    reason_codes: i === 3 ? ['BULLISH_TEST'] : ['TEST_REJECTED'],
    invalidation: ['TEST_INVALIDATION'],
    required_data: ['1h'],
    missing_required_data: i === 7 ? ['15m'] : [],
    hard_gates_passed: i === 3,
    hard_gate_status: {passed: i === 3, failed: i === 3 ? [] : ['TEST_GATE']},
    confidence_score: 'UNKNOWN',
    paper_trading: true,
    real_order_execution: false
  }));
}

function makeCandidate(kind = 'fresh', index = 0) {
  const stale = kind === 'stale';
  const invalid = kind === 'invalid';
  return {
    symbol: index === 0 ? 'BTCUSDT' : 'ETHUSDT',
    last_price: 100 + index,
    price_change_24h: index ? 1 : 5,
    quote_volume_24h: index ? 200 : 100,
    liquidity_quality: index ? 50 : 90,
    data_quality: stale ? 55 : invalid ? null : 95,
    overall_score: stale || invalid ? (index ? 99 : 98) : (index ? 60 : 90),
    coverage: {ratio: 1},
    best_strategy: index === 0 ? 'EMA_RIBBON_ALIGNMENT' : 'ADX_TREND_STRENGTH',
    direction: index === 0 ? 'LONG' : 'BEARISH',
    signal_state: 'CANDIDATE',
    accepted_strategies: index === 0 ? ['EMA_RIBBON_ALIGNMENT'] : [],
    reason_codes: index === 0 ? ['BULLISH_TEST'] : ['TEST_REJECTED'],
    risk_flags: ['TEST_RISK'],
    invalidation: ['TEST_INVALIDATION'],
    data_status: stale
      ? {data_stale: true, data_valid: true, source: 'TEST', fetch_age_ms: 999999}
      : invalid
        ? {data_stale: false, data_valid: false, source: 'TEST', fetch_age_ms: 999999}
        : {data_stale: false, data_valid: true, source: 'TEST', fetch_age_ms: 1000},
    strategies: makeStrategies()
  };
}

function makeBody(states = ['fresh', 'fresh'], {live = true, error = null, reason = null} = {}) {
  return {
    meta: {
      live,
      paper_trading: true,
      real_order_execution: false,
      confidence_score: 'UNKNOWN'
    },
    as_of: '2026-10-01T19:00:00.000Z',
    universe: {
      requested: 20,
      scanned: states.length,
      returned: states.length
    },
    ...(error ? {error} : {}),
    ...(reason ? {reason} : {}),
    candidates: states.map((kind, index) => makeCandidate(kind, index))
  };
}

function makeResponse(body = makeBody(), status = 200, ok = status >= 200 && status < 300) {
  return {status, ok, body, error: null};
}

test('1. HTTP 503 + error=DATA_STALE -> DATA_STALE', () => {
  assert.equal(
    classifyMarketRadarResponse(makeResponse({error: 'DATA_STALE'}, 503, false)),
    'DATA_STALE'
  );
});

test('2. HTTP 503 + error=MARKET_RADAR_UNAVAILABLE -> DATA_UNAVAILABLE', () => {
  assert.equal(
    classifyMarketRadarResponse(makeResponse({error: 'MARKET_RADAR_UNAVAILABLE'}, 503, false)),
    'DATA_UNAVAILABLE'
  );
});

test('3. HTTP 503 + error=DATA_SOURCE_UNAVAILABLE -> DATA_UNAVAILABLE', () => {
  assert.equal(
    classifyMarketRadarResponse(makeResponse({error: 'DATA_SOURCE_UNAVAILABLE'}, 503, false)),
    'DATA_UNAVAILABLE'
  );
});

test('4. HTTP 503 without a known stale reason -> DATA_UNAVAILABLE', () => {
  assert.equal(
    classifyMarketRadarResponse(makeResponse({message: 'temporary backend failure'}, 503, false)),
    'DATA_UNAVAILABLE'
  );
});

test('5. One fresh + one stale candidate -> PARTIAL_DATA', () => {
  const raw = makeBody(['fresh', 'stale'], {live: true});
  const res = makeResponse(raw);
  assert.equal(classifyMarketRadarResponse(res), 'PARTIAL_DATA');

  const display = raw.candidates.map(normalizeCandidateForDisplay);
  assert.equal(classifyCandidateOverallState(display), 'PARTIAL_DATA');
  assert.equal(display[0].data_status.data_stale, false);
  assert.equal(display[1].data_status.data_stale, true);
  assert.equal(display[1].signal_state, 'DATA_STALE');
});

test('6. All candidates stale -> DATA_STALE', () => {
  const raw = makeBody(['stale', 'stale'], {live: true});
  assert.equal(classifyMarketRadarResponse(makeResponse(raw)), 'DATA_STALE');

  const display = raw.candidates.map(normalizeCandidateForDisplay);
  assert.ok(display.every(candidate => candidateDataState(candidate) === 'DATA_STALE'));
});

test('7. All candidates fresh -> LIVE_DATA and meta.live does not control the result', () => {
  const raw = makeBody(['fresh', 'fresh'], {live: false});
  assert.equal(classifyMarketRadarResponse(makeResponse(raw)), 'LIVE_DATA');
  assert.ok(raw.candidates.every(isCandidateFresh));
});

test('8. Failed request never resolves to FETCHING', async () => {
  const result = await fetchMarketRadarWithRetry({
    getMarketRadar: async () => ({status: 0, ok: false, body: null, error: 'NETWORK_DOWN'})
  }, {
    quote: 'USDT',
    limit: 20,
    attempts: 2,
    sleepFn: async () => {}
  });
  assert.equal(result.attempts, 3);
  assert.notEqual(classifyMarketRadarResponse(result.response, true), 'FETCHING');
  assert.equal(classifyMarketRadarResponse(result.response, true), 'RETRY');
});

test('9. Retry works and stops after successful response', async () => {
  let calls = 0;
  const result = await fetchMarketRadarWithRetry({
    getMarketRadar: async () => {
      calls += 1;
      if (calls === 1) return {status: 503, ok: false, body: {error: 'DATA_STALE'}, error: null};
      return makeResponse(makeBody(['fresh', 'fresh']));
    }
  }, {
    quote: 'USDT',
    limit: 20,
    attempts: 2,
    sleepFn: async () => {}
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.response.status, 200);
});

test('10. Stale candidate cannot rank ahead of a fresh candidate', () => {
  const candidates = makeBody(['stale', 'fresh']).candidates;
  const ranked = sortCandidates(candidates, 'strongest');
  assert.equal(ranked[0].symbol, 'ETHUSDT');
  assert.equal(candidateDataState(ranked[1]), 'DATA_STALE');
});

test('11. Existing backend endpoints and read-only Market Radar endpoint remain unchanged', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/healthz')) return new Response(JSON.stringify({status: 'ok'}), {status: 200});
    if (value.endsWith('/readyz')) return new Response(JSON.stringify({ready: true}), {status: 200});
    if (value.endsWith('/api/signal?symbol=BTCUSDT')) {
      return new Response(JSON.stringify({
        meta: {live: true, paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'},
        signal: {
          data_status: {data_stale: false, data_valid: true, last_error: null},
          risk_filter: 'PASS',
          scores: {data_quality: 95, liquidity_quality: 90}
        }
      }), {status: 200});
    }
    if (value.endsWith('/api/market-radar?quote=USDT&limit=20')) {
      return new Response(JSON.stringify(makeBody()), {status: 200});
    }
    throw new Error('UNEXPECTED_ENDPOINT');
  };

  await getMarketRadar({quote: 'USDT', limit: 20}, fetchImpl);
  assert.equal(calls[0], DEFAULT_BACKEND_BASE_URL + '/api/market-radar?quote=USDT&limit=20');

  const state = await fetchBackendState(DEFAULT_BACKEND_BASE_URL, 'BTCUSDT', fetchImpl);
  assert.deepEqual(calls.slice(1), [
    DEFAULT_BACKEND_BASE_URL + '/healthz',
    DEFAULT_BACKEND_BASE_URL + '/readyz',
    DEFAULT_BACKEND_BASE_URL + '/api/signal?symbol=BTCUSDT'
  ]);
  assert.equal(state.health.status, 200);
  assert.equal(state.readiness.status, 200);
  assert.equal(state.signal.status, 200);
});

test('12. Candidate detail preserves the 10-strategy contract', () => {
  const candidate = makeCandidate('fresh', 0);
  const card = buildCandidateMarkup(candidate, 0);
  const detail = buildCandidateDetailMarkup(candidate);
  assert.match(card, /BTCUSDT/);
  assert.match(card, /Overall score/);
  assert.match(card, /EMA_RIBBON_ALIGNMENT/);
  assert.match(detail, /rxmr-strategies/);
  assert.ok((detail.match(/TEST_INVALIDATION/g) || []).length >= 10);
  assert.match(detail, /required_data/);
  assert.match(detail, /reason_codes/);
  assert.match(detail, /Hard gates/);
});

test('13. Sorting and filtering remain deterministic', () => {
  const candidates = makeBody(['fresh', 'fresh']).candidates;
  assert.equal(sortCandidates([...candidates].reverse(), 'strongest')[0].symbol, 'BTCUSDT');
  assert.equal(sortCandidates([...candidates].reverse(), 'liquidity')[0].symbol, 'BTCUSDT');
  assert.equal(sortCandidates([...candidates].reverse(), 'volume')[0].symbol, 'ETHUSDT');
  assert.deepEqual(filterCandidates(candidates, {direction: 'LONG'}).map(c => c.symbol), ['BTCUSDT']);
  assert.deepEqual(filterCandidates(candidates, {direction: 'BEARISH'}).map(c => c.symbol), ['ETHUSDT']);
  assert.deepEqual(filterCandidates(candidates, {signalState: 'CANDIDATE'}).map(c => c.symbol), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(getStrategyOptions(candidates).length, 10);
});

test('14. Offline is deterministic and not FETCHING', () => {
  const offline = makeResponse(null, 0, false);
  offline.error = 'OFFLINE';
  assert.equal(classifyMarketRadarResponse(offline, false), 'OFFLINE');
});

test('15. Fresh + invalid candidate yields PARTIAL_DATA and invalid candidate stays out of fresh ranking', () => {
  const raw = makeBody(['fresh', 'invalid'], {live: true});
  const display = raw.candidates.map(normalizeCandidateForDisplay);
  assert.equal(classifyCandidateOverallState(display), 'PARTIAL_DATA');
  assert.equal(candidateDataState(display[0]), 'LIVE_DATA');
  assert.equal(candidateDataState(display[1]), 'DATA_INVALID');
  assert.equal(sortCandidates(display, 'strongest')[0].symbol, 'BTCUSDT');
});

test('16. HTTP 200 with zero candidates is not LIVE_DATA', () => {
  const raw = makeBody([], {live: true});
  assert.equal(classifyMarketRadarResponse(makeResponse(raw)), 'DATA_STALE');
});

test('17. Contract validation rejects bad paper flags and incomplete strategy payload', () => {
  const good = makeResponse(makeBody());
  assert.deepEqual(validateMarketRadarContract(good), {
    valid: true,
    reason: null,
    strategiesPerCandidate: 10
  });

  const badFlags = makeResponse({
    meta: {live: true, paper_trading: false, real_order_execution: true, confidence_score: 12},
    candidates: []
  });
  assert.equal(validateMarketRadarContract(badFlags).valid, false);

  const badStrategies = makeResponse({
    meta: {live: true, paper_trading: true, real_order_execution: false, confidence_score: 'UNKNOWN'},
    candidates: [{symbol: 'BTCUSDT', strategies: [{}]}]
  });
  assert.equal(validateMarketRadarContract(badStrategies).valid, false);
});

test('18. Android embedded UI has no GitHub Pages dependency', async () => {
  const index = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  const clientJs = await fs.readFile(new URL('../radarx-backend-client.js', import.meta.url), 'utf8');
  assert.equal(index.includes('github.io'), false);
  assert.equal(index.includes('radarx-market-radar-screen.mjs'), true);
  assert.equal(clientJs.includes('getMarketRadar'), true);
});

test('19. Stale candidate markup is explicitly marked DATA_STALE', () => {
  const stale = normalizeCandidateForDisplay(makeCandidate('stale', 0));
  const markup = buildCandidateMarkup(stale, 0);
  assert.match(markup, /DATA_STALE/);
  assert.equal(stale.signal_state, 'DATA_STALE');
  assert.equal(stale.data_status.data_stale, true);
  assert.equal(stale.overall_score, null);
});
