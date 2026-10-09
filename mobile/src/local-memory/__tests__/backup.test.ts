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
  LOCAL_MEMORY_SCHEMA_VERSION: 1,
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
  getFirstAsync: jest.fn(async (_sql: string): Promise<Record<string, number> | null> => ({})),
  getAllAsync: jest.fn(async (_sql: string): Promise<Array<{ name: string }>> => []),
  withExclusiveTransactionAsync: jest.fn(async () => { throw new Error("new_connection_forbidden"); }),
};
const names = ["memory_collections", "memory_entities", "memory_observations",
  "memory_relations", "memory_revisions", "memory_notes_fts"];

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
  mockDb.getFirstAsync.mockImplementation(async (sql: string): Promise<Record<string, number> | null> => {
    if (sql.includes("pia_import.user_version")) return { user_version: 1 };
    if (sql.includes("pia_import.memory_entities")) return { n: 2 };
    if (sql === "SELECT count(*) AS n FROM memory_collections") {
      return { n: mockAlreadyContainsMemory || mockRestored ? 1 : 0 };
    }
    if (sql.includes("memory_collections")) return { n: 1 };
    if (sql.includes("memory_observations")) return { n: 1 };
    if (sql.includes("foreign_key_check")) return null;
    return {};
  });
  mockDb.getAllAsync.mockResolvedValue(names.map(name => ({ name })));

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
    "file:///cache/pia-encrypted-random-id.db", code,
  ]);
  expect(mockDb.getFirstAsync).toHaveBeenCalledWith("SELECT sqlcipher_export('pia_export')");
  expect(mockDb.execAsync).toHaveBeenCalledWith("PRAGMA pia_export.user_version = 1");
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_export");
  expect(Sharing.shareAsync).toHaveBeenCalledTimes(1);
  expect(FS.deleteAsync).toHaveBeenCalledWith("file:///cache/pia-encrypted-random-id.db", {
    idempotent: true,
  });
});

test("failed share deletes ciphertext from cache", async () => {
  (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error("cancelled"));
  await expect(shareEncryptedBackup("guest", code)).rejects.toThrow("cancelled");
  expect(FS.deleteAsync).toHaveBeenCalledTimes(1);
});

test("wrong password/corrupted backup cannot mutate the destination", async () => {
  mockDb.getAllAsync.mockRejectedValueOnce(new Error("wrong key"));
  await expect(restoreEncryptedBackup("guest", "file:///bad.db", code)).rejects.toThrow("wrong key");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_import");
  expect(FS.deleteAsync).toHaveBeenCalledTimes(1);
});

test("restore refuses to overwrite a profile with any existing collection", async () => {
  mockAlreadyContainsMemory = true;
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("restore_requires_empty_memory");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
});

test("restore imports all six tables and FTS atomically on the unlocked connection", async () => {
  const restored = await restoreEncryptedBackup("guest", "file:///backup.db", code);
  expect(restored).toEqual({ collections: 1, entities: 2, observations: 1 });
  expect(mockDb.runAsync).toHaveBeenCalledWith("ATTACH DATABASE ? AS pia_import KEY ?", [
    "file:///cache/pia-encrypted-random-id.db", code,
  ]);
  expect(mockDb.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  const statements = mockDb.execAsync.mock.calls.map(([sql]: string[]) => sql);
  expect(statements).toContain("BEGIN IMMEDIATE");
  expect(statements).toContain("COMMIT");
  expect(statements.filter((sql: string) => sql.startsWith("INSERT INTO"))).toHaveLength(6);
  expect(statements.some((sql: string) => sql.includes("FROM pia_import.memory_notes_fts"))).toBe(true);
  expect(mockDb.execAsync).toHaveBeenCalledWith("DETACH DATABASE pia_import");
  expect(FS.deleteAsync).toHaveBeenCalledTimes(1);
});

test("rejects unknown schema or oversized import before any transaction", async () => {
  mockDb.getAllAsync.mockResolvedValueOnce([]);
  await expect(restoreEncryptedBackup("guest", "file:///backup.db", code))
    .rejects.toThrow("incompatible_backup_schema");
  expect(mockDb.execAsync.mock.calls.some(([sql]: string[]) => sql.startsWith("INSERT INTO"))).toBe(false);
  (FS.getInfoAsync as jest.Mock).mockResolvedValueOnce({
    exists: true, size: 200 * 1024 * 1024, isDirectory: false,
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
  expect(FS.deleteAsync).toHaveBeenCalledTimes(1);
});
