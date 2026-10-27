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
let mockIndexFailure = false;
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
  mockVault.clear(); mockConnections.length = 0; mockMigrationFailure = false; mockIndexFailure = false;
  (SQLite.openDatabaseAsync as jest.Mock).mockImplementation(async (name: string) => {
    const sqlite = new DatabaseSync(path.join(mockDirectory, name));
    const connection = {
      sqlite,
      getFirstAsync: async (sql: string, params: unknown[] = []) => sql === "PRAGMA cipher_version"
        ? { cipher_version: "bridge-fixture" } : sqlite.prepare(sql).get(...params) ?? null,
      getAllAsync: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params),
      runAsync: async (sql: string, params: unknown[] = []) => {
        if (mockIndexFailure && sql.startsWith("INSERT INTO memory_search_fts")) throw new Error("simulated_index_failure");
        return sqlite.prepare(sql).run(...params);
      },
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
  expect(mockConnections[0].sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 10 });
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

const LONG_BODY = [
  "Летом ездили на дачу к родителям, собирали малину и смородину.",
  "Осенью перекрасили забор: зелёная краска, две банки.",
  "Ключи от гаража лежат у соседа Петра в синей коробке.",
].map(p => p + " " + "Подробности поездки и погоды. ".repeat(14)).join("\n\n");

async function installationV2() {
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  legacy.exec(fs.readFileSync(path.join(__dirname, "fixtures/v2-memory.sql"), "utf8"));
  const note = (id: string, collection: string, title: string, body: string) => {
    legacy.prepare(`INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,sensitivity,created_at,updated_at)
      VALUES (?,?,'notes',?,?,'standard','2026-10-14','2026-10-14')`).run(id, collection, title, JSON.stringify({ type: "note", title, body }));
    legacy.prepare("INSERT INTO memory_notes_fts VALUES (?,?,?)").run(id, title, body);
  };
  legacy.exec(`INSERT INTO memory_collections VALUES ('people','Люди','people',NULL,'standard','2026-10-14');
    INSERT INTO memory_collections VALUES ('notes','Заметки','notes',NULL,'standard','2026-10-14');`);
  note("masha", "people", "Маша", "Племянница, 7 лет, любит рисовать");
  note("dacha", "notes", "Дача", LONG_BODY);
  legacy.prepare("INSERT INTO direct_conversations VALUES (?,?,?,?,?)").run("chat", "Диалог", JSON.stringify({ id: "chat", title: "Диалог", createdAt: "2026-10-14", updatedAt: "2026-10-14", rows: [], drafts: [], question: "" }), "2026-10-14", "2026-10-14");
  legacy.close();
  mockVault.set(identity.keyName, "7".repeat(64));
  mockVault.set(identity.keyName + ".initialized", "yes");
  return identity;
}

test("upgrading v2 to v3 types the records, splits long text into chunks and searches through one index", async () => {
  await installationV2();
  const repo = await localMemoryRepository("guest");
  const db = mockConnections[0].sqlite;
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 10 });
  expect(await repo.entity("masha")).toMatchObject({ kind: "person", title: "Маша", record_version: 1 });
  expect(await repo.entity("dacha")).toMatchObject({ kind: "note" });
  expect(db.prepare("SELECT count(*) AS n FROM memory_chunks WHERE entity_id='dacha'").get().n).toBeGreaterThan(1);
  expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='memory_notes_fts'").get()).toMatchObject({ n: 0 });
  // Every record kept, and it is found by another word form and by «ё» written as «е».
  expect((await repo.searchNotes("племянница"))[0].id).toBe("masha");
  expect((await repo.searchNotes("зеленая"))[0].id).toBe("dacha");
  const [hit] = await repo.searchMemory("Где ключи от гаража?");
  expect(hit.entity.id).toBe("dacha");
  expect(hit.chunk).toContain("Ключи от гаража");
  expect(hit.chunk).not.toContain("малину");
  expect(await conversationRepository("guest").load()).toHaveLength(1);
});

test("a failure while building the v3 index rolls back to an intact v2 database, and the next start upgrades", async () => {
  const identity = await installationV2(); mockIndexFailure = true;
  await expect(openLocalMemory("guest")).rejects.toThrow("simulated_index_failure");
  const existing = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  expect(existing.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
  expect(existing.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('memory_chunks','memory_search_fts')").get()).toMatchObject({ n: 0 });
  expect(existing.prepare("SELECT count(*) AS n FROM pragma_table_info('memory_entities') WHERE name='kind'").get()).toMatchObject({ n: 0 });
  expect(existing.prepare("SELECT count(*) AS n FROM memory_notes_fts WHERE memory_notes_fts MATCH 'малину'").get()).toMatchObject({ n: 1 });
  existing.close(); mockIndexFailure = false;
  const repo = await localMemoryRepository("guest");
  expect((await repo.searchNotes("малину"))[0].id).toBe("dacha");
  expect(mockVault.get(identity.keyName)).toBe("7".repeat(64));
});

test("v4 attachments upgrade keeps every byte and allows merging two originals", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  legacy.exec(SCHEMA_SQL.replace("created_at TEXT NOT NULL\n);\nCREATE TABLE IF NOT EXISTS memory_attachment_parts", "created_at TEXT NOT NULL, UNIQUE(entity_id)\n);\nCREATE TABLE IF NOT EXISTS memory_attachment_parts"));
  legacy.exec("PRAGMA user_version=4");
  legacy.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?,?)").run("c", "Notes", "notes", "standard", "now");
  legacy.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("n", "c", "notes", JSON.stringify({ body: "Подпись", extracted_text: "Распознанная гарантия" }), "now", "now");
  legacy.prepare("INSERT INTO memory_attachments VALUES (?,?,?,?,?,?)").run("a", "n", "a.png", "image/png", 3, "now");
  legacy.prepare("INSERT INTO memory_attachment_parts VALUES (?,?,?,?)").run("a", 0, new Uint8Array([1,2,3]), "hash");
  legacy.close(); mockVault.set(identity.keyName, "6".repeat(64)); mockVault.set(identity.keyName + ".initialized", "yes");
  await openLocalMemory("guest");
  const db = mockConnections[0].sqlite;
  expect(Array.from(db.prepare("SELECT bytes FROM memory_attachment_parts").get().bytes)).toEqual([1,2,3]);
  db.prepare("INSERT INTO memory_attachments VALUES (?,?,?,?,?,?)").run("b", "n", "b.png", "image/png", 3, "now");
  expect(db.prepare("SELECT count(*) AS n FROM memory_attachments").get().n).toBe(2);
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(10);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const repo = await localMemoryRepository("guest");
  expect((await repo.searchMemory("гарантия"))[0].entity.id).toBe("n");
  expect((await repo.pendingVectorChunks("test"))[0].text).toContain("Распознанная гарантия");
});

test.each([false, true])("v5 enrichment migration (retry=%s) preserves data/key and invalidates unversioned model words", async failFirst => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  legacy.exec(SCHEMA_SQL.replace("  source_record_version INTEGER, source_collection_name TEXT,\n", ""));
  legacy.exec(`PRAGMA user_version=5;
    INSERT INTO memory_collections VALUES ('c','Заметки','notes',NULL,'standard','now');
    INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES ('n','c','notes','{"body":"Исходный текст"}','now','now');
    INSERT INTO memory_index_terms VALUES ('n','ручное','user','2099'), ('n','устаревшее','model:auto','2099');
    INSERT INTO memory_attachments VALUES ('a','n','a.txt','text/plain',3,'now');
    INSERT INTO memory_attachment_parts VALUES ('a',0,X'010203','hash');`);
  legacy.close(); mockVault.set(identity.keyName, "6".repeat(64)); mockVault.set(identity.keyName + ".initialized", "yes");
  if (failFirst) {
    mockIndexFailure = true;
    await expect(openLocalMemory("guest")).rejects.toThrow("simulated_index_failure");
    const unchanged = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
    expect(unchanged.prepare("PRAGMA user_version").get().user_version).toBe(5);
    expect(unchanged.prepare("PRAGMA table_info(memory_index_terms)").all().map((c: any) => c.name)).not.toContain("source_record_version");
    unchanged.close(); mockIndexFailure = false;
  }
  const repo = await localMemoryRepository("guest");
  expect((await repo.searchNotes("Исходный"))[0].id).toBe("n");
  expect((await repo.searchNotes("ручное"))[0].id).toBe("n");
  expect(await repo.searchNotes("устаревшее")).toEqual([]);
  expect(await repo.staleIndexTerms("model:auto")).toEqual(["n"]);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
  expect(Array.from(mockConnections.at(-1).sqlite.prepare("SELECT bytes FROM memory_attachment_parts").get().bytes)).toEqual([1,2,3]);
});

test("v6 to v8 adds isolated hygiene and derived job tables without changing originals", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  // A real v6 installation has no hygiene table. Keep every other v6 table.
  legacy.exec(SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS memory_cleanup_preferences \([\s\S]*?\);\n/, ""));
  legacy.exec(`PRAGMA user_version=6;
    INSERT INTO memory_collections(id,name,slug,sensitivity,created_at)
      VALUES ('c','Заметки','notes','standard','now');
    INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at)
      VALUES ('e','c','notes','{"body":"Не терять"}','now','now');`);
  legacy.close();
  mockVault.set(identity.keyName, "6".repeat(64));
  mockVault.set(identity.keyName + ".initialized", "yes");
  const repo = await localMemoryRepository("guest");
  const db = mockConnections[0].sqlite;
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(10);
  expect(db.prepare("SELECT count(*) AS n FROM memory_cleanup_preferences").get().n).toBe(0);
  expect((await repo.entity("e"))?.payload.body).toBe("Не терять");
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
  const violation = db.prepare("PRAGMA foreign_key_check").all();
  expect(violation).toEqual([]);
});

test("installed v7 SQLCipher migrates to v8 without touching notes, index rows or key", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  const oldSchema = SCHEMA_SQL.replace(
    /CREATE TABLE IF NOT EXISTS memory_vector_models \([\s\S]*?CREATE INDEX IF NOT EXISTS ix_memory_vector_jobs_ready[\s\S]*?;\n/, "");
  expect(oldSchema).not.toContain("CREATE TABLE IF NOT EXISTS memory_vector_models");
  legacy.exec(oldSchema);
  legacy.exec(`PRAGMA user_version=7;
    INSERT INTO memory_collections(id,name,slug,sensitivity,created_at)
      VALUES ('c','История','notes','standard','now');
    INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,created_at,updated_at)
      VALUES ('e','c','notes','Лиза','{"body":"Сохранённый разговор"}','now','now');
    INSERT INTO memory_chunks(id,entity_id,ord,text,content_hash,created_at)
      VALUES ('e:0','e',0,'Сохранённый разговор','old-hash','now');
    INSERT INTO memory_search_fts(entity_id,chunk_id,title,body,terms,aliases)
      VALUES ('e','e:0','Лиза','Сохранённый разговор','','');`);
  legacy.close();
  mockVault.set(identity.keyName, "6".repeat(64));
  mockVault.set(identity.keyName + ".initialized", "yes");
  const repo = await localMemoryRepository("guest");
  const db = mockConnections[0].sqlite;
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(10);
  expect((await repo.entity("e"))?.payload.body).toBe("Сохранённый разговор");
  expect(db.prepare("SELECT count(*) AS n FROM memory_chunks").get().n).toBe(1);
  expect(db.prepare("SELECT count(*) AS n FROM memory_search_fts").get().n).toBe(1);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
  const jobs = await repo.claimVectorJobs("toy", 2);
  expect(jobs).toHaveLength(1);
  expect(jobs[0].text).toContain("Сохранённый разговор");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("real installed v8 database adds v9 evidence without touching ciphertext key, FTS or originals", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  const schemaV8 = SCHEMA_SQL.replace(
    /-- Source\/extraction records are USER DATA:[\s\S]*?CREATE TABLE IF NOT EXISTS memory_received_shares \(/,
    "CREATE TABLE IF NOT EXISTS memory_received_shares (");
  expect(schemaV8).not.toContain("memory_extractions");
  legacy.exec(schemaV8);
  legacy.exec(`PRAGMA user_version=8;
    INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('c','Документы','documents','sensitive','now');
    INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,created_at,updated_at)
      VALUES ('e','c','notes','Важный оригинал','{"body":"Мой текст"}','now','now');
    INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at)
      VALUES ('a','e','a.pdf','application/pdf',3,'now');
    INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256)
      VALUES ('a',0,X'010203','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');`);
  legacy.close();
  mockVault.set(identity.keyName,"6".repeat(64));
  mockVault.set(identity.keyName+".initialized","yes");
  const repo=await localMemoryRepository("guest");
  const db=mockConnections[0].sqlite;
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(10);
  expect((await repo.entity("e"))?.payload.body).toBe("Мой текст");
  expect(Array.from(db.prepare("SELECT bytes FROM memory_attachment_parts").get().bytes)).toEqual([1,2,3]);
  expect(db.prepare("SELECT count(*) AS n FROM memory_extractions").get().n).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
});

test("real installed v9 extraction evidence upgrades to v10 FTS without changing originals", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  const schemaV9 = SCHEMA_SQL.replace(
    /-- Derived encrypted FTS5:[\s\S]*?CREATE TABLE IF NOT EXISTS memory_received_shares \(/,
    "CREATE TABLE IF NOT EXISTS memory_received_shares (");
  expect(schemaV9).not.toContain("tr_extraction_fts_insert");
  legacy.exec(schemaV9);
  legacy.exec(`PRAGMA user_version=9;
    INSERT INTO memory_collections(id,name,slug,sensitivity,created_at)
      VALUES ('c','Личное','notes','standard','now');
    INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,created_at,updated_at)
      VALUES ('e','c','notes','Важная запись','{"body":"Мой оригинал"}','now','now');
    INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at)
      VALUES ('a','e','audio.wav','audio/wav',3,'now');
    INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256)
      VALUES ('a',0,X'010203','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    INSERT INTO memory_extractions(id,attachment_id,source_version,producer_kind,producer_id,
      producer_revision,coverage,status,created_at)
      VALUES ('r','a','v1','asr','whisper','rev1','partial','partial','now');
    INSERT INTO memory_extraction_segments(id,extraction_id,ord,text,location_kind)
      VALUES ('s','r',0,'Осенний фестиваль','unknown');`);
  legacy.close();
  mockVault.set(identity.keyName,"6".repeat(64));
  mockVault.set(identity.keyName+".initialized","yes");
  const db=(await localMemoryRepository("guest"),mockConnections[0].sqlite);
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(10);
  expect(db.prepare("SELECT count(*) AS n FROM memory_extraction_segments").get().n).toBe(1);
  expect(db.prepare("SELECT segment_id FROM memory_extraction_fts WHERE memory_extraction_fts MATCH ?").get('"фестиваль"').segment_id).toBe("s");
  expect(Array.from(db.prepare("SELECT bytes FROM memory_attachment_parts").get().bytes)).toEqual([1,2,3]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
});
