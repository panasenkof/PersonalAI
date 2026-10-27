/**
 * Passwordless, portable encrypted SQLCipher backup.
 *
 * A fresh 256-bit recovery code is the only secret needed to decrypt an
 * exported file. Never export plaintext JSON/SQLite or the device key.
 * SQLCipher's ATTACH KEY + sqlcipher_export reencrypts the source in the
 * native library under the independent recovery code. Restore is atomic and
 * refuses to overwrite existing local memory.
 */
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type * as SQLite from "expo-sqlite";

import { LOCAL_MEMORY_SCHEMA_VERSION, withLocalMemoryDatabase } from "./storage";
import { withUnlockedTransaction } from "./transaction";
import { reindexAll } from "./search-index";

const CODE_PATTERN = /^[a-f0-9]{64}$/;
/** The records themselves, present in every version (v1–v3). */
const BACKUP_TABLES = [
  "memory_collections", "memory_entities", "memory_observations",
  "memory_relations", "memory_revisions",
] as const;
/** v3 user data; chunks, the search index and vectors are rebuilt instead. */
const V3_TABLES = {
  memory_aliases: "entity_id,alias,normalized",
  memory_index_terms: "entity_id,terms,source,created_at",
} as const;
const ENTITY_COLUMNS = "id,collection_id,domain,schema_version,title,payload_json,record_status,sensitivity," +
  "source_kind,source_ref,valid_from,valid_until,created_at,updated_at,record_version";
export const RESTORABLE_VERSIONS = [1, 2, 3, 4, 5, 6, 7];
const LEGACY_MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MANIFEST_FORMAT_VERSION = 1;
const MANIFEST_TABLE = 'persai_backup_manifest' as const;
const LEGACY_MAX_RESTORABLE_ENTITIES = 100000;
const TEMP_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;

type BackupCounts = { entities: number; collections: number; observations: number;
  attachments: number; attachment_parts: number; receipts: number; chats: number };
type BackupManifest = BackupCounts & { format_version: number; schema_version: number };
const COUNT_TABLES = {
  entities: "memory_entities", collections: "memory_collections",
  observations: "memory_observations", attachments: "memory_attachments",
  attachment_parts: "memory_attachment_parts",
  receipts: "memory_received_shares", chats: "direct_conversations",
} as const;
const COUNT_KEYS = Object.keys(COUNT_TABLES) as Array<keyof BackupCounts>;
function backupCountsQuery(prefix: "" | "pia_import."): string {
  // These identifiers are constants, never interpolated user input.
  return "SELECT " + COUNT_KEYS.map(k =>
    "(SELECT count(*) FROM " + prefix + COUNT_TABLES[k] + ") AS " + k).join(", ");
}
function validBackupCounts(counts: BackupCounts): boolean {
  return COUNT_KEYS.every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0);
}
function backupCountValues(counts: BackupCounts): number[] {
  return COUNT_KEYS.map(k => counts[k]);
}


/**
 * Conservative admission guard for the legacy single-file format. Free space
 * may change during an operation; SQLite rollback and cleanup remain required.
 */
async function requireTemporarySpace(estimatedBytes: number, multiplier: number): Promise<void> {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new Error("backup_preflight_unavailable");
  }
  let freeBytes: number;
  try {
    freeBytes = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    throw new Error("backup_storage_unavailable");
  }
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
    throw new Error("backup_storage_unavailable");
  }
  if (freeBytes < Math.ceil(estimatedBytes * multiplier) + TEMP_STORAGE_RESERVE_BYTES) {
    throw new Error("backup_insufficient_space");
  }
}

/** Refuse to export a backup which exceeds the format's restore contract. */
async function preflightExport(db: SQLite.SQLiteDatabase): Promise<void> {
  const count = await db.getFirstAsync<{ n: number }>("SELECT count(*) AS n FROM memory_entities");
  if (!count || !Number.isSafeInteger(count.n) || count.n < 0) {
    throw new Error("backup_preflight_unavailable");
  }
  // Current exports are format-verified; the 100k cap applies to old incoming files only.
  const pages = await db.getFirstAsync<{ page_count: number }>("PRAGMA page_count");
  const pageSize = await db.getFirstAsync<{ page_size: number }>("PRAGMA page_size");
  if (!pages || !pageSize || !Number.isSafeInteger(pages.page_count) ||
      !Number.isSafeInteger(pageSize.page_size) || pages.page_count <= 0 || pageSize.page_size <= 0) {
    throw new Error("backup_preflight_unavailable");
  }
  const estimatedBytes = pages.page_count * pageSize.page_size;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new Error("backup_preflight_unavailable");
  }
  // Export may have encryption overhead. Its actual size is rechecked after writing.
  await requireTemporarySpace(estimatedBytes, 1.25);
}

function checkedRecoveryCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) throw new Error("invalid_recovery_code");
  return code;
}

export function createRecoveryCode(): string {
  return Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, "0")).join("");
}

function temporaryPath(): string {
  if (!FileSystem.cacheDirectory) throw new Error("backup_cache_unavailable");
  return FileSystem.cacheDirectory + "pia-encrypted-" + Crypto.randomUUID() + ".db";
}

async function forgetTemporaryFile(path: string): Promise<void> {
  await Promise.all([
    path, path + "-wal", path + "-shm", path + "-journal",
  ].map(uri => FileSystem.deleteAsync(uri, { idempotent: true })));
}

async function detach(db: SQLite.SQLiteDatabase, alias: "pia_export" | "pia_import"): Promise<void> {
  await db.execAsync("DETACH DATABASE " + alias);
}

function nativeSqlitePath(fileUri: string): string {
  // Expo FileSystem returns file:///... URIs, but Expo SQLite opens native
  // databases with POSIX filesystem paths. SQLCipher ATTACH must receive
  // the actual path, not rely on SQLite having URI-filename support enabled.
  if (!fileUri.startsWith("file:///")) throw new Error("invalid_private_backup_path");
  const path = decodeURIComponent(fileUri.slice("file://".length));
  if (!path.startsWith("/") || path.includes("\\0")) {
    throw new Error("invalid_private_backup_path");
  }
  return path;
}

async function attach(db: SQLite.SQLiteDatabase, alias: "pia_export" | "pia_import", fileUri: string, code: string) {
  // Values are bound to the native statement; never concatenate a user path
  // or recovery code into SQL. Identifiers are fixed literals.
  await db.runAsync("ATTACH DATABASE ? AS " + alias + " KEY ?", [nativeSqlitePath(fileUri), code]);
}

export async function shareEncryptedBackup(profileId: string, recoveryCode: string): Promise<void> {
  const code = checkedRecoveryCode(recoveryCode);
  if (!await Sharing.isAvailableAsync()) throw new Error("backup_sharing_unavailable");
  const path = temporaryPath();
  let attached = false;
  try {
    await withLocalMemoryDatabase(profileId, async db => {
      try {
        await preflightExport(db);
        await attach(db, "pia_export", path, code);
        attached = true;
        // sqlcipher_export copies *all* memory, provenance, relations,
        // revisions, names and the encrypted index without passing plaintext to JS.
        await db.getFirstAsync("SELECT sqlcipher_export('pia_export')");
        await db.execAsync(`PRAGMA pia_export.user_version = ${LOCAL_MEMORY_SCHEMA_VERSION}`);
        // The manifest lives INSIDE SQLCipher ciphertext. No plaintext sidecar.
        await db.execAsync("CREATE TABLE pia_export.persai_backup_manifest (" +
          "format_version INTEGER PRIMARY KEY CHECK(format_version=1), schema_version INTEGER NOT NULL," +
          "entities INTEGER NOT NULL, collections INTEGER NOT NULL, observations INTEGER NOT NULL," +
          "attachments INTEGER NOT NULL, attachment_parts INTEGER NOT NULL," +
          "receipts INTEGER NOT NULL, chats INTEGER NOT NULL)");
        const counts = await db.getFirstAsync<BackupCounts>(backupCountsQuery(""));
        if (!counts || !validBackupCounts(counts)) throw new Error("backup_manifest_unavailable");
        await db.runAsync(
          "INSERT INTO pia_export.persai_backup_manifest " +
            "(format_version,schema_version,entities,collections,observations,attachments,attachment_parts,receipts,chats) " +
            "VALUES (?,?,?,?,?,?,?,?,?)",
          [MANIFEST_FORMAT_VERSION, LOCAL_MEMORY_SCHEMA_VERSION, ...backupCountValues(counts)],
        );
        const cipherIntegrity = await db.getFirstAsync<{ integrity_check: string }>(
          "PRAGMA pia_export.integrity_check",
        );
        if (cipherIntegrity?.integrity_check !== "ok") throw new Error("backup_integrity_check_failed");
        const check = await db.getFirstAsync<{ n: number }>(
          "SELECT count(*) AS n FROM pia_export.memory_collections",
        );
        if (!check || check.n < 0) throw new Error("backup_integrity_check_failed");
      } finally {
        if (attached) {
          attached = false;
          await detach(db, "pia_export");
        }
      }
    });
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || info.isDirectory || !info.size) throw new Error("backup_file_missing");
    if (!Number.isSafeInteger(info.size)) throw new Error("invalid_backup_size");
    // The shared file is SQLCipher ciphertext; code must be stored
    // separately and never included in the name or exported file.
    await Sharing.shareAsync(path, {
      mimeType: "application/octet-stream",
      dialogTitle: "Сохранить зашифрованную резервную копию PersAI",
    });
  } finally {
    await forgetTemporaryFile(path);
  }
}

export type BackupRestoreStats = {
  collections: number; entities: number; observations: number;
};

export async function restoreEncryptedBackup(
  profileId: string, sourceUri: string, recoveryCode: string,
): Promise<BackupRestoreStats> {
  const code = checkedRecoveryCode(recoveryCode);
  if (!sourceUri || !/^(content|file):\/\//.test(sourceUri)) throw new Error("invalid_backup_uri");
  const path = temporaryPath();
  try {
    // Inspect content:// providers before filling private cache.
    const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
    if (!sourceInfo.exists || sourceInfo.isDirectory || !Number.isSafeInteger(sourceInfo.size) ||
        sourceInfo.size <= 0) {
      throw new Error("invalid_backup_size");
    }
    // Source copy plus destination pages, WAL and regenerated search index.
    await requireTemporarySpace(sourceInfo.size, 3);
    await FileSystem.copyAsync({ from: sourceUri, to: path });
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || !info.size) {
      throw new Error("invalid_backup_size");
    }
    // A malicious/buggy content provider may truncate the stream during copy.
    // Never treat a partial cache file as a valid archive.
    if (info.size !== sourceInfo.size) throw new Error("backup_source_size_mismatch");
    return await withLocalMemoryDatabase(profileId, async db => {
      let attached = false;
      try {
        await attach(db, "pia_import", path, code);
        attached = true;
        // Wrong key throws from sqlite_master lookup, before any target write.
        const schema = await db.getAllAsync<{ name: string }>(
          "SELECT name FROM pia_import.sqlite_master WHERE type = 'table'",
        );
        const available = new Set(schema.map(row => row.name));
        if (!BACKUP_TABLES.every(table => available.has(table))) {
          throw new Error("incompatible_backup_schema");
        }
        const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA pia_import.user_version");
        // v2 added chats, v3 record types, names and index words. Every older
        // backup restores into the current schema; the search index is rebuilt.
        if (!version || !RESTORABLE_VERSIONS.includes(version.user_version) || version.user_version > LOCAL_MEMORY_SCHEMA_VERSION) {
          throw new Error("incompatible_backup_version");
        }
        // A v7 archive must carry the user-owned Android Share receipts.
        if (version.user_version >= 7 && !available.has("memory_received_shares")) {
          throw new Error("incompatible_backup_schema");
        }
        // Validate the *source* before any destination writes. A forged
        // SQLCipher file with the right table names can still have corruption.
        const integrity = await db.getFirstAsync<{ integrity_check: string }>(
          "PRAGMA pia_import.integrity_check",
        );
        if (integrity?.integrity_check !== "ok") throw new Error("invalid_backup_integrity");
        const badReference = await db.getFirstAsync("PRAGMA pia_import.foreign_key_check");
        if (badReference !== null) throw new Error("invalid_backup_references");
        const incoming = await db.getFirstAsync<{ n: number }>(
          "SELECT count(*) AS n FROM pia_import.memory_entities",
        );
        if (!incoming || !Number.isSafeInteger(incoming.n) || incoming.n < 0) {
          throw new Error("invalid_backup_records");
        }
        if (available.has(MANIFEST_TABLE)) {
          const manifest = await db.getFirstAsync<BackupManifest>(
            "SELECT * FROM pia_import.persai_backup_manifest",
          );
          const manifestRows = await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM pia_import.persai_backup_manifest",
          );
          if (manifestRows?.n !== 1 || !manifest || manifest.format_version !== MANIFEST_FORMAT_VERSION ||
              manifest.schema_version !== version.user_version || !validBackupCounts(manifest)) {
            throw new Error("backup_manifest_invalid");
          }
          const actual = await db.getFirstAsync<BackupCounts>(backupCountsQuery("pia_import."));
          if (!actual || !validBackupCounts(actual) ||
              backupCountValues(manifest).some((n, i) => n !== backupCountValues(actual)[i])) {
            throw new Error("backup_manifest_mismatch");
          }
        } else if (incoming.n > LEGACY_MAX_RESTORABLE_ENTITIES ||
                   info.size > LEGACY_MAX_BACKUP_BYTES) {
          throw new Error("backup_legacy_limit_without_manifest");
        }
        // Roll back *all* copied records if any table, FK or FTS operation
        // fails. Never replace a profile containing existing memory.
        // ATTACH and the SQLCipher key are scoped to this unlocked connection.
        // Expo's exclusiveTransaction opens a DIFFERENT, still-locked DB.
        await withUnlockedTransaction(db, async tx => {
          const existing = await tx.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_collections",
          );
          if (existing?.n !== 0) throw new Error("restore_requires_empty_memory");
          const entityColumns = await tx.getAllAsync<{ name: string }>("PRAGMA pia_import.table_info(memory_entities)");
          const typed = entityColumns.some(c => c.name === "kind");
          for (const table of BACKUP_TABLES) {
            // Named columns: v3 added «kind», and the type check rejects unknown values.
            const sql = table === "memory_entities"
              ? `INSERT INTO memory_entities(${ENTITY_COLUMNS}${typed ? ",kind" : ""}) SELECT ${ENTITY_COLUMNS}${typed ? ",kind" : ""} FROM pia_import.memory_entities`
              : `INSERT INTO ${table} SELECT * FROM pia_import.${table}`;
            // table is a constant, never user-controlled.
            await tx.execAsync(sql);
          }
          if (!typed) await tx.execAsync("UPDATE memory_entities SET kind='person' WHERE collection_id IN (SELECT id FROM memory_collections WHERE slug='people')");
          for (const [table, columns] of Object.entries(V3_TABLES)) {
            const copyColumns = table === "memory_index_terms" && version.user_version >= 6
              ? columns + ",source_record_version,source_collection_name" : columns;
            if (available.has(table)) await tx.execAsync(`INSERT INTO ${table}(${copyColumns}) SELECT ${copyColumns} FROM pia_import.${table}`);
          }
          if (version.user_version >= 4) {
            for (const table of ["memory_attachments", "memory_attachment_parts"] as const) {
              if (!available.has(table)) throw new Error("incompatible_backup_schema");
              await tx.execAsync(`INSERT INTO ${table} SELECT * FROM pia_import.${table}`);
            }
          }
          // Keep imported Android Share deduplication fingerprints: a source
          // is never re-imported merely because it was restored on another phone.
          // The earlier v1-v6 deployed formats may omit this optional table.
          if (available.has("memory_received_shares")) {
            await tx.execAsync(`INSERT INTO memory_received_shares(fingerprint,entity_id)
              SELECT fingerprint,entity_id FROM pia_import.memory_received_shares`);
          }
          // Hygienic keep/pin/defer are user decisions, NEVER a rebuildable index.
          // v1–v6 backups legitimately have no such preferences.
          if (version.user_version >= 7) {
            if (!available.has("memory_cleanup_preferences")) throw new Error("incompatible_backup_schema");
            await tx.execAsync(`INSERT INTO memory_cleanup_preferences(entity_id,guard,skip_until,version,updated_at)
              SELECT entity_id,guard,skip_until,version,updated_at FROM pia_import.memory_cleanup_preferences`);
          }
          // Chunks and the search index are derived: rebuilt here from the
          // restored records, so a backup can never carry a mismatched index.
          await reindexAll(tx);
          // Older backups have no chats. Import newer ones without replacing
          // any existing local conversation (including its pending proposals).
          if (available.has("direct_conversations")) await tx.execAsync(
            `INSERT OR IGNORE INTO direct_conversations(id,title,snapshot_json,created_at,updated_at)
             SELECT id,title,snapshot_json,created_at,updated_at FROM pia_import.direct_conversations`,
          );
          const violation = await tx.getFirstAsync("PRAGMA foreign_key_check");
          if (violation !== null) throw new Error("invalid_backup_references");
        });
        return {
          collections: (await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_collections",
          ))?.n ?? 0,
          entities: incoming.n,
          observations: (await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_observations",
          ))?.n ?? 0,
        };
      } finally {
        if (attached) await detach(db, "pia_import");
      }
    });
  } finally {
    // A cancelled/partial file-manager copy still needs to be cleaned up.
    await forgetTemporaryFile(path);
  }
}
