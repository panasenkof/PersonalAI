#!/usr/bin/env bash
# Expo SDK 57, step 2: remove unused packages, add replacements, report checks.
set -x
cd mobile
pick() { npm view "$1" versions --json | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));const re=new RegExp(process.argv[1]);console.log(v.filter(x=>re.test(x)&&!x.includes("-")).pop()||"")' "$2"; }
npm uninstall --no-audit --no-fund react-native-sse expo-linear-gradient expo-image-picker fast-xml-parser expo-video-thumbnails
npx expo install expo-image-manipulator
SR=$(pick expo-speech-recognition '^57\.'); [ -z "$SR" ] && SR=$(pick expo-speech-recognition '^56\.'); echo "expo-speech-recognition $SR"
npm install --no-audit --no-fund "expo-speech-recognition@$SR"
npx expo install --fix
echo "=== versions"; npm ls --depth=0
echo "=== whisper candidates"
for p in react-native-executorch react-native-audio-api react-native-worklets react-native-blob-util @kesha-antonov/react-native-background-downloader react-native-device-info; do echo "$p latest=$(npm view $p version) peer=$(npm view $p peerDependencies --json | tr -d '\n ')"; done
echo "=== bundled versions in expo 57"; node -e 'const b=require("expo/bundledNativeModules.json");for(const k of ["react-native-worklets","react-native-reanimated","react-native-audio-api","expo-audio","expo-build-properties","react-native-blob-util","react-native-device-info","expo-image-manipulator"])console.log(k,b[k])'
echo "=== expo install --check"; npx expo install --check
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|●|Tests:|Test Suites:|FAIL" | head -150
true
