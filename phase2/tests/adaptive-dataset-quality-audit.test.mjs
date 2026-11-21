import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_DATASET_SUPPORT_POLICY,
  buildAdaptiveDatasetQualityAudit,
  retainBalancedAdaptiveSamples
} from '../core/adaptive-dataset-quality-audit.mjs';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 8, 1, 0, 0, 0);

function makeSample({symbol='TESTUSDT',index=0,at=BASE,outcome='DOWN',regime='BTC_RISK_ON'}={}) {
  const sequence=Array.from({length:24},()=>Array(29).fill(0));
  sequence[23][19]=regime==='BTC_RISK_ON'?0.5:-0.5;
  sequence.forEach(step=>{step[28]=1;});
  return {
    id:symbol+':'+at+':'+index,
    symbol,price:1,at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
    training_eligible:true,closed_candle_baseline:true,historical_baseline:false,
    target_definition:'FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_15M_V2',
    outcome_source:'CLOSED_CANDLE_4H_FIRST_PASSAGE_V1',
    outcome,return_pct:outcome==='UP'?3:outcome==='DOWN'?-2:0,
    first_passage:{outcome,path_resolution:'15M'},
    temporal_sequence:sequence
  };
}

function passingTemporalProfile(){
  const phases={
    training:{samples:350,positive:50,negative:300},
    member_selection:{samples:85,positive:25,negative:60},
    calibration:{samples:85,positive:25,negative:60},
    validation:{samples:85,positive:25,negative:60},
    holdout:{samples:140,positive:40,negative:100}
  };
  return {
    regime_specialists:Object.fromEntries(['BTC_RISK_ON','BTC_RISK_OFF'].map(regime=>[
      regime,{
        training_samples:phases.training.samples,
        training_positive_samples:phases.training.positive,
        training_negative_samples:phases.training.negative,
        pooled_selection_diagnostic_samples:phases.member_selection.samples,
        pooled_selection_diagnostic_positive_samples:phases.member_selection.positive,
        pooled_selection_diagnostic_negative_samples:phases.member_selection.negative,
        selection_samples:phases.member_selection.samples,
        local_selection_samples:phases.member_selection.samples,
        pooled_calibration_diagnostic_samples:phases.calibration.samples,
        pooled_calibration_diagnostic_positive_samples:phases.calibration.positive,
        pooled_calibration_diagnostic_negative_samples:phases.calibration.negative,
        calibration_samples:phases.calibration.samples,
        calibration_targets:{
          samples:phases.calibration.samples,
          positive:phases.calibration.positive,
          negative:phases.calibration.negative
        },
        validation_samples:phases.validation.samples,
        validation_positive_samples:phases.validation.positive,
        validation_negative_samples:phases.validation.negative,
        holdout_samples:phases.holdout.samples,
        holdout_positive_samples:phases.holdout.positive,
        holdout_negative_samples:phases.holdout.negative
      }
    ]))
  };
}

function broadDataset(){
  const rows=[];
  for(let symbolIndex=0;symbolIndex<40;symbolIndex++){
    const symbol='PAIR'+String(symbolIndex).padStart(3,'0')+'USDT';
    for(let index=0;index<60;index++){
      const day=Math.floor(index/2);
      const hour=(index%2)*8;
      const at=BASE+day*24*60*60*1000+hour*60*60*1000;
      const regime=day%2===0?'BTC_RISK_ON':'BTC_RISK_OFF';
      const outcome=index%2===0?'UP':(index%6===1?'FLAT':'DOWN');
      rows.push(makeSample({symbol,index,at,outcome,regime}));
    }
  }
  return rows;
}

test('dataset audit admits only broad, mature, balanced, matching 15m first-passage support',()=>{
  const rows=broadDataset();
  const now=BASE+31*24*60*60*1000;
  const duplicate={...rows[0]};
  const audit=buildAdaptiveDatasetQualityAudit([...rows,duplicate],{
    temporalProfile:passingTemporalProfile(),now
  });
  assert.equal(audit.schema_version,'RADARX_ADAPTIVE_DATASET_QUALITY_AUDIT_V1');
  assert.equal(audit.data_support_ready,true,JSON.stringify(audit.blocking_reasons));
  assert.equal(audit.status,'MINIMUM_DATA_SUPPORT_PRESENT');
  assert.equal(audit.counts.input_training_rows,2401);
  assert.equal(audit.counts.valid_resolved_rows,2400);
  assert.equal(audit.counts.duplicate_rows,1);
  assert.equal(audit.counts.distinct_symbols,40);
  assert.equal(audit.counts.distinct_utc_days,30);
  assert.equal(audit.counts.positive,1200);
  assert.equal(audit.counts.negative,1200);
  assert.equal(audit.counts.micro_5m_sequence_coverage_pct,100);
  assert.equal(audit.regimes.BTC_RISK_ON.samples,1200);
  assert.equal(audit.regimes.BTC_RISK_OFF.samples,1200);
  assert.equal(audit.regime_phase_support.BTC_RISK_ON.passed,true);
  assert.equal(audit.regime_phase_support.BTC_RISK_ON.phases.calibration.scope,'SHARED_POOLED');
  assert.equal(audit.regime_phase_support.BTC_RISK_ON.phases.calibration.positive,25);
  assert.equal(audit.regime_phase_support.BTC_RISK_ON.phases.member_selection.positive,25);
  assert.equal(audit.policy.real_order_execution,false);
  assert.equal(ADAPTIVE_DATASET_SUPPORT_POLICY.min_distinct_symbols,40);
});

test('short-base Binance Spot pairs remain valid training samples',()=>{
  const rows=[
    makeSample({symbol:'OPUSDT',index:1,at:BASE,outcome:'UP'}),
    makeSample({symbol:'UNIUSDT',index:2,at:BASE+FOUR_HOURS,outcome:'DOWN'}),
    makeSample({symbol:'DOGEUSDT',index:3,at:BASE+2*FOUR_HOURS,outcome:'UP'})
  ];
  const audit=buildAdaptiveDatasetQualityAudit(rows,{
    temporalProfile:null,now:BASE+10*FOUR_HOURS
  });
  assert.equal(audit.counts.valid_resolved_rows,3);
  assert.deepEqual(audit.symbol_coverage.weakest_symbols.map(row=>row.symbol).sort(),
    ['DOGEUSDT','OPUSDT','UNIUSDT']);
  assert.equal(audit.rejection_reasons.INVALID_SPOT_SYMBOL,undefined);
});

test('dataset audit separates missing, malformed, non-finite and out-of-range TCN tensors',()=>{
  const makeBad=(symbol,index,mutation)=>{
    const row=makeSample({symbol,index,at:BASE+index*FOUR_HOURS,outcome:'DOWN'});
    mutation(row);
    return row;
  };
  const rows=[
    makeBad('MISSUSDT',1,row=>{row.temporal_sequence=null;}),
    makeBad('STEPUSDT',2,row=>{row.temporal_sequence=[];}),
    makeBad('CHANNELUSDT',3,row=>{row.temporal_sequence[0]=row.temporal_sequence[0].slice(0,28);}),
    makeBad('FINITEUSDT',4,row=>{row.temporal_sequence[0][0]=Number.NaN;}),
    makeBad('RANGEUSDT',5,row=>{row.temporal_sequence[0][0]=4.01;})
  ];
  const audit=buildAdaptiveDatasetQualityAudit(rows,{
    temporalProfile:null,now:BASE+20*FOUR_HOURS
  });
  assert.equal(audit.counts.valid_resolved_rows,0);
  assert.equal(audit.counts.sequence_missing_or_invalid_rows,5);
  assert.deepEqual(audit.counts.sequence_quality,{
    missing:1,step_count_invalid:1,channel_count_invalid:1,
    non_finite_value:1,value_out_of_range:1
  });
  assert.equal(audit.rejection_reasons.TEMPORAL_SEQUENCE_MISSING,1);
  assert.equal(audit.rejection_reasons.TEMPORAL_SEQUENCE_VALUE_OUT_OF_RANGE,1);
});

test('dataset fingerprints are stable under input reordering and change when model inputs change',()=>{
  const rows=[
    makeSample({symbol:'HASHXUSDT',index:1,at:BASE,outcome:'UP'}),
    makeSample({symbol:'HASHXUSDT',index:2,at:BASE+FOUR_HOURS,outcome:'DOWN'})
  ];
  const options={temporalProfile:null,now:BASE+20*FOUR_HOURS};
  const first=buildAdaptiveDatasetQualityAudit(rows,options);
  const reordered=buildAdaptiveDatasetQualityAudit(rows.slice().reverse(),options);
  assert.equal(first.fingerprints.sample_identity_sha256,reordered.fingerprints.sample_identity_sha256);
  assert.equal(first.fingerprints.model_input_sha256,reordered.fingerprints.model_input_sha256);
  const changed=rows.map(row=>({...row,temporal_sequence:row.temporal_sequence.map((step,index)=>
    index===23?step.map((value,channel)=>channel===0?value+0.01:value):step)}));
  const modified=buildAdaptiveDatasetQualityAudit(changed,options);
  assert.equal(first.fingerprints.sample_identity_sha256,modified.fingerprints.sample_identity_sha256);
  assert.notEqual(first.fingerprints.model_input_sha256,modified.fingerprints.model_input_sha256);
});

test('sample memory retains training evidence fairly across symbols instead of append-order eviction',()=>{
  const rows=[];
  for(let index=0;index<20;index++)
    rows.push(makeSample({symbol:'AAAUSDT',index,at:BASE+index*1000,outcome:'DOWN'}));
  for(let index=0;index<4;index++)
    rows.push(makeSample({symbol:'BBBUSDT',index,at:BASE+30_000+index*1000,outcome:'DOWN'}));
  rows.push(makeSample({symbol:'CCCUSDT',index:0,at:BASE+40_000,outcome:'UP'}));
  for(let index=0;index<20;index++)
    rows.push({id:'AUDIT:'+index,symbol:'AUDITUSDT',at:BASE+50_000+index,training_eligible:false});
  const retained=retainBalancedAdaptiveSamples(rows,{maxSamples:10,maxTrainingSamples:6});
  const training=retained.filter(row=>row.training_eligible===true);
  const audit=retained.filter(row=>row.training_eligible!==true);
  const symbols=new Set(training.map(row=>row.symbol));
  assert.equal(retained.length,10);
  assert.equal(training.length,6);
  assert.equal(audit.length,4);
  assert.deepEqual([...symbols].sort(),['AAAUSDT','BBBUSDT','CCCUSDT']);
  assert.deepEqual(audit.map(row=>row.id),['AUDIT:16','AUDIT:17','AUDIT:18','AUDIT:19']);
  assert.equal(new Set(retained.map(row=>row.id)).size,retained.length);
});

test('balanced retention preserves early, middle and recent history for each symbol',()=>{
  const rows=[];
  for(const symbol of ['AAAAAUSDT','BBBBBUSDT']){
    for(let index=0;index<100;index++)
      rows.push(makeSample({symbol,index,at:BASE+index*24*60*60*1000,outcome:index%10===0?'UP':'DOWN'}));
  }
  const retained=retainBalancedAdaptiveSamples(rows,{maxSamples:4,maxTrainingSamples:4});
  assert.equal(retained.length,4);
  for(const symbol of ['AAAAAUSDT','BBBBBUSDT']){
    const selected=retained.filter(row=>row.symbol===symbol).map(row=>row.at).sort((a,b)=>a-b);
    assert.deepEqual(selected,[BASE,BASE+99*24*60*60*1000]);
  }
});

test('aggregate sample count cannot hide weak positive support in a model phase',()=>{
  const rows=broadDataset();
  const profile=passingTemporalProfile();
  profile.regime_specialists.BTC_RISK_ON.holdout_positive_samples=3;
  profile.regime_specialists.BTC_RISK_ON.pooled_selection_diagnostic_positive_samples=2;
  const audit=buildAdaptiveDatasetQualityAudit(rows,{
    temporalProfile:profile,now:BASE+31*24*60*60*1000
  });
  assert.equal(audit.counts.valid_resolved_rows,2400);
  assert.equal(audit.data_support_ready,false);
  assert.ok(audit.blocking_reasons.includes('REGIME_PHASE_CLASS_SUPPORT_BELOW_MINIMUM'));
  assert.ok(audit.regime_phase_support.BTC_RISK_ON.gaps.includes('holdout:POSITIVE_SUPPORT'));
  assert.ok(audit.regime_phase_support.BTC_RISK_ON.gaps.includes('member_selection:POSITIVE_SUPPORT'));  assert.equal(audit.regime_phase_support.BTC_RISK_ON.phases.calibration.positive,25,
    'calibration support must come from the shared pooled target diagnostics');
});

test('unresolved, future, mixed-resolution, duplicate and sequence-less rows are excluded fail-closed',()=>{
  const valid=makeSample({symbol:'VALIDUSDT',index:1,at:BASE,outcome:'UP'});
  const future={...makeSample({symbol:'FUTUREUSDT',index:2,at:BASE+1000,outcome:'UP'}),resolved_at:BASE+12*FOUR_HOURS};
  const mixed={...makeSample({symbol:'MIXEDUSDT',index:3,at:BASE+2000,outcome:'UP'}),first_passage:{outcome:'UP',path_resolution:'5M'}};
  const noSequence={...makeSample({symbol:'NOSEQUSDT',index:4,at:BASE+3000,outcome:'DOWN'}),temporal_sequence:[]};
  const noPrice={...makeSample({symbol:'NOPRICEUSDT',index:6,at:BASE+5000,outcome:'DOWN'}),price:0};
  const duplicate={...valid};
  const unresolved={...makeSample({symbol:'PENDINGUSDT',index:5,at:BASE+4000,outcome:'DOWN'}),
    outcome:null,resolved_at:null,first_passage:null,outcome_source:null};
  const audit=buildAdaptiveDatasetQualityAudit([valid,duplicate,future,mixed,noSequence,noPrice,unresolved],{
    temporalProfile:null,now:BASE+10*FOUR_HOURS
  });
  assert.equal(audit.counts.valid_resolved_rows,1);
  assert.equal(audit.counts.duplicate_rows,1);
  assert.equal(audit.counts.sequence_missing_or_invalid_rows,1);
  assert.equal(audit.counts.unresolved_rows,2,
    'both an immature future label and an unlabelled outcome remain unresolved');
  assert.equal(audit.rejection_reasons.OUTCOME_UNAVAILABLE,1);
  assert.equal(audit.rejection_reasons.OUTCOME_NOT_MATURED,1);
  assert.equal(audit.rejection_reasons.FIRST_PASSAGE_LABEL_INVALID,1);
  assert.equal(audit.rejection_reasons.INVALID_BASELINE_PRICE,1);
  assert.equal(audit.data_support_ready,false);
  assert.ok(audit.blocking_reasons.includes('REGIME_PHASE_CLASS_SUPPORT_BELOW_MINIMUM'));
  assert.equal(audit.policy.live_probability_permission,false);
});
