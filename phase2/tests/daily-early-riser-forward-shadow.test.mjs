import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDailyEarlyRiserForwardForecastPair,
  resolveDailyEarlyRiserForwardForecast,
  scoreDailyEarlyRiserForwardShadow,
  DAILY_FORWARD_SHADOW_MODEL_MLP,
  DAILY_FORWARD_SHADOW_MODEL_LOGISTIC
} from '../core/daily-early-riser-forward-shadow.mjs';

const HORIZON=24*60*60*1000;
const INTERVAL=15*60*1000;
const BUNDLE='a'.repeat(64),MLP_SHA='b'.repeat(64),LOGISTIC_SHA='c'.repeat(64);
const BASE_AT=1_800_000_000_000-1;
function baselineAt(at){
  return {
    openTime:at-INTERVAL+1,open:100,high:101,low:99,close:100,closeTime:at,
    quoteVolume:1_000_000,trades:1000,takerBuyQuoteVolume:500_000
  };
}
function futurePath(at,outcome='UP'){
  return Array.from({length:96},(_,index)=>{
    const openTime=at+1+index*INTERVAL;
    const up=outcome==='UP'&&index===0;
    const down=outcome==='DOWN'&&index===0;
    const both=outcome==='AMBIGUOUS'&&index===0;
    return {
      openTime,open:100,
      high:up||both?106:101,
      low:down||both?97:99,
      close:100,closeTime:openTime+INTERVAL-1,
      quoteVolume:100_000,trades:100,takerBuyQuoteVolume:50_000
    };
  });
}
function pairAt(at,{outcome='UP',mlpProbability,logisticProbability}={}){
  const pair=createDailyEarlyRiserForwardForecastPair({
    symbol:'AAAUSDT',target_pct:5,at,feature_information_cutoff_at:at,
    recorded_at:at+1,trained_through_at:at-HORIZON,
    baseline:baselineAt(at),
    features:{volume_ratio:1.5,taker_buy_ratio:0.62,relative_strength_vs_btc_24h_pct:1.2},
    model_bundle_sha256:BUNDLE,mlp_model_sha256:MLP_SHA,logistic_model_sha256:LOGISTIC_SHA,
    mlp_up_probability:mlpProbability??(outcome==='UP'?0.9:0.1),
    logistic_up_probability:logisticProbability??(outcome==='UP'?0.7:0.3)
  });
  const future=futurePath(at,outcome);
  const resolved=pair.map(forecast=>resolveDailyEarlyRiserForwardForecast(forecast,{
    future15m:future,recorded_at:at+HORIZON
  }));
  assert.ok(resolved.every(row=>row.accepted));
  return resolved.map(row=>row.forecast);
}

test('forward forecasts are paired, hash-bound, and require a strictly earlier model training cutoff',()=>{
  const pair=pairAt(BASE_AT);
  assert.equal(pair.length,2);
  assert.equal(pair[0].pair_id,pair[1].pair_id);
  assert.notEqual(pair[0].forecast_id,pair[1].forecast_id);
  assert.equal(pair[0].model_variant,DAILY_FORWARD_SHADOW_MODEL_MLP);
  assert.equal(pair[1].model_variant,DAILY_FORWARD_SHADOW_MODEL_LOGISTIC);
  assert.ok(pair.every(row=>row.status==='RESOLVED'));
  assert.throws(()=>createDailyEarlyRiserForwardForecastPair({
    symbol:'AAAUSDT',target_pct:5,at:BASE_AT,feature_information_cutoff_at:BASE_AT,
    recorded_at:BASE_AT+1,trained_through_at:BASE_AT,
    baseline:baselineAt(BASE_AT),features:{x:1},
    model_bundle_sha256:BUNDLE,mlp_model_sha256:MLP_SHA,logistic_model_sha256:LOGISTIC_SHA,
    mlp_up_probability:0.8,logistic_up_probability:0.6
  }),/TRAINING_CUTOFF_NOT_BEFORE_FORECAST/);
});

test('bad, incomplete or gapped future data never becomes a FLAT outcome',()=>{
  const forecast=createDailyEarlyRiserForwardForecastPair({
    symbol:'AAAUSDT',target_pct:5,at:BASE_AT,feature_information_cutoff_at:BASE_AT,
    recorded_at:BASE_AT+1,trained_through_at:BASE_AT-HORIZON,
    baseline:baselineAt(BASE_AT),features:{x:1},
    model_bundle_sha256:BUNDLE,mlp_model_sha256:MLP_SHA,logistic_model_sha256:LOGISTIC_SHA,
    mlp_up_probability:0.8,logistic_up_probability:0.6
  })[0];
  const short=resolveDailyEarlyRiserForwardForecast(forecast,{
    future15m:futurePath(BASE_AT).slice(0,95),recorded_at:BASE_AT+HORIZON
  });
  assert.equal(short.accepted,false);
  const gap=futurePath(BASE_AT);
  gap[20]={...gap[20],openTime:gap[20].openTime+INTERVAL};
  const invalid=resolveDailyEarlyRiserForwardForecast(forecast,{
    future15m:gap,recorded_at:BASE_AT+HORIZON
  });
  assert.equal(invalid.accepted,false);
});

test('same-candle target and adverse hits are retained as ambiguous and excluded from scoring',()=>{
  const pair=pairAt(BASE_AT,{outcome:'AMBIGUOUS'});
  assert.ok(pair.every(row=>row.status==='AMBIGUOUS'));
  const score=scoreDailyEarlyRiserForwardShadow(pair,{
    target_pct:5,model_bundle_sha256:BUNDLE,minimum_paired_samples:1
  });
  assert.equal(score.paired_resolved_samples,0);
  assert.equal(score.status,'INSUFFICIENT_FORWARD_PAIRED_OUTCOMES');
  assert.equal(score.excluded_ambiguous_or_pending_records,2);
});

test('forward gate uses identical paired outcomes and needs at least 150 samples plus 0.003 gain',()=>{
  const resolved=[];
  for(let index=0;index<160;index++){
    const at=BASE_AT+index*HORIZON;
    const outcome=index%2===0?'UP':'DOWN';
    resolved.push(...pairAt(at,{outcome}));
  }
  const score=scoreDailyEarlyRiserForwardShadow(resolved,{target_pct:5,model_bundle_sha256:BUNDLE});
  assert.equal(score.paired_resolved_samples,160);
  assert.equal(score.status,'FORWARD_SHADOW_BRIER_GATE_PASSED');
  assert.ok(score.overall.brier_gain>=0.003);
  assert.ok(score.overall.gain_95pct_lower_bound>0);
  assert.equal(score.production_eligible,false);
  assert.equal(score.real_order_execution,false);
});

test('forward gate rejects unmatched or duplicated forecast rows instead of cherry-picking',()=>{
  const pair=pairAt(BASE_AT);
  const duplicate=[...pair,pair[0]];
  const score=scoreDailyEarlyRiserForwardShadow(duplicate,{
    target_pct:5,model_bundle_sha256:BUNDLE,minimum_paired_samples:1
  });
  assert.equal(score.paired_resolved_samples,0);
  assert.equal(score.excluded_duplicate_forecast_ids,1);
  assert.equal(score.status,'FORWARD_SHADOW_DID_NOT_BEAT_LOGISTIC');
});
