# EARLY_EXPANSION_RADAR — Radar 8 «البرق»

## Mission
Discover measurable accumulation of evidence before a large expansion instead of ranking coins only after the move is visible.

## API
`GET /api/early-expansion-radar?quote=USDT&limit=100`

Optional:
`scan=1` requests an immediate scan when the background radar is already running.

The response exposes:
- `expected_total` — symbols expected from exchangeInfo
- `received_total` — symbols received in ticker/24hr
- `missing_ticker_total`
- `eligible_total`
- `fast_scanned_total`
- `scanned_total`
- `deep_scanned_total`
- `skipped_total`
- `failed_total`
- `coverage_ratio = received_total / expected_total`
- `eligible_coverage_ratio`
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


## REST rate limiting
Radar 8 uses a serialized REST request queue. Endpoint REQUEST_WEIGHT is accounted for before each request and response headers `X-MBX-USED-WEIGHT-1M` are consumed when available. HTTP 429 and 418 responses establish explicit backoff windows; repeated requests are not fanned out across Binance base URLs after a rate-limit response.

Current Spot REST weights used by the implementation include: exchangeInfo 20, klines/uiKlines 2, depth 5/25/50/250 by limit tier, and ticker/24hr 2 for one symbol or 1–20 symbols, 40 for 21–100, and 80 when no symbol or 101+ symbols are requested. The local client reserves a safety margin under the 6,000 REQUEST_WEIGHT/minute policy.
