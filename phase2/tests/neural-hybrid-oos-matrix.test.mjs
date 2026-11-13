import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBrierMatrixReport,renderBrierTable} from '../tools/neural-hybrid-oos-matrix.mjs';

const goodMetric=(model,logistic)=>({
  evaluated:true,sample_count:100,model_brier_score:model,
  same_window_logistic_brier_score:logistic
});
const makeTarget=()=>({
  target_pct:5,
  neural_network:{
    selected:true,
    inner_selection_diagnostics:{passed:true,best_candidate:{brier_score:0.10},
      logistic_baseline_brier_score:0.1005},
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    validation_comparison:{same_window_logistic_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    holdout_comparison:{same_window_logistic_brier_score:0.084}
  },
  boosted_tree_model:{
    selected:true,
    candidate_selection_metrics:[{selection_beats_same_window_logistic:true,
      selection_brier_score:0.10,selection_logistic_brier_score:0.1005}],
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    same_window_logistic_validation:{model_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    same_window_logistic_holdout:{model_brier_score:0.084}
  },
  hybrid_model:{
    selected:true,
    candidate_selection_metrics:[{selection_beats_same_window_logistic:true,
      selection_brier_score:0.10,selection_logistic_brier_score:0.1005}],
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    holdout_comparison:{same_window_logistic_brier_score:0.084}
  },
  temporal_tcn:{
    selected:true,
    selection:{model_brier_score:0.10,logistic_brier_score:0.1005},
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09,
      pooled_logistic_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08,
      pooled_logistic_brier_score:0.084}
  },
  temporal_regime_local_tcn_challenger:{
    selected:true,selection:{model_brier_score:0.10,logistic_brier_score:0.1005},
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    validation_logistic:{evaluated:true,sample_count:100,model_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    holdout_logistic:{evaluated:true,sample_count:100,model_brier_score:0.084}
  },
  temporal_regime_local_tcn_pyramid_challenger:{
    selected:true,selection:{model_brier_score:0.10,logistic_brier_score:0.1005},
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    validation_logistic:{evaluated:true,sample_count:100,model_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    holdout_logistic:{evaluated:true,sample_count:100,model_brier_score:0.084}
  },
  temporal_regime_local_tcn_multiscale_challenger:{
    selected:true,selection:{model_brier_score:0.10,logistic_brier_score:0.1005},
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    validation_logistic:{evaluated:true,sample_count:100,model_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    holdout_logistic:{evaluated:true,sample_count:100,model_brier_score:0.084}
  },
  temporal_regime_local_tcn_attention_challenger:{
    selected:true,selection:{model_brier_score:0.10,logistic_brier_score:0.1005},
    validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
    validation_logistic:{evaluated:true,sample_count:100,model_brier_score:0.094},
    holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
    holdout_logistic:{evaluated:true,sample_count:100,model_brier_score:0.084}
  }
});
const hybridTcnReport={selected:true,input_sha256:'a'.repeat(64),
  target_results:{
    '5':{selected:true,validation:{evaluated:true,sample_count:100,model_brier_score:0.09},
      validation_logistic:{model_brier_score:0.094},
      holdout:{evaluated:true,sample_count:100,model_brier_score:0.08},
      holdout_logistic:{model_brier_score:0.084},
      selection:{model_brier_score:0.10,logistic_brier_score:0.1005}}
  }
};

test('matrix enforces strict margins at selection, external validation and untouched holdout',()=>{
  const daily={status:'COMPLETED_RESEARCH_ONLY',input_sha256:'a'.repeat(64),
    target_results:{'5_PCT_FIRST_PASSAGE_24H':makeTarget()}};
  const report=buildBrierMatrixReport(daily,{hybridTcnReport,requiredTargets:[5]});
  const row=report.rows.find(item=>item.family==='MLP_V5');
  assert.equal(row.inner_selection.passed,true);
  assert.equal(row.external_validation.passed,true);
  assert.equal(row.untouched_final_holdout.passed,true);
  assert.equal(report.source_integrity.same_input_sha256,true);
  assert.equal(report.overall_status,'HISTORICAL_ALL_FAMILY_GATES_PASSED_FORWARD_SHADOW_STILL_REQUIRED');
  assert.equal(report.promotion_eligible,true);
  assert.match(renderBrierTable(report),/MLP_V5/);
});

test('missing Brier evidence is never inferred from PnL or base-rate metrics',()=>{
  const daily={status:'COMPLETED_RESEARCH_ONLY',input_sha256:'a'.repeat(64),
    target_results:{'5_PCT_FIRST_PASSAGE_24H':{target_pct:5,neural_network:{validation:{evaluated:false}}}}};
  const report=buildBrierMatrixReport(daily,{requiredTargets:[5]});
  const row=report.rows.find(item=>item.family==='MLP_V5');
  assert.equal(row.external_validation.evaluated,false);
  assert.equal(row.historical_gate_status,'VALIDATION_BRIER_UNAVAILABLE');
  assert.equal(report.promotion_eligible,false);
});

test('same-window holdout Brier must clear 0.003 strictly, not equal it',()=>{
  const target=makeTarget();
  target.neural_network.holdout.model_brier_score=0.081;
  target.neural_network.holdout_comparison.same_window_logistic_brier_score=0.084;
  const report=buildBrierMatrixReport({input_sha256:'a'.repeat(64),
    target_results:{'5_PCT_FIRST_PASSAGE_24H':target}},{
      hybridTcnReport,requiredTargets:[5]
    });
  const row=report.rows.find(item=>item.family==='MLP_V5');
  assert.ok(Math.abs(row.untouched_final_holdout.improvement-0.003)<1e-12);
  assert.equal(row.untouched_final_holdout.passed,false);
});

test('family-wide approval requires all requested horizons and a uniform source hash',()=>{
  const t5=makeTarget(),t10=makeTarget();t10.target_pct=10;
  const daily={input_sha256:'a'.repeat(64),target_results:{
    '5_PCT_FIRST_PASSAGE_24H':t5,'10_PCT_FIRST_PASSAGE_24H':t10
  }};
  const report=buildBrierMatrixReport(daily,{
    hybridTcnReport,requiredTargets:[5,10,15]
  });
  assert.equal(report.promotion_eligible,false);
  assert.equal(report.target_coverage.find(x=>x.target_pct===15).present,false);
});
