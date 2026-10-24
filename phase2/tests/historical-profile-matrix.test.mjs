import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HISTORICAL_DETECTOR_PROFILES} from '../tools/historical-replay.mjs';

const script=resolve(dirname(fileURLToPath(import.meta.url)),'../tools/historical-profile-matrix.mjs');

test('12-radar historical profile matrix lists every canonical profile without network access',()=>{
  const run=spawnSync(process.execPath,[script,'--dry-run','--symbols','GTCUSDT',
    '--lookback-hours','6','--outcome-horizon-hours','24'],{
    encoding:'utf8',timeout:10_000
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const report=JSON.parse(run.stdout);
  assert.equal(report.status,'DRY_RUN_NO_NETWORK');
  assert.deepEqual(report.profiles.map(x=>x.profile),HISTORICAL_DETECTOR_PROFILES);
  assert.equal(report.profiles.length,12);
  assert.equal(new Set(report.profiles.map(x=>x.profile)).size,12);
  assert.equal(report.policy.network_access,false);
  assert.equal(report.window.lookback_hours,6);
  assert.equal(report.window.outcome_horizon_hours,24);
  assert.equal(report.window.end%60_000,59_999,
    'replay end must align to the last millisecond of a closed one-minute candle');
  assert.equal(report.window.outcome_end%60_000,59_999,
    'the forward outcome horizon must also end at a closed-candle close');
  assert.equal(report.policy.paper_trading,true);
  assert.equal(report.policy.real_order_execution,false);
  assert.ok(report.profiles.every(x=>x.actual_push_simulated===false));
});

test('profile-matrix dry-run surfaces unavailable evidence rather than treating it as ready',()=>{
  const run=spawnSync(process.execPath,[script,'--dry-run','--profiles',
    'STRONG_MOVE_RADAR,EARLY_EXPANSION_RADAR,WHALE_ACCUMULATION_RADAR,PROFESSOR_RADAR','--symbols','GTCUSDT'],{
    encoding:'utf8',timeout:10_000
  });
  assert.equal(run.status,0,run.stderr||run.stdout);
  const report=JSON.parse(run.stdout);
  assert.deepEqual(report.profiles.map(x=>x.profile),[
    'STRONG_MOVE_RADAR','EARLY_EXPANSION_RADAR','WHALE_ACCUMULATION_RADAR','PROFESSOR_RADAR'
  ]);
  const strong=report.profiles[0];
  assert.ok(strong.unavailable_historical_evidence.includes('HISTORICAL_ORDERBOOK_UNAVAILABLE'));
  const early=report.profiles[1];
  assert.ok(early.unavailable_historical_evidence.includes('HISTORICAL_ORDERBOOK_UNAVAILABLE'));
  const whale=report.profiles[2];
  assert.equal(whale.trade_history_required,true);
  const professor=report.profiles[3];
  assert.ok(professor.external_evidence_required.includes('PROFESSOR_NEWS_ARCHIVE'));
  assert.ok(professor.external_evidence_required.includes('PROFESSOR_STREAM_TRANSCRIPT_ARCHIVE'));
});

test('profile-matrix refuses unknown radar names',()=>{
  const run=spawnSync(process.execPath,[script,'--dry-run','--profiles','NOT_A_RADAR'],{
    encoding:'utf8',timeout:10_000
  });
  assert.notEqual(run.status,0);
  assert.match(run.stderr,/UNSUPPORTED_HISTORICAL_PROFILES/);
});
