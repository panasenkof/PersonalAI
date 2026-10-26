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
export const RESTORABLE_VERSIONS = [1, 2, 3, 4, 5, 6];
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

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
        await attach(db, "pia_export", path, code);
        attached = true;
        // sqlcipher_export copies *all* memory, provenance, relations,
        // revisions, names and the encrypted index without passing plaintext to JS.
        await db.getFirstAsync("SELECT sqlcipher_export('pia_export')");
        await db.execAsync(`PRAGMA pia_export.user_version = ${LOCAL_MEMORY_SCHEMA_VERSION}`);
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
    if (info.size > MAX_BACKUP_BYTES) throw new Error("backup_file_too_large");
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
    await FileSystem.copyAsync({ from: sourceUri, to: path });
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || info.isDirectory || !info.size || info.size > MAX_BACKUP_BYTES) {
      throw new Error("invalid_backup_size");
    }
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
        if (!incoming || incoming.n > 100000) throw new Error("invalid_backup_records");
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
