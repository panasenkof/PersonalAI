/** Native key policy and profile transitions (mocked SQLite/SecureStore). */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";

jest.mock("expo-sqlite", () => ({ openDatabaseAsync: jest.fn(), defaultDatabaseDirectory: "/private/SQLite" }));
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: jest.fn() }));
jest.mock("expo-secure-store", () => ({
  isAvailableAsync: jest.fn(), canUseBiometricAuthentication: jest.fn(),
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
}));
jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn(), randomUUID: jest.fn(),
  digestStringAsync: jest.fn(), CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));

import { localMemoryRepository } from "../repository";
import { authenticateExistingMemory, authorizeLocalMemorySession, revokeLocalMemorySession, closeLocalMemory, localMemoryIdentity, openLocalMemory } from "../storage";

const vault = new Map<string, string>();
let cancelled = false;
type FakeDatabase = {
  getFirstAsync: jest.Mock;
  getAllAsync: jest.Mock;
  execAsync: jest.Mock;
  withExclusiveTransactionAsync: jest.Mock;
  closeAsync: jest.Mock;
};
const databases: FakeDatabase[] = [];
function newDatabase(): FakeDatabase {
  const db: FakeDatabase = {
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (sql === "PRAGMA cipher_version") return { cipher_version: "4.6.0" };
      if (sql === "PRAGMA user_version") return { user_version: 0 };
      return { count: 1 };
    }),
    execAsync: jest.fn(async () => {}),
    withExclusiveTransactionAsync: jest.fn(async (cb: (db: FakeDatabase) => Promise<void>) => {
      await cb(db);
    }),
    closeAsync: jest.fn(async () => {}),
  };
  databases.push(db);
  return db;
}

beforeEach(async () => {
  await closeLocalMemory();
  authorizeLocalMemorySession();
  vault.clear();
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
  databases.length = 0;
  cancelled = false;
  jest.clearAllMocks();
  (Crypto.getRandomBytes as jest.Mock).mockReturnValue(Uint8Array.from({ length: 32 }, (_, i) => i));
  (Crypto.digestStringAsync as jest.Mock).mockImplementation(async (_alg, input: string) =>
    Array.from(input.slice(-16), ch => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(64, "0"));
  (SecureStore.isAvailableAsync as jest.Mock).mockResolvedValue(true);
  (SecureStore.canUseBiometricAuthentication as jest.Mock).mockReturnValue(true);
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string, options?: { requireAuthentication?: boolean }) => {
    if (cancelled && options?.requireAuthentication) throw new Error("biometric_auth_cancelled");
    return vault.get(key) ?? null;
  });
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => {
    vault.set(key, value);
  });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => {
    vault.delete(key);
  });
  (SQLite.openDatabaseAsync as jest.Mock).mockImplementation(async () => newDatabase());
});

test("rejects access outside an authenticated application session and unsupported SQLCipher", async () => {
  revokeLocalMemorySession();
  await expect(openLocalMemory("guest")).rejects.toThrow("application_locked");
  expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  authorizeLocalMemorySession();
  (SQLite.openDatabaseAsync as jest.Mock).mockImplementationOnce(async () => {
    const db = newDatabase(); db.getFirstAsync.mockResolvedValue(null); return db;
  });
  await expect(openLocalMemory("guest")).rejects.toThrow("sqlcipher_required_native_build");
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});

test("separates guest and owner databases, never reuses the same unlocked connection", async () => {
  const guest = await localMemoryIdentity("guest");
  const bob = await localMemoryIdentity("a0b0c0d0-1111-2222-3333-444455556666");
  const alice = await localMemoryIdentity("a0b0c0d0-1111-2222-3333-777788889999");
  expect(guest.databaseName).toBe("pia-personal-memory-v1.db");
  expect(bob.databaseName).not.toBe(guest.databaseName);
  expect(alice.databaseName).not.toBe(bob.databaseName);
  const guestDb = await openLocalMemory("guest");
  expect(await openLocalMemory("guest")).toBe(guestDb);
  const ownerDb = await openLocalMemory("a0b0c0d0-1111-2222-3333-444455556666");
  expect(ownerDb).not.toBe(guestDb);
  expect(guestDb.closeAsync).toHaveBeenCalledTimes(1);
  // The initialized SQLCipher key must be visible to schema creation.
  expect(guestDb.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  expect(guestDb.execAsync).toHaveBeenCalledWith("BEGIN IMMEDIATE");
  expect(guestDb.execAsync).toHaveBeenCalledWith("COMMIT");
  const names = (SQLite.openDatabaseAsync as jest.Mock).mock.calls.map(c => c[0]);
  expect(names).toEqual([guest.databaseName, bob.databaseName]);
  expect((SecureStore.setItemAsync as jest.Mock).mock.calls.filter(x => x[2]?.requireAuthentication)).toHaveLength(0);
  await closeLocalMemory();
  expect(ownerDb.closeAsync).toHaveBeenCalledTimes(1);
});

test("persists a device-bound 256-bit key without a separate memory prompt", async () => {
  const owner = "a0b0c0d0-1111-2222-3333-444455556666";
  const profile = await localMemoryIdentity(owner);
  const first = await openLocalMemory(owner);
  const key = vault.get(profile.keyName);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(vault.get(profile.keyName + ".initialized")).toBe("yes");
  expect((SecureStore.getItemAsync as jest.Mock).mock.calls.some(x => x[1]?.requireAuthentication)).toBe(false);
  expect((first.execAsync as jest.Mock).mock.calls[0][0]).toBe(`PRAGMA key = '${key}';`);
  await closeLocalMemory();
  const second = await openLocalMemory(owner);
  expect((second.execAsync as jest.Mock).mock.calls[0][0]).toBe(`PRAGMA key = '${key}';`);
  expect((SecureStore.setItemAsync as jest.Mock).mock.calls.filter(x => x[0] === profile.keyName)).toHaveLength(1);
});

test("migrates legacy guest key in place without wiping notes", async () => {
  const legacy = "d".repeat(64);
  vault.set("pia.local-memory.sqlcipher.key.v1", legacy);
  const db = await openLocalMemory("guest");
  const guest = await localMemoryIdentity("guest");
  expect((db.execAsync as jest.Mock).mock.calls[0][0]).toBe(`PRAGMA key = '${legacy}';`);
  expect(vault.get(guest.keyName)).toBe(legacy);
  expect(vault.has("pia.local-memory.sqlcipher.key.v1")).toBe(false);
  await closeLocalMemory();
  const next = await openLocalMemory("guest");
  expect((next.execAsync as jest.Mock).mock.calls[0][0]).toBe(`PRAGMA key = '${legacy}';`);
});

test("lost existing keys never rotate encryption; legacy migration cancellation is retryable", async () => {
  const owner = "a0b0c0d0-1111-2222-3333-444455556666";
  const profile = await localMemoryIdentity(owner);
  vault.set(profile.keyName + ".initialized", "yes");
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 4096 });
  await expect(openLocalMemory(owner)).rejects.toThrow("local_memory_unlock_failed");
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
  vault.set(profile.legacyKeyName, "f".repeat(64));
  vault.set(profile.legacyKeyName + ".initialized", "yes");
  cancelled = true;
  await expect(authenticateExistingMemory(owner)).rejects.toThrow("biometric_auth_cancelled");
  expect(vault.has(profile.keyName)).toBe(false);
  cancelled = false;
  expect(await authenticateExistingMemory(owner)).toBe(true);
  const readsBefore = (SecureStore.getItemAsync as jest.Mock).mock.calls.filter(c => c[1]?.requireAuthentication).length;
  const db = await openLocalMemory(owner);
  expect(db.execAsync).toHaveBeenCalledWith("PRAGMA key = '" + "f".repeat(64) + "';");
  expect((SecureStore.getItemAsync as jest.Mock).mock.calls.filter(c => c[1]?.requireAuthentication)).toHaveLength(readsBefore);
  expect(vault.has(profile.legacyKeyName)).toBe(false);
});

test("refuses invalid stored keys, future schemas and malformed profile ids", async () => {
  await expect(openLocalMemory("Alice@gmail.com")).rejects.toThrow("invalid_local_memory_owner");
  const owner = "a0b0c0d0-1111-2222-3333-444455556666";
  const profile = await localMemoryIdentity(owner);
  vault.set(profile.keyName, "unexpected-sql");
  await expect(openLocalMemory(owner)).rejects.toThrow("invalid_local_memory_key");
  await closeLocalMemory();
  vault.set(profile.keyName, "c".repeat(64));
  (SQLite.openDatabaseAsync as jest.Mock).mockImplementationOnce(async () => {
    const db = newDatabase();
    db.getFirstAsync.mockImplementation(async (sql: string) =>
      sql === "PRAGMA cipher_version" ? { cipher_version: "4.6.0" }
        : sql === "PRAGMA user_version" ? { user_version: 9 } : { count: 1 });
    return db;
  });
  await expect(openLocalMemory(owner)).rejects.toThrow("local_memory_schema_too_new");
});


test("interrupted first-time key write is retryable and never commits a false marker", async () => {
  (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("cancelled"));
  await expect(openLocalMemory("guest")).rejects.toThrow("cancelled");
  const identity = await localMemoryIdentity("guest");
  expect(vault.has(identity.keyName + ".initialized")).toBe(false);
  await expect(openLocalMemory("guest")).resolves.toBeTruthy();
  expect(vault.get(identity.keyName + ".initialized")).toBe("yes");
});

test("repairs a stranded old marker only for a proven empty database", async () => {
  const identity = await localMemoryIdentity("guest");
  vault.set(identity.keyName + ".initialized", "yes");
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 0 });
  await expect(openLocalMemory("guest")).resolves.toBeTruthy();
  expect(vault.get(identity.keyName)).toMatch(/^[a-f0-9]{64}$/);
  expect(FileSystem.getInfoAsync).toHaveBeenCalledWith("file:///private/SQLite/pia-personal-memory-v1.db");
});

test("never invents a replacement key for existing data even if its marker is missing", async () => {
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 4096 });
  await expect(openLocalMemory("guest")).rejects.toThrow("local_memory_unlock_failed");
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
});

test("closing a connection does not reuse it on a repeat visit", async () => {
  const first = await openLocalMemory("guest");
  await closeLocalMemory();
  const second = await openLocalMemory("guest");
  expect(second).not.toBe(first);
  expect(SQLite.openDatabaseAsync).toHaveBeenLastCalledWith("pia-personal-memory-v1.db", { useNewConnection: true });
});


test("revoking the application session blocks even a previously open connection", async () => {
  await openLocalMemory("guest");
  revokeLocalMemorySession();
  await expect(openLocalMemory("guest")).rejects.toThrow("application_locked");
});


test("a retained repository reopens after close and cannot use the old native handle", async () => {
  const repo = await localMemoryRepository("guest");
  const first = databases[0];
  await closeLocalMemory();
  await expect(repo.listCollections()).resolves.toEqual([]);
  expect(first.getAllAsync).not.toHaveBeenCalled();
  expect(databases[1].getAllAsync).toHaveBeenCalledTimes(1);
});

test("closing memory waits for the complete repository operation", async () => {
  const repo = await localMemoryRepository("guest");
  const first = databases[0];
  let finish: (value: any[]) => void = () => {};
  const reading = new Promise<any[]>(resolve => { finish = resolve; });
  first.getAllAsync.mockReturnValueOnce(reading);
  const operation = repo.listCollections();
  await Promise.resolve(); await Promise.resolve();
  const closing = closeLocalMemory();
  expect(first.closeAsync).not.toHaveBeenCalled();
  finish([]);
  await operation; await closing;
  expect(first.closeAsync).toHaveBeenCalledTimes(1);
});
