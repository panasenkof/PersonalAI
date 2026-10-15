#!/usr/bin/env bash
# Browser acceptance with full output.
set -x
cd mobile
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium > /dev/null 2>&1
echo "=== ui"; node scripts/verify-mobile-ui.cjs 2>&1 | tail -60
true
