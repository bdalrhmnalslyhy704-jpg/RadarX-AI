# RadarX Phase 2 — Managed Staging Runbook (Render-style Web Service)

> **Status: planning/documentation only.**
>
> This runbook does **not** create a Render account, Web Service, Static Site, domain, DNS record, paid subscription, or deployment. It contains no real secrets and does not modify `main`.
>
> Staging safety invariants:
> - `RADARX_ENV=staging`
> - `RADARX_STAGING_TEST_PUSH_ENABLED=true` only during the physical TEST_PUSH_ONLY window
> - `RADARX_PUSH_PROVIDER=webpush`
> - `RADARX_PAPER_TRADING=true`
> - `RADARX_REAL_ORDER_EXECUTION=false`
> - `RADARX_CONFIDENCE_MODE=UNKNOWN`
> - No Binance API credentials or exchange user-data credentials.
> - No order, cancellation, withdrawal, or real-trading endpoint.
> - No `LIVE_MARKET_SIGNAL` field test before a successful physical Android `TEST_PUSH_ONLY` test.

## 1. Final managed architecture

The current repository separates the Node monitoring/API process from the static PWA files. For a Render-style managed deployment, the clean target is:

| Component | Managed target | Purpose | Expected cost |
|---|---|---|---:|
| Backend | **Paid Web Service** | Node.js monitor, REST API, outbound Binance WSS, Web Push | **$7/month starting tier** |
| Durable store | **Persistent Disk attached to Web Service** | subscriptions, settings, dedup, signal/notification audit | **$0.25/GB/month** |
| PWA | **Static Site** (recommended) | Serves `phase1/app.html` and service worker over HTTPS | $0 on Render's current Free Static Site offering |
| HTTPS/TLS | Managed by Render | Public HTTPS for Web Service/Static Site/custom domains | Included |
| Domain | Your registrar | Stable staging hostname | Registrar price varies |

Render currently lists a 0.5 CPU/512 MB paid Web Service at $7/month and persistent disks at $0.25/GB/month. Managed TLS and custom domains are supported. Free Web Services are not suitable for this field test because they can spin down after 15 minutes of inactivity and their local filesystem is ephemeral. citeturn114003search2turn114003search0turn980726search5

**Budget example:** a $7/month backend plus a 1 GB persistent disk would be approximately **$7.25/month**, before any separately purchased domain, taxes, or other usage that Render may bill. The **current cost is $0** because this runbook does not create or activate anything.

### Important current-code compatibility gate

Render Web Services must listen on `0.0.0.0` and a Render web-service port (the platform defaults to `PORT=10000`). The current RadarX staging preflight on this branch deliberately requires a loopback bind address. Therefore:

**Do not create the Render service or deploy this branch yet.**

A small, separately approved code change is required to support managed-host binding safely while preserving the staging/read-only invariants. The required change is not part of this documentation-only task.

The application currently reads `RADARX_PORT`, not Render's `PORT`, so the managed target should use `RADARX_PORT=10000` while the host-binding compatibility patch is prepared. Render's documented requirement for `0.0.0.0` is a hard deployment requirement. citeturn980726search1

## 2. Render service creation — planned steps only

### 2.1 Create the backend Web Service

In the Render Dashboard:

1. Sign in to the Render account **only when you are ready to perform the external setup**.
2. Choose **New → Web Service**.
3. Connect the GitHub account/repository that contains RadarX.
4. Select repository:
   `bdalrhmnalslyhy704-jpg/RadarX-AI`
5. Select the branch:
   `phase2-staging-deployment-ready`
6. Do **not** select `main`.
7. Choose the Node.js runtime.
8. Select a small paid Web Service for the first continuous staging test.

Render's Web Service form includes the repository, branch, runtime, build command, start command, environment variables, persistent disk, and health-check settings. citeturn114003search0turn947960search6

### 2.2 Node.js version

Use **Node.js 24 LTS** for staging.

The repository's package engine currently permits Node `>=20`, but Node 20 reached EOL on March 24, 2026. Node 24 is an active LTS line as of September 2026. citeturn114003search3turn114003search4

Do not choose Node 20 merely because it is the current application minimum.

### 2.3 Build Command

Current branch has `package.json` but no committed `package-lock.json`, so use:

```text
npm install --omit=dev
```

Do **not** use `npm ci` until a lockfile is intentionally committed and maintained.

### 2.4 Start Command

For the managed target, the intended application command is:

```text
node phase2/server.mjs
```

The persistent-storage hard gate can be expressed operationally as:

```text
test -n "$RADARX_DATA_DIR" && test -d "$RADARX_DATA_DIR" && test -w "$RADARX_DATA_DIR" || { echo "ERROR: persistent storage unavailable"; exit 1; }; node phase2/server.mjs
```

Use the guarded form only after the required managed-host binding patch is approved.

The application's own staging preflight already rejects missing/unsafe auth, Web Push, origin, and read-only safety settings before the monitor starts.

## 3. Health Check

Set Render's HTTP Health Check Path to:

```text
/healthz
```

Render accepts HTTP health checks that return a `2xx` or `3xx` response and uses them to determine whether an instance can receive traffic. citeturn114003search1

After deployment, verify both:

```text
https://<backend-host>/healthz
https://<backend-host>/readyz
```

Expected operational gate:

- `/healthz` → HTTP 200.
- `/readyz` → HTTP 200.
- `readyz` must report the durable store as `LIVE`.
- WebSocket must be `LIVE`, or the documented REST fallback must be `LIVE`.
- `monitoring.running=true`.
- `bootstrap_done=true`.
- A recent completed candle must exist.

`/readyz` returning 503 is a **do-not-proceed** condition.

## 4. WebSocket configuration

There is no separate Render switch that needs to be enabled for RadarX's **outbound Binance WebSocket** path.

Render Web Services support outbound WebSocket connections. The RadarX monitor already has multiple public Binance WSS endpoints and reconnect/backoff logic. The field verification is therefore runtime verification, not a special dashboard toggle.

During staging verify:

```text
health.websocket.state === "LIVE"
```

If the WebSocket drops, the application should recover through its existing reconnect logic and REST reconciliation/fallback.

For a future **public browser-to-RadarX WebSocket**, the public URL must use `wss://`; Render routes public WebSocket traffic through the web-service port. Do not invent or test a client WebSocket endpoint that the current RadarX API does not expose. citeturn980726search0

## 5. Persistent Disk

The current `DurableStore` writes:

- push subscriptions;
- user settings;
- deduplication state;
- signal audit JSONL;
- notification audit JSONL.

Therefore persistent storage is **required for the field test** if the purpose is to retain subscriptions/audit across restarts and deploys.

Render's default service filesystem is ephemeral. A persistent disk preserves only the files written beneath its mount path. Persistent disks are available for paid Web Services and are billed at $0.25/GB/month. citeturn114003search5

Planned setup:

- Attach a Render Persistent Disk to the backend Web Service.
- Use a dedicated mount path such as:
  `/var/data/radarx`
- Set:
  `RADARX_DATA_DIR=/var/data/radarx`
- Choose the smallest disk size that safely covers the staging retention window.
- Do not store secrets on the application disk.

**Hard gate:** if the disk is not attached at the configured path, do not consider Staging ready. The start command's directory/writeability check can fail the process, but persistence itself must also be verified by an observed restart/deploy because a writable path alone does not prove durability.

Adding a persistent disk also changes Render's deploy behavior: Render documents that attaching one disables zero-downtime deploys. Treat that as a staging risk and schedule field tests accordingly. citeturn947960search0turn114003search6

## 6. Environment Variables

Set all values from the Render Dashboard's Environment section. Never put real secret values in GitHub.

Required safety values:

| Variable | Required value | Secret? |
|---|---|---:|
| `RADARX_ENV` | `staging` | No |
| `RADARX_STAGING_TEST_PUSH_ENABLED` | `true` only during TEST_PUSH_ONLY; otherwise `false` | No |
| `RADARX_PUSH_PROVIDER` | `webpush` | No |
| `RADARX_PAPER_TRADING` | `true` | No |
| `RADARX_REAL_ORDER_EXECUTION` | `false` | No |
| `RADARX_CONFIDENCE_MODE` | `UNKNOWN` | No |
| `RADARX_ALLOWED_ORIGINS` | exact HTTPS PWA origin | No |

Secret variables:

- `RADARX_AUTH_SECRET`
- `VAPID_PRIVATE_KEY`

Required Web Push variable names:

- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

Operational variables needed by this current deployment shape:

- `RADARX_HOST`
- `RADARX_PORT`
- `RADARX_DATA_DIR`

For the intended managed-host configuration, the values are planned as:

```text
RADARX_HOST=0.0.0.0
RADARX_PORT=10000
RADARX_DATA_DIR=/var/data/radarx
```

**These three values cannot be applied to the current branch as-is because its staging preflight intentionally rejects a non-loopback host.** This is the blocker described in Section 1.

Render supports adding environment variables and secrets in the Dashboard and redeploying with the saved configuration. citeturn114003search7

### Secret rules

Do not paste real values into:

- `.env.staging.example`;
- this runbook;
- PR text;
- GitHub Issues;
- frontend code;
- screenshots;
- browser local storage.

Generate VAPID credentials outside the repository and store the private key only in the managed secret store.

## 7. Exact HTTPS PWA origin

The PWA origin must be a single exact HTTPS origin with no trailing slash.

Example placeholder only:

```text
https://radarx-staging.example.com
```

Then set:

```text
RADARX_ALLOWED_ORIGINS=https://radarx-staging.example.com
```

If you use Render's temporary `onrender.com` hostname during initial verification, substitute that exact HTTPS origin instead. When a custom staging domain is added, update the variable to the custom-domain origin and redeploy.

Do not use:

```text
http://...
https://.../
*
```

The test Push endpoint requires the browser `Origin` to match an allowed origin, in addition to authentication.

## 8. PWA hosting on Render

The current Node API server is an API/monitor server; it does not serve `phase1/app.html` as a static website.

For a Render-only managed topology, use:

- **Backend Web Service:** Node API/monitor.
- **Static Site:** `phase1/app.html`, service worker, and PWA assets.

The Static Site may use the same branch:

```text
phase2-staging-deployment-ready
```

The PWA's final URL becomes the exact value used in `RADARX_ALLOWED_ORIGINS`.

No live notification test should be started merely because the PWA loads. Health, readiness, subscription, and TEST_PUSH_ONLY must all pass first.

## 9. Custom HTTPS domain

When you are ready to use a real domain:

1. Register/control a staging hostname with your DNS provider.
2. Add the required DNS record(s) for the Render Web Service and Static Site.
3. Add the custom domain in Render.
4. Wait for verification.
5. Confirm the site opens with a publicly trusted HTTPS certificate.
6. Update `RADARX_ALLOWED_ORIGINS` to the exact PWA origin.
7. Redeploy the backend with the updated environment variable.
8. Re-check `/healthz` and `/readyz`.

Render provides managed TLS and custom domains for Web Services. citeturn114003search0

Do not use a self-signed certificate for the physical Web Push validation.

## 10. Deploy flow — after the compatibility gate is cleared

The final execution order is:

1. Confirm the approved code supports Render's `0.0.0.0` host binding and Render port.
2. Create the paid Web Service.
3. Connect GitHub repository.
4. Select `phase2-staging-deployment-ready`.
5. Set Node 24 LTS.
6. Set build command.
7. Attach the persistent disk.
8. Set all environment variables in the Render Dashboard.
9. Configure `/healthz`.
10. Configure the custom domain/HTTPS when available.
11. Deploy.
12. Check `/healthz`.
13. Check `/readyz`.
14. Confirm Binance WebSocket or REST fallback is LIVE.
15. Confirm durable storage is writable and persistent.
16. Open the PWA over HTTPS.
17. Install the PWA on the Android device.
18. Manually tap the notification-enable control.
19. Confirm a Push Subscription is created.
20. Set `RADARX_STAGING_TEST_PUSH_ENABLED=true` only for the test window.
21. Send a unique authenticated `TEST_PUSH_ONLY`.
22. Confirm the physical Android device displays it.
23. Tap the notification.
24. Confirm it opens `settings.html`, not `signal.html`.
25. Record delivery evidence.
26. Delete the Push Subscription after the test.
27. Set `RADARX_STAGING_TEST_PUSH_ENABLED=false`.
28. Redeploy/restart the service.
29. Confirm the test endpoint is disabled.
30. Only after all of that may a later, separately authorized staging procedure consider `LIVE_MARKET_SIGNAL`.

## 11. TEST_PUSH_ONLY vs LIVE_MARKET_SIGNAL vs TEST_FIXTURE

### TEST_PUSH_ONLY

Purpose: **transport and device delivery test only**.

Properties:

- staging only;
- authenticated;
- trusted HTTPS Origin required;
- no market-analysis meaning;
- notification explicitly says it is a test;
- notification click opens Settings;
- never treated as a market signal;
- no numeric confidence.

This is the mandatory physical-device gate.

### LIVE_MARKET_SIGNAL

Purpose: **real market-monitoring event** produced from an actual completed public market-data candle after the configured data/liquidity/risk gates pass.

Properties:

- real public market source;
- carries a real signal/event identity;
- click opens the signal detail page;
- still paper/read-only;
- `confidence_score=UNKNOWN`;
- never creates an exchange order.

A `LIVE_MARKET_SIGNAL` physical-device test is forbidden until `TEST_PUSH_ONLY` has been physically received successfully on Android.

### TEST_FIXTURE

Purpose: **automated deterministic test data**.

Properties:

- synthetic fixture;
- used by unit/integration tests;
- not proof of Binance live connectivity;
- not proof of physical phone receipt;
- must remain distinguishable from `LIVE_MARKET_SIGNAL`.

## 12. Pre-run safety gates

Do not start the field window unless every gate below passes.

### Configuration gate

Fail closed when:

- `RADARX_ENV` is not `staging`;
- `RADARX_STAGING_TEST_PUSH_ENABLED` is not explicitly `true` or `false`;
- `RADARX_PUSH_PROVIDER` is not `webpush`;
- `RADARX_AUTH_SECRET` is missing or too short;
- any VAPID variable is missing;
- `RADARX_ALLOWED_ORIGINS` is empty or contains a non-HTTPS origin;
- `RADARX_REAL_ORDER_EXECUTION=true`;
- `RADARX_PAPER_TRADING=false`;
- `RADARX_CONFIDENCE_MODE` is not `UNKNOWN`.

The current branch already has an application-level Staging preflight for these controls.

### Persistent-storage gate

Fail the deployment window when:

- the required Render Persistent Disk is not attached;
- `RADARX_DATA_DIR` is not set to the disk mount path;
- the path does not exist;
- the service cannot write to the path;
- a restart test shows the subscription/audit state did not persist.

### Origin gate

Fail when the PWA is not opened from its exact HTTPS origin or the server is configured with a different origin.

### Test classification gate

Fail when:

- a test event is labeled `LIVE_MARKET_SIGNAL`;
- a TEST_PUSH_ONLY contains market-signal semantics;
- a TEST_FIXTURE is treated as proof of live data;
- a numeric confidence value appears where the contract requires `UNKNOWN`.

## 13. Field checklist

### Service

- [ ] Managed backend service is running.
- [ ] `/healthz` returns HTTP 200.
- [ ] `/readyz` returns HTTP 200.
- [ ] Monitor is running.
- [ ] Binance WebSocket is LIVE or approved REST fallback is LIVE.
- [ ] Persistent storage is attached, writable, and survives a restart.

### PWA / Android

- [ ] PWA opens over HTTPS.
- [ ] PWA is installed on Android.
- [ ] User manually pressed تشغيل التنبيهات.
- [ ] Notification permission is granted.
- [ ] Push Subscription exists server-side.
- [ ] API origin matches the exact PWA origin.

### TEST_PUSH_ONLY

- [ ] `RADARX_STAGING_TEST_PUSH_ENABLED=true`.
- [ ] Request is authenticated.
- [ ] Request Origin is trusted.
- [ ] Unique `test_id` is used.
- [ ] Audit class is `TEST_PUSH_ONLY`.
- [ ] No `TEST_FIXTURE` marker is present.
- [ ] Physical Android device received the notification.
- [ ] Notification click opened `settings.html`.
- [ ] Receipt time and test ID were recorded.

### Cleanup

- [ ] Push Subscription deleted after the test.
- [ ] Active staging subscription count verified.
- [ ] `RADARX_STAGING_TEST_PUSH_ENABLED=false`.
- [ ] Service restarted/redeployed with test pushes disabled.
- [ ] Test evidence preserved.
- [ ] No LIVE_MARKET_SIGNAL test was executed before the TEST_PUSH_ONLY gate.

## 14. Rollback to a known commit

### Fast path

Use the managed provider's **Deploys** page to select a previously successful deploy and choose **Rollback**.

Render documents that rollback can reuse the target deploy's build artifact and that Dashboard rollbacks automatically disable auto-deploys as a safeguard. citeturn947960search1

### Exact commit path

For an explicit known-good SHA:

1. Record the exact known-good commit SHA.
2. Go to Render → Service → Deploys.
3. Use **Manual Deploy → Deploy a specific commit**.
4. Enter the full/short SHA.
5. Disable auto-deploy if the rollback is intended to remain pinned.
6. Wait for the deploy to become live.
7. Re-check `/healthz` and `/readyz`.
8. Re-check WebSocket/fallback state.
9. Re-check persistent audit/subscription state.
10. Keep `RADARX_STAGING_TEST_PUSH_ENABLED=false` until the rollback is proven healthy.

Render supports deploying a specific Git commit by SHA and documents the automatic-deploy implications. citeturn947960search0

Do not delete the audit disk during application rollback.

## 15. Risks

1. **Current binding incompatibility:** the current staging preflight requires loopback, while Render Web Services require `0.0.0.0`. This must be resolved in a separate approved code change before deployment.
2. **Free Web Service sleeping:** not acceptable for a continuously running monitor.
3. **Ephemeral storage:** without a persistent disk, subscriptions and audit files can disappear on restart/deploy.
4. **Persistent disk deploy behavior:** Render documents that persistent disks disable zero-downtime deploys.
5. **WebSocket interruption:** Render can replace instances during deploys and platform maintenance; the monitor must reconnect and reconcile.
6. **Push delivery variability:** browser/OS permissions, battery policies, network conditions, and push-provider behavior can delay or prevent device delivery.
7. **Origin mistakes:** an incorrect `RADARX_ALLOWED_ORIGINS` prevents trusted browser operations.
8. **Secret exposure:** leaking `RADARX_AUTH_SECRET` or `VAPID_PRIVATE_KEY` requires immediate rotation and re-issuance of the staging session token.
9. **Auto-deploy drift:** a deployment pinned to a specific commit can be replaced later if auto-deploy is re-enabled or another branch configuration is used.

## 16. What you must provide before actual deployment

Nothing should be sent into GitHub.

Before the external deployment step, the operator must have:

- a Render account with permission to create the service;
- authorization to incur the selected monthly cost;
- the GitHub repository connected to that account;
- the exact staging PWA hostname;
- the exact staging API hostname;
- DNS control for those hostnames if a custom domain is used;
- a staging operator/test identity;
- real VAPID credentials generated outside the repository;
- a strong `RADARX_AUTH_SECRET`;
- an Android phone and browser/PWA environment that supports Web Push;
- agreement on the small code patch required for Render host binding.

No Binance trading credentials are required.

## 17. What cannot be tested before the domain/service exists

These items cannot be truthfully marked PASS from the repository/CI alone:

- real Render Web Service runtime;
- real managed HTTPS certificate;
- real DNS resolution;
- real Render Persistent Disk durability;
- actual outbound Binance WebSocket connectivity from the managed host;
- actual `/readyz` state on the managed host;
- real browser Push Subscription creation against the deployed API;
- physical Android Push receipt;
- notification click routing from a real OS notification;
- cleanup persistence after deleting the subscription;
- behavior across a real managed-service restart/deploy.

CI can validate application logic and security gates, but it cannot prove physical-device delivery.

## 18. Explicit non-actions in this runbook

This runbook does not:

- create a Render account;
- connect or authorize GitHub in Render;
- create a Web Service;
- create a Static Site;
- purchase compute;
- add a Persistent Disk;
- create DNS records;
- attach a custom domain;
- issue certificates;
- generate or store real VAPID keys;
- create real secrets;
- deploy a commit;
- test `LIVE_MARKET_SIGNAL`;
- merge `main`.

---

### Planned managed-staging settings summary

```text
Repository:
  bdalrhmnalslyhy704-jpg/RadarX-AI

Branch:
  phase2-staging-deployment-ready

Runtime:
  Node.js 24 LTS

Build:
  npm install --omit=dev

Start:
  node phase2/server.mjs
  (with the persistent-storage guard shown above when the approved
   Render host-binding patch is available)

Planned Render bind:
  RADARX_HOST=0.0.0.0
  RADARX_PORT=10000

Persistent data:
  RADARX_DATA_DIR=/var/data/radarx
  Render Persistent Disk attached at /var/data/radarx

Health:
  /healthz

Readiness:
  /readyz

Mandatory:
  RADARX_ENV=staging
  RADARX_STAGING_TEST_PUSH_ENABLED=true  (test window only)
  RADARX_PUSH_PROVIDER=webpush
  RADARX_PAPER_TRADING=true
  RADARX_REAL_ORDER_EXECUTION=false
  RADARX_CONFIDENCE_MODE=UNKNOWN

Origin:
  RADARX_ALLOWED_ORIGINS=<exact HTTPS PWA origin>

Secrets (Dashboard/secret store only):
  RADARX_AUTH_SECRET
  VAPID_SUBJECT
  VAPID_PUBLIC_KEY
  VAPID_PRIVATE_KEY
```
