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

  test -n "$(adb shell pidof com.radarx.app | tr -d '\r' || true)"

  TOP="$(adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' || true)"
  printf '%s\n' "$TOP" | grep -q 'com.radarx.app/.MainActivity'

  LOGS="$(adb logcat -d -s RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
  ! printf '%s\n' "$LOGS" | grep -Eqi 'RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)'
  ! printf '%s\n' "$LOGS" | grep -Fq 'RadarX Dashboard boot error:'

  # The service must not start merely because the Activity was opened.
  ! printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_START_REQUEST"
  ! printf '%s\n' "$LOGS" | grep -Fq "BRIDGE_START_BACKGROUND"
}

assert_background_service_declared() {
  PACKAGE="$(adb shell dumpsys package com.radarx.app 2>/dev/null | tr -d '\\r' || true)"
  printf '%s\n' "$PACKAGE" | grep -q 'RadarXBackgroundMonitorService'
  printf '%s\n' "$PACKAGE" | grep -q 'FOREGROUND_SERVICE_DATA_SYNC'
}

adb wait-for-device
adb install -r "$APK"

# Online: the Activity must remain open and NOT auto-start the foreground monitor.
start_app_and_wait_ready

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-online.png"
test -s "$RUNNER_TEMP/radarx-online.png"
head -c 8 "$RUNNER_TEMP/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

# Background monitoring is explicitly user-controlled; the non-exported service must remain registered.
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

echo "Android emulator online/offline UI + no-auto-start/background-service registration smoke tests passed."
