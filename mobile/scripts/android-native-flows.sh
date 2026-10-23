#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ATTEMPT="$(printenv SMOKE_ATTEMPT || echo 1)"
RESULTS_DIR="qa/android-results/attempt-$ATTEMPT"
# Capture the failure state of whichever additional Maestro scenario runs last.
# The minimal smoke's evidence stays intact under the original filenames.
capture_extra() {
  adb logcat -d -v threadtime > "$RESULTS_DIR/extra-logcat.txt" 2>&1 || true
  adb shell uiautomator dump /sdcard/native-flows-window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/native-flows-window.xml "$RESULTS_DIR/extra-window.xml" >/dev/null 2>&1 || true
  adb exec-out screencap -p > "$RESULTS_DIR/extra-final-screen.png" 2>/dev/null || true
}
trap capture_extra EXIT
FIXTURES="$RESULTS_DIR/fixtures"
node scripts/prepare-maestro-fixtures.cjs "$FIXTURES" >/dev/null
adb push "$FIXTURES/persai-qa-photo.png" /sdcard/Download/persai-qa-photo.png >/dev/null
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/persai-qa-photo.png >/dev/null
# Reuse the emulator and standalone APK installed by android-ui-smoke.sh.
# Each scenario clears application test state, not the Android device PIN.
for scenario in memory-note settings import-url import-photo; do
  echo ">>> Native Android Maestro scenario: $scenario"
  maestro test --format junit --output "$RESULTS_DIR/junit-$scenario.xml" \
    --test-output-dir "$RESULTS_DIR/$scenario" --debug-output "$RESULTS_DIR/debug-$scenario" \
    ".maestro/flows/$scenario.yaml"
done
