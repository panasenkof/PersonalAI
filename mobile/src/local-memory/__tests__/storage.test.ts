/** Native key policy and profile transitions (mocked SQLite/SecureStore). */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

jest.mock("expo-sqlite", () => ({ openDatabaseAsync: jest.fn() }));
jest.mock("expo-secure-store", () => ({
  isAvailableAsync: jest.fn(), canUseBiometricAuthentication: jest.fn(),
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
}));
jest.mock("expo-crypto", () => ({
  getRandomBytes: jest.fn(), randomUUID: jest.fn(),
  digestStringAsync: jest.fn(), CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));

import { closeLocalMemory, localMemoryIdentity, openLocalMemory } from "../storage";

const vault = new Map<string, string>();
let cancelled = false;
type FakeDatabase = {
  getFirstAsync: jest.Mock;
  execAsync: jest.Mock;
  withExclusiveTransactionAsync: jest.Mock;
  closeAsync: jest.Mock;
};
const databases: FakeDatabase[] = [];
function newDatabase(): FakeDatabase {
  const db: FakeDatabase = {
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
  vault.clear();
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

test("rejects unenrolled biometrics and plaintext Expo Go builds before creating a key", async () => {
  (SecureStore.canUseBiometricAuthentication as jest.Mock).mockReturnValue(false);
  await expect(openLocalMemory("guest")).rejects.toThrow("local_memory_biometric_required");
  expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
  (SecureStore.canUseBiometricAuthentication as jest.Mock).mockReturnValue(true);
  (SQLite.openDatabaseAsync as jest.Mock).mockImplementationOnce(async () => {
    const db = newDatabase();
    db.getFirstAsync.mockResolvedValue(null);
    return db;
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
  expect((SecureStore.setItemAsync as jest.Mock).mock.calls.filter(x => x[2]?.requireAuthentication)).toHaveLength(2);
  await closeLocalMemory();
  expect(ownerDb.closeAsync).toHaveBeenCalledTimes(1);
});

test("persists device-bound 256-bit key and requires interactive unlock", async () => {
  const owner = "a0b0c0d0-1111-2222-3333-444455556666";
  const profile = await localMemoryIdentity(owner);
  const first = await openLocalMemory(owner);
  const key = vault.get(profile.keyName);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(vault.get(profile.keyName + ".initialized")).toBe("yes");
  expect((SecureStore.getItemAsync as jest.Mock).mock.calls.some(x => x[0] === profile.keyName &&
    x[1]?.requireAuthentication)).toBe(true);
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

test("missing previously protected key or cancelled authentication never rotates old encryption", async () => {
  const owner = "a0b0c0d0-1111-2222-3333-444455556666";
  const profile = await localMemoryIdentity(owner);
  vault.set(profile.keyName + ".initialized", "yes");
  await expect(openLocalMemory(owner)).rejects.toThrow("local_memory_unlock_failed");
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
  vault.set(profile.keyName, "f".repeat(64));
  cancelled = true;
  await expect(openLocalMemory(owner)).rejects.toThrow("biometric_auth_cancelled");
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
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
