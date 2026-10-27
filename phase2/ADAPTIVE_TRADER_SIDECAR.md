# RadarX Adaptive Trader Sidecar — Build 224

This is an additive, isolated sidecar. The existing twelve RadarX radar implementations, the twenty-analyst review path, their notification thresholds, and their settings are not modified by the sidecar engine. Integration adds one navigation card, one read-only market-snapshot API route, and a separate REST client.

## Runtime architecture

- Android asset: android/app/src/main/assets/adaptive-trader.html
- Local browser-memory and paper-portfolio helpers: android/app/src/main/assets/adaptive-trader-client.js
- Independent backend analysis: phase2/core/adaptive-trader-engine.mjs
- Read-only API: GET /api/adaptive-trader/market-snapshot?limit=40|80|120
- Data source: Binance Spot public REST. No exchange key is accepted or stored.
- The screen refreshes about every five minutes only while it is visible; opening the screen performs the first scan.

## Market analysis v1

The sidecar ranks eligible Spot USDT symbols using the selected universe's 24-hour quote volume (minimum 750,000 USDT), closed 15-minute candles, relative candle volume and trade count, taker-buy share, close location, higher lows/local close-confirmed breakout, volatility compression, one-hour movement, and relative strength against BTC when that benchmark is fresh and contiguous. It ignores open/future candles and declines to call a move early when the asset is already extended or deeply down on the day.

The initial scan reviews the highest-volume 40, 80, or 120 eligible pairs, not every eligible pair. universe.coverage_pct, analyzed count, valid count, and the scan_complete flag disclose the scope. A valid live response is not proof that every pair was analyzed or that the ranking predicts profitable outcomes.

## Learning and missed-move review

The learning memory is browser-local on this device. It records price/feature snapshots; after at least four hours it labels observed outcomes (up at least 2%, down at most -2%, or flat between them). Calibration remains disabled until 30 outcomes are resolved and at least three feature buckets have eight examples each. It adjusts ranking scores by no more than four points. It does not rewrite program code, change entry gates, or modify the original RadarX detectors.

The missed-move audit begins after this screen starts collecting snapshots at least 15 minutes apart. It identifies a potential missed move only when there is a prior analyzed snapshot that was not in WATCH or EARLY_SETUP. Symbols without a prior analyzed snapshot are labelled UNASSESSED_MOVE. This is not a reconstruction of all historical market opportunities before installation.

## Paper portfolio

The optional client-side paper simulator uses a fictional balance of 10,000 USDT by default, up to three simultaneous positions, a maximum 5% of marked equity per position, a modeled +3% take-profit, -2% stop-loss, and four-hour time exit. It estimates 0.30% round-trip cost but does not simulate true queue position, spread, market impact, API latency, or all exchange execution constraints. Results are experiments, not an assurance of profitability.

Execution invariants:
- paper_trading: true
- real_order_execution: false
- No signed trade endpoints, API keys, futures, leverage, transfers, or withdrawals.
- Calibration and paper results stay separate from existing RadarX alert/notification state.

## Validation

adaptive-trader-sidecar.yml runs syntax checks, candidate/scoring and learning tests, missed-move classification, paper risk controls, API fail-closed tests, dashboard contract tests, and targeted existing RadarX regression suites. Release and live-phone notification proof must be performed separately after integration; this CI cannot establish profitability or confirm receipt on a physical device.
