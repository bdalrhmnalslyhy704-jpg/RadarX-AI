import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_DATASET_SUPPORT_POLICY,
  buildAdaptiveDatasetQualityAudit
} from '../core/adaptive-dataset-quality-audit.mjs';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 8, 1, 0, 0, 0);

function makeSample({symbol='TESTUSDT',index=0,at=BASE,outcome='DOWN',regime='BTC_RISK_ON'}={}) {
  const sequence=Array.from({length:24},()=>Array(29).fill(0));
  sequence[23][19]=regime==='BTC_RISK_ON'?0.5:-0.5;
  sequence.forEach(step=>{step[28]=1;});
  return {
    id:symbol+':'+at+':'+index,
    symbol,at,resolved_at:at+FOUR_HOURS,horizon_ms:FOUR_HOURS,
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
    training:{positive:50,negative:300},
    member_selection:{positive:25,negative:60},
    calibration:{positive:25,negative:60},
    validation:{positive:25,negative:60},
    holdout:{positive:40,negative:100}
  };
  return {
    regime_specialists:Object.fromEntries(['BTC_RISK_ON','BTC_RISK_OFF'].map(regime=>[
      regime,{
        training_positive_samples:phases.training.positive,
        training_negative_samples:phases.training.negative,
        selection_positive_samples:phases.member_selection.positive,
        selection_negative_samples:phases.member_selection.negative,
        calibration_positive_samples:phases.calibration.positive,
        calibration_negative_samples:phases.calibration.negative,
        validation_positive_samples:phases.validation.positive,
        validation_negative_samples:phases.validation.negative,
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
  assert.equal(audit.policy.real_order_execution,false);
  assert.equal(ADAPTIVE_DATASET_SUPPORT_POLICY.min_distinct_symbols,40);
});

test('aggregate sample count cannot hide weak positive support in a model phase',()=>{
  const rows=broadDataset();
  const profile=passingTemporalProfile();
  profile.regime_specialists.BTC_RISK_ON.holdout_positive_samples=3;
  profile.regime_specialists.BTC_RISK_ON.selection_positive_samples=2;
  const audit=buildAdaptiveDatasetQualityAudit(rows,{
    temporalProfile:profile,now:BASE+31*24*60*60*1000
  });
  assert.equal(audit.counts.valid_resolved_rows,2400);
  assert.equal(audit.data_support_ready,false);
  assert.ok(audit.blocking_reasons.includes('REGIME_PHASE_CLASS_SUPPORT_BELOW_MINIMUM'));
  assert.ok(audit.regime_phase_support.BTC_RISK_ON.gaps.includes('holdout:POSITIVE_SUPPORT'));
  assert.ok(audit.regime_phase_support.BTC_RISK_ON.gaps.includes('member_selection:POSITIVE_SUPPORT'));
});

test('unresolved, future, mixed-resolution, duplicate and sequence-less rows are excluded fail-closed',()=>{
  const valid=makeSample({symbol:'VALIDUSDT',index:1,at:BASE,outcome:'UP'});
  const future={...makeSample({symbol:'FUTUREUSDT',index:2,at:BASE+1000,outcome:'UP'}),resolved_at:BASE+1000+FOUR_HOURS+1};
  const mixed={...makeSample({symbol:'MIXEDUSDT',index:3,at:BASE+2000,outcome:'UP'}),first_passage:{outcome:'UP',path_resolution:'5M'}};
  const noSequence={...makeSample({symbol:'NOSEQUSDT',index:4,at:BASE+3000,outcome:'DOWN'}),temporal_sequence:[]};
  const duplicate={...valid};
  const audit=buildAdaptiveDatasetQualityAudit([valid,duplicate,future,mixed,noSequence],{
    temporalProfile:null,now:BASE+10*FOUR_HOURS
  });
  assert.equal(audit.counts.valid_resolved_rows,1);
  assert.equal(audit.counts.duplicate_rows,1);
  assert.equal(audit.counts.sequence_missing_or_invalid_rows,1);
  assert.equal(audit.rejection_reasons.OUTCOME_NOT_MATURED,1);
  assert.equal(audit.rejection_reasons.FIRST_PASSAGE_LABEL_INVALID,1);
  assert.equal(audit.data_support_ready,false);
  assert.ok(audit.blocking_reasons.includes('REGIME_PHASE_CLASS_SUPPORT_BELOW_MINIMUM'));
  assert.equal(audit.policy.live_probability_permission,false);
});
