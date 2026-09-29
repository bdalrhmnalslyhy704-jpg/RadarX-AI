# RadarX Phase 2 - PWA/API/Push Integration Testing

## Scope

This phase connects the Phase 1 PWA to the Phase 2 backend. It does not add trading execution. The client and backend remain Spot, Read-Only, and Paper Trading only.

The automated suite covers the server-to-PWA contract and a simulated Service Worker Push click. Automated tests use deterministic values labeled TEST_FIXTURE. A passing test suite is not evidence that a real device received a Push notification.

## Requirements

- Node.js 20 or newer.
- A Phase 2 server that can run continuously.
- A browser with Service Worker support.
- For real Web Push: a browser with Push API support, HTTPS, and valid VAPID configuration.
- A real authenticated Phase 2 session token.
- No Binance trading credentials are required.

## Supported browser baseline

The integration relies on Service Worker, Notifications, and Push APIs. Current Chromium-based browsers and compatible Android browsers generally provide the required APIs. Safari/iOS support depends on the installed web app/PWA mode and operating-system version; validate on the exact iPhone/iOS version before treating Push as production-ready.

The repository tests do not claim universal browser compatibility.

## Local run

Backend:

npm install

RADARX_AUTH_SECRET='long-random-value' npm start

PWA:

Serve phase1/ through an HTTP server. Do not use file:// for Service Worker or Push testing.

Example:

python -m http.server 8080 --directory phase1

For a different backend origin, set:

RADARX_ALLOWED_ORIGINS=http://localhost:8080

and point the PWA Settings page at:

http://127.0.0.1:8787

In Settings, enter the Phase 2 Session Token. The token is stored in sessionStorage; the backend secret is never placed in the frontend.

## Health and readiness

GET /healthz does not require authentication.

GET /readyz does not require authentication.

The PWA shows WebSocket state, last WebSocket message, latest completed candle, last analysis time, REST state, database state, unresolved gaps, Data Quality, Liquidity Quality, Risk Filter, and confidence_score=UNKNOWN.

A degraded or unavailable backend is not represented as fresh market data.

## Enabling Web Push

The browser must run on an appropriate secure origin. For production, use HTTPS.

Server configuration:

RADARX_PUSH_PROVIDER=webpush
RADARX_AUTH_SECRET=<server-only-secret>
VAPID_SUBJECT=mailto:operator@example.com
VAPID_PUBLIC_KEY=<public-key>
VAPID_PRIVATE_KEY=<private-key>

The private VAPID key is server-only. It is never returned by the frontend config endpoint.

The PWA follows this user-triggered flow:

1. The user presses تشغيل التنبيهات.
2. The page verifies Push, Notifications, and Service Worker support.
3. The page requests Notification permission.
4. Only after permission is granted does it register sw.js.
5. It fetches the VAPID public key from authenticated /v1/config.
6. It creates a PushSubscription.
7. It POSTs the subscription to /v1/subscriptions.
8. The server applies user notification settings before delivery.

No notification permission prompt is issued on page load.

## Android test

Use an Android device with a Chromium-based browser that supports the required APIs.

1. Serve the PWA over HTTPS.
2. Configure the server CORS allowlist for the PWA origin.
3. Open phase1/app.html.
4. Open Settings.
5. Enter the backend URL and a real session token.
6. Save and verify Health and Ready.
7. Press تشغيل التنبيهات.
8. Confirm the permission prompt appears only after the button press.
9. Confirm /v1/subscriptions contains one subscription.
10. Leave the server running on a continuously available host.
11. Wait for or generate a real completed 15m signal that passes all gates.
12. Confirm the Push notification arrives with the analytical warning.
13. Tap the notification.
14. Verify signal.html shows source time, server processing time, browser receipt time, stale/live state, Data Quality, Liquidity Quality, Risk Filter, and confidence_score=UNKNOWN.

The repository does not claim that physical-device delivery passed unless the device test was actually performed.

## HTTPS test

For browser validation, use an HTTPS development origin or a real HTTPS deployment. A production reverse proxy should terminate TLS and forward requests to the backend.

Keep PWA origin, Phase 2 backend origin, VAPID private key storage, and authentication secret storage separate. Never commit .env or secret-manager exports.

## iPhone boundaries

iPhone Push behavior must be validated against the exact iOS/Safari version and installation mode being used. The code intentionally does not claim universal iPhone Push availability.

Treat iPhone delivery as an explicit real-device test item before release.

## Automated tests

Run everything:

npm test

Run only Phase 2:

npm run test:phase2

The integration suite includes the market-style closed-candle flow into the existing Phase 1 engine, data gates, Unified JSON Signal, deduplication, durable audit, Push delivery, duplicate suppression, incomplete/stale data blocking, expired endpoint handling, no-subscription behavior, dedup persistence across restart, disabled provider behavior, Service Worker Push creation, notification click to signal.html, frontend secret scans, confidence contract, permission/unsupported branches, and no cross-origin API caching.

## Real data versus TEST_FIXTURE

The automated integration suite is deterministic. Fixtures are explicitly named TEST_FIXTURE.

To establish that a production alert came from real market data, inspect the Phase 2 audit record, source/source_time, WebSocket/REST health, candle completion state, Data Quality, Liquidity Quality, and Push audit status.

A TEST_FIXTURE event is never evidence of a live market alert.

## What automation does not prove

Automated CI cannot prove that a particular physical Android phone displayed a notification, that a particular iPhone displayed a notification, that a user's network allowed Push delivery, that a real subscription remains valid indefinitely, or that a production reverse proxy is configured correctly.

Those items require an actual HTTPS deployment and real browser/device testing.

## Safety checks

Every Phase 2 signal must keep paper_trading=true, real_order_execution=false, and confidence_score=UNKNOWN.

No exchange API key, secret, order endpoint, withdrawal endpoint, or authenticated exchange user-data credential belongs in the PWA.

## Troubleshooting

If Health is unavailable, verify backend host/port and CORS.
If VAPID is missing, /v1/config reports Push disabled or no public key and the page will not create a subscription.
If permission is denied, no subscription is created.
If a subscription returns HTTP 404/410, Phase 2 disables it and the user can subscribe again.
If data is stale, future-dated, incomplete, or has unresolved gaps, no Push is sent.
If the same signal repeats inside the deduplication window, no second Push is sent.