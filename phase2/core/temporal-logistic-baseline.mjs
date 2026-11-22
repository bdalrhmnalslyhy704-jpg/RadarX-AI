import {fitPlattScaler,applyProbabilityCalibrator} from './neural-closure-contracts.mjs';

const DAY_MS=86_400_000;

const finite=value=>value!==null&&value!==undefined&&value!==''&&
  typeof value!=='boolean'&&Number.isFinite(Number(value));
const sigmoid=value=>1/(1+Math.exp(-Math.max(-35,Math.min(35,value))));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const logLoss=(probability,label)=>{
  const p=clamp(probability,1e-12,1-1e-12);
  return -(label*Math.log(p)+(1-label)*Math.log(1-p));
};
const counts=rows=>{
  const positive=rows.filter(row=>row.target===1).length;
  return {rows:rows.length,positive,negative:rows.length-positive};
};
const average=values=>values.length
  ?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const standardDeviation=values=>{
  if(!values.length)return null;
  const mean=average(values);
  return Math.sqrt(average(values.map(value=>(value-mean)**2)));
};

/**
 * Expanding-window folds built only from the supplied outer-training rows.
 * Each fold has a full UTC-day purge immediately before its validation block.
 * The validation windows do not overlap; later folds may expand their training
 * window through earlier fold periods, as required by rolling-origin CV.
 */
export function buildPurgedExpandingLogisticFolds(rows,{
  foldCount=3,purgeMs=DAY_MS,initialTrainingFraction=0.50,
  validationFraction=0.15,minimumTrainingRows=100,
  minimumValidationRows=50,minimumClassCount=5
}={}) {
  if(!Array.isArray(rows)||rows.length===0||
    !Number.isInteger(foldCount)||foldCount<2||foldCount>6||
    !finite(purgeMs)||Number(purgeMs)<1||
    !finite(initialTrainingFraction)||Number(initialTrainingFraction)<=0||
    !finite(validationFraction)||Number(validationFraction)<=0||
    Number(initialTrainingFraction)+foldCount*Number(validationFraction)>0.98||
    !Number.isInteger(minimumTrainingRows)||minimumTrainingRows<20||
    !Number.isInteger(minimumValidationRows)||minimumValidationRows<10||
    !Number.isInteger(minimumClassCount)||minimumClassCount<1)
    throw new TypeError('TEMPORAL_LOGISTIC_CV_CONFIGURATION_INVALID');

  const identities=new Set();
  const normalized=rows.map((row,index)=>{
    if(!row||!row.id||identities.has(String(row.id))||
      !finite(row.at)||!finite(row.resolved_at)||
      (row.target!==0&&row.target!==1)||
      Number(row.resolved_at)<Number(row.at))
      throw new TypeError('TEMPORAL_LOGISTIC_CV_ROW_INVALID:'+index);
    identities.add(String(row.id));
    return {
      index,at:Number(row.at),resolved_at:Number(row.resolved_at),
      day:Math.floor(Number(row.at)/DAY_MS)*DAY_MS,
      target:row.target
    };
  }).sort((a,b)=>a.at-b.at||String(rows[a.index].id).localeCompare(String(rows[b.index].id)));

  const days=[...new Set(normalized.map(item=>item.day))].sort((a,b)=>a-b);
  if(days.length<Math.ceil(1/(1-Number(initialTrainingFraction)))+foldCount+2)
    throw new Error('TEMPORAL_LOGISTIC_CV_TOO_FEW_UTC_DAYS:'+days.length);

  const folds=[];
  for(let foldIndex=0;foldIndex<foldCount;foldIndex++){
    const startFraction=Number(initialTrainingFraction)+foldIndex*Number(validationFraction);
    const endFraction=startFraction+Number(validationFraction);
    const startIndex=Math.floor(days.length*startFraction);
    const endIndex=Math.min(days.length,Math.floor(days.length*endFraction));
    if(startIndex<2||endIndex<=startIndex)
      throw new Error('TEMPORAL_LOGISTIC_CV_FOLD_BOUNDARY_INVALID:'+foldIndex);

    const validationStartAt=days[startIndex];
    const validationEndAt=endIndex<days.length?days[endIndex]:days.at(-1)+DAY_MS;
    const purgeStartAt=validationStartAt-Number(purgeMs);
    const trainingItems=normalized.filter(item=>item.at<purgeStartAt);
    const purgedItems=normalized.filter(item=>
      item.at>=purgeStartAt&&item.at<validationStartAt);
    const validationItems=normalized.filter(item=>
      item.at>=validationStartAt&&item.at<validationEndAt);
    const training=trainingItems.map(item=>item.index);
    const validation=validationItems.map(item=>item.index);
    const trainingSupport=counts(trainingItems);
    const validationSupport=counts(validationItems);
    const maxTrainingResolvedAt=Math.max(...trainingItems.map(item=>item.resolved_at));

    if(training.length<minimumTrainingRows||
      validation.length<minimumValidationRows||
      trainingSupport.positive<minimumClassCount||
      trainingSupport.negative<minimumClassCount||
      validationSupport.positive<minimumClassCount||
      validationSupport.negative<minimumClassCount)
      throw new Error('TEMPORAL_LOGISTIC_CV_FOLD_SUPPORT_FAILED:'+JSON.stringify({
        fold:foldIndex+1,training:trainingSupport,validation:validationSupport,
        minimumTrainingRows,minimumValidationRows,minimumClassCount
      }));
    if(!(maxTrainingResolvedAt<validationStartAt))
      throw new Error('TEMPORAL_LOGISTIC_CV_LABEL_RESOLUTION_CROSSES_PURGE:'+foldIndex);
    if(training.some(index=>validation.includes(index))||
      purgedItems.some(item=>training.includes(item.index)||validation.includes(item.index)))
      throw new Error('TEMPORAL_LOGISTIC_CV_PARTITION_OVERLAP:'+foldIndex);

    const firstTrainAt=Math.min(...trainingItems.map(item=>item.at));
    const lastTrainAt=Math.max(...trainingItems.map(item=>item.at));
    const firstValidationAt=Math.min(...validationItems.map(item=>item.at));
    const lastValidationAt=Math.max(...validationItems.map(item=>item.at));
    folds.push({
      fold:foldIndex+1,
      schema:'PURGED_EXPANDING_UTC_DAY_ROLLING_ORIGIN_V1',
      train_indices:training,
      validation_indices:validation,
      purge_row_count:purgedItems.length,
      training_period:{start_at:firstTrainAt,end_at:lastTrainAt},
      validation_period:{start_at:firstValidationAt,end_at:lastValidationAt},
      purge_period:{start_at:purgeStartAt,end_at:validationStartAt-1},
      training_support:trainingSupport,
      validation_support:validationSupport,
      maximum_training_label_resolved_at:maxTrainingResolvedAt,
      validation_start_at:validationStartAt,
      validation_end_exclusive_at:validationEndAt,
      purge_ms:Number(purgeMs),
      chronological_order_verified:true,
      label_resolution_before_validation_verified:true
    });
  }

  return {
    schema:'RADARX_PURGED_EXPANDING_LOGISTIC_FOLDS_V1',
    fold_count:folds.length,
    purge_ms:Number(purgeMs),
    day_grouping:'UTC_CALENDAR_DAY',
    training_policy:'EXPANDING_WINDOW_TRAINING_WITH_NON_OVERLAPPING_FORWARD_VALIDATION_BLOCKS',
    holdout_used:false,
    folds
  };
}

function fitStandardizer(vectors) {
  if(!Array.isArray(vectors)||!vectors.length||
    !Array.isArray(vectors[0])||!vectors[0].length)
    throw new TypeError('TEMPORAL_LOGISTIC_FEATURE_MATRIX_EMPTY');
  const width=vectors[0].length;
  if(vectors.some(vector=>!Array.isArray(vector)||vector.length!==width||
    vector.some(value=>!finite(value))))
    throw new TypeError('TEMPORAL_LOGISTIC_FEATURE_MATRIX_INVALID');
  const means=Array(width).fill(0);
  for(const vector of vectors)
    for(let j=0;j<width;j++)means[j]+=Number(vector[j])/vectors.length;
  const scales=Array(width).fill(1);
  for(let j=0;j<width;j++){
    let variance=0;
    for(const vector of vectors)variance+=(Number(vector[j])-means[j])**2/vectors.length;
    const scale=Math.sqrt(variance);
    scales[j]=scale>1e-8?scale:1;
  }
  return {means,scales,fit_rows:vectors.length,fit_partition:'CURRENT_TRAINING_FOLD_ONLY'};
}
function transformVectors(vectors,standardizer) {
  return vectors.map(vector=>vector.map((value,index)=>
    (Number(value)-standardizer.means[index])/standardizer.scales[index]));
}
function fitLogisticWeights(vectors,labels,{l2,learningRate,maxEpochs}={}) {
  if(!Array.isArray(vectors)||!vectors.length||vectors.length!==labels.length||
    !Number.isFinite(l2)||l2<0||!Number.isFinite(learningRate)||
    learningRate<=0||learningRate>0.2||!Number.isInteger(maxEpochs)||maxEpochs<10)
    throw new TypeError('TEMPORAL_LOGISTIC_OPTIMIZER_INPUT_INVALID');
  const width=vectors[0].length;
  if(vectors.some(vector=>vector.length!==width||vector.some(value=>!finite(value)))||
    labels.some(value=>value!==0&&value!==1))
    throw new TypeError('TEMPORAL_LOGISTIC_OPTIMIZER_DATA_INVALID');
  const positives=labels.reduce((sum,value)=>sum+value,0);
  if(positives===0||positives===labels.length)
    throw new Error('TEMPORAL_LOGISTIC_TRAINING_REQUIRES_BOTH_CLASSES');
  const prior=clamp((positives+1)/(labels.length+2),1e-6,1-1e-6);
  const bias=Math.log(prior/(1-prior));
  let intercept=bias;
  const weights=Array(width).fill(0);
  let epochs=0,lastObjective=null,gradientNorm=null;

  for(let epoch=0;epoch<maxEpochs;epoch++){
    const gradient=Array(width).fill(0);
    let biasGradient=0;
    for(let i=0;i<vectors.length;i++){
      let z=intercept;
      for(let j=0;j<width;j++)z+=weights[j]*vectors[i][j];
      const residual=sigmoid(z)-labels[i];
      biasGradient+=residual;
      for(let j=0;j<width;j++)gradient[j]+=residual*vectors[i][j];
    }
    const inverse=1/vectors.length;
    biasGradient*=inverse;
    let squaredNorm=biasGradient*biasGradient;
    for(let j=0;j<width;j++){
      gradient[j]=gradient[j]*inverse+l2*weights[j];
      squaredNorm+=gradient[j]*gradient[j];
    }
    gradientNorm=Math.sqrt(squaredNorm);
    if(!Number.isFinite(gradientNorm)||!Number.isFinite(biasGradient))
      throw new Error('TEMPORAL_LOGISTIC_NON_FINITE_GRADIENT');
    if(gradientNorm<1e-7)break;
    intercept-=learningRate*biasGradient;
    for(let j=0;j<width;j++)weights[j]-=learningRate*gradient[j];
    if(!Number.isFinite(intercept)||weights.some(value=>!Number.isFinite(value)))
      throw new Error('TEMPORAL_LOGISTIC_NON_FINITE_PARAMETERS');
    epochs=epoch+1;
  }

  let objective=0;
  for(let i=0;i<vectors.length;i++){
    let z=intercept;
    for(let j=0;j<width;j++)z+=weights[j]*vectors[i][j];
    objective+=logLoss(sigmoid(z),labels[i])/vectors.length;
  }
  objective+=0.5*l2*weights.reduce((sum,value)=>sum+value*value,0);
  if(!Number.isFinite(objective))throw new Error('TEMPORAL_LOGISTIC_OBJECTIVE_NON_FINITE');
  return {
    weights,bias:intercept,l2,learning_rate:learningRate,
    epochs,max_epochs:maxEpochs,objective,gradient_norm:gradientNorm,
    training_rows:vectors.length,training_positive:positives,
    training_negative:labels.length-positives,
    solver:'FULL_BATCH_GRADIENT_DESCENT',
    class_weighting:'NONE_UNWEIGHTED_PROPER_PROBABILITY_OBJECTIVE'
  };
}

function predictFromScaledVector(vector,fit) {
  if(!Array.isArray(vector)||vector.length!==fit.weights.length||
    vector.some(value=>!finite(value)))
    throw new TypeError('TEMPORAL_LOGISTIC_PREDICTION_VECTOR_INVALID');
  let z=fit.bias;
  for(let j=0;j<vector.length;j++)z+=Number(vector[j])*fit.weights[j];
  return clamp(sigmoid(z),1e-6,1-1e-6);
}
export function predictTemporalLogisticProbability(featureVector,model) {
  if(!model?.standardizer||!model?.fit)
    throw new TypeError('TEMPORAL_LOGISTIC_MODEL_STATE_INVALID');
  const vector=transformVectors([featureVector],model.standardizer)[0];
  return predictFromScaledVector(vector,model.fit);
}

export function evaluateBinaryProbabilityMetrics(probabilities,labels) {
  if(!Array.isArray(probabilities)||!Array.isArray(labels)||
    probabilities.length===0||probabilities.length!==labels.length||
    probabilities.some(value=>!finite(value)||Number(value)<0||Number(value)>1)||
    labels.some(value=>value!==0&&value!==1))
    throw new TypeError('TEMPORAL_LOGISTIC_METRIC_INPUT_INVALID');
  const positives=labels.reduce((sum,value)=>sum+value,0);
  const negatives=labels.length-positives;
  const brier=average(probabilities.map((value,index)=>(Number(value)-labels[index])**2));
  const nll=average(probabilities.map((value,index)=>logLoss(Number(value),labels[index])));
  const scored=probabilities.map((probability,index)=>({
    probability:Number(probability),label:labels[index],index
  }));
  const descending=[...scored].sort((a,b)=>b.probability-a.probability||a.index-b.index);
  let truePositive=0,falsePositive=0,previousRecall=0,prAuc=0,cursor=0;
  while(cursor<descending.length){
    let end=cursor+1;
    while(end<descending.length&&descending[end].probability===descending[cursor].probability)end++;
    for(let i=cursor;i<end;i++){
      if(descending[i].label===1)truePositive++;
      else falsePositive++;
    }
    const recall=positives?truePositive/positives:null;
    const precision=truePositive/(truePositive+falsePositive);
    if(positives)prAuc+=(recall-previousRecall)*precision;
    if(positives)previousRecall=recall;
    cursor=end;
  }
  const ascending=[...scored].sort((a,b)=>a.probability-b.probability||a.index-b.index);
  let positiveRankSum=0;
  cursor=0;
  while(cursor<ascending.length){
    let end=cursor+1;
    while(end<ascending.length&&ascending[end].probability===ascending[cursor].probability)end++;
    const averageRank=((cursor+1)+end)/2;
    for(let i=cursor;i<end;i++)if(ascending[i].label===1)positiveRankSum+=averageRank;
    cursor=end;
  }
  const rocAuc=positives&&negatives
    ?(positiveRankSum-positives*(positives+1)/2)/(positives*negatives):null;
  let tp=0,fp=0,tn=0,fn=0;
  for(let i=0;i<probabilities.length;i++){
    const predicted=Number(probabilities[i])>=0.5?1:0;
    if(predicted===1&&labels[i]===1)tp++;
    else if(predicted===1)fp++;
    else if(labels[i]===0)tn++;
    else fn++;
  }
  const precision=tp+fp?tp/(tp+fp):0;
  const recall=tp+fn?tp/(tp+fn):0;
  return {
    sample_count:labels.length,positive_count:positives,negative_count:negatives,
    positive_rate:positives/labels.length,brier_score:brier,log_loss:nll,
    pr_auc_average_precision:positives?prAuc:null,roc_auc:rocAuc,
    precision_at_0_5:precision,recall_at_0_5:recall,
    f1_at_0_5:precision+recall?2*precision*recall/(precision+recall):0,
    confusion_at_0_5:{true_positive:tp,false_positive:fp,true_negative:tn,false_negative:fn}
  };
}

const DEFAULT_GRID=Object.freeze([
  Object.freeze({l2:0.001,learningRate:0.01}),
  Object.freeze({l2:0.01,learningRate:0.01}),
  Object.freeze({l2:0.1,learningRate:0.01}),
  Object.freeze({l2:1,learningRate:0.01}),
  Object.freeze({l2:0.001,learningRate:0.03}),
  Object.freeze({l2:0.01,learningRate:0.03}),
  Object.freeze({l2:0.1,learningRate:0.03}),
  Object.freeze({l2:1,learningRate:0.03})
]);

/**
 * Tune Logistic only on chronological folds of the supplied training rows,
 * then refit one selected configuration on the complete supplied training
 * partition. A callback may attach fixed-threshold execution diagnostics; it
 * is never used in hyperparameter selection.
 */
function fitFoldModel(rows,featureVectors,fold,configuration,maxEpochs){
  const trainingVectors=fold.train_indices.map(index=>featureVectors[index]);
  const validationVectors=fold.validation_indices.map(index=>featureVectors[index]);
  const trainingLabels=fold.train_indices.map(index=>rows[index].target);
  const validationLabels=fold.validation_indices.map(index=>rows[index].target);
  const standardizer=fitStandardizer(trainingVectors);
  const scaledTraining=transformVectors(trainingVectors,standardizer);
  const scaledValidation=transformVectors(validationVectors,standardizer);
  const fit=fitLogisticWeights(scaledTraining,trainingLabels,{
    l2:configuration.l2,learningRate:configuration.learning_rate,maxEpochs
  });
  const probabilities=scaledValidation.map(vector=>predictFromScaledVector(vector,fit));
  return {
    probabilities,
    metrics:evaluateBinaryProbabilityMetrics(probabilities,validationLabels),
    standardizer,fit,
    training_labels:trainingLabels,
    validation_labels:validationLabels
  };
}

function fitIsotonicCalibrator(probabilities,labels,{
  minimumPositives=50,minimumNegatives=50
}={}) {
  const support=counts(labels.map(target=>({target})));
  const base={
    method:'ISOTONIC_REGRESSION',fitted:false,
    sample_count:labels.length,positive_count:support.positive,
    negative_count:support.negative,
    fit_partition:'TRAIN_ONLY_CROSSFITTED_CALIBRATION_FOLD'
  };
  if(!Array.isArray(probabilities)||probabilities.length!==labels.length||
    labels.length===0||probabilities.some(value=>!finite(value)||Number(value)<0||Number(value)>1))
    return {...base,status:'INVALID_CALIBRATION_INPUT'};
  if(support.positive<minimumPositives||support.negative<minimumNegatives)
    return {...base,status:'INSUFFICIENT_CLASS_SUPPORT'};
  const sorted=probabilities.map((probability,index)=>({
    probability:Number(probability),label:labels[index]
  })).sort((a,b)=>a.probability-b.probability);
  const grouped=[];
  for(const item of sorted){
    const last=grouped.at(-1);
    if(last&&last.probability===item.probability){
      last.count++;last.positive+=item.label;
    }else grouped.push({
      probability:item.probability,count:1,positive:item.label
    });
  }
  const blocks=[];
  for(const group of grouped){
    blocks.push({
      lower:group.probability,upper:group.probability,
      count:group.count,positive:group.positive
    });
    while(blocks.length>=2){
      const right=blocks.at(-1),left=blocks.at(-2);
      const leftRate=left.positive/left.count;
      const rightRate=right.positive/right.count;
      if(leftRate<=rightRate)break;
      blocks.splice(-2,2,{
        lower:left.lower,upper:right.upper,
        count:left.count+right.count,
        positive:left.positive+right.positive
      });
    }
  }
  const thresholds=blocks.map(block=>block.upper);
  const values=blocks.map(block=>clamp(block.positive/block.count,1e-6,1-1e-6));
  return {
    ...base,status:'FITTED',fitted:true,
    x_thresholds:thresholds,y_thresholds:values,
    block_count:blocks.length,
    monotonic_non_decreasing:true,
    fit_objective:'POOL_ADJACENT_VIOLATORS_BINOMIAL_ISOTONIC_REGRESSION'
  };
}
function applyIsotonicCalibrator(probability,calibrator){
  if(!calibrator||calibrator.fitted!==true)return probability;
  const x=calibrator.x_thresholds,y=calibrator.y_thresholds;
  if(!Array.isArray(x)||!Array.isArray(y)||x.length!==y.length||!x.length)
    throw new TypeError('TEMPORAL_LOGISTIC_ISOTONIC_STATE_INVALID');
  const value=clamp(Number(probability),0,1);
  let index=x.findIndex(threshold=>value<=threshold);
  if(index<0)index=x.length-1;
  return clamp(Number(y[index]),1e-6,1-1e-6);
}
function applyCrossFittedCalibrator(probability,calibrator){
  if(!calibrator||calibrator.fitted!==true)return Number(probability);
  if(calibrator.method==='PLATT_SCALING'){
    const p=clamp(Number(probability),1e-9,1-1e-9);
    const logit=Math.log(p/(1-p));
    return applyProbabilityCalibrator(logit,calibrator);
  }
  if(calibrator.method==='ISOTONIC_REGRESSION')
    return applyIsotonicCalibrator(probability,calibrator);
  throw new TypeError('TEMPORAL_LOGISTIC_CALIBRATOR_METHOD_UNSUPPORTED');
}

/**
 * Tune Logistic only on early purged expanding-window folds of the supplied
 * outer-training rows. The penultimate fold fits calibration on OOF scores;
 * the final later fold selects Platt, isotonic or raw fallback. The selected
 * classifier is finally refit on the complete supplied training partition.
 * Outer validation and holdout are never passed to any fitting or selection.
 */
export function fitTunedTemporalLogisticBaseline(rows,featureVectors,{
  foldCount=5,purgeMs=DAY_MS,initialTrainingFraction=0.32,
  validationFraction=0.12,minimumTrainingRows=100,
  minimumValidationRows=50,minimumClassCount=5,
  candidateGrid=DEFAULT_GRID,maxEpochs=160,
  seed=22429,executionEvaluator=null
}={}) {
  if(!Array.isArray(rows)||!Array.isArray(featureVectors)||
    rows.length!==featureVectors.length||!rows.length||
    !Number.isInteger(seed)||!Array.isArray(candidateGrid)||!candidateGrid.length||
    foldCount<5||
    typeof executionEvaluator!=='function'&&executionEvaluator!==null)
    throw new TypeError('TEMPORAL_LOGISTIC_TUNING_INPUT_INVALID');
  const width=featureVectors[0]?.length;
  if(!Number.isInteger(width)||width<1||featureVectors.some(vector=>
    !Array.isArray(vector)||vector.length!==width||vector.some(value=>!finite(value))))
    throw new TypeError('TEMPORAL_LOGISTIC_FEATURE_VECTORS_INVALID');

  const folds=buildPurgedExpandingLogisticFolds(rows,{
    foldCount,purgeMs,initialTrainingFraction,validationFraction,
    minimumTrainingRows,minimumValidationRows,minimumClassCount
  });
  const tuningFolds=folds.folds.slice(0,-2);
  const calibrationFitFold=folds.folds.at(-2);
  const calibrationCheckFold=folds.folds.at(-1);
  if(tuningFolds.length<3||!calibrationFitFold||!calibrationCheckFold)
    throw new Error('TEMPORAL_LOGISTIC_CV_CALIBRATION_FOLDS_UNAVAILABLE');

  const normalizedGrid=candidateGrid.map((candidate,index)=>{
    const l2=Number(candidate?.l2),learningRate=Number(candidate?.learningRate);
    if(!Number.isFinite(l2)||l2<0||!Number.isFinite(learningRate)||
      learningRate<=0||learningRate>0.2)
      throw new TypeError('TEMPORAL_LOGISTIC_CANDIDATE_INVALID:'+index);
    return {candidate_index:index+1,l2,learning_rate:learningRate};
  });

  const candidateResults=[];
  for(const candidate of normalizedGrid){
    const foldResults=tuningFolds.map(fold=>
      fitFoldModel(rows,featureVectors,fold,candidate,maxEpochs)
    );
    const briers=foldResults.map(item=>item.metrics.brier_score);
    const losses=foldResults.map(item=>item.metrics.log_loss);
    candidateResults.push({
      ...candidate,
      mean_fold_brier:average(briers),
      sd_fold_brier:standardDeviation(briers),
      mean_fold_log_loss:average(losses),
      mean_fold_pr_auc:average(foldResults.map(item=>item.metrics.pr_auc_average_precision)),
      mean_fold_roc_auc:average(foldResults.map(item=>item.metrics.roc_auc)),
      folds:foldResults
    });
  }

  candidateResults.sort((a,b)=>
    a.mean_fold_brier-b.mean_fold_brier||
    a.mean_fold_log_loss-b.mean_fold_log_loss||
    b.l2-a.l2||a.learning_rate-b.learning_rate||
    a.candidate_index-b.candidate_index);
  const selected=candidateResults[0];
  if(!selected||!Number.isFinite(selected.mean_fold_brier))
    throw new Error('TEMPORAL_LOGISTIC_NO_VALID_CV_CANDIDATE');

  // These two folds are strictly excluded from candidate hyperparameter choice.
  const calibrationFitResult=fitFoldModel(rows,featureVectors,
    calibrationFitFold,selected,maxEpochs);
  const calibrationCheckResult=fitFoldModel(rows,featureVectors,
    calibrationCheckFold,selected,maxEpochs);
  const calibrationFitSupport=counts(calibrationFitFold.validation_indices.map(index=>rows[index]));
  const calibrationCheckSupport=counts(calibrationCheckFold.validation_indices.map(index=>rows[index]));
  const minimumCalibrationSupport=50;
  const calibrationFitLogits=calibrationFitResult.probabilities.map(probability=>
    Math.log(clamp(probability,1e-9,1-1e-9)/(1-clamp(probability,1e-9,1-1e-9))));
  const calibrationFitLabels=calibrationFitResult.validation_labels;
  const platt=fitPlattScaler(calibrationFitLogits,calibrationFitLabels,{
    minimumPositives:minimumCalibrationSupport,
    minimumNegatives:minimumCalibrationSupport,
    iterations:500,regularization:0.05
  });
  const isotonic=fitIsotonicCalibrator(
    calibrationFitResult.probabilities,calibrationFitLabels,{
      minimumPositives:minimumCalibrationSupport,
      minimumNegatives:minimumCalibrationSupport
    }
  );
  const checkProbabilities=calibrationCheckResult.probabilities;
  const checkLabels=calibrationCheckResult.validation_labels;
  const rawCheckMetrics=evaluateBinaryProbabilityMetrics(checkProbabilities,checkLabels);
  const plattCheckProbabilities=platt.fitted===true
    ?checkProbabilities.map(probability=>applyCrossFittedCalibrator(probability,platt))
    :checkProbabilities;
  const isotonicCheckProbabilities=isotonic.fitted===true
    ?checkProbabilities.map(probability=>applyCrossFittedCalibrator(probability,isotonic))
    :checkProbabilities;
  const plattCheckMetrics=evaluateBinaryProbabilityMetrics(plattCheckProbabilities,checkLabels);
  const isotonicCheckMetrics=evaluateBinaryProbabilityMetrics(isotonicCheckProbabilities,checkLabels);
  const methods=[
    {method:'NO_CALIBRATION',fitted:false,check_metrics:rawCheckMetrics},
    ...(platt.fitted===true?[{
      method:'PLATT_SCALING',fitted:true,check_metrics:plattCheckMetrics,
      calibrator:platt
    }]:[]),
    ...(isotonic.fitted===true?[{
      method:'ISOTONIC_REGRESSION',fitted:true,check_metrics:isotonicCheckMetrics,
      calibrator:isotonic
    }]:[])
  ];
  const rawCheckBrier=rawCheckMetrics.brier_score;
  const acceptedCalibration=methods.filter(candidate=>
    candidate.fitted===true&&
    candidate.check_metrics.brier_score<rawCheckBrier-1e-12&&
    candidate.check_metrics.log_loss<rawCheckMetrics.log_loss-1e-12
  ).sort((a,b)=>
    a.check_metrics.brier_score-b.check_metrics.brier_score||
    a.check_metrics.log_loss-b.check_metrics.log_loss||
    (a.method==='PLATT_SCALING'?-1:1)
  );
  const selectedCalibration=acceptedCalibration[0]??methods[0];
  const selectedCalibrator=selectedCalibration.fitted===true
    ?selectedCalibration.calibrator
    :{method:'NO_CALIBRATION',fitted:false};
  const calibration={
    schema:'RADARX_TRAIN_ONLY_CROSSFITTED_CALIBRATION_V1',
    status:selectedCalibration.fitted?'SELECTED_'+selectedCalibration.method:'RAW_FALLBACK',
    selected_method:selectedCalibration.method,
    selection_rule:'LATER_DISJOINT_CHECK_FOLD_MUST_IMPROVE_BOTH_BRIER_AND_LOG_LOSS',
    fit_partition:'PENULTIMATE_PURGED_TRAIN_ONLY_OOF_FOLD',
    check_partition:'FINAL_PURGED_TRAIN_ONLY_OOF_FOLD',
    fit_fold:calibrationFitFold.fold,
    check_fold:calibrationCheckFold.fold,
    fit_support:calibrationFitSupport,
    check_support:calibrationCheckSupport,
    minimum_positive_and_negative_support:minimumCalibrationSupport,
    platt_fit:{
      status:platt.status??null,fitted:platt.fitted===true,
      slope:platt.slope??null,intercept:platt.intercept??null,
      fit_samples:platt.sample_count??calibrationFitSupport.rows,
      fit_positives:platt.positive_count??calibrationFitSupport.positive,
      fit_negatives:platt.negative_count??calibrationFitSupport.negative
    },
    isotonic_fit:{
      status:isotonic.status??null,fitted:isotonic.fitted===true,
      fit_samples:isotonic.sample_count,
      fit_positives:isotonic.positive_count,
      fit_negatives:isotonic.negative_count,
      block_count:isotonic.block_count??0
    },
    check_metrics:{
      no_calibration:rawCheckMetrics,
      platt:platt.fitted===true?plattCheckMetrics:null,
      isotonic:isotonic.fitted===true?isotonicCheckMetrics:null
    },
    method_trials:methods.map(candidate=>({
      method:candidate.method,fitted:candidate.fitted,
      check_brier:candidate.check_metrics.brier_score,
      check_log_loss:candidate.check_metrics.log_loss,
      accepted:selectedCalibration.method===candidate.method&&selectedCalibration.fitted===true
    })),
    applied_to_final_model:selectedCalibration.fitted===true,
    training_partition_only:true,
    outer_validation_used_for_calibrator_fit:false,
    outer_validation_used_for_calibrator_selection:false,
    holdout_used_for_calibration:false
  };

  const finalStandardizer=fitStandardizer(featureVectors);
  const scaledAllTraining=transformVectors(featureVectors,finalStandardizer);
  const finalLabels=rows.map(row=>row.target);
  const finalFit=fitLogisticWeights(scaledAllTraining,finalLabels,{
    l2:selected.l2,learningRate:selected.learning_rate,maxEpochs
  });
  const buildFoldReport=(fold,result,role)=>{
    const report={
      fold:fold.fold,role,
      training_period:fold.training_period,
      validation_period:fold.validation_period,
      purge_period:fold.purge_period,
      purge_ms:fold.purge_ms,
      purge_row_count:fold.purge_row_count,
      training_support:fold.training_support,
      validation_support:fold.validation_support,
      maximum_training_label_resolved_at:fold.maximum_training_label_resolved_at,
      metrics:result.metrics,
      execution_metrics:null,
      execution_reference_threshold:0.15,
      execution_threshold_tuned_on_fold:false
    };
    if(executionEvaluator){
      const foldRows=fold.validation_indices.map(rowIndex=>rows[rowIndex]);
      report.execution_metrics=executionEvaluator(foldRows,result.probabilities);
    }
    return report;
  };
  const selectedFoldReports=[
    ...selected.folds.map((result,index)=>
      buildFoldReport(tuningFolds[index],result,'HYPERPARAMETER_SELECTION')),
    buildFoldReport(calibrationFitFold,calibrationFitResult,'CALIBRATION_FIT'),
    buildFoldReport(calibrationCheckFold,calibrationCheckResult,'CALIBRATION_CHECK')
  ];
  // Reconstruct raw, strictly purged out-of-fold predictions for every
  // validation row scored by the selected expanding-window CV folds. These
  // predictions are safe residual baselines for training a downstream model:
  // each row is scored by a Logistic fit whose labels all resolved before it.
  const oofPredictionByIndex=new Map();
  const appendOofPredictions=(fold,result)=>{
    if(!Array.isArray(result?.probabilities)||
      result.probabilities.length!==fold.validation_indices.length)
      throw new TypeError('TEMPORAL_LOGISTIC_OOF_FOLD_PREDICTION_LENGTH_MISMATCH:'+fold.fold);
    for(let offset=0;offset<fold.validation_indices.length;offset++){
      const rowIndex=fold.validation_indices[offset];
      const row=rows[rowIndex];
      const probability=Number(result.probabilities[offset]);
      if(oofPredictionByIndex.has(rowIndex)||!finite(probability)||
        probability<0||probability>1||
        !(Number(fold.maximum_training_label_resolved_at)<Number(row.at)))
        throw new TypeError('TEMPORAL_LOGISTIC_OOF_PREDICTION_INVALID:'+rowIndex);
      const bounded=clamp(probability,1e-9,1-1e-9);
      oofPredictionByIndex.set(rowIndex,{
        index:rowIndex,id:String(row.id),at:Number(row.at),
        raw_probability:probability,
        raw_logit:Math.log(bounded/(1-bounded)),
        fold:fold.fold,
        validation_start_at:Number(fold.validation_start_at),
        maximum_training_label_resolved_at:Number(fold.maximum_training_label_resolved_at),
        source_partition:'PURGED_EXPANDING_TRAIN_ONLY_OOF_FOLD'
      });
    }
  };
  for(let foldIndex=0;foldIndex<tuningFolds.length;foldIndex++)
    appendOofPredictions(tuningFolds[foldIndex],selected.folds[foldIndex]);
  appendOofPredictions(calibrationFitFold,calibrationFitResult);
  appendOofPredictions(calibrationCheckFold,calibrationCheckResult);
  const oofPredictions=[...oofPredictionByIndex.values()]
    .sort((a,b)=>a.index-b.index);
  const oofPredictionCoverage={
    schema:'RADARX_PURGED_EXPANDING_TEMPORAL_LOGISTIC_OOF_PREDICTIONS_V1',
    source_partition:'PRE_EXECUTION_HEAD_MODEL_TRAINING_ROWS_ONLY',
    total_training_rows:rows.length,
    oof_scored_rows:oofPredictions.length,
    unscored_warmup_or_tail_rows:rows.length-oofPredictions.length,
    coverage_pct:Number((100*oofPredictions.length/rows.length).toFixed(4)),
    fold_count:folds.fold_count,
    maximum_training_label_resolution_before_scored_row:true,
    outer_validation_or_holdout_used:false
  };
  const publicCandidates=candidateResults.map(candidate=>({
    candidate_index:candidate.candidate_index,l2:candidate.l2,
    learning_rate:candidate.learning_rate,
    mean_fold_brier:candidate.mean_fold_brier,
    sd_fold_brier:candidate.sd_fold_brier,
    mean_fold_log_loss:candidate.mean_fold_log_loss,
    mean_fold_pr_auc:candidate.mean_fold_pr_auc,
    mean_fold_roc_auc:candidate.mean_fold_roc_auc
  }));
  const report={
    schema:'RADARX_TRAIN_ONLY_PURGED_EXPANDING_LOGISTIC_CV_V2',
    status:'COMPLETE',
    model:'LOGISTIC_REGRESSION_TUNED_TEMPORAL',
    training_partition_only:true,
    outer_validation_rows_used:false,
    holdout_rows_or_labels_used:false,
    selection_metric:'LOWEST_UNWEIGHTED_MEAN_FOLD_RAW_BRIER_WITH_LOG_LOSS_TIE_BREAK',
    solver:'FULL_BATCH_GRADIENT_DESCENT',
    feature_normalization:'PER_FOLD_Z_SCORE_FIT_ON_FOLD_TRAINING_ROWS_ONLY',
    class_weighting:'NONE_UNWEIGHTED_PROPER_PROBABILITY_OBJECTIVE',
    random_seed:null,
    deterministic_solver_id:'FULL_BATCH_GD_DETERMINISTIC_V1',
    unused_seed_parameter:seed,
    purge_policy:'ONE_COMPLETE_UTC_DAY_BEFORE_EACH_VALIDATION_BLOCK',
    fold_schema:folds.schema,
    fold_count:folds.fold_count,
    hyperparameter_selection_folds:tuningFolds.length,
    calibration_fit_fold:calibrationFitFold.fold,
    calibration_check_fold:calibrationCheckFold.fold,
    folds:selectedFoldReports,
    candidate_grid:normalizedGrid,
    candidate_results:publicCandidates,
    selected_configuration:{
      l2:selected.l2,learning_rate:selected.learning_rate,
      candidate_index:selected.candidate_index
    },
    selection_summary:{
      selected_mean_fold_brier:selected.mean_fold_brier,
      selected_sd_fold_brier:selected.sd_fold_brier,
      selected_mean_fold_log_loss:selected.mean_fold_log_loss,
      selected_mean_fold_pr_auc:selected.mean_fold_pr_auc,
      selected_mean_fold_roc_auc:selected.mean_fold_roc_auc
    },
    calibration,
    final_fit:{
      training_rows:finalFit.training_rows,
      training_positive:finalFit.training_positive,
      training_negative:finalFit.training_negative,
      epochs:finalFit.epochs,objective:finalFit.objective,
      gradient_norm:finalFit.gradient_norm,
      solver:finalFit.solver
    },
    all_candidate_selection_used_only_early_training_folds:true,
    calibration_fit_and_check_inside_outer_train:true,
    outer_validation_used_for_hyperparameter_selection:false,
    outer_validation_used_for_calibrator_selection:false,
    execution_metrics_used_for_hyperparameter_selection:false,
    threshold_or_top_k_selected_by_cv:false,
    holdout_opened:false
  };
  const model={
    standardizer:finalStandardizer,
    fit:finalFit,
    configuration:report.selected_configuration,
    calibration,
    calibrator:selectedCalibrator,
    training_partition_only:true
  };
  return {
    model,report,
    oof_predictions:oofPredictions,
    oof_prediction_coverage:oofPredictionCoverage
  };
}

/** Predict using the final train-only cross-fitted calibration artifact. */
export function predictCrossFittedCalibratedTemporalLogisticProbability(featureVector,model) {
  const raw=predictTemporalLogisticProbability(featureVector,model);
  return applyCrossFittedCalibrator(raw,model?.calibrator);
}
