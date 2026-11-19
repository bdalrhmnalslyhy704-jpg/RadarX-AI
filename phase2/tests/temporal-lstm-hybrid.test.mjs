import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TCN_LSTM_HYBRID_SCHEMA,
  TCN_LSTM_PARAMETER_COUNT,
  TCN_LSTM_STEPS,
  TCN_LSTM_INPUT_CHANNELS,
  TCN_LSTM_RECEPTIVE_FIELD,
  buildTcnLstmAnchorFeatures,
  fitTcnLstmLogisticAnchor,
  inspectTcnLstmForward,
  lossAndGradientsTcnLstmHybrid,
  auditTcnLstmHybridGradients,
  trainTcnLstmHybrid,
  predictTcnLstmHybridProbability,
  predictTcnLstmHybridRankingLogit,
  predictTcnLstmHybridRankingAnchorLogit,
  predictTcnLstmHybridExecutionHeads,
  predictTcnLstmHybridCalibratedProbability,
  fitTcnLstmHybridCalibration,
  splitFourHourTcnLstmTrainingRows,
  selectTcnLstmHybridHyperparameters,
  summarizeTcnLstmSelectionReturns,
  tcnLstmPairwiseReturnRankingLoss,
  tcnLstmPairwiseLogitRankingLoss,
  buildTcnLstmReturnRankingPairs,
  summarizeTcnLstmPairwiseReturnRanking,
  summarizeTcnLstmPairwiseLogitRanking,
  summarizeTcnLstmRankingExecutionSelection,
  benchmarkTcnLstmHybridChronological,
  evaluateTcnLstmHybridGeneralization,
  benchmarkTcnLstmHybridInference,
  createTcnLstmHybridModelForAudit,
  effectiveTcnLstmTrainingSampleBudget,
  TCN_LSTM_MAX_TRAINING_SAMPLES
} from '../core/temporal-lstm-hybrid.mjs';
import { topKRankingSignals,compareTcnLstmRankingExecutionMetrics } from '../core/neural-closure-contracts.mjs';

const DAY=86400000;
const BASE=1_780_000_000_000;

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
  const rows=Array.from({length:24*4},(_,index)=>{
    const group=Math.floor(index/4),rank=index%4;
    const at=BASE+group*DAY+rank*75;
    const execution=makeExecutionRow(index,rank<2?'UP':'DOWN',at);
    return {...execution,sequence:makeSequence(rank<2?1:-1,index*0.01)};
  });
  const head=rows.map((_,index)=>[4,3,-3,-4][index%4]);
  const anchor=rows.map((_,index)=>[-4,-3,3,4][index%4]);
  const passed=summarizeTcnLstmRankingExecutionSelection(rows,head,anchor,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,maximumDrawdownPct:8
  });
  assert.equal(passed.status,'EVALUATED');
  assert.equal(passed.source_partition,'INNER_SELECTION_ONLY');
  assert.equal(passed.passed,true);
  assert.ok(passed.top_k_trials.some(item=>item.risk_gates_passed));
  const rejected=summarizeTcnLstmRankingExecutionSelection(rows,head,head,{
    roundTripCostBps:30,minimumTrades:20,minimumWinRatePct:55,maximumDrawdownPct:8
  });
  assert.equal(rejected.passed,false);
  assert.ok(rejected.top_k_trials.every(item=>
    item.risk_gates.beats_logistic_anchor===false));
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
  model.rankingHeadWeights=Array(before.cache.pooled.length).fill(1.5);
  const after=inspectTcnLstmForward(sequence,model,baselineLogit);
  assert.equal(after.probability,before.probability);
  assert.equal(after.logit,before.logit);
  assert.notEqual(after.ranking_logit,before.ranking_logit);
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

test('TCN-LSTM fits separate net-return and downside regression heads on training outcomes only',()=>{
  const evidence=makeRankedRows(0,10,'execution-train').map((row,index)=>({
    ...row,
    max_adverse_excursion_pct:index%4===0?-0.35:index%4===1?-0.75:
      index%4===2?-1.4:-2.1,
    max_adverse_excursion_at:row.at+60*60*1000
  }));
  const fitRows=evidence.map(({realized_return_pct,...row})=>row);
  const profile=trainTcnLstmHybrid(fitRows,{
    epochs:1,learningRate:0.0015,l2:0.0005,batchSize:8,
    seed:771,maxTrainingSamples:40,rankingRows:evidence,executionRows:evidence,
    rankingHeadEpochs:12,executionHeadEpochs:20,
    executionHeadRoundTripCostBps:30
  });
  assert.equal(profile.training.execution_regression_heads.fitted,true);
  assert.equal(profile.training.execution_regression_heads.fit_boundary,'TRAINING_PARTITION_ONLY');
  assert.equal(profile.training.execution_regression_heads.validation_or_holdout_used,false);
  assert.equal(profile.training.execution_regression_heads.round_trip_cost_bps,30);
  const prediction=predictTcnLstmHybridExecutionHeads(evidence[0].sequence,profile);
  assert.ok(Number.isFinite(prediction.predicted_net_return_pct));
  assert.ok(Number.isFinite(prediction.predicted_downside_risk_pct));
  assert.ok(prediction.predicted_downside_risk_pct>=0);
  assert.equal(profile.real_order_execution,false);
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
  assert.equal(profile.training.return_ranking.method,'SEPARATE_AUXILIARY_PAIRWISE_LOGIT_RESIDUAL_HEAD_V1');
  assert.equal(profile.training.return_ranking.source_partition,'TRAINING_PARTITION_ONLY');
  assert.equal(profile.training.return_ranking.comparison_pairs,10);
  assert.equal(profile.training.return_ranking.ranking_labels_seen_outside_training_partition,false);
  assert.equal(profile.training.return_ranking.classifier_parameters_updated_by_ranking_head,false);
  assert.equal(profile.training.return_ranking.ranking_head.fitted,true);
  assert.ok(profile.training.return_ranking.ranking_head.final_pairwise_log_loss<
    profile.training.return_ranking.ranking_head.initial_pairwise_log_loss);
  assert.ok(profile.model.rankingHeadWeights.some(value=>Math.abs(value)>0));
  const rankingLogit=predictTcnLstmHybridRankingLogit(rows[0].sequence,profile);
  const anchorLogit=predictTcnLstmHybridRankingAnchorLogit(rows[0].sequence,profile);
  assert.ok(Number.isFinite(rankingLogit));
  assert.ok(Number.isFinite(anchorLogit));
  assert.notEqual(rankingLogit,anchorLogit);
  assert.ok(Number.isFinite(profile.final_training_pairwise_rank_loss));
  assert.equal(profile.probability_ready,false);
  assert.equal(profile.real_order_execution,false);
});

test('TCN-LSTM inner selector scores pairwise ranking on its own purged selection partition',()=>{
  const trainingRows=makeRankedRows(0,10,'selector-train');
  const selectionRows=makeRankedRows(20,10,'selector-selection');
  const result=selectTcnLstmHybridHyperparameters(trainingRows,selectionRows,{
    requiredImprovement:0.00025,maxTrainingSamples:40,seed:131,
    roundTripCostBps:30,rankingScoreWeight:0.01,
    rankingMinimumReturnGapPct:0.5,rankingPairsPerTimestamp:4,
    candidates:[
      {name:'BRIER_ONLY',learningRate:0.0015,l2:0.0005,dropout:0,epochs:1},
      {name:'PAIRWISE_RANK',learningRate:0.0015,l2:0.0005,dropout:0,epochs:1,rankingWeight:0.02}
    ]
  });
  assert.equal(result.baseline.pairwise_ranking.status,'AVAILABLE');
  assert.equal(result.baseline.pairwise_ranking.comparison_pairs,10);
  assert.equal(result.selection_scoring.ranking_uses_inner_selection_partition_only,true);
  assert.equal(result.selection_scoring.outer_validation_or_holdout_used,false);
  assert.equal(result.candidates.length,2);
  assert.ok(result.candidates.every(item=>item.pairwise_ranking.status==='AVAILABLE'));
  assert.ok(result.candidates.every(item=>item.ranking_head?.fitted===true));
  assert.ok(result.candidates.every(item=>Number.isFinite(item.ranking_probability_blend_weight)));
  assert.ok(result.candidates.every(item=>item.ranking_blend_search.length===7));
  assert.equal(result.selection_scoring.method,'INNER_RETURN_SCREENED_BRIER_PLUS_FROZEN_RANKING_LOGIT_BLEND_AND_PAIRWISE_RANK_V2');
  assert.ok(result.candidates.every(item=>item.logistic_pairwise_ranking.holdout_values_used===false));
  assert.ok(result.candidates.every(item=>
    item.ranking_execution_selection.status==='UNAVAILABLE'&&
    item.ranking_head_selection_qualified===false));
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

test('hyper-parameter selection uses only a purged chronological inner-selection block',()=>{
  const training=makeRows(0,40,'train');
  const selection=makeRows(41,20,'selection');
  const result=selectTcnLstmHybridHyperparameters(training,selection,{
    candidates:[
      {name:'LOW_RATE',learningRate:0.0015,l2:0.0005,epochs:2},
      {name:'MID_RATE',learningRate:0.0025,l2:0.0015,dropout:0.10,epochs:2}
    ],
    requiredImprovement:0.00025,seed:7,maxTrainingSamples:40
  });
  assert.equal(result.training_support.rows,40);
  assert.equal(result.selection_support.rows,20);
  assert.equal(result.candidates.length,2);
  assert.ok(result.candidates.every(row=>
    Number.isFinite(row.selection_brier)&&Number.isFinite(row.logistic_selection_brier)));
  assert.equal(result.candidates.find(row=>row.name==='MID_RATE').config.dropout,0.10);
  assert.ok(result.candidates.every(row=>
    row.return_selection_diagnostics.status==='AVAILABLE'&&
    row.return_selection_diagnostics.selection_partition_only===true));
  assert.ok(result.candidates.every(row=>
    row.return_selection_diagnostics.affects_candidate_ranking===true&&
    row.return_selection_diagnostics.affects_acceptance_gates===true));
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
    assert.equal(result.holdout.evaluated,result.validation.passed);
    assert.equal(result.validation.sample_count,result.partition_support.validation.rows);
    if(result.validation.passed){
      assert.equal(result.holdout.sample_count,result.partition_support.holdout.rows);
      assert.equal(result.holdout.required_brier_improvement,0.003);
    }else{
        }
    assert.equal(result.validation.required_brier_improvement,0.003);
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
  assert.equal(result.validation.evaluated,false);
  assert.equal(result.validation.passed,false);
  assert.equal(result.holdout.evaluated,false);
  assert.equal(result.holdout.reason,'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES');
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


test('recurrent training budget uses up to 4,096 available training rows without touching later partitions',()=>{
  assert.equal(TCN_LSTM_MAX_TRAINING_SAMPLES,4096);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(4096,36102),4096);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(4096,1200),1200);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(512,36102),512);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(8192,36102),4096);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(4096,20),20);
  assert.equal(effectiveTcnLstmTrainingSampleBudget(undefined,36102),4096);
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
