#!/usr/bin/env bash
# Real native PdfRenderer round-trip on the SAME API-35 emulator as the UI smoke.
# Runs AFTER normal app login/smoke; a failing parser never counts as emulator ANR.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${SMOKE_ATTEMPT:-1}" in 1|2) ;; *) exit 2 ;; esac
OUT="qa/android-results/attempt-${SMOKE_ATTEMPT:-1}/pdf-page"
mkdir -p "$OUT"
[[ "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" == 35 ]]
# No second VM boot or additional release APK; only the test-only module APK.
set +e
(cd android && ./gradlew :persai-pdf:connectedDebugAndroidTest --build-cache --no-configuration-cache --no-daemon --stacktrace) >"$OUT/gradle.log" 2>&1
status=$?
set -e
find android -path '*/build/outputs/androidTest-results/connected/*' -type f \( -name '*.xml' -o -name '*.txt' \) -exec cp '{}' "$OUT/" \; 2>/dev/null || true
tail -n 80 "$OUT/gradle.log"
if [[ "$status" -ne 0 ]]; then
  echo "::error::Real Android PDF page extraction instrumented test failed"
  exit "$status"
fi
echo "Native PDF page fixture PASS on Android 35"
