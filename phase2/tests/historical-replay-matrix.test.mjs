import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {HISTORICAL_MATRIX_DEFAULT_SYMBOLS,HISTORICAL_MATRIX_MOVER_FOCUS_SYMBOLS,HISTORICAL_MATRIX_DEFAULT_WINDOWS,HISTORICAL_MATRIX_REQUIRED_REGIMES,normalizeMatrixSymbols,normalizeMatrixWindows,classifyBtcMarketRegime,summarizeHistoricalWindowReport} from '../core/historical-replay-matrix.mjs';
function candles({start=1_700_000_000_000,count=24,open=100,close=100,low=99,high=101}={}){return Array.from({length:count},(_,i)=>({openTime:start+i*3_600_000,open:i===0?open:open,close,low,high,closed:true}));}
test('historical matrix defaults span at least thirty unique Spot USDT markets',()=>{assert.ok(HISTORICAL_MATRIX_DEFAULT_SYMBOLS.length>=30);assert.equal(new Set(HISTORICAL_MATRIX_DEFAULT_SYMBOLS).size,HISTORICAL_MATRIX_DEFAULT_SYMBOLS.length);assert.ok(HISTORICAL_MATRIX_DEFAULT_SYMBOLS.every(x=>/^[A-Z0-9]{5,20}$/.test(x)));assert.equal(HISTORICAL_MATRIX_DEFAULT_WINDOWS.length,3);assert.ok(HISTORICAL_MATRIX_DEFAULT_WINDOWS.every(w=>Date.parse(w.end)-Date.parse(w.start)===6*3_600_000),'default windows must be six-hour slices to keep full public trade coverage bounded');assert.deepEqual(HISTORICAL_MATRIX_REQUIRED_REGIMES,['BULL_TREND','BEAR_TREND','SIDEWAYS']);const selloff=HISTORICAL_MATRIX_DEFAULT_WINDOWS.find(w=>w.id==='early-2025-selloff-candidate');assert.equal(selloff.start,'2025-02-25T06:00:00.000Z');assert.equal(selloff.end,'2025-02-25T12:00:00.000Z');});
test('default historical matrix keeps the recent high-mover cohort under regression coverage',()=>{
  assert.deepEqual(HISTORICAL_MATRIX_MOVER_FOCUS_SYMBOLS,['IOSTUSDT','ALTUSDT','WUSDT','CVXUSDT','ENAUSDT']);
  assert.ok(HISTORICAL_MATRIX_MOVER_FOCUS_SYMBOLS.every(symbol=>HISTORICAL_MATRIX_DEFAULT_SYMBOLS.includes(symbol)));
  assert.equal(HISTORICAL_MATRIX_DEFAULT_SYMBOLS.length,30,'keep bounded 30-symbol matrix cost');
  assert.equal(new Set(HISTORICAL_MATRIX_DEFAULT_SYMBOLS).size,30,'focused symbols must not duplicate the matrix');
  assert.ok(HISTORICAL_MATRIX_DEFAULT_SYMBOLS.every(symbol=>/^[A-Z0-9]{5,20}$/.test(symbol)));
});

test('hybrid fixed-SHA research matrix captures 33 unique historical Spot USDT symbols',()=>{
  const path=resolve(dirname(fileURLToPath(import.meta.url)),'../benchmarks/hybrid-tcn-attention-symbols.json');
  const symbols=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(symbols.length,33);
  assert.equal(new Set(symbols).size,33);
  assert.ok(symbols.every(symbol=>/^[A-Z0-9]{5,20}$/.test(symbol)&&symbol.endsWith('USDT')));
  assert.ok(['ATOMUSDT','UNIUSDT','ETCUSDT'].every(symbol=>symbols.includes(symbol)));
});
test('expanded hybrid benchmark includes later listing-aware windows for missed riser assets',()=>{
  const path=resolve(dirname(fileURLToPath(import.meta.url)),'../benchmarks/hybrid-tcn-attention-windows.json');
  const windows=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(windows.length,9);
  assert.deepEqual(windows.slice(0,3).map(w=>Date.parse(w.end)-Date.parse(w.start)),[48,24,48].map(h=>h*3_600_000));
  assert.ok(windows.slice(3).every(w=>Date.parse(w.start)>=Date.parse('2025-05-28T13:00:00.000Z')));
  assert.ok(windows.every((w,i)=>i===0||Date.parse(w.start)>=Date.parse(windows[i-1].end)));
  const missed=['PARTIUSDT','BEAMXUSDT','SOLVUSDT','SOPHUSDT'];
  for(const window of windows.slice(3)) assert.ok(missed.every(symbol=>window.symbols.includes(symbol)));
});
test('matrix windows are normalized, unique, chronological and limited to seven days',()=>{const w=normalizeMatrixWindows([{id:'bull',start:'2025-01-01T00:00:00Z',end:'2025-01-02T00:00:00Z'}],{now:Date.parse('2025-01-03T00:00:00Z')});assert.equal(w[0].id,'bull');assert.equal(w[0].endMs-w[0].startMs,86_400_000);assert.throws(()=>normalizeMatrixWindows([{id:'x',start:'2025-01-01',end:'2025-01-10'}],{now:Date.parse('2025-01-11')}),/OVER_SEVEN_DAYS/);assert.throws(()=>normalizeMatrixWindows([{id:'x',start:'2025-01-01',end:'2025-01-02'},{id:'x',start:'2025-01-02',end:'2025-01-03'}],{now:Date.parse('2025-01-04')}),/DUPLICATE/);});
test('per-window Spot universes are preserved and normalized for listing-aware historical replay',()=>{
  const normalized=normalizeMatrixWindows([{
    id:'post-listing',start:'2025-06-01T00:00:00Z',end:'2025-06-03T00:00:00Z',
    symbols:['partiusdt','beamxusdt','solvusdt','sophusdt']
  }],{now:Date.parse('2025-06-04T00:00:00Z')});
  assert.deepEqual(normalized[0].symbols,['PARTIUSDT','BEAMXUSDT','SOLVUSDT','SOPHUSDT']);
  const fallback=normalizeMatrixWindows([{
    id:'baseline',start:'2025-01-01T00:00:00Z',end:'2025-01-02T00:00:00Z'
  }],{now:Date.parse('2025-01-03T00:00:00Z')});
  assert.equal(fallback[0].symbols,null);
});

test('market regime classification uses observed BTC direction and range',()=>{const bull=classifyBtcMarketRegime(candles({open:100,close:104,low:99,high:105}));assert.equal(bull.regime,'BULL_TREND');const bear=classifyBtcMarketRegime(candles({open:100,close:96,low:95,high:101}));assert.equal(bear.regime,'BEAR_TREND');const sideways=classifyBtcMarketRegime(candles({open:100,close:100.5,low:99,high:101}));assert.equal(sideways.regime,'SIDEWAYS');const mixed=classifyBtcMarketRegime(candles({open:100,close:101,low:96,high:106}));assert.equal(mixed.regime,'MIXED');assert.equal(classifyBtcMarketRegime([]).regime,'UNKNOWN');});
test('required historical regime coverage includes a bearish-market window',()=>{
  const observed=['BULL_TREND','SIDEWAYS'];
  assert.deepEqual(HISTORICAL_MATRIX_REQUIRED_REGIMES.filter(x=>!observed.includes(x)),['BEAR_TREND']);
  const withBear=[...observed,'BEAR_TREND'];
  assert.equal(HISTORICAL_MATRIX_REQUIRED_REGIMES.every(x=>withBear.includes(x)),true);
});
test('historical coverage summaries never convert incomplete data into success',()=>{const summary=summarizeHistoricalWindowReport({symbol_count:2,results:[{data_quality:{trade_coverage_complete:true,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'FULL_TRADE',synthetic_data_used:false},summary:{replay_steps:10,accepted:2,rejected:4,first_accepted_at:'2025-01-01T00:00:00.000Z'}},{data_quality:{trade_coverage_complete:false,candle_fetch_complete:true},summary:{accepted:1,rejected:3}}]});assert.equal(summary.coverage_status,'INCOMPLETE_OR_EMPTY');assert.equal(summary.coverage_complete_symbols,1);assert.equal(summary.coverage_incomplete_symbols,1);assert.equal(summary.accepted_decisions,3);assert.equal(summary.rejected_decisions,7);const missing=summarizeHistoricalWindowReport({symbol_count:3,results:[{data_quality:{trade_coverage_complete:true,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'FULL_TRADE',synthetic_data_used:false},summary:{replay_steps:10}}]});assert.equal(missing.coverage_status,'INCOMPLETE_OR_EMPTY');assert.equal(missing.coverage_incomplete_symbols,2);});

test('matrix CLI dry-run validates the built-in 30-symbol by three-window plan without network access',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-replay-matrix.mjs');
  const run=spawnSync(process.execPath,[script,'--dry-run','--outcome-horizon-hours','48'],{encoding:'utf8',timeout:10_000});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const plan=JSON.parse(run.stdout);
  assert.equal(plan.status,'DRY_RUN_NO_NETWORK');
  assert.equal(plan.symbol_count,30);
  assert.equal(plan.window_count,3);
  assert.equal(plan.planned_symbol_window_replays,90);
  assert.equal(plan.limits.outcome_horizon_hours,48);
  assert.equal(plan.limits.archive_prefetch_concurrency,8);
  assert.equal(plan.limits.window_replay_concurrency,3);
  assert.equal(plan.limits.archive_prefetch_scope,'ALL_SYMBOLS_ALL_WINDOWS_BEFORE_REPLAY');
  assert.equal(plan.limits.replay_windows_in_parallel,true);
  assert.equal(plan.policy.real_order_execution,false);
});

test('matrix CLI dry-run accepts the fixed 33-symbol research cohort without network access',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-replay-matrix.mjs');
  const symbolsPath=resolve(dirname(fileURLToPath(import.meta.url)),'../benchmarks/hybrid-tcn-attention-symbols.json');
  const symbols=JSON.parse(readFileSync(symbolsPath,'utf8'));
  const run=spawnSync(process.execPath,[script,'--dry-run','--symbols',symbols.join(','),'--outcome-horizon-hours','4'],{encoding:'utf8',timeout:10_000});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const plan=JSON.parse(run.stdout);
  assert.equal(plan.status,'DRY_RUN_NO_NETWORK');
  assert.equal(plan.symbol_count,33);
  assert.equal(plan.window_count,3);
  assert.equal(plan.planned_symbol_window_replays,99);
  assert.equal(plan.limits.outcome_horizon_hours,4);
  assert.equal(plan.limits.archive_prefetch_concurrency,8);
  assert.equal(plan.limits.window_replay_concurrency,3);
  assert.equal(plan.limits.archive_prefetch_scope,'ALL_SYMBOLS_ALL_WINDOWS_BEFORE_REPLAY');
  assert.equal(plan.limits.replay_windows_in_parallel,true);
  assert.equal(plan.policy.real_order_execution,false);
});

test('matrix dry-run expands listing-aware per-window universes into the exact replay count',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-replay-matrix.mjs');
  const symbolsPath=resolve(dirname(fileURLToPath(import.meta.url)),'../benchmarks/hybrid-tcn-attention-symbols.json');
  const windowsPath=resolve(dirname(fileURLToPath(import.meta.url)),'../benchmarks/hybrid-tcn-attention-windows.json');
  const symbols=JSON.parse(readFileSync(symbolsPath,'utf8'));
  const run=spawnSync(process.execPath,[script,'--dry-run','--symbols',symbols.join(','),
    '--windows',windowsPath,'--outcome-horizon-hours','4'],{encoding:'utf8',timeout:10_000});
  assert.equal(run.status,0,run.stderr||run.stdout);
  const plan=JSON.parse(run.stdout);
  assert.equal(plan.status,'DRY_RUN_NO_NETWORK');
  assert.equal(plan.window_count,9);
  assert.equal(plan.symbol_count,37);
  assert.equal(plan.planned_symbol_window_replays,171);
  assert.equal(plan.windows.slice(0,3).every(w=>w.symbols.length===33),true);
  assert.equal(plan.windows.slice(3).every(w=>w.symbols.length===12),true);
  assert.ok(['PARTIUSDT','BEAMXUSDT','SOLVUSDT','SOPHUSDT']
    .every(symbol=>plan.symbols.includes(symbol)));
});

test('matrix CLI allows bounded parallel archives and rejects more than three concurrent historical windows',()=>{
  const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-replay-matrix.mjs');
  const accepted=spawnSync(process.execPath,[script,'--dry-run','--archive-prefetch-concurrency','6',
    '--window-replay-concurrency','2','--outcome-horizon-hours','4'],{encoding:'utf8',timeout:10_000});
  assert.equal(accepted.status,0,accepted.stderr||accepted.stdout);
  const plan=JSON.parse(accepted.stdout);
  assert.equal(plan.limits.archive_prefetch_concurrency,6);
  assert.equal(plan.limits.window_replay_concurrency,2);
  const rejected=spawnSync(process.execPath,[script,'--dry-run','--window-replay-concurrency','4'],
    {encoding:'utf8',timeout:10_000});
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/INVALID_WINDOW-REPLAY-CONCURRENCY|INVALID_WINDOW_REPLAY_CONCURRENCY/);
});

test('matrix reports measured early detections, missed movers, and weak follow-through together',()=>{
  const evaluation={
    version:'RADARX_MOVE_OUTCOME_ANALYSIS_V1',
    observation:{candle_coverage_complete:true,accepted_with_matured_outcomes:4},
    moderate_move:{observed_at:100,detected_early:true,minutes_before_move:12},
    strong_move:{observed_at:200,detected_early:false,minutes_before_move:null},
    low_follow_through_acceptances:[{classification:'LOW_FOLLOW_THROUGH_OR_ADVERSE_MOVE'}],
    missed_move_failure_codes:['BUY_FLOW_NOT_CONFIRMED','RESISTANCE_RECLAIM_NOT_CONFIRMED'],
    summary:{mature_accepted_count:4,low_follow_through_count:1}
  };
  const summary=summarizeHistoricalWindowReport({symbol_count:1,results:[{
    evaluation,
    data_quality:{trade_coverage_complete:true,candle_fetch_complete:true,outcome_candle_fetch_complete:true,replay_mode:'FULL_TRADE',synthetic_data_used:false},
    summary:{replay_steps:20,accepted:4,rejected:16}
  }]});
  assert.equal(summary.move_outcomes.symbols_requested,1);
  assert.equal(summary.move_outcomes.candle_coverage_complete_symbols,1);
  assert.equal(summary.move_outcomes.early_detections_before_5pct,1);
  assert.equal(summary.move_outcomes.missed_or_late_15pct_moves,1);
  assert.equal(summary.move_outcomes.low_follow_through_count,1);
  assert.ok(summary.move_outcomes.most_common_missed_move_failures.some(x=>x.code==='BUY_FLOW_NOT_CONFIRMED'));
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
