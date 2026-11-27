const finite = value => typeof value === 'number' && Number.isFinite(value);
const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const softplus = value => Math.max(0, value) + Math.log1p(Math.exp(-Math.abs(value)));


const clamp = (value, minimum, maximum) =>
  Math.max(minimum, Math.min(maximum, value));

/**
 * Fit Platt calibration for the probability that realized net return after
 * the declared round-trip cost is positive. The caller must supply a later,
 * purged calibration block that is disjoint from the Hurdle head fit block.
 */
export function fitHurdlePositiveReturnCalibration(rawProbabilities, netReturns, {
  minimumSamples = 30,
  minimumPositive = 8,
  minimumNegative = 8,
  iterations = 800,
  learningRate = 0.03,
  regularization = 0.05
} = {}) {
  if (!Array.isArray(rawProbabilities) || !Array.isArray(netReturns) ||
      rawProbabilities.length !== netReturns.length ||
      !Number.isInteger(minimumSamples) || minimumSamples < 1 ||
      !Number.isInteger(minimumPositive) || minimumPositive < 1 ||
      !Number.isInteger(minimumNegative) || minimumNegative < 1 ||
      !Number.isInteger(iterations) || iterations < 50 || iterations > 4000 ||
      !finite(learningRate) || learningRate <= 0 || learningRate > 0.15 ||
      !finite(regularization) || regularization < 0 || regularization > 2 ||
      rawProbabilities.some(value => !finite(value) || value < 0 || value > 1) ||
      netReturns.some(value => !finite(value))) {
    throw new TypeError('HURDLE_POSITIVE_RETURN_CALIBRATION_INPUT_INVALID');
  }
  const labels = netReturns.map(value => Number(value) > 0 ? 1 : 0);
  const positive = labels.reduce((sum, value) => sum + value, 0);
  const negative = labels.length - positive;
  const base = {
    schema: 'RADARX_HURDLE_POSITIVE_NET_RETURN_PLATT_CALIBRATOR_V1',
    method: 'REGULARIZED_PLATT_LOGISTIC_NLL_ON_LATER_PURGED_EXECUTION_HEAD_BLOCK_V1',
    fitted: false,
    samples: labels.length,
    positive_rows: positive,
    negative_rows: negative,
    fit_boundary: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK_ONLY',
    target_definition: 'REALIZED_FIRST_TOUCH_RETURN_MINUS_FIXED_ROUND_TRIP_COST_GT_ZERO',
    round_trip_cost_already_applied: true,
    validation_or_holdout_used: false
  };
  if (labels.length < minimumSamples || positive < minimumPositive ||
      negative < minimumNegative) {
    return {
      ...base,
      reason: 'HURDLE_POSITIVE_RETURN_CALIBRATION_CLASS_SUPPORT_BELOW_MINIMUM',
      slope: 1,
      intercept: 0,
      minimum_samples: minimumSamples,
      minimum_positive: minimumPositive,
      minimum_negative: minimumNegative
    };
  }

  const logits = rawProbabilities.map(value => {
    const bounded = clamp(Number(value), 1e-8, 1 - 1e-8);
    return clamp(Math.log(bounded / (1 - bounded)), -30, 30);
  });
  const slopePenalty = Number(regularization);
  const interceptPenalty = slopePenalty * 0.25;
  let slope = 1;
  let intercept = 0;
  let firstSlope = 0;
  let secondSlope = 0;
  let firstIntercept = 0;
  let secondIntercept = 0;
  let bestLoss = NaN;
  let best = { slope, intercept };
  let wait = 0;
  let completed = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;
  const objective = (m, b) => {
    let total = 0;
    for (let index = 0; index < logits.length; index++) {
      const z = clamp(m * logits[index] + b, -30, 30);
      total += softplus(z) - labels[index] * z;
    }
    return total / logits.length +
      slopePenalty * (m - 1) ** 2 + interceptPenalty * b * b;
  };
  const initial = objective(slope, intercept);
  if(!finite(initial))
    throw new TypeError('HURDLE_POSITIVE_RETURN_CALIBRATION_INITIAL_OBJECTIVE_NON_FINITE');
  // Identity is the incumbent: calibration must improve raw probabilities.
  bestLoss=initial;
  for (let step = 1; step <= iterations; step++) {
    let gradientSlope = 0;
    let gradientIntercept = 0;
    for (let index = 0; index < logits.length; index++) {
      const probability = sigmoid(slope * logits[index] + intercept);
      const error = probability - labels[index];
      gradientSlope += error * logits[index];
      gradientIntercept += error;
    }
    gradientSlope = gradientSlope / logits.length +
      2 * slopePenalty * (slope - 1);
    gradientIntercept = gradientIntercept / logits.length +
      2 * interceptPenalty * intercept;
    if (!finite(gradientSlope) || !finite(gradientIntercept))
      throw new TypeError('HURDLE_POSITIVE_RETURN_CALIBRATION_GRADIENT_NON_FINITE');

    firstSlope = beta1 * firstSlope + (1 - beta1) * gradientSlope;
    secondSlope = beta2 * secondSlope + (1 - beta2) * gradientSlope * gradientSlope;
    firstIntercept = beta1 * firstIntercept + (1 - beta1) * gradientIntercept;
    secondIntercept = beta2 * secondIntercept +
      (1 - beta2) * gradientIntercept * gradientIntercept;
    const correctedSlope = firstSlope / (1 - Math.pow(beta1, step));
    const correctedSlopeVariance = secondSlope / (1 - Math.pow(beta2, step));
    const correctedIntercept = firstIntercept / (1 - Math.pow(beta1, step));
    const correctedInterceptVariance = secondIntercept / (1 - Math.pow(beta2, step));
    const rate = Number(learningRate);
    slope = clamp(slope - rate * correctedSlope /
      (Math.sqrt(correctedSlopeVariance) + epsilon), 0.05, 8);
    intercept = clamp(intercept - rate * correctedIntercept /
      (Math.sqrt(correctedInterceptVariance) + epsilon), -8, 8);

    const current = objective(slope, intercept);
    if (!finite(current) || !finite(slope) || !finite(intercept))
      throw new TypeError('HURDLE_POSITIVE_RETURN_CALIBRATION_STATE_NON_FINITE');
    completed = step;
    if (current < bestLoss - 1e-10) {
      bestLoss = current;
      best = { slope, intercept };
      wait = 0;
    } else if (++wait >= 100) {
      break;
    }
  }
  return {
    ...base,
    fitted: true,
    slope: Number(best.slope),
    intercept: Number(best.intercept),
    initial_objective: Number(initial.toFixed(10)),
    final_objective: Number(bestLoss.toFixed(10)),
    identity_selected:Math.abs(bestLoss-initial)<=1e-10,
    iterations_completed: completed,
    learning_rate: Number(learningRate),
    regularization: Number(regularization),
    slope_bounds: [0.05, 8],
    intercept_bounds: [-8, 8],
    raw_probability_class_reweighting: false
  };
}

function applyHurdleProbabilityCalibration(rawProbability, calibration) {
  if (!calibration || calibration.schema !==
      'RADARX_HURDLE_POSITIVE_NET_RETURN_PLATT_CALIBRATOR_V1' ||
      calibration.fitted !== true || !finite(calibration.slope) ||
      calibration.slope < 0.05 || calibration.slope > 8 ||
      !finite(calibration.intercept) || calibration.intercept < -8 ||
      calibration.intercept > 8 ||
      calibration.fit_boundary !==
        'PURGED_INNER_TRAINING_EXECUTION_HEAD_CALIBRATION_BLOCK_ONLY' ||
      calibration.validation_or_holdout_used !== false) {
    throw new TypeError('HURDLE_POSITIVE_RETURN_CALIBRATION_STATE_INVALID');
  }
  const bounded = clamp(Number(rawProbability), 1e-8, 1 - 1e-8);
  const logit = Math.log(bounded / (1 - bounded));
  return sigmoid(clamp(
    Number(calibration.slope) * logit + Number(calibration.intercept), -30, 30
  ));
}

export const HURDLE_RETURN_HEAD_SCHEMA =
  'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V2';

const CONDITIONAL_MEAN_SCHEMA = 'RADARX_HURDLE_CONDITIONAL_MEAN_HUBER_V1';

function huberLoss(residual, delta) {
  const absolute = Math.abs(residual);
  return absolute <= delta
    ? 0.5 * residual * residual
    : delta * (absolute - 0.5 * delta);
}

/**
 * Fit a feature-conditional mean return model on one outcome class only.
 * Inputs have already been standardized from the full training-only block.
 */
function fitConditionalMeanHead(rows, targets, {
  learningRate = 0.01,
  epochs = 240,
  l2 = 0.1,
  huberDelta = 1
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(targets) ||
      rows.length !== targets.length || rows.length < 8 ||
      !Number.isInteger(epochs) || epochs < 20 || epochs > 1000 ||
      !finite(learningRate) || learningRate <= 0 || learningRate > 0.1 ||
      !finite(l2) || l2 < 0 || l2 > 10 ||
      !finite(huberDelta) || huberDelta <= 0 || huberDelta > 10) {
    throw new TypeError('HURDLE_CONDITIONAL_MEAN_CONFIGURATION_INVALID');
  }
  const featureCount = rows[0]?.length;
  if (!Number.isInteger(featureCount) || featureCount < 1 ||
      rows.some(row => !Array.isArray(row) || row.length !== featureCount ||
        row.some(value => !finite(value))) ||
      targets.some(value => !finite(value))) {
    throw new TypeError('HURDLE_CONDITIONAL_MEAN_TRAINING_DATA_INVALID');
  }

  let bias = targets.reduce((sum, value) => sum + Number(value), 0) / targets.length;
  let weights = Array(featureCount).fill(0);
  const firstMoment = Array(featureCount).fill(0);
  const secondMoment = Array(featureCount).fill(0);
  let biasFirstMoment = 0;
  let biasSecondMoment = 0;
  let bestLoss = NaN;
  let best = { weights: [...weights], bias };
  let wait = 0;
  let completedEpochs = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;
  const loss = () => {
    let total = 0;
    for (let index = 0; index < rows.length; index++) {
      const prediction = bias + rows[index].reduce(
        (sum, value, column) => sum + value * weights[column], 0
      );
      total += huberLoss(prediction - Number(targets[index]), huberDelta);
    }
    const penalty = weights.reduce((sum, value) => sum + value * value, 0);
    return total / rows.length + 0.5 * l2 * penalty;
  };

  const initialLoss = loss();
  if(!finite(initialLoss))
    throw new TypeError('HURDLE_CONDITIONAL_MEAN_INITIAL_LOSS_NON_FINITE');
  // Keep the constant class-mean predictor unless features strictly improve it.
  bestLoss=initialLoss;
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const gradient = Array(featureCount).fill(0);
    let biasGradient = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const residual = bias + row.reduce(
        (sum, value, column) => sum + value * weights[column], 0
      ) - Number(targets[index]);
      const absolute = Math.abs(residual);
      const error = absolute <= huberDelta
        ? residual
        : Math.sign(residual) * huberDelta;
      biasGradient += error;
      for (let column = 0; column < featureCount; column++) {
        gradient[column] += error * row[column];
      }
    }
    for (let column = 0; column < featureCount; column++) {
      gradient[column] = gradient[column] / rows.length + l2 * weights[column];
    }
    biasGradient /= rows.length;
    for (let column = 0; column < featureCount; column++) {
      const g = gradient[column];
      firstMoment[column] = beta1 * firstMoment[column] + (1 - beta1) * g;
      secondMoment[column] = beta2 * secondMoment[column] + (1 - beta2) * g * g;
      const m = firstMoment[column] / (1 - Math.pow(beta1, epoch));
      const v = secondMoment[column] / (1 - Math.pow(beta2, epoch));
      weights[column] -= learningRate * m / (Math.sqrt(v) + epsilon);
    }
    biasFirstMoment = beta1 * biasFirstMoment + (1 - beta1) * biasGradient;
    biasSecondMoment = beta2 * biasSecondMoment +
      (1 - beta2) * biasGradient * biasGradient;
    const mb = biasFirstMoment / (1 - Math.pow(beta1, epoch));
    const vb = biasSecondMoment / (1 - Math.pow(beta2, epoch));
    bias -= learningRate * mb / (Math.sqrt(vb) + epsilon);

    const currentLoss = loss();
    if (!finite(currentLoss) || !finite(bias) || weights.some(value => !finite(value))) {
      throw new TypeError('HURDLE_CONDITIONAL_MEAN_NON_FINITE');
    }
    completedEpochs = epoch;
    if (currentLoss < bestLoss - 1e-9) {
      bestLoss = currentLoss;
      best = { weights: [...weights], bias };
      wait = 0;
    } else if (++wait >= 40) {
      break;
    }
  }

  const minimum = Math.min(...targets.map(Number));
  const maximum = Math.max(...targets.map(Number));
  return {
    schema: CONDITIONAL_MEAN_SCHEMA,
    fitted: true,
    rows: rows.length,
    weights: best.weights,
    bias: Number(best.bias),
    training_target_min_pct: minimum,
    training_target_max_pct: maximum,
    huber_delta: Number(huberDelta),
    initial_huber_loss: Number(initialLoss.toFixed(8)),
    final_huber_loss: Number(bestLoss.toFixed(8)),
    constant_mean_baseline_selected:best.weights.every(value=>value===0)&&
      Math.abs(best.bias-targets.reduce((sum,value)=>sum+Number(value),0)/targets.length)<=1e-12,
    epochs_completed: completedEpochs,
    requested_epochs: epochs,
    learning_rate: Number(learningRate),
    l2: Number(l2),
    fit_partition: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
    validation_or_holdout_used: false
  };
}

function predictConditionalMean(normalized, model) {
  const raw = Number(model.bias) + normalized.reduce(
    (sum, value, index) => sum + value * Number(model.weights[index]), 0
  );
  // Keep each conditional mean within the observed training-only target range.
  return Math.max(
    Number(model.training_target_min_pct),
    Math.min(Number(model.training_target_max_pct), raw)
  );
}

/**
 * Two-part expected-return estimator:
 *   1) unweighted logistic probability that net return after fees is positive;
 *   2) separate feature-conditional Huber regressions for positive and
 *      non-positive net-return magnitudes.
 *
 * The class probability is deliberately not reweighted: it retains the
 * empirical prior. All normalizers, coefficients and target bounds are fitted
 * only on the purged execution-head training partition supplied here.
 */
export function fitHurdleReturnHead(featureRows, netReturns, {
  learningRate = 0.02,
  epochs = 200,
  l2 = 0.05,
  minimumClassRows = 10
} = {}) {
  if (!Array.isArray(featureRows) || !Array.isArray(netReturns) ||
      featureRows.length !== netReturns.length || featureRows.length < 20 ||
      !Number.isInteger(minimumClassRows) || minimumClassRows < 2 ||
      !finite(learningRate) || learningRate <= 0 || learningRate > 0.1 ||
      !Number.isInteger(epochs) || epochs < 20 || epochs > 1000 ||
      !finite(l2) || l2 < 0 || l2 > 10) {
    throw new TypeError('HURDLE_RETURN_HEAD_CONFIGURATION_INVALID');
  }
  const featureCount = featureRows[0]?.length;
  if (!Number.isInteger(featureCount) || featureCount < 1 ||
      featureRows.some(row => !Array.isArray(row) || row.length !== featureCount ||
        row.some(value => !finite(value))) ||
      netReturns.some(value => !finite(value))) {
    throw new TypeError('HURDLE_RETURN_HEAD_TRAINING_DATA_INVALID');
  }

  const positive = netReturns.map(value => Number(value) > 0 ? 1 : 0);
  const positiveIndexes = positive.map((value, index) => value ? index : -1)
    .filter(index => index >= 0);
  const nonPositiveIndexes = positive.map((value, index) => value ? -1 : index)
    .filter(index => index >= 0);
  const positiveCount = positiveIndexes.length;
  const nonPositiveCount = nonPositiveIndexes.length;
  if (positiveCount < minimumClassRows || nonPositiveCount < minimumClassRows) {
    throw new TypeError('HURDLE_RETURN_HEAD_CLASS_SUPPORT_TOO_SMALL:' +
      positiveCount + ':' + nonPositiveCount);
  }

  const moments = Array.from({ length: featureCount }, (_, column) => {
    const mean = featureRows.reduce((sum, row) => sum + Number(row[column]), 0) /
      featureRows.length;
    const variance = featureRows.reduce((sum, row) =>
      sum + Math.pow(Number(row[column]) - mean, 2), 0) / featureRows.length;
    const rawStd = Math.sqrt(Math.max(0, variance));
    return { mean, std: rawStd > 1e-8 ? rawStd : 1,
      constant: rawStd <= 1e-8 };
  });
  const normalized = featureRows.map(row => row.map((value, column) =>
    (Number(value) - moments[column].mean) / moments[column].std
  ));
  if (normalized.some(row => row.some(value => !finite(value)))) {
    throw new TypeError('HURDLE_RETURN_HEAD_STANDARDIZATION_NON_FINITE');
  }

  // Start from the empirical prior instead of 0.5. No class weighting is used.
  let weights = Array(featureCount).fill(0);
  let bias = Math.log(positiveCount / nonPositiveCount);
  const firstMoment = Array(featureCount).fill(0);
  const secondMoment = Array(featureCount).fill(0);
  let biasFirstMoment = 0;
  let biasSecondMoment = 0;
  let bestLoss = NaN;
  let best = { weights: [...weights], bias };
  let wait = 0;
  let completedEpochs = 0;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const epsilon = 1e-8;
  const loss = () => {
    let total = 0;
    for (let index = 0; index < normalized.length; index++) {
      const logit = bias + normalized[index].reduce(
        (sum, value, column) => sum + value * weights[column], 0
      );
      total += softplus(logit) - positive[index] * logit;
    }
    const penalty = weights.reduce((sum, value) => sum + value * value, 0);
    return total / normalized.length + 0.5 * l2 * penalty;
  };

  const initialLoss = loss();
  if(!finite(initialLoss))
    throw new TypeError('HURDLE_RETURN_HEAD_INITIAL_LOSS_NON_FINITE');
  // Keep the empirical-prior classifier unless features strictly improve it.
  bestLoss=initialLoss;
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const gradient = Array(featureCount).fill(0);
    let biasGradient = 0;
    for (let index = 0; index < normalized.length; index++) {
      const row = normalized[index];
      const error = sigmoid(bias + row.reduce(
        (sum, value, column) => sum + value * weights[column], 0
      )) - positive[index];
      biasGradient += error;
      for (let column = 0; column < featureCount; column++) {
        gradient[column] += error * row[column];
      }
    }
    for (let column = 0; column < featureCount; column++) {
      gradient[column] = gradient[column] / normalized.length + l2 * weights[column];
    }
    biasGradient /= normalized.length;
    for (let column = 0; column < featureCount; column++) {
      const g = gradient[column];
      firstMoment[column] = beta1 * firstMoment[column] + (1 - beta1) * g;
      secondMoment[column] = beta2 * secondMoment[column] + (1 - beta2) * g * g;
      const m = firstMoment[column] / (1 - Math.pow(beta1, epoch));
      const v = secondMoment[column] / (1 - Math.pow(beta2, epoch));
      weights[column] -= learningRate * m / (Math.sqrt(v) + epsilon);
    }
    biasFirstMoment = beta1 * biasFirstMoment + (1 - beta1) * biasGradient;
    biasSecondMoment = beta2 * biasSecondMoment +
      (1 - beta2) * biasGradient * biasGradient;
    const mb = biasFirstMoment / (1 - Math.pow(beta1, epoch));
    const vb = biasSecondMoment / (1 - Math.pow(beta2, epoch));
    bias -= learningRate * mb / (Math.sqrt(vb) + epsilon);

    const currentLoss = loss();
    if (!finite(currentLoss) || !finite(bias) || weights.some(value => !finite(value))) {
      throw new TypeError('HURDLE_RETURN_HEAD_NON_FINITE');
    }
    completedEpochs = epoch;
    if (currentLoss < bestLoss - 1e-9) {
      bestLoss = currentLoss;
      best = { weights: [...weights], bias };
      wait = 0;
    } else if (++wait >= 30) {
      break;
    }
  }

  const positiveReturns = positiveIndexes.map(index => Number(netReturns[index]));
  const nonPositiveReturns = nonPositiveIndexes.map(index => Number(netReturns[index]));
  const meanPositive = positiveReturns.reduce((sum, value) => sum + value, 0) /
    positiveReturns.length;
  const meanNonPositive = nonPositiveReturns.reduce((sum, value) => sum + value, 0) /
    nonPositiveReturns.length;
  const positiveConditionalRows = positiveIndexes.map(index => normalized[index]);
  const nonPositiveConditionalRows = nonPositiveIndexes.map(index => normalized[index]);
  const positiveConditionalMean = fitConditionalMeanHead(
    positiveConditionalRows, positiveReturns
  );
  const nonPositiveConditionalMean = fitConditionalMeanHead(
    nonPositiveConditionalRows, nonPositiveReturns
  );
  const prevalence = positiveCount / netReturns.length;
  return {
    schema: HURDLE_RETURN_HEAD_SCHEMA,
    fitted: true,
    fit_boundary: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
    feature_mean: moments.map(item => Number(item.mean)),
    feature_std: moments.map(item => Number(item.std)),
    zero_variance_feature_count: moments.filter(item => item.constant).length,
    weights: best.weights,
    bias: Number(best.bias),
    positive_class_mean_net_return_pct: Number(meanPositive),
    non_positive_class_mean_net_return_pct: Number(meanNonPositive),
    positive_conditional_mean_model: positiveConditionalMean,
    non_positive_conditional_mean_model: nonPositiveConditionalMean,
    conditional_mean_type: 'FEATURE_CONDITIONAL_HUBER_REGRESSION_V1',
    positive_rows: positiveCount,
    non_positive_rows: nonPositiveCount,
    empirical_positive_rate: Number(prevalence),
    positive_probability_class_weight: 1,
    negative_probability_class_weight: 1,
    class_reweighting_used: false,
    initial_log_loss: Number(initialLoss.toFixed(8)),
    final_log_loss: Number(bestLoss.toFixed(8)),
    empirical_prior_baseline_selected:best.weights.every(value=>value===0)&&
      Math.abs(best.bias-Math.log(positiveCount/nonPositiveCount))<=1e-12,
    epochs_completed: completedEpochs,
    requested_epochs: epochs,
    learning_rate: Number(learningRate),
    l2: Number(l2),
    target_definition: 'REALIZED_FIRST_TOUCH_RETURN_MINUS_ROUND_TRIP_COST_GT_ZERO',
    conditional_mean_fit_partition: 'PURGED_INNER_TRAINING_EXECUTION_HEAD_BLOCK_ONLY',
    validation_or_holdout_used: false
  };
}

export function predictHurdleExpectedNetReturn(features, model) {
  const featureCount = features?.length;
  const positiveMeanModel = model?.positive_conditional_mean_model;
  const nonPositiveMeanModel = model?.non_positive_conditional_mean_model;
  const validMeanModel = (item, positive) =>
    item?.schema === CONDITIONAL_MEAN_SCHEMA && item?.fitted === true &&
    Array.isArray(item.weights) && item.weights.length === featureCount &&
    item.weights.every(finite) && finite(item.bias) &&
    finite(item.training_target_min_pct) && finite(item.training_target_max_pct) &&
    item.training_target_min_pct <= item.training_target_max_pct &&
    (positive
      ? item.training_target_min_pct > 0
      : item.training_target_max_pct <= 0);
  if (!Array.isArray(features) || !features.length || features.some(value => !finite(value)) ||
      model?.schema !== HURDLE_RETURN_HEAD_SCHEMA || model?.fitted !== true ||
      !Array.isArray(model.feature_mean) || !Array.isArray(model.feature_std) ||
      !Array.isArray(model.weights) || model.feature_mean.length !== featureCount ||
      model.feature_std.length !== featureCount || model.weights.length !== featureCount ||
      model.feature_mean.some(value => !finite(value)) ||
      model.feature_std.some(value => !finite(value) || Number(value) <= 0) ||
      model.weights.some(value => !finite(value)) || !finite(model.bias) ||
      model.conditional_mean_type !== 'FEATURE_CONDITIONAL_HUBER_REGRESSION_V1' ||
      !validMeanModel(positiveMeanModel, true) ||
      !validMeanModel(nonPositiveMeanModel, false)) {
    throw new TypeError('HURDLE_RETURN_HEAD_INFERENCE_STATE_INVALID');
  }
  const normalized = features.map((value, index) =>
    (Number(value) - Number(model.feature_mean[index])) / Number(model.feature_std[index])
  );
  const rawProbability = sigmoid(Number(model.bias) + normalized.reduce(
    (sum, value, index) => sum + value * Number(model.weights[index]), 0
  ));
  const calibration = model.probability_calibration ?? null;
  const probability = calibration
    ? applyHurdleProbabilityCalibration(rawProbability, calibration)
    : rawProbability;
  const positiveMean = predictConditionalMean(normalized, positiveMeanModel);
  const nonPositiveMean = predictConditionalMean(normalized, nonPositiveMeanModel);
  const expected = probability * positiveMean + (1 - probability) * nonPositiveMean;
  if (!finite(rawProbability) || !finite(probability) || !finite(expected) ||
      !finite(positiveMean) || !finite(nonPositiveMean)) {
    throw new TypeError('HURDLE_RETURN_HEAD_EXPECTATION_NON_FINITE');
  }
  return {
    raw_probability_positive_net_return: Number(rawProbability),
    probability_positive_net_return: Number(probability),
    probability_calibration_applied: Boolean(calibration),
    probability_calibration_schema: calibration?.schema ?? null,
    expected_net_return_pct: Number(expected),
    positive_net_return_mean_pct: Number(positiveMean),
    non_positive_net_return_mean_pct: Number(nonPositiveMean),
    positive_net_return_class_mean_pct:
      Number(model.positive_class_mean_net_return_pct),
    non_positive_net_return_class_mean_pct:
      Number(model.non_positive_class_mean_net_return_pct),
    conditional_mean_type: model.conditional_mean_type
  };
}
