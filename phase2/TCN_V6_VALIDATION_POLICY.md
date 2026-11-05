# TCN V6 validation policy — Build 224

- Target: +3% first passage before -2% within four hours using completed 15-minute Binance Spot USDT candles.
- The shared TCN ensemble is fitted only on the purged chronological training block.
- The BTC-regime member and residual contribution scale are selected only on the disjoint chronological selection block. Candidate residual scales are 0%, 25%, 50%, 75%, and 100%.
- If a regime's local selection slice has insufficient class support, the pooled selection block may be used only for member/scale selection. That fallback never pools the regime's validation or final holdout.
- Probability calibration is fitted only from the permitted selection block. Validation and final holdout are strictly later.
- Final predictive readiness requires the unchanged Brier comparison margin against both the base-rate predictor and pooled logistic challenger on chronological validation and untouched holdout, plus the minimum live holdout sample size.
- A trained TCN or passing validation alone never constitutes predictive superiority.

Safety: Binance Spot analysis only; paper_trading=true; real_order_execution=false; confidence_score=UNKNOWN until all predictive and paper-trading gates pass.

## Brier-optimized residual training

The temporal residual network's final-layer gradient is derived directly from the
unweighted Brier objective, matching the reported selection, validation, and
holdout metric. Member choice, residual scale selection, and probability
calibration remain confined to the chronological selection block. Validation
and final holdout are not used for optimization or tuning.

The public temporal profile exposes its training objective explicitly so runtime acceptance and the Android diagnostics can verify the exact Brier-optimized model version.
