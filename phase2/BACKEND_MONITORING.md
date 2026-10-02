# RadarX Phase 2 - Continuous Backend Monitoring

## Purpose

Phase 2 moves continuous market monitoring out of the phone/browser. The PWA remains a read-only presentation client and Paper Trading client; the server is the continuity layer.

Pipeline:

Binance public market feeds -> WebSocket collector -> normalized candle buffers -> REST reconciliation -> data-quality/liquidity gates -> existing Phase 1 strategy engine -> Unified JSON Signal -> deduplication -> audit log -> Push provider

No trading API keys, order endpoints, withdrawals, or authenticated exchange-user endpoints are used.

## How the service works

At startup the service initializes durable state, bootstraps recent 4H/1H/15m candles through public REST, then opens combined kline WebSocket streams for configured symbols.

Only completed candles can trigger analysis. WebSocket updates for a candle that is still open may update the buffer, but they cannot emit a signal.

Each closed 15m candle triggers an analysis cycle. The cycle obtains fresh order-book depth and 24h ticker data, applies data-quality and liquidity gates, and invokes the three Phase 1 strategies without changing them:

- Multi-Timeframe Trend Following
- Confirmed Breakout with Volume and Liquidity
- Filtered Mean Reversion

The Unified JSON Signal remains the output contract.

confidence_score remains UNKNOWN.
paper_trading remains true.
real_order_execution remains false.

## REST reconciliation

REST is the repair and consistency path. It does not bypass the validation gates.

REST reconciliation is used when:

- the WebSocket disconnects or enters backoff;
- a candle is missing;
- candle timestamps are duplicated, unordered, or non-contiguous;
- a future timestamp is received;
- periodic consistency repair is due;
- the stream receives malformed data.

The REST client is GET-only and restricted to the public /api/v3 surface. It rotates across configured public Binance base URLs, spaces requests, maintains a bounded request budget, and honors Retry-After on rate-limit responses.

## Exponential reconnect

WebSocket reconnect uses exponential backoff with jitter and rotates between configured stream URLs. A heartbeat watchdog terminates a silent connection so it can enter the reconnect path. A long-running connection is also rotated before its maximum lifetime.

The server process owns the market connection. The phone does not need to stay open.

## Data quality

Before a signal can be emitted, the service checks:

- OHLC and numeric validity;
- monotonically increasing candle open times;
- expected timeframe spacing and gap detection;
- no future candle timestamps;
- existence of a completed 15m trigger candle;
- data freshness;
- live source state;
- unresolved reconciliation gaps;
- minimum Data Quality;
- minimum Liquidity Quality;
- spread and order-book depth;
- Phase 1 risk filter.

Any failed required gate records a blocked evaluation and prevents Push delivery.

Cached or historical values are never relabeled as live. A value is treated as current only when it was just obtained and passes freshness/integrity checks.

## Push notifications

Default provider:

RADARX_PUSH_PROVIDER=none

Web Push provider:

RADARX_PUSH_PROVIDER=webpush

The browser creates a Web Push subscription and sends it to the authenticated server endpoint. The server keeps the subscription server-side, filters it using the user's settings, and sends a minimal signal payload.

HTTP 404/410 subscription failures disable the subscription. Other push failures enter an in-memory retry queue with exponential delay and are audited. A later successful retry is audited too.

Firebase Cloud Messaging is not wired into this phase. The push interface is provider-based so FCM can be added later without changing the monitoring or strategy layers.

## API and settings

Authenticated endpoints:

GET /v1/settings
PUT /v1/settings
GET /v1/subscriptions
POST /v1/subscriptions
DELETE /v1/subscriptions/:id
GET /v1/signals
GET /v1/notifications
GET /v1/push/status

User settings include:

- notifications enabled/disabled;
- selected symbols;
- selected timeframes;
- minimum Data Quality;
- minimum Liquidity Quality;
- accepted signal types.

Health endpoints:

GET /healthz
GET /readyz

The API uses HMAC-signed short-lived bearer tokens, exact CORS allowlisting, body-size limits, no-store responses, and simple per-client rate limiting.

## Audit trail

Signals are appended to:

.radarx-data/signals.jsonl

Notification attempts are appended to:

.radarx-data/notifications.jsonl

Signal records contain source time, processing time, symbol, timeframe, price, strategy, reason, Data Quality, Liquidity Quality, notification status, blocked reasons, Paper Trading state, and real_order_execution=false.

## Running in the background

The service is a normal long-running Node.js process. Closing the browser or locking the phone does not stop a correctly hosted service.

Development:

npm install
RADARX_AUTH_SECRET='replace-me' npm start

For production, run the process under a supervisor such as systemd, Docker/Compose, Kubernetes, or a managed process service. Use automatic restart and put an HTTPS reverse proxy in front of public API endpoints.

Operational checks:

curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:8787/readyz

The health response exposes:

- WebSocket state;
- last WebSocket message;
- latest completed candle;
- last analysis time;
- REST state;
- database state;
- unresolved gaps.

## When no signal is emitted

No signal or Push notification is issued when:

- the trigger candle is incomplete;
- data is stale;
- the market source is disconnected;
- a gap is unresolved;
- future data is detected;
- series integrity fails;
- Data Quality is below its configured minimum;
- Liquidity Quality is below its configured minimum;
- spread/liquidity validation fails;
- the Phase 1 risk filter fails;
- there is no actionable direction;
- the event is already inside its deduplication window.

## Limits and hosting

The included durable store is local-file based. It is intended for one active service instance and testing. It is not a substitute for managed PostgreSQL/Redis/object storage when scaling horizontally.

For production scale, move subscriptions/settings/dedup/audit persistence to managed durable storage and make the push retry queue durable. Add distributed locking or a single-active-leader design before running more than one monitor instance.

Keep the monitor on a continuously running server. A mobile browser is not a server.

## Safety boundary

This phase contains no order creation, order cancellation, withdrawal, trading-account, or authenticated exchange-user API. All strategy outputs are read-only informational/Paper Trading outputs.

confidence_score=UNKNOWN is deliberate and must not be interpreted as a calibrated probability until out-of-sample calibration exists.
