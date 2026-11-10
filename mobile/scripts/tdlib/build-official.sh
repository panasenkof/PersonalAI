#!/usr/bin/env bash
# Explicit trusted source build; never downloads a third-party TDLib AAR.
set -euo pipefail
TD_SHA="c8828d50f5eac2fc7089ce1089d7ce9095c61b5e"
OPENSSL_TAG="openssl-3.5.9"
OPENSSL_TAG_OBJECT="d0ca66a1abe52545f14eca635c648932fcde5615"
NDK="27.0.12077973"
: "$ANDROID_SDK_ROOT"
: "$TDLIB_BUILD_ROOT"
test -n "$ANDROID_SDK_ROOT" && test -n "$TDLIB_BUILD_ROOT"
repo_root="$(cd "$(dirname "$0")/../../.." && pwd -P)"
mkdir -p "$TDLIB_BUILD_ROOT"
git clone --no-checkout https://github.com/tdlib/td.git "$TDLIB_BUILD_ROOT/source"
git -C "$TDLIB_BUILD_ROOT/source" checkout --detach "$TD_SHA"
test "$(git -C "$TDLIB_BUILD_ROOT/source" rev-parse HEAD)" = "$TD_SHA"
# Strictly reviewed changes: compile OpenSSL for just 2 needed ABIs;
# enable NDK r27 16 KiB linker alignment for TDLib JNI on Android 15+.
node "$repo_root/mobile/scripts/tdlib/patch-upstream.cjs" "$TDLIB_BUILD_ROOT/source/example/android"
cd "$TDLIB_BUILD_ROOT/source/example/android"
bash ./check-environment.sh
# Guard against a moved release tag before upstream script downloads its tarball.
tag_ref="$(git ls-remote https://github.com/openssl/openssl.git "refs/tags/$OPENSSL_TAG" | cut -f1)"
test "$tag_ref" = "$OPENSSL_TAG_OBJECT"
bash ./build-openssl.sh "$ANDROID_SDK_ROOT" "$NDK" "$TDLIB_BUILD_ROOT/openssl" "$OPENSSL_TAG"
bash ./build-tdlib.sh "$ANDROID_SDK_ROOT" "$NDK" "$TDLIB_BUILD_ROOT/openssl" \
  "c++_static" "JSONJava" 26 "arm64-v8a x86_64"
bundle="$TDLIB_BUILD_ROOT/bundle"
mkdir -p "$bundle/java/org/drinkless/tdlib"
for abi in arm64-v8a x86_64; do
  mkdir -p "$bundle/libs/$abi"
  cp "tdlib/libs/$abi/libtdjsonjava.so" "$bundle/libs/$abi/libtdjsonjava.so"
done
cp tdlib/java/org/drinkless/tdlib/JsonClient.java "$bundle/java/org/drinkless/tdlib/JsonClient.java"
node "$repo_root/mobile/scripts/tdlib/bundle.cjs" manifest "$bundle"
node "$repo_root/mobile/scripts/tdlib/bundle.cjs" verify "$bundle"
readelf_bin="$ANDROID_SDK_ROOT/ndk/$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
for abi in arm64-v8a x86_64; do
  "$readelf_bin" -l "$bundle/libs/$abi/libtdjsonjava.so" > "$bundle/$abi-ELF-program-headers.txt"
done
(cd "$bundle" && find . -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "Pinned official TDLib source bundle built. No APK integration was enabled."
