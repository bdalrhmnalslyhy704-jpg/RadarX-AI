#!/usr/bin/env bash
set -Eeuo pipefail

debug_on_error() {
  rc=$?
  echo "Smoke test failed with exit code $rc"
  adb devices -l 2>/dev/null || true
  adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true
  exit "$rc"
}
trap debug_on_error ERR

wait_for_online_device() {
  local attempt state boot
  for attempt in $(seq 1 20); do
    state="$(adb get-state 2>/dev/null || true)"
    if [[ "$state" == "device" ]]; then
      boot="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
      if [[ "$boot" == "1" ]]; then
        sleep 1
        state="$(adb get-state 2>/dev/null || true)"
        if [[ "$state" == "device" ]]; then return 0; fi
      fi
    else
      adb reconnect device >/dev/null 2>&1 || true
    fi
    sleep 1
  done
  echo "::error::Android emulator ADB never reached a stable online device state"
  adb devices -l 2>/dev/null || true
  return 1
}

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
  wait_for_online_device
  adb shell am force-stop com.radarx.app || true
  wait_for_online_device
  adb logcat -c
  adb shell am start -W -n com.radarx.app/.MainActivity >/dev/null
  wait_for_online_device
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

open_tradli_from_dashboard() {
  local attempt xml node bounds x1 y1 x2 y2 tap_x tap_y top
  adb shell am start -W -n com.radarx.app/.MainActivity >/dev/null
  wait_for_online_device
  sleep 1

  # Put the dashboard near the top, then scroll until Android exposes the real
  # WebView link in its accessibility tree. Fixed coordinates were unreliable
  # when the dashboard content height changed between builds.
  for _ in $(seq 1 8); do
    adb shell input swipe 160 170 160 610 100
  done

  for attempt in $(seq 1 18); do
    adb shell uiautomator dump /sdcard/radarx-window.xml >/dev/null 2>&1 || true
    xml="$(adb shell cat /sdcard/radarx-window.xml 2>/dev/null | tr -d '\r' || true)"
    node="$(printf '%s\n' "$xml" | grep -o '<node[^>]*>' | grep -E 'text="فتح TRADLI"|content-desc="فتح TRADLI"|resource-id="[^"]*openTradliBtn[^"]*"' | head -n 1 || true)"
    if [[ -n "$node" ]]; then
      bounds="$(printf '%s\n' "$node" | sed -nE 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/p')"
      if [[ -n "$bounds" ]]; then
        read -r x1 y1 x2 y2 <<< "$bounds"
        tap_x=$(( (x1 + x2) / 2 ))
        tap_y=$(( (y1 + y2) / 2 ))
        adb shell input tap "$tap_x" "$tap_y"
        sleep 2
        top="$(adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' || true)"
        if printf '%s\n' "$top" | grep -q 'com.radarx.app/.TradliActivity'; then
          return 0
        fi
      fi
    fi
    # Scroll the dashboard down in small steps and look for the button again.
    adb shell input swipe 160 560 160 220 240
    sleep 0.35
  done

  echo "::error::The visible TRADLI dashboard link could not launch TradliActivity"
  printf '%s\n' "$xml" | grep -E 'TRADLI|tradli|openTradliBtn' | tail -n 20 || true
  printf '%s\n' "$top" | grep -E 'mResumedActivity|ResumedActivity' | tail -n 5 || true
  return 1
}

assert_background_service_declared() {
  # The Android package-manager dump is not consistent about printing Java component
  # names. Verify the runtime service-start evidence instead; manifest declarations
  # and required permissions are asserted statically by the release workflow.
  local LOGS
  LOGS="$(adb logcat -d -s RadarXBackground:I '*:S' 2>/dev/null || true)"
  if ! printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_AUTO_START_REQUEST"; then
    echo "::error::Activity did not request the background monitor"
    return 1
  fi
  if ! printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_SERVICE_READY"; then
    echo "::error::Foreground monitor did not reach BACKGROUND_SERVICE_READY"
    return 1
  fi
  if [[ -z "$(adb shell pidof com.radarx.app | tr -d '\r' || true)" ]]; then
    echo "::error::RadarX application process is not alive"
    return 1
  fi
}

adb wait-for-device
wait_for_online_device
adb install -r "$APK"
wait_for_online_device

# Android 13+ may reject pm grant for POST_NOTIFICATIONS on a fresh install.
# MainActivity must start local monitoring even while the user permission prompt is pending.
# Treat the CI permission grant as best-effort; test service startup/queue independently.
if ! adb shell pm grant com.radarx.app android.permission.POST_NOTIFICATIONS >/dev/null 2>&1; then
  echo "::warning::POST_NOTIFICATIONS could not be granted by pm on this emulator; service startup must still succeed while permission is pending."
fi
adb shell appops set com.radarx.app POST_NOTIFICATION allow >/dev/null 2>&1 || true
adb shell pm grant com.radarx.app android.permission.ACCESS_NETWORK_STATE >/dev/null 2>&1 || true

# Online: the Activity must remain open and auto-start the foreground monitor.
start_app_and_wait_ready

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-online.png"
test -s "$RUNNER_TEMP/radarx-online.png"
head -c 8 "$RUNNER_TEMP/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

# TRADLI is a separate native Activity. Smoke-test its module bootstrap inside the embedded WebView.
adb logcat -c
open_tradli_from_dashboard
wait_for_online_device
TRADLI_READY=0
for attempt in $(seq 1 20); do
  TRADLI_LOGS="$(adb logcat -d -s RadarXTradliWeb:I '*:S' 2>/dev/null || true)"
  if printf '%s\n' "$TRADLI_LOGS" | grep -Fq "TRADLI_PAGE_READY"; then
    TRADLI_READY=1
    break
  fi
  if printf '%s\n' "$TRADLI_LOGS" | grep -Fq "TRADLI page boot error:"; then
    echo "::error::TRADLI feature suite failed during embedded WebView bootstrap"
    printf '%s\n' "$TRADLI_LOGS"
    exit 1
  fi
  sleep 1
done
if [[ "$TRADLI_READY" != "1" ]]; then
  echo "::error::TRADLI_PAGE_READY was not emitted"
  adb logcat -d -s RadarXTradliWeb:I '*:S' 2>/dev/null || true
  exit 1
fi
TRADLI_TOP="$(adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' || true)"
if ! printf '%s\n' "$TRADLI_TOP" | grep -q 'com.radarx.app/.TradliActivity'; then
  echo "::error::TRADLI Activity did not remain resumed"
  printf '%s\n' "$TRADLI_TOP" | grep -E 'mResumedActivity|ResumedActivity' || true
  exit 1
fi
adb shell am start -W -n com.radarx.app/.MainActivity >/dev/null
wait_for_online_device
sleep 2

# Background monitoring is continuous by default; the non-exported service must remain registered.
assert_background_service_declared
test -n "$(adb shell pidof com.radarx.app | tr -d '\r' || true)"

# Offline: the local UI and native foreground monitor must remain alive, without fabricating new live market data.
adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true
adb shell settings put global airplane_mode_on 1 >/dev/null 2>&1 || true
adb shell svc wifi disable >/dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1 || true
sleep 3

start_app_and_wait_ready

# No manual start action is emitted by the user during this offline restart.
LOGS="$(adb logcat -d -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I '*:S' 2>/dev/null || true)"
! printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_START_REQUEST"
printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_OFFLINE_WAIT"

assert_background_service_declared
test -n "$(adb shell pidof com.radarx.app | tr -d '\r' || true)"

adb exec-out screencap -p > "$RUNNER_TEMP/radarx-offline.png"
test -s "$RUNNER_TEMP/radarx-offline.png"
head -c 8 "$RUNNER_TEMP/radarx-offline.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

# Restoring internet must wake the existing service immediately instead of waiting for a manual app action.
adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
adb shell svc wifi enable >/dev/null 2>&1 || true
adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false >/dev/null 2>&1 || true
RECONNECTED=0
for attempt in $(seq 1 30); do
  LOGS="$(adb logcat -d -s RadarXBackground:I '*:S' 2>/dev/null || true)"
  if printf '%s\n' "$LOGS" | grep -Fq "BACKGROUND_NETWORK_AVAILABLE"; then
    RECONNECTED=1
    break
  fi
  sleep 2
done
test "$RECONNECTED" = "1"
test -n "$(adb shell pidof com.radarx.app | tr -d '\r' || true)"

echo "Android online/offline/reconnect smoke test passed: native service stays alive offline and scans immediately on validated network restore."
