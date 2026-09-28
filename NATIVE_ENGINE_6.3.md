# RadarX Native 6.3

RadarX Native 6.3 extends the 6.2 native market core into a small live radar.

## Feed design

- 12 Binance Spot/USDT pairs are monitored:
  BTC, ETH, BNB, SOL, XRP, DOGE, ADA, LINK, SUI, XLM, STX and WAXP.
- One combined WebSocket carries trade and best-bid/best-ask events for all 12 pairs.
- One REST request bootstraps 24-hour ticker data when the engine starts.
- No per-symbol polling loop and no WebView market page.
- Socket generation checks prevent stale callbacks from creating duplicate live channels.
- Ping/keepalive and capped exponential reconnect with jitter protect the connection.
- Android network callbacks stop/restart the market channel with connectivity changes.

## UI design

The native screen has a focused selected-symbol panel plus a 12-row live radar. Incoming events are coalesced before updating the UI, reducing unnecessary view work.

Selecting any radar row switches the focus panel without opening another connection.

## Why this is the foundation

The expensive RadarX signal engine should not run against every symbol on every tick. The native feed is deliberately split from future analysis layers:

1. transport and live state
2. candle/history cache
3. low-cost universe scan
4. shortlist deep analysis
5. signal/risk/alert presentation

This keeps market transport predictable before advanced analytics are introduced.
