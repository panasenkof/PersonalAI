/** Crypto gate tests. SQLCipher must be verified before writing a single memory row. */
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";

jest.mock("expo-sqlite", () => ({ openDatabaseAsync: jest.fn() }));
jest.mock("expo-secure-store", () => ({
  isAvailableAsync: jest.fn(),
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
}));
jest.mock("expo-crypto", () => ({ getRandomBytes: jest.fn(), randomUUID: jest.fn() }));

import { closeLocalMemory, openLocalMemory } from "../storage";

const db = {
  getFirstAsync: jest.fn(),
  execAsync: jest.fn(async () => {}),
  withExclusiveTransactionAsync: jest.fn(async (task: (tx: unknown) => Promise<void>) => task(db)),
  closeAsync: jest.fn(async () => {}),
};
beforeEach(async () => {
  await closeLocalMemory();
  jest.clearAllMocks();
  (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(db);
  (SecureStore.isAvailableAsync as jest.Mock).mockResolvedValue(true);
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
  (SecureStore.setItemAsync as jest.Mock).mockResolvedValue(undefined);
  (Crypto.getRandomBytes as jest.Mock).mockReturnValue(Uint8Array.from({ length: 32 }, (_, i) => i));
  db.getFirstAsync.mockImplementation(async (query: string) => {
    if (query === "PRAGMA cipher_version") return { cipher_version: "4.6.0" };
    if (query === "PRAGMA user_version") return { user_version: 0 };
    return { count: 1 };
  });
});

test("refuses Expo Go/unencrypted SQLite without creating a key or schema", async () => {
  db.getFirstAsync.mockResolvedValue(null);
  await expect(openLocalMemory()).rejects.toThrow("sqlcipher_required_native_build");
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(db.execAsync).not.toHaveBeenCalled();
  expect(db.closeAsync).toHaveBeenCalled();
});

test("refuses to open when secure key storage is inaccessible", async () => {
  (SecureStore.isAvailableAsync as jest.Mock).mockResolvedValue(false);
  await expect(openLocalMemory()).rejects.toThrow("secure_storage_unavailable");
  expect(SQLite.openDatabaseAsync).not.toHaveBeenCalled();
});

test("creates 256-bit device-only key, unlocks SQLCipher, initializes schema once", async () => {
  const [one, two] = await Promise.all([openLocalMemory(), openLocalMemory()]);
  expect(one).toBe(two);
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
  const [keyName, keyValue, options] = (SecureStore.setItemAsync as jest.Mock).mock.calls[0];
  expect(keyName).toContain("sqlcipher");
  expect(keyValue).toMatch(/^[0-9a-f]{64}$/);
  expect(options.keychainAccessible).toBe("device-only");
  expect(db.execAsync.mock.calls[0][0]).toBe("PRAGMA key = '" + keyValue + "';");
  expect(db.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
  expect(db.execAsync.mock.calls.some(([sql]: string[]) => sql.includes("CREATE TABLE IF NOT EXISTS memory_relations"))).toBe(true);
  await closeLocalMemory();
  expect(db.closeAsync).toHaveBeenCalledTimes(1);
});

test("existing encryption key stays stable and migrations never replace data", async () => {
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue("a".repeat(64));
  db.getFirstAsync.mockImplementation(async (sql: string) => sql === "PRAGMA cipher_version"
    ? { cipher_version: "4.6.0" }
    : sql === "PRAGMA user_version" ? { user_version: 1 } : { count: 1 });
  await openLocalMemory();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  expect(db.execAsync.mock.calls[0][0]).toBe("PRAGMA key = '" + "a".repeat(64) + "';");
});

test("refuses corrupt key or future schema rather than silently resetting storage", async () => {
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue("'; DROP TABLE memory_entities;--");
  await expect(openLocalMemory()).rejects.toThrow("invalid_local_memory_key");
  expect(db.execAsync).not.toHaveBeenCalled();
  await closeLocalMemory();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue("b".repeat(64));
  db.getFirstAsync.mockImplementation(async (sql: string) => sql === "PRAGMA cipher_version"
    ? { cipher_version: "4.6.0" }
    : sql === "PRAGMA user_version" ? { user_version: 9 } : { count: 1 });
  await expect(openLocalMemory()).rejects.toThrow("local_memory_schema_too_new");
  expect(db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
});
