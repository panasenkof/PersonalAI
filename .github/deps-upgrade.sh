#!/usr/bin/env bash
# Expo SDK 57, step 4: Jest preset dependencies; why expo config fails.
set -x
cd mobile
npx expo install expo-modules-core
npm install --no-audit --no-fund -D "@react-native/jest-preset@$(node -p 'require("react-native/package.json").version')"
echo "=== expo config"; npx expo config --json --full 2>&1 | tail -40
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit | head -60
echo "=== jest one suite"; npx jest --ci src/media/__tests__/voice.test.ts 2>&1 | head -60
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL|●.*›" | head -120
true
