#!/usr/bin/env bash
set -euo pipefail
APK="android/app/build/outputs/apk/release/app-release.apk"
test -s "$APK"
adb wait-for-device
adb install -r "$APK" >/dev/null
adb shell am force-stop com.radarx.app || true
adb logcat -c
adb shell am start -W -n com.radarx.app/.MainActivity >/dev/null
for _ in $(seq 1 15); do
  PID="$(adb shell pidof com.radarx.app | tr -d '\r' || true)"
  if [ -n "$PID" ]; then break; fi
  sleep 1
done
test -n "$PID"
LOGS="$(adb logcat -d 2>/dev/null || true)"
if printf '%s\n' "$LOGS" | grep -Eq 'FATAL EXCEPTION|Process com\.radarx\.app.*has died|AndroidRuntime.*FATAL'; then
  echo "RadarX launch crash detected"
  printf '%s\n' "$LOGS" | tail -250
  exit 1
fi
SERVICE="$(adb shell dumpsys activity services com.radarx.app/.RadarXBackgroundMonitorService 2>/dev/null || true)"
if ! printf '%s\n' "$SERVICE" | grep -q 'RadarXBackgroundMonitorService'; then
  echo "Background service was not registered"
  printf '%s\n' "$SERVICE"
  exit 1
fi
echo "RadarX Android 11 launch/background-service smoke passed."
