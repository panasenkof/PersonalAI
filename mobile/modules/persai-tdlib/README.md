# PersAI Telegram TDLib: source bundle gate

This folder currently contains **no native binary and no enabled Telegram account client**.

The first step is a user-triggered official-source build via
.github/workflows/telegram-tdlib-source.yml (not a random .aar).
TDLib upstream: c8828d50f5eac2fc7089ce1089d7ce9095c61b5e.
OpenSSL official tag: openssl-3.5.9.
NDK: 27.0.12077973. ABI: arm64-v8a and x86_64. Interface: JSONJava.

The workflow uploads a review candidate; its manifest is locally verifiable:
  node mobile/scripts/tdlib/bundle.cjs verify /path/to/bundle

No APK will embed or download TDLib until a subsequent reviewed PR introduces
the native bridge and explicitly installs a verified artifact. Never include
TDLib authorization data, code, session or encryption key in the normal PersAI
backup. Real Android login and Saved Messages are NOT_RUN / NOT_IMPLEMENTED.
