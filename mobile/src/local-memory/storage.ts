import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

const DB_NAME = "pia-personal-memory-v1.db";
const KEY_NAME = "pia.local-memory.sqlcipher.key.v1";
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
let opening: Promise<SQLite.SQLiteDatabase> | null = null;
let current: SQLite.SQLiteDatabase | null = null;

async function initialize(): Promise<SQLite.SQLiteDatabase> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("secure_storage_unavailable");
  }
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  try {
    const cipher = await db.getFirstAsync<{ version: string }>("PRAGMA cipher_version");
    if (!cipher?.version) throw new Error("sqlcipher_required_native_build");
    let key = await SecureStore.getItemAsync(KEY_NAME);
    if (key !== null && !/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid_local_memory_key");
    if (!key) {
      key = Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, "0")).join("");
      await SecureStore.setItemAsync(KEY_NAME, key, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
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
    current = db;
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

export async function openLocalMemory(): Promise<SQLite.SQLiteDatabase> {
  if (!opening) {
    opening = initialize().catch(error => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

/** Closing does not erase data or the key. No plaintext fallback. */
export async function closeLocalMemory(): Promise<void> {
  const old = current;
  current = null;
  opening = null;
  if (old) await old.closeAsync();
}
