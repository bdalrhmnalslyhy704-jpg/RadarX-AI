import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {HISTORICAL_MATRIX_DEFAULT_SYMBOLS,HISTORICAL_MATRIX_DEFAULT_WINDOWS,HISTORICAL_MATRIX_REQUIRED_REGIMES,normalizeMatrixSymbols,normalizeMatrixWindows,classifyBtcMarketRegime,summarizeHistoricalWindowReport} from '../core/historical-replay-matrix.mjs';
function candles({start=1_700_000_000_000,count=24,open=100,close=100,low=99,high=101}={}){return Array.from({length:count},(_,i)=>({openTime:start+i*3_600_000,open:i===0?open:open,close,low,high,closed:true}));}
test('historical matrix defaults span at least thirty unique Spot USDT markets',()=>{assert.ok(HISTORICAL_MATRIX_DEFAULT_SYMBOLS.length>=30);assert.equal(new Set(HISTORICAL_MATRIX_DEFAULT_SYMBOLS).size,HISTORICAL_MATRIX_DEFAULT_SYMBOLS.length);assert.ok(HISTORICAL_MATRIX_DEFAULT_SYMBOLS.every(x=>/^[A-Z0-9]{5,20}$/.test(x)));assert.equal(HISTORICAL_MATRIX_DEFAULT_WINDOWS.length,3);assert.ok(HISTORICAL_MATRIX_DEFAULT_WINDOWS.every(w=>Date.parse(w.end)-Date.parse(w.start)===6*3_600_000),'default windows must be six-hour slices to keep full public trade coverage bounded');assert.deepEqual(HISTORICAL_MATRIX_REQUIRED_REGIMES,['BULL_TREND','BEAR_TREND','SIDEWAYS']);const selloff=HISTORICAL_MATRIX_DEFAULT_WINDOWS.find(w=>w.id==='early-2025-selloff-candidate');assert.equal(selloff.start,'2025-02-25T06:00:00.000Z');assert.equal(selloff.end,'2025-02-25T12:00:00.000Z');});
test('matrix windows are normalized, unique, chronological and limited to seven days',()=>{const w=normalizeMatrixWindows([{id:'bull',start:'2025-01-01T00:00:00Z',end:'2025-01-02T00:00:00Z'}],{now:Date.parse('2025-01-03T00:00:00Z')});assert.equal(w[0].id,'bull');assert.equal(w[0].endMs-w[0].startMs,86_400_000);assert.throws(()=>normalizeMatrixWindows([{id:'x',start:'2025-01-01',end:'2025-01-10'}],{now:Date.parse('2025-01-11')}),/OVER_SEVEN_DAYS/);assert.throws(()=>normalizeMatrixWindows([{id:'x',start:'2025-01-01',end:'2025-01-02'},{id:'x',start:'2025-01-02',end:'2025-01-03'}],{now:Date.parse('2025-01-04')}),/DUPLICATE/);});
test('market regime classification uses observed BTC direction and range',()=>{const bull=classifyBtcMarketRegime(candles({open:100,close:104,low:99,high:105}));assert.equal(bull.regime,'BULL_TREND');const bear=classifyBtcMarketRegime(candles({open:100,close:96,low:95,high:101}));assert.equal(bear.regime,'BEAR_TREND');const sideways=classifyBtcMarketRegime(candles({open:100,close:100.5,low:99,high:101}));assert.equal(sideways.regime,'SIDEWAYS');const mixed=classifyBtcMarketRegime(candles({open:100,close:101,low:96,high:106}));assert.equal(mixed.regime,'MIXED');assert.equal(classifyBtcMarketRegime([]).regime,'UNKNOWN');});
test('required historical regime coverage includes a bearish-market window',()=>{
  const observed=['BULL_TREND','SIDEWAYS'];
  assert.deepEqual(HISTORICAL_MATRIX_REQUIRED_REGIMES.filter(x=>!observed.includes(x)),['BEAR_TREND']);
  const withBear=[...observed,'BEAR_TREND'];
  assert.equal(HISTORICAL_MATRIX_REQUIRED_REGIMES.every(x=>withBear.includes(x)),true);
});
test('historical coverage summaries never convert incomplete data into success',()=>{const summary=summarizeHistoricalWindowReport({symbol_count:2,results:[{data_quality:{trade_coverage_complete:true,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'FULL_TRADE',synthetic_data_used:false},summary:{replay_steps:10,accepted:2,rejected:4,first_accepted_at:'2025-01-01T00:00:00.000Z'}},{data_quality:{trade_coverage_complete:false,candle_fetch_complete:true},summary:{accepted:1,rejected:3}}]});assert.equal(summary.coverage_status,'INCOMPLETE_OR_EMPTY');assert.equal(summary.coverage_complete_symbols,1);assert.equal(summary.coverage_incomplete_symbols,1);assert.equal(summary.accepted_decisions,3);assert.equal(summary.rejected_decisions,7);const missing=summarizeHistoricalWindowReport({symbol_count:3,results:[{data_quality:{trade_coverage_complete:true,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'FULL_TRADE',synthetic_data_used:false},summary:{replay_steps:10}}]});assert.equal(missing.coverage_status,'INCOMPLETE_OR_EMPTY');assert.equal(missing.coverage_incomplete_symbols,2);});

test('matrix CLI dry-run validates the 30-symbol by three-window plan without network access',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-replay-matrix.mjs');
  const run=spawnSync(process.execPath,[script,'--dry-run'],{encoding:'utf8',timeout:10_000});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const plan=JSON.parse(run.stdout);
  assert.equal(plan.status,'DRY_RUN_NO_NETWORK');
  assert.equal(plan.symbol_count,30);
  assert.equal(plan.window_count,3);
  assert.equal(plan.planned_symbol_window_replays,90);
  assert.equal(plan.policy.real_order_execution,false);
});
test('matrix counts explicit closed-candle fallback without mislabeling exact trade coverage',()=>{
  const summary=summarizeHistoricalWindowReport({symbol_count:2,results:[
    {data_quality:{trade_coverage_complete:true,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'FULL_TRADE',synthetic_data_used:false},summary:{replay_steps:10,accepted:1,rejected:9}},
    {data_quality:{trade_coverage_complete:false,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'CANDLE_ONLY_FALLBACK',candle_only_fallback_used:true,synthetic_data_used:false},summary:{replay_steps:10,accepted:0,rejected:10}}
  ]});
  assert.equal(summary.coverage_status,'COMPLETE_WITH_CANDLE_FALLBACK');
  assert.equal(summary.coverage_complete_symbols,2);
  assert.equal(summary.trade_coverage_complete_symbols,1);
  assert.equal(summary.candle_fallback_symbols,1);
  assert.equal(summary.coverage_incomplete_symbols,0);
});
