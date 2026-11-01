#!/usr/bin/env bash
# Real native PdfRenderer round-trip on the SAME API-35 emulator as the UI smoke.
# Runs AFTER normal app login/smoke; a failing parser never counts as emulator ANR.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${SMOKE_ATTEMPT:-1}" in 1|2) ;; *) exit 2 ;; esac
OUT="qa/android-results/attempt-${SMOKE_ATTEMPT:-1}/pdf-page"
mkdir -p "$OUT"
[[ "$(adb shell getprop ro.build.version.sdk | tr -d '\r')" == 35 ]]
# The Gradle configuration for :app validates its ephemeral CI signing
# environment even for a module-only androidTest task. Reuse the certificate
# that the earlier release build generated; never create/export a user key.
export PIA_ANDROID_KEYSTORE_PATH="${RUNNER_TEMP:?}/pia-ephemeral-qa.p12"
export PIA_ANDROID_KEY_ALIAS="pia-ci-only"
export PIA_ANDROID_STORE_PASSWORD="ephemeral-ci-password-only"
export PIA_ANDROID_KEY_PASSWORD="ephemeral-ci-password-only"
test -s "$PIA_ANDROID_KEYSTORE_PATH"
# Gate actual Russian OCR on the emulator, never with mocked model output.
# Language data exists ONLY under androidTest/assets, hence never inflates release APK.
MODEL_ASSET="modules/persai-pdf/android/src/androidTest/assets/rus.traineddata"
MODEL_SHA="e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225"
MODEL_URL="https://huggingface.co/lm-kit/tessdata-fast/resolve/83ff76b97461395f257255720bf7f3957606dbb5/rus.traineddata"
if [[ -f "modules/persai-pdf/android/src/androidTest/java/expo/modules/persaipdf/LocalRussianOcrInstrumentedTest.kt" ]]; then
  mkdir -p "$(dirname "$MODEL_ASSET")"
  trap 'rm -f "$MODEL_ASSET" "$MODEL_ASSET.partial"' EXIT
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 120 --silent --show-error "$MODEL_URL" -o "$MODEL_ASSET.partial"
  printf '%s  %s\\n' "$MODEL_SHA" "$MODEL_ASSET.partial" | sha256sum --check --status
  [[ "$(wc -c < "$MODEL_ASSET.partial" | tr -d '[:space:]')" == "3861738" ]]
  mv "$MODEL_ASSET.partial" "$MODEL_ASSET"
  echo "Pinned Russian OCR test-only model verified, 3861738 bytes"
fi
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
