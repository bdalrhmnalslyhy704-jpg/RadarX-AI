#!/usr/bin/env bash
set -Eeuo pipefail

# Start the emulator ourselves instead of using an unbounded adb wait inside
# an action wrapper. Android 29/30 images can report boot complete while ADB
# remains offline; every probe below is bounded and the transport is retried.

API_LEVEL="${RADARX_EMULATOR_API_LEVEL:-29}"
AVD_NAME="${RADARX_EMULATOR_NAME:-radarx-smoke-${API_LEVEL}}"
PORT="${RADARX_EMULATOR_PORT:-5554}"
SERIAL="emulator-${PORT}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
APK="${RADARX_APK_PATH:-android/app/build/outputs/apk/debug/app-debug.apk}"
EMULATOR_LOG="${RUNNER_TEMP:-/tmp}/radarx-emulator-${API_LEVEL}.log"
EMULATOR_PID=""

fail_with_diagnostics() {
  local rc=$?
  trap - ERR
  set +e
  echo "::error::RadarX emulator smoke orchestration failed (exit ${rc}); API=${API_LEVEL} AVD=${AVD_NAME}."
  echo "=== adb devices ==="
  timeout 8s adb devices -l 2>&1 || true
  echo "=== emulator log tail ==="
  tail -n 180 "${EMULATOR_LOG}" 2>/dev/null || true
  echo "=== Android runtime log tail ==="
  timeout 12s adb -s "${SERIAL}" logcat -d -b all -s AndroidRuntime:E ActivityTaskManager:E ActivityManager:I '*:S' 2>&1 | tail -n 120 || true
  exit "${rc}"
}
trap fail_with_diagnostics ERR

cleanup_emulator() {
  local rc=$?
  set +e
  if [[ -n "${EMULATOR_PID}" ]]; then
    timeout 6s adb -s "${SERIAL}" emu kill >/dev/null 2>&1 || true
    kill "${EMULATOR_PID}" >/dev/null 2>&1 || true
    for attempt in $(seq 1 10); do
      kill -0 "${EMULATOR_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "${EMULATOR_PID}" >/dev/null 2>&1 || true
    wait "${EMULATOR_PID}" 2>/dev/null || true
  fi
  return "${rc}"
}
trap cleanup_emulator EXIT

if [[ -z "${SDK_ROOT}" || ! -d "${SDK_ROOT}" ]]; then
  echo "::error::ANDROID_SDK_ROOT/ANDROID_HOME is not configured."
  exit 1
fi
if [[ ! -s "${APK}" ]]; then
  echo "::error::APK does not exist: ${APK}"
  exit 1
fi
if [[ ! "${API_LEVEL}" =~ ^[0-9]{2}$ ]]; then
  echo "::error::Invalid Android emulator API level: ${API_LEVEL}"
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1 || ! command -v adb >/dev/null 2>&1 ||
   ! command -v sdkmanager >/dev/null 2>&1 || ! command -v avdmanager >/dev/null 2>&1; then
  echo "::error::Android SDK command-line tools are unavailable."
  exit 1
fi

sdk_item_valid() {
  local package="$1"
  case "${package}" in
    emulator) [[ -x "${SDK_ROOT}/emulator/emulator" ]] ;;
    "platform-tools") [[ -x "${SDK_ROOT}/platform-tools/adb" ]] ;;
    "system-images;android-${API_LEVEL};default;x86_64")
      [[ -s "${SDK_ROOT}/system-images/android-${API_LEVEL}/default/x86_64/system.img" ]] ;;
    "platforms;android-${API_LEVEL}") [[ -s "${SDK_ROOT}/platforms/android-${API_LEVEL}/android.jar" ]] ;;
    *) return 1 ;;
  esac
}

ensure_sdk_item() {
  local package="$1"
  for attempt in 1 2 3; do
    if sdk_item_valid "${package}"; then
      echo "Android SDK package verified: ${package}"
      return 0
    fi
    echo "Installing Android SDK package ${package} (attempt ${attempt}/3)."
    if timeout 180s sdkmanager --sdk_root="${SDK_ROOT}" "${package}" &&
       sdk_item_valid "${package}"; then
      return 0
    fi
    echo "::warning::SDK package ${package} is incomplete after attempt ${attempt}."
    if [[ "${attempt}" -lt 3 ]]; then sleep "$((attempt * 4))"; fi
  done
  echo "::error::Could not install/verify Android SDK package ${package}."
  return 1
}

ensure_sdk_item emulator
ensure_sdk_item platform-tools
ensure_sdk_item "platforms;android-${API_LEVEL}"
ensure_sdk_item "system-images;android-${API_LEVEL};default;x86_64"

echo "RADARX_EMULATOR_SDK_READY api=${API_LEVEL}"
# Keep AVD creation bounded while feeding the documented noninteractive
# "no custom hardware profile" answer through the inner shell's stdin pipe.
AVD_PACKAGE="system-images;android-${API_LEVEL};default;x86_64"
AVD_HOME="${ANDROID_AVD_HOME:-${HOME}/.android/avd}"
mkdir -p "${AVD_HOME}" "$(dirname "${EMULATOR_LOG}")"
export ANDROID_AVD_HOME="${AVD_HOME}"
timeout 90s bash -c 'printf "no\\n" | avdmanager create avd --force -n "$1" --package "$2"' _ "${AVD_NAME}" "${AVD_PACKAGE}"
echo "RADARX_AVD_CREATED name=${AVD_NAME} package=${AVD_PACKAGE}"
AVD_DIR="${AVD_HOME}/${AVD_NAME}.avd"
test -s "${AVD_DIR}/config.ini"
cat >> "${AVD_DIR}/config.ini" <<'AVD'
hw.cpu.ncore=2
hw.ramSize=2048
hw.heapSize=512
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
showDeviceFrame=no
fastboot.forceColdBoot=yes
AVD

mkdir -p "$(dirname "${EMULATOR_LOG}")" "${ANDROID_AVD_HOME:-${HOME}/.android/avd}"
: > "${EMULATOR_LOG}"
EMU_ARGS=(-port "${PORT}" -avd "${AVD_NAME}" -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim)
if [[ -r /dev/kvm && -w /dev/kvm ]]; then
  EMU_ARGS+=(-accel on)
else
  EMU_ARGS+=(-accel off)
fi

echo "Starting Android emulator with bounded ADB recovery: api=${API_LEVEL} serial=${SERIAL}"
timeout 8s adb start-server || true
"${SDK_ROOT}/emulator/emulator" "${EMU_ARGS[@]}" >"${EMULATOR_LOG}" 2>&1 &
EMULATOR_PID=$!
export ANDROID_SERIAL="${SERIAL}"

booted=0
started_at=$SECONDS
attempt=0
while (( SECONDS - started_at < 600 )); do
  attempt=$((attempt + 1))
  state="$(timeout 6s adb -s "${SERIAL}" get-state 2>/dev/null | tr -d '\r' || true)"
  if [[ "${state}" == "device" ]]; then
    boot_status="$(timeout 8s adb -s "${SERIAL}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "${boot_status}" == "1" ]]; then
      probe="$(timeout 6s adb -s "${SERIAL}" shell echo RADARX_DEVICE_READY 2>/dev/null | tr -d '\r' || true)"
      if [[ "${probe}" == *RADARX_DEVICE_READY* ]]; then
        booted=1
        break
      fi
    fi
  else
    timeout 5s adb reconnect offline >/dev/null 2>&1 || true
    if (( attempt % 6 == 0 )); then
      echo "ADB still reconnecting (${attempt} probes); restarting adb server."
      timeout 5s adb kill-server >/dev/null 2>&1 || true
      timeout 5s adb start-server >/dev/null 2>&1 || true
    fi
  fi
  if (( attempt % 10 == 0 )); then
    echo "Waiting for Android boot and ADB readiness: elapsed=$((SECONDS-started_at))s state=${state:-UNKNOWN} boot=${boot_status:-UNKNOWN}"
  fi
  sleep 3
done

if [[ "${booted}" -ne 1 ]]; then
  echo "::error::Android emulator did not become ADB-ready within 600 seconds."
  exit 1
fi

echo "RADARX_EMULATOR_BOOT_READY api=${API_LEVEL} elapsed=$((SECONDS-started_at))s"
# Animations are a performance convenience, not a test precondition. Bound every
# settings request so a transient ADB transport issue cannot hang the CI step.
timeout 6s adb -s "${SERIAL}" shell settings put global window_animation_scale 0.0 >/dev/null 2>&1 || true
timeout 6s adb -s "${SERIAL}" shell settings put global transition_animation_scale 0.0 >/dev/null 2>&1 || true
timeout 6s adb -s "${SERIAL}" shell settings put global animator_duration_scale 0.0 >/dev/null 2>&1 || true

echo "RADARX_EMULATOR_SMOKE_START api=${API_LEVEL} apk=${APK}"
RADARX_APK_PATH="${APK}" bash android/smoke-test.sh
echo "RADARX_EMULATOR_SMOKE_PASS api=${API_LEVEL}"
