#!/usr/bin/env bash
# Expo SDK 57, step 5: install peers with SDK-pinned versions; verify config and bundles.
set -x
cd mobile
V() { node -p "require('expo/bundledNativeModules.json')['$1']"; }
npm install --no-audit --no-fund "expo-font@$(V expo-font)" "expo-splash-screen@$(V expo-splash-screen)" "expo-modules-core@$(V expo-modules-core)"
npx expo install --check
echo "=== expo config"; npx expo config --json --full > /dev/null && echo "config ok"
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit | head -60
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL" | head -60
echo "=== export"; npx expo export --platform android --platform ios --output-dir /tmp/native-export 2>&1 | tail -15
echo "=== prebuild"; npx expo prebuild --platform android --no-install --clean 2>&1 | tail -15; grep -c usesCleartextTraffic android/app/src/main/AndroidManifest.xml; rm -rf android
true
