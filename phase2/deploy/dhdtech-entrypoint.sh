#!/bin/sh
set -eu

# DHDTech may provide no application variables on first deployment.
# Keep all defaults safe and avoid checking a credential into source control.

# The DHDTech catalog exposes container port 8787; enforce the same listener port.
# This prevents a platform-injected PORT value from silently targeting another port.
export PORT=8787
export RADARX_PORT=8787
export RADARX_ENV="${RADARX_ENV:-production}"
# DHDTech is a live public-market monitoring service. Start the 12 market-data
# radars even when a panel variable labels the deployment "staging"; staging here
# must never silently leave every radar idle. This does not enable order execution.
export RADARX_RADARS_AUTOSTART=true
export RADARX_STAGING_TEST_PUSH_ENABLED="${RADARX_STAGING_TEST_PUSH_ENABLED:-false}"
if [ -z "${RADARX_ALLOWED_ORIGINS:-}" ]; then
  export RADARX_ALLOWED_ORIGINS='https://appassets.androidplatform.net,https://radarx-backend.dhdtech.site,https://radarx-build-224.dhdtech.site,https://dhdtech.site'
fi
export RADARX_HOST="${RADARX_HOST:-0.0.0.0}"
export RADARX_REAL_ORDER_EXECUTION=false
export RADARX_PAPER_TRADING=true
export RADARX_CONFIDENCE_MODE=UNKNOWN
# Native Android polling reads the durable feed every five seconds and may use read-only compatibility routes.
# Leave enough shared backend budget for this routine cadence plus concurrent dashboard clients.
export RADARX_API_RATE_LIMIT_PER_MINUTE="${RADARX_API_RATE_LIMIT_PER_MINUTE:-300}"

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

# Prefer the operator's actual DHDTech RadarX volume mount. The user has
# mounted this volume directly at /APP/.RADARX-DATA; that mountpoint is the
# archive directory, not a parent folder to which another directory is appended.
# Preserve an explicit RADARX_DATA_DIR; only auto-detect when it is unset.
if [ -z "${RADARX_DATA_DIR:-}" ]; then
  radarx_mount=""
  for candidate in /APP/.RADARX-DATA /app/.RADARX-DATA /app/.radarx-data /APP/.radarx-data; do
    if [ -d "$candidate" ] && awk -v expected="$candidate" '$2 == expected { found=1 } END { exit(found ? 0 : 1) }' /proc/mounts && [ -w "$candidate" ]; then
      radarx_mount="$candidate"
      break
    fi
  done
  if [ -n "$radarx_mount" ]; then
    export RADARX_DATA_DIR="$radarx_mount"
  elif [ -d /data ] && awk '$2 == "/data" { found=1 } END { exit(found ? 0 : 1) }' /proc/mounts && [ -w /data ]; then
    mkdir -p /data/radarx
    export RADARX_DATA_DIR=/data/radarx
  else
    export RADARX_DATA_DIR=./.radarx-data
  fi
fi
# Migrate only missing files from the old container-local directory. Existing
# persistent records always win; the operation is idempotent across restarts.
if [ -d ./.radarx-data ] && [ "$(cd ./.radarx-data && pwd)" != "$(cd "$RADARX_DATA_DIR" && pwd)" ]; then
  cp -an ./.radarx-data/. "$RADARX_DATA_DIR"/ 2>/dev/null || true
fi
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

echo "[RADARX_DHDTECH_BOOT] build=224 host=$RADARX_HOST port=$PORT data_dir=$RADARX_DATA_DIR radar_autostart=$RADARX_RADARS_AUTOSTART paper_trading=$RADARX_PAPER_TRADING real_order_execution=$RADARX_REAL_ORDER_EXECUTION push_provider=$RADARX_PUSH_PROVIDER"
exec npm start
