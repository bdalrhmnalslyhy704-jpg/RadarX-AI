# EARLY_EXPANSION_RADAR — Radar 8 «البرق»

## Mission
Discover measurable accumulation of evidence before a large expansion instead of ranking coins only after the move is visible.

## API
`GET /api/early-expansion-radar?quote=USDT&limit=100`

Optional:
`scan=1` requests an immediate scan when the background radar is already running.

The response exposes:
- `universe_total`
- `eligible_total`
- `scanned_total`
- `skipped_total`
- `failed_total`
- `coverage_ratio`
- `deep_scanned_total`
- `deep_coverage_ratio`
- ranked candidates
- alert/event history
- monitoring health
- thresholds

## Decision bands
- `WATCH_EARLY`
- `PRE_EXPANSION`
- `BREAKOUT_DEVELOPING`
- `ALREADY_EXTENDED`
- `DATA_INSUFFICIENT`
- `HIGH_RISK_PUMP`
- `NO_SIGNAL`

## Evidence
The independent `early_expansion_score` combines:
volume acceleration, RVOL persistence, compression/expansion, breakout proximity, higher-low structure, buy/sell pressure, order-book imbalance, liquidity quality, volatility expansion, multi-timeframe alignment, market regime and data quality.

`confidence_score` remains `UNKNOWN`; this score is not a calibrated probability.

## Safety/data gates
No live score is allowed when:
- data is stale;
- future timestamps are present;
- candles/gaps are invalid;
- insufficient closed candles exist;
- liquidity is too weak;
- spread is too wide;
- the move is already extended;
- the timing cannot be established.

Only closed candles enter indicator analysis.

## Background behavior
The backend radar polls the market continuously on Railway through the existing backend service. It does not depend on the Android process staying open.

REST polling is the primary independent path for Radar 8; the design does not require bypassing Binance access restrictions.

## Paper-only policy
`paper_trading=true`
`real_order_execution=false`
`confidence_score=UNKNOWN`

Radar 8 never creates orders, withdrawals or account operations.

## Backtest discipline
The forensic replay uses historical closed Klines and explicitly refuses to fabricate historical order-book/news/Futures state. Precision, recall, false positives and lead-time claims require a larger walk-forward control sample before calibration.
