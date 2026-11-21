import test from 'node:test';
import assert from 'node:assert/strict';

// [RUN-NEURAL-REBENCHMARK] Include the frozen-threshold signal-transfer diagnostics in the immutable-cohort report.
// [RUN-NEURAL-REBENCHMARK] Re-run the immutable run-99 cohort after adding
// stage-by-stage chronological diagnostics; this is evidence generation only,
// and all threshold, risk, production, paper-only, and holdout gates stay fixed.
// [RUN-NEURAL-REBENCHMARK] Evaluate the fixed-cohort 35% calibration-fit allocation as a diagnostic-only alternative.
import {createVersionedModelArtifact} from '../core/model-artifact-guardian.mjs';
import {TEMPORAL_RANKING_BUCKET_MS} from '../core/temporal-neural-brain.mjs';
import {
  NEURAL_CLOSURE_TARGET_DEFINITION,NEURAL_CLOSURE_TARGET_SEMANTICS,NEURAL_CLOSURE_OUTCOME_SOURCE,
  NEURAL_CLOSURE_HORIZON_MS,NEURAL_CLOSURE_PURGE_MS,
  sha256Canonical,sha256CanonicalArrayMapped,
  NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,NEURAL_CLOSURE_MODEL_FAMILIES,focalAsymmetricBrierLoss,buildFourHourFirstTouchOutcome,
  deriveTrainingClassWeights,validateFourHourRows,splitFourHourRows,
  buildNeuralClosureCalibrationBlocks,buildWalkForwardCalibrationDiagnostics,
  chooseCalibration,
  fitTemperatureScaler,fitPlattScaler,applyProbabilityCalibrator,
  realizedExecutionGrossReturnPct,realizedExecutionNetReturnPct,
  simulateFirstTouchPaperPortfolio,NEURAL_CLOSURE_PORTFOLIO_POLICY,
  NEURAL_CLOSURE_RANKING_BUCKET_MS,topKProbabilitySignals,
  topKThresholdSignals,topKMatchedCountSignals,
  evaluateExternalExecutionRiskTopK,runNeuralClosureBenchmark,
  bootstrapOuterValidationUncertainty,
  NEURAL_CLOSURE_HOLDOUT_OPENING_REQUIRED_CHECKS,
  evaluateNeuralClosureHoldoutOpeningProtocol
} from '../core/neural-closure-contracts.mjs';

test('holdout opening protocol fails closed unless all fourteen research checks are explicitly true',()=>{
  const locked=evaluateNeuralClosureHoldoutOpeningProtocol({});
  assert.equal(locked.schema,'RADARX_NEURAL_CLOSURE_HOLDOUT_OPENING_PROTOCOL_V1');
  assert.equal(locked.status,'LOCKED');
  assert.equal(locked.passed,false);
  assert.equal(locked.holdout_metrics_read,false);
  assert.equal(locked.missing_checks.length,14);
  assert.equal(NEURAL_CLOSURE_HOLDOUT_OPENING_REQUIRED_CHECKS.length,14);

  const allTrue=Object.fromEntries(
    NEURAL_CLOSURE_HOLDOUT_OPENING_REQUIRED_CHECKS.map(name=>[name,true])
  );
  const approved=evaluateNeuralClosureHoldoutOpeningProtocol(allTrue);
  assert.equal(approved.status,'APPROVED');
  assert.equal(approved.passed,true);
  assert.deepEqual(approved.missing_checks,[]);
  const oneFalse={...allTrue,confidence_intervals_and_robustness_reported:false};
  const rejected=evaluateNeuralClosureHoldoutOpeningProtocol(oneFalse);
  assert.equal(rejected.status,'LOCKED');
  assert.deepEqual(rejected.missing_checks,[
    'confidence_intervals_and_robustness_reported'
  ]);
});

const BASE=Date.UTC(2026,0,1);
const assertClose=(actual,expected,message='')=>
  assert.ok(Math.abs(actual-expected)<=1e-8,
    message||('expected '+actual+' to be within 1e-8 of '+expected));
function makeRows({days=60,rowsPerDay=200}={}){
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
      execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
      outcome_source:NEURAL_CLOSURE_OUTCOME_SOURCE,
      training_eligible:true,closed_candle_baseline:true,
      outcome,target:positive?1:0,
      realized_return_pct:positive?3.4:outcome==='DOWN'?-2.3:0.08,
      max_adverse_excursion_pct:positive?0:outcome==='DOWN'?-2.3:-0.9,
      max_adverse_excursion_at:at+(outcome==='FLAT'?60*60_000:positive?0:1),
      max_favorable_excursion_pct:positive?3.4:outcome==='DOWN'?0:0.8,
      max_favorable_excursion_at:at+(outcome==='FLAT'?90*60_000:positive?1:0),
      first_touch:{
        resolution:positive?'TAKE_PROFIT_FIRST':outcome==='DOWN'?'STOP_LOSS_FIRST':'HORIZON_END',
        first_touch_at:outcome==='FLAT'?at+NEURAL_CLOSURE_HORIZON_MS:at+1,
        path_resolution:'1M',observed_candles:240,raw_klines_sha256:'a'.repeat(64),
        baseline_price:100,take_profit_price:103,stop_loss_price:98,
        exit_price:positive?103.4:outcome==='DOWN'?97.7:100.08,
        exit_price_source:outcome==='FLAT'?'HORIZON_CLOSE':'OPEN_GAP',
        exit_candle:outcome==='FLAT'?{
          open_time:at+1+239*60_000,close_time:at+NEURAL_CLOSURE_HORIZON_MS,
          open:100.05,high:100.1,low:100.02,close:100.08,
          is_closed:true,source:'BINANCE_PUBLIC_REST'
        }:outcome==='UP'?{
          open_time:at+1,close_time:at+60_000,
          open:103.4,high:103.8,low:103.2,close:103.5,
          is_closed:true,source:'BINANCE_PUBLIC_REST'
        }:{
          open_time:at+1,close_time:at+60_000,
          open:97.7,high:98,low:97.5,close:97.8,
          is_closed:true,source:'BINANCE_PUBLIC_REST'
        }
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
  // Always derive predictions from the current outer split. This keeps the
  // synthetic test fixture aligned when calibration/threshold blocks change.
  const split=splitFourHourRows(rows);
  const requiredIds=new Set(split.validation.map(row=>row.id));
  const validationIds=new Set(split.validation.map(row=>row.id));
  const evaluated=rows.filter(row=>requiredIds.has(row.id));
  const make=(positive,negative,artifactSha256=null,modelName=null)=>evaluated.map(row=>({
    id:row.id,probability:row.target?positive:negative,
    source_commit_sha:sourceCommitSha,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    artifact_sha256:artifactSha256,
    ...(modelName==='TCN_LSTM_HYBRID'&&validationIds.has(row.id)
      ?{pre_inner_calibration_probability:row.target?0.61:0.39}:{})
  }));
  const output={LOGISTIC_REGRESSION:make(0.72,0.24,null)};
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES)
    output[family]=make(0.73,0.23,artifacts[family].artifact_sha256,family);
  return output;
}

test('top-K ranking merges millisecond-skewed closes into the shared 15-minute decision bucket',()=>{
  const rows=[
    {at:900_001,symbol:'B',id:'b'},
    {at:950_000,symbol:'A',id:'a'},
    {at:1_799_999,symbol:'C',id:'c'},
    {at:1_800_001,symbol:'D',id:'d'},
    {at:1_900_000,symbol:'E',id:'e'},
    {at:2_699_999,symbol:'F',id:'f'},
    {at:2_700_001,symbol:'SINGLETON',id:'singleton'}
  ];
  const scores=[0.8,0.8,0.9,0.2,0.7,0.95,0.99];
  const ranked=topKProbabilitySignals(rows,scores,2);
  assert.equal(NEURAL_CLOSURE_RANKING_BUCKET_MS,TEMPORAL_RANKING_BUCKET_MS,
    'Top-K policy must stay aligned with the established RadarX ranking bucket');
  assert.equal(NEURAL_CLOSURE_RANKING_BUCKET_MS,900_000);
  assert.equal(ranked.decision_group_count,2,
    'three slightly different close timestamps in each 15m bucket must be ranked together');
  assert.equal(ranked.total_time_buckets,3);
  assert.equal(ranked.singleton_buckets_excluded,1,
    'a bucket with one symbol cannot demonstrate cross-sectional ranking skill');
  assert.equal(ranked.decision_bucket_ms,900_000);
  assert.equal(ranked.decision_grouping,'FLOOR_UNIX_EPOCH_15M_BUCKET');
  assert.equal(ranked.signal_count,4);
  assert.deepEqual(ranked.probabilities.map(value=>value>=0.5),
    [false,true,true,false,true,true,false]);
  assert.equal(ranked.probabilities[2],0.5+0.5*0.9);
  assert.equal(ranked.probabilities[1],0.5+0.5*0.8,
    'equal scores must use symbol ascending as a deterministic tie break');
  assert.ok(ranked.probabilities[5]>ranked.probabilities[2]);
  assert.equal(ranked.selected_scores_preserve_rank,true);
  assert.equal(ranked.tie_break_order,
    'PROBABILITY_DESCENDING_THEN_SYMBOL_ASCENDING_THEN_ID_ASCENDING');
  assert.throws(()=>topKProbabilitySignals(rows,scores,0),
    /NEURAL_TOP_K_TIMESTAMP_INPUT_INVALID/);
});

test('outer validation never selects Top-K and the holdout remains locked',()=>{
  const rows=makeRows(),sourceCommitSha='8'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  assert.equal(report.holdout_access.opened,false);
  const validation=report.models.TCN_LSTM_HYBRID.validation;
  assert.equal(validation.threshold_selection,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
  assert.equal(validation.selected_threshold,0.15);
  assert.equal(validation.threshold_selection_sample_count,0);
  assert.deepEqual(validation.threshold_trials,[]);
  assert.equal(validation.expanded_threshold_window_counterfactual.status,
    'DISABLED_STRICT_OUTER_EVALUATION_ONLY');
  assert.equal(validation.expanded_threshold_window_counterfactual.affects_primary_threshold,false);
  assert.equal(validation.expanded_threshold_window_counterfactual.holdout_values_used,false);
  assert.equal(validation.expanded_threshold_window_counterfactual.rank_based_top_k_policy,undefined);
  assert.equal(report.holdout_access.opening_protocol.status,'LOCKED');
});

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

test('fixed-SHA calibration, threshold-selection and outer-validation blocks are independently purged',()=>{
  const rows=validateFourHourRows(makeRows({days:40,rowsPerDay:600}));
  const split=splitFourHourRows(rows);
  const blocks=buildNeuralClosureCalibrationBlocks(split.validation);
  assert.ok(blocks.fit.length>0);
  assert.ok(blocks.purged.length>0);
  assert.ok(blocks.check.length>0);
  for(const name of ['fit','threshold_selection','check']){
    assert.ok(blocks.support[name].positive>=50,
      name+' positive support must remain at least 50');
    assert.ok(blocks.support[name].negative>=50,
      name+' negative support must remain at least 50');
  }
  const fitDays=new Set(blocks.days.fit);
  const purgeDays=new Set(blocks.days.purge);
  const thresholdDays=new Set(blocks.days.threshold_selection);
  const thresholdPurgeDays=new Set(blocks.days.threshold_purge);
  const checkDays=new Set(blocks.days.check);
  const sets=[fitDays,purgeDays,thresholdDays,thresholdPurgeDays,checkDays];
  for(let i=0;i<sets.length;i++){
    for(let j=i+1;j<sets.length;j++)
      assert.equal([...sets[i]].some(day=>sets[j].has(day)),false,
        'chronological blocks must be disjoint');
  }
  assert.ok(Math.max(...blocks.days.fit)<Math.min(...blocks.days.purge));
  assert.ok(Math.max(...blocks.days.purge)<Math.min(...blocks.days.threshold_selection));
  assert.ok(Math.max(...blocks.days.threshold_selection)<Math.min(...blocks.days.threshold_purge));
  assert.ok(Math.max(...blocks.days.threshold_purge)<Math.min(...blocks.days.check));
});

test('calibrator method is fixed from fit rows and cannot be selected by validation-check labels',()=>{
  const fitRows=Array.from({length:200},(_,index)=>({
    id:'CAL-FIT-'+index,target:index%2
  }));
  const checkRows=Array.from({length:80},(_,index)=>({
    id:'CAL-CHECK-'+index,target:index%2
  }));
  const rawMap=new Map([...fitRows,...checkRows].map(row=>[
    row.id,row.target===1?0.70:0.30
  ]));
  const fitted=chooseCalibration(rawMap,fitRows,checkRows,20);
  const flippedCheck=checkRows.map(row=>({...row,target:1-row.target}));
  const flipped=chooseCalibration(rawMap,fitRows,flippedCheck,20);
  assert.equal(fitted.check_block_used_for_calibrator_selection,false);
  assert.equal(fitted.selection_scope,'PREDECLARED_PLATT_FIT_ON_CALIBRATION_FIT_ONLY');
  assert.equal(fitted.platt.fit_partition,'CALIBRATION_FIT_ONLY');
  assert.equal(fitted.temperature.fitted,false);
  assert.equal(fitted.selected_method,flipped.selected_method);
  assert.deepEqual(fitted.selected_calibrator,flipped.selected_calibrator,
    'changing only validation-check labels must not change fitted calibration parameters');
  assert.notEqual(fitted.selected_check_brier,flipped.selected_check_brier,
    'validation-check labels may change the reported evaluation score, not the fitted calibrator');
});

test('calibration preflight reports insufficient class support without reducing the 50-row floor',()=>{
  const rows=validateFourHourRows(makeRows({days:20,rowsPerDay:100}));
  const split=splitFourHourRows(rows);
  const blocks=buildNeuralClosureCalibrationBlocks(split.validation);
  assert.ok(blocks.support.fit.positive<50||blocks.support.check.positive<50||
    blocks.support.fit.negative<50||blocks.support.check.negative<50);
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

test('Platt calibration can learn an inverse score orientation using calibration-fit labels only',()=>{
  const labels=Array.from({length:240},(_,index)=>index%2);
  const logits=labels.map((target,index)=>target
    ?-1.1-(index%5)*0.03
    :0.9+(index%7)*0.02);
  const fitted=fitPlattScaler(logits,labels);
  assert.equal(fitted.status,'FITTED');
  assert.equal(fitted.fitted,true);
  assert.equal(fitted.accepted,true);
  assert.equal(fitted.slope_orientation,'NEGATIVE');
  assert.ok(fitted.slope<0);
  assert.ok(fitted.fit_nll_after<fitted.fit_nll_before);
  assert.ok(fitted.orientation_trials.some(row=>
    row.orientation==='POSITIVE'&&Number.isFinite(row.fit_nll_after)));
  assert.ok(fitted.orientation_trials.some(row=>
    row.orientation==='NEGATIVE'&&Number.isFinite(row.fit_nll_after)));
  assert.ok(applyProbabilityCalibrator(0.8,fitted)<
    applyProbabilityCalibrator(0.2,fitted),
    'an accepted negative Platt slope must reverse probability order');
});

test('realized PnL uses actual first-touch fills and prices opening gaps conservatively',()=>{
  const up={
    outcome:'UP',execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
    realized_return_pct:3,
    first_touch:{resolution:'TAKE_PROFIT_FIRST',first_touch_at:BASE+60_000,
      baseline_price:100,take_profit_price:103,stop_loss_price:98,
      exit_price:103,exit_price_source:'BARRIER',
      exit_candle:{open_time:BASE+1,close_time:BASE+60_000,
        open:100,high:103.2,low:99.2,close:102.8,
        is_closed:true,source:'BINANCE_PUBLIC_REST'}}
  };
  const down={
    outcome:'DOWN',execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
    realized_return_pct:-2,
    first_touch:{resolution:'STOP_LOSS_FIRST',first_touch_at:BASE+60_000,
      baseline_price:100,take_profit_price:103,stop_loss_price:98,
      exit_price:98,exit_price_source:'BARRIER',
      exit_candle:{open_time:BASE+1,close_time:BASE+60_000,
        open:100,high:102,low:97.8,close:98.3,
        is_closed:true,source:'BINANCE_PUBLIC_REST'}}
  };
  const flat={
    outcome:'FLAT',execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
    realized_return_pct:1.25,
    first_touch:{resolution:'HORIZON_END',first_touch_at:BASE+NEURAL_CLOSURE_HORIZON_MS,
      baseline_price:100,take_profit_price:103,stop_loss_price:98,
      exit_price:101.25,exit_price_source:'HORIZON_CLOSE',
      exit_candle:{open_time:BASE+1+239*60_000,
        close_time:BASE+NEURAL_CLOSURE_HORIZON_MS,
        open:101,high:101.5,low:100.8,close:101.25,
        is_closed:true,source:'BINANCE_PUBLIC_REST'}}
  };

  assert.ok(Math.abs(realizedExecutionGrossReturnPct(up)-3)<1e-10);
  assert.ok(Math.abs(realizedExecutionGrossReturnPct(down)+2)<1e-10);
  assertClose(realizedExecutionGrossReturnPct(flat),1.25);
  const gapUp={...up,realized_return_pct:4,first_touch:{...up.first_touch,
    first_touch_at:BASE+1,exit_price:104,exit_price_source:'OPEN_GAP',
    exit_candle:{open_time:BASE+1,close_time:BASE+60_000,
      open:104,high:104.2,low:103.9,close:104.1,
      is_closed:true,source:'BINANCE_PUBLIC_REST'}}};
  const gapDown={...down,realized_return_pct:-3.5,first_touch:{...down.first_touch,
    first_touch_at:BASE+1,exit_price:96.5,exit_price_source:'OPEN_GAP',
    exit_candle:{open_time:BASE+1,close_time:BASE+60_000,
      open:96.5,high:99,low:96,close:96.8,
      is_closed:true,source:'BINANCE_PUBLIC_REST'}}};
  assertClose(realizedExecutionGrossReturnPct(gapUp),4);
  assertClose(realizedExecutionGrossReturnPct(gapDown),-3.5);
  const overstatedBarrierFill={...up,realized_return_pct:3.5,first_touch:{...up.first_touch,
    exit_price:103.5}};
  assert.equal(realizedExecutionGrossReturnPct(overstatedBarrierFill),null,
    'a barrier fill cannot claim a price better than the actual +3% barrier');
  const unsupportedExitCandle={...up,first_touch:{...up.first_touch,
    exit_candle:{...up.first_touch.exit_candle,high:102.9}}};
  assert.equal(realizedExecutionGrossReturnPct(unsupportedExitCandle),null,
    'the recorded exit candle must actually cross the declared barrier');
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
    execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
    outcome:'UP',target:1,realized_return_pct:3,
    first_touch:{...malformed.first_touch,first_touch_at:BASE+60_000,
      path_resolution:'1M',observed_candles:240,
      raw_klines_sha256:'a'.repeat(64)}
  }]),/EXIT_BARRIER_INVALID/);
});


test('event-driven Spot portfolio caps overlapping exposure and marks MAE before exits',()=>{
  const rows=Array.from({length:40},(_,index)=>{
    const at=BASE;
    const exitAt=at+3*60*60_000;
    return {
      id:'OVERLAP:'+index,
      symbol:'OVERLAP'+String(index).padStart(3,'0')+'USDT',
      at,outcome:'DOWN',
      resolved_at:at+NEURAL_CLOSURE_HORIZON_MS,
      realized_return_pct:-20,
      execution_return_contract:NEURAL_CLOSURE_EXECUTION_RETURN_CONTRACT,
      first_touch:{
        resolution:'STOP_LOSS_FIRST',first_touch_at:exitAt,
        baseline_price:100,take_profit_price:103,stop_loss_price:98,
        exit_price:80,exit_price_source:'OPEN_GAP',
        exit_candle:{open_time:exitAt,close_time:exitAt+59_999,
          open:80,high:80.5,low:79,close:80.2,
          is_closed:true,source:'BINANCE_PUBLIC_REST'}
      },
      max_adverse_excursion_pct:-20,
      max_adverse_excursion_at:exitAt,
      max_favorable_excursion_pct:0,
      max_favorable_excursion_at:at+60*60_000
    };
  });
  const result=simulateFirstTouchPaperPortfolio(rows,Array(40).fill(0.95),{
    threshold:0.5,roundTripCostBps:30,maxConcurrentPositions:30,initialEquity:100
  });
  assert.equal(result.signal_count,40);
  assert.equal(result.trade_count,30);
  assert.equal(result.skipped_capacity,10);
  assert.equal(result.max_concurrent_positions,30);
  assert.equal(result.return_data_status,'COMPLETE');
  assert.equal(result.position_fraction_pct,100/30);
  assertClose(result.net_pnl_pct,-20.3);
  assertClose(result.max_drawdown_pct,20.3);
  assert.equal(result.portfolio_simulation.method,
    'EVENT_DRIVEN_FIRST_TOUCH_EXECUTION_MTM_V1');
  assert.equal(NEURAL_CLOSURE_PORTFOLIO_POLICY.same_timestamp_exit_before_entry,true);
});

test('fixed-SHA evaluator scores the full outer block with identity calibration and a predeclared threshold',()=>{
  const rows=makeRows(),sourceCommitSha='a'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictionsByModel=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const split=splitFourHourRows(rows);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel,modelArtifactsByModel,sourceCommitSha
  });
  assert.equal(report.schema,'RADARX_BUILD224_FIXED_SHA_NEURAL_CLOSURE_BENCHMARK_V3');
  assert.equal(report.target.definition,NEURAL_CLOSURE_TARGET_DEFINITION);
  assert.equal(report.target.horizon_ms,NEURAL_CLOSURE_HORIZON_MS);
  assert.equal(report.integrity.row_count,rows.length);
  assert.match(report.integrity.dataset_sha256,/^[a-f0-9]{64}$/);
  assert.match(report.integrity.fixed_benchmark_sha256,/^[a-f0-9]{64}$/);
  assert.match(report.integrity.model_artifacts_sha256,/^[a-f0-9]{64}$/);
  assert.match(report.integrity.prediction_matrix_sha256,/^[a-f0-9]{64}$/);
  assert.equal(report.integrity.verified_model_artifacts,NEURAL_CLOSURE_MODEL_FAMILIES.length);
  assert.equal(report.split.purge_ms,NEURAL_CLOSURE_PURGE_MS);
  assert.equal(report.models.LOGISTIC_REGRESSION.status,'VALIDATION_EVALUATED');
  assert.equal(report.models.LOGISTIC_REGRESSION.validation.sample_count,split.validation.length);
  assert.equal(report.models.LOGISTIC_REGRESSION.validation.selected_threshold,0.15);
  assert.equal(report.models.LOGISTIC_REGRESSION.validation.threshold_selection,
    'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.evaluated,false);
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.brier_score,null);
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    const model=report.models[family];
    assert.equal(model.model_artifact_sha256,modelArtifactsByModel[family].artifact_sha256);
    assert.equal(model.calibration.schema,'RADARX_OUTER_VALIDATION_IDENTITY_PROBABILITY_STAGE_V1');
    assert.equal(model.calibration.status,'RAW_FALLBACK_NO_CALIBRATION_APPLIED');
    assert.equal(model.calibration.selected_method,'NO_CALIBRATION');
    assert.equal(model.calibration.applied_to_final_model,false);
    assert.equal(model.calibration.fit_rows,0);
    assert.equal(model.calibration.outer_validation_labels_used_for_calibrator_fit,false);
    assert.equal(model.validation.sample_count,split.validation.length);
    assert.equal(model.validation.calibration_applied,false);
    assert.equal(model.validation.calibrated_brier_score,model.validation.raw_brier_score);
    assert.ok(Number.isFinite(model.validation.raw_brier_score));
    assert.equal(model.validation.evaluation_brier_score,model.validation.raw_brier_score);
    assert.equal(model.validation.selected_threshold,0.15);
    assert.equal(model.validation.threshold_selection,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
    assert.equal(model.validation.threshold_selection_sample_count,0);
    assert.deepEqual(model.validation.threshold_trials,[]);
    assert.equal(model.holdout.evaluated,false);
    assert.equal(model.holdout.brier_score,null);
    assert.equal(model.acceptance.passed,false);
  }
  assert.equal(report.holdout_access.opened,false);
  assert.equal(report.holdout_access.opening_protocol.status,'LOCKED');
  assert.equal(report.status,'NEURAL_SUPERIORITY_NOT_PROVEN');
});

test('fixed-SHA evaluator keeps every holdout metric locked when the required validation Brier margin is mathematically unreachable',()=>{
  const rows=makeRows(),sourceCommitSha='d'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const logisticById=new Map(predictions.LOGISTIC_REGRESSION.map(row=>[row.id,row.probability]));
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    predictions[family]=predictions[family].map(row=>({
      ...row,probability:logisticById.get(row.id),
      artifact_sha256:modelArtifactsByModel[family].artifact_sha256
    }));
  }
  const qualificationByModel=Object.fromEntries(
    NEURAL_CLOSURE_MODEL_FAMILIES.map(family=>[family,{
      passed:true,reason:'TEST_INNER_QUALIFICATION_PASSED',diagnostic_only:false
    }])
  );
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,
    sourceCommitSha,qualificationByModel,requiredBrierImprovement:2
  });
  assert.equal(report.holdout_access.opened,false);
  assert.equal(report.holdout_access.opened_for_models.length,0);
  assert.equal(report.split.holdout_support_opened,false);
  assert.equal(report.models.LOGISTIC_REGRESSION.status,'VALIDATION_EVALUATED');
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.evaluated,false);
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.brier_score,null);
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    assert.equal(report.models[family].status,'VALIDATION_EVALUATED_HOLDOUT_LOCKED',family);
    assert.equal(report.models[family].validation.outer_validation_gate.passed,false,family);
    assert.ok(report.models[family].validation.outer_validation_gate.brier_improvement_vs_logistic<=1,
      'Brier improvement cannot exceed 1');
    assert.equal(report.models[family].holdout.evaluated,false,family);
    assert.equal(report.models[family].holdout.brier_score,null,family);
    assert.equal(report.models[family].holdout.trade_count,0,family);
    assert.equal(report.models[family].acceptance.status,
      'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES',family);
  }
  assert.equal(report.status,'NEURAL_SUPERIORITY_NOT_PROVEN');
});

test('raw Brier remains the primary model comparison while train-only calibrated probabilities drive frozen execution',()=>{
  const rows=makeRows(),sourceCommitSha='b'.repeat(40);
  const artifacts=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,artifacts);
  const logisticMetadata={
    schema:'TEST_TRAIN_ONLY_CROSSFITTED_CALIBRATION_V1',
    status:'SELECTED_PLATT_SCALING',selected_method:'PLATT_SCALING',
    applied_to_final_model:true,training_partition_only:true,
    fit_partition:'PENULTIMATE_PURGED_TRAIN_ONLY_OOF_FOLD',
    outer_validation_used_for_calibrator_fit:false,
    outer_validation_used_for_calibrator_selection:false,
    holdout_used_for_calibration:false
  };
  predictions.LOGISTIC_REGRESSION=predictions.LOGISTIC_REGRESSION.map(item=>({
    ...item,raw_probability:item.probability,
    calibrated_probability:item.probability>=0.5?0.10:0.01,
    calibration_metadata:logisticMetadata
  }));
  const split=splitFourHourRows(rows);
  const byId=new Map(predictions.LOGISTIC_REGRESSION.map(item=>[item.id,item]));
  const expectedRaw=split.validation.reduce((sum,row)=>{
    const p=byId.get(row.id).raw_probability;
    return sum+(p-row.target)**2;
  },0)/split.validation.length;
  const expectedCalibrated=split.validation.reduce((sum,row)=>{
    const p=byId.get(row.id).calibrated_probability;
    return sum+(p-row.target)**2;
  },0)/split.validation.length;
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel:artifacts,sourceCommitSha
  });
  const validation=report.models.LOGISTIC_REGRESSION.validation;
  assert.ok(Math.abs(validation.raw_brier_score-expectedRaw)<1e-12);
  assert.ok(Math.abs(validation.calibrated_brier_score-expectedCalibrated)<1e-12);
  assert.equal(validation.evaluation_brier_score,validation.raw_brier_score,
    'neural representation comparison must use native/raw probability outputs');
  assert.equal(validation.calibration_applied,true);
  assert.equal(validation.probability_evaluation_method,
    'RAW_PRIMARY_WITH_TRAIN_ONLY_CROSSFITTED_CALIBRATED_EXECUTION_STAGE');
  assert.equal(validation.execution_probability_stage,'TRAIN_ONLY_CROSSFITTED_CALIBRATED');
  assert.equal(validation.validation_threshold_metrics.signal_count,0,
    'fixed threshold execution must consume the train-only calibrated probabilities');
  assert.equal(validation.reliability_diagnostics.raw.status,'AVAILABLE');
  assert.equal(validation.reliability_diagnostics.calibrated.status,'AVAILABLE');
  assert.equal(validation.raw_classification_metrics.sample_count,split.validation.length);
  assert.equal(validation.calibrated_classification_metrics.sample_count,split.validation.length);
  assert.equal(validation.calibration.outer_validation_used_for_calibrator_fit,false);
  assert.equal(validation.calibration.outer_validation_used_for_calibrator_selection,false);
  assert.equal(report.holdout_access.opened,false);
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.brier_score,null);

  predictions.LOGISTIC_REGRESSION=predictions.LOGISTIC_REGRESSION.map(item=>({
    ...item,calibration_metadata:{
      ...logisticMetadata,outer_validation_used_for_calibrator_fit:true
    }
  }));
  const invalid=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel:artifacts,sourceCommitSha
  });
  assert.equal(invalid.models.LOGISTIC_REGRESSION.status,'NOT_EVALUATED');
  assert.equal(invalid.models.LOGISTIC_REGRESSION.reason,
    'MODEL_CALIBRATION_PROVENANCE_INVALID:LOGISTIC_REGRESSION');
  assert.equal(invalid.holdout_access.opened,false);
});

test('outer probability distributions report native model scores without calibration or policy selection',()=>{
  const rows=makeRows(),sourceCommitSha='c'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const split=splitFourHourRows(rows);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  for(const family of ['LOGISTIC_REGRESSION',...NEURAL_CLOSURE_MODEL_FAMILIES]){
    const validation=report.models[family].validation;
    const emptySelection=validation.threshold_selection_probability_distribution;
    assert.equal(validation.threshold_selection_sample_count,0,family);
    assert.equal(emptySelection.raw.sample_count,0,family);
    assert.equal(emptySelection.calibrated.sample_count,0,family);
    const outer=validation.outer_validation_probability_distribution;
    assert.equal(outer.raw.schema,'NEURAL_ENTRY_PROBABILITY_DISTRIBUTION_V1',family);
    assert.equal(outer.calibrated.schema,'NEURAL_ENTRY_PROBABILITY_DISTRIBUTION_V1',family);
    assert.equal(outer.raw.status,'AVAILABLE',family);
    assert.equal(outer.calibrated.status,'AVAILABLE',family);
    assert.equal(outer.raw.sample_count,split.validation.length,family);
    assert.equal(outer.calibrated.sample_count,split.validation.length,family);
    assert.equal(outer.raw.minimum,outer.calibrated.minimum,family);
    assert.equal(outer.raw.maximum,outer.calibrated.maximum,family);
    assert.equal(validation.calibration_applied,false,family);
    assert.equal(validation.selected_threshold,0.15,family);
    assert.deepEqual(validation.threshold_trials,[],family);
  }
});

test('chronological stability diagnostics are evaluation-only on the full outer block',()=>{
  const rows=makeRows(),sourceCommitSha='d'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const split=splitFourHourRows(rows);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  const diagnostic=report.models.TCN_LSTM_HYBRID.validation.chronological_stability_diagnostics;
  assert.equal(diagnostic.schema,'RADARX_MODEL_CHRONOLOGICAL_STABILITY_V1');
  assert.equal(diagnostic.threshold_selection.status,'NOT_EVALUATED_NO_OUTER_POLICY_SELECTION');
  const outer=diagnostic.outer_validation;
  assert.equal(outer.schema,'RADARX_CHRONOLOGICAL_STABILITY_DIAGNOSTICS_V1');
  assert.equal(outer.status,'AVAILABLE');
  assert.equal(outer.labels_used_for_scoring,true);
  assert.equal(outer.labels_used_for_fit,false);
  assert.equal(outer.labels_used_for_threshold_selection,false);
  assert.equal(outer.affects_primary_probabilities,false);
  assert.equal(outer.affects_acceptance_gates,false);
  assert.equal(outer.holdout_values_used,false);
  assert.equal(outer.sample_count,split.validation.length);
  assert.equal(outer.blocks.reduce((sum,block)=>sum+block.sample_count,0),split.validation.length);
  assert.ok(outer.block_count>=2);
  assert.equal(report.holdout_access.opened,false);
});

test('chronological stability partitions do not split equal decision timestamps',()=>{
  const rows=makeRows({days:60,rowsPerDay:200}),sourceCommitSha='5'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  const blocks=report.models.TCN_LSTM_HYBRID.validation
    .chronological_stability_diagnostics.outer_validation.blocks;
  assert.ok(blocks.length>=2);
  for(let index=0;index<blocks.length;index++){
    assert.ok(blocks[index].first_at<=blocks[index].last_at);
    if(index>0)assert.ok(blocks[index-1].last_at<blocks[index].first_at,
      'one timestamp group cannot straddle two adjacent chronological blocks');
  }
  assert.equal(report.holdout_access.opened,false);
});

test('walk-forward recalibration uses only prior matured labels and keeps one-day purges',()=>{
  const rows=makeRows({days:60,rowsPerDay:200});
  const rawMap=new Map(rows.map(row=>[
    row.id,row.target===1?0.24:0.055+(Number(row.id.split(':E')[1])%5)*0.002
  ]));
  // An unresolved fit label must be excluded from the first forward history.
  const initialFitDayCount=Math.floor(60*0.5);
  const firstForwardAt=BASE+(initialFitDayCount+1)*NEURAL_CLOSURE_PURGE_MS;
  rows[initialFitDayCount*200-1].resolved_at=firstForwardAt+1;
  const result=buildWalkForwardCalibrationDiagnostics(rows,rawMap,{
    fitFraction:0.5,minimumClassSupport:50,maximumBlocks:4,minimumTestDays:2
  });
  assert.equal(result.status,'AVAILABLE',result.reason??JSON.stringify(result));
  assert.equal(result.diagnostic_only,true);
  assert.equal(result.holdout_values_used,false);
  assert.equal(result.labels_used_for_gradient_fit,false);
  assert.equal(result.labels_used_for_current_or_future_block_calibration,false);
  assert.equal(result.calibration_uses_only_prior_matured_labels,true);
  assert.equal(result.scored_block_count,4);
  assert.ok(result.scored_rows>0);
  let historyCount=0;
  for(const block of result.blocks){
    assert.ok(block.latest_history_label_resolved_at<block.first_at);
    assert.ok(block.calibration_to_test_purge_gap_ms>NEURAL_CLOSURE_PURGE_MS);
    assert.ok(block.latest_label_maturity_gap_ms>0);
    assert.ok(block.calibration_history_rows>=historyCount);
    historyCount=block.calibration_history_rows;
  }
  assert.ok(result.blocks[0].excluded_unmatured_history_rows>=1);
  assert.ok(Number.isFinite(result.aggregate.static_brier_score));
  assert.ok(Number.isFinite(result.aggregate.adaptive_brier_score));
});

// [RUN-NEURAL-REBENCHMARK] Test causal first-block threshold selection on the immutable run-99 cohort.
// [RUN-NEURAL-REBENCHMARK] Split matched forward ranking and calibration metrics by the closed BTC regime feature.
test('walk-forward BTC regime diagnostics partition every forward row and compare both regimes with Logistic',()=>{
  const rows=makeRows({days:60,rowsPerDay:200});
  for(const row of rows){
    const match=String(row.symbol).match(/S(\d+)USDT/);
    const symbolIndex=Number(match?.[1]??0);
    const trend=symbolIndex%2===0?1:-1;
    row.temporal_sequence=Array.from({length:24},(_,step)=>{
      const channels=Array(29).fill(0);
      channels[19]=step===23?trend:0;
      return channels;
    });
  }
  const modelMap=new Map(rows.map(row=>[
    row.id,row.target===1?0.24:0.055+(Number(row.id.split(':E')[1])%5)*0.002
  ]));
  const logisticMap=new Map(rows.map(row=>[
    row.id,0.07+(Number(row.id.split(':E')[1])%13)*0.001
  ]));
  const result=buildWalkForwardCalibrationDiagnostics(rows,modelMap,{
    fitFraction:0.5,minimumClassSupport:50,maximumBlocks:4,minimumTestDays:2,
    baselineRawMap:logisticMap
  });
  assert.equal(result.status,'AVAILABLE',result.reason??JSON.stringify(result));
  for(const block of result.blocks){
    const regimes=block.btc_regime_diagnostics;
    assert.ok(regimes);
    const covered=regimes.BTC_RISK_ON.sample_count+
      regimes.BTC_RISK_OFF.sample_count+
      regimes.BTC_REGIME_UNKNOWN.sample_count;
    assert.equal(covered,block.sample_count,
      'each forward row must be assigned exactly once to a BTC regime');
    assert.ok(regimes.BTC_RISK_ON.sample_count>0);
    assert.ok(regimes.BTC_RISK_OFF.sample_count>0);
    assert.equal(regimes.BTC_REGIME_UNKNOWN.sample_count,0);
    for(const regime of ['BTC_RISK_ON','BTC_RISK_OFF']){
      const item=regimes[regime];
      assert.ok(Number.isFinite(item.adaptive_brier_score));
      assert.ok(Number.isFinite(item.logistic_baseline.adaptive_model_brier_improvement));
      assert.ok(item.adaptive_ranking_metrics.groups>0);
      assert.ok(item.logistic_baseline.adaptive_ranking_metrics.groups>0);
    }
  }
});

test('walk-forward policy freezes first-block threshold and evaluates later blocks under adaptive calibration',()=>{
  const rows=makeRows({days:60,rowsPerDay:200});
  const rawMap=new Map(rows.map(row=>[row.id,row.target===1?0.8:0.01]));
  const result=buildWalkForwardCalibrationDiagnostics(rows,rawMap,{
    fitFraction:0.5,minimumClassSupport:50,maximumBlocks:4,minimumTestDays:2,
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,maximumDrawdownPct:8
  });
  assert.equal(result.status,'AVAILABLE',result.reason??JSON.stringify(result));
  const policy=result.causal_forward_execution;
  assert.equal(policy.diagnostic_only,true);
  assert.equal(policy.labels_used_for_threshold_selection,'FIRST_FORWARD_BLOCK_ONLY');
  assert.equal(policy.later_threshold_frozen,true);
  assert.equal(policy.adaptive_calibration_used,true);
  assert.equal(policy.holdout_values_used,false);
  assert.ok(Number.isFinite(policy.selection.selected_threshold),
    JSON.stringify(policy.selection));
  assert.equal(policy.later_forward_validation.frozen_threshold,
    policy.selection.selected_threshold);
  assert.equal(policy.later_forward_validation.block_count,3);
  assert.ok(policy.later_forward_validation.sample_count>0);
  assert.equal(policy.later_forward_validation.metrics?.return_data_status,'COMPLETE');
  assert.equal(policy.later_forward_validation.passed,true,
    JSON.stringify(policy.later_forward_validation));
});

// [RUN-NEURAL-REBENCHMARK] Re-evaluate matched forward ranking metrics on the immutable run-99 cohort.
test('walk-forward ranking reports cross-sectional AP and compares the same future blocks with Logistic',()=>{
  const rows=makeRows({days:60,rowsPerDay:200});
  const modelMap=new Map(rows.map(row=>[
    row.id,row.target===1?0.24:0.055+(Number(row.id.split(':E')[1])%5)*0.002
  ]));
  const logisticMap=new Map(rows.map(row=>[
    row.id,0.07+(Number(row.id.split(':E')[1])%13)*0.001
  ]));
  const result=buildWalkForwardCalibrationDiagnostics(rows,modelMap,{
    fitFraction:0.5,minimumClassSupport:50,maximumBlocks:4,minimumTestDays:2,
    baselineRawMap:logisticMap
  });
  assert.equal(result.status,'AVAILABLE',result.reason??JSON.stringify(result));
  assert.equal(result.baseline_comparison_available,true);
  assert.equal(result.ranking_bucket_ms,NEURAL_CLOSURE_RANKING_BUCKET_MS);
  assert.equal(result.scored_block_count,4);
  assert.ok(Number.isFinite(result.aggregate.adaptive_brier_improvement_vs_logistic));
  assert.ok(Number.isFinite(result.aggregate.adaptive_average_precision_improvement_vs_logistic));
  assert.ok(result.aggregate.ranking_metrics.groups>0);
  assert.ok(result.aggregate.logistic_ranking_metrics.groups>0);
  for(const block of result.blocks){
    assert.equal(block.calibration_preserved_cross_sectional_ranking,true,
      'positive-slope Platt calibration must not reorder a cross-sectional group');
    assert.deepEqual(block.static_ranking_metrics,block.adaptive_ranking_metrics);
    assert.ok(block.logistic_baseline.static_ranking_metrics.groups>0);
    assert.ok(Number.isFinite(block.logistic_baseline.adaptive_model_brier_improvement));
    assert.ok(Number.isFinite(block.logistic_baseline.adaptive_average_precision_improvement));
  }
});

test('walk-forward baseline comparison fails closed when a baseline score is missing',()=>{
  const rows=makeRows({days:20,rowsPerDay:100});
  const modelMap=new Map(rows.map(row=>[row.id,0.08]));
  const baselineMap=new Map();
  const result=buildWalkForwardCalibrationDiagnostics(rows,modelMap,{
    baselineRawMap:baselineMap
  });
  assert.equal(result.status,'UNAVAILABLE');
  assert.equal(result.reason,'WALK_FORWARD_BASELINE_SCORE_INVALID');
});

test('walk-forward recalibration fails closed when the probability map is incomplete',()=>{
  const rows=makeRows({days:20,rowsPerDay:100});
  const result=buildWalkForwardCalibrationDiagnostics(rows,new Map());
  assert.equal(result.status,'UNAVAILABLE');
  assert.equal(result.reason,'WALK_FORWARD_MODEL_SCORE_INVALID');
});

test('expanded threshold and Top-K counterfactuals are disabled rather than selected on outer validation',()=>{
  const rows=makeRows(),sourceCommitSha='6'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  for(const family of ['LOGISTIC_REGRESSION','TCN_LSTM_HYBRID']){
    const validation=report.models[family].validation;
    const diagnostic=validation.expanded_threshold_window_counterfactual;
    assert.equal(diagnostic.schema,'RADARX_EXPANDED_THRESHOLD_WINDOW_COUNTERFACTUAL_V1');
    assert.equal(diagnostic.status,'DISABLED_STRICT_OUTER_EVALUATION_ONLY');
    assert.equal(diagnostic.diagnostic_only,true);
    assert.equal(diagnostic.affects_primary_probabilities,false);
    assert.equal(diagnostic.affects_primary_threshold,false);
    assert.equal(diagnostic.affects_acceptance_gates,false);
    assert.equal(diagnostic.holdout_values_used,false);
    assert.equal(validation.threshold_selection,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
    assert.equal(validation.selected_threshold,0.15);
  }
  assert.equal(report.holdout_access.opened,false);
});

test('fixed reference threshold failure and incomplete protocol keep every holdout metric locked',()=>{
  const rows=makeRows(),sourceCommitSha='e'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const evaluated=splitFourHourRows(rows).validation;
  const build=(positive,negative,artifactSha256=null)=>evaluated.map(row=>({
    id:row.id,probability:row.target===1?positive:negative,
    source_commit_sha:sourceCommitSha,target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,artifact_sha256:artifactSha256
  }));
  predictions.LOGISTIC_REGRESSION=build(0.10,0.90,null);
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES)
    predictions[family]=build(0.43,0.41,modelArtifactsByModel[family].artifact_sha256);
  const qualificationByModel=Object.fromEntries(NEURAL_CLOSURE_MODEL_FAMILIES.map(family=>[
    family,{passed:true,reason:'TEST_INNER_SELECTION_PASSED',diagnostic_only:false}
  ]));
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha,qualificationByModel
  });
  assert.equal(report.models.LOGISTIC_REGRESSION.validation.selected_threshold,0.15);
  assert.equal(report.models.LOGISTIC_REGRESSION.validation.threshold_selection,
    'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    const model=report.models[family];
    assert.equal(model.validation.selected_threshold,0.15,family);
    assert.equal(model.validation.threshold_selection,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD',family);
    assert.equal(model.holdout.evaluated,false,family);
    assert.equal(model.holdout.brier_score,null,family);
    assert.equal(model.acceptance.passed,false,family);
  }
  assert.equal(report.holdout_access.opened,false);
  assert.equal(report.holdout_access.opening_protocol.status,'LOCKED');
  assert.equal(report.holdout_access.opening_protocol.holdout_metrics_read,false);
});

test('a neural candidate cannot claim matched execution or open holdout when Logistic has no frozen trade threshold',()=>{
  const rows=makeRows(),sourceCommitSha='f'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const outerSplit=splitFourHourRows(rows);
  const evaluated=outerSplit.validation;
  const build=(positive,negative,artifactSha256=null)=>evaluated.map(row=>({
    id:row.id,
    probability:row.target===1?positive:negative,
    source_commit_sha:sourceCommitSha,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    artifact_sha256:artifactSha256
  }));
  // Without a complete Logistic reference prediction stream there is no
  // same-threshold comparator. Neural probabilities alone cannot open holdout.
  const predictions={};
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES)
    predictions[family]=build(0.85,0.05,modelArtifactsByModel[family].artifact_sha256);
  const qualificationByModel=Object.fromEntries(
    NEURAL_CLOSURE_MODEL_FAMILIES.map(family=>[family,{
      passed:true,reason:'TEST_INNER_SELECTION_PASSED',diagnostic_only:false
    }])
  );
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,
    sourceCommitSha,qualificationByModel
  });
  assert.equal(report.models.LOGISTIC_REGRESSION.status,'NOT_EVALUATED');
  assert.equal(report.models.LOGISTIC_REGRESSION.validation?.selected_threshold??null,null);
  assert.equal(report.holdout_access.opened,false);
  assert.equal(report.holdout_access.opened_for_models.length,0);
  assert.equal(report.holdout_access.reason,'NO_MODEL_PASSED_INNER_AND_OUTER_VALIDATION_GATES');
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout?.evaluated??false,false);
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    const model=report.models[family];
    assert.equal(model.validation.outer_validation_gate.gates.matched_execution_threshold_available,'FAIL',family);
    assert.equal(model.validation.outer_validation_gate.execution_reference,
      'UNAVAILABLE_NO_QUALIFIED_LOGISTIC_THRESHOLD',family);
    assert.equal(model.status,'VALIDATION_EVALUATED_HOLDOUT_LOCKED',family);
    assert.equal(model.holdout.evaluated,false,family);
    assert.equal(model.acceptance.status,'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES',family);
  }
  assert.equal(report.status,'NEURAL_SUPERIORITY_NOT_PROVEN');
});

test('predeclared Logistic threshold remains matched even when its outer execution is weak',()=>{
  const rows=makeRows(),sourceCommitSha='7'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const rowById=new Map([...splitFourHourRows(rows).validation,...splitFourHourRows(rows).holdout]
    .map(row=>[row.id,row]));
  for(const prediction of predictions.LOGISTIC_REGRESSION)prediction.probability=0.05;
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES){
    for(const prediction of predictions[family]){
      const row=rowById.get(prediction.id);
      prediction.probability=row.target===1?0.90:0.01;
    }
  }
  const qualificationByModel=Object.fromEntries(NEURAL_CLOSURE_MODEL_FAMILIES.map(family=>[
    family,{passed:true,reason:'TEST_INNER_SELECTION_PASSED',diagnostic_only:false}
  ]));
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha,qualificationByModel
  });
  const logistic=report.models.LOGISTIC_REGRESSION.validation;
  const neural=report.models.TCN_LSTM_HYBRID.validation.outer_validation_gate;
  assert.equal(logistic.threshold_selection,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
  assert.equal(logistic.selected_threshold,0.15);
  assert.equal(logistic.threshold_selection_gates.selection_role,'PREDECLARED_POLICY_NO_OUTER_SELECTION');
  assert.equal(logistic.threshold_selection_gates.acceptance_qualified,false);
  assert.equal(neural.outer_validation_threshold,0.15);
  assert.equal(neural.execution_reference,'MATCHED_LOGISTIC_EXECUTION_THRESHOLD');
  assert.equal(neural.gates.matched_execution_threshold_available,'PASS');
  assert.equal(neural.threshold_selection_method,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD_0_15_NO_OUTER_FIT');
  assert.equal(report.holdout_access.opened,false);
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
    if(index===0&&first==='GAP_UP'){open=104;high=104.2;low=103.9;close=104.1;}
    if(index===0&&first==='GAP_DOWN'){open=96.5;high=99;low=96;close=96.8;}
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
  assert.equal(up.first_touch.exit_price,103);
  assert.equal(up.first_touch.exit_price_source,'BARRIER');
  assertClose(up.realized_return_pct,3);
  assertClose(up.horizon_close_return_pct,0.5);
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
  assert.equal(down.first_touch.exit_price,98);
  assertClose(down.realized_return_pct,-2);
  const flat=buildFourHourFirstTouchOutcome({
    id:'label-flat',symbol:'SOLUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'SOLUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('FLAT')
  });
  assert.equal(flat.outcome,'FLAT');
  assert.equal(flat.first_touch.resolution,'HORIZON_END');
  assert.equal(flat.first_touch.exit_price,100.5);
  assertClose(flat.realized_return_pct,0.5);
  assert.equal(flat.first_touch.exit_price_source,'HORIZON_CLOSE');
  const gapUp=buildFourHourFirstTouchOutcome({
    id:'label-gap-up',symbol:'ADAUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'ADAUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('GAP_UP')
  });
  assert.equal(gapUp.outcome,'UP');
  assert.equal(gapUp.first_touch.exit_price,104);
  assert.equal(gapUp.first_touch.exit_price_source,'OPEN_GAP');
  assertClose(gapUp.realized_return_pct,4);
  assert.equal(gapUp.first_touch.first_touch_at,at+1);
  const gapDown=buildFourHourFirstTouchOutcome({
    id:'label-gap-down',symbol:'DOTUSDT',
    sourceEvidence:{exchange:'BINANCE',market:'SPOT',interval:'1m',
      transport:'BINANCE_PUBLIC_REST',symbol:'DOTUSDT',
      received_at:at+NEURAL_CLOSURE_HORIZON_MS+60_000},baselineAt:at,baselinePrice:100,
    candles:makeCandles('GAP_DOWN')
  });
  assert.equal(gapDown.outcome,'DOWN');
  assert.equal(gapDown.first_touch.exit_price,96.5);
  assertClose(gapDown.realized_return_pct,-3.5);
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


test('streaming canonical array digest is byte-identical to the reference canonical JSON digest',()=>{
  const rows=[
    {z:3,a:{y:[1,2,3],b:'first'},values:[[0.1,0.2],[0.3,0.4]]},
    {b:true,a:{c:null,a:'second'},values:[[1,2,3],[4,5,6]]},
    {id:'last',nested:{z:9,m:4,a:1}}
  ];
  const mapRow=row=>({id:row.id??null,features:row.values??null,source:row});
  assert.equal(
    sha256CanonicalArrayMapped(rows,mapRow),
    sha256Canonical(rows.map(mapRow))
  );
  assert.equal(
    sha256CanonicalArrayMapped([],row=>row),
    sha256Canonical([])
  );
  assert.throws(()=>sha256CanonicalArrayMapped({},row=>row),/CANONICAL_ROWS_REQUIRED/);
  assert.throws(()=>sha256CanonicalArrayMapped(rows,null),/ROW_MAPPER_REQUIRED/);
});


test('mapped canonical array hashing matches canonical full-array hashing without mapped-array allocation',()=>{
  const rows=[
    {id:'A',features:{z:2,a:1},temporal_sequence:[[0,1],[2,3]]},
    {id:'B',features:{a:4,z:3},temporal_sequence:[[4,5],[6,7]]}
  ];
  const mapRow=row=>({
    id:row.id,features:row.features,temporal_sequence:row.temporal_sequence
  });
  const mapped=sha256CanonicalArrayMapped(rows,mapRow);
  const materialized=sha256Canonical(rows.map(mapRow));
  assert.equal(mapped,materialized);
});

test('TCN-LSTM diagnostics explicitly disable outer-validation calibration stages',()=>{
  const rows=makeRows(),sourceCommitSha='1'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const qualificationByModel=Object.fromEntries(NEURAL_CLOSURE_MODEL_FAMILIES.map(family=>[
    family,{passed:false,reason:'TEST_DIAGNOSTIC_ONLY',diagnostic_only:true}
  ]));
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha,qualificationByModel
  });
  const validation=report.models.TCN_LSTM_HYBRID.validation;
  const diagnostics=validation.probability_stage_diagnostics;
  assert.equal(diagnostics.schema,'RADARX_TCN_LSTM_PROBABILITY_STAGE_DIAGNOSTICS_V1');
  assert.equal(diagnostics.status,'DISABLED_STRICT_OUTER_EVALUATION_ONLY');
  assert.equal(diagnostics.diagnostic_only,true);
  assert.equal(diagnostics.labels_used,false);
  assert.equal(diagnostics.holdout_values_used,false);
  assert.equal(diagnostics.affects_primary_probabilities,false);
  assert.equal(diagnostics.affects_threshold_selection,false);
  assert.equal(validation.calibration_applied,false);
  assert.equal(validation.calibrated_brier_score,validation.raw_brier_score);
  assert.ok(Number.isFinite(validation.raw_brier_score));
  assert.equal(validation.threshold_selection_sample_count,0);
  assert.equal(report.holdout_access.opened,false);

  const altered=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const validationIds=new Set(splitFourHourRows(rows).validation.map(row=>row.id));
  altered.TCN_LSTM_HYBRID=altered.TCN_LSTM_HYBRID.map(item=>
    validationIds.has(item.id)
      ?{...item,pre_inner_calibration_probability:item.probability>=0.5?0.99:0.01}
      :item
  );
  const alteredReport=runNeuralClosureBenchmark({
    rows,predictionsByModel:altered,modelArtifactsByModel,sourceCommitSha,qualificationByModel
  });
  const alteredValidation=alteredReport.models.TCN_LSTM_HYBRID.validation;
  assert.equal(alteredValidation.raw_brier_score,validation.raw_brier_score);
  assert.equal(alteredValidation.evaluation_brier_score,validation.evaluation_brier_score);
  assert.deepEqual(alteredValidation.outer_validation_gate,validation.outer_validation_gate);
  assert.deepEqual(alteredValidation.threshold_trials,[]);
});

test('fixed-SHA evaluator rejects any prediction row from the untouched holdout',()=>{
  const rows=makeRows(),sourceCommitSha='2'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  const holdoutRow=splitFourHourRows(rows).holdout[0];
  predictions.TCN_LSTM_HYBRID.push({
    id:holdoutRow.id,probability:0.77,raw_probability:0.77,
    calibrated_probability:0.77,pre_inner_calibration_probability:0.77,
    source_commit_sha:sourceCommitSha,
    target_definition:NEURAL_CLOSURE_TARGET_DEFINITION,
    target_semantics:NEURAL_CLOSURE_TARGET_SEMANTICS,
    artifact_sha256:modelArtifactsByModel.TCN_LSTM_HYBRID.artifact_sha256
  });
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha
  });
  assert.equal(report.models.TCN_LSTM_HYBRID.status,'NOT_EVALUATED');
  assert.match(report.models.TCN_LSTM_HYBRID.reason,/MODEL_PREDICTION_ROW_SET_MISMATCH/);
  assert.equal(report.holdout_access.opened,false);
  assert.equal(report.holdout_access.opening_protocol.holdout_metrics_read,false);
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.evaluated,false);
  assert.equal(report.models.LOGISTIC_REGRESSION.holdout.brier_score,null);
});

test('missing Logistic predictions prevent a matched comparison without changing the frozen policy',()=>{
  const rows=makeRows(),sourceCommitSha='3'.repeat(40);
  const modelArtifactsByModel=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,modelArtifactsByModel);
  delete predictions.LOGISTIC_REGRESSION;
  for(const family of NEURAL_CLOSURE_MODEL_FAMILIES)
    predictions[family]=predictions[family].map(row=>({
      ...row,probability:0.05,artifact_sha256:modelArtifactsByModel[family].artifact_sha256
    }));
  const qualificationByModel=Object.fromEntries(NEURAL_CLOSURE_MODEL_FAMILIES.map(family=>[
    family,{passed:true,reason:'TEST_INNER_QUALIFICATION_PASSED',diagnostic_only:false}
  ]));
  const report=runNeuralClosureBenchmark({
    rows,predictionsByModel:predictions,modelArtifactsByModel,sourceCommitSha,qualificationByModel
  });
  assert.equal(report.models.LOGISTIC_REGRESSION.status,'NOT_EVALUATED');
  const validation=report.models.TCN_LSTM_HYBRID.validation;
  assert.equal(validation.threshold_selection,'PREDECLARED_FROZEN_REFERENCE_THRESHOLD');
  assert.equal(validation.selected_threshold,0.15);
  assert.ok(validation.validation_threshold_metrics);
  assert.equal(validation.outer_validation_gate.gates.matched_execution_threshold_available,'FAIL');
  assert.equal(validation.outer_validation_gate.gates.matched_outer_validation_execution_risk_gates,'NOT_EVALUATED');
  assert.equal(report.holdout_access.opened,false);
});

test('score threshold policy abstains per bucket and Logistic matches its trade count',()=>{
  const rows=makeRows({days:1,rowsPerDay:30});
  const scores=rows.map((row,index)=>{
    const group=Math.floor(index/15),within=index%15;
    if(within===0)return group===0?1.0:0.1;
    return group===0?0.2:0.05;
  });
  const logistic=rows.map((row,index)=>{
    const within=index%15;
    return within===1?0.99:within===0?0.5:0.1;
  });
  const selected=topKThresholdSignals(rows,scores,1,0.5);
  assert.equal(selected.signal_count,1);
  assert.equal(selected.decision_group_count,2);
  assert.equal(selected.abstained_decision_group_count,1);
  assert.equal(selected.abstention_active,true);
  const matched=topKMatchedCountSignals(rows,logistic,selected);
  assert.equal(matched.signal_count,selected.signal_count);
  assert.equal(matched.matches_target_counts_by_bucket,true);
  const report=evaluateExternalExecutionRiskTopK(rows,scores,logistic,{
    riskPenaltyWeights:rows.map(()=>0.5),topKGrid:[1],
    roundTripCostBps:30,minimumRiskAdjustedScore:0.5,abstentionPercentile:0.4
  });
  assert.equal(report.status,'AVAILABLE');
  assert.equal(report.frozen_abstention_policy.enabled,true);
  assert.equal(report.frozen_abstention_policy.threshold_refitted_on_outer_validation,false);
  assert.equal(report.trials[0].neural_selected_count,1);
  assert.equal(report.trials[0].logistic_selected_count,1);
  assert.equal(report.trials[0].abstention_active,true);
  assert.equal(report.trials[0].logistic_matched_candidate_signal_counts,true);
  assert.equal(report.trials[0].logistic_matched_candidate_trade_counts,true);
  assert.equal(report.trials[0].neural_metrics.trade_count,
    report.trials[0].logistic_metrics.trade_count);
});

test('outer-validation moving-block bootstrap returns paired Brier and execution confidence intervals without holdout access',()=>{
  const rows=makeRows({days:60,rowsPerDay:80});
  const sourceCommitSha='9'.repeat(40);
  const artifacts=makeArtifacts(sourceCommitSha);
  const predictions=makePredictions(rows,sourceCommitSha,artifacts);
  const validation=splitFourHourRows(rows).validation
    .sort((a,b)=>a.at-b.at||a.symbol.localeCompare(b.symbol));
  const ids=validation.map(row=>row.id);
  const probabilityByModel={};
  for(const name of ['LOGISTIC_REGRESSION','TCN_LSTM_HYBRID']){
    const byId=new Map(predictions[name].map(item=>[item.id,item.probability]));
    probabilityByModel[name]=ids.map(id=>byId.get(id));
  }
  const contextScores=validation.map((row,index)=>
    Number((0.2+(index%11)/100).toFixed(5)));
  const pooledScores=validation.map((row,index)=>
    Number((0.2+((index*7)%11)/100).toFixed(5)));
  const logisticScores=probabilityByModel.LOGISTIC_REGRESSION;
  const result=bootstrapOuterValidationUncertainty(validation,probabilityByModel,{
    executionScoresByPolicy:{
      LOGIT_CONTEXT_AUGMENTED:contextScores,
      POOLED_ONLY:pooledScores,
      LOGISTIC_MATCHED_CONTEXT:logisticScores,
      LOGISTIC_MATCHED_POOLED:logisticScores,
      LOGISTIC_REGRESSION:logisticScores
    },
    executionPolicyConfigurations:{
      LOGIT_CONTEXT_AUGMENTED:{minimum_score:0.29},
      POOLED_ONLY:{minimum_score:0.29},
      LOGISTIC_MATCHED_CONTEXT:{match_trade_counts_with:'LOGIT_CONTEXT_AUGMENTED'},
      LOGISTIC_MATCHED_POOLED:{match_trade_counts_with:'POOLED_ONLY'}
    },
    topKGrid:[1],roundTripCostBps:30,
    repetitions:100,blockLengthDays:2,seed:22429,maxConcurrentPositions:30
  });
  assert.equal(result.schema,'RADARX_OUTER_VALIDATION_MOVING_BLOCK_BOOTSTRAP_V1');
  assert.equal(result.status,'AVAILABLE',JSON.stringify(result));
  assert.equal(result.evaluation_partition,'OUTER_VALIDATION_ONLY');
  assert.equal(result.sampling.repetitions,100);
  assert.equal(result.sampling.block_length_days,2);
  assert.equal(result.sampling.seed,22429);
  assert.equal(result.sampling.four_hour_event_overlap_between_resampled_blocks,false);
  assert.equal(result.isolation.parameters_refitted,false);
  assert.equal(result.isolation.thresholds_selected,false);
  assert.equal(result.isolation.top_k_selected,false);
  assert.equal(result.isolation.lambda_refitted,false);
  assert.equal(result.isolation.holdout_rows_or_scores_used,false);
  assert.equal(result.isolation.affects_acceptance_gates,false);
  const brier=result.probability_quality.comparisons.TCN_LSTM_HYBRID
    .candidate_minus_logistic_raw_brier;
  assert.equal(brier.status,'AVAILABLE');
  assert.equal(brier.valid_repetitions,100);
  assert.ok(Number.isFinite(brier.lower_95)&&Number.isFinite(brier.upper_95));
  const context=result.execution.paired_strategy_differences['1']
    .LOGIT_CONTEXT_AUGMENTED_MINUS_POOLED_ONLY.net_pnl_pct;
  assert.equal(context.status,'AVAILABLE');
  assert.equal(context.valid_repetitions,100);
  assert.ok(Number.isFinite(context.lower_95)&&Number.isFinite(context.upper_95));
  const contextVsMatchedLogistic=result.execution.paired_strategy_differences['1']
    .LOGIT_CONTEXT_AUGMENTED_MINUS_LOGISTIC_MATCHED_CONTEXT.net_pnl_pct;
  assert.equal(contextVsMatchedLogistic.status,'AVAILABLE');
  assert.equal(contextVsMatchedLogistic.valid_repetitions,100);
  assert.equal(result.execution.matched_comparator_trade_counts_by_decision_bucket,true);
  assert.equal(result.execution.selective_policies_use_inner_selection_thresholds_only,true);
  const drawdown=result.execution.strategy_confidence_intervals['1']
    .LOGIT_CONTEXT_AUGMENTED.max_drawdown_pct;
  assert.equal(drawdown.status,'AVAILABLE');
  assert.ok(drawdown.lower_95<=drawdown.upper_95);
});

test('outer bootstrap reuses frozen selective thresholds and matched per-bucket Logistic counts',()=>{
  const rows=makeRows({days:60,rowsPerDay:80});
  const contextScores=rows.map((row,index)=>Number((0.2+(index%11)/100).toFixed(5)));
  const logisticScores=rows.map((row,index)=>Number((0.25+((index*7)%13)/100).toFixed(5)));
  const predictionsByModel={
    LOGISTIC_REGRESSION:rows.map(row=>row.target?0.7:0.3),
    TCN_LSTM_HYBRID:rows.map(row=>row.target?0.72:0.28)
  };
  const result=bootstrapOuterValidationUncertainty(rows,predictionsByModel,{
    executionScoresByPolicy:{
      LOGIT_CONTEXT_AUGMENTED:contextScores,
      LOGISTIC_MATCHED_CONTEXT:logisticScores
    },
    executionPolicyConfigurations:{
      LOGIT_CONTEXT_AUGMENTED:{minimum_score:0.28},
      LOGISTIC_MATCHED_CONTEXT:{match_trade_counts_with:'LOGIT_CONTEXT_AUGMENTED'}
    },
    topKGrid:[1],roundTripCostBps:30,
    repetitions:100,blockLengthDays:2,seed:22430,maxConcurrentPositions:30
  });
  assert.equal(result.status,'AVAILABLE',JSON.stringify(result));
  assert.deepEqual(result.execution.policy_configurations,{
    LOGIT_CONTEXT_AUGMENTED:{minimum_score:0.28},
    LOGISTIC_MATCHED_CONTEXT:{match_trade_counts_with:'LOGIT_CONTEXT_AUGMENTED'}
  });
  assert.equal(result.execution.selective_policies_use_inner_selection_thresholds_only,true);
  assert.equal(result.execution.matched_comparator_trade_counts_by_decision_bucket,true);
  assert.equal(result.isolation.thresholds_selected,false);
  assert.equal(result.isolation.top_k_selected,false);
  assert.equal(result.isolation.holdout_rows_or_scores_used,false);
});

test('outer-validation bootstrap fails closed when there are too few UTC-day blocks',()=>{
  const rows=makeRows({days:10,rowsPerDay:10});
  const result=bootstrapOuterValidationUncertainty(rows,{
    LOGISTIC_REGRESSION:rows.map(row=>row.target?0.7:0.3)
  },{
    executionScoresByPolicy:{LOGISTIC_REGRESSION:rows.map(row=>row.target?0.7:0.3)},
    repetitions:100,blockLengthDays:3,seed:22429
  });
  assert.equal(result.status,'UNAVAILABLE');
  assert.equal(result.reason,'BOOTSTRAP_TOO_FEW_INDEPENDENT_TIME_BLOCKS');
  assert.equal(result.holdout_rows_or_scores_used,false);
});

test('zero score floor rejects zero and negative predicted net-return scores',()=>{
  const rows=makeRows({days:1,rowsPerDay:30});
  const scores=rows.map((row,index)=>index<15
    ?(index===14?0.05:0):(index%15===0?-0.01:0));
  const selection=topKThresholdSignals(rows,scores,1,0);
  assert.equal(selection.signal_count,1);
  assert.equal(selection.abstained_decision_group_count,1);
  assert.equal(selection.abstention_active,true);
  assert.equal(selection.probabilities[14],1);
  assert.ok(selection.probabilities.every((selected,index)=>
    selected===0||scores[index]>0
  ));
});

test('external selective execution abstains below its frozen inner-selection score floor',()=>{
  const rows=makeRows({days:1,rowsPerDay:30});
  const contextScores=rows.map((row,index)=>
    Number((index<15?0.20+(index%15)/100:0.18+(index%15)/100).toFixed(4)));
  const logisticProbabilities=rows.map((row,index)=>
    Number((0.3+((index*7)%15)/100).toFixed(4)));
  const lambdas=rows.map(()=>0.5);
  const report=evaluateExternalExecutionRiskTopK(rows,contextScores,logisticProbabilities,{
    riskPenaltyWeights:lambdas,topKGrid:[1],roundTripCostBps:30,
    minimumRiskAdjustedScore:0.33,abstentionPercentile:0.5
  });
  assert.equal(report.status,'AVAILABLE');
  assert.equal(report.evaluation_partition,'OUTER_VALIDATION_ONLY');
  assert.equal(report.frozen_abstention_policy.enabled,true);
  assert.equal(report.frozen_abstention_policy.minimum_risk_adjusted_score,0.33);
  assert.equal(report.frozen_abstention_policy.percentile_selected_on_inner_selection,0.5);
  assert.equal(report.frozen_abstention_policy.threshold_refitted_on_outer_validation,false);
  assert.equal(report.frozen_abstention_policy.baseline_trade_counts_matched,true);
  assert.equal(report.trials[0].abstention_active,true);
  assert.equal(report.trials[0].abstained_decision_group_count,1);
  assert.equal(report.trials[0].neural_selected_count,1);
  assert.equal(report.trials[0].logistic_selected_count,1);
  assert.equal(report.trials[0].logistic_matched_candidate_trade_counts,true);
});

test('external execution Top-K compares identical opportunities and rejects unfrozen risk penalties',()=>{
  const rows=makeRows({days:1,rowsPerDay:30});
  const contextScores=rows.map((row,index)=>Number((0.2+(index%15)/100).toFixed(4)));
  const logisticProbabilities=rows.map((row,index)=>Number((0.3+((index*7)%15)/100).toFixed(4)));
  const lambdas=rows.map(()=>0.5);
  const report=evaluateExternalExecutionRiskTopK(rows,contextScores,logisticProbabilities,{
    riskPenaltyWeights:lambdas,topKGrid:[1,2,3],roundTripCostBps:30
  });
  assert.equal(report.status,'AVAILABLE');
  assert.equal(report.evaluation_partition,'OUTER_VALIDATION_ONLY');
  assert.equal(report.opportunity_rows,30);
  assert.equal(report.risk_penalty_weight,0.5);
  assert.deepEqual(report.top_k_grid,[1,2,3]);
  assert.equal(report.lambda_refitted_on_outer_validation,false);
  assert.equal(report.holdout_rows_or_scores_used,false);
  assert.equal(report.thresholds_or_lambda_tuned_on_outer_validation,false);
  assert.equal(report.trials.length,3);
  assert.ok(report.trials.every(row=>
    row.neural_selected_count===row.logistic_selected_count&&
    row.neural_metrics.return_data_status==='COMPLETE'&&
    row.logistic_metrics.return_data_status==='COMPLETE'
  ));
  assert.throws(()=>evaluateExternalExecutionRiskTopK(rows,contextScores,logisticProbabilities,{
    riskPenaltyWeights:lambdas.map((value,index)=>index===0?value+0.1:value),
    topKGrid:[1,2,3],roundTripCostBps:30
  }),/EXTERNAL_EXECUTION_RISK_LAMBDA_NOT_FROZEN/);
});
