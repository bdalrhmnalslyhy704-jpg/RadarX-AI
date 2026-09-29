# Render scope note

This document is legacy VPS/systemd documentation; Render settings are defined in `MANAGED_STAGING_RUNBOOK.md`.

# RadarX Phase 2 — Staging Deployment Ready

This directory contains deployment templates only. No public deployment is performed by committing these files.

## Recommended target

For this project, use a small VPS with:
- Linux
- Node.js 24 LTS (Node.js >=20 is the application minimum)
- Caddy
- systemd
- persistent local storage

Node 24 is currently an LTS release; Node 20 reached EOL in March 2026. Keep the application compatibility floor at >=20, but use an actively supported LTS runtime for the staging host.

## Inputs you must provide

Before any real deployment:
1. A VPS or managed server that you control.
2. A DNS name for the PWA and, when separated, a DNS name for the API.
3. Permission to create A/AAAA DNS records.
4. A staging operator/test account.
5. Real VAPID credentials generated for this deployment.
6. A long random RADARX_AUTH_SECRET.
7. An Android phone capable of Web Push through its browser/PWA mode.
8. Access to the host over SSH or the provider dashboard.

No Binance API key, secret, trading permission, withdrawal permission, or private market credential is needed.

## Runtime variables

Required:
- RADARX_ENV=staging
- RADARX_STAGING_TEST_PUSH_ENABLED=true/false explicitly
- RADARX_AUTH_SECRET
- RADARX_PUSH_PROVIDER=webpush
- VAPID_SUBJECT
- VAPID_PUBLIC_KEY
- VAPID_PRIVATE_KEY
- RADARX_ALLOWED_ORIGINS=https://<exact-pwa-origin>

Recommended:
- RADARX_HOST=127.0.0.1
- RADARX_PORT=8787
- RADARX_DATA_DIR=/var/lib/radarx/phase2

Safety:
- RADARX_PAPER_TRADING=true
- RADARX_REAL_ORDER_EXECUTION=false
- RADARX_CONFIDENCE_MODE=UNKNOWN

## Deployment order

### 1. Prepare host

Create the service user and directories:

sudo useradd --system --home /opt/radarx --shell /usr/sbin/nologin radarx
sudo install -d -o radarx -g radarx -m 0750 /var/lib/radarx/phase2
sudo install -d -o root -g radarx -m 0750 /etc/radarx

Install Git, Node.js 24 LTS, and Caddy using the operating system/provider's documented packages.

Verify:

node --version
npm --version
caddy version

### 2. Deploy the repository checkout

Clone the repository into /opt/radarx and checkout this exact branch:

git clone <REPO_URL> /opt/radarx
cd /opt/radarx
git checkout phase2-staging-deployment-ready

Do not checkout main for the staging validation.

Install dependencies:

npm ci

### 3. Create host-only secrets

Create /etc/radarx/phase2-staging.env using deploy/.env.staging.example as a shape, but write real values only on the host.

Generate VAPID credentials outside Git:

npx web-push generate-vapid-keys

Store VAPID_PRIVATE_KEY and RADARX_AUTH_SECRET in the host secret store/EnvironmentFile. Never commit them.

Set RADARX_STAGING_TEST_PUSH_ENABLED=true only for the actual TEST_PUSH_ONLY window.

### 4. Run preflight

The server calls the Staging preflight automatically before starting.

Optional direct check:

RADARX_ENV=staging RADARX_STAGING_TEST_PUSH_ENABLED=true RADARX_PUSH_PROVIDER=webpush RADARX_AUTH_SECRET='<secret>' VAPID_SUBJECT='mailto:<operator-email>' VAPID_PUBLIC_KEY='<public>' VAPID_PRIVATE_KEY='<private>' RADARX_ALLOWED_ORIGINS='https://radarx-staging.example.com' node -e "import('./phase2/deploy/preflight.mjs').then(({assertStagingEnvironment})=>console.log(assertStagingEnvironment(process.env)))"

Never paste real secrets into shell history on a shared machine; prefer a protected secret store.

### 5. Configure systemd

Copy the example unit to:

/etc/systemd/system/radarx-phase2-staging.service

Set the EnvironmentFile path to the host-only secret file.

Then:

sudo systemctl daemon-reload
sudo systemctl enable --now radarx-phase2-staging
sudo systemctl status radarx-phase2-staging --no-pager

A failure at startup is expected when the preflight detects missing/insecure staging configuration.

### 6. Configure DNS

Create:
- A/AAAA record for the PWA hostname → VPS.
- A/AAAA record for the API hostname → VPS.

Wait until authoritative DNS resolves correctly before requesting the public certificate.

### 7. Enable HTTPS with Caddy

Copy deploy/Caddyfile.example to the host Caddy configuration and replace example hostnames.

Validate:

sudo caddy validate --config /etc/caddy/Caddyfile

Then reload:

sudo systemctl reload caddy

Caddy should obtain and renew publicly trusted certificates automatically when the domain resolves to the host and ports 80/443 are reachable.

### 8. Verify server

From a trusted machine:

curl -fsS https://radarx-api-staging.example.com/healthz
curl -fsS https://radarx-api-staging.example.com/readyz

Verify:
- database LIVE;
- WebSocket LIVE or REST fallback LIVE;
- monitoring.running=true;
- bootstrap_done=true;
- recent completed candle exists.

### 9. Android — TEST_PUSH_ONLY only

Do not test LIVE_MARKET_SIGNAL yet.

1. Open the PWA at its HTTPS URL.
2. Open Settings.
3. Enter the HTTPS API URL.
4. Enter the staging Session Token.
5. Save and test connection.
6. Install the PWA from HTTPS.
7. Tap تشغيل التنبيهات.
8. Grant notifications only after the button interaction.
9. Confirm a server-side subscription exists.
10. Tap إرسال TEST_PUSH_ONLY with a unique test_id.
11. The notification must say exactly: اختبار إشعار فقط — ليس تحليلًا للسوق.
12. Wait for the physical Android device to actually display it.
13. Record the receipt time and test_id.
14. Tap the notification.
15. Confirm it opens settings.html, not signal.html.
16. Review server Audit records and confirm event_class=TEST_PUSH_ONLY.

Only after these physical-device checks pass may a later staging step consider LIVE_MARKET_SIGNAL.

### 10. Cleanup

After the test window:

sudo systemctl stop radarx-phase2-staging

Or, if keeping monitoring available:

- set RADARX_STAGING_TEST_PUSH_ENABLED=false;
- restart the service;
- remove the Android Push Subscription from Settings;
- verify the server has no active staging subscription;
- preserve the audit evidence required for the report.

## Rollback

Application rollback:

cd /opt/radarx
git fetch --all
git checkout <previous-known-good-staging-commit>
npm ci
sudo systemctl restart radarx-phase2-staging

Then verify /healthz and /readyz.

Security rollback:
- disable TEST_PUSH_ONLY;
- rotate compromised secrets;
- revoke/reissue the staging session token;
- preserve relevant audit evidence.

## Hosting option notes

A managed service such as Render is operationally simpler. Current Render pricing lists a paid 0.5 CPU/512 MB web service at $7/month, with persistent disks at $0.25/GB/month; paid services do not spin down, and Render supports outbound WebSockets. Free web services are unsuitable for a continuously running market monitor because they spin down after 15 minutes and the local filesystem is ephemeral. See the staging decision table in the project report before purchasing anything.

A VPS gives direct control of systemd, Caddy, filesystem permissions, firewall rules, logs and rollback. Provider pricing depends on region/plan and should be checked immediately before purchase.

## Cost boundary

Do not purchase infrastructure merely by following this repository. The files are deployment-ready templates; the actual VPS/domain/managed-service purchase remains an explicit operator action.

## Safety boundary

This branch only prepares staging deployment. It does not create cloud resources, DNS records, certificates, paid subscriptions, exchange credentials, or trading orders.
