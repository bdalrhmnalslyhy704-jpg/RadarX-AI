# Build 224 — Daily Early-Riser Forward Shadow Runner

This is a research-only, append-only capture and scoring path. It does not send orders, alter RadarX deployment settings, or approve a model for production.

## 1. Create paired forecasts

The neural benchmark report must have status `COMPLETED_RESEARCH_ONLY` and contain an enabled `shadow_model_export` for the target. The exported bundle binds the selected MLP weights, same-window logistic weights, target, 35-feature schema, training cutoff, training-data SHA-256 and source-code commit.

Prepare `daily-forward-observations.jsonl` from the live scanner. Each line is one *closed* 15-minute baseline observation:

```json
{
  "schema": "RADARX_DAILY_FORWARD_OBSERVATION_V1",
  "symbol": "AAAUSDT",
  "at": 1800000899999,
  "feature_information_cutoff_at": 1800000899999,
  "recorded_at": 1800000901000,
  "observation_source": "BINANCE_OFFICIAL_CLOSED_15M_BASELINE",
  "baseline": {
    "openTime": 1800000000000,
    "open": 100,
    "high": 101,
    "low": 99,
    "close": 100,
    "closeTime": 1800000899999,
    "quoteVolume": 250000,
    "trades": 1000,
    "takerBuyQuoteVolume": 125000
  },
  "features": {
    "quote_volume_24h": 1200000,
    "volume_ratio": 1.5,
    "taker_buy_ratio": 0.61
  }
}
```

The real record must carry the full feature object produced by the Build 224 daily feature builder; the abbreviated example above only illustrates the envelope. A 24-hour USDT quote-volume value of at least 750,000 is mandatory. The baseline close time and feature-information cutoff must match exactly. Observations older than 30 minutes are rejected by default.

Run:

```bash
node phase2/tools/daily-early-riser-forward-shadow.mjs \
  --mode record \
  --model-report artifacts/daily-early-riser-neural-benchmark.json \
  --observations artifacts/daily-forward-observations.jsonl \
  --output artifacts/daily-forward-forecasts.jsonl
```

For a single target, add `--target 5`, `--target 10` or `--target 15`. The runner emits one MLP forecast and one same-window logistic forecast for each accepted symbol/baseline/target/model bundle. Repeated pair IDs are skipped. Writes are append-only.

## 2. Resolve after the 24-hour path closes

Prepare `daily-forward-closed-paths.jsonl` only from successful Binance Spot REST Kline responses. Each line must preserve the exact raw response body and its SHA-256:

```json
{
  "symbol": "AAAUSDT",
  "baseline_close_time": 1800000899999,
  "source": "BINANCE_SPOT_REST_KLINES_V1",
  "http_status": 200,
  "request_url": "https://api.binance.com/api/v3/klines?symbol=AAAUSDT&interval=15m&startTime=1800000900000&limit=96",
  "response_body": "[[...], ...]",
  "response_sha256": "<sha256 of the exact response_body bytes>",
  "recorded_at": 1800087300000
}
```

The response must contain the 96 consecutive 15-minute candles beginning immediately after the baseline. The runner checks the source, HTTP status, official endpoint, symbol, interval, start time, limit and response-body hash; the core resolver checks every candle's close time and continuity. A 451, 429, incomplete response, stale response or hash mismatch does not become a flat label; it remains unresolved and must be retried with valid official data.

Run:

```bash
node phase2/tools/daily-early-riser-forward-shadow.mjs \
  --mode resolve \
  --forecasts artifacts/daily-forward-forecasts.jsonl \
  --closed-paths artifacts/daily-forward-closed-paths.jsonl \
  --output artifacts/daily-forward-resolved.jsonl
```

The forecast ledger is never edited. Resolutions are appended to a separate file. Same-candle touches of both barriers remain `AMBIGUOUS` and are excluded from the binary Brier comparison.

## 3. Score the untouched forward sample

Find the target's `model_bundle_sha256` in the benchmark report under `target_results["5_PCT"].shadow_model_export.model_bundle_sha256` (change the target key for 10% or 15%).

```bash
node phase2/tools/daily-early-riser-forward-shadow.mjs \
  --mode score \
  --resolved artifacts/daily-forward-resolved.jsonl \
  --target 5 \
  --model-bundle-sha256 <64-character-model-bundle-sha256> \
  --output artifacts/daily-forward-score-5pct.json
```

The gate requires at least 150 paired resolved forecasts, a MLP Brier improvement of at least 0.003 over the paired logistic baseline, and a positive lower 95% confidence bound for the paired improvement. The score is separated by target and exact model-bundle hash so model versions cannot be mixed.

## Scope and limits

- Binance Spot USDT only; no futures, leverage, orders or live trading.
- Historical census results are not forward-shadow results. A new model-bundle hash starts a new forward cohort.
- This runner consumes scanner-produced observation JSONL and Binance REST response JSONL. It does not yet install itself in DHDTech or schedule the scanner. That runtime wiring must be reviewed and tested before this ledger can collect real forward samples.
- Even a passing forward Brier gate is not production approval. Net fees/slippage, positive net returns, maximum drawdown no greater than 8%, operational reliability and a separate shadow period remain required.
