import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  validateAndPrepareDense24hRows,
  splitDense24hChronologically,
  fitDenseStandardizer,
  fitDenseLogisticAnchor,
  fitDenseGeneralizationProjection,
  predictDenseProjectionProbability,
  evaluateDenseProjectionSplit
} from '../core/dense-generalization-projection.mjs';

const DAY=24*60*60*1000;
const START=Date.UTC(2025,0,1);
const labelSource='BINANCE_OFFICIAL_CLOSED_15M_SAFE_FIRST_TOUCH_HORIZONS_V1';
const targetDefinition='FIRST_TOUCH_PLUS_5_PCT_BEFORE_MINUS_2_PCT_WITHIN_24H_15M_V1';

function makeSample(symbol,day,index,{outcome='UP',status='RESOLVED',badCutoff=false}={}) {
  const at=START+day*DAY+index*60_000;
  return {
    id:symbol+':'+at,symbol,at,resolved_at:at+DAY,horizon_ms:DAY,
    quote_volume_24h:1_250_000,liquidity_lane:'STANDARD_750K_PLUS',
    feature_information_cutoff_at:badCutoff?at-1:at,
    observation_source:'BINANCE_OFFICIAL_CLOSED_15M_BASELINE',
    features:{
      volume_ratio:1.8+(index%3)*0.2,trade_ratio:1.4,taker_buy_ratio:0.56+(index%2)*0.03,
      compression_ratio:0.72,relative_strength_vs_btc_pct:0.8,
      recent_15m_return_pct:0.3,higher_low:true,breakout_above_prior_high:false,
      trend_aligned:true,return_30m_pct:0.5,hourly_return_pct:1.1,
      return_3h_pct:1.8,btc_hourly_return_pct:0.2,daily_change_pct:2,
      relative_strength_vs_btc_24h_pct:1.2,breakout_distance_pct:0.4,
      current_range_pct:2,lower_wick_pct:0.8,micro_5m_available:true,
      micro_5m_taker_buy_ratio:0.61,micro_5m_volume_ratio:1.5,
      micro_5m_trade_ratio:1.3,micro_5m_return_pct:0.2,micro_5m_close_location:0.7
    },
    safe_opportunity_targets:{
      '24h':{plus_5_pct:{
        status,outcome,horizon_ms:DAY,target_definition:targetDefinition,
        outcome_source:labelSource,resolved_at:at+DAY
      }}
    }
  };
}
function makeCohort(){
  const samples=[];
  for(let day=0;day<100;day++)for(let symbolIndex=0;symbolIndex<11;symbolIndex++){
    const outcome=(day+symbolIndex)%2===0?'UP':((day+symbolIndex)%4===1?'DOWN':'FLAT');
    samples.push(makeSample('PAIR'+symbolIndex+'USDT',day,symbolIndex,{outcome}));
  }
  samples.push(makeSample('AMBIGUOUSUSDT',50,20,{outcome:'AMBIGUOUS',status:'AMBIGUOUS'}));
  return samples;
}
function makeReport(samples,sha){
  return {
    status:'READY',
    data_quality:{
      all_sample_audits_ready:true,no_overlapping_daily_labels:true,
      feature_cutoff_violations:0,horizon_violations:0,symbols_failed:0,
      symbols_incomplete_archive:0,archive_coverage_after_first_available_pct:100
    },
    sample_file:{rows:samples.length,sha256:sha}
  };
}

test('dense cohort enforces SHA, target contract, cutoff, liquidity and ambiguity exclusion',()=>{
  const samples=makeCohort();
  const bytes=Buffer.from(samples.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const sha=createHash('sha256').update(bytes).digest('hex');
  const report=makeReport(samples,sha);
  const prepared=validateAndPrepareDense24hRows(samples,report,sha);
  assert.equal(prepared.raw_rows,1101);
  assert.equal(prepared.resolved_training_rows,1100);
  assert.equal(prepared.ambiguous_rows,1);
  assert.equal(prepared.under_floor_rows,0);
  assert.equal(prepared.raw_sample_sha256,sha);
  assert.equal(prepared.rows[0].vector.length,35);
  assert.equal(prepared.rows.every(row=>row.target===0||row.target===1),true);
  assert.throws(()=>validateAndPrepareDense24hRows(samples,report,'0'.repeat(64)),
    /DENSE24_RAW_SHA_OR_ROW_COUNT_MISMATCH/);
  const bad=samples.map(row=>({...row}));
  bad[0].feature_information_cutoff_at=bad[0].at-1;
  const badBytes=Buffer.from(bad.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const badSha=createHash('sha256').update(badBytes).digest('hex');
  assert.throws(()=>validateAndPrepareDense24hRows(bad,makeReport(bad,badSha),badSha),
    /DENSE24_FEATURE_CUTOFF_MISMATCH/);
});

test('chronological partitions purge the complete 24h target path at every boundary',()=>{
  const samples=makeCohort();
  const bytes=Buffer.from(samples.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const sha=createHash('sha256').update(bytes).digest('hex');
  const rows=validateAndPrepareDense24hRows(samples,makeReport(samples,sha),sha).rows;
  const split=splitDense24hChronologically(rows);
  assert.ok(split.train.length>500);
  assert.ok(split.selection.length>=100);
  assert.ok(split.validation.length>=100);
  assert.ok(split.holdout.length>=100);
  assert.ok(split.purged_rows>0);
  const parts=[split.train,split.selection,split.validation,split.holdout];
  for(let i=1;i<parts.length;i++){
    const priorMax=parts[i-1].reduce((v,row)=>Math.max(v,row.resolved_at),-Infinity);
    const nextMin=parts[i].reduce((v,row)=>Math.min(v,row.at),Infinity);
    assert.ok(priorMax<nextMin);
  }
});

test('projection uses train-only scaling, deterministic dropout and finite inference',()=>{
  const rows=[];
  for(let day=0;day<100;day++)for(let symbol=0;symbol<12;symbol++){
    const vector=Array.from({length:35},(_,feature)=>
      Math.sin((day+1)*(feature+2)*0.013)+Math.cos((symbol+3)*(feature+1)*0.07));
    const signal=vector[2]*vector[11]+vector[5]-vector[17]*vector[4];
    rows.push({
      id:day+':'+symbol,symbol:'S'+symbol,at:START+day*DAY+symbol*1000,
      resolved_at:START+day*DAY+symbol*1000+DAY,
      vector,target:signal>0?1:0,outcome:signal>0?'UP':'DOWN'
    });
  }
  const split=splitDense24hChronologically(rows);
  const scaler=fitDenseStandardizer(split.train);
  assert.equal(scaler.fit_boundary,'TRAIN_ONLY');
  const anchor=fitDenseLogisticAnchor(split.train,scaler,{iterations:120});
  const fit=fitDenseGeneralizationProjection(split.train,anchor,scaler,{
    dropout:0.20,l2:0.06,rank:4,hidden:8,epochs:10,seed:17
  });
  const first=predictDenseProjectionProbability(split.validation[0].vector,fit);
  const second=predictDenseProjectionProbability(split.validation[0].vector,fit);
  assert.ok(Number.isFinite(first)&&first>=0&&first<=1);
  assert.equal(first,second,'inference must be deterministic; dropout is training-only');
  const measured=evaluateDenseProjectionSplit(split.validation,fit,anchor,{bootstrapSeed:11});
  assert.ok(Number.isFinite(measured.model_brier));
  assert.ok(Number.isFinite(measured.logistic_brier));
  assert.equal(measured.required_brier_margin,0.003);
  assert.equal(typeof measured.passed,'boolean');
});

