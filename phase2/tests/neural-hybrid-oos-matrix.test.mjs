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
    validation_logistic_brier_score:0.094,
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
  },
  temporal_tcn_lstm_hybrid_challenger:{
    selected_for_research:true,
    status:'HOLDOUT_PASSED_RESEARCH_ONLY_NOT_PRODUCTION_APPROVED',
    inner_selection_diagnostics:{
      status:'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY',
      selected_configuration:'LR_0025_L2_0015_DROP10',
      baseline:{selection_brier:0.1005},
      candidates:[{name:'LR_0025_L2_0015_DROP10',selection_brier:0.10,
        logistic_selection_brier:0.1005,improvement:0.0005,passed_inner_margin:true}]
    },
    validation:{
      evaluated:true,sample_count:100,required_brier_improvement:0.003,
      model:{rows:100,brier:0.09,asymmetric_risk_brier:0.095},
      baseline:{rows:100,brier:0.094,asymmetric_risk_brier:0.096},
      brier_improvement:0.004,
      paired_bootstrap_95ci:{evaluated:true,improvement_ci95_low:0.001},
      passed:true
    },
    holdout:{
      evaluated:true,sample_count:100,required_brier_improvement:0.003,
      model:{rows:100,brier:0.08,asymmetric_risk_brier:0.085},
      baseline:{rows:100,brier:0.084,asymmetric_risk_brier:0.086},
      brier_improvement:0.004,
      paired_bootstrap_95ci:{evaluated:true,improvement_ci95_low:0.001},
      passed:true
    }
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
  assert.equal(report.promotion_eligible,true,JSON.stringify({families:report.family_summary,integrity:report.source_integrity}));
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

test('Brier rows from a different or missing source SHA cannot share an approval matrix',()=>{
  const daily={input_sha256:'a'.repeat(64),
    target_results:{'5_PCT_FIRST_PASSAGE_24H':makeTarget()}};
  const different={...hybridTcnReport,input_sha256:'b'.repeat(64)};
  const report=buildBrierMatrixReport(daily,{hybridTcnReport:different,requiredTargets:[5]});
  assert.equal(report.source_integrity.same_input_sha256,false);
  assert.equal(report.promotion_eligible,false);
});


test('same-cohort TCN-LSTM calibration and external gates are included in the family Brier matrix',()=>{
  const target=makeTarget();
  target.temporal_tcn_lstm_hybrid_challenger={
    selected_for_research:true,
    status:'HOLDOUT_PASSED_RESEARCH_ONLY_NOT_PRODUCTION_APPROVED',
    inner_selection_diagnostics:{
      status:'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY',
      selected_configuration:'LR_0025_L2_0015_DROP10',
      baseline:{selection_brier:0.1005},
      candidates:[
        {name:'LR_0015_L2_0005_DROP00',selection_brier:0.1003,
          logistic_selection_brier:0.1005,improvement:0.0002,passed_inner_margin:false},
        {name:'LR_0025_L2_0015_DROP10',selection_brier:0.1000,
          logistic_selection_brier:0.1005,improvement:0.0005,passed_inner_margin:true}
      ]
    },
    validation:{
      evaluated:true,sample_count:100,required_brier_improvement:0.003,
      model:{rows:100,brier:0.090,asymmetric_risk_brier:0.100},
      baseline:{rows:100,brier:0.094,asymmetric_risk_brier:0.101},
      brier_improvement:0.004,
      paired_bootstrap_95ci:{evaluated:true,improvement_ci95_low:0.001},
      passed:true
    },
    holdout:{
      evaluated:true,sample_count:100,required_brier_improvement:0.003,
      model:{rows:100,brier:0.080,asymmetric_risk_brier:0.095},
      baseline:{rows:100,brier:0.084,asymmetric_risk_brier:0.096},
      brier_improvement:0.004,
      paired_bootstrap_95ci:{evaluated:true,improvement_ci95_low:0.001},
      passed:true
    },
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false
  };
  const report=buildBrierMatrixReport({
    input_sha256:'a'.repeat(64),
    target_results:{'5_PCT_SAFE_OPPORTUNITY_24H':target}
  },{hybridTcnReport,requiredTargets:[5]});
  const row=report.rows.find(item=>item.family==='HYBRID_TCN_LSTM_ATTENTION');
  assert.ok(row,'TCN-LSTM must have its own matrix row');
  assert.equal(row.variant,'CAUSAL_TCN_LSTM_LOCKED_DROPOUT_QUERY_ATTENTION');
  assert.equal(row.inner_selection.passed,true);
  assert.ok(Math.abs(row.inner_selection.improvement-0.0005)<1e-12);
  assert.equal(row.external_validation.passed,true);
  assert.equal(row.external_validation.model_brier,0.09);
  assert.equal(row.external_validation.logistic_brier,0.094);
  assert.equal(row.untouched_final_holdout.passed,true);
  assert.equal(row.untouched_final_holdout.model_brier,0.08);
  assert.equal(row.untouched_final_holdout.logistic_brier,0.084);
  assert.equal(row.production_approved,false);
  const family=report.family_summary.find(item=>item.family==='HYBRID_TCN_LSTM_ATTENTION');
  assert.equal(family.rows,1);
  assert.equal(family.validation_and_holdout_passed_all_targets,true);
});

test('TCN-LSTM Brier matrix keeps a locked holdout unevaluated when external validation fails',()=>{
  const target=makeTarget();
  target.temporal_tcn_lstm_hybrid_challenger={
    selected_for_research:false,
    inner_selection_diagnostics:{
      status:'INNER_SELECTION_QUALIFIED_RESEARCH_ONLY',
      selected_configuration:'LR_0015_L2_0005_DROP00',
      baseline:{selection_brier:0.1005},
      candidates:[{name:'LR_0015_L2_0005_DROP00',selection_brier:0.1000,
        logistic_selection_brier:0.1005,improvement:0.0005,passed_inner_margin:true}]
    },
    validation:{
      evaluated:true,sample_count:100,required_brier_improvement:0.003,
      model:{rows:100,brier:0.100,asymmetric_risk_brier:0.110},
      baseline:{rows:100,brier:0.101,asymmetric_risk_brier:0.109},
      brier_improvement:0.001,passed:false,
      paired_bootstrap_95ci:{evaluated:true,improvement_ci95_low:-0.001}
    },
    holdout:{evaluated:false,reason:'HOLDOUT_LOCKED_UNTIL_VALIDATION_PASSES'},
    probability_ready:false,live_eligibility_ready:false,real_order_execution:false
  };
  const report=buildBrierMatrixReport({
    input_sha256:'a'.repeat(64),
    target_results:{'5_PCT_SAFE_OPPORTUNITY_24H':target}
  },{requiredTargets:[5]});
  const row=report.rows.find(item=>item.family==='HYBRID_TCN_LSTM_ATTENTION');
  assert.ok(row);
  assert.equal(row.external_validation.evaluated,true);
  assert.equal(row.external_validation.passed,false);
  assert.equal(row.untouched_final_holdout.evaluated,false);
  assert.equal(row.historical_gate_status,'HOLDOUT_BRIER_UNAVAILABLE');
  assert.equal(report.promotion_eligible,false);
});
