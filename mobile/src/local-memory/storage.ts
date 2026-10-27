import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system/legacy";

import { waitForUnlockedTransaction, withUnlockedTransaction } from "./transaction";
import { withBiometricPrompt } from "./authentication";
import { MEMORY_KINDS, reindexAll } from "./search-index";

// Guest uses the historical database name so PR #15 notes are preserved.
const GUEST_DB_NAME = "pia-personal-memory-v1.db";
const LEGACY_GUEST_KEY = "pia.local-memory.sqlcipher.key.v1";
const OLD_PROTECTED_KEY_PREFIX = "pia.local-memory.sqlcipher.biometric.v2.";
const KEY_PREFIX = "pia.local-memory.sqlcipher.app-session.v3.";
let applicationSessionUnlocked = false;
const sessionListeners = new Set<(unlocked: boolean) => void>();
export function authorizeLocalMemorySession(): void {
  applicationSessionUnlocked = true;
  for (const listener of sessionListeners) listener(true);
}
export function revokeLocalMemorySession(): void {
  applicationSessionUnlocked = false;
  for (const listener of sessionListeners) listener(false);
}
/** A completed answer waits for the next app unlock before writing ciphertext.
 * Tab changes have no part in the lifetime of either the session or the job. */
export function waitForApplicationSession(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("session_disposed"));
  if (applicationSessionUnlocked) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { sessionListeners.delete(listener); signal?.removeEventListener("abort", abort); };
    const listener = (unlocked: boolean) => { if (unlocked) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new Error("session_disposed")); };
    sessionListeners.add(listener);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Background work (index words, vectors) stops when the app locks. */
export function onLocalMemorySessionChange(listener: (unlocked: boolean) => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}
export const localMemorySessionUnlocked = () => applicationSessionUnlocked;
const requireApplicationSession = () => { if (!applicationSessionUnlocked) throw new Error("application_locked"); };
export const LOCAL_MEMORY_SCHEMA_VERSION = 9;
const KIND_CHECK = `CHECK(kind IN (${MEMORY_KINDS.map(k => `'${k}'`).join(",")}))`;

/** All memory (including full-text indexes, revisions, and WAL) is in SQLCipher. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS direct_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'note' ${KIND_CHECK}
);
CREATE INDEX IF NOT EXISTS ix_memory_entities_collection ON memory_entities(collection_id, created_at);
CREATE TABLE IF NOT EXISTS memory_attachments (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_attachment_parts (
  attachment_id TEXT NOT NULL REFERENCES memory_attachments(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(attachment_id, ord)
);
-- Source/extraction records are USER DATA: backup/restore must preserve them.
-- A source_version hashes the immutable part hashes, not guessed file paths.
CREATE TABLE IF NOT EXISTS memory_extractions (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES memory_attachments(id) ON DELETE CASCADE,
  source_version TEXT NOT NULL,
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('manual','text','ocr','asr','vision','pdf','unknown')),
  producer_id TEXT NOT NULL,
  producer_revision TEXT NOT NULL,
  language TEXT,
  coverage TEXT NOT NULL CHECK(coverage IN ('full','partial','unknown')),
  status TEXT NOT NULL CHECK(status IN ('complete','partial','failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_memory_extractions_source
  ON memory_extractions(attachment_id,created_at,id);
CREATE TABLE IF NOT EXISTS memory_extraction_segments (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL REFERENCES memory_extractions(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL CHECK(length(text)>0 AND length(text)<=6000),
  location_kind TEXT NOT NULL CHECK(location_kind IN ('page','time','char','unknown')),
  page INTEGER,
  start_ms INTEGER,
  end_ms INTEGER,
  char_start INTEGER,
  char_end INTEGER,
  UNIQUE(extraction_id,ord),
  CHECK (
    (location_kind='unknown' AND page IS NULL AND start_ms IS NULL AND end_ms IS NULL AND char_start IS NULL AND char_end IS NULL)
    OR (location_kind='page' AND page>0 AND start_ms IS NULL AND end_ms IS NULL AND char_start IS NULL AND char_end IS NULL)
    OR (location_kind='time' AND page IS NULL AND start_ms>=0 AND end_ms>start_ms AND char_start IS NULL AND char_end IS NULL)
    OR (location_kind='char' AND page IS NULL AND start_ms IS NULL AND end_ms IS NULL AND char_start>=0 AND char_end>char_start)
  )
);
CREATE INDEX IF NOT EXISTS ix_memory_extraction_segments_run
  ON memory_extraction_segments(extraction_id,ord);
CREATE TABLE IF NOT EXISTS memory_received_shares (
  fingerprint TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE
);
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
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(entity_id, ord)
);
CREATE TABLE IF NOT EXISTS memory_aliases (
  entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL, normalized TEXT NOT NULL,
  UNIQUE(entity_id, normalized)
);
CREATE INDEX IF NOT EXISTS ix_memory_aliases_normalized ON memory_aliases(normalized);
CREATE TABLE IF NOT EXISTS memory_index_terms (
  entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  terms TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
  source_record_version INTEGER, source_collection_name TEXT,
  UNIQUE(entity_id, source)
);
CREATE TABLE IF NOT EXISTS memory_vectors (
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL, dim INTEGER NOT NULL, vector BLOB NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(chunk_id, model)
);
CREATE TABLE IF NOT EXISTS memory_vector_models (
  model TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0,
  scan_cursor TEXT NOT NULL DEFAULT '', scan_complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_vector_jobs (
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL REFERENCES memory_vector_models(model) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','leased','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
  available_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(chunk_id,model)
);
CREATE INDEX IF NOT EXISTS ix_memory_vector_jobs_ready
  ON memory_vector_jobs(model,state,available_at,lease_until,updated_at);
CREATE TABLE IF NOT EXISTS memory_cleanup_preferences (
  entity_id TEXT PRIMARY KEY REFERENCES memory_entities(id) ON DELETE CASCADE,
  guard TEXT NOT NULL DEFAULT 'normal' CHECK(guard IN ('normal','pinned','never_suggest')),
  skip_until TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
  entity_id UNINDEXED, chunk_id UNINDEXED, title, body, terms, aliases, prefix='2 3 4'
);
`;

/** v2 → v3: record types, chunks, names, index words, vectors and one search
 * index over all of them. Runs inside the upgrade transaction: any failure
 * rolls back to the previous version with every record intact. */
async function upgradeToV3(tx: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await tx.getAllAsync<{ name: string }>("PRAGMA table_info(memory_entities)");
  if (!columns.some(c => c.name === "kind")) {
    await tx.execAsync(`ALTER TABLE memory_entities ADD COLUMN kind TEXT NOT NULL DEFAULT 'note' ${KIND_CHECK}`);
  }
  // Records in «Люди» are people; everything else stays a note until edited.
  await tx.execAsync("UPDATE memory_entities SET kind='person' WHERE kind='note' AND collection_id IN (SELECT id FROM memory_collections WHERE slug='people')");
  await tx.execAsync("CREATE INDEX IF NOT EXISTS ix_memory_entities_kind ON memory_entities(kind)");
  await reindexAll(tx);
  await tx.execAsync("DROP TABLE IF EXISTS memory_notes_fts");
}

/** Legacy model timestamps cannot prove which version was actually processed. */
async function upgradeToV6(tx: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await tx.getAllAsync<{ name: string }>("PRAGMA table_info(memory_index_terms)");
  if (!columns.some(c => c.name === "source_record_version")) await tx.execAsync("ALTER TABLE memory_index_terms ADD COLUMN source_record_version INTEGER");
  if (!columns.some(c => c.name === "source_collection_name")) await tx.execAsync("ALTER TABLE memory_index_terms ADD COLUMN source_collection_name TEXT");
}

/** Remove the old one-original-per-note restriction without cascading away bytes.
 * Shadow tables stay inside SQLCipher; the enclosing transaction rolls back on disk-full. */
export async function upgradeToV5(tx: Pick<SQLite.SQLiteDatabase, "execAsync">): Promise<void> {
  await tx.execAsync(`
    CREATE TABLE memory_attachment_parts_v5 AS SELECT * FROM memory_attachment_parts;
    CREATE TABLE memory_attachments_v5 AS SELECT * FROM memory_attachments;
    DROP TABLE memory_attachment_parts;
    DROP TABLE memory_attachments;
    CREATE TABLE memory_attachments (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0), created_at TEXT NOT NULL
    );
    CREATE TABLE memory_attachment_parts (
      attachment_id TEXT NOT NULL REFERENCES memory_attachments(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(attachment_id, ord)
    );
    INSERT INTO memory_attachments SELECT * FROM memory_attachments_v5;
    INSERT INTO memory_attachment_parts SELECT * FROM memory_attachment_parts_v5;
    DROP TABLE memory_attachment_parts_v5;
    DROP TABLE memory_attachments_v5;
  `);
}

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
  databaseName: string; keyName: string; legacyKeyName: string; isGuest: boolean;
}> {
  if (profileId !== "guest" && !/^[a-f0-9-]{8,64}$/i.test(profileId)) {
    throw new Error("invalid_local_memory_owner");
  }
  const hash = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, profileId)).slice(0, 40);
  const isGuest = profileId === "guest";
  return {
    databaseName: isGuest ? GUEST_DB_NAME : `pia-personal-memory-owner-${hash}.db`,
    keyName: KEY_PREFIX + (isGuest ? "guest" : hash),
    legacyKeyName: OLD_PROTECTED_KEY_PREFIX + (isGuest ? "guest" : hash),
    isGuest,
  };
}
const VALID_KEY = /^[0-9a-f]{64}$/;
const BIOMETRIC_OPTIONS = {
  requireAuthentication: true,
  authenticationPrompt: "Войти в PersAI",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Upgrade an old biometric key as part of the APP'S unlock screen. A successful
 * read of that protected secret IS the biometric challenge, avoiding a second
 * authenticateAsync prompt. The underlying SQLCipher key never changes.
 */
export async function needsLegacyMemoryMigration(profileId: string): Promise<boolean> {
  const identity = await localMemoryIdentity(profileId);
  return !(await SecureStore.getItemAsync(identity.keyName)) &&
    Boolean(await SecureStore.getItemAsync(identity.legacyKeyName + ".initialized"));
}

export async function authenticateExistingMemory(profileId: string): Promise<boolean> {
  const identity = await localMemoryIdentity(profileId);
  if (await SecureStore.getItemAsync(identity.keyName)) return false;
  if (!(await SecureStore.getItemAsync(identity.legacyKeyName + ".initialized"))) return false;
  const key = await withBiometricPrompt(() => SecureStore.getItemAsync(identity.legacyKeyName, BIOMETRIC_OPTIONS));
  if (!key) return false;
  if (!VALID_KEY.test(key)) throw new Error("invalid_local_memory_key");
  await SecureStore.setItemAsync(identity.keyName, key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(identity.keyName) !== key) throw new Error("local_memory_unlock_failed");
  return true;
}

async function initialize(profileId: string): Promise<SQLite.SQLiteDatabase> {
  requireApplicationSession();
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("secure_storage_unavailable");
  }
  const identity = await localMemoryIdentity(profileId);
  const marker = identity.keyName + ".initialized";
  const previouslyInitialized = await SecureStore.getItemAsync(marker);
  // AppLock has already authenticated the user. No per-memory biometric sheet.
  let key = await SecureStore.getItemAsync(identity.keyName);
  if (key !== null && !VALID_KEY.test(key)) throw new Error("invalid_local_memory_key");
  let migratedLegacy = false;
  if (!key && identity.isGuest) {
    const legacy = await SecureStore.getItemAsync(LEGACY_GUEST_KEY);
    if (legacy !== null && !VALID_KEY.test(legacy)) throw new Error("invalid_local_memory_key");
    if (legacy) { key = legacy; migratedLegacy = true; }
  }
  if (!key) {
  // Repair the old marker-before-key bug ONLY after proving no data exists.
  // Never replace a lost key for a nonempty encrypted file, even without a marker.
  const directory = SQLite.defaultDatabaseDirectory;
  if (!directory) throw new Error("local_memory_unlock_failed");
  const path = directory.replace(/\/$/, "") + "/" + identity.databaseName;
  // expo-sqlite returns a POSIX path on Android/iOS; FileSystem needs a URI.
  const file = await FileSystem.getInfoAsync(path.startsWith("file://") ? path : "file://" + path);
  if (file.exists && (file.isDirectory || file.size > 0)) throw new Error("local_memory_unlock_failed");
  }
  requireApplicationSession();
  // Always use a fresh native handle; Expo otherwise caches connections.
  const db = await SQLite.openDatabaseAsync(identity.databaseName, { useNewConnection: true });
  try {
    const cipher = await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version");
    if (!cipher?.cipher_version) throw new Error("sqlcipher_required_native_build");
    if (!key) {
      key = Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, "0")).join("");
      await SecureStore.setItemAsync(identity.keyName, key!, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } else if (migratedLegacy) {
      await SecureStore.setItemAsync(identity.keyName, key!, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    }
    requireApplicationSession();
    // Safe interpolation: key is validated hex only, and never logged or exported.
    await db.execAsync(`PRAGMA key = '${key}';`);
    await db.getFirstAsync("SELECT count(*) AS count FROM sqlite_master");
    await db.execAsync("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
    const version = row?.user_version ?? 0;
    if (version > LOCAL_MEMORY_SCHEMA_VERSION) throw new Error("local_memory_schema_too_new");
    // v3 (record types, chunks, one search index) is built from the records
    // themselves, so v1 and v2 databases upgrade the same way.
    // Version 1 exists in TWO deployed forms: before PR #28 without chats,
    // and fresh PR #28 installations with chats. All CREATEs are additive and
    // idempotent, so both upgrade on the same keyed connection without touching
    // existing notes, indexes, revisions, conversations or encryption keys.
    if (version < LOCAL_MEMORY_SCHEMA_VERSION) {
      await withUnlockedTransaction(db, async tx => {
        await tx.execAsync(SCHEMA_SQL);
        await upgradeToV6(tx);
        if (version < 3) await upgradeToV3(tx);
        if (version === 4) await upgradeToV5(tx);
        // v6→v7 adds only private review metadata: never rewrite existing FTS on this upgrade.
        if (version >= 3 && version < 6) await reindexAll(tx);
        await tx.execAsync(`PRAGMA user_version = ${LOCAL_MEMORY_SCHEMA_VERSION}`);
      });
    }
    if (!previouslyInitialized) await SecureStore.setItemAsync(marker, "yes", {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (await SecureStore.getItemAsync(identity.legacyKeyName + ".initialized")) {
      await SecureStore.deleteItemAsync(identity.legacyKeyName);
      await SecureStore.deleteItemAsync(identity.legacyKeyName + ".initialized");
    }
    if (migratedLegacy) {
      await SecureStore.deleteItemAsync(LEGACY_GUEST_KEY);
    }
    return db;
  } catch (error) {
    try { await db.closeAsync(); } catch { /* preserve the original unlock failure */ }
    throw error;
  }
}

/**
 * Execute a complete sensitive operation on a locked profile connection.
 * Profile switches and close operations cannot interrupt an export or restore.
 * UI callers must avoid simultaneous repository writes while this runs.
 */
export async function withLocalMemoryDatabase<T>(
  profileId: string, work: (db: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  return serialize(async () => {
    requireApplicationSession();
    if (current && currentProfile !== profileId) {
      const previous = current;
      current = null;
      currentProfile = null;
      await waitForUnlockedTransaction(previous);
      await previous.closeAsync();
    }
    if (!current) {
      const db = await initialize(profileId);
      current = db;
      currentProfile = profileId;
    }
    requireApplicationSession();
    return work(current);
  });
}

export async function openLocalMemory(profileId: string): Promise<SQLite.SQLiteDatabase> {
  return withLocalMemoryDatabase(profileId, async db => db);
}

/** Close on account switches or expiry of the application session. */
export async function closeLocalMemory(): Promise<void> {
  await serialize(async () => {
    const previous = current;
    current = null;
    currentProfile = null;
    if (previous) {
      await waitForUnlockedTransaction(previous);
      await previous.closeAsync();
    }
  });
}
