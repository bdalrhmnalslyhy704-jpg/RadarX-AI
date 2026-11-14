import test from 'node:test';
import assert from 'node:assert/strict';
import {createVersionedModelArtifact} from '../core/model-artifact-guardian.mjs';
import {
  NEURAL_CLOSURE_TARGET_DEFINITION,NEURAL_CLOSURE_TARGET_SEMANTICS,NEURAL_CLOSURE_OUTCOME_SOURCE,
  NEURAL_CLOSURE_HORIZON_MS,NEURAL_CLOSURE_PURGE_MS,
  NEURAL_CLOSURE_MODEL_FAMILIES,focalAsymmetricBrierLoss,buildFourHourFirstTouchOutcome,
  deriveTrainingClassWeights,validateFourHourRows,splitFourHourRows,
  fitTemperatureScaler,fitPlattScaler,applyProbabilityCalibrator,
  realizedExecutionGrossReturnPct,realizedExecutionNetReturnPct,
  runNeuralClosureBenchmark
} from '../core/neural-closure-contracts.mjs';

const BASE=Date.UTC(2026,0,1);
function makeRows({days=20,rowsPerDay=400}={}){
  const rows=[];
  for(let day=0;day<days;day++)for(let index=0;index<rowsPerDay;index++){
    const at=BASE+day*NEURAL_CLOSURE_PURGE_MS+index*60_000;
    const positive=index%7===0;
    const outcome=positive?'UP':index%11===0?'FLAT':'DOWN';
    rows.push({
      id:'D'+day+':E'+index,
      symbol:'S'+String(index).padStart(4,'0')+'USDT',
      market:'BINANCE_SPOT_USDT',
      source_audit:{exchange:'BINANCE',market:'SPOT',interval:'1m',
        transport:'BINANCE_PUBLIC_REST',symbol:'S'+String(index).padStart(4,'0')+'USDT',
        received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000,
        observed_candles:240,raw_klines_sha256:'a'.repeat(64)},
      at,resolved_at:at+NEURAL_CLOSURE_HORIZON_MS,
      horizon_ms:NEURAL_CLOSURE_HORIZON_MS,
      feature_information_cutoff_at:at,
      target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
      target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
      outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
      training_eligible:true,closed_candle_baseline:true,
      outcome,target:positive?1:0,
      realized_return_pct:positive?3.4:outcome==='DOWN'?-2.3:0.08,
      first_touch:{
        resolution:positive?'TAKE_PROFIT_FIRST':outcome==='DOWN'?'STOP_LOSS_FIRST':'HORIZON_END',
        first_touch_at:outcome==='FLAT'?at+NEURAL_CLOSURE_HORIZON_MS:at+59_999,
        path_resolution:'1M',observed_candles:240,raw_klines_sha256:'a'.repeat(64),
        baseline_price:100,take_profit_price:103,stop_loss_price:98
      },
      features:[index/rowsPerDay,day/30]
    });
  }
  return rows;
}
function makeArtifacts(sourceCommitSha){
  return Object.fromEntries(NEURAL_CLOSURE_MODEL_FAMILIES.map((family,index)=>[
    family,createVersionedModelArtifact({
      modelName:family,modelFamily:family,modelVersion:'1.0.0',
      sourceCommitSha,targetDefinition:NEURAL_CLOSURE_TARGET_DEFINITION,
      featureSchemaId:'RADARX_FOUR_HOUR_TEST_FEATURES_V1',
      featureNames:['feature_a','feature_b'],
      featureIndexMap:{feature_a:0,feature_b:1},
      normalization:{mean:[0,0],std:[1,1]},
      modelState:{weights:[index/100+0.1,0.2],bias:0}
    })
  ]));
}
function makePredictions(rows,sourceCommitSha,artifacts){
  const evaluated=rows.filter(row=>{
    const day=Math.floor((row.at-BASE)/NEURAL_CLOSURE_PURGE_MS);
    return (day>=13&&day<=15)||(day>=17);
  });
  const make=(positive,negative,artifactSha256=null)=>evaluated.map(row=>({
    id:row.id,probability:row.target?positive:negative,
    source_commit_sha:sourceCommitSha,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    artifact_sha256:artifactSha256
  }));
  const output={LOGISTIC_REGRESSION:make(0.72,0.24,null)};
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES)
    output[family]=make(0.73,0.23,artifacts[family].artifact_sha256);
  return output;
}

test('Focal-Asymmetric Brier analytic probability/logit gradients match central differences',()=>{
  for(const target of [0,1]){
    const p=0.37,step=1e-6;
    const result=focalAsymmetricBrierLoss(p,target,{
      gammaPositive:1.2,gammaNegative:1.8,positiveWeight:2.1,negativeWeight:0.7
    });
    const plus=focalAsymmetricBrierLoss(p+step,target,{
      gammaPositive:1.2,gammaNegative:1.8,positiveWeight:2.1,negativeWeight:0.7
    }).loss;
    const minus=focalAsymmetricBrierLoss(p-step,target,{
      gammaPositive:1.2,gammaNegative:1.8,positiveWeight:2.1,negativeWeight:0.7
    }).loss;
    assert.ok(Math.abs((plus-minus)/(2*step)-result.probabilityGradient)<1e-8);
    assert.ok(Math.abs(result.logitGradient-
      result.probabilityGradient*p*(1-p))<1e-14);
  }
  assert.throws(()=>focalAsymmetricBrierLoss(NaN,1),/PROBABILITY_INVALID/);
  assert.throws(()=>focalAsymmetricBrierLoss(0.5,2),/TARGET_INVALID/);
});

test('class weights are derived only from the supplied training partition',()=>{
  const weights=deriveTrainingClassWeights([1,0,0,0,1,0]);
  assert.equal(weights.training_positive,2);
  assert.equal(weights.training_negative,4);
  assert.equal(weights.positiveWeight,1.5);
  assert.equal(weights.negativeWeight,0.75);
  assert.equal(weights.derived_from,'TRAINING_PARTITION_ONLY');
  assert.throws(()=>deriveTrainingClassWeights([0,0]),/BOTH_CLASSES/);
});

test('strict four-hour row validation rejects target/source/cutoff drift and duplicates',()=>{
  const rows=makeRows({days:8,rowsPerDay:4});
  assert.equal(validateFourHourRows(rows).length,32);
  assert.throws(()=>validateFourHourRows(rows.map((row,index)=>index===0
    ?{...row,feature_information_cutoff_at:row.at+60_000}:row)),/TIME_OR_CUTOFF_INVALID/);
  assert.throws(()=>validateFourHourRows(rows.map((row,index)=>index===0
    ?{...row,target_definition:'OTHER'}:row)),/TARGET_OR_SOURCE_MISMATCH/);
  assert.throws(()=>validateFourHourRows(rows.map((row,index)=>index===0
    ?{...row,outcome_source:'MOCK'}:row)),/TARGET_OR_SOURCE_MISMATCH/);
  assert.throws(()=>validateFourHourRows(rows.concat(rows[0])),/DUPLICATE_ID/);
});

test('nominal 60/20/20 split has a complete UTC purge day at both boundaries',()=>{
  const rows=validateFourHourRows(makeRows({days:20,rowsPerDay:4}));
  const split=splitFourHourRows(rows);
  assert.equal(split.schema,'RADARX_NEURAL_CLOSURE_PURGED_60_20_20_UTC_DAY_SPLIT_V1');
  assert.equal(split.days.train.length,12);
  assert.equal(split.days.purge_train_validation.length,1);
  assert.equal(split.days.validation.length,3);
  assert.equal(split.days.purge_validation_holdout.length,1);
  assert.equal(split.days.holdout.length,3);
  assert.equal(split.purged.length,8);
  assert.equal(split.counts.total,rows.length);
  assert.ok(split.boundaries.train_last_at<
    split.boundaries.validation_first_at-NEURAL_CLOSURE_PURGE_MS);
  assert.ok(split.boundaries.validation_last_at<
    split.boundaries.holdout_first_at-NEURAL_CLOSURE_PURGE_MS);
});

test('temperature and Platt calibration fail closed below 50 positive or negative samples',()=>{
  const logits=Array.from({length:278},(_,index)=>index<8?1.2:-0.3);
  const labels=Array.from({length:278},(_,index)=>index<8?1:0);
  const temperature=fitTemperatureScaler(logits,labels);
  const platt=fitPlattScaler(logits,labels);
  assert.equal(temperature.status,'INSUFFICIENT_CLASS_SUPPORT');
  assert.equal(platt.status,'INSUFFICIENT_CLASS_SUPPORT');
  assert.equal(temperature.fitted,false);
  assert.equal(platt.fitted,false);
  assert.equal(temperature.positive,8);
  assert.equal(temperature.min_positive,50);
});

test('temperature and Platt scaling fit only with 50+ positive and negative support',()=>{
  const labels=Array.from({length:240},(_,index)=>index%2);
  const logits=labels.map((target,index)=>target?1.1+(index%5)*0.03:-0.9-(index%7)*0.02);
  const temperature=fitTemperatureScaler(logits,labels);
  const platt=fitPlattScaler(logits,labels);
  assert.equal(temperature.status,'FITTED');
  assert.equal(platt.status,'FITTED');
  assert.equal(temperature.fitted,true);
  assert.equal(platt.fitted,true);
  assert.ok(temperature.temperature>0);
  assert.ok(platt.slope>0);
  assert.ok(applyProbabilityCalibrator(0.8,temperature)>0.5);
  assert.ok(applyProbabilityCalibrator(0.8,platt)>0.5);
  assert.throws(()=>applyProbabilityCalibrator(NaN,platt),/LOGIT_NON_FINITE/);
});

test('realized PnL exits at the first touched barrier, not the later four-hour close',()=>{
  const up={
    outcome:'UP',realized_return_pct:-9,
    first_touch:{resolution:'TAKE_PROFIT_FIRST',baseline_price:100,
      take_profit_price:103,stop_loss_price:98}
  };
  const down={
    outcome:'DOWN',realized_return_pct:8,
    first_touch:{resolution:'STOP_LOSS_FIRST',baseline_price:100,
      take_profit_price:103,stop_loss_price:98}
  };
  const flat={
    outcome:'FLAT',realized_return_pct:1.25,
    first_touch:{resolution:'HORIZON_END',baseline_price:100,
      take_profit_price:103,stop_loss_price:98}
  };

  assert.ok(Math.abs(realizedExecutionGrossReturnPct(up)-3)<1e-10);
  assert.ok(Math.abs(realizedExecutionGrossReturnPct(down)+2)<1e-10);
  assert.equal(realizedExecutionGrossReturnPct(flat),1.25);
  assert.ok(Math.abs(realizedExecutionNetReturnPct(up,30)-2.7)<1e-10);
  assert.ok(Math.abs(realizedExecutionNetReturnPct(down,30)+2.3)<1e-10);
  assert.ok(Math.abs(realizedExecutionNetReturnPct(flat,30)-0.95)<1e-10);

  const malformed={...up,first_touch:{...up.first_touch,take_profit_price:104}};
  assert.throws(()=>validateFourHourRows([{
    id:'BAD:1',symbol:'ETHUSDT',market:'BINANCE_SPOT_USDT',
    source_audit:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'ETHUSDT',
      received_at:BASE+NEURAL_CLOSURE_HORIZON_MS+60_000,
      observed_candles:240,raw_klines_sha256:'a'.repeat(64)},
    at:BASE,resolved_at:BASE+NEURAL_CLOSURE_HORIZON_MS,
    horizon_ms:NEURAL_CLOSURE_HORIZON_MS,feature_information_cutoff_at:BASE,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
    training_eligible:true,closed_candle_baseline:true,
    outcome:'UP',target:1,realized_return_pct:-9,
    first_touch:{...malformed.first_touch,first_touch_at:BASE+60_000,
      path_resolution:'1M',observed_candles:240,
      raw_klines_sha256:'a'.repeat(64)}
  }]),/EXIT_BARRIER_INVALID/);
});

test('fixed-SHA evaluator compares identical event identities and refuses false superiority',()=>{
  const rows=makeRows(),sourceCommitSha='a'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictionsByModel=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel,modelArtifactsByModel,sourceCommitSha
  });
  assert.equal(report.schema,'RADARX_BUILD224_FIXED_SHA_NEURAL_CLOSURE_BENCHMARK_V1');
  assert.equal(report.target.definition,NEURAL_CLOSURE_TARGET_DEFINITION);
  assert.equal(report.target.horizon_ms,NEURAL_CLOSURE_HORIZON_MS);
  assert.equal(report.integrity.row_count,8000);
  assert.match(report.integrity.dataset_sha256,/^[a-f0-9]{64}$/);
  assert.match(report.integrity.fixed_benchmark_sha256,/^[a-f0-9]{64}$/);
  assert.match(report.integrity.model_artifacts_sha256,/^[a-f0-9]{64}$/);
  assert.match(report.integrity.prediction_matrix_sha256,/^[a-f0-9]{64}$/);
  assert.equal(report.integrity.verified_model_artifacts,NEURAL_CLOSURE_MODEL_FAMILIES.length);
  assert.ok(report.models.TCN_V11.model_artifact_sha256===modelArtifactsByModel.TCN_V11.artifact_sha256);
  assert.equal(report.split.purge_ms,NEURAL_CLOSURE_PURGE_MS);
  assert.equal(report.models.LOGISTIC_REGRESSION.status,'EVALUATED');
  assert.equal(report.models.TCN_V11.calibration.calibration_fit_rows,400);
  assert.equal(report.models.TCN_V11.calibration.calibration_purged_rows,400);
  assert.equal(report.models.TCN_V11.calibration.calibration_check_rows,400);
  assert.deepEqual(report.models.TCN_V11.calibration.calibration_days.purge,
    [BASE+14*NEURAL_CLOSURE_PURGE_MS]);
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    assert.equal(report.models[family].status,'EVALUATED');
    assert.equal(report.models[family].holdout.sample_count,1200);
    assert.equal(report.models[family].acceptance.passed,false,
      'a candidate with no >0.003 Brier gain must not be promoted');
  }
  assert.equal(report.status,'NEURAL_SUPERIORITY_NOT_PROVEN');
});

test('fixed-SHA evaluator fails a family closed when any same-cohort prediction is missing',()=>{
  const rows=makeRows(),sourceCommitSha='b'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  predictions.TCN_V11=predictions.TCN_V11.slice(1);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  assert.equal(report.models.TCN_V11.status,'NOT_EVALUATED');
  assert.equal(report.models.TCN_V11.acceptance.status,'NOT_EVALUATED');
});


test('four-hour +3/-2 target resolves from exactly 240 closed 1m candles',()=>{
  const at=Date.UTC(2026,2,1,0,0,0)+59_999;
  const makeCandles=(first)=>Array.from({length:240},(_,index)=>{
    let open=100,high=102,low=99,close=100.5;
    if(index===0&&first==='UP'){high=103.2;close=103.1;}
    if(index===0&&first==='DOWN'){low=97.8;close=97.9;}
    if(index===0&&first==='AMBIGUOUS'){high=104;low=97;close=100;}
    const openTime=at+1+index*60_000;
    return {
      open,high,low,close,open_time:openTime,
      close_time:openTime+59_999,is_closed:true,
      source:'BINANCE_PUBLIC_REST'
    };
  });
  const up=buildFourHourFirstTouchOutcome({
    id:'label-up',symbol:'ETHUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'ETHUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('UP')
  });
  assert.equal(up.training_eligible,true);
  assert.equal(up.outcome,'UP');
  assert.equal(up.target,1);
  assert.equal(up.first_touch.resolution,'TAKE_PROFIT_FIRST');
  assert.equal(up.horizon_ms,NEURAL_CLOSURE_HORIZON_MS);
  const down=buildFourHourFirstTouchOutcome({
    id:'label-down',symbol:'BTCUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'BTCUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('DOWN')
  });
  assert.equal(down.outcome,'DOWN');
  assert.equal(down.target,0);
  const flat=buildFourHourFirstTouchOutcome({
    id:'label-flat',symbol:'SOLUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'SOLUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('FLAT')
  });
  assert.equal(flat.outcome,'FLAT');
  assert.equal(flat.first_touch.resolution,'HORIZON_END');
  const ambiguous=buildFourHourFirstTouchOutcome({
    id:'label-ambiguous',symbol:'XRPUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'XRPUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('AMBIGUOUS')
  });
  assert.equal(ambiguous.training_eligible,false);
  assert.match(ambiguous.reason,/AMBIGUOUS/);
  const gap=makeCandles('FLAT');gap[0]={...gap[0],open_time:gap[0].open_time+60_000};
  const invalid=buildFourHourFirstTouchOutcome({
    id:'label-gap',symbol:'BNBUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'BNBUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,candles:gap
  });
  assert.equal(invalid.training_eligible,false);
});


test('fixed-SHA evaluator refuses candidate predictions without an exact versioned model artifact',()=>{
  const rows=makeRows(),sourceCommitSha='c'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  delete modelArtifactsByModel.TCN_V11;
  const predictionsByModel=makePredictions(rows,sourceCommitSha,makeArtifacts(sourceCommitSha));
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel,modelArtifactsByModel,sourceCommitSha
  });
  assert.equal(report.models.TCN_V11.status,'NOT_EVALUATED');
  assert.equal(report.models.TCN_V11.reason,'EXACT_VERSIONED_MODEL_ARTIFACT_MISSING');
  assert.equal(report.models.TCN_V11.acceptance.passed,false);
  assert.equal(report.integrity.verified_model_artifacts,NEURAL_CLOSURE_MODEL_FAMILIES.length-1);
});
