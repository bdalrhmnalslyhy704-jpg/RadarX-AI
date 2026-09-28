# RadarX Native 6.2 — Architecture

## Purpose

RadarX Native 6.2 replaces the previous Android WebView shell with a small native Android runtime for the live market layer.

The existing web RadarX application remains in the repository and is not deleted.

## Current live path

Android UI
-> BinanceMarketEngine
-> one combined Binance Spot WebSocket
-> trade + best bid/ask streams
-> throttled UI snapshots

A REST 24-hour ticker is requested once at startup as a bootstrap snapshot. It is not polled for every screen update.

## Reliability rules

- WebSocket reconnects automatically with capped exponential backoff and jitter.
- A connection generation prevents an older socket callback from creating duplicate sockets.
- Client ping interval keeps the connection active.
- Android network callbacks tell the engine when connectivity changes.
- The UI never fabricates a price when there is no live/real snapshot.
- UI rendering is coalesced to avoid redrawing on every incoming market frame.
- The live chart is a lightweight Android Canvas view, not a page-sized WebView.

## Next layers

1. Multi-symbol market multiplexer using one managed WebSocket session.
2. Historical candle bootstrap + incremental candle updates.
3. Native chart layer and timeframe switching.
4. Lightweight scanner worker and shortlist cache.
5. Radar feature engine: structure, volatility, volume, VWAP, order-book, relative strength, MTF consensus.
6. Alerts and notification delivery.
7. Account/subscription/backend integration.

The scanner and signal layers will be added only after the data path remains stable under live traffic.
