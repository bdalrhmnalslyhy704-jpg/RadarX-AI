import test from 'node:test';
import {rankBottomCandidates} from '../radarx-bottom-reversal.mjs';
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

const IDS=['MTF_TREND','CONFIRMED_BREAKOUT','MEAN_REVERSION','VCP_PRE_BREAKOUT','EMA_RIBBON_ALIGNMENT','ADX_TREND_STRENGTH','MACD_TREND_CONTINUATION','BOLLINGER_BAND_REVERSION','VWAP_REVERSION','RELATIVE_VOLUME_SURGE','ATR_EXPANSION','FRACTAL_MA_BOTTOM_REVERSAL','FRACTAL_MA_BREAKOUT','FRACTAL_MA_TREND_SHIFT'];

function strategies(accepted=true){
  return IDS.map((id,i)=>({
    id,name:id,signal_state:accepted && i===0?'CONFIRMED':accepted && i===3?'CANDIDATE':'REJECTED',direction:accepted && (i===0||i===3)?'LONG':'NONE',
    score:{value:accepted && i===0?82:accepted && i===3?79:null,coverage:accepted && (i===0||i===3)?1:0.5},
    evidence:{test:i},reason_codes:accepted && i===0?['BULLISH_TEST']:['TEST_REJECTED'],
    invalidation:['TEST_INVALIDATION'],required_data:['1h'],missing_required_data:[],
    hard_gates_passed:accepted && (i===0||i===3),hard_gate_status:{passed:accepted && (i===0||i===3),failed:accepted && (i===0||i===3)?[]:['TEST_GATE']},
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
    accepted_strategies:rejected||invalid?[]:['MTF_TREND','VCP_PRE_BREAKOUT'],
    reason_codes:rejected||invalid?['TEST_REJECTED']:['BULLISH_TEST'],risk_flags:['TEST_RISK'],invalidation:['TEST_INVALIDATION'],
    data_status:stale?{data_stale:true,data_valid:false,source:'TEST',fetch_age_ms:999999}:{data_stale:false,data_valid:!invalid&&!rejected,source:'TEST',fetch_age_ms:1000},
    best_strategy:rejected||invalid?null:'VCP_PRE_BREAKOUT',
    pre_breakout_fingerprint:{version:'prebreakout-fingerprint.v1',detected:!stale&&!invalid&&!rejected,stage:'PRE-BREAKOUT',score:82,trapRisk:18,evidenceCount:6,reasonCodes:['HL_EMERGING','COMPRESSION','VOLUME_AWAKENING','RELATIVE_POWER_INCREASING','SELL_PRESSURE_DECLINING'],evidence:{structure:{score:90,status:'HL_EMERGING'},compression:{score:80,status:'TIGHT'},volume:{score:75,status:'ACCELERATING'},relative_power:{score:78,status:'INCREASING'},resistance:{score:70,status:'TESTING',tests:2},order_flow:{score:72,status:'BUYING_PRESSURE'},regime:{score:75,status:'SUPPORTIVE'},trigger:{score:60,status:'NEAR_RESISTANCE'}},resistance:{remainingTests:1},context:{breakout:false,retest:false,falseBreakout:false},journey:[{stage:'BUILDING',at:1727827200000,score:60},{stage:'PRE-BREAKOUT',at:1727830800000,score:82}],historical:{samples:8,lookaheadBars:16,successfulSamples:4,descriptiveSuccessRatePct:50,analogs:[]}},
    strategies:stale||invalid||rejected?strategies(false):strategies(true)
  };
}
function body(kinds=['fresh','fresh'],live=true){
  return {meta:{live,paper_trading:true,real_order_execution:false,confidence_score:'UNKNOWN'},as_of:'2026-10-02T00:00:00.000Z',
    universe:{requested:20,scanned:kinds.length,returned:kinds.length},candidates:kinds.map((x,i)=>candidate(x,i))};
}
function response(b=body(),status=200){return{status,ok:status>=200&&status<300,body:b,error:null};}

assert.equal(DEFAULT_BACKEND_BASE_URL,'https://radarx-ai-triple-production.up.railway.app');
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
assert.equal(getStrategyOptions([fresh]).length,14);
assert.equal(normalizeStrategyRows(fresh).length,14);

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
assert.match(validMarkup,/PRE BREAKOUT/);
assert.match(validMarkup,/Trap/);
assert.match(validMarkup,/6 \/ 8/);
assert.match(validMarkup,/PRE BREAKOUT/);

const invalidMarkup=buildCandidateMarkup(invalid,2);
assert.match(invalidMarkup,/غير متاح بسبب جودة البيانات/);
assert.doesNotMatch(invalidMarkup,/99/);
assert.doesNotMatch(invalidMarkup,/NONE/);

const detail=buildCandidateDetailMarkup(fresh);
assert.equal((detail.match(/<article class="rx-strategy">/g)||[]).length,14);
assert.match(detail,/الاستراتيجيات المقبولة/);
assert.match(detail,/الاستراتيجيات المرفوضة/);
assert.match(detail,/الاستراتيجيات ذات البيانات الناقصة/);
assert.match(detail,/التفاصيل الفنية/);
assert.match(detail,/Pre-Breakout Fingerprint/);
assert.match(detail,/History Engine/);
assert.match(detail,/Relative Power/);
assert.match(detail,/Journey:/);

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
assert.equal(validateMarketRadarContract(response(body(['fresh']))).strategiesPerCandidate,14);
const fifteen=body(['fresh']);
fifteen.candidates[0].strategies.push({
  id:'SUPPORT_RESISTANCE_CONFIRMATION',name:'SUPPORT_RESISTANCE_CONFIRMATION',signal_state:'CANDIDATE',direction:'LONG',
  score:{value:78,coverage:1},evidence:{test:'support-resistance'},reason_codes:['SUPPORT_BOUNCE_CONFIRMATION'],invalidation:['SUPPORT_LOST'],
  required_data:['15m'],missing_required_data:[],hard_gates_passed:true,hard_gate_status:{passed:true,failed:[]},
  confidence_score:'UNKNOWN',paper_trading:true,real_order_execution:false
});
assert.equal(validateMarketRadarContract(response(fifteen)).strategiesPerCandidate,15);
const eleven=body(['fresh']);
eleven.candidates[0].strategies=eleven.candidates[0].strategies.slice(0,11);
assert.equal(validateMarketRadarContract(response(eleven)).valid,false);
assert.equal(validateMarketRadarContract(response(eleven)).reason,'STRATEGY_COUNT_UNSUPPORTED');

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
assert.match(index,/openBottomRadarBtn/);
assert.match(index,/openPreMoveRadarBtn/);
assert.match(index,/pre-move-radar.html/);
assert.match(index,/openBottomRadar\(\)/);
const indexHtml=index;
const bgControl=await readFile(new URL('../radarx-background-control.mjs',import.meta.url),'utf8');
const manifest=await readFile(new URL('../../AndroidManifest.xml',import.meta.url),'utf8');
const mainActivity=await readFile(new URL('../../java/com/radarx/app/MainActivity.java',import.meta.url),'utf8');
const tradliActivity=await readFile(new URL('../../java/com/radarx/app/TradliActivity.java',import.meta.url),'utf8');
const backgroundServiceSourceForMove=await readFile(new URL('../../java/com/radarx/app/RadarXBackgroundMonitorService.java',import.meta.url),'utf8');
assert.match(backgroundServiceSourceForMove,/fetchRadarAlertsFeed/);
assert.match(backgroundServiceSourceForMove,/notifyNewRadarAlerts/);
assert.match(backgroundServiceSourceForMove,/api\/radar-alerts\?radar=ALL/);
assert.match(backgroundServiceSourceForMove,/LIQUIDITY_ABSORPTION_RADAR/);
assert.match(backgroundServiceSourceForMove,/detected_time_12h/);
assert.match(backgroundServiceSourceForMove,/formatTimestamp12h/);
assert.match(backgroundServiceSourceForMove,/setReadTimeout\(30_000\)/);
const backgroundService=await readFile(new URL('../../java/com/radarx/app/RadarXBackgroundMonitorService.java',import.meta.url),'utf8');
assert.match(indexHtml,/backgroundMonitorPanel/);
assert.match(indexHtml,/mountBackgroundMonitorControl/);
assert.match(bgControl,/الرادارات المستقلة/);
assert.match(bgControl,/Radar 1 — Early-Wake/);
assert.match(bgControl,/Radar 2 — Strong-Move/);
assert.match(bgControl,/Radar 3 — Rotation\/Lag/);
assert.match(bgControl,/Radar 4 — Liquidity Absorption/);
assert.match(bgControl,/تشغيل هذا الرادار/);
assert.match(bgControl,/إيقاف هذا الرادار/);
assert.match(client,/getRadarStatus/);
assert.match(client,/getRadarAlerts/);
assert.match(client,/setRadarState/);
assert.match(client,/\/api\/radar-status/);
assert.match(client,/\/api\/radar-alerts/);
assert.match(client,/\/api\/radar-control/);
assert.match(mainActivity,/startBackgroundMonitor/);
assert.equal(mainActivity.includes('setReadTimeout(60000)'),true);
assert.match(tradliActivity,/TRADLI — AI Trading Analysis/);
assert.equal(tradliActivity.includes('setReadTimeout(30000)'),true);
assert.match(manifest,/TradliActivity/);
assert.match(mainActivity,/stopBackgroundMonitor/);
assert.match(manifest,/FOREGROUND_SERVICE_DATA_SYNC/);
assert.match(manifest,/RadarXBackgroundMonitorService/);
assert.match(manifest,/foregroundServiceType="specialUse"/);
assert.match(manifest,/PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
assert.match(manifest,/continuous RadarX market alert monitoring/);
assert.equal(backgroundService.includes('/api/v3/order'),false);
const movePage=await readFile(new URL('../move-radar.html',import.meta.url),'utf8');
const moveEngine=await readFile(new URL('../radarx-move-radar.mjs',import.meta.url),'utf8');
assert.match(movePage,/Pre-Explosion Radar/);
assert.match(movePage,/ما قبل الانفجار/);
assert.match(movePage,/24\/7 Backend/);
assert.match(movePage,/التنبيهات/);
assert.match(movePage,/a\.event==='PRE_EXPLOSION_ALERT'/);
assert.match(movePage,/Number\(a\.movePct\)<=1\.25/);
assert.match(moveEngine,/normalizeMoveAlerts/);
assert.match(moveEngine,/HIGH_EXPANSION_SETUP/);
assert.match(client,/\/api\/move-radar\?quote=/);

const preMovePage=await readFile(new URL('../pre-move-radar.html',import.meta.url),'utf8');
const preMoveEngine=await readFile(new URL('../radarx-pre-move.mjs',import.meta.url),'utf8');
assert.match(preMovePage,/Pre‑Move Radar/);
assert.match(preMovePage,/قبل الحركة/);
assert.match(preMovePage,/04:00/);
assert.match(preMovePage,/Taker Buy/);
assert.match(preMovePage,/تسارع الحجم/);
assert.match(preMovePage,/القوة النسبية/);
assert.match(preMovePage,/ضغط الحيتان/);
assert.match(preMovePage,/لا يوجد توقع مضمون/);
assert.match(preMoveEngine,/rankPreMoveCandidates/);
assert.match(preMoveEngine,/ALREADY_MOVED/);
assert.match(preMoveEngine,/VOLUME_ACCELERATING/);
const bottomPage=await readFile(new URL('../bottom-radar.html',import.meta.url),'utf8');
const bottomSample={candidates:[{
  symbol:'TESTUSDT',last_price:1.25,price_change_24h:-6,liquidity_quality:88,data_quality:95,
  data_status:{data_valid:true},
  bottom_context:{
    metrics:{
      buying_pressure:82,selling_exhaustion:76,compression:72,momentum:71,structure:78,
      whale_pressure:84,orderbook_imbalance:81,taker_buy_ratio:.67,mtf_alignment:79,
      bos_up:true,higher_low:true,composite_algorithm_score:78
    },
    algorithms:{
      rsi14:{value:29,score:84,bullish_divergence:true},
      stochastic14:{k:18,score:90},obv_accumulation:{score:78},
      volume_price_divergence:{score:80,rvol_ratio:1.42},ema20_50_reclaim:{score:74},
      wyckoff_spring:{score:88,spring_confirmed:true},vwap_position:{score:76,vwap:1.21},
      price_structure:{score:82},taker_flow:{score:84},orderbook_pressure:{score:81},
      whale_pressure:{score:84,heuristic:true},sell_exhaustion:{score:76},
      squeeze:{score:72},momentum_awaken:{score:71},mtf_alignment:{score:79}
    },
    current_price:1.25,high_24h:1.42,low_24h:1.18,range_position_pct:29,
    last_rise:{high:1.34,low:1.16,rise_pct:15.5,drawdown_from_high_pct:6.7,recovery_from_low_pct:7.8}
  },
  strategies:[
    {id:'MEAN_REVERSION',score:{value:78},signal_state:'CANDIDATE'},
    {id:'BOLLINGER_BAND_REVERSION',score:{value:82},signal_state:'CANDIDATE'},
    {id:'VCP_PRE_BREAKOUT',score:{value:80},signal_state:'CANDIDATE'},
    {id:'RELATIVE_VOLUME_SURGE',score:{value:79},signal_state:'CANDIDATE'},
    {id:'VWAP_REVERSION',score:{value:76},signal_state:'CANDIDATE'},
    {id:'MACD_TREND_CONTINUATION',score:{value:72},signal_state:'CANDIDATE'},
    {id:'EMA_RIBBON_ALIGNMENT',score:{value:68},signal_state:'CANDIDATE'},
    {id:'ADX_TREND_STRENGTH',score:{value:70},signal_state:'CANDIDATE'},
    {id:'ATR_EXPANSION',score:{value:74},signal_state:'CANDIDATE'},
    {id:'MTF_TREND',score:{value:73},signal_state:'CANDIDATE'}
  ]
}]};
const bottomRows=rankBottomCandidates(bottomSample);
assert.equal(bottomRows.length,1);
assert.equal(bottomRows[0].symbol,'TESTUSDT');
assert.ok(bottomRows[0].score>65);
assert.ok(bottomRows[0].buyingPressure>70);
assert.ok(bottomRows[0].momentumAwakening>60);
assert.ok(bottomRows[0].sellingExhaustion>60);
assert.ok(bottomRows[0].compression>60);
assert.ok(bottomRows[0].structure>60);
assert.ok(bottomRows[0].whalePressure>60);
assert.equal(bottomRows[0].bosUp,true);
assert.equal(bottomRows[0].higherLow,true);

const bottomEngine=await readFile(new URL('../radarx-bottom-reversal.mjs',import.meta.url),'utf8');
assert.match(bottomPage,/Bottom Reversal Radar/);
assert.match(bottomPage,/فحص القيعان الآن/);
assert.match(bottomPage,/selected>10 عملات/);
assert.match(bottomPage,/const scanLimits=\[requestedLimit\]/);
assert.match(bottomPage,/LIVE MARKET/);
assert.match(bottomPage,/horizons/);
assert.match(bottomEngine,/1–2 يوم/);
assert.match(bottomEngine,/5–7 أيام/);
assert.match(bottomEngine,/BOLLINGER_BAND_REVERSION/);
assert.match(bottomEngine,/VCP_PRE_BREAKOUT/);
assert.match(bottomEngine,/RELATIVE_VOLUME_SURGE/);
assert.match(bottomEngine,/MACD_TREND_CONTINUATION/);
assert.match(bottomEngine,/EMA_RIBBON_ALIGNMENT/);
assert.match(bottomEngine,/ADX_TREND_STRENGTH/);
assert.match(bottomEngine,/ATR_EXPANSION/);
assert.match(bottomEngine,/MTF_TREND/);
assert.match(bottomEngine,/bottomContextOf/);
assert.match(bottomEngine,/bottomAlgorithms/);
assert.match(bottomEngine,/taker_flow/);
assert.match(bottomEngine,/orderbook_pressure/);
assert.match(bottomEngine,/whale_pressure/);
assert.match(bottomEngine,/sell_exhaustion/);
assert.match(bottomEngine,/squeeze/);
assert.match(bottomEngine,/mtf_alignment/);
assert.match(bottomPage,/السعر الحالي/);
assert.match(bottomPage,/آخر قمة ارتفاع/);
assert.match(bottomPage,/قاع بداية آخر ارتفاع/);
assert.match(bottomPage,/RSI 14/);
assert.match(bottomPage,/Stochastic 14/);
assert.match(bottomPage,/Wyckoff Spring/);
assert.match(bottomPage,/Volume-Price/);
assert.match(bottomPage,/ضغط الحيتان/);
assert.match(bottomPage,/Order Book Imbalance/);
assert.match(bottomPage,/Taker Buy/);
assert.match(bottomPage,/Squeeze/);
assert.match(mainActivity,/openBottomRadar/);
assert.match(manifest,/BottomRadarActivity/);
const tradliPage=await readFile(new URL('../tradli.html',import.meta.url),'utf8');
assert.match(tradliPage,/TRADLI — AI Trading Analysis/);
assert.match(tradliPage,/mountTradliFeatureSuite/);
assert.match(tradliPage,/expected=\['chart','verify','advisor','hub','sd','desk'\]/);
assert.match(tradliPage,/TRADLI_PAGE_READY/);
assert.match(tradliPage,/اتصال بيانات TRADLI/);
assert.match(tradliPage,/فحص بيانات السوق الآن/);
assert.match(tradliPage,/requestJson/);

assert.equal(index.includes("mountTradliFeatureSuite"),false);
const suite=await readFile(new URL('../radarx-tradli-feature-suite.mjs',import.meta.url),'utf8');
assert.match(suite,/rxsuite-tab/);
assert.match(suite,/data-tab="desk"/);
assert.equal((suite.match(/data-tab="/g)||[]).length,6);
assert.match(suite,/orderDesk/);
assert.match(suite,/NO EXECUTION/);
assert.equal(suite.includes('/api/v3/order'),false);
assert.equal(/real_order_execution\\s*[:=]\\s*true/.test(suite),false);

console.log('RadarX Android Dashboard/background regression tests passed');

// PRE_MOVE_RADAR_RELEASE_TRIGGER

test('Radar 4 dedicated Android page exposes independent control and alert time source',async()=>{
  const page=await readFile(new URL('../radar4-liquidity-absorption.html',import.meta.url),'utf8');
  assert.match(page,/Radar 4 — Liquidity Absorption/);
  assert.match(page,/تشغيل Radar 4 فقط/);
  assert.match(page,/إيقاف Radar 4/);
  assert.match(page,/LIQUIDITY_ABSORPTION_RADAR/);
  assert.match(page,/detected_time_12h/);
  assert.match(page,/12h/);
});
