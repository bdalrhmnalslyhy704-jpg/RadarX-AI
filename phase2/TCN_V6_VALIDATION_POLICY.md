# TCN V6 validation policy — Build 224

- Training target: first passage +3% before -2% over four hours using completed 15-minute Binance Spot USDT candles.
- The shared TCN ensemble is fitted only on the purged chronological training block.
- The positive-class weight is capped square-root inverse frequency and is computed from training labels only. Validation and holdout remain naturally imbalanced and are scored without weights.
- Member choice and probability calibration use only the disjoint chronological regime-selection block. A pooled selection fallback may be used only when a regime's own selection slice lacks class support; it never pools that regime's validation or final holdout.
- Validation is later than training and selection. Final holdout is later than validation and is never used for fitting, member selection, calibration, early stopping, or hyperparameter changes.
- Predictive readiness requires the unchanged Brier margin against both the base-rate predictor and pooled logistic challenger on validation and untouched holdout, plus minimum live holdout support.
- Training completion, a passing validation slice, or a successful scan alone never authorizes probability output or trading.

Safety: Binance Spot analysis only; paper_trading=true; real_order_execution=false; confidence_score=UNKNOWN until the full predictive and paper validation gates pass.
