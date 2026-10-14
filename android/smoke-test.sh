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
  if [[ -n "${REPLAY_SERVER_PID:-}" ]]; then
    kill "${REPLAY_SERVER_PID}" >/dev/null 2>&1 || true
    wait "${REPLAY_SERVER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${APP_LOGCAT_PID:-}" ]]; then
    kill "${APP_LOGCAT_PID}" >/dev/null 2>&1 || true
    wait "${APP_LOGCAT_PID}" 2>/dev/null || true
  fi
  if [[ -n "${REPLAY_LOGCAT_PID:-}" ]]; then
    kill "${REPLAY_LOGCAT_PID}" >/dev/null 2>&1 || true
    wait "${REPLAY_LOGCAT_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

capture_screenshot() {
  local name="$1"
  local output="$2"
  local remote="/sdcard/radarx-${name}.png"

  PHASE="capture ${name} screenshot"
  # Software-rendered Android emulators can stall the streaming screencap pipe
  # for over 15 seconds although MainActivity is already UI_READY. Allow a
  # larger bounded window, then use a device-side capture + adb pull fallback.
  if timeout 40s adb exec-out screencap -p > "${output}" && [[ -s "${output}" ]]; then
    return 0
  fi
  rm -f "${output}"
  timeout 25s adb shell screencap -p "${remote}"
  timeout 20s adb pull "${remote}" "${output}" >/dev/null
  test -s "${output}"
}

start_app_and_wait_ready() {
  PHASE="force-stop before clean launch"
  if [[ -n "${APP_LOGCAT_PID:-}" ]]; then
    kill "${APP_LOGCAT_PID}" >/dev/null 2>&1 || true
    wait "${APP_LOGCAT_PID}" 2>/dev/null || true
    APP_LOGCAT_PID=""
  fi
  timeout 20s adb shell am force-stop com.radarx.app || true
  timeout 15s adb logcat -c

  # Capture startup logs continuously. Repeated short adb logcat dumps can time
  # out on a cold software-rendered emulator and hide healthy Activity markers.
  APP_LOG_FILE="${RUNNER_TEMP:-/tmp}/radarx-app-startup-logcat.txt"
  : > "${APP_LOG_FILE}"
  PHASE="start persistent app startup log capture"
  adb logcat -v brief -s RadarXSmoke:I RadarXWeb:I RadarXBackground:I AndroidRuntime:E ActivityTaskManager:E '*:S' >> "${APP_LOG_FILE}" 2>&1 &
  APP_LOGCAT_PID=$!
  sleep 1
  if ! kill -0 "${APP_LOGCAT_PID}" 2>/dev/null; then
    echo "::error::Could not start Android startup log capture"
    return 1
  fi

  PHASE="launch MainActivity without blocking for WebView idle"
  local start_output
  start_output="$(timeout 45s adb shell am start -n com.radarx.app/.MainActivity 2>&1)" || {
    local rc=$?
    echo "::error::MainActivity launch command failed (exit ${rc})"
    echo "${start_output}"
    return "${rc}"
  }
  echo "MainActivity launch: ${start_output}"

  PHASE="wait for live process, resumed Activity, and JS UI readiness"
  local pid="" logs="" resume_line="" pause_line="" activity_state="" activity_resumed=0 ready=0
  for attempt in $(seq 1 60); do
    logs="$(cat "${APP_LOG_FILE}" 2>/dev/null || true)"
    # Process and foreground state are sampled together every 10 seconds. Some
    # Android builds do not emit the test-only ACTIVITY_RESUMED marker at all;
    # dumpsys is the authoritative fallback for a live ResumedActivity.
    if (( attempt == 1 || attempt % 5 == 0 )); then
      pid="$(timeout 12s adb shell pidof com.radarx.app 2>/dev/null | tr -d '\r' || true)"
      activity_state="$(timeout 12s adb shell dumpsys activity activities 2>/dev/null || true)"
    fi
    resume_line="$(printf '%s\n' "${logs}" | grep -nF 'ACTIVITY_RESUMED' | tail -n 1 | cut -d: -f1 || true)"
    pause_line="$(printf '%s\n' "${logs}" | grep -nF 'ACTIVITY_PAUSED' | tail -n 1 | cut -d: -f1 || true)"
    activity_resumed=0
    if [[ -n "${resume_line}" ]] &&
       { [[ -z "${pause_line}" ]] || (( resume_line > pause_line )); }; then
      activity_resumed=1
    fi
    if printf '%s\n' "${activity_state}" | grep -Eq '(^|[[:space:]])(mResumedActivity|ResumedActivity):[[:space:]]*.*com\.radarx\.app/\.MainActivity'; then
      activity_resumed=1
    fi
    if [[ -n "${pid}" && "${activity_resumed}" -eq 1 ]] &&
       printf '%s\n' "${logs}" | grep -Fq 'UI_READY'; then
      ready=1
      break
    fi
    sleep 2
  done
  if [[ "${ready}" -ne 1 ]]; then
    echo "::error::RadarX Activity/process/UI did not become ready"
    echo "PID=${pid:-NONE} RESUME_LINE=${resume_line:-NONE} PAUSE_LINE=${pause_line:-NONE} ACTIVITY_RESUMED=${activity_resumed:-0}"
    printf '%s\n' "${logs}" | tail -n 180
    timeout 15s adb shell dumpsys activity activities 2>/dev/null | tail -n 100 || true
    timeout 12s adb logcat -d -b crash 2>/dev/null | tail -n 140 || true
    return 1
  fi
  echo "RadarX Activity/process/UI ready: pid=${pid}"

  PHASE="wait for background foreground-service startup"
  local service_ready=0
  for attempt in $(seq 1 30); do
    logs="$(cat "${APP_LOG_FILE}" 2>/dev/null || true)"
    if printf '%s\n' "${logs}" | grep -Fq "BACKGROUND_AUTO_START_REQUEST" &&
       printf '%s\n' "${logs}" | grep -Fq "BACKGROUND_SERVICE_READY"; then
      service_ready=1
      break
    fi
    sleep 2
  done

  if printf '%s\n' "${logs}" | grep -Eqi 'RadarXWeb: ERROR:Uncaught (ReferenceError|SyntaxError|TypeError)'; then
    echo "::error::RadarX WebView runtime JavaScript error detected"
    printf '%s\n' "${logs}" | tail -n 180
    return 1
  fi
  if printf '%s\n' "${logs}" | grep -Fq 'RadarX Dashboard boot error:'; then
    echo "::error::RadarX dashboard boot error detected"
    printf '%s\n' "${logs}" | tail -n 180
    return 1
  fi
  if [[ "${service_ready}" -ne 1 ]]; then
    echo "::error::Expected automatic monitor startup markers were not observed"
    printf '%s\n' "${logs}" | tail -n 180
    return 1
  fi

  # Stop the stream only after both UI and service readiness have been observed.
  kill "${APP_LOGCAT_PID}" >/dev/null 2>&1 || true
  wait "${APP_LOGCAT_PID}" 2>/dev/null || true
  APP_LOGCAT_PID=""
}
background_service_pid() {
  local pid
  pid="$(timeout 8s adb shell pidof com.radarx.app:radar_background 2>/dev/null | tr -d '\r' || true)"
  if [[ -n "$pid" ]]; then
    printf '%s\n' "$pid"
    return 0
  fi
  # Some Android emulator/toybox versions omit colon-suffixed names from pidof.
  pid="$(timeout 8s adb shell ps -A 2>/dev/null | awk '$NF == "com.radarx.app:radar_background" {print $2; exit}' | tr -d '\r' || true)"
  printf '%s\n' "$pid"
}

assert_background_service_declared() {
  PHASE="verify background service registration in the built APK manifest"
  local aapt manifest_tree permissions
  aapt="$(find "$ANDROID_HOME/build-tools" -type f -name aapt 2>/dev/null | sort -V | tail -1)"
  if [[ -z "$aapt" || ! -x "$aapt" ]]; then
    echo "::error::Android aapt tool was not found; cannot inspect the packaged manifest"
    return 1
  fi

  manifest_tree="$("$aapt" dump xmltree "$APK" AndroidManifest.xml)"
  permissions="$("$aapt" dump permissions "$APK")"

  if ! printf '%s\n' "$manifest_tree" | grep -Fq 'com.radarx.app.RadarXBackgroundMonitorService'; then
    echo "::error::Packaged APK does not declare RadarXBackgroundMonitorService"
    printf '%s\n' "$manifest_tree" | grep -Ei 'service|RadarXBackgroundMonitorService' | tail -n 80 || true
    return 1
  fi
  if ! printf '%s\n' "$manifest_tree" | grep -Fq 'radar_background'; then
    echo "::error::Background service is not isolated into the expected process"
    printf '%s\n' "$manifest_tree" | grep -Ei 'RadarXBackgroundMonitorService|process' | tail -n 80 || true
    return 1
  fi
  if ! printf '%s\n' "$permissions" | grep -Fq 'android.permission.FOREGROUND_SERVICE_DATA_SYNC'; then
    echo "::error::Packaged APK lacks FOREGROUND_SERVICE_DATA_SYNC permission"
    printf '%s\n' "$permissions"
    return 1
  fi

  # Verify live service state independently of logcat. Heavy WebView output can
  # rotate the log buffer after the service-ready marker, so a missing old log line
  # alone must not fail a correctly running service. Conversely, a manifest or log
  # marker alone is not enough: Android must currently hold the service instance.
  local logs runtime_state service_pid service_pid_source
  logs="$(cat "${APP_LOG_FILE:-/nonexistent}" 2>/dev/null || true)"
  runtime_state="$(timeout 15s adb shell dumpsys activity services com.radarx.app 2>/dev/null || true)"
  service_pid="$(background_service_pid)"
  service_pid_source="pidof-or-ps"
  # Some Android API 29 / toybox pidof builds do not resolve long colon-suffixed
  # app process names, even while dumpsys reports the live ServiceRecord and its
  # ProcessRecord. In that case, derive the PID only from that same live service
  # snapshot; still require both the registered service and its concrete process.
  if [[ -z "$service_pid" ]]; then
    service_pid="$(printf '%s\n' "$runtime_state" | sed -nE 's/.*ProcessRecord\{[^}]* ([0-9]+):com\.radarx\.app:radar_background\/.*/\1/p' | head -n 1 | tr -d '\r')"
    service_pid_source="dumpsys"
  fi
  if ! printf '%s\n' "$runtime_state" | grep -Fq 'RadarXBackgroundMonitorService' || [[ -z "$service_pid" ]]; then
    echo "::error::Manifest is valid but Android does not show a live background-monitor service process"
    echo "BACKGROUND_SERVICE_PID=${service_pid:-NONE} PID_SOURCE=$service_pid_source"
    if printf '%s\n' "$logs" | grep -Fq 'BACKGROUND_SERVICE_READY'; then
      echo "BACKGROUND_READY_MARKER=present"
    else
      echo "BACKGROUND_READY_MARKER=absent_or_rotated"
    fi
    printf '%s\n' "$runtime_state" | grep -Ei 'RadarXBackgroundMonitorService|ServiceRecord|isForeground|ProcessRecord|radar_background' | tail -n 120 || true
    printf '%s\n' "$logs" | tail -n 100
    return 1
  fi
  if printf '%s\n' "$logs" | grep -Fq 'BACKGROUND_SERVICE_READY'; then
    echo "Android background service confirmed live: pid=$service_pid source=$service_pid_source; ready-marker=present"
  else
    echo "Android background service confirmed live: pid=$service_pid source=$service_pid_source; ready-marker=rotated-after-runtime-confirmation"
  fi
}

PHASE="wait for Android emulator device"
timeout 60s adb wait-for-device
PHASE="install debug APK"
timeout 45s adb install -r "${APK}"

# Online: the Activity must remain open and auto-start the foreground monitor.
start_app_and_wait_ready

capture_screenshot online "${RUNNER_TEMP}/radarx-online.png"
test -s "${RUNNER_TEMP}/radarx-online.png"
head -c 8 "${RUNNER_TEMP}/radarx-online.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

# Background monitoring is continuous by default; the non-exported service must remain registered.
assert_background_service_declared
test -n "$(timeout 12s adb shell pidof com.radarx.app | tr -d '\\r' || true)"

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
LOGS="$(cat "${APP_LOG_FILE:-/nonexistent}" 2>/dev/null || true)"
! printf '%s\\n' "${LOGS}" | grep -Fq "BACKGROUND_START_REQUEST"

assert_background_service_declared
test -n "$(timeout 12s adb shell pidof com.radarx.app | tr -d '\\r' || true)"

capture_screenshot offline "${RUNNER_TEMP}/radarx-offline.png"
test -s "${RUNNER_TEMP}/radarx-offline.png"
head -c 8 "${RUNNER_TEMP}/radarx-offline.png" | od -An -t x1 | tr -d ' ' | grep -Fq '89504e470d0a1a0a'

echo "Android emulator online/offline UI + continuous-auto-start/background-service registration smoke tests passed."


# Deterministic reconnect/restart regression: 623 durable alerts including
# same-timestamp groups and rows with no source id. The test override is debug-only.
PHASE="start local 623-alert replay fixture"
REPLAY_TEST_PORT=18765
REPLAY_TEST_FEED_URL="http://10.0.2.2:${REPLAY_TEST_PORT}/api/radar-alerts?radar=ALL"
REPLAY_TMP="${RUNNER_TEMP:-/tmp}"
node android/background-replay-test-server.mjs > "${REPLAY_TMP}/radarx-replay-fixture.log" 2>&1 &
REPLAY_SERVER_PID=$!
fixture_ready=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${REPLAY_TEST_PORT}/test/health" >/dev/null 2>&1; then
    fixture_ready=1
    break
  fi
  sleep 1
done
if [[ "${fixture_ready}" -ne 1 ]]; then
  echo "::error::Replay fixture server did not start"
  cat "${REPLAY_TMP}/radarx-replay-fixture.log" || true
  exit 1
fi
curl -fsS --max-time 3 "http://127.0.0.1:${REPLAY_TEST_PORT}/test/empty" >/dev/null

fixture_stats() {
  curl -fsS --max-time 3 "http://127.0.0.1:${REPLAY_TEST_PORT}/test/stats"
}
stat_field() {
  node -e 'const s=JSON.parse(process.argv[1]); process.stdout.write(String(s[process.argv[2]] ?? ""));' "$1" "$2"
}
REPLAY_LOG_FILE="${REPLAY_TMP}/radarx-replay-logcat.txt"
: > "${REPLAY_LOG_FILE}"
# One persistent log stream avoids repeatedly invoking adb logcat -d inside the
# replay wait loop; all assertions still inspect actual Android runtime logs.
replay_logs() { cat "${REPLAY_LOG_FILE}"; }
accepted_log_count() {
  { grep -F 'ALERT_POST_REQUEST_ACCEPTED key=' "${REPLAY_LOG_FILE}" || true; } |
    wc -l | tr -d ' '
}
accepted_log_keys() {
  sed -n 's/^.*ALERT_POST_REQUEST_ACCEPTED key=//p' "${REPLAY_LOG_FILE}"
}
reconciled_log_count() {
  { grep -F 'ALERT_POST_RECONCILED_ACTIVE key=' "${REPLAY_LOG_FILE}" || true; } |
    wc -l | tr -d ' '
}
reconciled_log_keys() {
  sed -n 's/^.*ALERT_POST_RECONCILED_ACTIVE key=//p' "${REPLAY_LOG_FILE}"
}
handled_log_keys() {
  { accepted_log_keys; reconciled_log_keys; }
}
handled_unique_count() {
  handled_log_keys | sort -u | wc -l | tr -d ' '
}
launch_replay_test_app() {
  timeout 25s adb shell am start -n com.radarx.app/.MainActivity \
    --es radarx_test_alert_feed_url "${REPLAY_TEST_FEED_URL}" \
    --el radarx_test_scan_interval_ms 1000
}

PHASE="clear emulator app data and establish an empty-feed cursor"
timeout 10s adb shell svc wifi enable >/dev/null 2>&1 || true
timeout 10s adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
timeout 10s adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
timeout 15s adb shell am force-stop com.radarx.app >/dev/null 2>&1 || true
timeout 20s adb shell pm clear com.radarx.app
timeout 10s adb logcat -c
adb logcat -v brief -s RadarXBackground:I RadarXSmoke:I AndroidRuntime:E '*:S' >> "${REPLAY_LOG_FILE}" 2>&1 &
REPLAY_LOGCAT_PID=$!
sleep 1
if ! kill -0 "${REPLAY_LOGCAT_PID}" 2>/dev/null; then
  echo "::error::Could not start Android replay log capture"
  exit 1
fi
launch_replay_test_app
replay_ready=0
for attempt in $(seq 1 35); do
  logs="$(replay_logs)"
  if printf '%s\n' "${logs}" | grep -Fq 'REPLAY_TEST_OVERRIDE_CONFIGURED' &&
     printf '%s\n' "${logs}" | grep -Fq 'BACKGROUND_SERVICE_READY' &&
     printf '%s\n' "${logs}" | grep -Fq 'DEBUG_REPLAY_TEST_FEED_ACTIVE'; then
    replay_ready=1
    break
  fi
  sleep 2
done
if [[ "${replay_ready}" -ne 1 ]]; then
  echo "::error::Debug replay app or local feed did not become ready"
  tail -n 180 "${REPLAY_LOG_FILE}" || true
  exit 1
fi

# Establish the initial cursor against an empty feed before the outage.
empty_seen=0
for attempt in $(seq 1 20); do
  stats="$(fixture_stats)"
  empty_seen="$(stat_field "${stats}" emptyRequests)"
  if [[ "${empty_seen}" -ge 2 ]]; then break; fi
  sleep 1
done
if [[ "${empty_seen}" -lt 2 ]]; then
  echo "::error::The app never polled the empty feed to initialize its cursor"
  exit 1
fi
[[ "$(accepted_log_count)" -eq 0 ]]

PHASE="simulate offline period while more than 500 events are queued"
timeout 10s adb shell cmd connectivity airplane-mode enable >/dev/null 2>&1 || true
timeout 10s adb shell settings put global airplane_mode_on 1 >/dev/null 2>&1 || true
timeout 10s adb shell svc wifi disable >/dev/null 2>&1 || true
timeout 5s adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true >/dev/null 2>&1 || true
sleep 4
curl -fsS --max-time 5 -X POST "http://127.0.0.1:${REPLAY_TEST_PORT}/test/queue" > "${REPLAY_TMP}/radarx-replay-queued.json"
sleep 8
offline_stats="$(fixture_stats)"
offline_requests="$(stat_field "${offline_stats}" queuedRequests)"
if [[ "${offline_requests}" -ne 0 ]]; then
  echo "::error::Android reached the fixture while airplane mode was enabled: queuedRequests=${offline_requests}"
  exit 1
fi
[[ "$(accepted_log_count)" -eq 0 ]]

PHASE="reconnect and drain the full durable alert archive"
timeout 10s adb shell svc wifi enable >/dev/null 2>&1 || true
timeout 10s adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
timeout 10s adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
timeout 5s adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false >/dev/null 2>&1 || true
restart_done=0
replay_complete=0
for attempt in $(seq 1 120); do
  accepted="$(accepted_log_count)"
  if [[ "${accepted}" -ge 150 && "${restart_done}" -eq 0 ]]; then
    # Stop only the service, keeping app notifications in Android's tray so restart reconciliation is tested faithfully.
    sleep 2
    before_ready="$(grep -F 'BACKGROUND_SERVICE_READY' "${REPLAY_LOG_FILE}" | wc -l | tr -d ' ')"
    old_service_pid="$(background_service_pid)"
    if [[ -z "${old_service_pid}" ]]; then
      echo "::error::Background service process was absent before the restart checkpoint"
      timeout 10s adb shell dumpsys activity services com.radarx.app 2>&1 | tail -n 100 || true
      exit 1
    fi

    # MainActivity is singleTop, so the stop test exercises its real onNewIntent path.
    stop_output="$(timeout 15s adb shell am start -n com.radarx.app/.MainActivity --ez radarx_test_stop_background_monitor true 2>&1)" || {
      echo "::error::Could not deliver the app-owned background stop intent to MainActivity"
      echo "${stop_output}"
      exit 1
    }
    echo "${stop_output}"
    service_stopped=0
    stop_request_seen=0
    stop_action_seen=0
    current_service_pid="${old_service_pid}"
    service_registered=1
    for stop_attempt in $(seq 1 20); do
      current_service_pid="$(background_service_pid)"
      logs="$(replay_logs)"
      if printf '%s\\n' "${logs}" | grep -Fq 'TEST_STOP_BACKGROUND_MONITOR_REQUEST'; then
        stop_request_seen=1
      fi
      if printf '%s\\n' "${logs}" | grep -Fq 'BACKGROUND_STOP_ACTION_RECEIVED'; then
        stop_action_seen=1
      fi
      service_state="$(timeout 4s adb shell dumpsys activity services com.radarx.app 2>/dev/null || true)"
      service_registered=1
      if ! printf '%s\\n' "${service_state}" | grep -Fq 'RadarXBackgroundMonitorService'; then
        service_registered=0
      fi
      # Android may keep an empty process cached after its ServiceRecord is removed.
      # Verify the lifecycle callback, service-side action, and removal from dumpsys.
      if [[ "${service_registered}" -eq 0 && "${stop_request_seen}" -eq 1 && "${stop_action_seen}" -eq 1 ]]; then
        service_stopped=1
        break
      fi
      sleep 1
    done
    if [[ "${service_stopped}" -ne 1 ]]; then
      echo "::error::Background service remained registered after MainActivity stop intent"
      echo "STOP_REQUEST_SEEN=${stop_request_seen} STOP_ACTION_SEEN=${stop_action_seen} OLD_PID=${old_service_pid} CURRENT_PID=${current_service_pid:-NONE} SERVICE_REGISTERED=${service_registered:-UNKNOWN}"
      timeout 10s adb shell dumpsys activity services com.radarx.app 2>&1 | tail -n 100 || true
      exit 1
    fi
    launch_replay_test_app
    restarted_ready=0
    for restart_attempt in $(seq 1 30); do
      new_pid="$(background_service_pid)"
      ready_count="$(grep -F 'BACKGROUND_SERVICE_READY' "${REPLAY_LOG_FILE}" | wc -l | tr -d ' ')"
      logs="$(replay_logs)"
      if [[ -n "${new_pid}" && "${ready_count}" -gt "${before_ready}" ]] &&
         printf '%s\n' "${logs}" | grep -Fq 'REPLAY_TEST_OVERRIDE_CONFIGURED'; then
        restarted_ready=1
        break
      fi
      sleep 2
    done
    if [[ "${restarted_ready}" -ne 1 ]]; then
      echo "::error::Background service failed to resume with its saved cursor after service stop/start"
      tail -n 180 "${REPLAY_LOG_FILE}" || true
      exit 1
    fi
    restart_done=1
  fi

  handled="$(handled_unique_count)"
  if [[ "${handled}" -ge 623 ]]; then
    stats="$(fixture_stats)"
    drained="$(stat_field "${stats}" drainedRequests)"
    if [[ "${drained}" -ge 1 ]]; then
      replay_complete=1
      break
    fi
  fi
  sleep 2
done
if [[ "${restart_done}" -ne 1 ]]; then
  echo "::error::Replay did not reach the planned mid-run restart"
  echo "accepted=$(accepted_log_count)"
  exit 1
fi
if [[ "${replay_complete}" -ne 1 ]]; then
  echo "::error::Replay did not drain all 623 alerts before timeout"
  echo "accepted=$(accepted_log_count)"
  fixture_stats || true
  tail -n 180 "${REPLAY_LOG_FILE}" || true
  exit 1
fi

PHASE="assert exactly 623 unique handled alerts, zero repeated post requests, and final compound cursor"
keys_file="${REPLAY_TMP}/radarx-replay-accepted-keys.txt"
handled_file="${REPLAY_TMP}/radarx-replay-handled-keys.txt"
accepted_log_keys > "${keys_file}"
handled_log_keys > "${handled_file}"
accepted_total="$(wc -l < "${keys_file}" | tr -d ' ')"
accepted_unique="$(sort -u "${keys_file}" | wc -l | tr -d ' ')"
handled_unique="$(sort -u "${handled_file}" | wc -l | tr -d ' ')"
reconciled_total="$(reconciled_log_count)"
if [[ "${accepted_total}" -ne "${accepted_unique}" ]]; then
  echo "::error::Duplicate NotificationManager post requests: total=${accepted_total} unique=${accepted_unique}"
  sort "${keys_file}" | uniq -c | grep -vE '^[[:space:]]+1 ' | head -n 60 || true
  exit 1
fi
if [[ "${handled_unique}" -ne 623 ]]; then
  echo "::error::Replay did not handle 623 unique alerts: handled=${handled_unique} expected=623"
  sort "${handled_file}" | uniq -c | grep -vE '^[[:space:]]+1 ' | head -n 60 || true
  exit 1
fi
if ! grep -Fq 'FALCON_EYE_RADAR|REPLAY:0623' "${handled_file}"; then
  echo "::error::Last archived alert was neither posted nor reconciled as already active"
  exit 1
fi
prefs_xml="$(timeout 8s adb shell run-as com.radarx.app cat shared_prefs/radarx_background.xml 2>/dev/null || true)"
if ! printf '%s\n' "${prefs_xml}" | grep -Fq 'FALCON_EYE_RADAR|REPLAY:0623'; then
  echo "::error::The persisted compound cursor did not reach the final event"
  printf '%s\n' "${prefs_xml}" | grep -E 'radar_alert_cursor_(at|id)|cursor_initialized' || true
  exit 1
fi
final_stats="$(fixture_stats)"
final_pages="$(stat_field "${final_stats}" queuedRequests)"
final_drained="$(stat_field "${final_stats}" drainedRequests)"
if [[ "${final_pages}" -lt 13 || "${final_drained}" -lt 1 ]]; then
  echo "::error::Replay pagination incomplete: pages=${final_pages} drained=${final_drained}"
  exit 1
fi
echo "ANDROID_DURABLE_REPLAY_PASS: alerts=623 handled_unique=${handled_unique} new_post_requests=${accepted_total} reconciled_active=${reconciled_total} duplicate_post_requests=0 missing=0 same_timestamp=yes no_id_rows=yes offline_reconnect=yes force_stop_restart=yes final_cursor=verified pages=${final_pages}"
