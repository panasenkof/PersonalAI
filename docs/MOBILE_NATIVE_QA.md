# Native SQLCipher verification (Android)

The standard `CI required` workflow checks TypeScript, Jest, Expo JavaScript
bundles, backend databases and release infrastructure. None of those compiles
the native SQLCipher library. This separate workflow builds the **real
Android APK** after `expo prebuild --clean`, using SDK 54's `useSQLCipher`
plugin. It runs for mobile-related PRs and can be manually dispatched.

It establishes native compile compatibility; the APK must still be tested
on an emulator or physical device with enrolled biometrics before the
encrypted-local-memory feature is approved for public release.

## Required on-device signoff

1. Install the `pia-sqlcipher-debug-apk` artifact (not Expo Go). Enroll device
   biometric authentication and launch the app.
2. Guest memory: create a note; quit app fully, relaunch, unlock and ensure
   the note survived (same SQLCipher key, same DB).
3. Confirm ordinary SQLite cannot open the encrypted DB without the key;
   check that the DB file does not begin with the plaintext header
   `SQLite format 3\0`.
4. Cancel biometric prompt: no previous notes may render; memory must
   remain locked. Remove enrolled biometrics: app must refuse to access memory
   rather than generate a new key.
5. Sign into two distinct server accounts (once PR #17 is merged), create
   separate local notes, switch profile and ensure no cross-account results.
6. Upgrade from PR #15 with an existing guest note: open with biometrics and
   ensure the old encrypted data remains readable and old key is removed.
7. Simulate process restart, app backgrounding and low-storage conditions.
   Check fail-closed handling. Test both Android and iOS native release
   binaries before launch; this workflow only compiles Android.

Do not claim that a green native build proves runtime encryption.
Store a record of on-device pass/fail before general availability.

## Offline list improvements

Local note search now supports `limit`/`offset` paging. The UI offers
“Показать ещё” instead of truncating silently at the first 50 results.
