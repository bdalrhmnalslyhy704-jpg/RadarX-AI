#!/bin/sh
set -eu

# DHDTech may provide no application variables on first deployment.
# Keep all defaults safe and avoid checking a credential into source control.

# The DHDTech catalog exposes container port 8787; enforce the same listener port.
# This prevents a platform-injected PORT value from silently targeting another port.
export PORT=8787
export RADARX_PORT=8787
export RADARX_ENV="${RADARX_ENV:-production}"
export RADARX_STAGING_TEST_PUSH_ENABLED="${RADARX_STAGING_TEST_PUSH_ENABLED:-false}"
export RADARX_ALLOWED_ORIGINS="${RADARX_ALLOWED_ORIGINS:-https://appassets.androidplatform.net,https://radarx-backend.dhdtech.site}"
export RADARX_HOST="${RADARX_HOST:-0.0.0.0}"
export RADARX_REAL_ORDER_EXECUTION=false
export RADARX_PAPER_TRADING=true
export RADARX_CONFIDENCE_MODE=UNKNOWN

# Push is optional for public Spot market-data monitoring. Prefer configured FCM/Web Push;
# otherwise use the explicit no-op provider and preserve local-polling notifications.
if [ -z "${RADARX_PUSH_PROVIDER:-}" ]; then
  if [ -n "${FCM_PROJECT_ID:-}" ] && [ -n "${FCM_SERVICE_ACCOUNT_JSON:-}" ]; then
    RADARX_PUSH_PROVIDER=fcm
  elif [ -n "${VAPID_SUBJECT:-}" ] && [ -n "${VAPID_PUBLIC_KEY:-}" ] && [ -n "${VAPID_PRIVATE_KEY:-}" ]; then
    RADARX_PUSH_PROVIDER=webpush
  else
    RADARX_PUSH_PROVIDER=none
  fi
fi
export RADARX_PUSH_PROVIDER

export RADARX_DATA_DIR="${RADARX_DATA_DIR:-./.radarx-data}"
mkdir -p "$RADARX_DATA_DIR"
chmod 700 "$RADARX_DATA_DIR" 2>/dev/null || true

# If no auth secret was configured in the host panel, create a cryptographically random
# private secret in the app data directory; never use a hard-coded public fallback.
if [ -z "${RADARX_AUTH_SECRET:-}" ]; then
  secret_file="$RADARX_DATA_DIR/.auth-secret"
  if [ ! -s "$secret_file" ]; then
    tmp_file="$secret_file.tmp.$$"
    (umask 077; node --input-type=module -e "import {randomBytes} from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))" > "$tmp_file")
    chmod 600 "$tmp_file" 2>/dev/null || true
    mv "$tmp_file" "$secret_file"
  fi
  RADARX_AUTH_SECRET="$(cat "$secret_file")"
  export RADARX_AUTH_SECRET
fi

echo "[RADARX_DHDTECH_BOOT] build=224 host=$RADARX_HOST port=$PORT paper_trading=$RADARX_PAPER_TRADING real_order_execution=$RADARX_REAL_ORDER_EXECUTION push_provider=$RADARX_PUSH_PROVIDER"
exec npm start
