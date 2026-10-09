# Mobile local memory: owner isolation and biometric unlock

PR #15 had a single DB/key for all users of the installation. This phase
isolates device-local SQLCipher stores by profile, using a keyed identifier
derived from the authenticated server user UUID. The `guest` store is
separate and must not be silently merged with an account. Changing account
closes the previous SQLite connection, clears UI state and opens the new
owner's encrypted database.

Every profile's SQLCipher key is stored via `expo-secure-store` with
`requireAuthentication=true`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The
key is retrieved with an interactive device biometric prompt. Devices without
enrolled biometric authentication are explicitly rejected, **not downgraded**
to unprotected storage. Updating biometric enrollments may invalidate the key.
An encrypted export/restore flow is necessary before production distribution.

## Upgrade without guest data loss

The historical PR #15 database remains named `pia-personal-memory-v1.db`
for the guest profile. On the first successful unlock, the legacy key is
re-wrapped in a biometrically protected new SecureStore record. Only after
the existing encrypted database unlocks and passes schema checks is the
old unprotected key record removed. No plaintext memory copy is made.

Previously created local records are assigned to the explicit **guest**
profile. They never automatically enter a signed-in user's different profile.

## Limits

This is device-profile isolation and local access control, *not*
hardware attestation or an end-to-end encrypted multi-device sync solution.
Users sharing enrolled biometrics and the same device may both unlock the
guest store. Use dedicated OS accounts or do not share the guest mode.
Recovery/backup and real-device SQLCipher behavior remain distinct tasks.
