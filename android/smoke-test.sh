#!/usr/bin/env bash
set -euo pipefail

APK="android/app/build/outputs/apk/release/app-release.apk"
DEVICE="\${ANDROID_SERIAL:-emulator-5554}"

cleanup() {
  adb -s "$DEVICE" shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  adb -s "$DEVICE" shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
  adb -s "$DEVICE" shell svc wifi enable >/dev/null 2>&1 || true
}
trap cleanup EXIT

adb -s "$DEVICE" wait-for-device
adb -s "$DEVICE" install -r "$APK"
adb -s "$DEVICE" logcat -c
adb -s "$DEVICE" shell am force-stop com.radarx.app || true
adb -s "$DEVICE" shell am start -n com.radarx.app/.MainActivity >/dev/null

ready=0
connected=0
for i in $(seq 1 12); do
  sleep 3
  LOGS="$(adb -s "$DEVICE" logcat -d -s RadarXSmoke:I '*:S' 2>/dev/null || true)"
  if printf '%s\n' "$LOGS" | grep -Fq "UI_READY"; then ready=1; fi
  if printf '%s\n' "$LOGS" | grep -Fq "BACKEND_CONNECTED"; then connected=1; fi
  if [ "$ready" = "1" ] && [ "$connected" = "1" ]; then break; fi
done
test "$ready" = "1"
test "$connected" = "1"

adb -s "$DEVICE" exec-out screencap -p > "$RUNNER_TEMP/radarx-online.png"
test -s "$RUNNER_TEMP/radarx-online.png"
head -c 8 "$RUNNER_TEMP/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

adb -s "$DEVICE" shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true
adb -s "$DEVICE" shell settings put global airplane_mode_on 1 >/dev/null 2>&1 || true
adb -s "$DEVICE" shell svc wifi disable >/dev/null 2>&1 || true
adb -s "$DEVICE" shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1 || true
sleep 3

adb -s "$DEVICE" logcat -c
adb -s "$DEVICE" shell am force-stop com.radarx.app
adb -s "$DEVICE" shell am start -n com.radarx.app/.MainActivity >/dev/null

ready_offline=0
disconnected=0
for i in $(seq 1 8); do
  sleep 2
  LOGS="$(adb -s "$DEVICE" logcat -d -s RadarXSmoke:I '*:S' 2>/dev/null || true)"
  if printf '%s\n' "$LOGS" | grep -Fq "UI_READY"; then ready_offline=1; fi
  if printf '%s\n' "$LOGS" | grep -Fq "BACKEND_DISCONNECTED"; then disconnected=1; fi
  if [ "$ready_offline" = "1" ] && [ "$disconnected" = "1" ]; then break; fi
done
test "$ready_offline" = "1"
test "$disconnected" = "1"

adb -s "$DEVICE" exec-out screencap -p > "$RUNNER_TEMP/radarx-offline.png"
test -s "$RUNNER_TEMP/radarx-offline.png"
head -c 8 "$RUNNER_TEMP/radarx-offline.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

echo "Android emulator online/offline smoke tests passed."
