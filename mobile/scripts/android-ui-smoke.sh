#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p qa/android-results
# Disposable emulator only: this script installs an ephemeral APK and sets a PIN.
[[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
collect() {
  adb logcat -d -v threadtime > qa/android-results/logcat.txt 2>&1 || true
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/window.xml qa/android-results/window.xml >/dev/null 2>&1 || true
  adb exec-out screencap -p > qa/android-results/final-screen.png 2>/dev/null || true
}
trap collect EXIT
adb logcat -c
adb install -r android/app/build/outputs/apk/release/app-release.apk
# Real Android credential prompt, without an application authentication bypass.
adb shell locksettings set-pin 2468
adb shell input keyevent 82
maestro test --format junit --output qa/android-results/junit.xml \
  --test-output-dir qa/android-results .maestro/flows/smoke.yaml
