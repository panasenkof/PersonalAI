import * as SQLite from "expo-sqlite";
import { closeLocalMemory, localMemoryIdentity, openLocalMemory, authorizeLocalMemorySession } from "../storage";
import { localMemoryRepository } from "../repository";
import { conversationRepository } from "../../direct-agent/conversations";
import { DirectChatStore } from "../../direct-agent/chat-store";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
let mockDirectory: string;
const mockVault = new Map<string, string>();
const mockConnections: any[] = [];
let mockMigrationFailure = false;
jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(),
  get defaultDatabaseDirectory() { return mockDirectory; },
}));
jest.mock("expo-secure-store", () => ({
  isAvailableAsync: async () => true, WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: async (key: string) => mockVault.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockVault.set(key, value); },
  deleteItemAsync: async (key: string) => { mockVault.delete(key); },
}));
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: async () => ({ exists: false }) }));
jest.mock("expo-crypto", () => ({
  randomUUID: () => require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: async (_algorithm: string, value: string) => require("node:crypto").createHash("sha256").update(value).digest("hex"),
  getRandomBytes: jest.fn(() => new Uint8Array(32).fill(1)),
}));

beforeEach(async () => {
  await closeLocalMemory(); authorizeLocalMemorySession();
  mockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "persai-upgrade-"));
  mockVault.clear(); mockConnections.length = 0; mockMigrationFailure = false;
  (SQLite.openDatabaseAsync as jest.Mock).mockImplementation(async (name: string) => {
    const sqlite = new DatabaseSync(path.join(mockDirectory, name));
    const connection = {
      sqlite,
      getFirstAsync: async (sql: string, params: unknown[] = []) => sql === "PRAGMA cipher_version"
        ? { cipher_version: "bridge-fixture" } : sqlite.prepare(sql).get(...params) ?? null,
      getAllAsync: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params),
      runAsync: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).run(...params),
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
        if (mockMigrationFailure && sql.includes("CREATE TABLE IF NOT EXISTS direct_conversations")) {
          throw new Error("simulated_disk_full");
        }
      },
      closeAsync: jest.fn(async () => { sqlite.close(); }),
    };
    mockConnections.push(connection); return connection;
  });
});
afterEach(async () => { await closeLocalMemory(); fs.rmSync(mockDirectory, { recursive: true, force: true }); });

async function installationV1(withChats = false) {
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  legacy.exec(fs.readFileSync(path.join(__dirname, "fixtures/v1-memory.sql"), "utf8"));
  legacy.exec(`
    INSERT INTO memory_collections VALUES ('recipes','Рецепты','recipes',NULL,'standard','2026-10-12');
    INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,created_at,updated_at,record_version)
      VALUES ('note','recipes','notes','Индейка','{"title":"Индейка","body":"Чеснок и паприка"}','2026-10-12','2026-10-13',2);
    INSERT INTO memory_notes_fts VALUES ('note','Индейка','Чеснок и паприка');
    INSERT INTO memory_revisions(id,record_type,entity_id,version,reason,actor_kind,before_json,after_json,created_at)
      VALUES ('revision','entity','note',2,'Правка','user','{}','{}','2026-10-13');
  `);
  if (withChats) {
    // PR #28 also shipped schema version 1, but new installations had this table.
    legacy.exec("CREATE TABLE direct_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
    const saved = { id: "old-chat", title: "Существующий диалог", createdAt: "2026-10-13", updatedAt: "2026-10-13", rows: [{ id: "a", role: "assistant", text: "Сохранённый ответ" }], drafts: [], question: "Черновик" };
    legacy.prepare("INSERT INTO direct_conversations VALUES (?,?,?,?,?)").run(saved.id, saved.title, JSON.stringify(saved), saved.createdAt, saved.updatedAt);
  }
  legacy.close();
  mockVault.set(identity.keyName, "6".repeat(64));
  mockVault.set(identity.keyName + ".initialized", "yes");
  return identity;
}

test.each([false, true])("upgrading an installed v1 database (chats=%s) opens a usable chat and preserves notes, FTS, revisions and the key", async withChats => {
  const identity = await installationV1(withChats);
  // Use production storage, repository and chat owner, with only the native bridge replaced.
  const store = new DirectChatStore("guest");
  await store.initialize();
  expect(store.getSnapshot()).toMatchObject({ ready: true, error: "" });
  expect(store.getSnapshot().conversations).toHaveLength(1);
  if (withChats) expect(store.getSnapshot().conversations[0]).toMatchObject({ id: "old-chat", question: "Черновик", rows: [{ text: "Сохранённый ответ" }] });
  store.create(); store.setQuestion("Можно ввести сообщение"); await store.checkpoint();
  store.dispose();
  const repo = await localMemoryRepository("guest");
  expect((await repo.searchNotes("паприка"))[0]).toMatchObject({ id: "note", record_version: 2 });
  expect(await repo.revisions("entity", "note")).toHaveLength(1);
  expect(await repo.listCollections()).toMatchObject([{ id: "recipes", name: "Рецепты" }]);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
  expect(mockConnections[0].sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
  await closeLocalMemory();
  const reopened = conversationRepository("guest");
  expect((await reopened.load()).find(c => c.question === "Можно ввести сообщение")).toBeTruthy();
  expect(mockConnections).toHaveLength(2);
});

test("an interrupted upgrade rolls back its version and can be retried without replacing the existing key or data", async () => {
  const identity = await installationV1(); mockMigrationFailure = true;
  await expect(openLocalMemory("guest")).rejects.toThrow("simulated_disk_full");
  expect(mockConnections[0].closeAsync).toHaveBeenCalledTimes(1);
  const existing = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  expect(existing.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
  expect(existing.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='direct_conversations'").get()).toMatchObject({ n: 0 });
  expect(existing.prepare("SELECT payload_json FROM memory_entities WHERE id='note'").get().payload_json).toContain("паприка");
  existing.close(); mockMigrationFailure = false;
  expect(await conversationRepository("guest").load()).toEqual([]);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
});
