import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  buildPurgedExpandingLogisticFolds,
  fitTunedTemporalLogisticBaseline,
  predictTemporalLogisticProbability,
  evaluateBinaryProbabilityMetrics
} from '../core/temporal-logistic-baseline.mjs';

function cohort(days=90,rowsPerDay=10){
  const rows=[],vectors=[];
  for(let day=0;day<days;day++){
    for(let slot=0;slot<rowsPerDay;slot++){
      const target=slot%2;
      const at=Date.UTC(2026,0,1)+day*86_400_000+slot*60_000;
      rows.push({
        id:'R'+day+'_'+slot,symbol:'T'+slot,at,
        resolved_at:at+4*60*60_000,target,
        realized_return_pct:target?2.7:-2.1
      });
      vectors.push([
        target?1:-1,
        Math.sin(day/7)+slot/rowsPerDay,
        (day-45)/45
      ]);
    }
  }
  return {rows,vectors};
}

test('expanding folds are chronological, non-overlapping and purge a complete UTC day',()=>{
  const {rows}=cohort();
  const result=buildPurgedExpandingLogisticFolds(rows,{
    foldCount:3,purgeMs:86_400_000,initialTrainingFraction:0.5,
    validationFraction:0.15,minimumTrainingRows:100,
    minimumValidationRows:50,minimumClassCount:5
  });
  assert.equal(result.status,undefined);
  assert.equal(result.fold_count,3);
  assert.equal(result.holdout_used,false);
  for(const fold of result.folds){
    assert.equal(fold.chronological_order_verified,true);
    assert.equal(fold.label_resolution_before_validation_verified,true);
    assert.equal(fold.purge_ms,86_400_000);
    assert.ok(fold.training_period.end_at<fold.validation_period.start_at);
    assert.ok(fold.maximum_training_label_resolved_at<fold.validation_start_at);
    assert.ok(fold.purge_row_count>0);
    assert.ok(fold.training_support.positive>0&&fold.training_support.negative>0);
    assert.ok(fold.validation_support.positive>0&&fold.validation_support.negative>0);
  }
  const firstValidation=new Set(result.folds[0].validation_indices);
  const secondValidation=new Set(result.folds[1].validation_indices);
  assert.equal([...firstValidation].some(index=>secondValidation.has(index)),false);
  assert.ok(result.folds[1].train_indices.length>result.folds[0].train_indices.length);
});

test('CV rejects rows whose outcomes are not matured or whose identities are duplicated',()=>{
  const {rows}=cohort();
  const invalid=[...rows];
  invalid[0]={...invalid[0],resolved_at:invalid[0].at-1};
  assert.throws(()=>buildPurgedExpandingLogisticFolds(invalid),/TEMPORAL_LOGISTIC_CV_ROW_INVALID/);
  const duplicate=[...rows,{...rows[0]}];
  assert.throws(()=>buildPurgedExpandingLogisticFolds(duplicate),/TEMPORAL_LOGISTIC_CV_ROW_INVALID/);
});

test('probability metrics calculate Brier, log loss, PR-AUC and ROC-AUC from aligned labels',()=>{
  const metrics=evaluateBinaryProbabilityMetrics([0.9,0.8,0.1,0.2],[1,0,0,1]);
  assert.equal(metrics.sample_count,4);
  assert.equal(metrics.positive_count,2);
  assert.ok(Math.abs(metrics.brier_score-0.325)<1e-12);
  assert.ok(Math.abs(metrics.pr_auc_average_precision-(5/6))<1e-12);
  assert.ok(Math.abs(metrics.roc_auc-0.75)<1e-12);
  assert.ok(Number.isFinite(metrics.log_loss));
});

test('tuned Logistic selects hyperparameters only on purged train folds then refits on train rows',()=>{
  const {rows,vectors}=cohort();
  const executionCalls=[];
  const result=fitTunedTemporalLogisticBaseline(rows,vectors,{
    foldCount:3,purgeMs:86_400_000,initialTrainingFraction:0.5,
    validationFraction:0.15,minimumTrainingRows:100,
    minimumValidationRows:50,minimumClassCount:5,
    candidateGrid:[
      {l2:0.001,learningRate:0.01},
      {l2:0.1,learningRate:0.01}
    ],
    maxEpochs:60,seed:22429,
    executionEvaluator:(foldRows,probabilities)=>{
      executionCalls.push(foldRows.length);
      return {trade_count:probabilities.filter(value=>value>=0.15).length,
        execution_reference_threshold:0.15};
    }
  });
  assert.equal(result.report.status,'COMPLETE');
  assert.equal(result.report.fold_count,3);
  assert.equal(result.report.training_partition_only,true);
  assert.equal(result.report.outer_validation_rows_used,false);
  assert.equal(result.report.holdout_rows_or_labels_used,false);
  assert.equal(result.report.holdout_opened,false);
  assert.equal(result.report.outer_validation_used_for_hyperparameter_selection,false);
  assert.equal(result.report.execution_metrics_used_for_hyperparameter_selection,false);
  assert.equal(result.report.candidate_results.length,2);
  assert.ok(result.report.selected_configuration.l2===0.001||
    result.report.selected_configuration.l2===0.1);
  assert.equal(executionCalls.length,3);
  assert.ok(result.report.folds.every(fold=>fold.execution_metrics!==null));
  assert.equal(result.model.standardizer.fit_partition,'CURRENT_TRAINING_FOLD_ONLY');
  assert.equal(result.model.standardizer.fit_rows,rows.length);
  const probability=predictTemporalLogisticProbability(vectors[0],result.model);
  assert.ok(probability>0&&probability<1);
});

test('trainer wires tuned Logistic on split.train only and retains legacy fixed reference diagnostics',async()=>{
  const trainer=await readFile(new URL('../tools/train-neural-closure-models.mjs',import.meta.url),'utf8');
  assert.match(trainer,/fitTunedTemporalLogisticBaseline\(\s*split\.train,logisticTrainingVectors/);
  assert.match(trainer,/predictTemporalLogisticProbability/);
  assert.match(trainer,/logistic_baseline_temporal_cv=logisticTuning\.report/);
  assert.match(trainer,/fixedLogisticFit=fitLogisticBaseline\(split\.train\)/);
  assert.match(trainer,/outer_validation_used_for_hyperparameter_selection:false/);
  assert.match(trainer,/holdout_used:false/);
  assert.match(trainer,/threshold:0\.15,roundTripCostBps:args\.roundTripCostBps/);
});
