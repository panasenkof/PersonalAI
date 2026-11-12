#!/usr/bin/env bash
# Shared optional compiler cache setup for BOTH native emulator and signed APK.
# A transient Ubuntu mirror DNS outage must not block an otherwise buildable APK.
set -euo pipefail
if ! command -v ccache >/dev/null 2>&1; then
  for attempt in 1 2; do
    echo "Attempt $attempt/2 to install optional ccache from Ubuntu"
    if timeout 45s sudo apt-get \
      -o Acquire::Retries=0 -o Acquire::http::Timeout=12 \
      -o Acquire::https::Timeout=12 update -qq &&
      timeout 45s sudo apt-get \
      -o Acquire::Retries=0 -o Acquire::http::Timeout=12 \
      -o Acquire::https::Timeout=12 install -y --no-install-recommends ccache; then
      break
    fi
    if [ "$attempt" -eq 1 ]; then sleep 5; fi
  done
fi
if command -v ccache >/dev/null 2>&1; then
  launcher="$(command -v ccache)"
  test -x "$launcher"
  echo "PERSAI_CCACHE_BIN=$launcher" >> "$GITHUB_ENV"
  ccache --zero-stats
  ccache --version | head -n 1
  echo "Native C/C++ object cache enabled"
else
  echo "PERSAI_CCACHE_BIN=" >> "$GITHUB_ENV"
  echo "::warning::ccache unavailable (Ubuntu mirror/DNS). Building normally without the optional compiler cache."
fi
