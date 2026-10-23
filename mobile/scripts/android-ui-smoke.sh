#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep both attempts' evidence if an emulator-only retry is needed.
case "${SMOKE_ATTEMPT:-1}" in 1|2) ;; *) echo "Invalid smoke attempt" >&2; exit 2;; esac
RESULTS_DIR="qa/android-results/attempt-${SMOKE_ATTEMPT:-1}"
mkdir -p "$RESULTS_DIR"
# Disposable emulator only: this script installs an ephemeral APK and sets a PIN.
[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
collect() {
  adb logcat -d -v threadtime > "$RESULTS_DIR/logcat.txt" 2>&1 || true
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/window.xml "$RESULTS_DIR/window.xml" >/dev/null 2>&1 || true
  adb exec-out screencap -p > "$RESULTS_DIR/final-screen.png" 2>/dev/null || true
}
trap collect EXIT
adb wait-for-device
# sys.boot_completed alone does not guarantee a responsive system launcher.
# Give Android's services a chance to settle, then diagnose the actual screen
# if any Maestro assertion fails (never auto-dismiss security dialogs).
[[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]
adb shell cmd package list packages >/dev/null
adb logcat -c
adb install -r android/app/build/outputs/apk/release/app-release.apk
# Real Android credential prompt, without an application authentication bypass.
adb shell locksettings set-pin 2468
adb shell input keyevent 82
maestro test --format junit --output "$RESULTS_DIR/junit.xml" \
  --test-output-dir "$RESULTS_DIR" --debug-output "$RESULTS_DIR/debug" \
  .maestro/flows/smoke.yaml
