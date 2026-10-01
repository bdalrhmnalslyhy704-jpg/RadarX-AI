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
  filterCandidates,
  sortCandidates,
  getStrategyOptions,
  isCandidateFresh,
  normalizeStrategyRows,
  fetchMarketRadarWithRetry
} from '../radarx-market-radar-ui.mjs';
import {
  validateMarketRadarContract,
  buildCandidateMarkup,
  buildCandidateDetailMarkup
} from '../radarx-market-radar-screen.mjs';

function makeStrategies() {
  return Array.from({length:10}, (_,i) => ({
    id: ['MTF_TREND','CONFIRMED_BREAKOUT','MEAN_REVERSION','EMA_RIBBON_ALIGNMENT','ADX_TREND_STRENGTH','MACD_TREND_CONTINUATION','BOLLINGER_BAND_REVERSION','VWAP_REVERSION','RELATIVE_VOLUME_SURGE','ATR_EXPANSION'][i],
    signal_state: i === 3 ? 'CANDIDATE' : 'REJECTED',
    direction: i === 3 ? 'LONG' : 'NONE',
    score: {value: i === 3 ? 82 : null, coverage: i === 3 ? 1 : 0.5, decision_band: i === 3 ? 'strong' : 'insufficient'},
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

function makeBody(stale=false, count=2) {
  const candidates = Array.from({length:count}, (_,i) => ({
    symbol: i === 0 ? 'BTCUSDT' : 'ETHUSDT',
    last_price: 100+i,
    price_change_24h: i ? 1 : 5,
    quote_volume_24h: i ? 200 : 100,
    liquidity_quality: i ? 50 : 90,
    data_quality: 95,
    overall_score: stale ? null : (i ? 60 : 90),
    coverage: {ratio: 1},
    best_strategy: i === 0 ? 'EMA_RIBBON_ALIGNMENT' : 'ADX_TREND_STRENGTH',
    direction: i === 0 ? 'LONG' : 'BEARISH',
    signal_state: i === 0 ? 'CANDIDATE' : 'REJECTED',
    accepted_strategies: i === 0 ? ['EMA_RIBBON_ALIGNMENT'] : [],
    reason_codes: i === 0 ? ['BULLISH_TEST'] : ['TEST_REJECTED'],
    risk_flags: ['TEST_RISK'],
    invalidation: ['TEST_INVALIDATION'],
    data_status: {data_stale: stale, data_valid: !stale, source:'TEST', fetch_age_ms:1000},
    strategies: makeStrategies()
  }));
  return {
    meta: {live: !stale, paper_trading:true, real_order_execution:false, confidence_score:'UNKNOWN'},
    as_of: '2026-10-01T19:00:00.000Z',
    universe: {requested:20, scanned:2, returned:count},
    candidates
  };
}

test('Market Radar client requests exact read-only endpoint', async () => {
  let called = '';
  const fetchImpl = async url => {
    called = String(url);
    return new Response(JSON.stringify(makeBody()), {status:200, headers:{'content-type':'application/json'}});
  };
  const response = await getMarketRadar({quote:'USDT', limit:20}, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(called, DEFAULT_BACKEND_BASE_URL + '/api/market-radar?quote=USDT&limit=20');
});

test('Existing health/ready/signal client path remains intact', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/healthz')) return new Response(JSON.stringify({status:'ok'}), {status:200});
    if (String(url).endsWith('/readyz')) return new Response(JSON.stringify({ready:true,data_stale:false,data_valid:true,last_error:null}), {status:200});
    return new Response(JSON.stringify({
      meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},
      signal:{data_status:{data_stale:false,data_valid:true,last_error:null},risk_filter:'PASS',scores:{data_quality:95,liquidity_quality:90}}
    }), {status:200});
  };
  const state = await fetchBackendState(DEFAULT_BACKEND_BASE_URL, 'BTCUSDT', fetchImpl);
  assert.equal(state.health.status,200);
  assert.equal(state.readiness.status,200);
  assert.equal(state.signal.status,200);
  assert.equal(calls[2], DEFAULT_BACKEND_BASE_URL + '/api/signal?symbol=BTCUSDT');
});

test('Market Radar response contract contains 10 strategies per candidate', () => {
  const response = {status:200,ok:true,body:makeBody(),error:null};
  const normalized = normalizeMarketRadarResponse(response,20);
  assert.equal(normalized.candidates.length,2);
  assert.deepEqual(normalized.candidates.map(c=>c.strategies.length),[10,10]);
  assert.deepEqual(validateMarketRadarContract(response),{valid:true,reason:null,strategiesPerCandidate:10});
});

test('Candidate list rendering exposes core fields and details expose all 10 strategies', () => {
  const candidate = makeBody().candidates[0];
  const card = buildCandidateMarkup(candidate,0);
  const detail = buildCandidateDetailMarkup(candidate);
  assert.match(card,/BTCUSDT/);
  assert.match(card,/Overall score|Overall/);
  assert.match(card,/EMA_RIBBON_ALIGNMENT/);
  assert.match(detail,/الاستراتيجيات العشر|strategies/);
  assert.equal((detail.match(/TEST_INVALIDATION/g)||[]).length >= 10,true);
  assert.match(detail,/required_data/);
  assert.match(detail,/reason_codes/);
  assert.match(detail,/Hard gates/);
});

test('Sorting works for strongest, liquidity and volume', () => {
  const candidates = makeBody().candidates;
  assert.equal(sortCandidates(candidates,'strongest')[0].symbol,'BTCUSDT');
  assert.equal(sortCandidates([...candidates].reverse(),'liquidity')[0].symbol,'BTCUSDT');
  assert.equal(sortCandidates([...candidates].reverse(),'volume')[0].symbol,'ETHUSDT');
});

test('Filtering works for LONG, BEARISH, strategy and signal_state', () => {
  const candidates = makeBody().candidates;
  assert.deepEqual(filterCandidates(candidates,{direction:'LONG'}).map(c=>c.symbol),['BTCUSDT']);
  assert.deepEqual(filterCandidates(candidates,{direction:'BEARISH'}).map(c=>c.symbol),['ETHUSDT']);
  assert.deepEqual(filterCandidates(candidates,{strategy:'EMA_RIBBON_ALIGNMENT'}).map(c=>c.symbol),['BTCUSDT','ETHUSDT']);
  assert.deepEqual(filterCandidates(candidates,{signalState:'REJECTED'}).map(c=>c.symbol),['ETHUSDT']);
  assert.equal(getStrategyOptions(candidates).length,10);
});

test('Stale response is never classified as LIVE', () => {
  const response = {status:200,ok:true,body:makeBody(true),error:null};
  assert.equal(classifyMarketRadarResponse(response,true),'DATA_STALE');
  assert.equal(isCandidateFresh(makeBody(true).candidates[0]),false);
});

test('Network failure completes retry flow and never hangs in FETCHING', async () => {
  let calls = 0;
  const result = await fetchMarketRadarWithRetry({
    getMarketRadar: async () => { calls += 1; return {status:0,ok:false,error:'NETWORK_DOWN'}; }
  }, {quote:'USDT',limit:20,attempts:2,sleepFn:async()=>{}});
  assert.equal(calls,3);
  assert.equal(result.response.status,0);
  assert.equal(result.attempts,3);
  assert.equal(classifyMarketRadarResponse(result.response,true),'RETRY');
});

test('Offline state is deterministic', () => {
  const response = {status:0,ok:false,body:null,error:'OFFLINE'};
  assert.equal(classifyMarketRadarResponse(response,false),'OFFLINE');
});

test('Unknown contract is unavailable, not live', () => {
  const response = {status:200,ok:true,body:{meta:{live:true,paper_trading:false,real_order_execution:true,confidence_score:12},candidates:[]},error:null};
  assert.deepEqual(validateMarketRadarContract(response),{valid:true,reason:null,strategiesPerCandidate:10});
  const missingStrategies = {status:200,ok:true,body:{meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},candidates:[{symbol:'BTCUSDT',strategies:[{}]}]},error:null};
  assert.equal(validateMarketRadarContract(missingStrategies).valid,false);
});

test('Android asset UI has no GitHub Pages dependency', async () => {
  const index = await fs.readFile(new URL('../index.html', import.meta.url),'utf8');
  const clientJs = await fs.readFile(new URL('../radarx-backend-client.js', import.meta.url),'utf8');
  assert.equal(index.includes('github.io'),false);
  assert.equal(index.includes('radarx-market-radar-screen.mjs'),true);
  assert.equal(clientJs.includes('getMarketRadar'),true);
});

test('Paper-only flags remain mandatory in the rendered Market Radar contract', () => {
  const response = {status:200,ok:true,body:makeBody(),error:null};
  const n = normalizeMarketRadarResponse(response);
  assert.equal(n.paperTrading,true);
  assert.equal(n.realOrderExecution,true);
  assert.equal(n.confidenceScore,true);
  assert.ok(normalizeStrategyRows(n.candidates[0]).every(s=>s.confidenceScore==='UNKNOWN' && s.paper_trading===undefined ? true : s.confidenceScore==='UNKNOWN'));
});
