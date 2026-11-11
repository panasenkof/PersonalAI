#!/usr/bin/env bash
# Single reviewed TDLib staging path for both ephemeral Android acceptance
# and explicitly approved, user-upgradable signed release builds.
# Run from mobile/ on trusted main. Never accept a PR-supplied binary or URL.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_REF:?}"
: "${RUNNER_TEMP:?}"
: "${GITHUB_ENV:?}"
: "${TDLIB_SOURCE_RUN_ID:?}"
: "${GH_TOKEN:?}"

if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then
  echo "::error::TDLib staging requires trusted main"
  exit 1
fi
if [[ ! "$TDLIB_SOURCE_RUN_ID" =~ ^[1-9][0-9]{0,14}$ ]]; then
  echo "::error::Invalid TDLib source build run ID"
  exit 1
fi
if [[ -n "${TDLIB_ARCHIVE_SHA256:-}" && ! "${TDLIB_ARCHIVE_SHA256}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "::error::TDLib archive digest must be exactly 64 lowercase hex characters"
  exit 1
fi

metadata="$RUNNER_TEMP/tdlib-source-run.json"
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$TDLIB_SOURCE_RUN_ID" > "$metadata"
source_sha="$(node scripts/tdlib/verify-source-run.cjs "$metadata" \
  "$GITHUB_REPOSITORY" "$TDLIB_SOURCE_RUN_ID")"
if [[ -f ../.git/shallow ]]; then
  git -C .. fetch --no-tags --unshallow origin main
fi
git -C .. merge-base --is-ancestor "$source_sha" HEAD || {
  echo "::error::TDLib source run is not an ancestor of the checked-out main"
  exit 1
}
mkdir -p "$RUNNER_TEMP/tdlib-artifact"
gh run download "$TDLIB_SOURCE_RUN_ID" --repo "$GITHUB_REPOSITORY" \
  --name "tdlib-jsonjava-official-source-$source_sha" \
  --dir "$RUNNER_TEMP/tdlib-artifact"
archive="$RUNNER_TEMP/tdlib-artifact/official-tdlib-jsonjava-android.tar.gz"
test -s "$archive"
if [[ -n "${TDLIB_ARCHIVE_SHA256:-}" ]]; then
  printf '%s  %s\n' "$TDLIB_ARCHIVE_SHA256" "$archive" | sha256sum --check --status || {
    echo "::error::Reviewed TDLib archive digest mismatch"
    exit 1
  }
fi
python3 scripts/tdlib/unpack_verified.py "$archive" "$RUNNER_TEMP/tdlib-extracted"
node scripts/tdlib/bundle.cjs verify "$RUNNER_TEMP/tdlib-extracted/bundle"
node scripts/tdlib/bundle.cjs stage "$RUNNER_TEMP/tdlib-extracted/bundle" modules/persai-tdlib
test -s modules/persai-tdlib/android/src/main/jniLibs/x86_64/libtdjsonjava.so
test -s modules/persai-tdlib/android/src/main/jniLibs/arm64-v8a/libtdjsonjava.so
test -s modules/persai-tdlib/android/src/main/java/org/drinkless/tdlib/JsonClient.java
echo 'TDLIB_EXPLICIT_STAGE=true' >> "$GITHUB_ENV"
echo "Reviewed official TDLib staged from source run $TDLIB_SOURCE_RUN_ID."
