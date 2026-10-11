#!/usr/bin/env bash
set -Eeuo pipefail

PHASE="initialization"

debug_on_error() {
  local rc=$?
  trap - ERR
  set +e
  echo "::error::RadarX Android smoke test failed during: ${PHASE} (exit ${rc})"
  timeout 5s adb devices -l 2>&1 | tail -n 40 || true
  timeout 10s adb logcat -d -b all -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I AndroidRuntime:E ActivityTaskManager:E '*:S' 2>&1 | tail -n 180 || true
  timeout 8s adb shell dumpsys activity activities 2>&1 | tail -n 80 || true
  exit "${rc}"
}
trap debug_on_error ERR

APK="${RADARX_APK_PATH:-android/app/build/outputs/apk/release/app-release.apk}"
START_ACTION="com.radarx.app.action.START_BACKGROUND_MONITOR"

cleanup() {
  timeout 5s adb shell am force-stop com.radarx.app >/dev/null 2>&1 || true
  timeout 5s adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
  timeout 5s adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
  timeout 5s adb shell svc wifi enable >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_app_and_wait_ready() {
  PHASE="force-stop before clean launch"
  timeout 15s adb shell am force-stop com.radarx.app || true
  timeout 10s adb logcat -c

  # Do not use `am start -W`: it waits for Android's launch/idle completion and
  # can hang while a WebView initializes on a cold CI emulator. Launch normally,
  # then independently verify process, resumed Activity, JS health and service.
  PHASE="launch MainActivity without blocking for WebView idle"
  local start_output
  start_output="$(timeout 30s adb shell am start -n com.radarx.app/.MainActivity 2>&1)" || {
    local rc=$?
    echo "::error::MainActivity launch command failed (exit ${rc})"
    echo "${start_output}"
    return "${rc}"
  }
  echo "MainActivity launch: ${start_output}"

  PHASE="wait for live process and resumed Activity"
  local pid="" top="" resumed="" ready=0
  for attempt in $(seq 1 20); do
    pid="$(timeout 5s adb shell pidof com.radarx.app 2>/dev/null | tr -d '\\r' || true)"
    top="$(timeout 7s adb shell dumpsys activity activities 2>/dev/null | tr -d '\\r' || true)"
    resumed="$(printf '%s\\n' "${top}" | grep -E 'mResumedActivity|ResumedActivity' | tail -n 5 || true)"
    if [[ -n "${pid}" ]] && printf '%s\\n' "${resumed}" | grep -q 'com.radarx.app'; then
      ready=1
      break
    fi
    sleep 2
  done
  if [[ "${ready}" -ne 1 ]]; then
    echo "::error::RadarX process/Activity did not become ready"
    echo "PID=${pid:-NONE}"
    printf '%s\\n' "${resumed}"
    timeout 10s adb shell dumpsys activity exit-info com.radarx.app 2>/dev/null | tail -n 100 || true
    timeout 10s adb logcat -d -b crash 2>/dev/null | tail -n 140 || true
    return 1
  fi
  echo "RadarX process/Activity ready: pid=${pid}"

  PHASE="wait for background foreground-service startup"
  local logs="" service_ready=0
  for attempt in $(seq 1 15); do
    logs="$(timeout 8s adb logcat -d -s RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
    if printf '%s\\n' "${logs}" | grep -Fq "BACKGROUND_AUTO_START_REQUEST" &&
       printf '%s\\n' "${logs}" | grep -Fq "BACKGROUND_SERVICE_READY"; then
      service_ready=1
      break
    fi
    sleep 2
  done

  if printf '%s\\n' "${logs}" | grep -Eqi 'RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)'; then
    echo "::error::RadarX WebView runtime JavaScript error detected"
    printf '%s\\n' "${logs}" | tail -n 180
    return 1
  fi
  if printf '%s\\n' "${logs}" | grep -Fq 'RadarX Dashboard boot error:'; then
    echo "::error::RadarX dashboard boot error detected"
    printf '%s\\n' "${logs}" | tail -n 180
    return 1
  fi
  if [[ "${service_ready}" -ne 1 ]]; then
    echo "::error::Expected automatic monitor startup markers were not observed"
    printf '%s\\n' "${logs}" | tail -n 180
    return 1
  fi
}

assert_background_service_declared() {
  PHASE="verify background service manifest registration"
  local package_dump
  package_dump="$(timeout 12s adb shell dumpsys package com.radarx.app 2>/dev/null | tr -d '\\r' || true)"
  printf '%s\\n' "${package_dump}" | grep -q 'RadarXBackgroundMonitorService'
  printf '%s\\n' "${package_dump}" | grep -q 'FOREGROUND_SERVICE_DATA_SYNC'
}

PHASE="wait for Android emulator device"
timeout 60s adb wait-for-device
PHASE="install debug APK"
timeout 45s adb install -r "${APK}"

# Online: the Activity must remain open and auto-start the foreground monitor.
start_app_and_wait_ready

PHASE="capture online screenshot"
timeout 15s adb exec-out screencap -p > "${RUNNER_TEMP}/radarx-online.png"
test -s "${RUNNER_TEMP}/radarx-online.png"
head -c 8 "${RUNNER_TEMP}/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

# Background monitoring is continuous by default; the non-exported service must remain registered.
assert_background_service_declared
test -n "$(timeout 5s adb shell pidof com.radarx.app | tr -d '\\r' || true)"

# Offline: the local UI Activity must still remain open without the backend.
PHASE="simulate offline state"
timeout 10s adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true
timeout 10s adb shell settings put global airplane_mode_on 1 >/dev/null 2>&1 || true
timeout 10s adb shell svc wifi disable >/dev/null 2>&1 || true
timeout 10s adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1 || true
sleep 3

start_app_and_wait_ready

# The monitor may auto-start, but it must not be misclassified as a user-initiated request.
PHASE="verify offline startup is not user-initiated"
LOGS="$(timeout 10s adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
! printf '%s\\n' "${LOGS}" | grep -Fq "BACKGROUND_START_REQUEST"

assert_background_service_declared
test -n "$(timeout 5s adb shell pidof com.radarx.app | tr -d '\\r' || true)"

PHASE="capture offline screenshot"
timeout 15s adb exec-out screencap -p > "${RUNNER_TEMP}/radarx-offline.png"
test -s "${RUNNER_TEMP}/radarx-offline.png"
head -c 8 "${RUNNER_TEMP}/radarx-offline.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

echo "Android emulator online/offline UI + continuous-auto-start/background-service registration smoke tests passed."
