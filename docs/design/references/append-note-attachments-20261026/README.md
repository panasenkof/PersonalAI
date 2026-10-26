# Existing-note attachments — browser evidence

Synthetic QA note only; no personal data. `entry-320.png`: saved note with the new Add files entry. `staged-320.png`: selected original, remove/cancel/save actions. Previously importing originals always created another note.

TypeScript PASS. Full Jest: 84 suites / 592 tests PASS (existing worker teardown warning remains). Browser workflows 320/360/390/430 PASS, including cancellation and append preserving the text. Final screenshot-only animation handling rerun at 320 PASS: disable CSS animation when capturing so the image represents the settled sheet. SQLite tests cover real transaction rollback and byte roundtrip with mocked Expo file I/O; browser uses a metadata adapter, not native encryption.

Android system picker/actual codecs/TalkBack/font scaling NOT RUN locally. Required minimal Maestro remains unchanged; PR CI is reported separately for its exact SHA. No owner sign-off is required to continue functions.
