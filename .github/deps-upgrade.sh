#!/usr/bin/env bash
# Expo SDK 54 -> 57. Output goes to .github/deps-upgrade.log.
set -x
cd mobile
pick() { npm view "$1" versions --json | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));const re=new RegExp(process.argv[1]);console.log(v.filter(x=>re.test(x)&&!x.includes("-")).pop()||"")' "$2"; }
EXPO=$(pick expo '^57\.'); echo "expo $EXPO"
npm install --no-audit --no-fund "expo@$EXPO" || exit 1
npx expo install --fix || exit 1
npm uninstall --no-audit --no-fund react-native-sse expo-linear-gradient expo-image-picker fast-xml-parser expo-video-thumbnails
npx expo install expo-image-manipulator
SR=$(pick expo-speech-recognition '^57\.'); [ -z "$SR" ] && SR=$(pick expo-speech-recognition '^56\.'); echo "expo-speech-recognition $SR"
npm install --no-audit --no-fund "expo-speech-recognition@$SR"
npx expo install --fix
echo "=== versions"; npm ls --depth=0
echo "=== whisper candidates"
for p in react-native-executorch react-native-audio-api react-native-worklets react-native-blob-util @kesha-antonov/react-native-background-downloader react-native-device-info; do echo "$p latest=$(npm view $p version) peer=$(npm view $p peerDependencies --json | tr -d '\n ')"; done
echo "=== expo install --check"; npx expo install --check
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|●|Tests:|Test Suites:|FAIL" | head -120
true
