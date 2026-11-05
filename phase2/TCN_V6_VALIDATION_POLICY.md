# RadarX Build 224 — TCN V6 validation policy

## Target and evidence

TCN V6 uses 24 completed 15-minute candles with 29 channels and the
`FIRST_PASSAGE_3PCT_BEFORE_MINUS_2PCT_4H_V1` target: +3% must be reached
before -2% inside four hours. Training rows must come from verified closed
Binance Spot USDT candles. Unresolved, ticker-only, duplicate, stale, incomplete,
or future-labelled rows are not training examples.

## Chronological model-selection boundaries

1. The shared TCN ensemble is fitted only on the earliest purged training block.
2. Ensemble-member selection and the probability calibrator may use only the
   later, disjoint selection block.
3. If a BTC regime has too few selection examples or one class is absent in its
   local selection slice, a pooled selection-block fallback may choose the
   shared ensemble member. It is still earlier than validation and holdout.
4. The reported validation block is later than training and selection. The
   final holdout is later still and is never used to fit, select, tune, or
   calibrate the model.
5. Each regime is evaluated on its own validation and untouched holdout rows.
   Pooled selection does not pool the regime's validation or holdout scores.

## Probability and trading gates

Probability readiness requires the selected TCN to beat both the prevalence
baseline and the same-window logistic challenger by the configured Brier
comparison margin on chronological validation and on the untouched holdout.
Live eligibility additionally requires the configured live holdout sample
minimum. A trained network, a passing first validation block, or a successful
container scan alone does not establish predictive superiority.

All output remains Binance Spot analysis-only. `paper_trading=true`,
`real_order_execution=false`, and `confidence_score=UNKNOWN` remain enforced
until the full predictive and paper-trading gates have passed. No change to
these safety gates is implied by the selection fallback.


Regression fixture: a regime with zero positive local selection outcomes may use the pooled selection window, while its own validation and holdout remain regime-specific and later in time.

The sparse-regime regression requires fewer than three local positive selection outcomes before using pooled chronological selection; it does not require a zero-positive local slice.
