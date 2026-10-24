# Build 224 — Pre-Move Detection and Reliability Plan

## Mission
Make RadarX useful at finding Binance Spot USDT pairs that are *starting* to strengthen, before a large move where evidence permits, while showing uncertainty honestly and never fabricating a live signal. This is an engineering plan and acceptance contract, not a promise that every future price rise can be predicted.

## Non-negotiable runtime and trading invariants
- Build 224 branch lineage only: `build224-multi-analyst-20261007`.
- DHDTech.io Cloud is the deployment target.
- Public Binance Spot market data, USDT quote pairs, read-only monitoring.
- `paper_trading=true`; `real_order_execution=false`; no order-placement client, futures, leverage, or private trading endpoints.
- Closed candles only for candle-based confirmation. Do not label stale, incomplete, future-dated, cached-only or synthetic data as LIVE.
- Status vocabulary remains explicit: `LIVE_DATA`, `PARTIAL_DATA`, `DATA_STALE`, `DATA_UNAVAILABLE`, `OFFLINE`.
- When data is missing, preserve “unknown”; do not coerce it to a numeric zero and silently treat it as known.
- Keep push delivery separate from signal creation. An eligible signal must still be visible in the API/feed if push delivery fails.

## Intended detection pipeline

### 1. Full-market discovery and coverage
1. Build the eligible universe from live Spot exchange metadata, excluding inactive/non-USDT/non-directional instruments where appropriate.
2. Read the broad public ticker feed first, then update short-term per-symbol observations for price, quote-volume increments, trade-count increments and their acceleration.
3. Prefer the public market-data WebSocket. Fall back to public REST within a bounded request budget; use cache only when its age and source are explicit.
4. Maintain fair rotation so busy symbols cannot permanently starve symbols that have never received Micro/Deep analysis.
5. Expose expected, received, eligible, Micro-scanned, Deep-scanned and failed counts, plus the oldest-waiting candidates and each deferral reason.
6. Test the under-floor burst lane separately. It may grant a *scan*, never bypass evidence, anti-chase, data-quality or final notification gates.

### 2. Early-move feature evidence
Evaluate independent, interpretable features rather than one opaque score:
- **Price structure:** volatility/range compression, higher lows, reclaim of local levels, distance to prior resistance, breakout/retest integrity.
- **Participation:** quote-volume and trade-count ratio against that same symbol's own recent baseline; prefer rising participation before price acceleration.
- **Buyer pressure:** taker-buy share, change from baseline, and whether price closes well in the candle range. Missing taker data is “unknown”, not bearish or bullish.
- **Relative strength:** short-window return relative to BTC and broad market regime.
- **Market quality:** valid closed candles, data freshness, quote volume, spread and book availability where provided.
- **Anti-chase and risk:** 1m/5m/15m/1h extension, wick/fakeout risk, sharp prior 24h movement, and liquidity risk. An extended move can remain visible as “already extended”, but must not be relabeled as a pre-move setup.
- Score and thresholds must remain auditable by feature, threshold, source timestamp and rejection reason.

### 3. State machine and signal semantics
- `DATA_INSUFFICIENT`: required observations, candle sequence or freshness is missing.
- `WATCH_EARLY`: a credible change is present, but not enough evidence for an actionable alert.
- `PRE_EXPANSION`: a compressed base is supported by rising participation or other independent evidence.
- `BREAKOUT_DEVELOPING`: local level/acceleration is developing but continuation is not yet confirmed.
- `CONTINUATION_CONFIRMED`: closed-candle structure and participation confirm the move; still not a promise of future profit.
- `ALREADY_EXTENDED` / `ANTI_CHASE`: retain as a risk/forensics observation, not a late “early” alert.
- `CANCELLED`: the pattern failed, evidence reversed, data expired or quality gate failed.
- Keep watch-only notifications distinct from actionable signal notifications and label them clearly in Arabic and in the API payload.

### 4. Radar suite and 20-analyst design
- Keep all 12 radars active and independently observable; one worker's failure must not silently disable the rest.
- Each radar owns a defined hypothesis and input evidence. Avoid having every radar emit the same generic momentum signal.
- The 19 specialist analysts should independently assess data quality, price structure, participation, buyer/seller flow, liquidity/spread, relative strength, compression, breakout/retest, trend/regime, volatility, fakeout/manipulation risk, anti-chase, historical outcomes, cross-radar corroboration, strategy fit, risk, source consistency, timing and notification readiness.
- The 20th/final analyst merges the specialist evidence, detects disagreement and missing evidence, and returns an explicit decision plus reason codes. Analysts cannot manufacture missing data or override safety/anti-chase gates.
- During implementation, verify the actual runtime registration count and names from the code and health endpoints; a UI label alone is not proof that every analyst ran.

### 5. Feedback loop: missed movers and false positives
- Persist each scan journey with symbol, observed-at timestamps, source, per-stage scores, candidate lane, features, gates, selected/deferred reason and final disposition.
- Record forward markouts at 5m, 15m, 1h and 4h, without using future candles in the original signal. Define outcome labels and fees/slippage assumptions before reporting performance.
- “Missed mover” audit: after a move crosses a configurable threshold, inspect earlier available snapshots and report whether the symbol was absent from the universe, missing from ticker data, starved from Micro/Deep, rejected by a feature, blocked by data quality, or rejected as extended.
- “False-positive” audit: distinguish a failed setup, a signal that arrived late, a push-delivery failure, a bad/stale data event, and a move that simply did not follow through.
- Adjust thresholds only from replay/forward evidence; do not lower all thresholds at once just to increase alert volume.

**Build 224 implementation note (missed-mover audit):** The GET /api/radar-missed-movers endpoint reads retained, completed Radar 8 full-market Scan Journey snapshots and cross-checks them against a bounded recent tail of each of the 12 radar alert archives. It reports sampled threshold crossings, whether a recorded alert preceded the observed crossing, and the scan-stage/defer reason actually stored. Missing/unreadable archives or a saturated 2,000-row archive tail force PARTIAL_ARCHIVE_COVERAGE and set the miss counts invalid. Because the full-universe baseline currently uses sampled ticker prices, not a continuous trade tape or complete closed-OHLC history for every symbol, extrema are explicitly OBSERVED_SNAPSHOT_PROXY_NOT_CLOSED_OHLC; this endpoint is a first feedback-loop instrument, not proof of full-market recall, exact highs/lows, or profitability.
- Report precision, recall on the *defined labeled sample*, lead time, missed-mover causes, alert volume, and follow-through by radar. Never imply these sample metrics guarantee future detection.

### 6. Notifications and Android integration
- Verify the backend's signal store/feed independently of FCM.
- Verify Android token registration, backend subscription mapping, FCM credentials, provider health, send response and device receipt as separate checkpoints.
- Keep an auditable delivery status such as queued/sent/failed; retry safely without duplicate signal creation.
- Test the installed Build 224 app against the actual deployed API contract, including unavailable/stale data states. A green GitHub build does not prove device delivery.

### 7. Resource and timing budgets
- Keep runtime inside the DHDTech small container budget (0.5 CPU / 512 MB), with the existing RSS guard target of 0.360 GiB.
- Target a healthy completed market scan cycle under 45 seconds where exchange quotas and data availability permit; report over-budget cycles honestly instead of overlapping scans.
- Bound REST concurrency, queues, retained histories and archive growth. Back off on rate limits and expose the reason.
- Never trade data integrity for a green health light or a faster cycle.

## Required acceptance gates before a release is called live-verified
1. Unit tests: missing/null/blank/non-finite numbers remain missing; zero is preserved as a valid numeric value.
2. Detector tests: quiet base with increasing activity; flat-volume negative case; buyer-flow transition; confirmed breakout; fakeout; low-liquidity burst; extended/anti-chase; stale and gapped candles.
3. Coverage tests: fair rotation eventually scans every eligible symbol, queue age decreases after a successful Deep scan, and the under-floor lane cannot directly create an actionable signal.
4. Historical replay: use only data available at each decision time; publish sample size, label rules, precision/recall and lead-time distributions.
5. Integration: all 12 radars report started/healthy or a concrete error; the analyst swarm reports each specialist and the final analyst's run status.
6. Push: an eligible test event reaches the real Build 224 device, and failed delivery is visible without creating false “sent” status.
7. Production smoke: deployed commit matches the tested commit; API reports fresh live data and non-zero scan activity; DHDTech logs show no silent worker shutdown; resource budgets remain safe.

## Current work / status
- The DHDTech entrypoint autostart fix exists on the Build 224 branch lineage and explicitly keeps paper trading on and real order execution off.
- This plan is now checked into the repository to keep the target and acceptance criteria durable.
- A first missed-mover audit endpoint and regression suite are implemented on PR #335: GET /api/radar-missed-movers. The exact-head Phase 1/2 test suite passed on commit 84d3d8c9596629b64eb11c20ce664dedf50ff1b5, including the endpoint integration test and five audit-unit tests. This proves the code/test contract only; the production-aligned replay gate for the latest head is not yet confirmed, and the retained Radar 8 sample proxy is not equivalent to independent full-market closed-OHLC recall.
- The overall plan remains NOT_LIVE_VERIFIED until the 12-radar periodic health/cycle evidence, 20-analyst role execution evidence, live DHDTech commit/health and fresh-data smoke, and real physical-device push receipt are separately verified. Do not interpret a green CI result as proof of those runtime conditions.
- The numeric-input normalization change in this change set prevents null/blank values from becoming zero in the early-move/radar-8 paths.
- Repository tests and CI must pass before this change is merged. After deployment, live DHDTech and real-device push still require separate verification; CI alone is not proof of either.
