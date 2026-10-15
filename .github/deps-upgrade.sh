#!/usr/bin/env bash
# Whisper on the phone: react-native-executorch and its peers.
set -x
cd mobile
pick() { npm view "$1" versions --json | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));const re=new RegExp(process.argv[1]);console.log(v.filter(x=>re.test(x)&&!x.includes("-")).pop()||"")' "$2"; }
npx expo install react-native-worklets expo-build-properties
npm install --no-audit --no-fund "react-native-executorch@0.10.5" "react-native-blob-util@$(pick react-native-blob-util '^0\.24\.')" "react-native-audio-api@0.13.6"
cat node_modules/react-native-executorch/rne-build-config.json
echo "=== babel-preset-expo worklets"; grep -rn "worklets" node_modules/babel-preset-expo/build/*.js | head -20
echo "=== audio-api types"; sed -n 1,40p node_modules/react-native-audio-api/lib/typescript/types.d.ts 2>/dev/null | head -5; ls node_modules/react-native-audio-api/lib
echo "=== executorch types"; ls node_modules/react-native-executorch/lib/typescript/src | head; grep -n "speechToText" -A3 node_modules/react-native-executorch/lib/typescript/src/models.d.ts | head -10
npx expo install --check
echo "=== expo-doctor"; npx -y expo-doctor@latest
echo "=== tsc"; npx tsc --noEmit | head -60
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL|Cannot find" | head -40
true
