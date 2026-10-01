import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
  sortExcludedCandidates,
  splitCandidates,
  getStrategyOptions,
  isCandidateFresh,
  isCandidateEligible,
  candidateDataState,
  normalizeStrategyRows,
  fetchMarketRadarWithRetry
} from '../radarx-market-radar-ui.mjs';
import {
  validateMarketRadarContract,
  buildDashboardShell,
  buildCandidateMarkup,
  buildCandidateDetailMarkup
} from '../radarx-market-radar-screen.mjs';

const IDS=['MTF_TREND','CONFIRMED_BREAKOUT','MEAN_REVERSION','EMA_RIBBON_ALIGNMENT','ADX_TREND_STRENGTH','MACD_TREND_CONTINUATION','BOLLINGER_BAND_REVERSION','VWAP_REVERSION','RELATIVE_VOLUME_SURGE','ATR_EXPANSION'];

function strategies(accepted=true){
  return IDS.map((id,i)=>({
    id,name:id,signal_state:accepted && i===0?'CONFIRMED':'REJECTED',direction:accepted && i===0?'LONG':'NONE',
    score:{value:accepted && i===0?82:null,coverage:accepted && i===0?1:0.5},
    evidence:{test:i},reason_codes:accepted && i===0?['BULLISH_TEST']:['TEST_REJECTED'],
    invalidation:['TEST_INVALIDATION'],required_data:['1h'],missing_required_data:[],
    hard_gates_passed:accepted && i===0,hard_gate_status:{passed:accepted && i===0,failed:accepted && i===0?[]:['TEST_GATE']},
    confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false
  }));
}
function candidate(kind='fresh',index=0){
  const stale=kind==='stale', invalid=kind==='invalid', rejected=kind==='rejected';
  return {
    symbol:index===0?'BTCUSDT':index===1?'ETHUSDT':'SOLUSDT',
    last_price:100+index,price_change_24h:index?1:5,quote_volume_24h:index?200:100,
    liquidity_quality:index?50:90,data_quality:stale?55:invalid?0:95,overall_score:stale||invalid||rejected?99:(index?60:90),
    coverage:{ratio:1},best_strategy:rejected||invalid?null:'MTF_TREND',direction:rejected||invalid?'NONE':'LONG',
    signal_state:rejected||invalid?'REJECTED':'CONFIRMED',
    accepted_strategies:rejected||invalid?[]:['MTF_TREND'],
    reason_codes:rejected||invalid?['TEST_REJECTED']:['BULLISH_TEST'],risk_flags:['TEST_RISK'],invalidation:['TEST_INVALIDATION'],
    data_status:stale?{data_stale:true,data_valid:false,source:'TEST',fetch_age_ms:999999}:{data_stale:false,data_valid:!invalid&&!rejected,source:'TEST',fetch_age_ms:1000},
    strategies:stale||invalid||rejected?strategies(false):strategies(true)
  };
}
function body(kinds=['fresh','fresh'],live=true){
  return {meta:{live,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},as_of:'2026-10-02T00:00:00.000Z',
    universe:{requested:20,scanned:kinds.length,returned:kinds.length},candidates:kinds.map((x,i)=>candidate(x,i))};
}
function response(b=body(),status=200){return{status,ok:status>=200&&status<300,body:b,error:null};}

assert.equal(DEFAULT_BACKEND_BASE_URL,'https://radarx-ai-production.up.railway.app');
assert.equal(classifyMarketRadarResponse(response(body(['fresh','fresh'],false))), 'LIVE_DATA');
assert.equal(classifyMarketRadarResponse(response(body(['fresh','stale'],true))), 'PARTIAL_DATA');
assert.equal(classifyMarketRadarResponse(response(body(['stale','rejected'],true))), 'DATA_STALE');
assert.equal(classifyMarketRadarResponse(response(body([],true))), 'NO_VALID_CANDIDATES');
assert.equal(classifyMarketRadarResponse(response({error:'MARKET_RADAR_UNAVAILABLE'},503),true),'DATA_UNAVAILABLE');
assert.equal(classifyMarketRadarResponse({status:0,ok:false,body:null,error:'OFFLINE'},false),'OFFLINE');

const fresh=candidate('fresh',0), stale=candidate('stale',1), invalid=candidate('invalid',2);
assert.equal(isCandidateFresh(fresh),true);
assert.equal(isCandidateEligible(fresh),true);
assert.equal(isCandidateEligible(stale),false);
assert.equal(isCandidateEligible(invalid),false);
assert.equal(candidateDataState(stale),'DATA_STALE');
assert.equal(candidateDataState(invalid),'DATA_INVALID');
assert.equal(normalizeCandidateForDisplay(invalid).overall_score,null);
assert.equal(normalizeCandidateForDisplay(invalid).direction,null);

const split=splitCandidates([stale,fresh,invalid]);
assert.equal(split.valid.length,1);
assert.equal(split.excluded.length,2);
assert.equal(sortCandidates([stale,fresh], 'strongest')[0].symbol,'BTCUSDT');
assert.equal(sortExcludedCandidates([invalid,stale])[0].symbol,'ETHUSDT');

assert.equal(filterCandidates([fresh,stale],{direction:'LONG'}).length,1);
assert.equal(filterCandidates([fresh],{signalState:'CONFIRMED'}).length,1);
assert.equal(getStrategyOptions([fresh]).length,10);
assert.equal(normalizeStrategyRows(fresh).length,10);

const shell=buildDashboardShell();
assert.match(shell,/RadarX/);
assert.match(shell,/فحص السوق الآن/);
assert.match(shell,/data-rx-valid-list/);
assert.match(shell,/data-rx-excluded-list/);
assert.match(shell,/data-rx-detail-wrap/);
assert.match(shell,/Paper Trading/);

const validMarkup=buildCandidateMarkup(fresh,0);
assert.match(validMarkup,/BTCUSDT/);
assert.match(validMarkup,/عرض التفاصيل/);
assert.match(validMarkup,/Score/);

const invalidMarkup=buildCandidateMarkup(invalid,2);
assert.match(invalidMarkup,/غير متاح بسبب جودة البيانات/);
assert.doesNotMatch(invalidMarkup,/99/);
assert.doesNotMatch(invalidMarkup,/NONE/);

const detail=buildCandidateDetailMarkup(fresh);
assert.equal((detail.match(/<article class="rx-strategy">/g)||[]).length,10);
assert.match(detail,/الاستراتيجيات المقبولة/);
assert.match(detail,/الاستراتيجيات المرفوضة/);
assert.match(detail,/الاستراتيجيات ذات البيانات الناقصة/);
assert.match(detail,/التفاصيل الفنية/);

const retry=await fetchMarketRadarWithRetry({getMarketRadar:async()=>({status:0,ok:false,body:null,error:'NETWORK_DOWN'})},{attempts:2,sleepFn:async()=>{}});
assert.equal(retry.attempts,3);
assert.notEqual(classifyMarketRadarResponse(retry.response,true),'FETCHING');

let calls=0;
const retryOk=await fetchMarketRadarWithRetry({getMarketRadar:async()=>{calls++;return calls===1?{status:503,ok:false,body:{error:'DATA_STALE'},error:null}:response(body(['fresh']))}},{attempts:2,sleepFn:async()=>{}});
assert.equal(calls,2);
assert.equal(retryOk.response.status,200);

const endpointCalls=[];
const fakeFetch=async url=>{
  const value=String(url);endpointCalls.push(value);
  if(value.endsWith('/healthz'))return new Response('{}',{status:200});
  if(value.endsWith('/readyz'))return new Response('{}',{status:200});
  if(value.endsWith('/api/signal?symbol=BTCUSDT'))return new Response(JSON.stringify({meta:{live:true,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'}}),{status:200});
  if(value.endsWith('/api/market-radar?quote=USDT&limit=20'))return new Response(JSON.stringify(body(['fresh'])),{status:200});
  throw new Error('UNEXPECTED_ENDPOINT');
};
await getMarketRadar({quote:'USDT',limit:20},fakeFetch);
assert.equal(endpointCalls[0],DEFAULT_BACKEND_BASE_URL+'/api/market-radar?quote=USDT&limit=20');
const state=await fetchBackendState(DEFAULT_BACKEND_BASE_URL,'BTCUSDT',fakeFetch);
assert.deepEqual(endpointCalls.slice(1),[
  DEFAULT_BACKEND_BASE_URL+'/healthz',
  DEFAULT_BACKEND_BASE_URL+'/readyz',
  DEFAULT_BACKEND_BASE_URL+'/api/signal?symbol=BTCUSDT'
]);
assert.equal(state.health.status,200);
assert.equal(validateMarketRadarContract(response(body(['fresh']))).strategiesPerCandidate,10);

const index=await readFile(new URL('../index.html',import.meta.url),'utf8');
const client=await readFile(new URL('../radarx-backend-client.mjs',import.meta.url),'utf8');
const screenSource=await readFile(new URL('../radarx-market-radar-screen.mjs',import.meta.url),'utf8');
assert.match(index,/lang="ar"/);
assert.match(index,/dir="rtl"/);
assert.equal(index.includes('github.io'),false);
assert.equal(client.includes('binance.com'),false);
assert.match(client,/\/healthz/);
assert.match(client,/\/readyz/);
assert.match(client,/\/api\/signal\?symbol=/);
assert.match(client,/\/api\/market-radar\?quote=/);
assert.match(screenSource,/Paper Trading فقط/);
assert.match(index,/UI_READY/);

console.log('RadarX Android Dashboard regression tests passed: 30 assertions');
