# Application unlock and isolated local memory

PersAI unlocks the **whole application once**, at startup or after a real
background transition. `AppLock` covers inactive/system-sheet transitions,
requires enrolled device biometrics and authorizes the in-process memory session.
Opening the Memory tab, searching notes, saving a note or changing tabs never
creates another biometric challenge. Without an authorized session the storage
layer rejects operations, including use of an already-open connection.

Each guest/server owner has a distinct SQLCipher database and 256-bit key.
Keys remain encrypted in device-bound `expo-secure-store` with
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`. New keys do not use per-item
`requireAuthentication`: authentication belongs to the application boundary.
Database rows, FTS, revisions and WAL remain encrypted. This is application
access control backed by OS secure storage, not a per-query hardware challenge.

## Upgrade without data loss

The guest database retains `pia-personal-memory-v1.db`. Existing v2 biometric
keys are read **on the app unlock screen**, using that read as the one biometric
challenge, and rewrapped into v3 device-bound storage. The SQLCipher key itself
never changes. The old key is removed only after the database successfully opens
and passes schema checks. The active owner is inferred from saved local mode or
a cached JWT subject only to locate the legacy key; server authorization still
uses the server's normal verification.

Switching to a different old profile also routes its one-time key migration
through the application unlock screen, preserving the same SQLCipher key. New
profiles and subsequent tab changes do not add a challenge.

The old unprotected PR #15 guest key is also migrated without copying plaintext
rows. A cancelled migration does not rotate encryption. A stranded initialization
marker can be repaired only for a proven absent/zero-length database. Existing
nonempty encrypted data with a missing key is preserved and reported as locked.
Do not erase an installed database to work around that error.

## Lifecycle and operations

The application owns background locking. Screens do not close the shared
connection on tab blur. Repository operations lease the database for the complete
operation and are serialized with profile switches and backup/restore. Reopening
uses a fresh Expo SQLite native connection. Signing out or changing profiles
closes the previous connection. Guest data is never merged into an account.

System file pickers and share sheets hide app content without destroying the
requesting screen; returning from a sheet that backgrounded the app requires
application authentication before continuing database/network work.

Biometrics shared on one phone can unlock its application. There is no hardware
attestation, server/mobile sync or claim that JS tests prove on-device encryption.
Run the native acceptance checklist before distributing a release broadly.
