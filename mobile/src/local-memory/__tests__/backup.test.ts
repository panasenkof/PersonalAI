import * as Crypto from "expo-crypto";
import * as FS from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

jest.mock("expo-crypto", () => ({ getRandomBytes: jest.fn(), randomUUID: jest.fn() }));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/", copyAsync: jest.fn(),
  deleteAsync: jest.fn(), getInfoAsync: jest.fn(),
}));
jest.mock("expo-sharing", () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock("../storage", () => ({
  LOCAL_MEMORY_SCHEMA_VERSION: 7,
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
  getFirstAsync: jest.fn(async (_sql: string): Promise<Record<string, string | number> | null> => ({})),
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
  mockRestored = false;
  mockAlreadyContainsMemory = false;
  mockDb.runAsync.mockResolvedValue({});
  mockDb.execAsync.mockImplementation(async (sql: string) => {
    if (sql === "COMMIT") mockRestored = true;
  });
  mockDb.getFirstAsync.mockImplementation(async (sql: string): Promise<Record<string, string | number> | null> => {
    if (sql.includes("pia_import.user_version")) return { user_version: 1 };
    if (sql.includes("pia_import.integrity_check")) return { integrity_check: "ok" };
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
  expect(mockDb.execAsync).toHaveBeenCalledWith("PRAGMA pia_export.user_version = 7");
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_export");
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
  expect(FS.deleteAsync).toHaveBeenCalledWith("file:///cache/pia-encrypted-random-id.db", {
    idempotent: true,
  });
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
  mockDb.getFirstAsync.mockImplementation(async (sql: string): Promise<Record<string, string | number> | null> => {
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
  (FS.getInfoAsync as jest.Mock).mockResolvedValueOnce({
    exists: true, size: 3 * 1024 * 1024 * 1024, isDirectory: false,
  });
  await expect(restoreEncryptedBackup("guest", "file:///huge.db", code))
    .rejects.toThrow("invalid_backup_size");
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
  expect(mockDb.execAsync.mock.calls.map(([sql]) => sql)).toContainEqual(expect.stringContaining("INSERT OR IGNORE INTO direct_conversations"));
});

test.each([1, 2, 3])("restores deployed schema v%s including chats into the upgraded memory", async version => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql => sql === "PRAGMA pia_import.user_version" ? { user_version: version } : read(sql));
  tablesOnce([...names, "direct_conversations"]);
  await restoreEncryptedBackup("guest", "file:///backup.db", code);
  expect(mockDb.execAsync.mock.calls.map(([sql]) => sql)).toContainEqual(expect.stringContaining("INSERT OR IGNORE INTO direct_conversations"));
});

test.each([0, 8])("rejects unsupported backup schema v%s before copying any memory", async version => {
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
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts", "memory_cleanup_preferences"]);
  await restoreEncryptedBackup("guest", "file:///backup.db", code);
  const sql = mockDb.execAsync.mock.calls.map(([s]: string[]) => s);
  const restored = sql.find(s => s.includes("FROM pia_import.memory_cleanup_preferences"));
  expect(restored).toContain("INSERT INTO memory_cleanup_preferences");
  expect(sql.indexOf("COMMIT")).toBeGreaterThan(sql.indexOf(restored));
});

test("v7 backup missing policy table fails before mutation", async () => {
  const read = mockDb.getFirstAsync.getMockImplementation()!;
  mockDb.getFirstAsync.mockImplementation(async sql =>
    sql === "PRAGMA pia_import.user_version" ? { user_version: 7 } : read(sql));
  tablesOnce([...names, "memory_attachments", "memory_attachment_parts"]);
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("incompatible_backup_schema");
  // Schema check may run during a transaction, but the entire transaction rolls back.
  const statements = mockDb.execAsync.mock.calls.map(([s]: string[]) => s);
  expect(statements).toContain("ROLLBACK");
  expect(statements).not.toContain("COMMIT");
});
