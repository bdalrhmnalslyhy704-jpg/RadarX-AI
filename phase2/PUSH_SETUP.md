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

## FCM

Firebase Cloud Messaging is not included yet. The provider interface is isolated so an FCM implementation can be added later.

## Security checklist

- never commit .env files that contain secrets;
- never place VAPID_PRIVATE_KEY in the PWA;
- never add exchange trading credentials;
- use HTTPS at the public edge;
- restrict CORS to the exact PWA origin;
- rotate compromised secrets immediately;
- protect the .radarx-data directory and host volume;
- keep the monitor behind a supervisor with restart-on-failure.
