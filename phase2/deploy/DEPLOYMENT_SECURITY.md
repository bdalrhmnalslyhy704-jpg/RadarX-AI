# RadarX Phase 2 — Deployment Security

## Non-negotiable safety policy

- This environment is Staging only.
- paper_trading must remain true.
- real_order_execution must remain false.
- confidence_score remains UNKNOWN.
- No Binance API key/secret or authenticated exchange user-data credential is permitted.
- No order, cancellation, withdrawal, or trading endpoint is permitted.
- TEST_PUSH_ONLY is a notification transport test, never a market signal.

## Deployment topology note

The loopback/`127.0.0.1` and `/var/lib/radarx/phase2` examples below are for the legacy VPS/systemd reverse-proxy topology, not Render. Render uses `RADARX_HOST=0.0.0.0`, the platform-provided `PORT`, and `/var/data/radarx` for the Persistent Disk.

## Secret handling

Required server-side secrets:
- RADARX_AUTH_SECRET
- VAPID_PRIVATE_KEY

Required non-secret Web Push configuration:
- VAPID_SUBJECT
- VAPID_PUBLIC_KEY
- RADARX_PUSH_PROVIDER=webpush
- RADARX_ALLOWED_ORIGINS=https://...

Rules:
- Inject through a secret manager or host-only EnvironmentFile.
- Never commit real values to Git.
- Never place VAPID_PRIVATE_KEY or RADARX_AUTH_SECRET in frontend files.
- Never print secret values in logs.
- Do not paste secrets into PR descriptions, screenshots, issue comments, or chat.
- Rotate secrets after the field test if the test credentials were shared outside the secret store.

## Origin protection

RADARX_ALLOWED_ORIGINS must contain the exact HTTPS PWA origin. The TEST_PUSH_ONLY endpoint also requires the request Origin to match an allowed origin.

CORS is not authentication; the Bearer session token is still mandatory.

## Service account

Run Node as a dedicated unprivileged user such as radarx, never as root.

Recommended:
- /etc/radarx/phase2-staging.env owned by root:radarx with mode 0640.
- /var/lib/radarx/phase2 owned by radarx:radarx with mode 0750.
- /opt/radarx source readable but not writable by the service user.
- Only ports 80 and 443 exposed publicly.
- Keep Node bound to 127.0.0.1:8787.

## Firewall

Allow inbound:
- TCP 80 from the public internet for ACME HTTP challenge and HTTP→HTTPS redirect.
- TCP 443 from the public internet.

Do not expose:
- TCP 8787 publicly.
- SSH publicly without the host's normal administration controls.
- Any exchange trading API port.

Outbound access required:
- HTTPS/WSS to Binance public market-data endpoints.
- HTTPS to Web Push provider endpoints.

## Logging

Log operational events such as startup failures, health state, WebSocket state, push status, and subscription lifecycle without:
- Authorization headers;
- VAPID private key;
- RADARX_AUTH_SECRET;
- full PushSubscription keys.

Audit data may include event class, signal/test identifiers, timestamps and delivery status. Keep TEST_PUSH_ONLY clearly separated from LIVE_MARKET_SIGNAL.

## Preflight

The Staging server runs a fail-fast preflight before startup. It rejects:
- non-staging runtime;
- missing/ambiguous RADARX_STAGING_TEST_PUSH_ENABLED;
- missing/short RADARX_AUTH_SECRET;
- missing VAPID values;
- non-webpush provider;
- empty or non-HTTPS allowed origins;
- a non-loopback Node bind address;
- any environment override that changes read-only flags.

## TEST_PUSH_ONLY lifecycle

1. Enable only for the staging window.
2. Authenticate the operator/test account.
3. Confirm trusted HTTPS Origin.
4. Send one unique test_id.
5. Verify physical Android receipt.
6. Verify click opens settings.html.
7. Remove the subscription.
8. Disable TEST_PUSH_ONLY by setting RADARX_STAGING_TEST_PUSH_ENABLED=false.
9. Preserve only the evidence needed for the staging report.

## Incident response

If a secret is exposed:
1. Stop the staging service.
2. Rotate RADARX_AUTH_SECRET and/or VAPID keys in the secret store.
3. Re-issue the staging session token.
4. Re-subscribe the test device.
5. Re-run health/readiness and TEST_PUSH_ONLY before resuming.

If the staging build is unhealthy:
1. Stop the service.
2. Roll back the staging checkout to the last known-good commit.
3. Preserve audit evidence.
4. Restart and verify /healthz and /readyz.
