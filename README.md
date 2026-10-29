# RadarX-AI — Build 224

Build target: **DHDTech Cloud**, backend service on port `8787`. The active deployment branch is `build224-multi-analyst-20261007`.

## Runtime contract

- Binance Spot USDT public market-data monitoring; no live order execution.
- `paper_trading=true`, `real_order_execution=false`.
- Closed-candle validation, market-data freshness checks, and explicit unavailable/stale states.
- Twelve coordinated radars plus the multi-analyst layer; the Adaptive Trader runs as an independent server-side sidecar.
- Persistent worker memory includes market-wide observations, deep candidate observations, matured outcomes, and a missed-mover audit.
- Smart Trader results must come from the server worker, not be described as learned merely because a browser-side scan completed.

## DHDTech endpoints

The configured backend hostname is `https://radarx-backend.dhdtech.site`.

- `GET /api/deployment-info` — deployment contract, radar/analyst registration, and notification provider status.
- `GET /api/adaptive-trader/status` — scan history, durable learning state, candidate summary, missed movers, and notification transport.
- `POST /api/adaptive-trader/scan` — request one persisted worker scan. Manual requests are throttled to one per minute; active scans are not duplicated.
- `GET /api/adaptive-trader/market-snapshot?limit=80` — read-only market snapshot. This endpoint alone does not count as a persisted learning cycle.

The web client calls the configured DHDTech backend and displays server-reported counts, errors, and results. Notification-provider configuration does **not** prove delivery to a physical phone; verify the device receipt separately.

## Learning and validation

- Live candidate observations are not considered mature outcomes until the four-hour horizon has elapsed.
- Outcomes use the project's +2% / -2% labels, with intermediate outcomes classified as flat.
- Historical calibration samples are calculated from available closed-candle history; missing data is not replaced with simulated prices.
- The learner does not apply score calibration until the configured minimum resolved-sample count and factor-bucket coverage are satisfied.
- A missed-mover record is an audit clue, not a buy signal. Already-extended moves remain excluded from entry recommendations.

## Tests

Run the repository test suite with Node.js 22 or newer:

```sh
npm test
```

## Deployment rule

Deploy this Build 224 branch to **DHDTech Cloud only**. Do not use Railway or Vercel as deployment targets for this build. A Git commit is not proof of a successful DHDTech deployment, a published Android APK, or a real-device notification receipt.
