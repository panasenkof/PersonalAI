#!/usr/bin/env bash
# Whisper, final check with the new UI test.
set -x
cd mobile
npm ci --no-audit --no-fund
echo "=== tsc"; npx tsc --noEmit | head -60
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL" | head -40
echo "=== whisper ui"; npx jest --ci src/__tests__/voice-whisper.test.tsx 2>&1 | tail -30
true
