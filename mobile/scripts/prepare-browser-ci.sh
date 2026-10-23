#!/usr/bin/env bash
set -euo pipefail
# Hosted Ubuntu already has Chrome's shared libraries. Avoid a full apt upgrade
# on every PR; keep the dependency installer as a fallback for lean/new images.
npx playwright install --only-shell chromium
probe="$(mktemp)"
trap 'rm -f "$probe"' EXIT
if ! node -e 'require("playwright").chromium.launch({args:["--no-sandbox"]}).then(b=>b.close()).catch(e=>{console.error(e);process.exit(1)})' >"$probe" 2>&1; then
  cat "$probe"
  if grep -Eq 'Host system is missing dependencies|error while loading shared libraries' "$probe"; then
    npx playwright install-deps chromium
  else
    exit 1
  fi
fi
