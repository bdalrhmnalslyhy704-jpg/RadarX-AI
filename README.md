# RadarX-AI

Advanced AI Crypto Market Scanner and Pre-Breakout Detection.

## RadarX 5.13 Background Intelligence

RadarX now has two layers:

1. Foreground live radar
   - Binance Spot WebSocket while the app is open.
   - Existing RadarX Ultimate 5.11 + Pro Engine 5.11.
   - Multi-symbol monitoring, deep analysis, flow, structure, trap detection, and paper trading.

2. Server-side background radar
   - Runs independently of the browser.
   - GitHub Actions wakes the scan every 5 minutes.
   - Binance Spot public data is validated for freshness before scoring.
   - Candidate gates combine market regime, multi-timeframe structure, momentum, relative volume, volatility compression, VWAP, ATR, order-book imbalance, recent trade delta, relative strength, liquidity, and trap-risk filtering.
   - Alerts are limited by score, trap risk, phase, and cooldowns.
   - No order execution is performed.

## Background notifications

### External channel
The background engine publishes alerts to an ntfy topic: radarx-alert-9c4c7b3e8e6d4a5fb7c2e1d9a6f3b8c1
Open the RadarX dashboard and use the external notification button. Subscribe to the displayed topic in the ntfy Android app.

### Web Push
Web Push is supported through /api/radarx-push and /radarx-sw-5.13.js.
Upstash Redis / Vercel KV is used for subscriptions and optional persistent VAPID keys.

## Important execution limits

The background scanner is scheduled server-side, so it does not depend on an open browser tab. GitHub Actions scheduled workflows have a minimum interval of 5 minutes and can be delayed during platform load.
For minute-level or sub-minute monitoring, use a production scheduler/service that supports that cadence.

## Data integrity

- Unavailable != 0
- Current data is not backfilled into history.
- Stale or malformed OHLC, order-book, and trade responses are rejected.
- Scores, trap risk, and phases are heuristics and must be calibrated/backtested.
- The system does not guarantee future price movement.

## Main entry point

https://radar-x-ai.vercel.app/
