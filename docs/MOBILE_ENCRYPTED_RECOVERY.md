# Encrypted mobile memory backup and recovery

## Privacy model

Backups never materialize plaintext JSON or an unencrypted SQLite file. On a
native SQLCipher build, `ATTACH DATABASE ? AS pia_export KEY ?` followed by
`sqlcipher_export('pia_export')` copies the local memory into a **new,
independently encrypted** database, including FTS, observations, relations
and revision history. A fresh random 256-bit recovery code, rendered as 64
hex characters, is the independent secret needed to decrypt this file.
Device biometrics and the SecureStore key are not included in the backup.

The user must store the code **separately** from the exported encrypted
file. Neither is transmitted to the PersonalAI server. The user chooses the
destination through the native share sheet. The ephemeral exported file is
deleted from the app cache after sharing, including on failures.

## Recovery

Choose the encrypted SQLCipher file and supply its recovery code on a newly
installed device or an **empty local profile**. The app verifies the format,
table names and schema version before copying any rows. All six tables,
including FTS, are inserted under one exclusive transaction, with foreign
key verification. Existing memory is *never* overwritten, and errors roll
back all changes. The imported file is deleted from app cache.

This initial backup format supports local schema **v1** only. Changes in
schema require explicit migration support.

## Required native sign-off before wide release

- A real Android AND iOS SQLCipher build, not Expo Go.
- Export real notes with observations, links, and revisions; ensure the
  exported header is not `SQLite format 3\0`.
- Import on a fresh phone with correct recovery code. Compare the search
  index, original notes and historical revisions.
- Try an invalid code and corrupt file: target stays empty.
- Attempt restore to a nonempty profile: it is rejected without any writes.
- Interrupt export/import and run with low storage space. No half-import.
- Confirm no outbound network calls, temporary plaintext or secret keys in
  app logs, analytics, filenames, or the shared file.
- Losing both the device and the recovery code still means permanent data
  loss. Exports are manual, not automatic recurring backups.
- This backup contains local memory data only; remote blobs and server
  account data are not included.

The automated Jest tests validate commands and failure paths. They do not
replace native export/import validation.

## Native SQLCipher connection caveat

Expo SDK 54 `withExclusiveTransactionAsync()` internally creates a **new
SQLite connection**. SQLCipher's `PRAGMA key` unlocks the *original connection
only*. Using Expo's exclusive transaction can therefore fail with an encrypted
database (schema creation, edits, FTS and backup import were affected).

PersonalAI instead runs `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` on the
same unlocked connection, with FIFO transaction serialization. Closing or
switching a device profile waits for active writes. This is validated in
regression tests but still requires native device acceptance.
