# RadarX Build 224 — Stabilization and Release Roadmap

**Scope:** Build 224 only; branch `build224-multi-analyst-20261007` remains the release base. Do not switch to Build 230, `main`, or an older build. Do not create another DHDTech service, database, or volume for this plan.

## Safety and release invariants

- Public Binance Spot USDT market data only. No mock prices, no stale data presented as live, no futures execution.
- `paper_trading=true`, `real_order_execution=false`, and `confidence_score=UNKNOWN` remain enforced.
- A WATCH or PRE_EXPANSION observation is not a buy instruction; no signal is treated as proof of profit.
- Do not rebuild/redeploy merely because a warning appeared. Collect evidence, fix the common root cause, run gates, then deploy the existing service once.
- Do not publish an APK until the API endpoint used by the APK is the actual, live Build 224 deployment and its endpoints pass the release contract.

## System definition

- **12 independent radars:** Early Move, Strong Move, Rotation Lag/Joker, Liquidity Absorption/Sweeper, Kahir, Doomsday, Al Muqawim/Resilience, Early Expansion/Lightning, Falcon Eye/Hawkeye, Coin Hunter, Whale Accumulation, Professor.
- **20-persona analysis layer:** 19 named specialists plus the final judge (20 total), with explicit data-integrity, completeness, liquidity, anti-chase, and trap gates.
- The specialist engine must return all 19 unique role outputs and a separate final decision. Missing evidence must remain unavailable; never synthesize a positive score from absent data.

## Evidence captured from the October 21, 2026 DHDTech runtime logs

| Area | Observed | Interpretation / next action |
|---|---|---|
| Spot universe | 506 expected, 506 received, zero missing | Ticker coverage was complete for that cycle. |
| Radar 8 eligibility | 228 eligible, 228 fast-scanned, 18 micro-scanned, 5 deep-scanned, zero scan failures | Broad scan worked; deep analysis is intentionally selective, but selection fairness and wait-time are release metrics. |
| Kline cache | 222/228 ready in one snapshot; a later warmup brought it to 228/228 with zero failures | Cache warmup eventually recovered; readiness must be checked after warmup, not inferred from a partial snapshot. |
| Binance Kline WebSocket | LIVE, 228 subscribed, 0 reconnects in the shown interval | This validates the market-wide Kline socket for that interval only; it does not prove the separate early-move ticker socket is healthy. |
| REST errors | `MOVE_RECONCILE This operation was aborted` and `DOOMSDAY_RADAR_tick This operation was aborted` | Common REST transport/timeout problem is plausible. Use fallback hosts, prevent overlapping reconciliation, and confirm actual source/fallback from logs. |
| Cycle duration | Radar 8 examples around 52s and 77s against a 20s cadence | Cycle overruns are real and need profiling; do not blindly raise concurrency or claim the target is met. |
| Memory | Post-GC RSS about 0.240–0.257 GiB versus a 0.360 GiB target | Memory stayed below the observed target in these samples; keep tracking p95/peak, not just one post-GC reading. |
| Light-scan microstructure | Spread and depth availability were both 0 for the 228-symbol light-scan sample | The light layer did not have live book/depth evidence at that moment. Keep such fields explicitly unavailable and let deep gates reject unsupported conclusions; investigate coverage before relying on order-book claims. |
| Outcomes | Archive was healthy, with no missing/corrupt files; only a small number of emitted signals had outcome tracking in this snapshot | Check that emitted signals are tracked to complete 5m/15m/30m/60m/4h/24h outcomes. Do not count non-signals as missed outcomes without inspecting the ledger contract. |
| APK release | The current release workflow still checks the legacy Railway host and its `/api/early-expansion-radar` endpoint returned HTTP 404 | APK/backend URL migration is a release blocker until the real public DHDTech backend URL is confirmed and wired into the Android allow-list, website CORS, and CI endpoint gate. Do not guess the host. |

## Execution plan and gates

### Gate 0 — Transport recovery (current patch)

1. Keep the supported `!miniTicker@arr` feed, derive the 24h change from current/open price when the mini-ticker omits the percentage, and retain trade counts only from a real REST ticker snapshot.
2. Keep both public Spot REST endpoints in the default fallback list even when a primary URL is configured.
3. Coalesce reconciliation calls so slow ticks cannot start overlapping full-universe REST refreshes.
4. Require endpoint smoke tests and unit tests for primary timeout → fallback success, both-endpoints failure, and no duplicate reconciliation.
5. Do not mark the live service healthy until REST, early-move ticker WS, and Kline WS are independently verified from the running container.

### Gate 1 — Runtime integrity

- On startup, verify the persistent archive path is writable and identify the exact Build 224 commit/branch from runtime metadata.
- Confirm all 12 radars are registered and running; collect recent cycles, errors, and telemetry for every radar.
- Confirm every signal has source, source timestamp, freshness, closed-candle quality, data and liquidity quality, rejection reasons, and the paper-only safety fields.
- Missing/stale/incomplete data means WATCH/REJECT/UNAVAILABLE, never LIVE_DATA.

### Gate 2 — Timing and load

- Record per-phase p50/p95 and overlap counts over at least 30 consecutive cycles.
- First remove duplicate work: coalesced REST calls, cached closed klines, bounded per-radar queues, no concurrent full-universe ticker refreshes.
- Preserve rotation fairness so low-ranked eligible symbols are not permanently starved; alert on oldest pending symbol and queue age.
- Do not increase worker concurrency unless measurements show spare request-weight budget and RSS margin.
- Release targets: no skipped/overlapping scans that corrupt state; p95 cycle time below 45s and improving toward the intended cadence; RSS peak under 0.360 GiB; zero unresolved transport aborts over the validation window.

### Gate 3 — Market coverage and microstructure

- Validate the full Spot USDT universe and ticker reconciliation.
- Require current closed candles with contiguous timestamps for any multi-candle feature; open candles may update cache but must not qualify as closed evidence.
- Expose per-symbol reasons for invalid/gapped/incomplete candles and for missing spread/depth.
- For signals that claim absorption or order-book pressure, require fresh book/depth values. If unavailable, report UNKNOWN and reject entry-eligible status.
- Require warmup to reach the defined coverage gate before declaring the cache fully ready. Confirm all 228/eligible symbols are ready in the same readiness snapshot.

### Gate 4 — 12-radar audit

Use the specialization contracts in `RADAR_SPECIALIZATION_BUILD224.md`. For each radar, replay real closed historical candles over positive cases, false positives, failed breakouts, missed moves, thin liquidity, stale data, and broad-market regime changes.

For each radar track: eligible symbols, fast/micro/deep selection, queue age, valid-data ratio, accepted and rejected counts, top rejection reasons, duplicate alerts, cycle p50/p95, and outcome-complete rate. A radar passes only its own role-specific gates; do not merge twelve differently defined detectors into a single generic score.

### Gate 5 — 20-analyst audit

The existing engine defines 19 named specialists and a distinct final judge. Verify:
- exactly 19 unique, non-placeholder specialist IDs and roles for every completed analysis;
- final judge reports a decision and all hard-gate reasons;
- any analysis failure is marked invalid and rejected, not filled with synthetic specialist outputs;
- missing evidence coverage and source timestamps are displayed;
- outcomes calibrate analyst weights only after the outcome horizon is complete;
- false positives, missed rises, and late/chased entries are reviewed separately.

Track signal quality by regime and horizon. Do not advertise profitability or use confidence percentages until historical evaluation is complete, sufficiently sampled, and free from leakage.

### Gate 6 — Web/PWA + Android release contract

1. Confirm the actual public URL of the existing DHDTech backend service. It must not be guessed from the service label.
2. Replace legacy Railway-only endpoint assumptions in the Android client/release workflow with the confirmed Build 224 backend URL while preserving strict HTTPS origin allow-listing.
3. Set allowed origins to the actual web/PWA origin(s), and verify CORS preflight and authenticated API requests.
4. Test `/healthz`, `/readyz`, radar status, each radar API contract, early-expansion schema, market coverage, and signal data-status from the same public host.
5. Build the signed APK only after all live API gates pass. Confirm package `com.radarx.app`, Build 224 branch/commit, notification setup, online/offline startup, background polling, and no real order execution.
6. Install the APK on a real Android device and verify fresh Binance data plus a test notification before calling the release done.

## Definition of stable

The system is not declared stable because a container started or one scan completed. Stability requires all 12 radars to produce fresh health/cycle telemetry, 19+1 analyst completeness, real live public-data transport, acceptable p95 timing and memory, zero unresolved critical data-integrity faults during the validation window, complete outcome tracking for emitted alerts, and successful web/PWA + Android endpoint checks.

## Current status

- [x] Build 224 base branch preserved.
- [x] Mini-ticker compatibility fix exists in the base branch.
- [x] Phase 2 test suite passed for the REST fallback/reconciliation patch (recorded for the current PR head at the time of status capture).
- [x] Production-aligned integration gate passed for that PR head.
- [ ] Final Triple Radar CI including Android background smoke must pass on the exact final head.
- [ ] Merge only after the exact-head gates pass.
- [ ] DHDTech runtime must deploy/serve the merged commit and prove REST + ticker WS + Kline WS health.
- [ ] Replace the legacy Railway API host in the Android release path with the confirmed DHDTech URL.
- [ ] Complete 30-cycle runtime timing/coverage validation; then install and verify the release APK.

**Non-negotiable:** do not create another DHDTech service/volume, do not disable data-integrity gates, do not turn on real orders, and do not claim completion until these gates have evidence.
