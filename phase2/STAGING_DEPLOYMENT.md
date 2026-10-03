# RadarX Phase 2 — Real Push Staging Deployment

## Purpose
This document prepares a real HTTPS staging deployment for the Phase 2 monitoring service and Web Push validation. It does not authorize production deployment, exchange credentials, order execution, or changes to main.

Safety invariants:
- market=SPOT / read-only analysis only.
- paper_trading=true.
- real_order_execution=false.
- confidence_score=UNKNOWN; never replace it with a numeric confidence.
- No Binance API key/secret, trading permission, withdrawal permission, or authenticated exchange user-data API.
- VAPID private key and RADARX_AUTH_SECRET remain server-side only.
- The staging-only test endpoint is disabled unless RADARX_STAGING_TEST_PUSH_ENABLED=true and RADARX_ENV=staging.

## 1. Hosting requirements
- Linux VPS or another always-on server.
- Node.js 20+.
- A persistent process supervisor such as systemd.
- A real DNS name for the PWA and, when using a separate origin, a DNS name for the API.
- TCP 80/443 reachable by the HTTPS edge.
- Persistent writable storage for .radarx-data (or RADARX_DATA_DIR).
- Outbound HTTPS/WSS access to Binance public endpoints and outbound Web Push traffic.
- The phone must open the PWA from HTTPS; do not use file://.

The Node backend should listen on loopback, for example 127.0.0.1:8787, while the HTTPS reverse proxy is the public edge.

## 2. Recommended topology
- PWA: https://radarx-staging.example.com/phase1/
- API: https://radarx-api-staging.example.com/
- Node backend: 127.0.0.1:8787

The PWA settings page stores the API URL in browser storage. CORS must contain the exact PWA origin.

## 3. Secrets and runtime variables
Create these only in a host secret manager, shell environment, systemd EnvironmentFile outside Git, or equivalent.

| Variable | Required | Secret? | Notes |
|---|---|---:|---|
| RADARX_ENV | Yes | No | Set to staging. |
| RADARX_STAGING_TEST_PUSH_ENABLED | Yes for manual test | No | true only on staging. |
| RADARX_AUTH_SECRET | Yes | YES | Long random server-only bearer-token signing secret. |
| RADARX_PUSH_PROVIDER | Yes | No | webpush for real Push. |
| VAPID_SUBJECT | Yes | No | Contact such as mailto:operator@example.com. |
| VAPID_PUBLIC_KEY | Yes | No | Public VAPID key exposed only through authenticated /v1/config. |
| VAPID_PRIVATE_KEY | Yes | YES | Server-only. Never send to the browser. |
| RADARX_ALLOWED_ORIGINS | Yes | No | Exact PWA origin. |
| RADARX_DATA_DIR | Recommended | No | Persistent audit/subscription path. |
| RADARX_HOST | Recommended | No | Keep 127.0.0.1 behind the proxy. |
| RADARX_PORT | Recommended | No | Example 8787. |

Never put secret values in GitHub files, PR bodies, frontend source, screenshots, issue comments, or browser storage.

### Generate VAPID keys
Run on the server or a trusted operator workstation where the private key remains secret:

npx web-push generate-vapid-keys

Store the resulting keys in the staging secret store. Do not paste them into this repository.

### Issue a staging session token
After RADARX_AUTH_SECRET is loaded:

RADARX_AUTH_SECRET='<server-secret>' npm run issue-token -- --user staging-android

Treat the printed token as a credential for the test account.

## 4. HTTPS
Caddy is recommended for the staging edge because it can provision and renew publicly trusted certificates for real DNS names. Point DNS to the VPS and allow ports 80/443.

Example Caddyfile:

radarx-staging.example.com {
    handle /phase1/* {
        root * /opt/radarx
        file_server
    }
}

radarx-api-staging.example.com {
    reverse_proxy 127.0.0.1:8787
}

With this layout, /phase1/... maps to /opt/radarx/phase1/... and the API stays behind the HTTPS edge. Node remains private on loopback.

Validate:
curl -fsS https://radarx-api-staging.example.com/healthz
curl -fsS https://radarx-api-staging.example.com/readyz

Do not treat plaintext HTTP or an untrusted self-signed certificate as equivalent to the real-device HTTPS test.

## 5. Persistent process
Example systemd unit; create it on the host, not in this repository unless explicitly requested:

/etc/systemd/system/radarx-phase2-staging.service:

[Unit]
Description=RadarX Phase 2 Staging Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/radarx
ExecStart=/usr/bin/node phase2/server.mjs
Restart=always
RestartSec=5
EnvironmentFile=/etc/radarx/phase2-staging.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/radarx/phase2

[Install]
WantedBy=multi-user.target

Keep the secret file root-readable and outside Git.
sudo systemctl daemon-reload
sudo systemctl enable --now radarx-phase2-staging
sudo systemctl status radarx-phase2-staging --no-pager

## 6. Host environment shape (placeholders only)
RADARX_ENV=staging
RADARX_STAGING_TEST_PUSH_ENABLED=true
RADARX_HOST=127.0.0.1
RADARX_PORT=8787
RADARX_PUSH_PROVIDER=webpush
RADARX_ALLOWED_ORIGINS=https://radarx-staging.example.com
RADARX_DATA_DIR=/var/lib/radarx/phase2
RADARX_AUTH_SECRET=<SET_IN_SECRET_STORE>
VAPID_SUBJECT=mailto:<OPERATOR_EMAIL>
VAPID_PUBLIC_KEY=<SET_IN_SECRET_STORE>
VAPID_PRIVATE_KEY=<SET_IN_SECRET_STORE>

## 7. Health/readiness gate
Start field testing only when:
1. GET /healthz returns HTTP 200.
2. GET /readyz returns HTTP 200 with database LIVE and WebSocket or REST LIVE.
3. monitoring.running=true and bootstrap_done=true.
4. last_complete_candle is current enough for the freshness policy.
5. Authenticated /v1/config reports provider webpush and enabled=true.

## 8. TEST_PUSH_ONLY manual test
1. Open the public HTTPS PWA.
2. Open Settings and enter the API HTTPS URL and staging session token.
3. Verify Health and Ready.
4. Install the PWA from HTTPS.
5. Tap تشغيل التنبيهات; notification permission must be requested by that user action.
6. Confirm POST /v1/subscriptions created an active server-side subscription.
7. Tap إرسال TEST_PUSH_ONLY.
8. The endpoint is accepted only with authentication and an Origin matching RADARX_ALLOWED_ORIGINS.
9. The notification must visibly say: اختبار إشعار فقط — ليس تحليلًا للسوق.
10. The test notification is not a market signal and must not contain numeric confidence.
11. Tapping the test notification opens Settings, not signal.html.
12. Confirm notification audit event_class=TEST_PUSH_ONLY and no TEST_FIXTURE label.

A successful HTTP response is not proof of device receipt. Mark the field test successful only after the physical Android device displays the notification.

## 9. LIVE_MARKET_SIGNAL validation
Only after TEST_PUSH_ONLY is physically confirmed:
- Wait for a real completed Binance public candle that passes data, liquidity, and risk gates.
- Confirm audit event_class=LIVE_MARKET_SIGNAL with public source metadata and confidence_score=UNKNOWN.
- Confirm Android receives the real market notification.
- Tap it and verify signal.html has the same signal_id, source_time, server processing time, browser receipt time, quality/risk values, paper flags, and UNKNOWN confidence.
- Never create or execute an exchange order.

## 10. Rollback
1. Stop the staging service: sudo systemctl stop radarx-phase2-staging.
2. Preserve the current data directory for audit review.
3. Point the staging process at the previous known-good integration commit or branch.
4. Restart and re-run healthz/readyz before field testing.
5. To disable the staging test endpoint while retaining monitoring, set RADARX_STAGING_TEST_PUSH_ENABLED=false and restart.
6. If a secret may be compromised, rotate it in the secret store; do not commit replacement values.

Do not delete audit data during rollback unless the retention policy explicitly requires it.

## 11. Risks and limits
- Push delivery depends on browser/OS support, notification settings, battery/network policy, and the browser push service.
- HTTP 404/410 from a push service is treated as an expired subscription and disables it server-side.
- CORS is browser-origin protection and is not a substitute for authentication.
- The test endpoint is staging-gated and is never a market signal.
- CI cannot prove physical device receipt.
- iPhone Web Push needs Home Screen web-app installation and a user-driven permission flow on supported iOS/iPadOS versions; validate on the exact device and OS.
- Market monitoring runs on the server and must not depend on the phone remaining connected.