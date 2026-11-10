# PersAI Telegram TDLib native module

The Expo native JSONJava bridge already exists for Telegram user authorization and Saved Messages/Topics. The required official library **is not bundled in ordinary APKs**. Without that binary the UI fails closed and Telegram account login is not available.

## Trusted upstream

- TDLib tdlib/td commit c8828d50f5eac2fc7089ce1089d7ce9095c61b5e
- OpenSSL tag openssl-3.5.9
- Android NDK 27.0.12077973, ABI arm64-v8a + x86_64
- Source workflow: .github/workflows/telegram-tdlib-source.yml
- Local manifest/SHA-256/ELF/16 KiB gate: mobile/scripts/tdlib/bundle.cjs

## Manual source to APK acceptance

1. On GitHub Actions, main: run **Build official TDLib JSONJava bundle (manual)** and obtain a successful run ID.
2. On GitHub Actions, main: run **TDLib official-source Android APK acceptance (manual)** and enter the source run ID.
3. The existing native SQLCipher/Expo/emulator workflow confirms GitHub main provenance, extracts only whitelisted files, verifies checksums/ELF, stages the official JSONJava binary and builds a signed QA APK.
4. consumer-rules.pro prevents R8 from removing/renaming the official JsonClient class used by reflection.

No third-party AAR, dynamic native download, account secrets sent to GitHub, or automatic TDLib build per PR. After this manual gate, a **separate reviewed PR** must pin the approved artifact and enable it in the normal signed upgrade APK; physical Vivo and Telegram acceptance then follow.

Details: docs/architecture/TELEGRAM_TDLIB_APK_ACCEPTANCE_GATE_2026-11-10.md.
