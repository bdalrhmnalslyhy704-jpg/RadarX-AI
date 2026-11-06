# TCN V6 validation policy — Build 224

- Target: +3% first passage before -2% within four hours using completed 15-minute Binance Spot USDT candles.
- The shared TCN ensemble is fitted only on the purged chronological training block.
- Mature histories reserve an untouched holdout of at least 2× the live sample floor and 25% of usable rows; medium histories reserve at least the live floor plus 30 rows and 20%. This preserves a broad later test while avoiding the former 40% holdout that unnecessarily reduced the training window.
- The shared temporal residual is fitted on the shared purged training block, while each BTC regime keeps a logistic anchor fitted only on its own training rows. Each regime selects the residual scale on its own later member-selection block. Candidate residual scales are 0%, 25%, 50%, 75%, and 100%.
- A separate later chronological calibration block fits the probability calibrator; it never reuses rows used to select a member or residual scale. The inner fit split adapts to available time blocks: small histories reserve about 80% for model fitting, medium histories about 70%, and mature histories about 78%; the remaining pre-validation rows are divided into non-overlapping member-selection and calibration blocks. The outer validation and untouched holdout remain separate and later.
- If a regime's calibration block lacks 30 rows, 5 positive labels or 20 negative labels, a disjoint later shared calibration block may be used. It remains before outer validation; no validation or final-holdout labels enter calibration.
- Probability calibration is fitted only from the separate later calibration block. Validation and final holdout are strictly later.
- Mature history reserves a wider inner validation block of at least 300 observations or 15% of matured labels (whichever is larger), to reduce regime-specific positive-class sparsity. Smaller histories retain the prior minimum-based validation allocation. This inner validation block does not overlap the untouched final holdout.
- Final predictive readiness requires the unchanged 0.003 Brier comparison margin against both the base-rate predictor and pooled logistic challenger on chronological validation and untouched holdout, plus the minimum live holdout sample size.
- A trained TCN or passing validation alone never constitutes predictive superiority.

Safety: Binance Spot analysis only; paper_trading=true; real_order_execution=false; confidence_score=UNKNOWN until all predictive and paper-trading gates pass.

## Brier-optimized residual training

The temporal residual network's final-layer gradient is derived directly from the
unweighted Brier objective, matching the reported selection, validation, and
holdout metric. Member choice and residual scale selection remain confined to the chronological
member-selection block; probability calibration uses only its separate later
calibration block. Validation
and final holdout are not used for optimization or tuning.

The public temporal profile exposes its training objective explicitly so runtime acceptance and the Android diagnostics can verify the exact Brier-optimized model version. Training-strategy V14 fits shared temporal residual weights on the common training block, with a separate training-only logistic anchor for each BTC regime. Selection, calibration, validation and final holdout remain chronologically disjoint. Each BTC risk regime therefore starts from the same type of linear challenger used in its own validation and holdout comparison; the TCN residual may add signal but cannot rewrite that anchor. No member selection, calibration, validation or holdout rows enter anchor fitting. All regime-specific sample support and Brier superiority margins remain unchanged.

## V5 nested residual-neural validation

V5 fits its logistic anchor and residual MLP only on the earliest 80% of the
bounded chronological training window. The remaining 20% of that window is a
separate member/residual-scale selection block. The model then receives an
outer chronological validation block and an untouched final holdout. Every
label must mature before its applicable cutoff; rows crossing a cutoff are
purged. The V5 member-selection Brier scores are reported separately from
outer-validation scores. The predictive superiority margin and readiness gates
are unchanged.
