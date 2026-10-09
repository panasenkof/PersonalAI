import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

// Guest uses the historical database name so PR #15 notes are preserved.
const GUEST_DB_NAME = "pia-personal-memory-v1.db";
const LEGACY_GUEST_KEY = "pia.local-memory.sqlcipher.key.v1";
const PROTECTED_KEY_PREFIX = "pia.local-memory.sqlcipher.biometric.v2.";
export const LOCAL_MEMORY_SCHEMA_VERSION = 1;

/** All memory (including full-text indexes, revisions, and WAL) is in SQLCipher. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  description TEXT, sensitivity TEXT NOT NULL DEFAULT 'unclassified',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES memory_collections(id) ON DELETE CASCADE,
  domain TEXT NOT NULL, schema_version TEXT NOT NULL DEFAULT '1',
  title TEXT, payload_json TEXT NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'active', sensitivity TEXT NOT NULL DEFAULT 'inherit',
  source_kind TEXT, source_ref TEXT, valid_from TEXT, valid_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_memory_entities_collection ON memory_entities(collection_id, created_at);
CREATE TABLE IF NOT EXISTS memory_observations (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'inherit',
  source_kind TEXT, source_ref TEXT, confidence REAL, valid_from TEXT, valid_until TEXT,
  record_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_memory_observations_entity ON memory_observations(entity_id, occurred_at);
CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, source_kind TEXT, source_ref TEXT, created_at TEXT NOT NULL,
  UNIQUE(source_entity_id, target_entity_id, kind),
  CHECK (source_entity_id <> target_entity_id)
);
CREATE INDEX IF NOT EXISTS ix_memory_relations_target ON memory_relations(target_entity_id);
CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY, record_type TEXT NOT NULL CHECK(record_type IN ('entity','observation')),
  entity_id TEXT REFERENCES memory_entities(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES memory_observations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 1),
  reason TEXT NOT NULL, actor_kind TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK ((entity_id IS NOT NULL AND observation_id IS NULL AND record_type='entity')
      OR (entity_id IS NULL AND observation_id IS NOT NULL AND record_type='observation'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_local_entity_revision ON memory_revisions(entity_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS ix_local_observation_revision ON memory_revisions(observation_id, version);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(entity_id UNINDEXED, title, body);
`;

/** SQLCipher is only available in custom native builds, never Expo Go.
 * Verify cipher support before writing any sensitive content, fail closed.
 */
let current: SQLite.SQLiteDatabase | null = null;
let currentProfile: string | null = null;
// Serialize profile switches and closing: never reuse an opened guest database
// for a signed-in account, even if both screens mount concurrently.
let queue: Promise<void> = Promise.resolve();
async function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const previous = queue;
  let release: () => void = () => {};
  queue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await fn(); }
  finally { release(); }
}

export async function localMemoryIdentity(profileId: string): Promise<{
  databaseName: string; keyName: string; isGuest: boolean;
}> {
  if (profileId !== "guest" && !/^[a-f0-9-]{8,64}$/i.test(profileId)) {
    throw new Error("invalid_local_memory_owner");
  }
  const hash = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, profileId)).slice(0, 40);
  const isGuest = profileId === "guest";
  return {
    databaseName: isGuest ? GUEST_DB_NAME : `pia-personal-memory-owner-${hash}.db`,
    keyName: PROTECTED_KEY_PREFIX + (isGuest ? "guest" : hash),
    isGuest,
  };
}
const VALID_KEY = /^[0-9a-f]{64}$/;
const BIOMETRIC_OPTIONS = {
  requireAuthentication: true,
  authenticationPrompt: "Разблокировать персональную память",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function initialize(profileId: string): Promise<SQLite.SQLiteDatabase> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("secure_storage_unavailable");
  }
  const identity = await localMemoryIdentity(profileId);
  // Fail closed on a device without enrolled hardware-backed authentication.
  // There is deliberately no PIN hash or plaintext fallback.
  if (!SecureStore.canUseBiometricAuthentication()) {
    throw new Error("local_memory_biometric_required");
  }
  const db = await SQLite.openDatabaseAsync(identity.databaseName);
  try {
    const cipher = await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version");
    if (!cipher?.cipher_version) throw new Error("sqlcipher_required_native_build");
    let key = await SecureStore.getItemAsync(identity.keyName, BIOMETRIC_OPTIONS);
    if (key !== null && !VALID_KEY.test(key)) throw new Error("invalid_local_memory_key");
    let migratedLegacy = false;
    if (!key && identity.isGuest) {
      // PR #15 guest data remains in the same encrypted SQLite database.
      // Re-wrap its key under biometric access, never copy plaintext rows.
      const legacy = await SecureStore.getItemAsync(LEGACY_GUEST_KEY);
      if (legacy !== null && !VALID_KEY.test(legacy)) throw new Error("invalid_local_memory_key");
      if (legacy) { key = legacy; migratedLegacy = true; }
    }
    if (!key) {
      key = Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, "0")).join("");
    }
    if (!(await SecureStore.getItemAsync(identity.keyName, BIOMETRIC_OPTIONS))) {
      await SecureStore.setItemAsync(identity.keyName, key, BIOMETRIC_OPTIONS);
      // Merely writing a protected key does not constitute biometric unlock.
      // Read it back through the device authenticator before touching memory.
      const validated = await SecureStore.getItemAsync(identity.keyName, BIOMETRIC_OPTIONS);
      if (validated !== key) throw new Error("local_memory_unlock_failed");
    }
    // Safe interpolation: key is validated hex only, and never logged or exported.
    await db.execAsync(`PRAGMA key = '${key}';`);
    await db.getFirstAsync("SELECT count(*) AS count FROM sqlite_master");
    await db.execAsync("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
    const version = row?.user_version ?? 0;
    if (version > LOCAL_MEMORY_SCHEMA_VERSION) throw new Error("local_memory_schema_too_new");
    if (version === 0) {
      await db.withExclusiveTransactionAsync(async tx => {
        await tx.execAsync(SCHEMA_SQL);
        await tx.execAsync("PRAGMA user_version = 1");
      });
    }
    if (migratedLegacy) {
      await SecureStore.deleteItemAsync(LEGACY_GUEST_KEY);
    }
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

export async function openLocalMemory(profileId: string): Promise<SQLite.SQLiteDatabase> {
  return serialize(async () => {
    if (current && currentProfile === profileId) return current;
    if (current) {
      await current.closeAsync();
      current = null;
      currentProfile = null;
    }
    const db = await initialize(profileId);
    current = db;
    currentProfile = profileId;
    return db;
  });
}

/** Close when switching accounts, going to background or locking the device. */
export async function closeLocalMemory(): Promise<void> {
  await serialize(async () => {
    if (current) await current.closeAsync();
    current = null;
    currentProfile = null;
  });
}
