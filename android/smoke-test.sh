#!/usr/bin/env bash
set -euo pipefail

debug_on_error() {
  rc=$?
  echo "Smoke test failed with exit code $rc"
  adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true
  exit "$rc"
}
trap debug_on_error ERR

APK="android/app/build/outputs/apk/release/app-release.apk"

cleanup() {
  adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
  adb shell svc wifi enable >/dev/null 2>&1 || true
}
trap cleanup EXIT

adb wait-for-device
adb install -r "$APK"
adb logcat -c
adb shell am force-stop com.radarx.app || true
adb shell am start -n com.radarx.app/.MainActivity >/dev/null

ready=0
scan_complete=0
background_ready=0
web_errors=0
for i in $(seq 1 18); do
  sleep 3
  LOGS="$(adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
  if printf '%s
' "$LOGS" | grep -Fq "UI_READY"; then ready=1; fi
  if printf '%s
' "$LOGS" | grep -Fq "SCAN_COMPLETE"; then scan_complete=1; fi
  if printf '%s
' "$LOGS" | grep -Fq "BACKGROUND_SERVICE_READY"; then background_ready=1; fi
  if printf '%s
' "$LOGS" | grep -Eqi "RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)"; then web_errors=1; fi
  if [ "$ready" = "1" ] && [ "$scan_complete" = "1" ] && [ "$background_ready" = "1" ]; then break; fi
done

test "$ready" = "1"
test "$scan_complete" = "1"
test "$background_ready" = "1"
test "$web_errors" = "0"

LOGS="$(adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
! printf '%s
' "$LOGS" | grep -Eqi "RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)"

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-online.png"
test -s "$RUNNER_TEMP/radarx-online.png"
head -c 8 "$RUNNER_TEMP/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true
adb shell settings put global airplane_mode_on 1 >/dev/null 2>&1 || true
adb shell svc wifi disable >/dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1 || true
sleep 3

adb logcat -c
adb shell am force-stop com.radarx.app
adb shell am start -n com.radarx.app/.MainActivity >/dev/null

offline_ready=0
offline_background=0
offline_errors=0
for i in $(seq 1 12); do
  sleep 2
  LOGS="$(adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
  if printf '%s
' "$LOGS" | grep -Fq "UI_READY"; then offline_ready=1; fi
  if printf '%s
' "$LOGS" | grep -Fq "BACKGROUND_SERVICE_READY"; then offline_background=1; fi
  if printf '%s
' "$LOGS" | grep -Eqi "RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)"; then offline_errors=1; fi
  if [ "$offline_ready" = "1" ] && [ "$offline_background" = "1" ]; then break; fi
done

test "$offline_ready" = "1"
test "$offline_background" = "1"
test "$offline_errors" = "0"

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-offline.png"
test -s "$RUNNER_TEMP/radarx-offline.png"
head -c 8 "$RUNNER_TEMP/radarx-offline.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

echo "Android emulator online/offline UI + background smoke tests passed."
