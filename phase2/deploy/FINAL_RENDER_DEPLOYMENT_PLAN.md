# RadarX — Final Render Deployment Plan

**Status:** PLAN ONLY — no Render account, Web Service, payment method, DNS record, domain, secret, or deployment was created by this change.

## 1. Proposed deployment commit

**Proposed application/runtime commit:**
`913cc2e39b5099cace06bc6c46d752abc6a5ff87`

This is the validated head of **PR #18** (`phase2-fix-staging-preflight-assertion`), whose parent is PR #17 (`phase2-fix-test-hanging`). The runtime changes from PR #14 are included through that branch lineage.

Reviewed PR chain:

| PR | Branch | Role | Deployment relevance |
|---|---|---|---|
| #14 | `phase2-predeploy-safety-fixes` | readiness, staging push safety gates, Render runbook alignment | **Included in the runtime lineage** |
| #15 | `ci-workflow-concurrency-hardening` | CI-only concurrency hardening | **Not part of the proposed runtime commit** |
| #17 | `phase2-fix-test-hanging` | test isolation, HTTP cleanup, bounded test resources | **Included in the runtime lineage** |
| #18 | `phase2-fix-staging-preflight-assertion` | aligns the staging HTTPS assertion with the existing production preflight contract | **Included; current validated head** |

PR #18 did **not** change production logic. The official staging origin error remains:
`STAGING_ALLOWED_ORIGINS_MUST_BE_EXACT_HTTPS_ORIGINS`.

**Important:** `913cc2e...` is a feature-branch candidate, not a merge into `main`. No merge is required for this planning step.

## 2. Render Web Service configuration

### Build Command

```text
npm ci --omit=dev
```

### Start Command

```text
npm start
```

### Host

```text
RADARX_HOST=0.0.0.0
```

The application must bind the public HTTP server to the platform-provided port.

### Port

Use the **Render-provided `PORT`** environment variable. Do not hard-code a public Render port.

### Health Check

```text
/healthz
```

### Readiness Check

```text
/readyz
```

`/healthz` is the Render health-check endpoint. `/readyz` is the operator gate: do not treat staging as ready while readiness is failing.

## 3. Persistent Disk

Attach a Render Persistent Disk to the backend Web Service:

```text
Mount path: /var/data/radarx
```

Set:

```text
RADARX_DATA_DIR=/var/data/radarx
```

Use the smallest capacity that safely covers the staging retention window.

The application uses durable local storage for push subscriptions, user settings, deduplication state, and audit JSONL data. Render's default service filesystem is ephemeral, so the disk is required for persistence across restarts/deploys.

Render documents that persistent disks are available on paid web services and that data outside the mount path remains ephemeral. Attaching a disk also prevents zero-downtime deploys, so rollout/rollback must allow for the documented instance replacement behavior.

## 4. WebSocket requirements

### Outbound Binance WebSocket

RadarX uses outbound WebSocket market feeds. Render Web Services support outbound WebSocket connections; no special WebSocket dashboard toggle is required.

Operational requirements:

- The Node server listens on the Render-provided `PORT`.
- Binance WSS connections are outbound from the service.
- Reconnect/backoff and REST reconciliation/fallback remain enabled.
- Monitor freshness must be checked after startup.
- A WebSocket disconnect must not be converted into fake zero-valued market data.

### Future browser-to-RadarX WebSocket

If a later client-facing WebSocket is exposed publicly, use `wss://` and keep it on the same public web-service port. Do not invent a second public port.

## 5. HTTPS requirements

The public PWA/API origins must be **exact HTTPS origins** with no trailing slash.

Valid shape:

```text
https://<EXACT-PWA-ORIGIN>
```

Invalid shapes include:

```text
http://...
https://.../
*
```

Render terminates inbound TLS/SSL at the edge and forwards the request to the Web Service. The external PWA and API URLs must therefore use HTTPS.

For staging, the current preflight additionally requires an exact HTTPS `RADARX_PUBLIC_API_ORIGIN`.

## 6. Environment variables

Names and planned values only; **never place real secrets in Git**.

### Required application configuration

```text
RADARX_ENV=staging
RADARX_STAGING_TEST_PUSH_ENABLED=false
RADARX_HOST=0.0.0.0
RADARX_PUSH_PROVIDER=webpush
RADARX_ALLOWED_ORIGINS=https://<EXACT-PWA-ORIGIN>
RADARX_DATA_DIR=/var/data/radarx
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
```

### Required secret/credential names

```text
RADARX_AUTH_SECRET=<secret>
VAPID_SUBJECT=<secret>
VAPID_PUBLIC_KEY=<secret>
VAPID_PRIVATE_KEY=<secret>
```

### Additional current-preflight variable

The current staging preflight also requires:

```text
RADARX_PUBLIC_API_ORIGIN=https://<EXACT-API-ORIGIN>
```

This variable is listed because omitting it would fail the actual production code's staging preflight, even though it was not in the original abbreviated variable list.

### Safety invariants

These must remain fixed:

```text
paper_trading=true
real_order_execution=false
confidence_score=UNKNOWN
```

In environment-variable form:

```text
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
```

No Binance trading API key, withdrawal credential, or exchange user-data credential is required for this read-only + Paper Trading architecture.

## 7. How to keep secrets outside Git

Use Render's Environment/Secret configuration.

Do **not** commit:

- `RADARX_AUTH_SECRET`
- `VAPID_PRIVATE_KEY`
- any real VAPID credentials
- session tokens
- private keys
- screenshots containing secret values

The repository may contain placeholders only. The secret store should be the only source of real secret values at runtime.

Before the first real staging deployment, generate fresh VAPID credentials outside Git and provide the values through the managed secret configuration.

## 8. TEST_PUSH_ONLY procedure

The feature is controlled by:

```text
RADARX_STAGING_TEST_PUSH_ENABLED
```

### During the physical Android test only

Set:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=true
```

Use this window only to verify:

- PWA subscription exists;
- authentication works;
- the physical Android device actually receives the notification;
- the test event is recorded as `TEST_PUSH_ONLY`;
- the notification opens the intended settings/test destination.

### After the phone test

Immediately set:

```text
RADARX_STAGING_TEST_PUSH_ENABLED=false
```

Then restart/redeploy the service so the running process uses the new value.

Do **not** interpret successful `TEST_PUSH_ONLY` delivery as proof that `LIVE_MARKET_SIGNAL` is ready. The existing safety gates require a successful physical device receipt acknowledgment before a later staging step can consider live market-signal push.

## 9. Pre-deployment gates

Before creating any Render resource, confirm:

- Phase 1: **15/15** tests passed.
- Phase 2: **70/70** tests passed.
- Total: **85/85** tests passed.
- `npm audit --omit=dev --audit-level=critical`: **0 vulnerabilities**.
- Exact application commit is known: `913cc2e...`.
- HTTPS origin is known.
- Persistent disk mount is planned at `/var/data/radarx`.
- All secrets are prepared outside Git.
- CORS/allowed origin matches the exact PWA origin.
- `RADARX_STAGING_TEST_PUSH_ENABLED` is explicit.
- `TEST_PUSH_ONLY` is disabled during ordinary operation.
- Live market push remains blocked until the physical-device validation gate is satisfied.
- Rollback target is recorded before the first deploy.
- `RADARX_PAPER_TRADING=true`.
- `RADARX_REAL_ORDER_EXECUTION=false`.
- `RADARX_CONFIDENCE_MODE=UNKNOWN`.

## 10. First-deploy verification sequence

After the user explicitly approves and creates the Render service:

1. Configure the Web Service with the commands and environment names in this document.
2. Attach the Persistent Disk at `/var/data/radarx`.
3. Deploy the exact proposed application commit.
4. Confirm the process binds to `0.0.0.0:$PORT`.
5. Verify:
   `https://<API-ORIGIN>/healthz`
6. Verify:
   `https://<API-ORIGIN>/readyz`
7. Confirm durable storage is `LIVE`.
8. Confirm WebSocket is `LIVE` or the documented REST fallback is `LIVE`.
9. Confirm `monitoring.running=true`, `bootstrap_done=true`, and a recent completed candle exists.
10. Only then perform the physical Android `TEST_PUSH_ONLY` window.
11. Set `RADARX_STAGING_TEST_PUSH_ENABLED=false` after the test.
12. Keep live market-signal push blocked until its explicit safety gate is satisfied.

## 11. Rollback plan

### Application rollback

Record the previous known-good application commit before the first deployment.

On Render, use the previous successful deployment/rollback mechanism to return the service to that version. If Git-based rollback is required, pin the service to the previous known-good commit rather than moving it to an unverified branch.

After rollback, verify:

```text
/healthz
/readyz
```

and confirm the monitor/storage state is healthy.

### Persistent data rollback

Do not casually restore a disk snapshot just because an application deploy failed. Persistent data is separate from the application version.

Use a disk snapshot restore only when the data itself is known to be damaged or incompatible and the resulting data loss is acceptable. Record the target snapshot before making such a recovery action.

### Security rollback

If any secret is exposed or suspected compromised:

1. disable `TEST_PUSH_ONLY`;
2. rotate `RADARX_AUTH_SECRET`;
3. rotate/reissue VAPID credentials as appropriate;
4. invalidate/reissue staging session credentials if applicable;
5. preserve the relevant audit evidence.

## 12. Cost estimate

Render's current pricing page lists the smallest paid web-service tier at **$7/month** for the less-than-1-CPU / 512 MB option, and persistent SSD storage at **$0.25/GB/month**.

| Item | Current planning price |
|---|---:|
| Web Service | **about $7/month** |
| Persistent Disk | **$0.25 per GB/month** |
| Example: 1 GB disk | **about $7.25/month total** |

This is a planning estimate, not a guaranteed final bill. Domain registration, taxes, and additional bandwidth/usage can increase the total. Verify the Render pricing page immediately before purchase.

Pricing reference: https://render.com/pricing

## 13. Exactly what the user must do later

Nothing in this plan creates or purchases infrastructure.

When ready to proceed, the human operator must explicitly:

1. Create/sign in to the Render account.
2. Create the planned Web Service.
3. Select the intended repository/branch/commit.
4. Choose the paid compute plan.
5. Attach the Persistent Disk at `/var/data/radarx`.
6. Add the environment variables and secrets in Render.
7. Configure the health check as `/healthz`.
8. Configure the exact HTTPS PWA/API origins.
9. Perform the first staging deploy.
10. Run the physical Android `TEST_PUSH_ONLY` check.
11. Disable `RADARX_STAGING_TEST_PUSH_ENABLED` after the test.
12. Keep all trading-safety invariants unchanged.

No payment method, Render service, domain, DNS record, or deployment is part of this repository change.

## 14. Scope and safety confirmation

This plan does **not** modify:

- strategy logic;
- market-data logic;
- real order execution;
- Paper Trading policy;
- confidence calibration.

The intended runtime safety remains:

```text
paper_trading=true
real_order_execution=false
confidence_score=UNKNOWN
```

The plan is documentation only. It does not create a Render resource and does not deploy anything.
