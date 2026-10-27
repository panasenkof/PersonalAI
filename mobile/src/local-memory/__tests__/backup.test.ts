import * as Crypto from "expo-crypto";
import * as FS from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

jest.mock("expo-crypto", () => ({ getRandomBytes: jest.fn(), randomUUID: jest.fn() }));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/", copyAsync: jest.fn(),
  deleteAsync: jest.fn(), getInfoAsync: jest.fn(), getFreeDiskStorageAsync: jest.fn(),
}));
jest.mock("expo-sharing", () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock("../storage", () => ({
  LOCAL_MEMORY_SCHEMA_VERSION: 8,
  withLocalMemoryDatabase: jest.fn(async (_id: string, task: (db: unknown) => Promise<unknown>) => task(mockDb)),
}));

import { withLocalMemoryDatabase } from "../storage";
import { createRecoveryCode, restoreEncryptedBackup, shareEncryptedBackup } from "../backup";

const code = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
let mockRestored = false;
let mockAlreadyContainsMemory = false;
const mockDb = {
  runAsync: jest.fn(async (_sql: string, _params?: unknown[]) => ({})),
  execAsync: jest.fn(async (_sql: string) => {}),
  getFirstAsync: jest.fn(async (_sql: string): Promise<Record<string, string | number | undefined> | null> => ({})),
  getAllAsync: jest.fn(async (_sql: string): Promise<Array<{ name: string }>> => []),
  withExclusiveTransactionAsync: jest.fn(async () => { throw new Error("new_connection_forbidden"); }),
};
const names = ["memory_collections", "memory_entities", "memory_observations",
  "memory_relations", "memory_revisions", "memory_notes_fts"];
let mockTables = names;
const tablesOnce = (tables: string[]) => { mockTables = tables; };

beforeEach(() => {
  jest.clearAllMocks();
  (Crypto.getRandomBytes as jest.Mock).mockReturnValue(Uint8Array.from({ length: 32 }, (_, i) => i));
  (Crypto.randomUUID as jest.Mock).mockReturnValue("random-id");
  (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
  (Sharing.shareAsync as jest.Mock).mockResolvedValue(undefined);
  (FS.deleteAsync as jest.Mock).mockResolvedValue(undefined);
  (FS.copyAsync as jest.Mock).mockResolvedValue(undefined);
  (FS.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 4096, isDirectory: false });
  (FS.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(8 * 1024 * 1024 * 1024);
  mockRestored = false;
  mockAlreadyContainsMemory = false;
  mockDb.runAsync.mockResolvedValue({});
  mockDb.execAsync.mockImplementation(async (sql: string) => {
    if (sql === "COMMIT") mockRestored = true;
  });
  mockDb.getFirstAsync.mockImplementation(async (sql: string): Promise<Record<string, string | number | undefined> | null> => {
    if (sql === "SELECT count(*) AS n FROM memory_entities") return { n: 2 };
    if (sql === "PRAGMA page_count") return { page_count: 20 };
    if (sql === "PRAGMA page_size") return { page_size: 4096 };
    if (sql === "PRAGMA pia_export.integrity_check") return { integrity_check: "ok" };
    if (sql.includes("(SELECT count(*) FROM ")) return { entities: 2, collections: 1, observations: 1, attachments: 0, attachment_parts: 0, receipts: 0, chats: 0 };
    if (sql.includes("pia_import.user_version")) return { user_version: 1 };
    if (sql.includes("pia_import.integrity_check")) return { integrity_check: "ok" };
    if (sql === "SELECT count(*) AS n FROM pia_import.persai_backup_manifest") return { n: 1 };
    if (sql === "SELECT count(*) AS n FROM direct_conversations") return { n: 0 };
    if (sql.includes("JOIN main.direct_conversations current")) return { n: 0 };
    if (sql.includes("pia_import.memory_entities")) return { n: 2 };
    if (sql === "SELECT count(*) AS n FROM memory_collections") {
      return { n: mockAlreadyContainsMemory || mockRestored ? 1 : 0 };
    }
    if (sql.includes("memory_collections")) return { n: 1 };
    if (sql.includes("memory_observations")) return { n: 1 };
    if (sql.includes("foreign_key_check")) return null;
    return {};
  });
  mockTables = names;
  mockDb.getAllAsync.mockImplementation(async (sql: string) => {
    if (sql.includes("pia_import.sqlite_master")) { const tables = mockTables; mockTables = names; return tables.map(name => ({ name })); }
    return [];
  });

});

test("generates 256-bit recovery code and refuses invalid codes before filesystem access", async () => {
  expect(createRecoveryCode()).toBe(code);
  await expect(shareEncryptedBackup("guest", "password")).rejects.toThrow("invalid_recovery_code");
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", "password"))
    .rejects.toThrow("invalid_recovery_code");
  expect(withLocalMemoryDatabase).not.toHaveBeenCalled();
  expect(FS.copyAsync).not.toHaveBeenCalled();
});

test("export SQLCipher-encrypts a new independent file before sharing and erases temp copy", async () => {
  await shareEncryptedBackup("guest", code);
  expect(mockDb.runAsync).toHaveBeenCalledWith("ATTACH DATABASE ? AS pia_export KEY ?", [
    "/cache/pia-encrypted-random-id.db", code,
  ]);
  expect(mockDb.getFirstAsync).toHaveBeenCalledWith("SELECT sqlcipher_export('pia_export')");
  expect(mockDb.execAsync).toHaveBeenCalledWith("PRAGMA pia_export.user_version = 8");
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_export");
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
  expect(FS.deleteAsync).toHaveBeenCalledWith("file:///cache/pia-encrypted-random-id.db", {
    idempotent: true,
  });
});

test("verified export accepts more than 100k records and writes an encrypted manifest", async () => {
  const previous = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "SELECT count(*) AS n FROM memory_entities" ? { n: 100001 } :
    sql.includes("(SELECT count(*) FROM ") ? { entities: 100001, collections: 1, observations: 1,
      attachments: 0, attachment_parts: 0, receipts: 0, chats: 0 } : previous(sql));
  await shareEncryptedBackup("guest", code);
  expect(mockDb.execAsync).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE pia_export.persai_backup_manifest"));
  expect(mockDb.runAsync).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO pia_export.persai_backup_manifest"),
    [1, 7, 100001, 1, 1, 0, 0, 0, 0]);
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
});

test("manifest export admits over 2 GiB when private cache has conservative free space", async () => {
  const previous = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA page_count" ? { page_count: 600000 } : previous(sql));
  await shareEncryptedBackup("guest", code);
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
});

test("export preflight rejects low free storage without creating ciphertext", async () => {
  (FS.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(1000);
  await expect(shareEncryptedBackup("guest", code)).rejects.toThrow("backup_insufficient_space");
  expect(mockDb.runAsync).not.toHaveBeenCalled();
});

test("restore checks provider storage before copying content URI", async () => {
  (FS.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1024);
  await expect(restoreEncryptedBackup("guest", "content://provider/backup", code))
    .rejects.toThrow("backup_insufficient_space");
  expect(FS.copyAsync).not.toHaveBeenCalled();
  expect(withLocalMemoryDatabase).not.toHaveBeenCalled();
});

test("restore rejects a provider with unknown size before copying", async () => {
  (FS.getInfoAsync as jest.Mock).mockResolvedValueOnce({ exists: true, isDirectory: false });
  await expect(restoreEncryptedBackup("guest", "content://provider/unknown-size", code))
    .rejects.toThrow("invalid_backup_size");
  expect(FS.copyAsync).not.toHaveBeenCalled();
});

test("disk space query failure does not imply unlimited storage", async () => {
  (FS.getFreeDiskStorageAsync as jest.Mock).mockRejectedValueOnce(new Error("permission"));
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("backup_storage_unavailable");
  expect(FS.copyAsync).not.toHaveBeenCalled();
});

test("failed share deletes ciphertext from cache", async () => {
  (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error("cancelled"));
  await expect(shareEncryptedBackup("guest", code)).rejects.toThrow("cancelled");
  expect(FS.deleteAsync).toHaveBeenCalledTimes(4);
});

test("wrong password/corrupted backup cannot mutate the destination", async () => {
  mockDb.getAllAsync.mockImplementationOnce(async () => { throw new Error("wrong key"); });
  await expect(restoreEncryptedBackup("guest", "file:///bad.db", code)).rejects.toThrow("wrong key");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_import");
  expect(FS.deleteAsync).toHaveBeenCalledTimes(4);
});

test("restore refuses to overwrite a profile with any existing collection", async () => {
  mockAlreadyContainsMemory = true;
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("restore_requires_empty_memory");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
});

test("restore imports the five record tables atomically on the unlocked connection and rebuilds the search index", async () => {
  const restored = await restoreEncryptedBackup("guest", "file:///backup.db", code);
  expect(restored).toEqual({ collections: 1, entities: 2, observations: 1 });
  expect(mockDb.runAsync).toHaveBeenCalledWith("ATTACH DATABASE ? AS pia_import KEY ?", [
    "/cache/pia-encrypted-random-id.db", code,
  ]);
  expect(mockDb.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  const statements = mockDb.execAsync.mock.calls.map(([sql]: string[]) => sql);
  expect(statements).toContain("BEGIN IMMEDIATE");
  expect(statements).toContain("COMMIT");
  expect(statements.filter((sql: string) => sql.startsWith("INSERT INTO"))).toHaveLength(5);
  // The old index is never copied: it is rebuilt from the restored records.
  expect(statements.some((sql: string) => sql.includes("FROM pia_import.memory_notes_fts"))).toBe(false);
  expect(mockDb.getAllAsync).toHaveBeenCalledWith("SELECT id FROM memory_entities ORDER BY created_at, id");
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_import");
  expect(FS.deleteAsync).toHaveBeenCalledTimes(4);
});

test("rejects corrupt backup contents before target transaction", async () => {
  // Match the source integrity-check pragma regardless of invocation order.
  mockDb.getFirstAsync.mockImplementation(async (sql: string): Promise<Record<string, string | number | undefined> | null> => {
    if (sql.includes("pia_import.user_version")) return { user_version: 1 };
    if (sql.includes("pia_import.integrity_check")) return { integrity_check: "corrupt" };
    return { n: 0 };
  });
  await expect(restoreEncryptedBackup("guest", "file:///corrupt.db", code))
    .rejects.toThrow("invalid_backup_integrity");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
});

test("rejects unknown schema or oversized import before any transaction", async () => {
  tablesOnce([]);
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("incompatible_backup_schema");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
  (FS.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(32 * 1024 * 1024 * 1024);
  (FS.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, size: 3 * 1024 * 1024 * 1024, isDirectory: false });
  await expect(restoreEncryptedBackup("guest", "file:///huge.db", code))
    .rejects.toThrow("backup_legacy_limit_without_manifest");
});


test("partial recovery failure rolls back on the unlocked SQLCipher connection", async () => {
  mockDb.execAsync.mockImplementation(async (sql: string) => {
    if (sql.includes("INSERT INTO memory_observations")) throw new Error("disk_full");
  });
  await expect(restoreEncryptedBackup("guest", "file:///input.db", code))
    .rejects.toThrow("disk_full");
  const commands = mockDb.execAsync.mock.calls.map(([sql]: string[]) => sql);
  expect(commands).toContain("BEGIN IMMEDIATE");
  expect(commands).toContain("ROLLBACK");
  expect(commands).not.toContain("COMMIT");
  expect(mockDb.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  expect(FS.deleteAsync).toHaveBeenCalledTimes(4);
});


test("native ATTACH decodes Expo file:// URI and binds the filesystem path", async () => {
  await shareEncryptedBackup("guest", code);
  const [sql, params] = mockDb.runAsync.mock.calls[0] as [string, unknown[]];
  expect(sql).toBe("ATTACH DATABASE ? AS pia_export KEY ?");
  expect(params[0]).toBe("/cache/pia-encrypted-random-id.db");
  expect(String(params[0])).not.toContain("file://");
});

test("new backups also import chats without overwriting existing conversations; old backups remain valid", async () => {
  tablesOnce([...names, "direct_conversations"]);
  await restoreEncryptedBackup("guest", "file:///backup.db", code);
  expect(mockDb.execAsync.mock.calls.map(([sql]) => sql)).toContainEqual(expect.stringContaining("INSERT INTO direct_conversations"));
});

test("chat ID collision refuses restore without overwriting old or dropping imported conversation", async () => {
  const previous = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    String(sql).includes("JOIN main.direct_conversations current") ? { n: 1 } : previous(sql));
  tablesOnce([...names, "direct_conversations"]);
  await expect(restoreEncryptedBackup("guest", "file:///colliding-chat.db", code))
    .rejects.toThrow("backup_chat_conflict");
  expect(mockDb.execAsync.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO"))).toBe(false);
});

test.each([1, 2, 3])("restores deployed schema v%s including chats into the upgraded memory", async version => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql => sql === "PRAGMA pia_import.user_version" ? { user_version: version } : read(sql));
  tablesOnce([...names, "direct_conversations"]);
  await restoreEncryptedBackup("guest", "file:///backup.db", code);
  expect(mockDb.execAsync.mock.calls.map(([sql]) => sql)).toContainEqual(expect.stringContaining("INSERT INTO direct_conversations"));
});

test.each([0, 9])("rejects unsupported backup schema v%s before copying any memory", async version => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql => sql === "PRAGMA pia_import.user_version" ? { user_version: version } : read(sql));
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code)).rejects.toThrow("incompatible_backup_version");
  expect(mockDb.execAsync.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO"))).toBe(false);
});


test("v4 restores original metadata and bytes in the same transaction", async () => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql => sql === "PRAGMA pia_import.user_version" ? { user_version: 4 } : read(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts"]);
  await restoreEncryptedBackup("guest", "file:///backup.db", code);
  const statements = mockDb.execAsync.mock.calls.map(([sql]) => sql);
  expect(statements).toContain("INSERT INTO memory_attachments SELECT * FROM pia_import.memory_attachments");
  expect(statements).toContain("INSERT INTO memory_attachment_parts SELECT * FROM pia_import.memory_attachment_parts");
  expect(statements.indexOf("COMMIT")).toBeGreaterThan(statements.indexOf("INSERT INTO memory_attachment_parts SELECT * FROM pia_import.memory_attachment_parts"));
});

test("v7 restore brings back explicit keep/skip decisions within the same SQLCipher transaction", async () => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 7 } : read(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_received_shares", "memory_cleanup_preferences"]);
  await restoreEncryptedBackup("guest", "file:///backup.db", code);
  const sql = mockDb.execAsync.mock.calls.map(([s]: string[]) => s);
  const restored = sql.find(s => s.includes("FROM pia_import.memory_cleanup_preferences"));
  expect(restored).toContain("INSERT INTO memory_cleanup_preferences");
  expect(restored).toBeDefined();
  const shareReceipt = sql.find(v => v.includes("FROM pia_import.memory_received_shares"));
  expect(shareReceipt).toContain("INSERT INTO memory_received_shares");
  expect(sql.indexOf("COMMIT")).toBeGreaterThan(sql.indexOf(shareReceipt!));
  expect(sql.indexOf("COMMIT")).toBeGreaterThan(sql.indexOf(restored!));
});

test("v7 archive lacking Android Share receipts is rejected before target writes", async () => {
  const prev = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 7 } : prev(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_cleanup_preferences"]);
  await expect(restoreEncryptedBackup("guest", "file:///truncated-v7.db", code))
    .rejects.toThrow("incompatible_backup_schema");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.includes("INSERT INTO memory_entities"))).toBe(false);
});

test("v4 archives with receipts preserve fingerprints and originals", async () => {
  const prev = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 4 } : prev(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_received_shares"]);
  await restoreEncryptedBackup("guest", "file:///v4.db", code);
  expect(mockDb.execAsync.mock.calls.map(([sql]) => sql)).toContainEqual(
    expect.stringContaining("FROM pia_import.memory_received_shares"));
});

test("verified SQLCipher archive with over 100k records restores after manifest verification", async () => {
  const prior = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 7 } :
    sql === "SELECT * FROM pia_import.persai_backup_manifest" ?
      { format_version: 1, schema_version: 7, entities: 100001, collections: 1,
        observations: 1, attachments: 0, attachment_parts: 0, receipts: 0, chats: 0 } :
    sql.includes("(SELECT count(*) FROM pia_import.") ||
    sql.includes("(SELECT count(*) FROM memory_entities") ?
      { entities: 100001, collections: 1, observations: 1, attachments: 0,
        attachment_parts: 0, receipts: 0, chats: 0 } :
    sql === "SELECT count(*) AS n FROM pia_import.memory_entities" ? { n: 100001 } : prior(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_received_shares",
    "memory_cleanup_preferences", "direct_conversations", "persai_backup_manifest"]);
  const out = await restoreEncryptedBackup("guest", "file:///large-manifest.db", code);
  expect(out.entities).toBe(100001);
  expect(mockDb.execAsync).toHaveBeenCalledWith("COMMIT");
});

test("verified restore checks row-count symmetry inside transaction before COMMIT", async () => {
  const before = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql => {
    if (sql === "PRAGMA pia_import.user_version") return { user_version: 7 };
    if (sql === "SELECT * FROM pia_import.persai_backup_manifest") return {
      format_version: 1, schema_version: 7, entities: 2, collections: 1,
      observations: 1, attachments: 0, attachment_parts: 0, receipts: 0, chats: 0,
    };
    if (sql.includes("(SELECT count(*) FROM ")) {
      const inserted = mockDb.execAsync.mock.calls.some(([text]: string[]) =>
        text.includes("INSERT INTO memory_entities"));
      const original = { entities: 2, collections: 1, observations: 1,
        attachments: 0, attachment_parts: 0, receipts: 0, chats: 0 };
      return sql.includes("pia_import.") || !inserted ? original : { ...original, entities: 1 };
    }
    return before(sql);
  });
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_received_shares",
    "memory_cleanup_preferences", "direct_conversations", "persai_backup_manifest"]);
  await expect(restoreEncryptedBackup("guest", "file:///rowloss.db", code))
    .rejects.toThrow("backup_restore_count_mismatch");
  const commands = mockDb.execAsync.mock.calls.map(([sql]) => String(sql));
  expect(commands).toContain("ROLLBACK");
  expect(commands).not.toContain("COMMIT");
});

test("manifest mismatch is rejected without any destination insert", async () => {
  const prior = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 7 } :
    sql === "SELECT * FROM pia_import.persai_backup_manifest" ?
      { format_version: 1, schema_version: 7, entities: 100001, collections: 1,
        observations: 1, attachments: 0, attachment_parts: 0, receipts: 0, chats: 0 } :
    prior(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_received_shares",
    "memory_cleanup_preferences", "direct_conversations", "persai_backup_manifest"]);
  await expect(restoreEncryptedBackup("guest", "file:///mismatched.db", code))
    .rejects.toThrow("backup_manifest_mismatch");
  expect(mockDb.execAsync.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO"))).toBe(false);
});

test("rejects a truncated Android content URI before opening SQLCipher", async () => {
  (FS.getInfoAsync as jest.Mock)
    .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 12345 })
    .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 1234 });
  await expect(restoreEncryptedBackup("guest", "content://provider/partial", code))
    .rejects.toThrow("backup_source_size_mismatch");
  expect(withLocalMemoryDatabase).not.toHaveBeenCalled();
});

test("v7 backup missing policy table fails before mutation", async () => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 7 } : read(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts"]);
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("incompatible_backup_schema");
  // v7 now checks required tables BEFORE entering a write transaction.
  const statements = mockDb.execAsync.mock.calls.map(([s]: string[]) => s);
  expect(statements).not.toContain("BEGIN IMMEDIATE");
  expect(statements).not.toContain("COMMIT");
  expect(statements.some(sql => sql.includes("INSERT INTO memory_entities"))).toBe(false);
});
