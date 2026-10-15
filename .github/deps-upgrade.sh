#!/usr/bin/env bash
# Expo SDK 57, step 3: missing peers, splash plugin, Node types; full Jest error.
set -x
cd mobile
npx expo install expo-font expo-splash-screen
npm install --no-audit --no-fund -D @types/node@22
echo "=== jest-expo needs"; npm view jest-expo@$(node -p 'require("jest-expo/package.json").version') dependencies peerDependencies --json
echo "=== installed jest"; node -p 'require("jest/package.json").version'; npm ls jest jest-environment-node @jest/core --depth=1
npx expo install --fix
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit | head -80
echo "=== jest one suite"; npx jest --ci src/media/__tests__/voice.test.ts 2>&1 | head -80
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL" | head -80
true
