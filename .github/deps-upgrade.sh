#!/usr/bin/env bash
# Expo SDK 57, step 6: tidy package.json (SDK-style ranges, no direct expo-modules-core).
set -x
cd mobile
npm uninstall --no-audit --no-fund expo-modules-core
npm pkg set scripts.android="expo start --android" scripts.ios="expo start --ios"
npm pkg set dependencies.expo="~$(node -p 'require("expo/package.json").version')" \
  dependencies.expo-font="~$(node -p 'require("expo-font/package.json").version')" \
  dependencies.expo-splash-screen="~$(node -p 'require("expo-splash-screen/package.json").version')"
npm install --no-audit --no-fund
npm ls expo-modules-core
npx expo install --check
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit | head -40
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL|Cannot find" | head -40
echo "=== export"; npx expo export --platform android --output-dir /tmp/native-export 2>&1 | tail -4
true
