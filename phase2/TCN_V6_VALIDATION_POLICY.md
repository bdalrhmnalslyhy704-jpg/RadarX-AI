# TCN V6 validation policy — Build 224

- Target: +3% first passage before -2% within four hours using completed 15-minute Binance Spot USDT candles.
- The shared TCN ensemble is fitted only on the purged chronological training block.
- Mature histories reserve an untouched holdout of at least 2× the live sample floor and 25% of usable rows; medium histories reserve at least the live floor plus 30 rows and 20%. This preserves a broad later test while avoiding the former 40% holdout that unnecessarily reduced the training window.
- The deployed TCN contract is one shared pooled residual ensemble trained only on the shared purged chronological training block, with one frozen pooled logistic anchor. It does not train independent TCN weights or choose a different TCN member per BTC regime. The supported BTC regimes receive separate outer-validation and untouched-holdout gates using the same shared TCN.
- TCN member and residual-scale selection use one later shared pooled selection block. The selected member and scale are frozen once and reused across supported regimes. Candidate residual scales are 0%, 10%, 25%, 50%, and 100% (`[0, 0.1, 0.25, 0.5, 1]`).
- TCN probability calibration uses a separate shared pooled block after member/scale selection. It requires at least 30 rows, 5 positive labels, and 20 negative labels. If pooled calibration support is insufficient, TCN probability readiness remains false; no regime-local calibration block is substituted for the shared TCN calibrator.
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

The current V6 TCN implementation supersedes the older V19/V22 description: mature histories use 60% of the fitted history for shared TCN fitting, 16% for pooled member/scale selection, and approximately 23.5% for shared calibration before the outer chronological validation. Medium histories use 55%/17%/27.5%; smaller histories use 50%/26%/22%. Regime-local partitions remain available for local training-only anchors and separate specialist diagnostics, but the TCN itself keeps the shared pooled training, selection, and calibration contract. The 0.003 Brier superiority margin and untouched final holdout gate are unchanged. No validation or holdout rows enter fitting, member selection, or calibration.

## V5 neural and hybrid challenger validation

V5 uses up to 1,500 newest purged training rows. Its pre-validation window is divided chronologically into 64% model fitting, 10% member/residual-scale selection, and 26% probability calibration plus hybrid-weight selection. The selected MLP member is refit on the union of the fitting and member-selection blocks; every refit label must mature before calibration begins.

The final 26% block is further divided into 55% calibration fitting, 23% disjoint calibration checking, and 22% dedicated hybrid blend-weight selection. The probability calibrator for each applicable model is fitted only on the first slice and accepted/rejected on the second. The final slice chooses among the predeclared GBDT/MLP blend weights `[0.25, 0.5, 0.75]`; it is not used to update either component or fit a calibrator. Only the single selected blend weight may enter outer validation. Outer validation selects the model family, and the final untouched holdout confirms that one winner without falling through to a runner-up.

MLP, GBDT, and logistic reference fits expose separate calibration diagnostics. A rejected calibrator leaves that model's raw probability unchanged. If any chronological block lacks the required sample/class support, the affected challenger remains ineligible rather than borrowing validation or final-holdout rows. Labels crossing any cutoff are purged.