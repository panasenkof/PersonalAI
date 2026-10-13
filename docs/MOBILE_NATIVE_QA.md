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
4. Cancel the APPLICATION biometric prompt: no app screens or previous notes may render.
   On successful app unlock, visit Memory/Assistant three times: no second
   biometric prompt is allowed. Remove enrolled biometrics: app must refuse to access memory
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

## Mobile usability acceptance

- Upgrade from the previous APK without reinstalling: confirm old notes survive
  the single application unlock and key rewrapping. Keep com.paigent.app and
  the release certificate unchanged.
- Save two different model connections; switch back/forth; restart; verify each
  address, token and model, and that Save returns to the assistant.
- Query a known standard note with memory allowed: memory is searched first.
  Ask for a fresh fact and verify sources with public search without another account.
- Deny microphone, then enable it; dictate without sending; cancel recognition.
- Import text locally; image via vision; audio via STT; video via five frames.
  Confirm no external transfer before the per-file action and no save before confirmation.
- Open a picker/share sheet, cancel/return and authenticate the application as needed;
  ensure no memory-specific sheet or closed-connection error appears.
- Backup disclosure is initially collapsed; export/restore and wrong recovery-code
  checks still need a genuine native device.
