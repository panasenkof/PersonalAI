#!/usr/bin/env bash
# Whisper, step 3: check the code against the real packages.
set -x
cd mobile
npm ci --no-audit --no-fund
echo "=== tsc"; npx tsc --noEmit | head -80
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|●|Tests:|Test Suites:|FAIL" | head -60
echo "=== export"; npx expo export --platform android --output-dir /tmp/native-export 2>&1 | tail -6
echo "=== prebuild"; npx expo prebuild --platform android --no-install --clean 2>&1 | tail -4; grep -n "minSdkVersion\|minSdk" android/gradle.properties android/build.gradle 2>/dev/null | head; grep -c usesCleartextTraffic android/app/src/main/AndroidManifest.xml; grep -n "RECORD_AUDIO\|FOREGROUND" android/app/src/main/AndroidManifest.xml; rm -rf android
true
