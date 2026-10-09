# Offline mobile personal memory — phase 5.1

First usable on-device memory slice for **iOS and Android**: accessible from
the login screen without an account, network connection or PersonalAI server.
An authenticated server user can also switch to the “На телефоне” tab, but
its content is **independent** of their cloud/server account.

## Encryption requirements

Expo SDK 54 `expo-sqlite@16.0.10` is built with the `useSQLCipher: true`
config plugin. It is **not supported in Expo Go**. Build and install your own
native binary (`npx expo prebuild`, EAS development/preview/release build).
The app refuses to open an ordinary/unencrypted SQLite database:
`PRAGMA cipher_version` must report a version before writing memory.

Each installation generates a 256-bit key with `expo-crypto`, storing it
in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The key is
never transmitted to a backend or included in account exports. It persists
across restarts; closing or exiting offline mode does not erase it.
If device secrets are lost or an app is reinstalled, **recovery is not
currently possible**. Back up only when an explicitly encrypted export/import
is implemented in a future phase.

There is no insecure fallback to AsyncStorage/plain SQLite, even during
development. SQLite FTS5 is created *inside* the encrypted database;
all observation history, provenance, and relationships stay there too.

## Supported operations

Device-local contract mirrors Python MemoryRepository:
`createCollection`, `createEntity`, `entity`, scoped `entities`,
`createObservation`, `reviseEntity`, `reviseObservation`,
`linkEntities`, `relationsForEntity`, `revisions`, and
`searchNotes` with SQLite FTS5. Atomic corrections use an
`expectedVersion` guard in an exclusive transaction. Edits are recorded
as before/after snapshots and searchable notes are reindexed transactionally.
All external input is bound into prepared SQL parameters except the
validated hex-only SQLCipher key pragma and two hardcoded identifier choices.
No network calls in storage/repository code.

The first UI supports creating, searching and editing plain notes, adding
events and relations, and reading the correction history. Data stays on
this device. There is **no sync, no server-to-phone migration, no remote
agent access, no deletion/export of device memory yet**.

## Product behavior and limitations

- Guest offline mode opens without API credentials. Returning to server
  login is explicit. Saved server tokens are not used on offline startup.
- The notes are not yet an independent on-device LLM. Text capture/search is
  functional without internet; AI chat still requires the server.
- An existing server account and the phone-local database are separate
  stores by design. The UI must not imply content was copied or synced.
- SQLCipher uses native binaries, so Jest mocks and a Python sqlite3 schema
  check cover testable parts but do **not** replace a real-device QA pass
  with the configured SQLCipher binary (wrong key, backup restore, reinstall).
- App data loss is possible on device loss, reinstall or SecureStore key
  loss. Future encrypted backup, explicit deletion, local PIN/biometric UX
  and cross-device synchronization must address these concerns.

## Verification

From `mobile`: `npm ci && npm run typecheck && npm test -- --runInBand`.
From `backend`: `pytest tests/test_mobile_local_schema.py -q`.
GitHub's CI required gate must be green on the **last** PR commit.
