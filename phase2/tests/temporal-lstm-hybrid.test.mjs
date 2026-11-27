import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TCN_LSTM_HYBRID_SCHEMA,
  TCN_LSTM_PARAMETER_COUNT,
  TCN_LSTM_STEPS,
  TCN_LSTM_INPUT_CHANNELS,
  TCN_LSTM_RECEPTIVE_FIELD,
  TCN_LSTM_HIDDEN,
  TCN_LSTM_RANKING_FEATURE_COUNT,
  TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT,
  fitTcnLstmOrderedRankerForTrainingPartition,
  isTcnLstmDualMetricCheckpointBetter,
  buildTcnLstmAnchorFeatures,
  fitTcnLstmLogisticAnchor,
  inspectTcnLstmForward,
  lossAndGradientsTcnLstmHybrid,
  projectTcnLstmAuxiliaryGradient,
  auditTcnLstmHybridGradients,
  trainTcnLstmHybrid,
  predictTcnLstmHybridProbability,
  predictTcnLstmHybridRankingScore,
  predictTcnLstmHybridRankingLogit,
  predictTcnLstmHybridRankingAnchorLogit,
  predictTcnLstmHybridExecutionHeads,
  predictTcnLstmHybridExecutionScore,
  buildTcnLstmExecutionHeadInputFeatures,
  TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA,
  summarizeTcnLstmExecutionHeadContextAblation,
  predictTcnLstmLogisticLogit,
  predictTcnLstmHybridCalibratedProbability,
  fitTcnLstmHybridCalibration,
  splitFourHourTcnLstmTrainingRows,
  splitTcnLstmHurdleProbabilityCalibrationRows,
  splitTcnLstmTrainingRowsForExecutionHead,
  selectTcnLstmExecutionRiskPolicy,
  selectTcnLstmHybridHyperparameters,
  summarizeTcnLstmSelectionReturns,
  tcnLstmPairwiseReturnRankingLoss,
  tcnLstmPairwiseLogitRankingLoss,
  buildTcnLstmReturnRankingPairs,
  summarizeTcnLstmPairwiseReturnRanking,
  summarizeTcnLstmPairwiseLogitRanking,
  summarizeTcnLstmRankingExecutionSelection,
  hasFoldStableOrderedRankerQualification,
  benchmarkTcnLstmHybridChronological,
  evaluateTcnLstmHybridGeneralization,
  benchmarkTcnLstmHybridInference,
  createTcnLstmHybridModelForAudit,
  effectiveTcnLstmTrainingSampleBudget,
  selectChronologicalTcnLstmTrainingRows,
  TCN_LSTM_MAX_TRAINING_SAMPLES
} from '../core/temporal-lstm-hybrid.mjs';
import { topKRankingSignals,compareTcnLstmRankingExecutionMetrics,
  evaluateExternalExecutionRiskTopK } from '../core/neural-closure-contracts.mjs';
import { fitHurdleReturnHead,fitHurdlePositiveReturnCalibration,predictHurdleExpectedNetReturn } from '../core/hurdle-return-head.mjs';
import {createOrderedTemporalRankerArtifact,verifyOrderedTemporalRankerArtifact} from '../core/ordered-temporal-ranker-artifact.mjs';

const DAY=86400000;
const BASE=1_780_000_000_000;

test('hurdle return head learns feature-conditional class means without class reweighting',()=>{
  const features=[],returns=[];
  for(let index=0;index<200;index++){
    const profitable=index%10<2;
    const x=(index%20)/10-1;
    features.push([x,profitable?1:-1]);
    returns.push(profitable?1.5+0.6*x:-0.8+0.25*x);
  }
  const head=fitHurdleReturnHead(features,returns,{
    learningRate:0.02,epochs:200,l2:0.05,minimumClassRows:10
  });
  assert.equal(head.schema,'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V2');
  assert.equal(head.fitted,true);
  assert.equal(head.positive_rows,40);
  assert.equal(head.non_positive_rows,160);
  assert.equal(head.class_reweighting_used,false);
  assert.equal(head.positive_probability_class_weight,1);
  assert.equal(head.negative_probability_class_weight,1);
  assert.equal(head.conditional_mean_type,'FEATURE_CONDITIONAL_HUBER_REGRESSION_V1');
  assert.equal(head.positive_conditional_mean_model.rows,40);
  assert.equal(head.non_positive_conditional_mean_model.rows,160);
  assert.equal(head.validation_or_holdout_used,false);
  const high=predictHurdleExpectedNetReturn([0.9,1],head);
  const low=predictHurdleExpectedNetReturn([-0.9,-1],head);
  assert.ok(high.probability_positive_net_return>low.probability_positive_net_return);
  assert.ok(high.positive_net_return_mean_pct>low.positive_net_return_mean_pct);
  assert.ok(high.non_positive_net_return_mean_pct>low.non_positive_net_return_mean_pct);
  assert.ok(high.expected_net_return_pct>low.expected_net_return_pct);
  assert.ok(high.expected_net_return_pct>0);
  assert.ok(low.expected_net_return_pct<0);
  const restored=JSON.parse(JSON.stringify(head));
  assert.deepEqual(predictHurdleExpectedNetReturn([0.9,1],restored),high);
});

test('Hurdle positive-net-return probability calibration is fitted on its separate calibration block and drives expected value',()=>{
  const returns=Array.from({length:200},(_,index)=>
    index%5===0?1.1+(index%7)*0.03:-0.65-(index%9)*0.02
  );
  const raw=Array(returns.length).fill(0.70);
  const calibration=fitHurdlePositiveReturnCalibration(raw,returns,{
    minimumSamples:30,minimumPositive:8,minimumNegative:8,
    iterations:800,learningRate:0.03,regularization:0.05
  });
  assert.equal(calibration.fitted,true);
  assert.equal(calibration.schema,'RADARX_HURDLE_POSITIVE_NET_RETURN_PLATT_CALIBRATOR_V1');
  assert.equal(calibration.fit_boundary,
    'PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK_ONLY');
  assert.equal(calibration.positive_rows,40);
  assert.equal(calibration.negative_rows,160);
  assert.ok(calibration.slope>=0.05&&calibration.slope<=8);
  assert.ok(Number.isFinite(calibration.intercept));
  const head=fitHurdleReturnHead(
    returns.map((value,index)=>[Math.sin(index*0.13),value>0?1:-1]),returns,
    {learningRate:0.02,epochs:120,l2:0.05,minimumClassRows:8}
  );
  const rawPrediction=predictHurdleExpectedNetReturn([0.4,1],head);
  head.probability_calibration=calibration;
  const calibratedPrediction=predictHurdleExpectedNetReturn([0.4,1],head);
  assert.equal(calibratedPrediction.probability_calibration_applied,true);
  assert.equal(calibratedPrediction.probability_calibration_schema,calibration.schema);
  assert.equal(calibratedPrediction.raw_probability_positive_net_return,
    rawPrediction.raw_probability_positive_net_return);
  assert.notEqual(calibratedPrediction.probability_positive_net_return,
    calibratedPrediction.raw_probability_positive_net_return);
  assert.ok(Math.abs(calibratedPrediction.expected_net_return_pct-
    (calibratedPrediction.probability_positive_net_return*
      calibratedPrediction.positive_net_return_mean_pct+
     (1-calibratedPrediction.probability_positive_net_return)*
      calibratedPrediction.non_positive_net_return_mean_pct))<1e-10);
  const restored=JSON.parse(JSON.stringify(head));
  assert.deepEqual(predictHurdleExpectedNetReturn([0.4,1],restored),calibratedPrediction);
});

test('Hurdle probability calibration split keeps an earlier training block, four-hour maturity purge, and later calibration block',()=>{
  const bucketMs=15*60*1000,horizonMs=4*60*60*1000;
  const rows=[],netReturns=[];
  for(let group=0;group<50;group++){
    const at=BASE+group*bucketMs;
    for(let symbolIndex=0;symbolIndex<4;symbolIndex++){
      const index=group*4+symbolIndex;
      rows.push({
        id:'hurdle-cal-'+index,symbol:'PAIR'+symbolIndex,
        at,resolved_at:at+((index%16)+1)*bucketMs
      });
      netReturns.push(index%5===0?1.0:-0.7);
    }
  }
  const split=splitTcnLstmHurdleProbabilityCalibrationRows(rows,netReturns,{
    horizonMs,bucketMs,calibrationGroupFraction:0.2,
    minimumTrainingGroups:20,minimumCalibrationGroups:8,minimumClassRows:8
  });
  assert.equal(split.status,'READY');
  assert.equal(split.diagnostics.training_groups,25);
  assert.equal(split.diagnostics.purged_groups,15);
  assert.equal(split.diagnostics.calibration_groups,10);
  assert.equal(split.diagnostics.training_rows,100);
  assert.equal(split.diagnostics.purged_rows,60);
  assert.equal(split.diagnostics.calibration_rows,40);
  assert.equal(split.diagnostics.chronology_valid,true);
  assert.equal(split.diagnostics.forward_label_horizon_valid,true);
  assert.equal(split.diagnostics.complete_decision_groups,true);
  assert.equal(split.diagnostics.disjoint_sample_identities,true);
  assert.ok(split.diagnostics.training_max_resolved_at<
    split.diagnostics.calibration_min_at);
  assert.ok(split.diagnostics.training_decision_time_gap_ms>=horizonMs);
  assert.equal(split.diagnostics.validation_or_holdout_used,false);
});

test('auxiliary raw ranking logits drive deterministic Top-K per 15m bucket',()=>{
  const bucketMs=15*60*1000;
  const bucket=Math.floor(BASE/bucketMs)*bucketMs;
  const rows=[
    {id:'a',symbol:'AAA',at:bucket},
    {id:'b',symbol:'BBB',at:bucket+1000},
    {id:'c',symbol:'CCC',at:bucket+2000},
    {id:'d',symbol:'DDD',at:bucket+bucketMs},
    {id:'e',symbol:'EEE',at:bucket+bucketMs+1000},
    {id:'f',symbol:'FFF',at:bucket+2*bucketMs}
  ];
  const result=topKRankingSignals(rows,[0.2,2.0,1.0,-1.0,3.0,9.0],1);
  assert.equal(result.decision_group_count,2);
  assert.equal(result.total_time_buckets,3);
  assert.equal(result.singleton_buckets_excluded,1);
  assert.equal(result.signal_count,2);
  assert.ok(result.probabilities[1]>0.5);
  assert.ok(result.probabilities[4]>0.5);
  assert.equal(result.probabilities[0],0);
  assert.equal(result.probabilities[2],0);
  assert.equal(result.probabilities[3],0);
  assert.equal(result.probabilities[5],0);
  assert.ok(result.probabilities[1]>result.probabilities[2]);
  assert.equal(result.score_source,'RAW_AUXILIARY_RANKING_LOGIT');
  assert.throws(()=>topKRankingSignals(rows,[0,1,Infinity,2,3,4],1),
    /NEURAL_TOP_K_RANKING_SCORE_INVALID/);
});

function makeSequence(direction=1,seed=0){
  return Array.from({length:TCN_LSTM_STEPS},(_,time)=>
    Array.from({length:TCN_LSTM_INPUT_CHANNELS},(_,feature)=>{
      const drift=direction*(feature===0?0.8:feature===7?0.35:0.08);
      const wave=Math.sin((time+1)*(feature+1)*0.09+seed)*0.12;
      return Math.max(-3.5,Math.min(3.5,drift+wave));
    })
  );
}
function makeRankedRows(startGroup=0,groupCount=10,prefix='ranked'){
  const returns=[4,2,-1,-3];
  return Array.from({length:groupCount*4},(_,index)=>{
    const group=Math.floor(index/4),rank=index%4;
    const at=BASE+(startGroup+group)*DAY+rank*75;
    return {
      id:prefix+'-'+(startGroup+group)+'-'+rank,
      symbol:'RANK'+rank+'USDT',
      at,resolved_at:at+4*60*60*1000,
      target:rank%2===0?1:0,
      realized_return_pct:returns[rank],
      sequence:makeSequence(rank<2?1:-1,(startGroup+group)*0.031+rank*0.17),
      temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
        at-(23-step)*900000)
    };
  });
}

function makeRows(start,count,prefix='sample'){
  return Array.from({length:count},(_,index)=>{
    const absolute=start+index;
    const target=absolute%2===0?1:0;
    const at=BASE+absolute*DAY;
    return {
      id:prefix+'-'+absolute,
      symbol:'TST'+String(absolute%4)+'USDT',
      at,resolved_at:at+DAY,target,
      realized_return_pct:target===1?2.8:-2.2,
      sequence:makeSequence(target?1:-1,absolute*0.017),
      temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
        at-(23-step)*900000)
    };
  });
}

function makeExecutionRow(index,outcome,at){
  const baseline=100,take=103,stop=98;
  const candleOpenTime=at+120_000;
  const candleCloseTime=candleOpenTime+59_999;
  const up=outcome==='UP';
  const exit=up?take:stop;
  const candle=up?{
    source:'BINANCE_PUBLIC_REST',is_closed:true,
    open_time:candleOpenTime,close_time:candleCloseTime,
    open:100.4,high:103.2,low:99.2,close:102.8
  }:{
    source:'BINANCE_PUBLIC_REST',is_closed:true,
    open_time:candleOpenTime,close_time:candleCloseTime,
    open:99.5,high:102.4,low:97.8,close:98.2
  };
  return {
    id:'rank-'+index,
    symbol:'RANK'+index+'USDT',
    at,resolved_at:at+4*60*60*1000,
    outcome,target:up?1:0,
    realized_return_pct:up?3:-2,
    execution_return_contract:'FIRST_TOUCH_PRICE_WITH_OPEN_GAP_AWARE_EXITS_V1',
    first_touch:{
      resolution:up?'TAKE_PROFIT_FIRST':'STOP_LOSS_FIRST',
      first_touch_at:candleCloseTime,
      baseline_price:baseline,take_profit_price:take,stop_loss_price:stop,
      exit_price:exit,exit_price_source:'BARRIER',exit_candle:candle
    },
    max_adverse_excursion_pct:up?-0.3:-2,
    max_adverse_excursion_at:up?at+60_000:candleCloseTime,
    max_favorable_excursion_pct:up?3:0.3,
    max_favorable_excursion_at:up?candleCloseTime:at+90_000
  };
}


test('external execution-risk Top-K uses one frozen lambda and identical validation opportunities',()=>{
  const bucket=Math.floor(BASE/(15*60*1000))*(15*60*1000);
  const rows=Array.from({length:8},(_,index)=>{
    const group=Math.floor(index/4),rank=index%4;
    const row=makeExecutionRow(index,index%2===0?'UP':'DOWN',
      bucket+group*15*60*1000+rank*1000);
    return {...row,symbol:'RISK'+index+'USDT'};
  });
  const result=evaluateExternalExecutionRiskTopK(rows,
    [-0.3,0.9,0.2,-0.1,0.8,-0.4,0.1,0.3],
    [0.95,0.2,0.3,0.4,0.1,0.9,0.8,0.7],
    {riskPenaltyWeights:Array(rows.length).fill(1.25),topKGrid:[1,2],roundTripCostBps:30});
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.evaluation_partition,'OUTER_VALIDATION_ONLY');
  assert.equal(result.risk_penalty_weight,1.25);
  assert.equal(result.lambda_refitted_on_outer_validation,false);
  assert.equal(result.holdout_rows_or_scores_used,false);
  assert.equal(result.trials.length,2);
  assert.equal(result.trials[0].neural_selected_count,2);
  assert.equal(result.trials[0].logistic_selected_count,2);
  assert.equal(result.trials[0].neural_metrics.return_data_status,'COMPLETE');
  assert.equal(result.trials[0].logistic_metrics.return_data_status,'COMPLETE');
  assert.throws(()=>evaluateExternalExecutionRiskTopK(rows,
    [-0.3,0.9,0.2,-0.1,0.8,-0.4,0.1,0.3],
    [0.95,0.2,0.3,0.4,0.1,0.9,0.8,0.7],
    {riskPenaltyWeights:[...Array(7).fill(1.25),1.5],topKGrid:[1]}),
    /EXTERNAL_EXECUTION_RISK_LAMBDA_NOT_FROZEN/);
});


test('fresh TCN-LSTM classifier residual is exactly neutral to the matched full-sequence Logistic reference',()=>{
  const model=createTcnLstmHybridModelForAudit(711);
  const sequence=makeSequence(1,12);
  const output=inspectTcnLstmForward(sequence,model,0.173);
  assert.equal(output.logit,0.173);
  assert.equal(output.probability,1/(1+Math.exp(-0.173)));
  const anchor=fitTcnLstmLogisticAnchor(makeRows(0,40,'neutral-anchor'));
  const externalLogisticModel={
    training_partition_only:true,
    standardizer:{means:Array(696).fill(0),scales:Array(696).fill(1)},
    fit:{weights:Array(696).fill(0),bias:0.173}
  };
  const profile={
    model,baseline_fit:anchor,
    execution_logistic_context_model:externalLogisticModel,
    execution_logistic_context_metadata:{
      logistic_feature_schema_id:'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1'
    }
  };
  assert.ok(Math.abs(predictTcnLstmHybridProbability(sequence,profile)-
    1/(1+Math.exp(-0.173)))<1e-12,
    'inference must add the temporal residual to the exact full-sequence Logistic baseline');
  assert.ok(Math.abs(predictTcnLstmHybridProbability(sequence,profile,{
    externalLogisticLogit:-0.27
  })-1/(1+Math.exp(0.27)))<1e-12,
  'an explicitly aligned raw full-sequence Logistic logit must override the pooled fallback');
});

test('TCN-LSTM attention forward pass is finite, normalized and exposes sequential memory states',()=>{
  const sequence=makeSequence(1,3);
  const model=createTcnLstmHybridModelForAudit(71);
  const output=inspectTcnLstmForward(sequence,model,0.17);
  assert.ok(output.probability>0&&output.probability<1);
  assert.equal(output.lstm_hidden_sequence.length,24);
  assert.equal(output.lstm_cell_sequence.length,24);
  assert.equal(output.tcn_latent_sequence.length,24);
  assert.equal(output.tcn_latent_sequence[0].length,8);
  assert.ok(Math.abs(output.attention_weights.reduce((sum,value)=>sum+value,0)-1)<1e-12);
  assert.ok(output.attention_weights.every(value=>Number.isFinite(value)&&value>=0));
  assert.equal(TCN_LSTM_PARAMETER_COUNT,1089);
});

test('unidirectional LSTM state for an earlier prefix is invariant to later input changes',()=>{
  const original=makeSequence(1,5);
  const changed=original.map(row=>[...row]);
  for(let time=12;time<24;time++)
    for(let feature=0;feature<29;feature++)
      changed[time][feature]=Math.max(-4,Math.min(4,changed[time][feature]*-1.3));
  const model=createTcnLstmHybridModelForAudit(29);
  const a=inspectTcnLstmForward(original,model,0.1);
  const b=inspectTcnLstmForward(changed,model,0.1);
  for(let time=0;time<12;time++)for(let unit=0;unit<8;unit++){
    assert.ok(Math.abs(a.lstm_hidden_sequence[time][unit]-b.lstm_hidden_sequence[time][unit])<1e-12);
    assert.ok(Math.abs(a.lstm_cell_sequence[time][unit]-b.lstm_cell_sequence[time][unit])<1e-12);
  }
});

test('TCN, LSTM BPTT and temporal-attention analytic gradients match central finite differences',()=>{
  const result=auditTcnLstmHybridGradients(makeSequence(-1,11),0,{
    model:createTcnLstmHybridModelForAudit(13),
    baselineLogit:0.23,
    epsilon:1e-5
  });
  assert.equal(result.parameter_count,TCN_LSTM_PARAMETER_COUNT);
  assert.equal(result.checked_parameters,TCN_LSTM_PARAMETER_COUNT);
  assert.equal(result.passed,true,
    'max absolute gradient error='+result.maximum_absolute_error+
    ', max relative error='+result.maximum_relative_error+
    ', worst parameter='+JSON.stringify(result.worst_parameter));
  assert.ok(result.maximum_absolute_error<2e-5);
});

test('focal-asymmetric TCN-LSTM objective matches finite-difference gradients',()=>{
  const audit=auditTcnLstmHybridGradients(makeSequence(1,37),1,{
    model:createTcnLstmHybridModelForAudit(43),
    baselineLogit:-0.11,
    epsilon:1e-5,
    objective:'FOCAL_ASYMMETRIC_BRIER',
    classWeights:{positiveWeight:2.4,negativeWeight:0.53},
    gammaPositive:1,
    gammaNegative:2
  });
  assert.equal(audit.passed,true,
    'focal TCN-LSTM max abs error='+audit.maximum_absolute_error+
    ', max relative error='+audit.maximum_relative_error+
    ', worst='+JSON.stringify(audit.worst_parameter));
  assert.ok(audit.maximum_absolute_error<2e-5);
});

test('focal-asymmetric TCN-LSTM fits class weights on the training rows only',()=>{
  const rows=makeRows(0,40,'focal-train');
  const profile=trainTcnLstmHybrid(rows,{
    epochs:1,learningRate:0.0015,l2:0.001,batchSize:8,
    seed:107,maxTrainingSamples:40,objective:'FOCAL_ASYMMETRIC_BRIER'
  });
  assert.equal(profile.loss_objective,'FOCAL_ASYMMETRIC_BRIER');
  assert.equal(profile.loss_class_weights.derived_from,'TRAINING_PARTITION_ONLY');
  assert.equal(profile.loss_class_weights.training_positive,20);
  assert.equal(profile.loss_class_weights.training_negative,20);
  assert.equal(profile.training.history[0].loss_objective,'FOCAL_ASYMMETRIC_BRIER');
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.real_order_execution,false);
});

test('pairwise ranking accuracy counts an exact score tie as half-correct',()=>{
  const rows=makeRankedRows(0,10,'tie-accuracy');
  const tiedLogits=Array(rows.length).fill(0);
  const tiedProbabilities=Array(rows.length).fill(0.5);
  const logitMetrics=summarizeTcnLstmPairwiseLogitRanking(rows,tiedLogits,{
    roundTripCostBps:30,minimumReturnGapPct:0.5,maxPairsPerTimestamp:4
  });
  const probabilityMetrics=summarizeTcnLstmPairwiseReturnRanking(rows,tiedProbabilities,{
    roundTripCostBps:30,minimumReturnGapPct:0.5,maxPairsPerTimestamp:4
  });
  assert.equal(logitMetrics.status,'AVAILABLE');
  assert.equal(probabilityMetrics.status,'AVAILABLE');
  assert.equal(logitMetrics.pairwise_accuracy_pct,50);
  assert.equal(probabilityMetrics.pairwise_accuracy_pct,50);
  assert.ok(Math.abs(logitMetrics.pairwise_log_loss-Math.log(2))<1e-7);
  assert.ok(Math.abs(probabilityMetrics.pairwise_log_loss-Math.log(2))<1e-7);
});

test('TCN-LSTM pairwise return ranking loss orders high-return candidates above low-return candidates',()=>{
  const correct=tcnLstmPairwiseReturnRankingLoss(0.82,0.18);
  const reversed=tcnLstmPairwiseReturnRankingLoss(0.18,0.82);
  assert.equal(correct.correct,true);
  assert.equal(reversed.correct,false);
  assert.ok(correct.loss<reversed.loss);
  assert.ok(correct.high_logit_gradient<0);
  assert.ok(correct.low_logit_gradient>0);
});


test('auxiliary rank head must pass inner-selection Top-K execution gates and beat the Logistic anchor',()=>{
  const groupCount=50;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    const outcome=group<30&&rank===0?'UP':'DOWN';
    const at=BASE+group*15*60*1000+rank*75;
    const execution=makeExecutionRow(index,outcome,at);
    return {...execution,sequence:makeSequence(outcome==='UP'?1:-1,index*0.01)};
  });
  const head=rows.map((_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    if(rank===1)return -100-group;
    return group<30?100-group:20-(group-30)*0.1;
  });
  const anchor=rows.map((_,index)=>index%2===1?10:0);
  const passed=summarizeTcnLstmRankingExecutionSelection(rows,head,anchor,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,maximumDrawdownPct:8
  });
  assert.equal(passed.status,'EVALUATED');
  assert.equal(passed.source_partition,'INNER_SELECTION_ONLY');
  assert.equal(passed.passed,true);
  assert.ok(passed.top_k_trials.some(item=>item.passed));
  const rejected=summarizeTcnLstmRankingExecutionSelection(rows,head,head,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,maximumDrawdownPct:8
  });
  assert.equal(rejected.passed,false);
  assert.ok(rejected.top_k_trials.every(item=>
    item.gates.beats_logistic_anchor===false));
  assert.equal(rejected.holdout_values_used,false);
});

test('TCN-LSTM pairwise logit loss preserves ranking margins beyond probability clipping',()=>{
  const pair=tcnLstmPairwiseLogitRankingLoss(22,21.5);
  assert.ok(Math.abs(pair.margin-0.5)<1e-12);
  assert.ok(Math.abs(pair.loss-Math.log1p(Math.exp(-0.5)))<1e-12);
  assert.equal(pair.correct,true);
  assert.ok(pair.high_logit_gradient<0);
  assert.ok(pair.low_logit_gradient>0);
  const reversed=tcnLstmPairwiseLogitRankingLoss(21.5,22);
  assert.equal(reversed.correct,false);
  assert.ok(reversed.loss>pair.loss);
});

test('training return-ranking pairs use net realized returns and group near-simultaneous 15m decisions',()=>{
  const rows=makeRankedRows(0,10,'rank-pairs').map((row,index)=>({
    ...row,at:row.at+(index%4)*0.25
  }));
  const fitRows=rows.map(({realized_return_pct,...row})=>row);
  const built=buildTcnLstmReturnRankingPairs(fitRows,rows,{
    roundTripCostBps:30,minimumReturnGapPct:0.5,maxPairsPerTimestamp:4
  });
  assert.equal(built.source_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(built.decision_group_count,10);
  assert.equal(built.comparison_pairs,10);
  assert.ok(built.pairs.every(pair=>pair.return_gap_pct>=0.5));
  assert.ok(built.pairs.every(pair=>pair.high_index!==pair.low_index));
  const mismatched=rows.map((row,index)=>index===0?{...row,symbol:'WRONGUSDT'}:row);
  assert.throws(()=>buildTcnLstmReturnRankingPairs(fitRows,mismatched),/ROW_IDENTITY_MISMATCH/);
});

test('profitability-boundary rank pairs compare only positive net opportunities against non-positive outcomes',()=>{
  const returnsByGroup=[
    [4,2,-1,-3],
    [-0.5,-1,-2,-3],
    [1,1.2,2,3],
    [3,2,-2,-4],
    [-0.2,0.1,-0.1,0.8]
  ];
  const rows=returnsByGroup.flatMap((groupReturns,group)=>groupReturns.map(
    (realized_return_pct,rank)=>{
      const at=BASE+group*DAY+rank*75;
      return {
        id:'profit-boundary-'+group+'-'+rank,
        symbol:'BOUNDARY'+rank+'USDT',
        at,resolved_at:at+4*60*60*1000,
        target:rank%2===0?1:0,
        realized_return_pct,
        sequence:makeSequence(rank<2?1:-1,group*0.031+rank*0.17),
        temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
          at-(23-step)*900000)
      };
    }
  ));
  const fitRows=rows.map(({realized_return_pct,...row})=>row);
  const options={
    roundTripCostBps:30,minimumReturnGapPct:0.5,
    maxPairsPerTimestamp:16,pairStrategy:'PROFITABILITY_BOUNDARY_V1'
  };
  const built=buildTcnLstmReturnRankingPairs(fitRows,rows,options);
  assert.equal(built.pair_strategy,'PROFITABILITY_BOUNDARY_V1');
  assert.equal(built.schema,'RADARX_TCN_LSTM_PROFITABILITY_BOUNDARY_RANK_PAIRS_V1');
  assert.equal(built.decision_group_count,5);
  assert.equal(built.mixed_decision_groups,3);
  assert.equal(built.all_non_positive_groups,1);
  assert.equal(built.all_positive_groups,1);
  assert.equal(built.comparison_pairs,11);
  assert.ok(built.pairs.every(pair=>{
    const high=rows[pair.high_index].realized_return_pct-0.30;
    const low=rows[pair.low_index].realized_return_pct-0.30;
    return pair.pair_type==='POSITIVE_VS_NON_POSITIVE'&&high>0&&low<=0&&
      high-low>=0.5;
  }));

  const logits=rows.map(row=>row.realized_return_pct>0.30?2:-2);
  const metrics=summarizeTcnLstmPairwiseLogitRanking(rows,logits,{
    ...options
  });
  assert.equal(metrics.status,'AVAILABLE');
  assert.equal(metrics.pair_strategy,'PROFITABILITY_BOUNDARY_V1');
  assert.equal(metrics.positive_vs_non_positive_pairs,11);
  assert.equal(metrics.pairwise_accuracy_pct,100);
  assert.equal(metrics.holdout_values_used,false);
});

test('profitability Top-K rank pairs also order profitable candidates against each other',()=>{
  const returnsByGroup=[
    [4,2,-1,-3],
    [-0.5,-1,-2,-3],
    [1,1.2,2,3],
    [3,2,-2,-4],
    [-0.2,0.1,-0.1,0.8]
  ];
  const rows=returnsByGroup.flatMap((groupReturns,group)=>groupReturns.map(
    (realized_return_pct,rank)=>{
      const at=BASE+group*DAY+rank*75;
      return {
        id:'topk-pair-'+group+'-'+rank,
        symbol:'TOPK'+rank+'USDT',
        at,resolved_at:at+4*60*60*1000,
        target:rank%2===0?1:0,
        realized_return_pct,
        sequence:makeSequence(rank<2?1:-1,group*0.041+rank*0.13),
        temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
          at-(23-step)*900000)
      };
    }
  ));
  const fitRows=rows.map(({realized_return_pct,...row})=>row);
  const options={
    roundTripCostBps:30,minimumReturnGapPct:0.05,
    maxPairsPerTimestamp:16,pairStrategy:'PROFITABILITY_TOPK_V2'
  };
  const built=buildTcnLstmReturnRankingPairs(fitRows,rows,options);
  assert.equal(built.pair_strategy,'PROFITABILITY_TOPK_V2');
  assert.equal(built.schema,'RADARX_TCN_LSTM_PROFITABILITY_TOPK_RANK_PAIRS_V2');
  assert.equal(built.decision_group_count,5);
  assert.equal(built.positive_vs_non_positive_pairs,11);
  assert.equal(built.positive_vs_positive_pairs,8);
  assert.equal(built.comparison_pairs,19);
  assert.ok(built.pairs.some(pair=>pair.pair_type==='POSITIVE_VS_POSITIVE'&&
    pair.return_gap_pct<0.5));
  assert.ok(built.pairs.every(pair=>{
    const high=rows[pair.high_index].realized_return_pct-0.30;
    const low=rows[pair.low_index].realized_return_pct-0.30;
    return high>low&&high-low>=options.minimumReturnGapPct&&
      (pair.pair_type==='POSITIVE_VS_NON_POSITIVE'
        ?high>0&&low<=0
        :pair.pair_type==='POSITIVE_VS_POSITIVE'&&high>0&&low>0);
  }));
  const logits=rows.map(row=>2*(row.realized_return_pct-0.30));
  const metrics=summarizeTcnLstmPairwiseLogitRanking(rows,logits,options);
  assert.equal(metrics.status,'AVAILABLE');
  assert.equal(metrics.pair_strategy,'PROFITABILITY_TOPK_V2');
  assert.equal(metrics.positive_vs_non_positive_pairs,11);
  assert.equal(metrics.positive_vs_positive_pairs,8);
  assert.equal(metrics.comparison_pairs,19);
  assert.equal(metrics.pairwise_accuracy_pct,100);
  assert.equal(metrics.holdout_values_used,false);
});

test('profitability Top-K rank pairs use the full 32-pair budget with balanced strata',()=>{
  const rows=Array.from({length:30},(_,rank)=>{
    const at=BASE+rank*75;
    const realized_return_pct=rank<15?2-rank*0.02:-1-(rank-15)*0.02;
    return {
      id:'topk-budget-32-'+rank,
      symbol:'BUDGET'+rank+'USDT',
      at,resolved_at:at+4*60*60*1000,
      target:rank<15?1:0,
      realized_return_pct,
      sequence:makeSequence(rank<15?1:-1,rank*0.013),
      temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
        at-(23-step)*900000)
    };
  });
  const fitRows=rows.map(({realized_return_pct,...row})=>row);
  const options={
    roundTripCostBps:30,minimumReturnGapPct:0.05,
    maxPairsPerTimestamp:32,pairStrategy:'PROFITABILITY_TOPK_V2'
  };
  const built=buildTcnLstmReturnRankingPairs(fitRows,rows,options);
  assert.equal(built.decision_group_count,1);
  assert.equal(built.comparison_pairs,32);
  assert.equal(built.positive_vs_non_positive_pairs,16);
  assert.equal(built.positive_vs_positive_pairs,16);
  assert.ok(built.pairs.every(pair=>{
    const high=rows[pair.high_index].realized_return_pct-0.30;
    const low=rows[pair.low_index].realized_return_pct-0.30;
    return high>low&&high-low>=0.05&&
      (pair.pair_type==='POSITIVE_VS_NON_POSITIVE'
        ?high>0&&low<=0
        :pair.pair_type==='POSITIVE_VS_POSITIVE'&&high>0&&low>0);
  }));
});

test('ordered ranker threads Top-K pair policy through every purged inner fold',()=>{
  const rows=makeRankedRows(0,100,'topk-ranker-fit');
  const fitted=fitTcnLstmOrderedRankerForTrainingPartition(rows,{
    roundTripCostBps:30,minimumReturnGapPct:0.5,maxPairsPerTimestamp:16,
    pairStrategy:'PROFITABILITY_TOPK_V2',
    learningRate:0.03,epochs:4,l2:0.001,patience:2,
    l2Grid:[0.001,0.01],temporalBlockCounts:[1],validationFraction:0.08
  });
  assert.equal(fitted.pair_support.pair_strategy,'PROFITABILITY_TOPK_V2');
  assert.equal(fitted.training.pair_strategy,'PROFITABILITY_TOPK_V2');
  assert.equal(fitted.pair_support.positive_vs_non_positive_pairs,400);
  assert.equal(fitted.pair_support.positive_vs_positive_pairs,100);
  assert.equal(fitted.training.internal_training_validation.pair_strategy,
    'PROFITABILITY_TOPK_V2');
  assert.equal(fitted.training.internal_training_validation.fold_count,3);
  assert.equal(fitted.training.initialization_method,
    'PROJECTED_FOLD_LOCAL_LOGISTIC_WEIGHT_WARM_START_V1');
  assert.equal(fitted.training.initialization_source_rows,fitted.training.training_rows);
  assert.equal(fitted.training.internal_training_validation.logistic_baseline_config
    .ranker_initialization_method,
    'FOLD_LOCAL_LOGISTIC_WEIGHT_WARM_START_THEN_RETURN_PAIRWISE_FINE_TUNING_V1');
  assert.equal(fitted.training.validation_or_holdout_used,false);
});

test('pairwise return-ranking evaluation reports only selection-supplied ranking evidence',()=>{
  const rows=makeRankedRows(0,10,'rank-eval');
  const probabilities=rows.map(row=>[0.84,0.72,0.28,0.16][Number(row.id.split('-').at(-1))]);
  const score=summarizeTcnLstmPairwiseReturnRanking(rows,probabilities,{
    roundTripCostBps:30,minimumReturnGapPct:0.5
  });
  assert.equal(score.status,'AVAILABLE');
  assert.equal(score.comparison_pairs,10);
  assert.equal(score.pairwise_accuracy_pct,100);
  assert.equal(score.holdout_values_used,false);
  assert.equal(score.diagnostic_only,true);
});

test('PCGrad projects conflicting auxiliary rank gradients away from the primary Brier gradient',()=>{
  const primary={output:[1,0],encoder:{gate:[0,2]}};
  const auxiliary={output:[-1,3],encoder:{gate:[0,0]}};
  const projected=projectTcnLstmAuxiliaryGradient(primary,auxiliary);
  assert.equal(projected.conflict,true);
  assert.equal(projected.projection_applied,true);
  assert.ok(projected.dot_before<0);
  assert.ok(Math.abs(projected.dot_after)<1e-10);
  assert.deepEqual(projected.gradient,{
    output:[-1+1/5,3],
    encoder:{gate:[0,2/5]}
  });
  assert.equal(projectTcnLstmAuxiliaryGradient(primary,{
    output:[1,3],encoder:{gate:[0,0]}
  }).projection_applied,false);
  assert.equal(projectTcnLstmAuxiliaryGradient({output:[0,0]},{
    output:[-1,1]
  }).projection_applied,false);
});

test('external-logit backprop passes finite differences without high-logit probability clipping',()=>{
  const audit=auditTcnLstmHybridGradients(makeSequence(1,71),1,{
    model:createTcnLstmHybridModelForAudit(73),
    baselineLogit:22,epsilon:1e-5,
    objective:'EXTERNAL_LOGIT',externalLogitGradient:-0.37
  });
  assert.equal(audit.passed,true,
    'external-logit max absolute error='+audit.maximum_absolute_error+
    ' worst='+JSON.stringify(audit.worst_parameter));
  assert.ok(audit.maximum_absolute_error<2e-5);
});

test('pairwise logit ranking summary preserves high-confidence cross-sectional ordering',()=>{
  const rows=makeRankedRows(0,10,'rank-logit-eval');
  const logits=rows.map(row=>[22,21, -21,-22][Number(row.id.split('-').at(-1))]);
  const score=summarizeTcnLstmPairwiseLogitRanking(rows,logits,{
    roundTripCostBps:30,minimumReturnGapPct:0.5
  });
  assert.equal(score.status,'AVAILABLE');
  assert.equal(score.pairwise_accuracy_pct,100);
  assert.equal(score.score_domain,'RAW_MODEL_LOGITS_NO_PROBABILITY_CLIPPING');
  assert.equal(score.holdout_values_used,false);
});

test('separate auxiliary rank head changes ranking logits without changing classifier probabilities',()=>{
  const sequence=makeSequence(1,991);
  const model=createTcnLstmHybridModelForAudit(993);
  const baselineLogit=0.17;
  const before=inspectTcnLstmForward(sequence,model,baselineLogit);
  model.rankingHeadWeights=Array(TCN_LSTM_RANKING_FEATURE_COUNT).fill(1.5);
  const after=inspectTcnLstmForward(sequence,model,baselineLogit);
  assert.equal(after.probability,before.probability);
  assert.equal(after.logit,before.logit);
  assert.notEqual(after.ranking_score,before.ranking_score);
  assert.equal(after.ranking_score,after.ranking_logit);
  assert.equal(Object.hasOwn(after,'ranking_residual_logit'),false,
    'the independent rank head must not be exposed as a classifier residual');
});


test('rank-head execution diagnostics quantify lift against the same frozen Logistic anchor',()=>{
  const comparison=compareTcnLstmRankingExecutionMetrics(
    {trade_count:66,win_rate_pct:57.5,net_pnl_pct:1.25,
      max_drawdown_pct:2.0,average_net_return_pct:0.12,sharpe_per_trade:0.4},
    {trade_count:66,win_rate_pct:52.0,net_pnl_pct:0.35,
      max_drawdown_pct:2.5,average_net_return_pct:0.04,sharpe_per_trade:0.1}
  );
  assert.equal(comparison.comparison_baseline,'SAME_FROZEN_TCN_LSTM_LOGISTIC_ANCHOR');
  assert.deepEqual(comparison.head_minus_anchor,{
    trade_count:0,win_rate_percentage_points:5.5,
    net_pnl_percentage_points:0.9,max_drawdown_percentage_points:-0.5,
    average_net_return_percentage_points:0.08,sharpe_per_trade:0.3
  });
});

test('TCN-LSTM fits return and downside heads on later purged rows unseen by the encoder',()=>{
  const addDownside=(rows)=>rows.map((row,index)=>({
    ...row,
    max_adverse_excursion_pct:index%4===0?-0.35:index%4===1?-0.75:
      index%4===2?-1.4:-2.1,
    max_adverse_excursion_at:row.at+60*60*1000,
    external_logistic_logit:row.target===1?1.25:-0.65
  }));
  const modelTrainingEvidence=addDownside(
    makeRankedRows(0,10,'execution-model-train')
  );
  const evidence=addDownside(
    makeRankedRows(20,10,'execution-head-train')
  );
  const fitRows=modelTrainingEvidence.map(({realized_return_pct,...row})=>row);
  const profile=trainTcnLstmHybrid(fitRows,{
    epochs:1,learningRate:0.0015,l2:0.0005,batchSize:8,
    seed:771,maxTrainingSamples:40,rankingRows:modelTrainingEvidence,executionRows:evidence,
    rankingHeadEpochs:12,executionHeadEpochs:20,
    executionHeadRoundTripCostBps:30
  });
  assert.equal(profile.training.execution_regression_heads.fitted,true);
  assert.equal(profile.training.execution_regression_heads.fit_boundary,'TRAINING_PARTITION_ONLY');
  assert.equal(profile.training.execution_regression_heads.validation_or_holdout_used,false);
  assert.equal(profile.training.execution_regression_heads.representation_out_of_sample,true);
  assert.equal(profile.training.execution_regression_heads.training_and_execution_head_identities_disjoint,true);
  assert.equal(profile.training.execution_regression_heads.source_partition,
    'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK');
  assert.equal(profile.training.execution_regression_heads.model_training_rows,40);
  assert.ok(profile.training.execution_regression_heads.model_training_max_resolved_at<
    profile.training.execution_regression_heads.execution_head_min_at);
  assert.equal(profile.training.execution_regression_heads.round_trip_cost_bps,30);
  assert.equal(profile.training.execution_regression_heads.schema,
    'RADARX_TCN_LSTM_SCORE_GATED_RETURN_DOWNSIDE_HEADS_V6_TRAIN_ONLY_ZSCORE');
  assert.equal(profile.training.execution_regression_heads.hurdle_return_head.fit_partition,
    'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY');
  assert.equal(profile.training.execution_regression_heads.hurdle_return_head.probability_calibration_split.status,
    'UNAVAILABLE');
  assert.equal(profile.training.execution_regression_heads.hurdle_return_head.validation_or_holdout_used,
    false);
  assert.equal(profile.training.execution_regression_heads.hurdle_return_head.logit_context_augmented.fitted,
    true);
  assert.equal(profile.model.executionHurdleReturnHeads.LOGIT_CONTEXT_AUGMENTED.fitted,true);
  assert.equal(profile.model.executionHurdleReturnHeads.POOLED_ONLY.fitted,true);
  assert.equal(profile.training.execution_regression_heads.logit_context_augmented.feature_count,
    5*TCN_LSTM_HIDDEN+4);
  assert.equal(profile.training.execution_regression_heads.pooled_only_reference.feature_count,
    TCN_LSTM_HIDDEN);
  assert.equal(profile.model.executionReturnHeadWeights.length,5*TCN_LSTM_HIDDEN+4);
  assert.equal(profile.model.executionReturnHeadPooledOnlyWeights.length,TCN_LSTM_HIDDEN);
  const externalLogisticLogit=evidence[0].external_logistic_logit;
  assert.throws(()=>buildTcnLstmExecutionHeadInputFeatures(
    evidence[0].sequence,profile.model,profile.baseline_fit
  ),/TCN_LSTM_EXECUTION_HEAD_EXTERNAL_LOGISTIC_SCORE_REQUIRED/);
  const contextInputs=buildTcnLstmExecutionHeadInputFeatures(
    evidence[0].sequence,profile.model,profile.baseline_fit,{
      externalLogisticLogit
    }
  );
  const pooledInputs=buildTcnLstmExecutionHeadInputFeatures(
    evidence[0].sequence,profile.model,profile.baseline_fit,{variant:'POOLED_ONLY'}
  );
  const anchorLogit=predictTcnLstmLogisticLogit(evidence[0].sequence,profile.baseline_fit);
  const forward=inspectTcnLstmForward(evidence[0].sequence,profile.model,anchorLogit);
  const neuralLogit=forward.logit;
  const rankingResidualLogit=forward.ranking_score;
  assert.equal(contextInputs.schema,TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA);
  assert.equal(contextInputs.features.length,5*TCN_LSTM_HIDDEN+4);
  assert.equal(pooledInputs.features.length,TCN_LSTM_HIDDEN);
  const externalLogisticScore=Math.tanh(externalLogisticLogit/4);
  const logisticScore=Math.tanh(anchorLogit/4);
  const neuralScore=Math.tanh(neuralLogit/4);
  const rankingScore=Math.tanh(rankingResidualLogit/4);
  assert.ok(Math.abs(contextInputs.features.at(-4)-logisticScore)<1e-12);
  assert.ok(Math.abs(contextInputs.features.at(-3)-externalLogisticScore)<1e-12);
  assert.ok(Math.abs(contextInputs.features.at(-2)-neuralScore)<1e-12);
  assert.ok(Math.abs(contextInputs.features.at(-1)-rankingScore)<1e-12);
  for(let index=0;index<TCN_LSTM_HIDDEN;index++){
    assert.ok(Math.abs(contextInputs.features[TCN_LSTM_HIDDEN+index]-
      pooledInputs.features[index]*logisticScore)<1e-12);
    assert.ok(Math.abs(contextInputs.features[2*TCN_LSTM_HIDDEN+index]-
      pooledInputs.features[index]*externalLogisticScore)<1e-12);
    assert.ok(Math.abs(contextInputs.features[3*TCN_LSTM_HIDDEN+index]-
      pooledInputs.features[index]*neuralScore)<1e-12);
    assert.ok(Math.abs(contextInputs.features[4*TCN_LSTM_HIDDEN+index]-
      pooledInputs.features[index]*rankingScore)<1e-12);
  }
  for(const score of contextInputs.features.slice(-4))
    assert.ok(score>=-1&&score<=1);
  const normalization=profile.training.execution_regression_heads.normalization;
  assert.equal(normalization.schema,'RADARX_TCN_LSTM_EXECUTION_HEAD_TRAIN_ONLY_ZSCORE_V1');
  assert.equal(normalization.method,'TRAIN_ONLY_POPULATION_ZSCORE_FOR_FEATURES_AND_TARGETS');
  assert.equal(normalization.fit_partition,'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK');
  assert.equal(normalization.fit_rows,evidence.length);
  assert.equal(normalization.validation_or_holdout_used,false);
  const contextualNormalizers=profile.model.executionHeadNormalizers.LOGIT_CONTEXT_AUGMENTED;
  assert.equal(contextualNormalizers.net_return.feature_mean.length,5*TCN_LSTM_HIDDEN+4);
  assert.equal(contextualNormalizers.net_return.feature_std.length,5*TCN_LSTM_HIDDEN+4);
  assert.ok(contextualNormalizers.net_return.feature_std.every(value=>value>0));
  assert.ok(contextualNormalizers.net_return.target_std>0);
  assert.equal(profile.model.executionHeadNormalizers.POOLED_ONLY.net_return.feature_mean.length,
    TCN_LSTM_HIDDEN);
  const prediction=predictTcnLstmHybridExecutionHeads(
    evidence[0].sequence,profile,{externalLogisticLogit}
  );
  assert.equal(prediction.variant,'LOGIT_CONTEXT_AUGMENTED');
  assert.equal(prediction.input_feature_schema,TCN_LSTM_EXECUTION_HEAD_INPUT_FEATURE_SCHEMA);
  assert.equal(prediction.input_feature_count,5*TCN_LSTM_HIDDEN+4);
  const pooledOnlyPrediction=predictTcnLstmHybridExecutionHeads(
    evidence[0].sequence,profile,{variant:'POOLED_ONLY'}
  );
  assert.equal(pooledOnlyPrediction.variant,'POOLED_ONLY');
  assert.equal(pooledOnlyPrediction.input_feature_count,TCN_LSTM_HIDDEN);
  assert.ok(Number.isFinite(pooledOnlyPrediction.predicted_net_return_pct));
  assert.ok(Number.isFinite(prediction.predicted_net_return_pct));
  assert.ok(Number.isFinite(prediction.predicted_hurdle_net_return_pct));
  assert.ok(Number.isFinite(prediction.predicted_positive_net_return_probability));
  assert.ok(Number.isFinite(pooledOnlyPrediction.predicted_hurdle_net_return_pct));
  assert.ok(Number.isFinite(prediction.predicted_downside_risk_pct));
  const normalizedReturnFeatures=contextInputs.features.map((value,index)=>
    (value-contextualNormalizers.net_return.feature_mean[index])/
      contextualNormalizers.net_return.feature_std[index]);
  const normalizedExpected=profile.model.executionReturnHeadBias+
    normalizedReturnFeatures.reduce((sum,value,index)=>
      sum+value*profile.model.executionReturnHeadWeights[index],0);
  const restoredExpected=normalizedExpected*contextualNormalizers.net_return.target_std+
    contextualNormalizers.net_return.target_mean;
  assert.ok(Math.abs(prediction.predicted_net_return_pct-restoredExpected)<1e-10);

  assert.ok(prediction.predicted_downside_risk_pct>=0);
  const unavailable=predictTcnLstmHybridExecutionScore(
    evidence[0].sequence,profile,{externalLogisticLogit}
  );
  assert.equal(unavailable.status,'UNAVAILABLE');
  profile.execution_risk_penalty_weight=0.5;
  const scored=predictTcnLstmHybridExecutionScore(
    evidence[0].sequence,profile,{externalLogisticLogit}
  );
  assert.equal(scored.status,'AVAILABLE');
  assert.equal(scored.risk_penalty_weight,0.5);
  assert.equal(scored.score_semantics,
    'PREDICTED_NET_RETURN_MINUS_FROZEN_LAMBDA_TIMES_PREDICTED_DOWNSIDE_RISK');
  assert.ok(Math.abs(scored.risk_adjusted_net_return_score-
    (prediction.predicted_net_return_pct-0.5*prediction.predicted_downside_risk_pct))<1e-10);
  profile.execution_risk_penalty_weight=2;
  const higherPenalty=predictTcnLstmHybridExecutionScore(
    evidence[0].sequence,profile,{externalLogisticLogit}
  );
  assert.ok(higherPenalty.risk_adjusted_net_return_score<=scored.risk_adjusted_net_return_score);
  const restored=JSON.parse(JSON.stringify(profile));
  const restoredScore=predictTcnLstmHybridExecutionScore(
    evidence[0].sequence,restored,{externalLogisticLogit}
  );
  assert.equal(restoredScore.status,'AVAILABLE');
  assert.deepEqual(restored.model.executionHeadNormalizers,profile.model.executionHeadNormalizers);
  const restoredPooledOnly=predictTcnLstmHybridExecutionHeads(
    evidence[0].sequence,restored,{variant:'POOLED_ONLY'}
  );
  assert.equal(restoredPooledOnly.variant,'POOLED_ONLY');
  assert.equal(restoredPooledOnly.input_feature_count,TCN_LSTM_HIDDEN);
  assert.equal(restoredScore.risk_penalty_weight,2);
  profile.execution_ranking_score_adjustment_weight=0.75;
  const rankAdjusted=predictTcnLstmHybridExecutionScore(
    evidence[0].sequence,profile,{externalLogisticLogit}
  );
  assert.equal(rankAdjusted.ranking_score_adjustment_weight,0.75);
  assert.ok(Number.isFinite(rankAdjusted.normalized_independent_return_rank_score));
  profile.execution_minimum_positive_net_return_probability=0.65;
  const probabilityGated=predictTcnLstmHybridExecutionScore(
    evidence[0].sequence,profile,{externalLogisticLogit}
  );
  assert.equal(probabilityGated.minimum_positive_net_return_probability,0.65);
  assert.equal(probabilityGated.positive_return_probability_eligible,
    probabilityGated.predicted_positive_net_return_probability>=0.65);
  assert.equal(probabilityGated.rank_adjusted_execution_selection_score<=-1e9,
    probabilityGated.positive_return_probability_eligible===false||
      probabilityGated.base_risk_adjusted_return_positive===false);
  assert.ok(Math.abs(rankAdjusted.risk_adjusted_net_return_score-
    (rankAdjusted.predicted_net_return_pct-
      2*rankAdjusted.predicted_downside_risk_pct))<1e-10);
  assert.equal(rankAdjusted.base_risk_adjusted_return_positive,
    rankAdjusted.base_risk_adjusted_expected_net_return_pct>0);
  assert.ok(Number.isFinite(rankAdjusted.rank_adjusted_execution_selection_score));
  assert.ok(Math.abs(rankAdjusted.rank_adjusted_execution_selection_score-
    (rankAdjusted.base_risk_adjusted_expected_net_return_pct>0
      ?rankAdjusted.risk_adjusted_net_return_score+
        0.75*rankAdjusted.normalized_independent_return_rank_score:-1e9))<1e-10);
  assert.equal(restoredScore.risk_adjusted_net_return_score,
    higherPenalty.risk_adjusted_net_return_score);
  assert.equal(profile.real_order_execution,false);
});

test('selective execution policy chooses a real abstention threshold only from inner-selection rows',()=>{
  const groupCount=50;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    const outcome=group<42&&rank===0?'UP':'DOWN';
    const at=BASE+group*DAY+rank*75;
    return makeExecutionRow(index,outcome,at);
  });
  const predictions=rows.map((row,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    const profitable=group<42&&rank===0;
    return {
      predicted_net_return_pct:profitable
        ?2.9-(group%7)*0.08:rank===0?-2.0:-2.4,
      predicted_downside_risk_pct:profitable?0.25:1.8+(group%3)*0.1
    };
  });
  const logisticLogits=rows.map((row,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    if(group<42)return group<30?(rank===0?3:1):(rank===0?1:3);
    return rank===0?3:1;
  });
  const policy=selectTcnLstmExecutionRiskPolicy(rows,predictions,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8
  });
  assert.equal(policy.status,'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION');
  assert.equal(policy.passed,true);
  assert.equal(policy.selection_partition_only,true);
  assert.equal(policy.threshold_selected_on_inner_selection,true);
  assert.equal(policy.threshold_frozen_before_outer_validation,true);
  assert.equal(policy.holdout_values_used,false);
  assert.equal(policy.selected_top_k_per_timestamp,1);
  assert.equal(policy.positive_score_floor_enforced,true);
  assert.equal(policy.selected_threshold_floor_rule,'MAX_ZERO_AND_INNER_SELECTION_QUANTILE');
  assert.ok(policy.selected_minimum_risk_adjusted_score>=0);
  assert.ok(policy.selected_risk_penalty_weight>0);
  assert.ok(Number.isFinite(policy.selected_minimum_risk_adjusted_score));
  assert.ok(policy.selected_abstention_percentile>0);
  assert.ok(policy.selected_trial.abstained_decision_group_count>0);
  assert.ok(policy.selected_trial.selected_trade_count<policy.selected_trial.decision_group_count);
  assert.ok(policy.selected_trial.model_metrics.trade_count>=20);
  assert.ok(policy.selected_trial.model_metrics.win_rate_pct>=55);
  assert.ok(policy.selected_trial.model_metrics.net_pnl_pct>0);
  assert.ok(policy.selected_trial.model_metrics.max_drawdown_pct<=8);
  assert.equal(policy.selected_trial.logistic_anchor_signal_counts_matched,true);
  assert.equal(policy.selected_trial.logistic_anchor_trade_counts_matched,true);
  assert.equal(policy.selected_trial.gates.matched_logistic_executed_trade_count,true);

  const hurdleOnlyPredictions=predictions.map(item=>({
    ...item,predicted_net_return_pct:-0.2,
    predicted_hurdle_net_return_pct:item.predicted_net_return_pct
  }));
  const hurdlePolicy=selectTcnLstmExecutionRiskPolicy(rows,hurdleOnlyPredictions,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8
  });
  assert.equal(hurdlePolicy.status,'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION');
  assert.equal(hurdlePolicy.selected_return_estimator,'HURDLE_EXPECTED_VALUE');
  assert.equal(hurdlePolicy.selected_trial.return_estimator,'HURDLE_EXPECTED_VALUE');
  assert.equal(hurdlePolicy.selection_partition_only,true);
  assert.equal(hurdlePolicy.holdout_values_used,false);
});

test('independent raw rank score adjusts expected-return ranking without touching classifier probabilities',()=>{
  const groupCount=40;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    const outcome=group<30&&rank===0?'UP':'DOWN';
    const at=BASE+group*DAY+rank*75;
    return makeExecutionRow(index,outcome,at);
  });
  const predictions=rows.map((row,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    const normalizedRank=group<30
      ?(rank===0?0.5:-0.5)
      :(rank===0?-0.3:-0.4);
    return {
      predicted_net_return_pct:group<30
        ?(rank===0?0.08:0.09)
        :(rank===0?0.09:0.08),
      predicted_hurdle_net_return_pct:group<30
        ?(rank===0?0.08:0.09)
        :(rank===0?0.09:0.08),
      predicted_downside_risk_pct:0.01,
      normalized_independent_return_rank_score:normalizedRank
    };
  });
  const logisticLogits=rows.map((row,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    return group<30?(rank===0?1:3):(rank===0?1:0);
  });
  const policy=selectTcnLstmExecutionRiskPolicy(rows,predictions,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8,abstentionPercentileGrid:[0.2,0.5,0.8],
    rankingScoreAdjustmentGrid:[0,1]
  });
  assert.equal(policy.status,'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION');
  assert.equal(policy.passed,true);
  assert.equal(policy.selected_ranking_score_adjustment_weight,1);
  assert.equal(policy.selected_trial.ranking_score_adjustment_weight,1);
  assert.ok(policy.selected_trial.model_metrics.trade_count>=20);
  assert.ok(policy.selected_trial.model_metrics.win_rate_pct>=55);
  assert.ok(policy.selected_trial.model_metrics.net_pnl_pct>0);
  assert.ok(policy.selected_trial.model_metrics.max_drawdown_pct<=8);
  assert.equal(policy.selected_trial.gates.beats_matched_logistic_anchor,true);
  assert.equal(policy.selected_trial.score_formula_id,
    'POSITIVE_BASE_RISK_ADJUSTED_RETURN_GATE_PLUS_NORMALIZED_INDEPENDENT_RANK_SELECTION_ADJUSTMENT_V2');
  assert.equal(policy.selected_trial.positive_base_risk_adjusted_return_gate_enforced,true);
  // A positive rank score may not rescue negative base expectancy after risk.
  const negativeBase=predictions.map(item=>({
    ...item,predicted_net_return_pct:-0.2,
    predicted_hurdle_net_return_pct:-0.2,
    normalized_independent_return_rank_score:0.99
  }));
  const blocked=selectTcnLstmExecutionRiskPolicy(rows,negativeBase,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8,abstentionPercentileGrid:[0.2,0.5],
    rankingScoreAdjustmentGrid:[4]
  });
  assert.equal(blocked.passed,false);
  assert.equal(blocked.selected_trade_count,0);
  assert.equal(blocked.positive_base_risk_adjusted_return_gate_enforced,true);
  assert.equal(policy.holdout_values_used,false);
});

test('inner execution policy freezes a positive-return probability floor before risk-score ranking',()=>{
  const groupCount=40;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    return makeExecutionRow(index,group<30&&rank===0?'UP':'DOWN',
      BASE+group*DAY+rank*75);
  });
  const predictions=rows.map((row,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    return {
      predicted_net_return_pct:rank===0?0.08:0.20,
      predicted_hurdle_net_return_pct:rank===0?0.08:0.20,
      predicted_downside_risk_pct:0.01,
      predicted_positive_net_return_probability:group<30&&rank===0?0.82:0.35,
      normalized_independent_return_rank_score:rank===0?0.1:-0.1
    };
  });
  const logisticLogits=rows.map((row,index)=>index%2===0?0:3);
  const policy=selectTcnLstmExecutionRiskPolicy(rows,predictions,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8,abstentionPercentileGrid:[0.2,0.5,0.8],
    riskPenaltyWeightGrid:[0.01],rankingScoreAdjustmentGrid:[0],
    minimumPositiveNetReturnProbabilityGrid:[0,0.55,0.7]
  });
  assert.equal(policy.status,'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION');
  assert.equal(policy.passed,true);
  assert.ok(policy.selected_minimum_positive_net_return_probability>=0.55);
  assert.equal(policy.selected_trial.positive_return_probability_gate_enforced,true);
  assert.ok(policy.selected_trial.model_metrics.trade_count>=20);
  assert.ok(policy.selected_trial.model_metrics.win_rate_pct>=55);
  assert.ok(policy.selected_trial.model_metrics.net_pnl_pct>0);
  assert.ok(policy.selected_trial.model_metrics.max_drawdown_pct<=8);
  assert.equal(policy.selected_trial.gates.beats_matched_logistic_anchor,true);
  assert.equal(policy.holdout_values_used,false);
});

test('selective execution policy accepts a frozen lower positive risk-penalty grid',()=>{
  const groupCount=30;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    return makeExecutionRow(index,group<25&&rank===0?'UP':'DOWN',
      BASE+group*DAY+rank*75);
  });
  const predictions=rows.map((row,index)=>({
    predicted_net_return_pct:0.08,
    predicted_hurdle_net_return_pct:0.08,
    predicted_downside_risk_pct:0.5,
    normalized_independent_return_rank_score:index%2===0?0.2:-0.2
  }));
  const logisticLogits=rows.map((row,index)=>index%2===0?1:0);
  const policy=selectTcnLstmExecutionRiskPolicy(rows,predictions,logisticLogits,{
    minimumTrades:1,minimumWinRatePct:50,maximumDrawdownPct:8,
    abstentionPercentileGrid:[0.2,0.5],
    riskPenaltyWeightGrid:[0.01,0.05],
    rankingScoreAdjustmentGrid:[0]
  });
  assert.deepEqual(policy.risk_penalty_weight_grid,[0.01,0.05]);
  assert.ok(policy.trials.every(item=>item.risk_penalty_weight>0));
  assert.ok(policy.trials.every(item=>item.risk_penalty_weight<=0.05));
});
test('selective execution policy stays abstained when every predicted risk-adjusted net-return score is nonpositive',()=>{
  const groupCount=30;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    return makeExecutionRow(index,'UP',BASE+group*DAY+rank*75);
  });
  const predictions=rows.map(()=>({
    predicted_net_return_pct:-0.1,
    predicted_downside_risk_pct:0.2
  }));
  const logisticLogits=rows.map((row,index)=>index%2===0?1:0);
  const policy=selectTcnLstmExecutionRiskPolicy(rows,predictions,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8
  });
  assert.equal(policy.status,'ABSTAIN_NO_SELECTIVE_EXECUTION_POLICY_PASSED');
  assert.equal(policy.passed,false);
  assert.equal(policy.positive_score_floor_enforced,true);
  assert.equal(policy.selected_minimum_risk_adjusted_score,0);
  assert.equal(policy.selected_trade_count,0);
  assert.equal(policy.selected_trial.model_metrics.trade_count,0);
  assert.equal(policy.selected_trial.gates.minimum_trades,false);
  assert.equal(policy.selected_trial.gates.positive_net_pnl,false);
  assert.equal(policy.holdout_values_used,false);
});

test('score-conditioned execution-head ablation requires strict inner-selection improvement over pooled-only reference',()=>{
  const policy=(net,win,dd,passed=true)=>({
    status:'EVALUATED',passed,
    selected_trial:{model_metrics:{trade_count:80,net_pnl_pct:net,win_rate_pct:win,max_drawdown_pct:dd}}
  });
  const improved=summarizeTcnLstmExecutionHeadContextAblation(
    policy(0.8,56,4.0,false),policy(1.1,57,3.8,true)
  );
  assert.equal(improved.status,'EVALUATED');
  assert.equal(improved.source_partition,'INNER_SELECTION_ONLY');
  assert.equal(improved.baseline_variant,'POOLED_ONLY');
  assert.equal(improved.candidate_variant,'LOGIT_CONTEXT_AUGMENTED');
  assert.equal(improved.passed,true);
  assert.equal(improved.delta.net_pnl_percentage_points,0.3);
  const noPnlLift=summarizeTcnLstmExecutionHeadContextAblation(
    policy(0.8,56,4.0,false),policy(0.8,57,3.0,true)
  );
  assert.equal(noPnlLift.passed,false);
  assert.equal(noPnlLift.gates.net_pnl_strictly_improved,false);
  const worseWin=summarizeTcnLstmExecutionHeadContextAblation(
    policy(0.8,56,4.0,false),policy(1.1,55,3.0,true)
  );
  assert.equal(worseWin.passed,false);
  const missing=summarizeTcnLstmExecutionHeadContextAblation(
    {status:'UNAVAILABLE'},policy(1.1,57,3.8,true)
  );
  assert.equal(missing.status,'UNAVAILABLE');
  assert.equal(missing.passed,false);
});


test('execution-head ablation treats a fully abstaining pooled policy as a zero-exposure reference',()=>{
  const noExposure={
    status:'ABSTAIN_NO_SELECTIVE_EXECUTION_POLICY_PASSED',
    passed:false,threshold_frozen_before_outer_validation:true,
    selected_trial:{
      logistic_anchor_trade_counts_matched:true,
      model_metrics:{
        signal_count:0,trade_count:0,win_rate_pct:null,
        net_pnl_pct:0,max_drawdown_pct:0,return_data_status:'COMPLETE'
      }
    }
  };
  const contextPolicy={
    status:'SELECTIVE_EXECUTION_POLICY_PASSED_INNER_SELECTION',
    passed:true,threshold_frozen_before_outer_validation:true,
    minimum_win_rate_pct:55,maximum_drawdown_pct:8,
    selected_trial:{
      logistic_anchor_trade_counts_matched:true,
      model_metrics:{
        signal_count:30,trade_count:30,win_rate_pct:60,
        net_pnl_pct:0.8,max_drawdown_pct:4,
        return_data_status:'COMPLETE'
      }
    }
  };
  const evaluated=summarizeTcnLstmExecutionHeadContextAblation(noExposure,contextPolicy);
  assert.equal(evaluated.status,'EVALUATED');
  assert.equal(evaluated.pooled_only_no_exposure,true);
  assert.equal(evaluated.comparison_reference_mode,'NO_EXPOSURE_ZERO_TRADE_REFERENCE');
  assert.equal(evaluated.pooled_only_metrics.win_rate_pct,null);
  assert.equal(evaluated.delta.win_rate_percentage_points,null);
  assert.equal(evaluated.delta.drawdown_percentage_points,null);
  assert.equal(evaluated.gates.context_policy_absolute_gates,true);
  assert.equal(evaluated.gates.net_pnl_strictly_improved,true);
  assert.equal(evaluated.gates.win_rate_not_worse,true);
  assert.equal(evaluated.gates.drawdown_not_worse,true);
  assert.equal(evaluated.passed,true);

  const failedContext={
    ...contextPolicy,passed:false,
    selected_trial:{
      ...contextPolicy.selected_trial,
      model_metrics:{
        signal_count:30,trade_count:30,win_rate_pct:54,
        net_pnl_pct:0.8,max_drawdown_pct:9,
        return_data_status:'COMPLETE'
      }
    }
  };
  const rejected=summarizeTcnLstmExecutionHeadContextAblation(noExposure,failedContext);
  assert.equal(rejected.status,'EVALUATED');
  assert.equal(rejected.passed,false);
  assert.equal(rejected.gates.context_policy_absolute_gates,false);
  assert.equal(rejected.gates.win_rate_not_worse,false);
  assert.equal(rejected.gates.drawdown_not_worse,false);
});

test('rank execution policy selects an inner-only abstention threshold instead of forcing one trade per bucket',()=>{
  const groupCount=50;
  const rows=Array.from({length:groupCount*2},(_,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    const winner=group<30&&rank===0;
    const outcome=winner?'UP':'DOWN';
    const at=BASE+group*15*60*1000+rank*75;
    return makeExecutionRow(index,outcome,at);
  });
  const rankScores=rows.map((row,index)=>{
    const group=Math.floor(index/2),rank=index%2;
    if(rank===1)return -100-group;
    return group<30?100-group:20-(group-30)*0.1;
  });
  const logisticScores=rows.map((row,index)=>index%2===1?3:0);
  const policy=summarizeTcnLstmRankingExecutionSelection(rows,rankScores,logisticScores,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,maximumDrawdownPct:8
  });
  assert.equal(policy.status,'EVALUATED');
  assert.equal(policy.source_partition,'INNER_SELECTION_ONLY');
  assert.equal(policy.threshold_selected_on_inner_selection,true);
  assert.equal(policy.threshold_frozen_before_outer_validation,true);
  assert.equal(policy.holdout_values_used,false);
  assert.equal(policy.top_k_per_timestamp,1);
  assert.equal(policy.passed,true);
  assert.equal(policy.selected_trial.threshold_source,
    'INNER_SELECTION_GROUP_MAX_SCORE_QUANTILE_V1');
  assert.ok(policy.selected_abstention_percentile>0);
  assert.ok(policy.selected_trial.selected_trade_count>=20);
  assert.ok(policy.selected_trial.selected_trade_count<groupCount);
  assert.ok(policy.selected_trial.model_metrics.win_rate_pct>=55);
  assert.ok(policy.selected_trial.model_metrics.net_pnl_pct>0);
  assert.ok(policy.selected_trial.model_metrics.max_drawdown_pct<=8);
  assert.ok(policy.selected_trial.abstained_decision_group_count>0);
  assert.equal(policy.selected_trial.logistic_anchor_signal_counts_matched,true);
  assert.equal(policy.selected_trial.logistic_anchor_trade_counts_matched,true);
  assert.ok(policy.top_k_trials.every(trial=>
    trial.threshold_selected_on_inner_selection===true&&
    trial.threshold_frozen_before_outer_validation===true&&
    trial.gates.genuine_abstention===true
  ));
});

test('TCN-LSTM pairwise ranking updates only the auxiliary head from training returns',()=>{
  const rows=makeRankedRows(0,10,'rank-train');
  const fitRows=rows.map(({realized_return_pct,...row})=>row);
  const profile=trainTcnLstmHybrid(fitRows,{
    epochs:1,learningRate:0.0015,l2:0.0005,batchSize:8,
    seed:77,maxTrainingSamples:40,rankingRows:rows,rankingWeight:0,
    rankingHeadLearningRate:0.03,rankingHeadEpochs:40,
    rankingRoundTripCostBps:30,rankingMinimumReturnGapPct:0.5,
    rankingPairsPerTimestamp:4
  });
  assert.equal(profile.training.return_ranking.enabled,true);
  assert.equal(profile.training.return_ranking.method,
    'CLASSIFICATION_PROBABILITY_PLUS_INDEPENDENT_MULTISCALE_RETURN_RANKER_V2');
  assert.equal(profile.training.shared_classifier_loss.enabled,false);
  assert.equal(profile.training.shared_classifier_loss.gradient_batches_applied,0);
  assert.equal(profile.training.return_ranking.classifier_parameters_updated_by_shared_ranking_loss,false);
  assert.equal(profile.training.return_ranking.source_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(profile.training.return_ranking.comparison_pairs,10);
  assert.equal(profile.training.return_ranking.ranking_labels_seen_outside_training_partition,false);
  assert.equal(profile.training.return_ranking.classifier_parameters_updated_by_ranking_head,false);
  assert.equal(profile.training.return_ranking.ranking_head.fitted,true);
  assert.ok(profile.training.return_ranking.ranking_head.final_pairwise_log_loss<
    profile.training.return_ranking.ranking_head.initial_pairwise_log_loss);
  assert.ok(profile.model.rankingHeadWeights.some(value=>Math.abs(value)>0));
  const rankingScore=predictTcnLstmHybridRankingScore(rows[0].sequence,profile);
  const legacyRawScore=predictTcnLstmHybridRankingLogit(rows[0].sequence,profile);
  const anchorLogit=predictTcnLstmHybridRankingAnchorLogit(rows[0].sequence,profile);
  const forward=inspectTcnLstmForward(rows[0].sequence,profile.model,0);
  const alternateForward=inspectTcnLstmForward(rows[0].sequence,profile.model,anchorLogit+17);
  assert.ok(Number.isFinite(rankingScore));
  assert.ok(Number.isFinite(anchorLogit));
  assert.equal(legacyRawScore,rankingScore);
  assert.equal(rankingScore,forward.ranking_score);
  assert.equal(alternateForward.ranking_score,rankingScore,
    'independent rank score must not depend on the Logistic/classifier logit');
  assert.ok(Number.isFinite(profile.final_training_pairwise_rank_loss));
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.real_order_execution,false);
});

test('TCN-LSTM shared classifier pairwise ranking loss backpropagates through the full temporal network',()=>{
  const rows=makeRankedRows(0,10,'shared-rank-train');
  const fitRows=rows.map(({realized_return_pct,...row})=>row);
  const common={
    epochs:2,learningRate:0.0015,l2:0.0005,batchSize:8,
    seed:117,maxTrainingSamples:40,rankingRows:rows,
    rankingHeadLearningRate:0.03,rankingHeadEpochs:20,
    rankingRoundTripCostBps:30,rankingMinimumReturnGapPct:0.5,
    rankingPairsPerTimestamp:4
  };
  const classifierOnly=trainTcnLstmHybrid(fitRows,{...common,rankingWeight:0});
  const shared=trainTcnLstmHybrid(fitRows,{...common,rankingWeight:0.05});
  const loss=shared.training.shared_classifier_loss;
  assert.equal(loss.enabled,true);
  assert.equal(loss.method,'SHARED_TCN_LSTM_CLASSIFIER_PAIRWISE_LOGIT_BACKPROP_PCGRAD_V2');
  assert.equal(loss.conflict_resolution,'PCGRAD_PROJECT_AUXILIARY_RANKING_GRADIENT');
  assert.ok(Number.isFinite(loss.mean_gradient_cosine_before_projection));
  assert.equal(loss.source_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(loss.comparison_pairs,10);
  assert.ok(loss.gradient_batches_applied>0);
  assert.ok(loss.pair_updates_applied>0);
  assert.equal(loss.classifier_parameters_updated,true);
  assert.equal(loss.validation_or_holdout_used,false);
  assert.ok(shared.training.history.some(item=>item.shared_ranking_pairs_used>0));
  assert.ok(shared.training.history.every(item=>
    Number.isFinite(item.post_update_shared_classifier_pairwise_rank_loss)&&
    Number.isFinite(item.post_update_training_composite_objective)
  ));
  assert.notDeepEqual(shared.model.outputWeights,classifierOnly.model.outputWeights);
  assert.equal(shared.training.return_ranking.classifier_parameters_updated_by_ranking_head,false);
  assert.equal(shared.training.return_ranking.classifier_parameters_updated_by_shared_ranking_loss,true);
  assert.equal(shared.probability_ready,false);
  assert.equal(shared.real_order_execution,false);
});

test('ordered ranker epoch checkpoints require Pareto improvement on both accuracy and log loss',()=>{
  const incumbent={pairwise_accuracy_pct:60,pairwise_log_loss:0.50};
  assert.equal(isTcnLstmDualMetricCheckpointBetter(
    {pairwise_accuracy_pct:61,pairwise_log_loss:0.49},incumbent),true,
    'improving both metrics must replace the checkpoint');
  assert.equal(isTcnLstmDualMetricCheckpointBetter(
    {pairwise_accuracy_pct:60,pairwise_log_loss:0.49},incumbent),true,
    'a loss improvement with unchanged accuracy is valid');
  assert.equal(isTcnLstmDualMetricCheckpointBetter(
    {pairwise_accuracy_pct:61,pairwise_log_loss:0.50},incumbent),true,
    'an accuracy improvement with unchanged loss is valid');
  assert.equal(isTcnLstmDualMetricCheckpointBetter(
    {pairwise_accuracy_pct:61,pairwise_log_loss:0.51},incumbent),false,
    'accuracy gains cannot compensate for worse log loss');
  assert.equal(isTcnLstmDualMetricCheckpointBetter(
    {pairwise_accuracy_pct:59,pairwise_log_loss:0.49},incumbent),false,
    'loss gains cannot compensate for worse accuracy');
  assert.equal(isTcnLstmDualMetricCheckpointBetter(incumbent,incumbent),false,
    'an exact tie is not a new best checkpoint');
  assert.throws(()=>isTcnLstmDualMetricCheckpointBetter(
    {pairwise_accuracy_pct:101,pairwise_log_loss:0.4},incumbent),
    /TCN_LSTM_DUAL_METRIC_CHECKPOINT_ARGUMENTS_INVALID/);
});

test('ordered ranker selection fails closed unless the selected V6 candidate beats Logistic on both metrics in all three folds',()=>{
  const foldResults=Array.from({length:3},(_,index)=>({
    fold_index:index+1,
    best_validation_pairwise_accuracy_pct:66+index,
    logistic_validation_pairwise_accuracy_pct:64+index,
    best_validation_pairwise_log_loss:0.60-index*0.005,
    logistic_validation_pairwise_log_loss:0.62-index*0.005,
    epoch_checkpoint_selected:true
  }));
  const rankHead={
    schema:'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1',
    representation:'RAW_ORDERED_696_V1',
    internal_training_validation:{
      schema:'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6',
      method:'THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3',
      epoch_checkpoint_selection_policy:'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1',
      fold_count:3,
      selected_candidate_qualified:true,
      fold_stable_dual_metric_superiority:true,
      robustness_status:'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY',
      fold_stable_dual_metric_candidate_count:1,
      selected_temporal_block_count:2,
      selected_l2:0.05,
      selected_epochs:11,
      selected_parameterization_id:'TEMPORAL_BLOCK_TIED_2X29_V1',
      selected_parameter_count:58,
      candidate_grid:[{
        temporal_block_count:2,l2:0.05,best_epoch:11,
        parameterization_id:'TEMPORAL_BLOCK_TIED_2X29_V1',
        parameter_count:58,epoch_checkpoint_selected_count:3,
        all_epoch_checkpoints_selected:true,fold_results:foldResults
      }]
    }
  };

  assert.equal(hasFoldStableOrderedRankerQualification(rankHead,'RAW_ORDERED_696_V1'),true);

  const unqualified=structuredClone(rankHead);
  unqualified.internal_training_validation.selected_candidate_qualified=false;
  unqualified.internal_training_validation.fold_stable_dual_metric_superiority=false;
  unqualified.internal_training_validation.robustness_status='ABSTAIN_NO_FOLD_STABLE_DUAL_SUPERIORITY';
  unqualified.internal_training_validation.fold_stable_dual_metric_candidate_count=0;
  assert.equal(hasFoldStableOrderedRankerQualification(unqualified,'RAW_ORDERED_696_V1'),false);

  const missingParetoPolicy=structuredClone(rankHead);
  missingParetoPolicy.internal_training_validation.epoch_checkpoint_selection_policy=
    'ACCURACY_FIRST_THEN_LOG_LOSS';
  assert.equal(hasFoldStableOrderedRankerQualification(missingParetoPolicy,'RAW_ORDERED_696_V1'),false,
    'the runtime qualification gate must reject an undeclared checkpoint policy');

  const noParetoCheckpoint=structuredClone(rankHead);
  noParetoCheckpoint.internal_training_validation.candidate_grid[0]
    .all_epoch_checkpoints_selected=false;
  noParetoCheckpoint.internal_training_validation.candidate_grid[0]
    .epoch_checkpoint_selected_count=2;
  noParetoCheckpoint.internal_training_validation.candidate_grid[0]
    .fold_results[1].epoch_checkpoint_selected=false;
  assert.equal(hasFoldStableOrderedRankerQualification(noParetoCheckpoint,'RAW_ORDERED_696_V1'),false,
    'all three nested folds must select a genuine Pareto checkpoint before ranker qualification');

  const accuracyRegression=structuredClone(rankHead);
  accuracyRegression.internal_training_validation.candidate_grid[0]
    .fold_results[1].best_validation_pairwise_accuracy_pct=65;
  assert.equal(hasFoldStableOrderedRankerQualification(accuracyRegression,'RAW_ORDERED_696_V1'),false,
    'one fold with no strict Logistic accuracy margin must force abstention');

  const lossRegression=structuredClone(rankHead);
  lossRegression.internal_training_validation.candidate_grid[0]
    .fold_results[2].best_validation_pairwise_log_loss=0.62;
  assert.equal(hasFoldStableOrderedRankerQualification(lossRegression,'RAW_ORDERED_696_V1'),false,
    'one fold with no strict Logistic log-loss margin must force abstention');

  const legacyTwoFold=structuredClone(rankHead);
  legacyTwoFold.internal_training_validation.schema=
    'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V5';
  legacyTwoFold.internal_training_validation.fold_count=2;
  assert.equal(hasFoldStableOrderedRankerQualification(legacyTwoFold,'RAW_ORDERED_696_V1'),false);

  assert.equal(hasFoldStableOrderedRankerQualification(
    {representation:'LATENT_MULTI_SCALE_V2'},'LATENT_MULTI_SCALE_V2'
  ),true,'the V6 ordered-ranker gate must not alter the separate legacy ranker representation');
});

test('TCN-LSTM inner selector scores pairwise ranking on its own purged selection partition',()=>{
  // The independent ranker fits on the earlier model-training block.
  // Execution-head features must therefore be OOS for that ranker.
  const trainingRows=makeRankedRows(0,50,'selector-train').map(row=>({
    ...row,max_adverse_excursion_pct:row.target===1?-0.4:-1.1
  }));
  const selectionRows=makeRankedRows(60,10,'selector-selection');
  let externalContextProviderCalls=0;
  let externalContextPurgeVerified=false;
  let externalContextLabelIsolationVerified=false;
  const result=selectTcnLstmHybridHyperparameters(trainingRows,selectionRows,{
    requiredImprovement:0.00025,maxTrainingSamples:200,seed:131,
    roundTripCostBps:30,rankingScoreWeight:0.01,
    rankingMinimumReturnGapPct:0.5,rankingPairsPerTimestamp:4,
    rankingPairStrategy:'PROFITABILITY_BOUNDARY_V1',
    rankingRepresentation:'RAW_ORDERED_696_V1',
    rankingHeadLearningRate:0.03,rankingHeadEpochs:8,rankingHeadL2:0.001,
    requireExternalLogisticSelectionBaseline:true,
    externalLogisticExecutionContextProvider:(modelRows,scoringRows)=>{
      externalContextProviderCalls++;
      externalContextPurgeVerified=
        Math.max(...modelRows.map(row=>row.resolved_at))<
        Math.min(...scoringRows.map(row=>row.at));
      externalContextLabelIsolationVerified=
        modelRows.every(row=>row.target===0||row.target===1)&&
        modelRows.every(row=>!Object.hasOwn(row,'realized_return_pct')&&
          !Object.hasOwn(row,'max_adverse_excursion_pct'))&&
        scoringRows.every(row=>!Object.hasOwn(row,'target')&&
          !Object.hasOwn(row,'realized_return_pct')&&
          !Object.hasOwn(row,'max_adverse_excursion_pct'));
      const oofModelRows=modelRows.slice(Math.floor(modelRows.length*0.35));
      return {
        model:{training_partition_only:true,kind:'TEST_PURGED_TEMPORAL_LOGISTIC'},
        feature_schema_id:'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1',
        feature_schema_names:Array.from({length:696},(_,index)=>'STEP_FEATURE_'+index),
        report:{
          schema:'RADARX_TRAIN_ONLY_PURGED_EXPANDING_LOGISTIC_CV_V2',
          status:'COMPLETE',training_partition_only:true,
          outer_validation_rows_used:false,holdout_rows_or_labels_used:false,
          selected_configuration:{l2:0.01,learning_rate:0.01},
          calibration:{status:'RAW_FALLBACK'}
        },
        training_predictions:oofModelRows.map((row,index)=>({
          id:String(row.id),at:Number(row.at),
          raw_logit:(Number(row.at)%997)/997-0.5,
          oof_fold:(index%3)+1,
          maximum_training_label_resolved_at:Number(row.at)-1,
          source_partition:'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLD'
        })),
        training_predictions_are_out_of_fold:true,
        training_prediction_coverage:{
          schema:'RADARX_PURGED_EXPANDING_TEMPORAL_LOGISTIC_OOF_PREDICTIONS_V1',
          total_training_rows:modelRows.length,
          oof_scored_rows:oofModelRows.length,
          outer_validation_or_holdout_used:false
        },
        predictions:scoringRows.map(row=>({
          id:String(row.id),at:Number(row.at),
          raw_logit:(Number(row.at)%997)/997-0.5,
          logit:-0.25
        }))
      };
    },
    candidates:[
      {name:'BRIER_ONLY',learningRate:0.0015,l2:0.0005,dropout:0,epochs:1},
      {name:'PAIRWISE_RANK',learningRate:0.0015,l2:0.0005,dropout:0,epochs:1,rankingWeight:0.02}
    ]
  });
  assert.equal(result.baseline.pairwise_ranking.status,'AVAILABLE');
  assert.equal(result.baseline.pairwise_ranking.comparison_pairs,40);
  assert.equal(result.baseline.kind,'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW');
  assert.equal(result.baseline.feature_schema_id,
    'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1');
  assert.equal(result.baseline.feature_count,696);
  assert.equal(result.baseline.probability_stage,'RAW_UNCALIBRATED');
  assert.equal(result.training_residual_anchor.kind,
    'TCN_LSTM_FROZEN_POOLED_LOGISTIC_ANCHOR_V1');
  const expectedRawProbabilities=selectionRows.map(row=>
    1/(1+Math.exp(-((Number(row.at)%997)/997-0.5)))
  );
  const expectedRawBrier=selectionRows.reduce((sum,row,index)=>
    sum+(expectedRawProbabilities[index]-row.target)**2,0
  )/selectionRows.length;
  assert.ok(Math.abs(result.baseline.selection_brier-expectedRawBrier)<1e-8,
    'inner selection must compare the neural probability against the raw 696D Logistic scores, not the calibrated context or pooled 58D anchor');
  assert.equal(result.execution_logistic_context.inner_selection_baseline_source,
    'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW');
  // The top-level classifier baseline source identifies OOF logits consumed
  // during neural training. The explicit baseline object identifies the final
  // Logistic refit used to score the later inner-selection rows.
  assert.equal(result.classifier_baseline_source,
    'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF');
  assert.equal(result.baseline.kind,
    'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW',
    'the explicit baseline result must identify the final-refit Logistic used to score inner-selection rows');
  const selectedOrDiagnostic=result.selected_fit??result.diagnostic_fit;
  assert.equal(result.classifier_baseline_feature_count,696);
  assert.equal(result.classifier_baseline_training_logits_used,true);
  assert.equal(result.classifier_baseline_training_logits_are_purged_oof,true);
  assert.equal(result.classifier_baseline_training_rows,
    selectedOrDiagnostic.training.rows);
  assert.ok(result.classifier_baseline_training_rows<result.model_training_rows,
    'the Logistic OOF subset must be smaller than the complete model-training partition');
  assert.equal(result.training_return_pair_support.training_rows,result.model_training_rows);
  assert.equal(result.training_return_pair_support.ranker_fitted_once_for_all_classifier_candidates,true);
  assert.equal(result.classifier_residual_reference.training_logits_used_for_fit,true);
  assert.equal(result.classifier_residual_reference.training_logits_are_purged_out_of_fold,true);
  assert.equal(result.classifier_residual_reference.selection_logits_from_final_train_only_refit,true);
  assert.equal(result.classifier_residual_reference.same_logistic_feature_schema_and_objective,true);
  assert.equal(result.classifier_residual_reference.feature_count,696);
  assert.equal(result.selection_scoring.ranking_uses_inner_selection_partition_only,true);
  assert.equal(result.selection_scoring.outer_validation_or_holdout_used,false);
  assert.equal(result.candidates.length,2);
  assert.equal(result.candidate_count_requested,2);
  assert.equal(result.candidate_count_evaluated,2);
  assert.equal(result.training_return_pair_support.status,'AVAILABLE');
  assert.equal(externalContextProviderCalls,1,
    'one frozen temporal Logistic fit must score both the execution-head and later selection rows');
  assert.equal(externalContextPurgeVerified,true,
    'the provider training labels must all resolve before any score-context row');
  assert.equal(externalContextLabelIsolationVerified,true,
    'score-only rows must not expose target labels or realized execution outcomes');
  assert.equal(result.execution_logistic_context.status,'AVAILABLE');
  assert.equal(result.execution_logistic_context.validation_or_holdout_used,false);
  assert.equal(selectedOrDiagnostic.execution_logistic_context_model.kind,
    'TEST_PURGED_TEMPORAL_LOGISTIC');
  assert.equal(selectedOrDiagnostic.training.classifier_baseline.source,
    'TUNED_FULL_ORDERED_TEMPORAL_LOGISTIC_696_RAW_OOF');
  assert.equal(selectedOrDiagnostic.training.classifier_baseline.feature_count,696);
  assert.equal(selectedOrDiagnostic.training.classifier_baseline.training_logits_available_rows,
    selectedOrDiagnostic.training.rows);
  assert.equal(selectedOrDiagnostic.training.classifier_baseline.source_partition,
    'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLDS');
  assert.equal(selectedOrDiagnostic.training.classifier_baseline.predictions_are_purged_out_of_fold,true);
  assert.equal(selectedOrDiagnostic.training.classifier_baseline.validation_or_holdout_used,false);
  const pairwiseCandidate=result.candidates.find(item=>item.name==='PAIRWISE_RANK');
  assert.equal(pairwiseCandidate?.config.rankingWeight,0.02,
    'the selected candidate weight must be passed into the actual classifier optimizer');
  assert.equal(pairwiseCandidate?.config.requested_shared_classifier_ranking_weight,0.02);
  assert.equal(pairwiseCandidate?.shared_classifier_training?.enabled,true);
  assert.equal(pairwiseCandidate?.shared_classifier_training?.weight,0.02);
  assert.ok(pairwiseCandidate?.shared_classifier_training?.gradient_batches_applied>0,
    'a positive configured ranking weight must apply real classifier-gradient batches');
  assert.equal(pairwiseCandidate?.shared_classifier_training?.classifier_parameters_updated,true);
  assert.equal(pairwiseCandidate?.shared_classifier_training?.validation_or_holdout_used,false);
  assert.ok(result.candidates.every(item=>item.pairwise_ranking.status==='AVAILABLE'));
  assert.ok(result.candidates.every(item=>item.ranking_head?.fitted===true));
  assert.ok(result.candidates.every(item=>
    item.ranking_head?.training_rows===result.model_training_rows&&
    item.ranking_head?.standardization?.fit_rows===result.model_training_rows&&
    item.ranking_head?.source_partition==='PRE_EXECUTION_MODEL_TRAINING_PARTITION'&&
    item.ranking_head?.feature_scoring_partition==='PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK'&&
    item.ranking_head?.feature_scores_out_of_sample===true&&
    item.ranking_head?.downstream_feature_contract?.out_of_sample_for_execution_head_features===true&&
    item.ranking_head?.downstream_feature_contract?.training_and_execution_feature_identities_disjoint===true&&
    item.ranking_head?.downstream_feature_contract?.chronology_valid===true
  ),'every execution-head rank feature must be scored by a ranker fit on earlier disjoint training rows');
  assert.ok(result.candidates.every(item=>{
    const internal=item.ranking_head?.internal_training_validation;
    return internal?.schema==='RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6'&&
      internal?.method==='THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3'&&
      internal?.epoch_checkpoint_selection_policy===
        'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1'&&
      internal?.epoch_selection_policy===
        'NESTED_PURGED_EPOCH_WINDOW_THEN_FIXED_EPOCH_REFIT_ON_FULL_OUTER_FOLD_TRAINING_ROWS'&&
      internal?.chronology_valid===true&&
      internal?.outer_validation_or_holdout_used===false&&
      internal?.model_selection_partition_used===false&&
      internal?.fold_count===3&&internal?.folds?.length===3&&
      internal?.folds.every((fold,index)=>
        fold.fold_index===index+1&&fold.tuning_rows>=20&&fold.validation_rows>=20&&
        fold.tuning_pairs>=10&&fold.validation_pairs>=10&&
        Number.isFinite(fold.logistic_validation_pairwise_accuracy_pct)&&
        fold.logistic_validation_pairwise_accuracy_pct>=0&&fold.logistic_validation_pairwise_accuracy_pct<=100&&
        Number.isFinite(fold.logistic_validation_pairwise_log_loss)&&
        fold.logistic_baseline_training_rows===fold.tuning_rows&&
        fold.logistic_baseline_validation_labels_read===false&&
        fold.logistic_baseline_validation_or_holdout_used===false&&
        fold.epoch_training_rows>=20&&fold.epoch_validation_rows>=20&&
        fold.epoch_training_pairs>=10&&fold.epoch_validation_pairs>=10&&
        fold.epoch_training_rows+fold.epoch_validation_rows+
          fold.epoch_purged_rows+fold.epoch_unused_rows===fold.tuning_rows&&
        fold.epoch_purge_gap_ms>=4*60*60*1000&&
        fold.epoch_validation_min_at>fold.epoch_training_max_resolved_at&&
        fold.epoch_validation_max_at<fold.validation_min_at&&
        fold.purge_gap_ms>=4*60*60*1000&&
        fold.validation_min_at>fold.tuning_max_resolved_at)&&
      internal.folds.slice(0,-1).every((fold,index)=>
        fold.validation_max_at<internal.folds[index+1].validation_min_at&&
        internal.folds[index+1].tuning_max_at>=fold.validation_max_at)&&
      internal?.validation_rows>=40&&internal?.purged_rows>=0&&
      internal?.purge_gap_ms>=4*60*60*1000&&
      internal?.l2_grid?.length===10&&
      [0.0001,0.00025,0.0005,0.001,0.01,0.05,0.10,0.25,0.5,1.0].every(l2=>
        internal.l2_grid.includes(l2)&&
        internal.candidate_grid.some(candidate=>candidate.l2===l2))&&
      internal?.candidate_grid?.length===80&&
      [1,2,3,4,6,8,12,24].every(blockCount=>
        internal.candidate_grid.some(candidate=>candidate.temporal_block_count===blockCount))&&
      internal.candidate_grid.every(candidate=>
        candidate.parameter_count===candidate.temporal_block_count*29&&
        candidate.steps_per_block===24/candidate.temporal_block_count&&
        candidate.fold_count===3&&candidate.fold_results?.length===3&&
        Number.isFinite(candidate.minimum_fold_pairwise_log_loss_improvement))&&
      Number.isFinite(internal?.selected_validation_pairwise_log_loss)&&
      Number.isFinite(internal?.selected_validation_pairwise_accuracy_pct)&&
      Number.isFinite(internal?.selected_minimum_fold_pairwise_accuracy_pct)&&
      Number.isFinite(internal?.selected_validation_pairwise_accuracy_improvement_pct)&&
      Number.isFinite(internal?.selected_minimum_fold_pairwise_accuracy_improvement_pct)&&
      Number.isFinite(internal?.selected_minimum_fold_pairwise_log_loss_improvement)&&
      Number.isFinite(internal?.selected_validation_pairwise_log_loss_improvement)&&
      internal?.selected_candidate_qualified===(internal?.fold_stable_dual_metric_candidate_count>0)&&
      internal?.fold_stable_dual_metric_superiority===internal?.selected_candidate_qualified&&
      internal?.robustness_status===(internal?.selected_candidate_qualified
        ?'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY':'ABSTAIN_NO_FOLD_STABLE_DUAL_SUPERIORITY')&&
      internal?.candidate_grid?.every(candidate=>Number.isFinite(candidate.best_validation_pairwise_accuracy_pct)&&
        Number.isFinite(candidate.minimum_fold_pairwise_accuracy_pct)&&
        Number.isFinite(candidate.best_validation_pairwise_accuracy_improvement_pct)&&
        Number.isFinite(candidate.minimum_fold_pairwise_accuracy_improvement_pct)&&
        Number.isFinite(candidate.minimum_fold_pairwise_log_loss_improvement)&&
        Number.isFinite(candidate.best_validation_pairwise_log_loss_improvement)&&
        candidate.fold_results.every(fold=>
          Number.isFinite(fold.best_validation_pairwise_accuracy_pct)&&
          Number.isFinite(fold.logistic_validation_pairwise_accuracy_pct)&&
          Number.isFinite(fold.logistic_validation_pairwise_log_loss)&&
          Number.isFinite(fold.epoch_selection_pairwise_accuracy_pct)&&
          Number.isFinite(fold.epoch_selection_pairwise_log_loss)&&
          fold.epoch_training_rows>=20&&fold.epoch_validation_rows>=20&&
          fold.epoch_purge_gap_ms>=4*60*60*1000&&
          Number.isFinite(fold.training_pairwise_accuracy_pct)))&&
      internal?.final_refit_rows===result.model_training_rows&&
      internal?.final_refit_pairs===item.ranking_head.training_pairs&&
      internal?.final_refit_epoch_selection_mode===
        'FIXED_EPOCHS_FROM_NESTED_PURGED_FOLD_EARLY_STOPPING'&&
      item.ranking_head.epoch_selection_mode==='FIXED_EPOCHS';
  }),'the final ranker must be refit on all pre-execution training rows after purged training-only tuning');
  assert.ok(result.candidates.every(item=>
    item.ranking_score_method==='RAW_ORDERED_696_INDEPENDENT_PAIRWISE_RANK_SCORE_V1'&&
    item.ranking_score_domain==='RAW_LINEAR_SCORE_NO_SIGMOID_NO_CLASSIFIER_LOGIT_ADDITION'&&
    item.independent_ranker_fit_mode===
      'FITTED_ONCE_ON_COMPLETE_PRE_EXECUTION_MODEL_TRAINING_PARTITION'
  ));
  assert.equal(result.selection_scoring.score_separation_method,
    'RAW_ORDERED_696_RETURN_RANK_SCORE_NO_SIGMOID_NO_CLASSIFIER_LOGIT_ADDITION_V1');
  assert.equal(result.selection_scoring.method,
    'INNER_CLASSIFIER_BRIER_PLUS_RAW_ORDERED_696_RETURN_RANKING_V7');
  assert.equal(result.selection_scoring.require_pairwise_ranking_improvement,true);
  assert.ok(result.candidates.every(item=>
    item.shared_classifier_pairwise_ranking.status==='AVAILABLE'&&
    Number.isFinite(item.shared_classifier_pairwise_ranking_improvement)
  ));
  assert.ok(result.candidates.every(item=>item.logistic_pairwise_ranking.holdout_values_used===false));
  assert.ok(result.candidates.every(item=>{
    const stageOnePassed=item.brier_improvement>0.00025&&
      Number.isFinite(item.pairwise_ranking_improvement)&&item.pairwise_ranking_improvement>0&&
      item.ranking_head?.fitted===true&&item.ranking_head.weight_l2_norm>1e-8&&
      item.pairwise_ranking.pairwise_accuracy_pct>50&&
      item.pairwise_ranking.pairwise_accuracy_pct>
        item.logistic_pairwise_ranking.pairwise_accuracy_pct;
    const stageTwoAttempted=stageOnePassed||item.stage_two_diagnostic_only===true;
    return stageTwoAttempted
      ?item.ranking_execution_selection.status!=='DEFERRED_UNTIL_DUAL_INNER_GATE'
      :item.ranking_execution_selection.status==='DEFERRED_UNTIL_DUAL_INNER_GATE';
  }));
  assert.equal(result.candidates.filter(item=>item.stage_two_diagnostic_only===true).length,
    result.candidates.length>0&&result.candidates[0].passed_inner_composite_margin!==true?1:0,
    'only the best non-qualified candidate may enter diagnostic Stage 2');
  assert.equal(result.ranking_head_selection_qualification.qualified,false);
  assert.equal(result.real_order_execution,false);
});

test('locked variational dropout uses one channel mask across 24 steps and passes BPTT finite differences',()=>{
  const sequence=makeSequence(1,19);
  const scale=[0,1.25,0,1.25,1.25,0,1.25,0];
  const model=createTcnLstmHybridModelForAudit(23);
  const forward=inspectTcnLstmForward(sequence,model,0.12,{dropoutScale:scale});
  assert.deepEqual(forward.input_dropout_scale,scale);
  for(let time=0;time<TCN_LSTM_STEPS;time++){
    for(let channel=0;channel<scale.length;channel++){
      assert.ok(Math.abs(
        forward.lstm_input_sequence[time][channel]-
        forward.tcn_latent_sequence[time][channel]*scale[channel]
      )<1e-12);
    }
  }
  const audit=auditTcnLstmHybridGradients(sequence,1,{
    model:createTcnLstmHybridModelForAudit(23),
    baselineLogit:-0.09,
    epsilon:1e-5,
    dropoutScale:scale
  });
  assert.equal(audit.passed,true,
    'locked-dropout max abs error='+audit.maximum_absolute_error+
    ' worst='+JSON.stringify(audit.worst_parameter));
});

test('training-only Logistic anchor is deterministic and identity-bound to its training rows',()=>{
  const rows=makeRows(0,40);
  const first=fitTcnLstmLogisticAnchor(rows);
  const second=fitTcnLstmLogisticAnchor(rows);
  assert.equal(first.training_rows,40);
  assert.equal(first.training_fingerprint,second.training_fingerprint);
  assert.deepEqual(first.weights,second.weights);
  assert.equal(first.fit_boundary,'TRAINING_PARTITION_ONLY');
  assert.equal(buildTcnLstmAnchorFeatures(rows[0].sequence).length,58);
});

test('inner-selection return screen deducts fees and becomes a bounded candidate-selection gate',()=>{
  const rows=Array.from({length:24},(_,index)=>({
    id:'return-'+index,
    realized_return_pct:index<14?3:-2
  }));
  const probabilities=rows.map(()=>0.7);
  const result=summarizeTcnLstmSelectionReturns(rows,probabilities,{
    thresholds:[0.5],roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55
  });
  assert.equal(result.status,'AVAILABLE');
  assert.equal(result.selection_partition_only,true);
  assert.equal(result.holdout_values_used,false);
  assert.equal(result.diagnostic_only,false);
  assert.equal(result.affects_candidate_ranking,true);
  assert.equal(result.affects_acceptance_gates,true);
  assert.equal(result.portfolio_drawdown_evaluated,false);
  assert.equal(result.trials[0].trade_count,24);
  assert.equal(result.trials[0].net_wins,14);
  assert.equal(result.trials[0].net_losses,10);
  assert.equal(result.trials[0].win_rate_pct,58.3333);
  assert.equal(result.trials[0].mean_net_trade_return_pct,0.616667);
  assert.equal(result.best_preliminary_threshold,0.5);
  const incomplete=summarizeTcnLstmSelectionReturns(
    [{realized_return_pct:1},{realized_return_pct:null}],
    [0.8,0.7],{thresholds:[0.5]}
  );
  assert.equal(incomplete.status,'UNAVAILABLE');
  assert.equal(incomplete.reason,'SELECTION_REALIZED_RETURN_OR_PROBABILITY_INCOMPLETE');
});

test('inner-selection top-K diagnostics compare TCN-LSTM with the frozen Logistic anchor on identical decision times',()=>{
  const rows=[];
  const modelProbabilities=[];
  const logisticProbabilities=[];
  for(let group=0;group<8;group++){
    const at=Math.floor((BASE+group*4*60*60*1000)/900000)*900000;
    rows.push(
      makeExecutionRow(group*3,'UP',at),
      makeExecutionRow(group*3+1,'DOWN',at),
      makeExecutionRow(group*3+2,'DOWN',at)
    );
    modelProbabilities.push(0.9,0.2,0.1);
    logisticProbabilities.push(0.1,0.9,0.2);
  }
  const result=summarizeTcnLstmSelectionReturns(rows,modelProbabilities,{
    baselineProbabilities:logisticProbabilities,
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    thresholds:[0.5]
  });
  const rank=result.cross_sectional_rank_diagnostics;
  assert.equal(rank.status,'AVAILABLE');
  assert.equal(rank.selection_partition_only,true);
  assert.equal(rank.holdout_values_used,false);
  assert.equal(rank.affects_candidate_ranking,false);
  assert.equal(rank.affects_acceptance_gates,false);
  assert.deepEqual(rank.top_k_grid,[1,2,3]);
  const topOne=rank.trials[0];
  assert.equal(topOne.decision_group_count,8);
  assert.equal(topOne.model_metrics.trade_count,8);
  assert.equal(topOne.model_metrics.win_rate_pct,100);
  assert.equal(topOne.logistic_metrics.trade_count,8);
  assert.equal(topOne.logistic_metrics.win_rate_pct,0);
  assert.ok(topOne.model_minus_logistic.net_pnl_pct>0);
});

test('mini-batch TCN-LSTM training restores a finite train-only checkpoint and predicts probabilities',()=>{
  const rows=makeRows(0,32);
  const profile=trainTcnLstmHybrid(rows,{
    epochs:2,learningRate:0.0015,l2:0.001,
    batchSize:8,seed:101,maxTrainingSamples:32
  });
  assert.equal(profile.schema,TCN_LSTM_HYBRID_SCHEMA);
  assert.equal(profile.status,'TRAINED_RESEARCH_CHALLENGER_NOT_VALIDATED');
  assert.equal(profile.training.rows,32);
  assert.equal(profile.training.fit_boundary,'TRAINING_PARTITION_ONLY');
  assert.equal(profile.training.restored_best_training_checkpoint,true);
  assert.equal(profile.training.validation_or_selection_or_holdout_used_for_fit,false);
  const probability=predictTcnLstmHybridProbability(rows[0].sequence,profile);
  assert.ok(Number.isFinite(probability)&&probability>=0&&probability<=1);
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.live_eligibility_ready,false);
});

test('classifier probability and raw multi-scale return ranking are independent outputs',()=>{
  const rows=makeRows(0,32,'independent-rank-score');
  const profile=trainTcnLstmHybrid(rows,{
    epochs:2,learningRate:0.0015,l2:0.001,
    batchSize:8,seed:202,maxTrainingSamples:32
  });
  const sequence=rows[0].sequence;
  const anchorLogit=predictTcnLstmHybridRankingAnchorLogit(sequence,profile);
  const hidden=profile.model.rankingHeadWeights.length;
  const sigmoid=value=>1/(1+Math.exp(-value));
  profile.model.rankingHeadWeights=Array(hidden).fill(0.01);
  const rankingForward=inspectTcnLstmForward(sequence,profile.model,0);
  const classifierForward=inspectTcnLstmForward(sequence,profile.model,anchorLogit);
  const classifierProbability=sigmoid(classifierForward.logit);
  const score=predictTcnLstmHybridRankingScore(sequence,profile);
  assert.ok(Math.abs(predictTcnLstmHybridProbability(sequence,profile)-
    classifierProbability)<1e-12);
  assert.equal(score,rankingForward.ranking_score);
  const changedLogisticContext=inspectTcnLstmForward(sequence,profile.model,anchorLogit+15);
  assert.equal(changedLogisticContext.ranking_score,score,
    'rank score must not depend on the frozen Logistic anchor/classifier logit');
  assert.ok(Math.abs(predictTcnLstmHybridProbability(sequence,profile)-
    classifierProbability)<1e-12,
    'rank-head parameters must not change the classifier probability');
  assert.equal(profile.real_order_execution,false);
});

test('execution-head split uses a later complete 15m block and purges forward labels',()=>{
  const rows=makeRows(0,100,'execution-split').map((row,index)=>({
    ...row,max_adverse_excursion_pct:index%2===0?-0.35:-1.2
  }));
  const split=splitTcnLstmTrainingRowsForExecutionHead(rows);
  assert.equal(split.status,'READY');
  assert.equal(split.diagnostics.schema,'RADARX_TCN_LSTM_PURGED_EXECUTION_HEAD_SPLIT_V1');
  assert.equal(split.model_training_rows.length,59);
  assert.equal(split.execution_head_rows.length,40);
  assert.equal(split.purged_rows.length,1);
  assert.ok(Math.max(...split.model_training_rows.map(row=>row.resolved_at))<
    Math.min(...split.execution_head_rows.map(row=>row.at)));
  assert.equal(split.diagnostics.representation_out_of_sample,true);
  assert.equal(split.diagnostics.validation_or_holdout_used,false);
  const modelIds=new Set(split.model_training_rows.map(row=>row.id));
  assert.ok(split.execution_head_rows.every(row=>!modelIds.has(row.id)));
});

test('execution-head split abstains when a complete purged training block lacks support',()=>{
  const rows=makeRows(0,30,'small-execution-split').map((row,index)=>({
    ...row,max_adverse_excursion_pct:index%2===0?-0.35:-1.2
  }));
  const split=splitTcnLstmTrainingRowsForExecutionHead(rows);
  assert.equal(split.status,'UNAVAILABLE');
  assert.equal(split.execution_head_rows,null);
  assert.equal(split.diagnostics.representation_out_of_sample,false);
});

test('hyper-parameter selection uses only a purged chronological inner-selection block',()=>{
  const training=makeRows(0,100,'train').map((row,index)=>({
    ...row,max_adverse_excursion_pct:index%2===0?-0.35:-1.2
  }));
  const selection=makeRows(101,20,'selection');
  const result=selectTcnLstmHybridHyperparameters(training,selection,{
    candidates:[
      {name:'LOW_RATE',learningRate:0.0015,l2:0.0005,epochs:2},
      {name:'MID_RATE',learningRate:0.0025,l2:0.0015,dropout:0.10,epochs:2}
    ],
    requiredImprovement:0.00025,seed:7,maxTrainingSamples:100
  });
  assert.equal(result.training_support.rows,100);
  assert.equal(result.model_training_rows,59);
  assert.equal(result.execution_head_training_rows,40);
  assert.equal(result.training_sample_selection.execution_head_split.status,'READY');
  assert.equal(result.training_sample_selection.execution_head_split.purged_rows,1);
  assert.equal(result.selection_support.rows,20);
  assert.equal(result.candidates.length,2);
  assert.ok(result.candidates.every(row=>
    Number.isFinite(row.selection_brier)&&Number.isFinite(row.logistic_selection_brier)));
  assert.equal(result.candidates.find(row=>row.name==='MID_RATE').config.dropout,0.10);
  assert.ok(result.candidates.every(row=>{
    const dualInnerGatePassed=row.brier_improvement>0.00025&&
      Number.isFinite(row.pairwise_ranking_improvement)&&
      row.pairwise_ranking_improvement>0;
    const diagnosticWinner=row.name===result.diagnostic_configuration;
    if(dualInnerGatePassed||diagnosticWinner){
      return row.return_selection_diagnostics.selection_partition_only===true&&
        row.return_selection_diagnostics.holdout_values_used===false;
    }
    return row.return_selection_diagnostics.status==='DEFERRED_UNTIL_DUAL_INNER_GATE'&&
      row.return_selection_diagnostics.selection_partition_only===true;
  }), 'only dual-gate candidates and the single diagnostic winner may fit train-only execution heads');
  assert.equal(result.status,'ABSTAIN_NO_INNER_SELECTION_SUPERIORITY');
  assert.equal(result.selected_fit,null);
  assert.ok(result.diagnostic_fit);
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
  assert.equal(result.validation_or_holdout_used_for_fit_or_selection,false);
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
});

test('hyper-parameter selection rejects an unresolved split purge or identity overlap',()=>{
  const training=makeRows(0,40,'same');
  const overlapping=makeRows(39,20,'selection');
  assert.throws(()=>selectTcnLstmHybridHyperparameters(training,overlapping,{
    candidates:[
      {name:'A',learningRate:0.0015,l2:0.0005,epochs:1},
      {name:'B',learningRate:0.0025,l2:0.0015,epochs:1}
    ],maxTrainingSamples:40
  }),/TCN_LSTM_TRAIN_SELECTION_PURGE_VIOLATION/);
});

test('volatility extremes remain finite while malformed and out-of-contract tensors fail closed',()=>{
  const extreme=Array.from({length:24},(_,time)=>
    Array.from({length:29},(_,feature)=>(time+feature)%2?4:-4));
  const output=inspectTcnLstmForward(extreme,createTcnLstmHybridModelForAudit(31),25);
  assert.ok(Number.isFinite(output.probability));
  assert.ok(output.attention_weights.every(Number.isFinite));
  const malformed=makeSequence();
  malformed[7][12]=Number.NaN;
  assert.throws(()=>inspectTcnLstmForward(malformed,createTcnLstmHybridModelForAudit()),
    /TCN_LSTM_SEQUENCE_VALUE_INVALID/);
  const outOfRange=makeSequence();
  outOfRange[8][4]=4.01;
  assert.throws(()=>inspectTcnLstmForward(outOfRange,createTcnLstmHybridModelForAudit()),
    /TCN_LSTM_SEQUENCE_VALUE_INVALID/);
});

test('raw and fully calibrated inference paths are finite and measured without hardware claims',()=>{
  const rows=makeRows(0,32);
  const profile=trainTcnLstmHybrid(rows,{epochs:1,learningRate:0.0015,l2:0.001,batchSize:8});
  const raw=benchmarkTcnLstmHybridInference(rows[0].sequence,profile,{warmup:2,iterations:10});
  assert.ok(raw.p50_ms>=0);
  assert.ok(raw.p95_ms>=raw.p50_ms);
  assert.equal(raw.calibrated,false);
  assert.equal(raw.measured_path,'RAW_TCN_LSTM_FORWARD_PLUS_FROZEN_LOGISTIC_ANCHOR');
  assert.equal(raw.production_latency_claim,false);

  const calibrator={fitted:true,slope:1.2,intercept:-0.08};
  const probability=predictTcnLstmHybridCalibratedProbability(
    rows[0].sequence,profile,calibrator
  );
  assert.ok(Number.isFinite(probability)&&probability>=0&&probability<=1);
  const calibrated=benchmarkTcnLstmHybridInference(rows[0].sequence,profile,{
    warmup:2,iterations:10,modelCalibrator:calibrator
  });
  assert.ok(calibrated.p50_ms>=0);
  assert.ok(calibrated.p95_ms>=calibrated.p50_ms);
  assert.equal(calibrated.calibrated,true);
  assert.equal(calibrated.measured_path,
    'TCN_LSTM_FORWARD_PLUS_FROZEN_LOGISTIC_ANCHOR_PLUS_PLATT_CALIBRATION');
  assert.equal(calibrated.production_latency_claim,false);
  assert.throws(()=>predictTcnLstmHybridCalibratedProbability(
    rows[0].sequence,profile,{fitted:false}
  ),/TCN_LSTM_INFERENCE_CALIBRATOR_NOT_FITTED/);
  assert.throws(()=>benchmarkTcnLstmHybridInference(rows[0].sequence,profile,{
    warmup:2,iterations:10,modelCalibrator:{fitted:false}
  }),/TCN_LSTM_INFERENCE_CALIBRATOR_NOT_FITTED/);
});

test('full TCN-LSTM benchmark uses purged time partitions and reports untouched outer Brier',()=>{
  const rows=makeRows(0,100*4,'chronology');
  const result=benchmarkTcnLstmHybridChronological(rows,{
    maxTrainingSamples:80,bootstrapIterations:40,seed:17,
    candidates:[
      {name:'LOW',learningRate:0.0015,l2:0.0005,epochs:2},
      {name:'MID',learningRate:0.0025,l2:0.0015,epochs:2}
    ]
  });
  assert.equal(result.input_samples,rows.length);
  assert.ok(result.partition_support.training.rows>=20);
  assert.ok(result.partition_support.selection.rows>=20);
  assert.ok(result.partition_support.calibration.rows>=20);
  assert.ok(result.partition_support.validation.rows>=20);
  assert.ok(result.partition_support.holdout.rows>=20);
  assert.equal(result.inner_selection_diagnostics.validation_or_holdout_used_for_fit_or_selection,false);
  const hasCalibration=result.calibration?.model?.fitted===true;
  if(hasCalibration){
    assert.equal(result.calibration.model.fit_boundary,'CALIBRATION_PARTITION_ONLY');
    assert.equal(result.validation.evaluated,true);
    assert.equal(result.holdout.evaluated,false);
    assert.equal(result.holdout.status,'LOCKED');
    assert.equal(result.holdout.labels_read,false);
    assert.equal(result.holdout.metrics_read,false);
    assert.equal(result.validation.sample_count,result.partition_support.validation.rows);
    assert.equal(result.validation.required_brier_improvement,0.003);
    if(result.validation.passed){
      assert.equal(result.status,'VALIDATION_PASSED_HOLDOUT_STILL_LOCKED');
      assert.equal(result.holdout.reason,'HOLDOUT_LOCKED_PENDING_EXPLICIT_FINAL_PROTOCOL_AUTHORIZATION');
    }
  }else{
    assert.ok(['ABSTAIN_INNER_SELECTION_GATE_FAILED','ABSTAIN_CALIBRATION_SUPPORT_FAILED']
      .includes(result.status));
    assert.notEqual(result.holdout?.evaluated,true);
  }
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
  assert.equal(result.real_order_execution,false);
  assert.equal(result.inference_latency.evaluated,
    result.calibration?.model?.fitted===true);
  assert.equal(result.zero_latency_claim,false);
  if(result.inference_latency.evaluated){
    assert.ok(result.inference_latency.p50_ms>=0);
    assert.ok(result.inference_latency.p95_ms>=result.inference_latency.p50_ms);
    assert.equal(result.inference_latency.calibrated,true);
    assert.equal(result.inference_latency.production_latency_claim,false);
  }
});

test('full TCN-LSTM benchmark rejects datasets with overlapping label maturity across partitions',()=>{
  const rows=makeRows(0,100*4,'purge');
  // Move a training outcome beyond the selection boundary while preserving its
  // baseline identity and its temporal sequence cadence.
  const changed=rows.map(row=>({...row}));
  changed.find(row=>row.id==='purge-0').resolved_at=BASE+205*DAY;
  const result=benchmarkTcnLstmHybridChronological(changed,{
    maxTrainingSamples:80,bootstrapIterations:20
  });
  assert.equal(result.status,'CHRONOLOGY_OR_CLASS_SUPPORT_REJECTED');
  assert.ok(result.purge_violations.length>0);
});

test('full TCN-LSTM benchmark fails closed for insufficient unique UTC days',()=>{
  const rows=makeRows(0,40,'short-window');
  const result=benchmarkTcnLstmHybridChronological(rows);
  assert.equal(result.status,'WAITING_FOR_UNIQUE_UTC_DAY_SUPPORT');
  assert.equal(result.probability_ready,false);
});

test('five-partition calibrated evaluation gates holdout behind external validation',()=>{
  const training=makeRows(0,40,'train');
  const selection=makeRows(41,20,'selection');
  const calibration=makeRows(62,60,'calibration');
  const validation=makeRows(123,60,'validation');
  const holdout=makeRows(184,60,'holdout');
  const result=evaluateTcnLstmHybridGeneralization({
    trainingRows:training,selectionRows:selection,
    calibrationRows:calibration,validationRows:validation,holdoutRows:holdout,
    candidates:[
      {name:'LR_LOW',learningRate:0.0015,l2:0.0005,epochs:1},
      {name:'LR_MID',learningRate:0.0025,l2:0.0015,epochs:1}
    ],
    requiredInnerImprovement:0,
    maxTrainingSamples:40,bootstrapIterations:200,seed:19
  });
  assert.equal(result.partition_summary.training.rows,40);
  assert.equal(result.partition_summary.calibration.rows,60);
  // The synthetic fixture has no inner-selection return-qualified candidate.
  // Fail closed before fitting calibration or opening external validation.
  assert.equal(result.status,'ABSTAIN_INNER_SELECTION_GATE_FAILED');
  assert.equal(result.calibration.fitted,false);
  assert.equal(result.validation.evaluated,false);
  assert.equal(result.holdout.evaluated,false);
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
  assert.equal(result.real_order_execution,false);
});

test('holdout outcome labels remain unread until external validation passes',()=>{
  const rows=makeRows(0,400,'sealed-holdout');
  const days=[...new Set(rows.map(row=>Math.floor(row.at/DAY)*DAY))].sort((a,b)=>a-b);
  const holdoutStart=days[Math.floor(days.length*0.87)]+DAY;
  const sealed=rows.map(row=>{
    if(row.at<holdoutStart)return row;
    const copy={...row};
    delete copy.target;
    Object.defineProperty(copy,'target',{
      enumerable:true,configurable:false,
      get(){throw new Error('HOLDOUT_LABEL_READ_BEFORE_EXTERNAL_VALIDATION');}
    });
    return copy;
  });
  const result=benchmarkTcnLstmHybridChronological(sealed,{
    maxTrainingSamples:80,bootstrapIterations:200,seed:37,
    requiredInnerImprovement:0,
    requiredOuterImprovement:1.0,
    candidates:[
      {name:'DROP00',learningRate:0.0015,l2:0.0005,dropout:0,epochs:1},
      {name:'DROP10',learningRate:0.0025,l2:0.0015,dropout:0.10,epochs:1}
    ]
  });
  // Without matured MAE/first-touch execution evidence, the new independent
  // return/risk heads cannot qualify the inner fit. The sealed holdout getter
  // must still remain unread and the evaluator must fail closed.
  assert.notEqual(result.validation?.evaluated,true);
  assert.notEqual(result.validation?.passed,true);
  assert.notEqual(result.holdout?.evaluated,true);
  assert.equal(result.holdout.reason,'HOLDOUT_LOCKED_PENDING_EXPLICIT_FINAL_PROTOCOL_AUTHORIZATION');
});

test('five-partition evaluator rejects leakage, overlapping identities and unresolved label maturity',()=>{
  const training=makeRows(0,40,'train');
  const selection=makeRows(41,20,'selection');
  const calibration=makeRows(62,60,'calibration');
  const validation=makeRows(123,60,'validation');
  const holdout=makeRows(184,60,'holdout');
  const duplicated=selection.map(row=>({...row,id:training[0].id}));
  assert.throws(()=>evaluateTcnLstmHybridGeneralization({
    trainingRows:training,selectionRows:duplicated,
    calibrationRows:calibration,validationRows:validation,holdoutRows:holdout,
    candidates:[
      {name:'A',learningRate:0.0015,l2:0.0005,epochs:1},
      {name:'B',learningRate:0.0025,l2:0.0015,epochs:1}
    ],maxTrainingSamples:40
  }),/TCN_LSTM_CROSS_PARTITION_IDENTITY_OVERLAP/);
  const immature=selection.map((row,index)=>index===0?{...row,resolved_at:row.at}:row);
  assert.throws(()=>evaluateTcnLstmHybridGeneralization({
    trainingRows:training,selectionRows:immature,
    calibrationRows:calibration,validationRows:validation,holdoutRows:holdout,
    candidates:[
      {name:'A',learningRate:0.0015,l2:0.0005,epochs:1},
      {name:'B',learningRate:0.0025,l2:0.0015,epochs:1}
    ],maxTrainingSamples:40
  }),/TCN_LSTM_PARTITION_EVENT_OR_MATURITY_TIME_INVALID/);
});

test('TCN receptive field covers all two-tap causal dilations',()=>{
  assert.equal(TCN_LSTM_RECEPTIVE_FIELD,15);
});


test('recurrent training budget uses up to 6,144 available training rows without touching later partitions',()=>{
  assert.equal(TCN_LSTM_MAX_TRAINING_SAMPLES,6144);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(6144,36102),6144);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(6144,1200),1200);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(512,36102),512);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(8192,36102),6144);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(6144,20),20);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(undefined,36102),6144);
});

test('recurrent fit budget preserves recent regimes and anchors older complete 15m groups',()=>{
  const bucketMs=15*60*1000;
  const rows=Array.from({length:12},(_,groupIndex)=>{
    const at=Math.floor((BASE+groupIndex*bucketMs)/bucketMs)*bucketMs;
    return Array.from({length:30},(_,symbolIndex)=>({
      id:`g${groupIndex}-s${symbolIndex}`,
      symbol:`S${String(symbolIndex).padStart(2,'0')}`,
      at
    }));
  }).flat();
  const selected=selectChronologicalTcnLstmTrainingRows(rows,120);
  const repeated=selectChronologicalTcnLstmTrainingRows(rows,120);
  assert.equal(selected.rows.length,120);
  assert.equal(selected.diagnostics.effective_budget,120);
  assert.equal(selected.diagnostics.method,'RECENCY_WEIGHTED_COMPLETE_15M_DECISION_BUCKETS_V1');
  assert.equal(selected.diagnostics.available_decision_groups,12);
  assert.equal(selected.diagnostics.selected_decision_groups,4);
  assert.equal(selected.diagnostics.recent_window_fraction,0.35);
  assert.equal(selected.diagnostics.recent_budget_fraction,0.70);
  assert.equal(selected.diagnostics.recent_selected_decision_groups,3);
  assert.equal(selected.diagnostics.older_selected_decision_groups,1);
  assert.equal(selected.diagnostics.recent_selected_fraction,0.75);
  assert.equal(selected.diagnostics.sampled_across_full_training_chronology,true);
  assert.equal(selected.diagnostics.complete_decision_groups,true);
  const selectedGroupCounts=new Map();
  for(const row of selected.rows){
    const key=Math.floor(row.at/bucketMs)*bucketMs;
    selectedGroupCounts.set(key,(selectedGroupCounts.get(key)||0)+1);
  }
  assert.deepEqual([...selectedGroupCounts.values()],[30,30,30,30]);
  const selectedIndices=[...selectedGroupCounts.keys()].map(at=>
    Math.round((at-Math.floor(BASE/bucketMs)*bucketMs)/bucketMs));
  assert.deepEqual(selectedIndices,[0,7,9,11]);
  assert.deepEqual(selected.rows.map(row=>row.id),repeated.rows.map(row=>row.id));
  assert.equal(selected.rows[0].at,rows[0].at);
  assert.equal(selected.rows.at(-1).at,rows.at(-1).at);
});



test('exported Platt fitting accepts only supplied calibration rows and reports its fit boundary',()=>{
  const calibrationRows=makeRows(500,60,'four-hour-calibration');
  const calibrator=fitTcnLstmHybridCalibration(
    calibrationRows,
    sequence=>sequence[0][0]>=0?0.72:0.28,
    {minimumSamples:30,minimumPositive:8,minimumNegative:8,iterations:120}
  );
  assert.equal(calibrator.fitted,true);
  assert.equal(calibrator.fit_boundary,'CALIBRATION_PARTITION_ONLY');
  assert.equal(calibrator.samples,60);
  assert.equal(calibrator.positive,30);
  assert.equal(calibrator.negative,30);
  assert.ok(Number.isFinite(calibrator.slope));
  assert.ok(Number.isFinite(calibrator.intercept));
  const unsupported=fitTcnLstmHybridCalibration(
    makeRows(700,20,'thin-calibration'),
    sequence=>sequence[0][0]>=0?0.72:0.28
  );
  assert.equal(unsupported.fitted,false);
  assert.equal(unsupported.reason,'TCN_LSTM_CALIBRATION_SUPPORT_BELOW_MINIMUM');
});


test('four-hour TCN-LSTM splitter keeps fit, selection and calibration inside outer train and purges every 4h boundary',()=>{
  const fourHourRows=makeRows(0,120,'outer-train').map(row=>({
    ...row,resolved_at:row.at+4*60*60*1000
  }));
  const external=makeRows(125,12,'outer-validation').map(row=>{
    const value={
      id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.at+4*60*60*1000,
      sequence:row.sequence,temporal_sequence_timestamps:row.temporal_sequence_timestamps
    };
    Object.defineProperty(value,'target',{
      enumerable:true,get(){throw new Error('EXTERNAL_VALIDATION_LABEL_READ_DURING_INTERNAL_SPLIT');}
    });
    return value;
  });
  const result=splitFourHourTcnLstmTrainingRows(fourHourRows,external,{
    horizonMs:4*60*60*1000
  });
  assert.equal(result.status,'READY');
  assert.equal(result.schema,'RADARX_TCN_LSTM_FOUR_HOUR_PURGED_INNER_SPLIT_V1');
  assert.equal(result.external_validation_labels_read,false);
  assert.equal(result.chronology_valid,true);
  assert.equal(result.identities_valid,true);
  const {training,selection,calibration}=result.partitions;
  assert.ok(training.length>=20&&selection.length>=20&&calibration.length>=20);
  assert.ok(Math.max(...training.map(row=>row.resolved_at))<
    Math.min(...selection.map(row=>row.at)));
  assert.ok(Math.max(...selection.map(row=>row.resolved_at))<
    Math.min(...calibration.map(row=>row.at)));
  assert.ok(Math.max(...calibration.map(row=>row.resolved_at))<
    Math.min(...external.map(row=>row.at)));
  const outerTrainIds=new Set(fourHourRows.map(row=>row.id));
  for(const row of [...training,...selection,...calibration])
    assert.ok(outerTrainIds.has(row.id),'inner partition row must originate from outer train');
  assert.equal(new Set([...training,...selection,...calibration].map(row=>row.id)).size,
    training.length+selection.length+calibration.length);
});

test('four-hour TCN-LSTM splitter rejects non-four-hour labels and outer boundary leakage',()=>{
  const rows=makeRows(0,120,'outer-train').map(row=>({
    ...row,resolved_at:row.at+4*60*60*1000
  }));
  const external=makeRows(125,12,'outer-validation').map(row=>({
    id:row.id,symbol:row.symbol,at:row.at,resolved_at:row.at+4*60*60*1000,
    sequence:row.sequence,temporal_sequence_timestamps:row.temporal_sequence_timestamps
  }));
  const wrongHorizon=rows.map((row,index)=>index===0
    ?{...row,resolved_at:row.at+24*60*60*1000}:row);
  const rejected=splitFourHourTcnLstmTrainingRows(wrongHorizon,external,{
    horizonMs:4*60*60*1000
  });
  assert.equal(rejected.status,'ABSTAIN_FOUR_HOUR_LABEL_MATURITY_MISMATCH');
  const leaked=external.map((row,index)=>{
    if(index!==0)return row;
    const shiftedAt=rows.at(-1).at+60_000;
    return {
      ...row,at:shiftedAt,resolved_at:shiftedAt+4*60*60*1000,
      temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
        shiftedAt-(23-step)*900000)
    };
  });
  const leakage=splitFourHourTcnLstmTrainingRows(rows,leaked,{
    horizonMs:4*60*60*1000
  });
  assert.equal(leakage.status,'ABSTAIN_OUTER_TRAIN_VALIDATION_PURGE_FAILED');
});


test('failed inner TCN-LSTM selection preserves a diagnostic-only fit without qualifying it',()=>{
  const training=makeRows(0,40,'diagnostic-train');
  const selection=makeRows(41,20,'diagnostic-selection');
  const result=selectTcnLstmHybridHyperparameters(training,selection,{
    candidates:[
      {name:'DIAGNOSTIC_A',learningRate:0.0015,l2:0.0005,epochs:1},
      {name:'DIAGNOSTIC_B',learningRate:0.0025,l2:0.0015,dropout:0.1,epochs:1}
    ],
    requiredImprovement:10,
    seed:229,
    maxTrainingSamples:40
  });
  assert.equal(result.status,'ABSTAIN_NO_INNER_SELECTION_SUPERIORITY');
  assert.equal(result.selected_fit,null);
  assert.ok(result.diagnostic_fit&&result.diagnostic_fit.model,
    'best inner candidate remains available solely for sealed outer diagnostics');
  assert.ok(result.diagnostic_configuration);
  assert.equal(result.validation_or_holdout_used_for_fit_or_selection,false);
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
  assert.equal(result.real_order_execution,false);
});

test('selective execution policy evaluates singleton 15m buckets without treating them as a Logistic edge',()=>{
  const groupCount=40;
  const rows=Array.from({length:groupCount},(_,index)=>
    makeExecutionRow(index,index<25?'UP':'DOWN',BASE+index*DAY)
  );
  const predictions=rows.map((row,index)=>({
    predicted_net_return_pct:index<25?1.2:-1,
    predicted_downside_risk_pct:0.1
  }));
  const logisticLogits=rows.map((row,index)=>index<25?1:-1);
  const policy=selectTcnLstmExecutionRiskPolicy(rows,predictions,logisticLogits,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,
    maximumDrawdownPct:8
  });
  assert.equal(policy.status,'ABSTAIN_NO_SELECTIVE_EXECUTION_POLICY_PASSED');
  assert.equal(policy.passed,false);
  assert.equal(policy.selected_trial.decision_group_count,40);
  assert.equal(policy.selected_trial.selected_trade_count,25);
  assert.equal(policy.selected_trial.abstained_decision_group_count,15);
  assert.equal(policy.holdout_values_used,false);
  assert.equal(policy.selected_trial.gates.beats_matched_logistic_anchor,false);
});



test('ordered 696-feature pairwise ranker fits training-only normalization and leaves classifier parameters unchanged',()=>{
  const modelTrainingRows=makeRankedRows(0,12,'ordered-ranker-fit');
  const executionFeatureRows=makeRankedRows(100,12,'ordered-ranker-execution');
  const fitRows=modelTrainingRows.map(({realized_return_pct,...row})=>row);
  const options={
    epochs:1,learningRate:0.0015,l2:0.0005,batchSize:8,
    seed:696224,maxTrainingSamples:fitRows.length,
    rankingRows:modelTrainingRows,fitIndependentRankingHead:true,
    rankingPairStrategy:'PROFITABILITY_BOUNDARY_V1',
    rankingRepresentation:'RAW_ORDERED_696_V1'
  };
  const profile=trainTcnLstmHybrid(fitRows,options);
  const classifierOnly=trainTcnLstmHybrid(fitRows,{
    ...options,fitIndependentRankingHead:false
  });
  const ranker=profile.training.return_ranking.ranking_head;
  assert.equal(ranker.fitted,true);
  assert.equal(ranker.schema,'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1');
  assert.equal(ranker.representation,'RAW_ORDERED_696_V1');
  assert.equal(ranker.fit_boundary,'TRAINING_PARTITION_ONLY');
  assert.equal(ranker.feature_count,TCN_LSTM_ORDERED_RANKING_FEATURE_COUNT);
  assert.equal(ranker.feature_count,TCN_LSTM_STEPS*TCN_LSTM_INPUT_CHANNELS);
  assert.equal(ranker.training_rows,modelTrainingRows.length);
  assert.equal(ranker.training_pairs,48);
  assert.equal(ranker.standardization.fit_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(ranker.standardization.fit_rows,modelTrainingRows.length);
  assert.equal(ranker.feature_schema_id,
    'RADARX_TCN_LSTM_LOGISTIC_FULL_ORDERED_SEQUENCE_24X29_696_V1');
  assert.equal(ranker.classifier_parameters_updated,false);
  assert.equal(ranker.validation_or_holdout_used,false);
  assert.equal(profile.model.rankingRepresentation,'RAW_ORDERED_696_V1');
  assert.equal(profile.model.orderedRankingHeadWeights.length,696);
  assert.equal(profile.training.return_ranking.representation,'RAW_ORDERED_696_V1');
  assert.equal(profile.training.return_ranking.comparison_pairs,48);

  const withoutRankFields=model=>{
    const copy=structuredClone(model);
    delete copy.rankingRepresentation;
    delete copy.rankingHeadWeights;
    delete copy.rankingFeatureMean;
    delete copy.rankingFeatureStd;
    delete copy.orderedRankingHeadWeights;
    delete copy.orderedRankingFeatureMean;
    delete copy.orderedRankingFeatureStd;
    return copy;
  };
  assert.deepEqual(withoutRankFields(profile.model),withoutRankFields(classifierOnly.model),
    'the full-sequence rank head must not update any temporal classifier parameter');

  const score=predictTcnLstmHybridRankingScore(modelTrainingRows[0].sequence,profile);
  assert.ok(Number.isFinite(score));
  const forward=inspectTcnLstmForward(
    modelTrainingRows[0].sequence,profile.model,0
  );
  assert.equal(forward.ranking_representation,'RAW_ORDERED_696_V1');
  assert.equal(forward.ranking_score_feature_count,696);
  assert.equal(forward.ranking_score,score);

  const trainingIds=new Set(modelTrainingRows.map(row=>String(row.id)));
  assert.ok(executionFeatureRows.every(row=>!trainingIds.has(String(row.id))),
    'later execution feature identities must be disjoint from the ranker fit rows');
  const rankerMaxResolvedAt=Math.max(...modelTrainingRows.map(row=>row.resolved_at));
  const executionMinAt=Math.min(...executionFeatureRows.map(row=>row.at));
  assert.ok(rankerMaxResolvedAt<executionMinAt,
    'all ranker labels must resolve before the later execution-feature block begins');
  for(const row of executionFeatureRows.slice(0,4)){
    const anchorLogit=predictTcnLstmLogisticLogit(row.sequence,profile.baseline_fit);
    const executionFeatures=buildTcnLstmExecutionHeadInputFeatures(
      row.sequence,profile.model,profile.baseline_fit,{
        variant:'LOGIT_CONTEXT_AUGMENTED',
        externalLogisticLogit:anchorLogit
      }
    );
    const independentScore=predictTcnLstmHybridRankingScore(row.sequence,profile);
    assert.equal(executionFeatures.independent_return_rank_score,independentScore);
    assert.equal(executionFeatures.normalized_ranking_score,Math.tanh(independentScore/4));
    assert.ok(Number.isFinite(executionFeatures.normalized_ranking_score));
  }

  const restored=JSON.parse(JSON.stringify(profile));
  assert.equal(
    predictTcnLstmHybridRankingScore(modelTrainingRows[0].sequence,restored),
    score,
    'fresh-process JSON state must preserve the independent ordered rank score'
  );
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.real_order_execution,false);
});

test('raw ordered ranker fits once on all pre-execution rows and can be injected into a smaller OOF classifier fit',()=>{
  const completePartition=makeRankedRows(0,30,'ranker-full-partition');
  const executionFeatureRows=makeRankedRows(100,4,'ranker-full-partition-execution');
  const ranker=fitTcnLstmOrderedRankerForTrainingPartition(completePartition,{
    roundTripCostBps:30,minimumReturnGapPct:0.50,maxPairsPerTimestamp:16,
    learningRate:0.03,epochs:8,l2:0.001,patience:5
  });
  assert.equal(ranker.fitted,true);
  assert.equal(ranker.training_rows,completePartition.length);
  assert.equal(ranker.training.training_rows,completePartition.length);
  assert.equal(ranker.training.standardization.fit_rows,completePartition.length);
  assert.equal(ranker.training.epoch_checkpoint_selection_policy,
    'FIXED_EPOCH_COUNT_NO_CHECKPOINT_SELECTION');
  assert.equal(ranker.training.internal_training_validation.epoch_checkpoint_selection_policy,
    'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1');
  assert.equal(ranker.training_pairs,ranker.pair_support.comparison_pairs);
  assert.ok(ranker.training_pairs>=10);
  assert.equal(ranker.source_partition,'PRE_EXECUTION_MODEL_TRAINING_PARTITION');
  const chosenBlocks=ranker.training.temporal_block_count;
  const chosenStepsPerBlock=24/chosenBlocks;
  assert.equal(ranker.training.parameter_count,chosenBlocks*29);
  assert.equal(ranker.training.steps_per_block,chosenStepsPerBlock);
  assert.equal(ranker.training.parameterization_id,
    'TEMPORAL_BLOCK_TIED_'+chosenBlocks+'X29_V1');
  assert.equal(ranker.training.internal_training_validation.selected_temporal_block_count,
    chosenBlocks);
  const rankerGrid=ranker.training.internal_training_validation;
  const expectedL2Grid=[0.0001,0.00025,0.0005,0.001,0.01,0.05,0.10,0.25,0.5,1.0];
  assert.deepEqual(rankerGrid.l2_grid,expectedL2Grid);
  assert.equal(rankerGrid.candidate_grid.length,80);
  for(const l2 of expectedL2Grid) for(const blockCount of [1,2,3,4,6,8,12,24])
    assert.ok(rankerGrid.candidate_grid.some(candidate=>
      candidate.l2===l2&&candidate.temporal_block_count===blockCount),
      'the complete low-to-high L2 grid must cover every temporal block count');
  for(let step=0;step<24;step++){
    const firstStep=Math.floor(step/chosenStepsPerBlock)*chosenStepsPerBlock;
    for(let channel=0;channel<29;channel++){
      const current=step*29+channel,first=firstStep*29+channel;
      assert.equal(ranker.model_state.orderedRankingHeadWeights[current],
        ranker.model_state.orderedRankingHeadWeights[first]);
      assert.equal(ranker.model_state.orderedRankingFeatureMean[current],
        ranker.model_state.orderedRankingFeatureMean[first]);
      assert.equal(ranker.model_state.orderedRankingFeatureStd[current],
        ranker.model_state.orderedRankingFeatureStd[first]);
    }
  }
  assert.equal(ranker.training.validation_or_holdout_used,false);
  assert.equal(ranker.training.classifier_parameters_updated,false);
  const rankerMaxResolvedAt=Math.max(...completePartition.map(row=>row.resolved_at));
  const executionFeatureMinAt=Math.min(...executionFeatureRows.map(row=>row.at));
  assert.ok(rankerMaxResolvedAt<executionFeatureMinAt);

  // Exercise the V6 three-fold provenance validator with an actual fitted ranker.
  const artifactProfile={
    model:{
      rankingRepresentation:ranker.model_state.rankingRepresentation,
      orderedRankingHeadWeights:[...ranker.model_state.orderedRankingHeadWeights],
      orderedRankingFeatureMean:[...ranker.model_state.orderedRankingFeatureMean],
      orderedRankingFeatureStd:[...ranker.model_state.orderedRankingFeatureStd]
    },
    training:{
      return_ranking:{
        representation:'RAW_ORDERED_696_V1',
        pair_strategy:'PROFITABILITY_BOUNDARY_V1',
        round_trip_cost_bps:30,
        minimum_return_gap_pct:0.50,
        maximum_pairs_per_timestamp:16,
        ranking_head:{
          ...ranker.training,
          downstream_feature_contract:{
            schema:'RADARX_TCN_LSTM_EXECUTION_RANK_FEATURE_OUT_OF_SAMPLE_CONTRACT_V1',
            fit_partition:'PRE_EXECUTION_MODEL_TRAINING_PARTITION',
            feature_scoring_partition:'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK',
            ranker_training_rows:ranker.training_rows,
            ranker_training_pairs:ranker.training_pairs,
            ranker_standardizer_fit_rows:ranker.training.standardization.fit_rows,
            ranker_standardizer_fit_partition:'TRAINING_PARTITION_ONLY',
            model_training_max_resolved_at:rankerMaxResolvedAt,
            execution_feature_min_at:executionFeatureMinAt,
            purge_gap_ms:executionFeatureMinAt-rankerMaxResolvedAt,
            training_and_execution_feature_identities_disjoint:true,
            chronology_valid:true,
            classifier_parameters_updated_by_ranker:false,
            validation_or_holdout_used:false,
            out_of_sample_for_execution_head_features:true
          }
        }
      }
    }
  };
  const artifactProvenance={
    sourceCommitSha:'1'.repeat(40),
    datasetSha256:'2'.repeat(64),
    inputFileSha256:'3'.repeat(64),
    datasetSourceCommitSha:'4'.repeat(40),
    datasetRowCount:32300,
    targetDefinition:'FIRST_TOUCH_PLUS_3_PCT_BEFORE_MINUS_2_PCT_WITHIN_4H_1M_V1',
    targetSemantics:'UP_IF_PLUS_3_PCT_FIRST_BEFORE_MINUS_2_PCT_ELSE_NON_SUCCESS_WITHIN_4H_1M_V1',
    featureNames:Array.from({length:696},(_,index)=>'STEP_FEATURE_'+String(index).padStart(3,'0')),
    roundTripCostBps:30,
    splitDefinition:{
      schema:'RADARX_NEURAL_CLOSURE_PURGED_60_20_20_UTC_DAY_SPLIT_V1',
      purge_ms:86400000,
      counts:{train:19269,validation:6282,holdout:6389}
    }
  };
  const v6Artifact=createOrderedTemporalRankerArtifact({
    profile:artifactProfile,provenance:artifactProvenance
  });
  const v6Verification=verifyOrderedTemporalRankerArtifact(v6Artifact);
  assert.equal(v6Verification.valid,true,v6Verification.reason);
  const v6Tuning=v6Artifact.training_provenance.internal_training_validation;
  assert.equal(v6Tuning.fold_count,3);
  assert.equal(v6Tuning.method,
    'THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3');
  assert.equal(v6Tuning.epoch_checkpoint_selection_policy,
    'PARETO_NON_REGRESSION_PAIRWISE_ACCURACY_AND_LOG_LOSS_V1');  for(const candidate of v6Tuning.candidate_grid){
    const selectedCount=candidate.fold_results.filter(fold=>
      fold.epoch_checkpoint_selected===true).length;
    assert.equal(candidate.epoch_checkpoint_selected_count,selectedCount);
    assert.equal(candidate.all_epoch_checkpoints_selected,selectedCount===v6Tuning.fold_count);
  }
  if(v6Tuning.selected_candidate_qualified){
    assert.equal(v6Tuning.candidate_grid.find(candidate=>
      candidate.temporal_block_count===v6Tuning.selected_temporal_block_count&&
      candidate.l2===v6Tuning.selected_l2)?.all_epoch_checkpoints_selected,true);
  }

  assert.equal(v6Tuning.schema,
    'RADARX_TCN_LSTM_ORDERED_RANKER_INTERNAL_PURGED_EXPANDING_VALIDATION_V6');
  assert.equal(v6Tuning.selected_candidate_qualified,
    v6Tuning.fold_stable_dual_metric_candidate_count>0);
  assert.equal(v6Tuning.robustness_status,v6Tuning.selected_candidate_qualified
    ?'FOLD_STABLE_DUAL_LOGISTIC_SUPERIORITY':'ABSTAIN_NO_FOLD_STABLE_DUAL_SUPERIORITY');

  // Simulate Logistic OOF coverage filtering out early rows from the classifier
  // residual fit. The independent ranker remains fitted on the full earlier block.
  const classifierRows=completePartition.slice(8);
  const classifierFitRows=classifierRows.map(({realized_return_pct,...row})=>row);
  const common={
    epochs:1,learningRate:0.0015,l2:0.0005,batchSize:8,
    seed:696225,maxTrainingSamples:classifierFitRows.length,
    rankingRepresentation:'RAW_ORDERED_696_V1',
    rankingPairStrategy:'PROFITABILITY_BOUNDARY_V1',
    rankingPairsPerTimestamp:16,
    rankingRows:null,fitIndependentRankingHead:false
  };
  const withFrozenRanker=trainTcnLstmHybrid(classifierFitRows,{
    ...common,preFittedIndependentRankingHead:ranker
  });
  const classifierOnly=trainTcnLstmHybrid(classifierFitRows,common);
  const rankHead=withFrozenRanker.training.return_ranking.ranking_head;
  assert.equal(rankHead.fitted,true);
  assert.equal(rankHead.training_rows,completePartition.length);
  assert.equal(rankHead.standardization.fit_rows,completePartition.length);
  assert.equal(withFrozenRanker.training.return_ranking.comparison_pairs,ranker.training_pairs);
  assert.equal(withFrozenRanker.training.return_ranking.independent_ranker_fit_mode,
    'FITTED_ONCE_ON_COMPLETE_PRE_EXECUTION_MODEL_TRAINING_PARTITION');
  assert.deepEqual(withFrozenRanker.model.orderedRankingHeadWeights,
    ranker.model_state.orderedRankingHeadWeights);
  assert.deepEqual(withFrozenRanker.model.orderedRankingFeatureMean,
    ranker.model_state.orderedRankingFeatureMean);
  assert.deepEqual(withFrozenRanker.model.orderedRankingFeatureStd,
    ranker.model_state.orderedRankingFeatureStd);

  const withoutRankFields=model=>{
    const copy=structuredClone(model);
    delete copy.rankingRepresentation;
    delete copy.rankingHeadWeights;
    delete copy.rankingFeatureMean;
    delete copy.rankingFeatureStd;
    delete copy.orderedRankingHeadWeights;
    delete copy.orderedRankingFeatureMean;
    delete copy.orderedRankingFeatureStd;
    return copy;
  };
  assert.deepEqual(withoutRankFields(withFrozenRanker.model),withoutRankFields(classifierOnly.model),
    'a pre-fitted independent ranker must not alter any classifier parameter');
  assert.equal(withFrozenRanker.probability_ready,false);
  assert.equal(withFrozenRanker.real_order_execution,false);
});

test('independent return ranker fits only the earlier model-training partition and produces out-of-sample execution-head features',()=>{
  const modelTrainingRows=makeRankedRows(0,12,'ranker-model-fit');
  const executionHeadRows=makeRankedRows(100,12,'ranker-execution-features');
  const fitRows=modelTrainingRows.map(({realized_return_pct,...row})=>row);
  const options={
    epochs:1,learningRate:0.0015,l2:0.001,batchSize:8,
    seed:22441,maxTrainingSamples:fitRows.length,
    rankingRows:modelTrainingRows,fitIndependentRankingHead:true,
    rankingPairStrategy:'PROFITABILITY_BOUNDARY_V1'
  };
  const profile=trainTcnLstmHybrid(fitRows,options);
  const classifierOnly=trainTcnLstmHybrid(fitRows,{
    ...options,fitIndependentRankingHead:false
  });
  const withoutRankFields=model=>{
    const copy=structuredClone(model);
    delete copy.rankingHeadWeights;
    delete copy.rankingFeatureMean;
    delete copy.rankingFeatureStd;
    return copy;
  };
  const ranker=profile.training.return_ranking.ranking_head;
  assert.equal(ranker.fitted,true);
  assert.equal(ranker.fit_boundary,'TRAINING_PARTITION_ONLY');
  assert.equal(ranker.training_rows,modelTrainingRows.length);
  assert.equal(ranker.training_pairs,48);
  assert.equal(profile.training.return_ranking.pair_strategy,'PROFITABILITY_BOUNDARY_V1');
  assert.equal(profile.training.return_ranking.comparison_pairs,48);
  assert.equal(ranker.standardization.fit_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(ranker.standardization.fit_rows,modelTrainingRows.length);
  assert.equal(ranker.classifier_parameters_updated,false);
  assert.equal(ranker.validation_or_holdout_used,false);
  assert.ok(ranker.weight_l2_norm>1e-8);
  assert.deepEqual(withoutRankFields(profile.model),withoutRankFields(classifierOnly.model),
    'fitting the independent rank head must not update temporal classifier parameters');

  const rankerIds=new Set(modelTrainingRows.map(row=>String(row.id)));
  assert.ok(executionHeadRows.every(row=>!rankerIds.has(String(row.id))));
  const rankerMaxResolvedAt=Math.max(...modelTrainingRows.map(row=>row.resolved_at));
  const executionFeatureMinAt=Math.min(...executionHeadRows.map(row=>row.at));
  assert.ok(rankerMaxResolvedAt<executionFeatureMinAt,
    'all ranker labels must resolve before execution-head feature rows begin');

  const row=executionHeadRows[0];
  const externalLogisticLogit=predictTcnLstmLogisticLogit(
    row.sequence,profile.baseline_fit
  );
  const features=buildTcnLstmExecutionHeadInputFeatures(
    row.sequence,profile.model,profile.baseline_fit,{
      variant:'LOGIT_CONTEXT_AUGMENTED',externalLogisticLogit
    }
  );
  const rankingScore=predictTcnLstmHybridRankingScore(row.sequence,profile);
  assert.equal(features.independent_return_rank_score,rankingScore);
  assert.equal(features.normalized_ranking_score,Math.tanh(rankingScore/4));
  assert.ok(Number.isFinite(features.normalized_ranking_score));
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.real_order_execution,false);
});


test('ordered ranker fails closed when no nested Pareto epoch checkpoint is selected',()=>{
  const rows=makeRankedRows(0,30,'constant-feature-no-checkpoint').map(row=>({
    ...row,
    sequence:Array.from({length:24},()=>Array(29).fill(0))
  }));
  const ranker=fitTcnLstmOrderedRankerForTrainingPartition(rows,{
    roundTripCostBps:30,minimumReturnGapPct:0.50,maxPairsPerTimestamp:16,
    learningRate:0.03,epochs:2,l2:0.001,patience:1,
    l2Grid:[0.001,0.01],temporalBlockCounts:[1,2]
  });
  const tuning=ranker.training.internal_training_validation;
  assert.equal(tuning.method,
    'THREE_FOLD_NESTED_PARETO_CHECKPOINT_REQUIRED_LOGISTIC_ANCHORED_VALIDATION_V3');
  assert.equal(tuning.selected_candidate_qualified,false);
  assert.equal(tuning.fold_stable_dual_metric_superiority,false);
  assert.equal(tuning.fold_stable_dual_metric_candidate_count,0);
  assert.ok(tuning.candidate_grid.length>=4);
  for(const candidate of tuning.candidate_grid){
    assert.equal(candidate.epoch_checkpoint_selected_count,0);
    assert.equal(candidate.all_epoch_checkpoints_selected,false);
    assert.deepEqual(candidate.fold_results.map(fold=>fold.epoch_checkpoint_selected),
      [false,false,false]);
  }
  const rankHead={
    schema:'RADARX_TCN_LSTM_INDEPENDENT_ORDERED_696_RETURN_RANKER_V1',
    representation:'RAW_ORDERED_696_V1',
    internal_training_validation:tuning
  };
  assert.equal(hasFoldStableOrderedRankerQualification(rankHead,'RAW_ORDERED_696_V1'),false);
});
