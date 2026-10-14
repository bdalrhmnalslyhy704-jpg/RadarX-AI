# RadarX Phase 2 - Push Notification Setup

## Default state

Push delivery is disabled by default:

RADARX_PUSH_PROVIDER=none

## Web Push setup

Web Push uses VAPID credentials on the server.

1. Install dependencies:

npm install

2. Generate a VAPID key pair outside Git. With web-push installed, an operator can run:

npx web-push generate-vapid-keys

3. Put the generated values into the deployment secret store or process environment:

RADARX_PUSH_PROVIDER=webpush
VAPID_SUBJECT=mailto:operator@example.invalid
VAPID_PUBLIC_KEY=<public-key>
VAPID_PRIVATE_KEY=<private-key>
RADARX_AUTH_SECRET=<long-random-server-secret>

4. Never commit the private VAPID key or the auth secret. Do not put them in source code, PR text, browser bundles, or phase1/app.html.

The public VAPID key may be exposed to the browser during a later authenticated/configuration flow. The private VAPID key is server-only.

## Subscription lifecycle

The browser obtains a Push subscription and calls:

POST /v1/subscriptions

with an authenticated bearer token and the subscription JSON.

The server stores the endpoint and encryption keys in server-side durable storage. The API response intentionally omits the keys.

To remove a subscription:

DELETE /v1/subscriptions/:id

Only the authenticated owner can remove it.

## Notification settings

The server filters with:

- enabled / disabled;
- symbols;
- timeframes;
- minimum Data Quality;
- minimum Liquidity Quality;
- signal types ENTRY_CANDIDATE and CONFIRMED.

These settings are server-side, so notification processing does not require the phone to stay connected.

## Development authentication token

A development token can be printed without writing it to disk:

RADARX_AUTH_SECRET='...' npm run issue-token -- --user local-user

Treat the token as a credential. A public deployment should use a real identity provider instead of the development token tool.

## Native Android Push — Firebase Cloud Messaging (FCM)

FCM is implemented in the native Android client and in the Phase 2 backend provider. It remains **disabled until the operator provisions credentials**. The existing 5-second polling/local-notification path remains the fallback when Firebase is absent or the backend reports FCM not ready.

### 1. Firebase Android app configuration

1. Create or select a Firebase project and register the Android app with application ID `com.radarx.app`.
2. Enable Firebase Cloud Messaging (HTTP v1) for that project.
3. Download the app's `google-services.json` and place it at `android/app/google-services.json` only in a private build workspace/CI secret. The Gradle plugin is automatically applied when that file exists. Do not commit the file unless the project owner explicitly chooses to publish the Firebase client configuration.
4. Build/install the APK from that configured workspace. Without this file, the APK deliberately logs `FCM_NOT_CONFIGURED_LOCAL_NOTIFICATION_FALLBACK_ACTIVE` and continues the existing local polling path.

### 2. Railway backend secrets

On the existing `RadarX-AI-Triple` service, set the runtime guardrails and the FCM variables through Railway's secret-variable UI. Do not create another service or volume:

```text
RADARX_ENV=production
RADARX_STAGING_TEST_PUSH_ENABLED=false
RADARX_PUSH_PROVIDER=fcm
RADARX_AUTH_SECRET=<random secret with at least 32 characters>
RADARX_ALLOWED_ORIGINS=https://appassets.androidplatform.net
RADARX_PAPER_TRADING=true
RADARX_REAL_ORDER_EXECUTION=false
RADARX_CONFIDENCE_MODE=UNKNOWN
FCM_PROJECT_ID=<Firebase project ID>
FCM_SERVICE_ACCOUNT_JSON=<single-line JSON for a service account>
```

Use a password manager or secret generator for `RADARX_AUTH_SECRET`. Keep the allowed-origin value aligned with the real installed PWA origin if that origin changes. The production startup preflight validates the provider-specific credentials and the read-only safety flags; add all required values together, then verify the deployment rather than setting `RADARX_ENV=production` by itself.

The service account must be permitted to send FCM messages (Firebase Cloud Messaging API Admin or a narrower equivalent role). Enable the FCM HTTP v1 API. The backend exchanges the private service-account key for a short-lived OAuth access token and caches that token in memory; it does not store the access token in the archive. The service-account JSON contains a private key and must never be committed, logged, placed in the APK, or returned by any API. The Firebase Android client config and the server service-account credentials are different things.

After the variables are set, check `/healthz` and logs for the provider status. A device registration will return `FCM_PUSH_NOT_ENABLED` until the provider is correctly configured.

### 3. Device registration and staging verification

Once the configured APK is installed and notification permission has been granted, the app fetches the current FCM registration token and sends it to:

`POST /api/push/device/register`

The API stores the token privately in the existing durable `/data/.radarx-data/subscriptions.json` archive; it never returns the token. Token refreshes are re-registered automatically. The route validates a UUID installation ID and token shape, obeys API rate limits, and requires that Android reports notification permission as granted. To remove a device registration, use `DELETE /api/push/device/:installation_id`.

For staging only, set `RADARX_ENV=staging` and `RADARX_STAGING_TEST_PUSH_ENABLED=true`, then send `POST /api/push/device/test` with `{"installation_id":"<device UUID>","test_id":"android-smoke-01"}`. This emits only `TEST_PUSH_ONLY`, never a market signal. Keep this gate disabled in production.

### 4. Timing and validation

FCM uses high-priority Android messages, a 30-second delivery TTL, a high-importance channel, and the device's default sound. This improves prompt delivery but cannot guarantee display in under one second: carrier/Wi-Fi state, Android Doze, manufacturer battery controls, notification permission, FCM availability, and channel settings remain outside the backend's control. Measure actual server-send-to-device receipt on a configured physical Android phone; successful CI or an HTTP `SENT` result proves provider acceptance, not user-visible receipt.

Do not switch production to `RADARX_PUSH_PROVIDER=fcm` until the service account is configured and a physical-device `TEST_PUSH_ONLY`/real-alert field test passes. Keep `paper_trading=true`, `real_order_execution=false`, and `confidence_score=UNKNOWN`.

## Security checklist

- never commit .env files that contain secrets;
- never place VAPID_PRIVATE_KEY in the PWA;
- never add exchange trading credentials;
- use HTTPS at the public edge;
- restrict CORS to the exact PWA origin;
- rotate compromised secrets immediately;
- protect the .radarx-data directory and host volume;
- keep the monitor behind a supervisor with restart-on-failure.
