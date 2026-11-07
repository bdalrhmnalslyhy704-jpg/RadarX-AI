# Hybrid TCN + Attention — Fixed-SHA research benchmark

## Status and safety

This is an isolated research challenger for RadarX Build 224. It does not replace V5 or TCN V6, does not alter any radar score, and is not imported by the live backend. The only permitted market is Binance Spot USDT. It is paper-only: no futures, leverage, exchange orders, or live position execution.

A model name, a successful training run, synthetic unit tests, or lower classification loss is not evidence of profitable trading. Promotion is blocked until the benchmark has enough real, independently replayed, out-of-sample paper trades and beats the frozen classic baseline.

## Frozen benchmark identity

Every report records three identifiers:

- source_commit_sha: the full 40-character source commit used for the benchmark.
- dataset_sha256: SHA-256 of the canonical sorted event dataset, including the sequence tensors, baseline scores, realized forward outcomes, and event timestamps.
- fixed_benchmark_sha256: SHA-256 over the source SHA, dataset SHA, row count, and target contract.

The classical baseline and the neural challenger are run against the same normalized event rows, same non-overlapping out-of-sample timestamps, same costs, same single-position constraint, and same equity accounting. A dataset change creates a different dataset SHA; results from different SHAs must never be compared as if paired.

## Causal feature tensor

buildHybridSequence constructs a 24-step sequence from completed candles only. It rejects incomplete candles and any candle whose close time exceeds asOf. The 21 channels include:

1. One-, three-, and twelve-candle log returns.
2. Candle body, range, close location, and upper/lower wick fractions.
3. Quote-turnover and trade-count expansion versus the preceding self-baseline.
4. Taker-buy imbalance and aggregate-trade buy/sell imbalance.
5. Bid/ask depth imbalance and spread.
6. Volume-profile point-of-control distance and 70% value-area position.
7. Short realized volatility, adaptive short/long volatility ratio, and relative BTC return.
8. Explicit availability masks for depth and aggregate-trade evidence.

The order-book and aggregate-trade fields are optional. A missing feed is encoded as unavailable, not fabricated as neutral live evidence. The current builder consumes depth/aggregate-trade fields attached to their matching completed candle; raw-feed collection and historical backfill remain an upstream data requirement.

## Neural architecture and objective

The challenger first projects 21 features to 12 hidden channels, then applies three causal residual temporal convolution blocks with dilations 1, 2, and 4. A learned temporal attention query produces a softmax weight over the 24 available historical states; the weighted context feeds the prediction head. No step after the decision timestamp is accessible to the model.

Training minimizes a custom differentiable portfolio objective, not MSE or Brier:

loss = -mean(net portfolio return) - 0.15 * Sharpe + 0.08 * downside semivariance + 0.08 * drawdown penalty.

The gradient flows through a smooth position-allocation function and the attention/TCN layers. This objective is an optimization target, not a guarantee of future profit. Thresholds are selected only on the validation block inside each walk-forward fold.

## Execution and outcome rules

The benchmark assumes long-only Spot entries, one open position at a time, and a 20% equity allocation per position. Default round-trip costs are 30 bps (10 bps fee plus 5 bps slippage per side). All strategies use identical costs. A +3% take-profit and -2% stop-loss are resolved from completed future candles; if one candle touches both levels and OHLC ordering is unknown, the stop is assumed to occur first. This conservative tie rule prevents optimistic look-ahead.

The event adapter prepareHybridBenchmarkEvent builds a normalized row from the decision-time closed-candle window and the forward 4-hour closed-candle path. It refuses an incomplete forward horizon when neither barrier has been reached. The dataset must provide one unique row per symbol/decision timestamp with:

- id, symbol, market=BINANCE_SPOT_USDT, outcome_source=BINANCE_SPOT_CLOSED_15M, at, latest_input_at, and resolved_at in epoch milliseconds.
- sequence: exactly 24 rows by 21 finite normalized features, each value within [-4, 4].
- gross_return_pct: realized long-only forward gross return, derived from the same closed-candle outcome policy for every model.
- classic_score: frozen classic-baseline score normalized to [0, 1].

latest_input_at <= at and resolved_at > at are mandatory. Duplicate symbol/timestamp events are removed once. Rows without the explicit Spot market and closed-15m outcome provenance are rejected. The caller must still source the candles and matching historical market-depth/aggregate-trade records from the public Spot market and must not include future-derived values in the input tensor or classic score.

## Walk-forward protocol

The benchmark uses expanding chronological folds. Each fold has a training block, a later threshold-selection/validation block, and a strictly later out-of-sample test block. Training labels must resolve before the validation boundary minus the full horizon/embargo; validation labels must resolve before the test boundary minus the embargo. Test blocks do not overlap. Thresholds are fit on validation only; the test scores are never used for fitting, threshold selection, calibration, or model changes.

A fold that fails sample support or a maturity/embargo condition is rejected. A short history returns INSUFFICIENT_WALK_FORWARD_COVERAGE, not a relaxed split.

## Acceptance and release gates

The hybrid may be marked accepted only if all these independent gates pass on the combined non-overlapping out-of-sample test rows:

- At least 100 completed test trades.
- Net win rate at least 55%, after costs.
- Portfolio maximum drawdown at most 8%.
- Net PnL strictly positive, after costs.
- Higher net PnL and higher per-trade Sharpe than the classic baseline, without higher maximum drawdown.
- Identical fixed benchmark SHA, candidate test events, cost assumptions, and position constraints.

Any missing gate yields NEURAL_SUPERIORITY_NOT_PROVEN. Insufficient folds yield INSUFFICIENT_WALK_FORWARD_COVERAGE.

## Reproduction

Prepare a JSON file containing rows (the schema above), then run:

    node phase2/tools/hybrid-tcn-attention-benchmark.mjs --input reports/prepared-spot-events.json --source-commit-sha <full-40-character-sha> --output reports/hybrid-tcn-attention-benchmark.json

The prepared dataset adapter is intentionally separate from the live app. Until a verified full-history replay produces the exact event rows and this CLI emits an accepted report on a release SHA, V5 and TCN V6 remain frozen challengers, not declared failures replaced by an unproven model.
