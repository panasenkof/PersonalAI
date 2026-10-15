#!/usr/bin/env bash
# Browser acceptance with full output, then the unit tests.
set -x
cd mobile
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium > /dev/null 2>&1
echo "=== ui"; node scripts/verify-mobile-ui.cjs 2>&1 | tail -40
echo "=== jest"; npx jest --ci 2>&1 | grep -E "✕|Tests:|Test Suites:|FAIL" | head -20
true
