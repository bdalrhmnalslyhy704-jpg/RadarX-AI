import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_EARLY_RISER_HORIZON_MS,
  DAILY_EARLY_RISER_OUTCOME_SOURCE,
  prepareDailyEarlyRiserCognitiveRow
} from '../core/daily-early-riser-neural-benchmark.mjs';

function sampleWith({
  at=1_800_000_000_000,
  featureCutoffAt=at,
  targetPct=5,
  outcome='UP',
  status='RESOLVED',
  resolvedAt=at+DAILY_EARLY_RISER_HORIZON_MS,
  horizonMs=DAILY_EARLY_RISER_HORIZON_MS,
  outcomeSource=DAILY_EARLY_RISER_OUTCOME_SOURCE
}={}){
  const key='plus_'+targetPct+'_pct';
  return {
    id:'DAILY_TEST:AAAUSDT:'+String(at),
    symbol:'AAAUSDT',
    at,
    feature_information_cutoff_at:featureCutoffAt,
    observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
    features:{
      volume_ratio:1.4,trade_ratio:1.2,taker_buy_ratio:0.61,
      close_location:0.72,current_range_pct:1.2,
      relative_strength_vs_btc_pct:0.8
    },
    targets:{
      [key]:{
        status,outcome,resolved_at:resolvedAt,horizon_ms:horizonMs,
        outcome_source:outcomeSource,
        target_definition:'FIRST_PASSAGE_PLUS_'+targetPct+'_PCT_BEFORE_MINUS_2_PCT_24H_15M_V1'
      }
    }
  };
}

test('daily cognitive row preserves the 24h first-passage label and baseline-only feature cutoff',()=>{
  const input=sampleWith({targetPct:5,outcome:'UP'});
  const result=prepareDailyEarlyRiserCognitiveRow(input,5);
  assert.equal(result.reason,null);
  assert.equal(result.row.outcome,'UP');
  assert.equal(result.row.at,input.at);
  assert.equal(result.row.resolved_at,input.at+DAILY_EARLY_RISER_HORIZON_MS);
  assert.equal(result.row.horizon_ms,DAILY_EARLY_RISER_HORIZON_MS);
  assert.equal(result.row.outcome_source,DAILY_EARLY_RISER_OUTCOME_SOURCE);
  assert.equal(result.row.historical_baseline,true);
  assert.equal(result.row.closed_candle_baseline,true);
  assert.equal(result.row.training_eligible,true);
  assert.deepEqual(result.row.features,input.features);
});

test('ambiguous, invalid and unresolved labels are excluded rather than mapped to FLAT',()=>{
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({status:'AMBIGUOUS',outcome:'AMBIGUOUS'}),5).reason,
    'LABEL_NOT_RESOLVED');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({status:'INVALID',outcome:'INVALID'}),5).reason,
    'LABEL_NOT_RESOLVED');
});

test('the daily horizon must mature exactly 96 closed 15m candles after the feature cutoff',()=>{
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({resolvedAt:1_800_000_000_000+DAILY_EARLY_RISER_HORIZON_MS-1}),5).reason,
    'LABEL_HORIZON_MISMATCH');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({horizonMs:4*60*60*1000}),5).reason,
    'LABEL_HORIZON_MISMATCH');
});

test('future information or a non-Binance baseline is rejected',()=>{
  assert.equal(prepareDailyEarlyRiserCognitiveRow(sampleWith({featureCutoffAt:1_800_000_000_000-1}),5).reason,
    'FEATURE_CUTOFF_NOT_AT_BASELINE');
  const row=sampleWith({targetPct:5});
  row.observation_source='MOCK_OR_UNVERIFIED';
  assert.equal(prepareDailyEarlyRiserCognitiveRow(row,5).reason,'FEATURE_CUTOFF_NOT_AT_BASELINE');
});

test('target definitions remain independent for +5%, +10% and +15%',()=>{
  const input={
    ...sampleWith({targetPct:5,outcome:'UP'}),
    targets:{
      plus_5_pct:sampleWith({targetPct:5,outcome:'UP'}).targets.plus_5_pct,
      plus_10_pct:sampleWith({targetPct:10,outcome:'DOWN'}).targets.plus_10_pct,
      plus_15_pct:sampleWith({targetPct:15,outcome:'FLAT'}).targets.plus_15_pct
    }
  };
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,5).row.outcome,'UP');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,10).row.outcome,'DOWN');
  assert.equal(prepareDailyEarlyRiserCognitiveRow(input,15).row.outcome,'FLAT');
});
