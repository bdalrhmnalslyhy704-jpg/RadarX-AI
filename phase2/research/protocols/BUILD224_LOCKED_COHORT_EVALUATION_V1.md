# Build 224 — Locked Out-of-Time Cohort Evaluation Protocol V1

**Protocol status:** PREDECLARED — NOT EXECUTED  
**Model status:** NOT QUALIFIED; Logistic remains the accepted fallback  
**Execution policy:** paper-only; real order execution disabled  
**Scope:** evaluation of one frozen candidate against one frozen Logistic anchor on the separate `PROSPECTIVE_COHORT_V1` artifact.

This protocol is deliberately separate from model development. It does not authorize training, calibration, threshold tuning, candidate selection, outer-validation replay, or holdout access.

## 1. Immutable cohort identity

The cohort must pass its collection workflow and all of the following checks before any scores or labels are opened:

- Schema: `RADARX_BUILD224_BINANCE_SPOT_4H_FIRST_TOUCH_PROSPECTIVE_COHORT_V1`.
- Contract state: `LOCKED_UNSCORED`.
- Role: `RETROSPECTIVE_OUT_OF_TIME_BACKFILL_ONLY`.
- Start boundary: `2026-11-18T00:14:59.999Z`, strictly after the legacy last label maturity at `2026-11-17T20:14:59.999Z`.
- Legacy cohort SHA-256: `f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77`.
- Collection source SHA: `0cf4beaebf9a8ff6e85d3107c70b2fd790c2b2ef`.
- Required: every selected eligible crypto Spot USDT symbol accounted for; all required interval archives verified; no incomplete raw archive accepted; canonical dataset hash verified; encrypted payload and wrapped key verified.

The final cohort SHA-256, exact decision count, included-symbol count, row count, and encrypted-artifact digest must be copied from the successful collection/verification report. They are intentionally not guessed here.

**Interpretation limit:** this dataset is a historical Binance backfill collected after the legacy label-maturity boundary. It is out-of-time relative to the frozen legacy cohort, but it is not live-forward observation and must never be described as prospective live validation. Current-universe collection also retains survivorship risk because historical delisted assets are not included.

## 2. Frozen candidate and Logistic comparison

No candidate may be retrained or reselected using the locked cohort.

Frozen legacy research references:

| Component | SHA-256 / identity |
|---|---|
| Hurdle V2 artifact content | `9f7e08c75d388588603e3847c63a4c216983b36fffa8d2245850a70ca83c2206` |
| Hurdle V2 artifact manifest | `9fed9fee8e0eb832fb3c4d40900a782f3f53a637e263eb5d5c1093cc6da3231` |
| Ordered ranker artifact content | `0e846029aec3e4467d4d791b3a27689d32288ad8dd6b6fe6a4991d6a0dc9101a` |
| Ordered ranker artifact manifest | `7befe375c252f3bcb21c6fc84fbb7072ab7d9811ba3fa1fc2a1721d59b7260c2` |
| Training code commit | `4c6f8c6446ee16080f123681b3066455477eb524` |
| Legacy dataset SHA | `f9923205db04e0356b0df078c138b8862987b42bbf81b7e329d29179392f8a77` |

The current Hurdle artifact declares that contextual inference requires external temporal Logistic logits and consumes a TCN-LSTM representation plus additional score contexts. The Hurdle/ranker pair alone therefore does **not** close the complete inference dependency chain.

Before unsealing the cohort, a separate dependency manifest must pin the exact hashes and schemas of:
1. the upstream TCN-LSTM encoder/classifier that produces the pooled latent state and neural-classifier score;
2. the Logistic anchor scorer;
3. the purged temporal Logistic CV scorer;
4. the independent ordered return ranker;
5. the Hurdle V2 contextual/pooled heads.

A fresh-process integration probe must load that exact bundle and reproduce deterministic output probes. A Hurdle-head-only reload probe is not an end-to-end inference test. If any required scorer cannot be identified and hash-pinned, evaluation is blocked and the cohort remains locked.

## 3. Frozen execution policy

The only rank-score threshold eligible for this evaluation is the raw score threshold selected on the legacy inner-selection partition:

- Raw rank score threshold: `1.559563724215137`.
- Top-K: 1 candidate per 4-hour decision.
- No-entry/abstention: preserve the frozen raw score threshold; do not recompute a quantile on the locked cohort.
- Pair evidence definition for diagnostic ranking metrics: `PROFITABILITY_BOUNDARY_V1`, 30 bps round-trip cost, minimum net-return gap 0.50 percentage points, maximum 16 pairs per 15-minute timestamp.
- Execution cost: 30 bps round trip, applied exactly once.
- Portfolio simulation: preserve the frozen event-driven first-touch contract, position fraction, concurrency limit, and adverse/favorable same-timestamp ordering from the legacy implementation.

The 85th-percentile threshold was selected from 130 legacy inner-selection decision groups and produced 20 trades there. That inner result is exploratory, not proof. The raw threshold above is frozen solely to prevent retuning after the new cohort is opened.

## 4. Evaluation order and metrics

Once Sections 1–3 pass, execute one deterministic, read-only scoring pass:

1. Verify feature schema, ordering, closed-candle chronology, and dependency hashes in a fresh process.
2. Generate candidate and Logistic outputs on exactly the same new-cohort rows and timestamps.
3. Report Brier, log loss, PR-AUC, and all support counts for the classifier.
4. Report profitability-boundary pairwise accuracy and pairwise log loss on identical pairs, both pooled and by UTC-day/decision-time block.
5. Apply the frozen raw score threshold and the existing event-driven execution simulator.
6. Construct the Logistic comparator with the existing matched-decision/matched-trade-count rule; do not tune its threshold on the new cohort.
7. Report net PnL after the declared 30 bps cost, win rate, drawdown, trade count, abstention rate, exposure, and every rejected or skipped event.

No new model, threshold, calibration method, Top-K, feature, cost, risk penalty, or candidate may be selected from these results.

## 5. Non-negotiable acceptance rules

All of these are required for an execution-positive result:

- At least 20 completed trades.
- Win rate at least 55%.
- Net PnL strictly greater than zero after the declared costs.
- Maximum drawdown no greater than 8%.
- Candidate executed trade count exactly matched to the Logistic comparator.
- Candidate net PnL strictly greater than Logistic and candidate drawdown no worse than Logistic.
- Pairwise ranking accuracy strictly greater than Logistic and pairwise log loss strictly lower than Logistic.
- No missing outcomes, unverified archives, dependency mismatch, or chronology failure.

For a claim of statistically supported profitability, additionally report a paired block-bootstrap confidence interval using decision-time/UTC-day blocks. A lower 95% confidence bound for net return that is not above zero means the evidence is not statistically conclusive, even if the point estimate passes the legacy gates. The 20-trade floor is a minimum operational gate, not a guarantee of statistical power.

If the cohort produces fewer than 20 trades under the frozen policy, the execution result is **INCONCLUSIVE — INSUFFICIENT TRADE SUPPORT**. Do not lower the threshold, increase activity, or retune the policy to force a pass. Continue collecting genuinely forward paper observations under the same frozen model/policy instead.

## 6. Cohort-size limitation

The collection begins on 2026-11-18 and the workflow started on 2026-11-27. At that time, the 4-hour schedule was expected to contain approximately 57 decision groups (the final persisted schedule is authoritative). The legacy inner-selection policy selected 20 trades from 130 groups at a 15.38% selection rate. At that same historical rate, 57 groups would yield only about 9 trades.

Therefore this backfill can support a useful out-of-time ranking/probability diagnostic, but it is not expected to meet the 20-trade execution gate at the frozen policy. An insufficient-trade result must remain inconclusive; it must not be repaired by changing the frozen threshold. A longer forward paper observation window is required for the final execution-proof stage.

## 7. Stop conditions and safety

Stop and keep the cohort locked on any of the following:
- dataset or raw-archive hash mismatch;
- incomplete symbol/row accounting;
- missing or mismatched model dependency hash;
- input schema/order mismatch;
- any attempt to train, calibrate, tune, or select on the cohort;
- any outer-validation or holdout access not separately authorized.

Paper trading stays enabled for research only. Real order execution, leverage, withdrawals, and live capital use remain disabled. A failed or inconclusive result retains Logistic as the fallback and does not authorize promotion.

**Protocol outcome before execution:** PREDECLARED, PENDING COHORT VERIFICATION AND COMPLETE INFERENCE-DEPENDENCY CLOSURE.
