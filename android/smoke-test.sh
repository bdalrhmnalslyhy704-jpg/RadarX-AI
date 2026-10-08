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
SERVICE_COMPONENT="com.radarx.app/.RadarXBackgroundMonitorService"
START_ACTION="com.radarx.app.action.START_BACKGROUND_MONITOR"

cleanup() {
  adb shell am force-stop com.radarx.app >/dev/null 2>&1 || true
  adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
  adb shell svc wifi enable >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_app_and_wait_ready() {
  adb shell am force-stop com.radarx.app || true
  adb logcat -c
  adb shell am start -W -n com.radarx.app/.MainActivity >/dev/null
  sleep 8

  PID="$(adb shell pidof com.radarx.app | tr -d '\r' || true)"
  if [[ -z "$PID" ]]; then
    echo "::error::RadarX process is not alive after launch"
    adb shell dumpsys activity exit-info com.radarx.app 2>/dev/null | tail -n 120 || true
    adb logcat -d -b crash 2>/dev/null | tail -n 160 || true
    return 1
  fi

  TOP="$(adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' || true)"
  RESUMED="$(printf '%s\n' "$TOP" | grep -E 'mResumedActivity|ResumedActivity' | tail -n 5 || true)"
  if ! printf '%s\n' "$RESUMED" | grep -q 'com.radarx.app'; then
    echo "::error::RadarX MainActivity is not resumed after launch"
    printf '%s\n' "$RESUMED"
    adb shell dumpsys activity top 2>/dev/null | tail -n 80 || true
    return 1
  fi

  LOGS="$(adb logcat -d -s RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
  if printf '%s\n' "$LOGS" | grep -Eqi 'RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)'; then
    echo "::error::RadarX WebView runtime JavaScript error detected"
    printf '%s\n' "$LOGS"
    return 1
  fi
  if printf '%s\n' "$LOGS" | grep -Fq 'RadarX Dashboard boot error:'; then
    echo "::error::RadarX dashboard boot error detected"
    printf '%s\n' "$LOGS"
    return 1
  fi

  # Build 224 now requires continuous monitoring: opening the Activity auto-starts
  # the foreground service when notifications are permitted. This must be explicit
  # in the native logs and must not crash/close the Activity.
  printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_AUTO_START_REQUEST"
  printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_SERVICE_READY"
}

assert_background_service_declared() {
  PACKAGE="$(adb shell dumpsys package com.radarx.app 2>/dev/null | tr -d '\\r' || true)"
  printf '%s\n' "$PACKAGE" | grep -q 'RadarXBackgroundMonitorService'
  printf '%s\n' "$PACKAGE" | grep -q 'FOREGROUND_SERVICE_DATA_SYNC'
}

adb wait-for-device
adb install -r "$APK"

# Online: the Activity must remain open and auto-start the foreground monitor.
start_app_and_wait_ready

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-online.png"
test -s "$RUNNER_TEMP/radarx-online.png"
head -c 8 "$RUNNER_TEMP/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

# Background monitoring is continuous by default; the non-exported service must remain registered.
assert_background_service_declared
test -n "$(adb shell pidof com.radarx.app | tr -d '\r' || true)"

# Offline: the local UI Activity must still remain open without the backend.
adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true
adb shell settings put global airplane_mode_on 1 >/dev/null 2>&1 || true
adb shell svc wifi disable >/dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1 || true
sleep 3

start_app_and_wait_ready

# No automatic background start even offline.
LOGS="$(adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
! printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_START_REQUEST"

assert_background_service_declared
test -n "$(adb shell pidof com.radarx.app | tr -d '\r' || true)"

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-offline.png"
test -s "$RUNNER_TEMP/radarx-offline.png"
head -c 8 "$RUNNER_TEMP/radarx-offline.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

echo "Android emulator online/offline UI + continuous-auto-start/background-service registration smoke tests passed."
