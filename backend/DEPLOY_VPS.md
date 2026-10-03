# RadarX VPS 24/7 deployment

## Architecture

Android is the client UI. The VPS runs the RadarX scanner continuously.
The backend keeps Binance public WebSockets alive, refreshes the candidate universe,
performs deep multi-timeframe analysis, stores the latest signals in memory, and
exposes a small HTTPS API to the Android app.

The APK never receives BINANCE_API_SECRET.

## 1. Prepare the server

Recommended baseline:
- Linux VPS with Docker and Docker Compose.
- Keep TCP 8000 private.
- Put Nginx/Caddy in front of the service on HTTPS 443.
- Allow inbound 22 only for administration and 80/443 for the public API.

## 2. Configure secrets

Copy `.env.example` to `.env` and set:
- BINANCE_API_KEY
- BINANCE_API_SECRET
- RADARX_CONTROL_TOKEN

Do not commit `.env`.

The Binance API key should be restricted to reading and Spot trading. Turn off withdrawals,
margin, futures and portfolio-margin permissions. Start with:
RADARX_ALLOW_LIVE_TRADING=false
RADARX_AUTO_EXECUTION=false

## 3. Run

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8000/api/v1/health
curl http://127.0.0.1:8000/api/v1/config
curl http://127.0.0.1:8000/api/v1/scan?force=true
```

The compose service uses `restart: unless-stopped`, so the worker comes back after a
process crash or host reboot.

## 4. Put HTTPS in front

Expose only Nginx/Caddy. Reverse proxy:
`/api/*` and `/ws` -> `http://127.0.0.1:8000`

Do not expose port 8000 directly to the Internet.

## 5. Execution path

1. Scanner creates a fresh Signal from live market data.
2. Android requests /api/v1/execution/plan with the RadarX control token.
3. Backend accepts only a fresh signal already produced by the scanner.
4. RiskEngine sizes the position from account balance and configured risk.
5. Binance exchangeInfo rules normalize price/quantity to tickSize, stepSize and notional limits.
6. Only when both RADARX_ALLOW_LIVE_TRADING=true and RADARX_AUTO_EXECUTION=true,
   and the permission safety check passes, a Spot LIMIT BUY can be sent.

For production, keep live execution disabled until paper tests are clean.
