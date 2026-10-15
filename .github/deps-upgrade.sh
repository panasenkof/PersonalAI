#!/usr/bin/env bash
# Whisper, step 2: worklets and build properties (needs node_modules first).
set -x
cd mobile
npm ci --no-audit --no-fund
npx expo install react-native-worklets expo-build-properties
echo "=== babel-preset-expo worklets"; grep -rn "react-native-worklets/plugin\|worklets" node_modules/babel-preset-expo/build/index.js | head; sed -n 125,150p node_modules/babel-preset-expo/build/index.js
grep -rln "react-native-worklets/plugin" node_modules/babel-preset-expo/build | head
npx expo install --check
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit | head -60
true
