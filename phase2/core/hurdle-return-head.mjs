const finite = value => typeof value === 'number' && Number.isFinite(value);
const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const softplus = value => Math.max(0, value) + Math.log1p(Math.exp(-Math.abs(value)));

export const HURDLE_RETURN_HEAD_SCHEMA =
  'RADARX_TCN_LSTM_HURDLE_RETURN_HEAD_V1';

/**
 * Two-part expected-return estimator:
 *   1) unweighted logistic probability that net return after fees is positive;
 *   2) training-only conditional mean net return for positive and non-positive
 *      outcomes.
 *
 * The class probability is deliberately not reweighted: it must retain its
 * empirical prior to make the probability × conditional-mean decomposition
 * interpretable as an expected net return. Features and coefficients are
 * fitted only on the purged execution-head training partition supplied here.
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
  const positiveCount = positive.reduce((sum, value) => sum + value, 0);
  const nonPositiveCount = positive.length - positiveCount;
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

  // Start from the empirical prior instead of 0.5. This is important for the
  // rare-positive regime and avoids any hidden class reweighting.
  let weights = Array(featureCount).fill(0);
  let bias = Math.log(positiveCount / nonPositiveCount);
  const firstMoment = Array(featureCount).fill(0);
  const secondMoment = Array(featureCount).fill(0);
  let biasFirstMoment = 0;
  let biasSecondMoment = 0;
  let bestLoss = Infinity;
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
      const y = positive[index];
      total += softplus(logit) - y * logit;
    }
    const penalty = weights.reduce((sum, value) => sum + value * value, 0);
    return total / normalized.length + 0.5 * l2 * penalty;
  };

  const initialLoss = loss();
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

  const positiveReturns = netReturns.filter(value => Number(value) > 0);
  const nonPositiveReturns = netReturns.filter(value => Number(value) <= 0);
  const meanPositive = positiveReturns.reduce((sum, value) => sum + Number(value), 0) /
    positiveReturns.length;
  const meanNonPositive = nonPositiveReturns.reduce((sum, value) => sum + Number(value), 0) /
    nonPositiveReturns.length;
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
    positive_net_return_mean_pct: Number(meanPositive),
    non_positive_net_return_mean_pct: Number(meanNonPositive),
    positive_rows: positiveCount,
    non_positive_rows: nonPositiveCount,
    empirical_positive_rate: Number(prevalence),
    positive_probability_class_weight: 1,
    negative_probability_class_weight: 1,
    class_reweighting_used: false,
    initial_log_loss: Number(initialLoss.toFixed(8)),
    final_log_loss: Number(bestLoss.toFixed(8)),
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
  if (!Array.isArray(features) || !features.length || features.some(value => !finite(value)) ||
      model?.schema !== HURDLE_RETURN_HEAD_SCHEMA || model?.fitted !== true ||
      !Array.isArray(model.feature_mean) || !Array.isArray(model.feature_std) ||
      !Array.isArray(model.weights) || model.feature_mean.length !== features.length ||
      model.feature_std.length !== features.length || model.weights.length !== features.length ||
      model.feature_mean.some(value => !finite(value)) ||
      model.feature_std.some(value => !finite(value) || Number(value) <= 0) ||
      model.weights.some(value => !finite(value)) || !finite(model.bias) ||
      !finite(model.positive_net_return_mean_pct) ||
      !finite(model.non_positive_net_return_mean_pct) ||
      Number(model.positive_net_return_mean_pct) <= 0 ||
      Number(model.non_positive_net_return_mean_pct) > 0) {
    throw new TypeError('HURDLE_RETURN_HEAD_INFERENCE_STATE_INVALID');
  }
  const normalized = features.map((value, index) =>
    (Number(value) - Number(model.feature_mean[index])) / Number(model.feature_std[index])
  );
  const probability = sigmoid(Number(model.bias) + normalized.reduce(
    (sum, value, index) => sum + value * Number(model.weights[index]), 0
  ));
  const expected = probability * Number(model.positive_net_return_mean_pct) +
    (1 - probability) * Number(model.non_positive_net_return_mean_pct);
  if (!finite(probability) || !finite(expected)) {
    throw new TypeError('HURDLE_RETURN_HEAD_EXPECTATION_NON_FINITE');
  }
  return {
    probability_positive_net_return: Number(probability),
    expected_net_return_pct: Number(expected),
    positive_net_return_mean_pct: Number(model.positive_net_return_mean_pct),
    non_positive_net_return_mean_pct: Number(model.non_positive_net_return_mean_pct)
  };
}
