# RadarX Backend 0.1

RadarX backend designed for 24/7 cloud operation. It keeps market-data transport and heavy scanning outside the Android/WebView client.

Architecture:
Market WebSocket -> bounded state/cache -> staged scanner -> risk engine -> execution adapter -> REST/WebSocket API.

Performance:
- One all-symbol miniTicker stream for the broad live universe.
- Deep streams only for current high-priority candidates.
- HTTP/2 connection pooling and keep-alive.
- Bounded REST concurrency.
- Short TTL caches with stale fallback.
- WebSocket reconnect rotation before the documented 24-hour Binance connection lifetime.
- Scan work is asynchronous and does not block API requests.

Security:
- Credentials exist only in server environment variables.
- Live trading is disabled by default.
- The backend rejects API keys with withdrawals enabled.
- Futures and margin permissions are disabled by default.
- The APK should never receive BINANCE_API_SECRET.

Run:
1. Copy .env.example to .env.
2. Fill credentials on the server only.
3. Run docker compose up -d --build.
4. Check /api/v1/health.
5. Check /api/v1/scan?force=true.
