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

const CODE_PATTERN = /^[a-f0-9]{64}$/;
const BACKUP_TABLES = [
  "memory_collections", "memory_entities", "memory_observations",
  "memory_relations", "memory_revisions", "memory_notes_fts",
] as const;
const MAX_BACKUP_BYTES = 150 * 1024 * 1024;

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
  await FileSystem.deleteAsync(path, { idempotent: true });
}

async function detach(db: SQLite.SQLiteDatabase, alias: "pia_export" | "pia_import"): Promise<void> {
  await db.execAsync("DETACH DATABASE " + alias);
}

async function attach(db: SQLite.SQLiteDatabase, alias: "pia_export" | "pia_import", path: string, code: string) {
  // Values are bound to the native statement; never concatenate a user path
  // or recovery code into SQL. Identifiers are fixed literals.
  await db.runAsync("ATTACH DATABASE ? AS " + alias + " KEY ?", [path, code]);
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
        // revisions and encrypted FTS without passing plaintext to JS.
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
    // The shared file is SQLCipher ciphertext; code must be stored
    // separately and never included in the name or exported file.
    await Sharing.shareAsync(path, {
      mimeType: "application/octet-stream",
      dialogTitle: "Сохранить зашифрованную резервную копию PersonalAI",
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
        if (version?.user_version !== LOCAL_MEMORY_SCHEMA_VERSION) {
          throw new Error("incompatible_backup_version");
        }
        const incoming = await db.getFirstAsync<{ n: number }>(
          "SELECT count(*) AS n FROM pia_import.memory_entities",
        );
        if (!incoming || incoming.n > 100000) throw new Error("invalid_backup_records");
        // Roll back *all* copied records if any table, FK or FTS operation
        // fails. Never replace a profile containing existing memory.
        await db.withExclusiveTransactionAsync(async tx => {
          const existing = await tx.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_collections",
          );
          if (existing?.n !== 0) throw new Error("restore_requires_empty_memory");
          for (const table of BACKUP_TABLES) {
            const sql = table === "memory_notes_fts"
              ? "INSERT INTO memory_notes_fts(entity_id,title,body) " +
                "SELECT entity_id,title,body FROM pia_import.memory_notes_fts"
              : `INSERT INTO ${table} SELECT * FROM pia_import.${table}`;
            // table is a constant, never user-controlled.
            await tx.execAsync(sql);
          }
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
