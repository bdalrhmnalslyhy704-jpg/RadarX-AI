import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TCN_LSTM_HYBRID_SCHEMA,
  TCN_LSTM_PARAMETER_COUNT,
  TCN_LSTM_STEPS,
  TCN_LSTM_INPUT_CHANNELS,
  buildTcnLstmAnchorFeatures,
  fitTcnLstmLogisticAnchor,
  inspectTcnLstmForward,
  lossAndGradientsTcnLstmHybrid,
  auditTcnLstmHybridGradients,
  trainTcnLstmHybrid,
  predictTcnLstmHybridProbability,
  selectTcnLstmHybridHyperparameters,
  benchmarkTcnLstmHybridChronological,
  benchmarkTcnLstmHybridInference,
  createTcnLstmHybridModelForAudit
} from '../core/temporal-lstm-hybrid.mjs';

const DAY=86400000;
const BASE=1_780_000_000_000;

function makeSequence(direction=1,seed=0){
  return Array.from({length:TCN_LSTM_STEPS},(_,time)=>
    Array.from({length:TCN_LSTM_INPUT_CHANNELS},(_,feature)=>{
      const drift=direction*(feature===0?0.8:feature===7?0.35:0.08);
      const wave=Math.sin((time+1)*(feature+1)*0.09+seed)*0.12;
      return Math.max(-3.5,Math.min(3.5,drift+wave));
    })
  );
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
      sequence:makeSequence(target?1:-1,absolute*0.017),
      temporal_sequence_timestamps:Array.from({length:24},(_,step)=>
        at-(23-step)*900000)
    };
  });
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
      {name:'MID_RATE',learningRate:0.0025,l2:0.0015,epochs:2}
    ],
    requiredImprovement:0.00025,seed:7,maxTrainingSamples:40
  });
  assert.equal(result.training_support.rows,40);
  assert.equal(result.selection_support.rows,20);
  assert.equal(result.candidates.length,2);
  assert.ok(result.candidates.every(row=>
    Number.isFinite(row.selection_brier)&&Number.isFinite(row.logistic_selection_brier)));
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

test('inference latency is measured without asserting a hardware-specific promise',()=>{
  const rows=makeRows(0,32);
  const profile=trainTcnLstmHybrid(rows,{epochs:1,learningRate:0.0015,l2:0.001,batchSize:8});
  const result=benchmarkTcnLstmHybridInference(rows[0].sequence,profile,{warmup:2,iterations:10});
  assert.ok(result.p50_ms>=0);
  assert.ok(result.p95_ms>=result.p50_ms);
  assert.equal(result.production_latency_claim,false);
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
  assert.ok(result.partition_support.validation.rows>=20);
  assert.ok(result.partition_support.holdout.rows>=20);
  assert.equal(result.inner_selection_diagnostics.validation_or_holdout_used_for_fit_or_selection,false);
  assert.equal(result.validation.evaluated,true);
  assert.equal(result.holdout.evaluated,true);
  assert.equal(result.validation.sample_count,result.partition_support.validation.rows);
  assert.equal(result.holdout.sample_count,result.partition_support.holdout.rows);
  assert.equal(result.validation.required_improvement,0.003);
  assert.equal(result.holdout.required_improvement,0.003);
  assert.equal(result.probability_ready,false);
  assert.equal(result.live_eligibility_ready,false);
  assert.equal(result.real_order_execution,false);
});

test('full TCN-LSTM benchmark rejects datasets with overlapping label maturity across partitions',()=>{
  const rows=makeRows(0,100*4,'purge');
  // Move a training outcome beyond the selection boundary while preserving its
  // baseline identity and its temporal sequence cadence.
  const changed=rows.map(row=>({...row}));
  changed.find(row=>row.id==='purge-0').resolved_at=BASE+64*DAY;
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
