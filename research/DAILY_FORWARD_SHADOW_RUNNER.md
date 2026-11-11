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

## 4. Build 224 runtime integration (explicit opt-in)

The research branch also contains an optional runtime sidecar inside the existing Adaptive Trader worker. It uses the same live candidate scan, but it records forecasts only; it does not change candidate scores, analyst decisions, alerts, paper positions or order gates.

The latest verified model package is published by the GitHub Actions workflow **Build 224 Daily Shadow Model Bundle Verification**. Download the artifact named `radarx-build224-daily-shadow-model-verification-9` from [run #43075556756](https://github.com/bdalrhmnalslyhy704-jpg/RadarX-AI/actions/runs/43075556756), and place `daily-forward-shadow-model-bundles.json` on the DHDTech persistent data volume used by RadarX. The package contains the complete MLP and logistic weight objects for each enabled target, not just their hashes. The runtime rechecks the feature schema and bundle identities when it loads the file.

To request activation after this research change has been reviewed, merged through the intended release process and deployed to DHDTech, set:

```text
RADARX_DAILY_EARLY_RISER_FORWARD_SHADOW_ENABLED=true
RADARX_DAILY_FORWARD_SHADOW_MODEL_BUNDLE_PATH=<absolute path to daily-forward-shadow-model-bundles.json>
```

The path variable is optional when the file is named `daily-forward-shadow-model-bundles.json` in the same persistent directory RadarX uses for its durable store. The feature is disabled unless the first variable is exactly `true`. A missing or invalid bundle disables only this research sidecar and is logged; it must not prevent the rest of RadarX from starting.

At runtime, the sidecar accepts only fresh candidates with a valid closed 15m baseline and a continuous 96-bar daily feature window. It records at most four new symbols per Adaptive Trader cycle and attempts at most one matured 24-hour path per cycle through a dedicated, bounded public Spot REST client. The paired forecasts and resolutions are stored in two append-only files in the durable store:

- `daily-forward-shadow-forecasts.jsonl`
- `daily-forward-shadow-resolved.jsonl`
- `daily-forward-shadow-market-paths.jsonl`

The sidecar's status is exposed in the Adaptive Trader worker snapshot as `daily_forward_shadow`. A cycle failure or Binance 451/429 does not fail the existing Adaptive Trader scan; an invalid, incomplete or gapped 96-candle path remains pending rather than being assigned FLAT. Each successfully validated 96-candle Binance response is stored once in `daily-forward-shadow-market-paths.jsonl` with its exact request URL, raw response body, HTTP status, timestamp and SHA-256. On restart or recovery from a partial resolution write, the sidecar reuses this immutable path and only appends the missing outcome row; it does not need to download the same path again.

## Scope and limits

- Binance Spot USDT only; no futures, leverage, orders or live trading.
- Historical census results are not forward-shadow results. A new model-bundle hash starts a new forward cohort.
- The code is integrated only on this unmerged research branch. No DHDTech deployment has been performed and the opt-in flag has not been enabled, so no real forward forecasts have yet been collected.
- Forward evaluation still requires at least 150 paired resolved observations per target, a MLP Brier improvement of at least 0.003 over the paired logistic baseline and a positive lower 95% confidence bound.
- Even a passing forward Brier gate is not production approval. Net fees/slippage, positive net returns, maximum drawdown no greater than 8%, operational reliability and a separate shadow period remain required.
