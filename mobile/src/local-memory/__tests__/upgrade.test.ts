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
let mockTemporalMigrationFailure = false;
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
  mockVault.clear(); mockConnections.length = 0; mockMigrationFailure = false; mockIndexFailure = false; mockTemporalMigrationFailure = false;
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
        if (mockTemporalMigrationFailure && sql.includes("CREATE TABLE IF NOT EXISTS memory_temporal_claims")) throw new Error("simulated_temporal_disk_full");
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
  expect(mockConnections[0].sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 14 });
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
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 14 });
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
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
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
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
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
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
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
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
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
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
  expect(db.prepare("SELECT count(*) AS n FROM memory_extraction_segments").get().n).toBe(1);
  expect(db.prepare("SELECT segment_id FROM memory_extraction_fts WHERE memory_extraction_fts MATCH ?").get('"фестиваль"').segment_id).toBe("s");
  expect(Array.from(db.prepare("SELECT bytes FROM memory_attachment_parts").get().bytes)).toEqual([1,2,3]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(mockVault.get(identity.keyName)).toBe("6".repeat(64));
});


test("v10 to v11 stores candidate, evidence, and non-applying state review transactionally", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const { stageTemporalCandidate, stageTemporalReviewProposal } = require("../temporal-store");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  const oldSchema = SCHEMA_SQL.replace(
    /-- Temporal claim candidates[\s\S]*?CREATE TABLE IF NOT EXISTS memory_cleanup_preferences \(/,
    "CREATE TABLE IF NOT EXISTS memory_cleanup_preferences (");
  expect(oldSchema).not.toContain("CREATE TABLE IF NOT EXISTS memory_temporal_claims");
  legacy.exec(oldSchema);
  legacy.exec("PRAGMA user_version=10");
  legacy.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?,?)")
    .run("people","Люди","people","standard","now");
  for (const [id, value] of [["a","Работаю в А"],["b","Работаю в Б"]]) {
    legacy.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,?,'notes',?,'now','now')")
      .run(id,"people",JSON.stringify({body:value}));
  }
  legacy.close();
  mockVault.set(identity.keyName,"6".repeat(64));
  mockVault.set(identity.keyName+".initialized","yes");
  await openLocalMemory("guest");
  const db = mockConnections[0].sqlite;
  const bridge = mockConnections[0];
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
  const make = (entityId: string, value: string, kind: "state" | "event" = "state"): import("../temporal-claims").TemporalClaimCandidate => ({
    recordedAt: "2026-10-27T12:00:00.000Z", subjectId: "person-1",
    predicate: "employment", context: "primary", value, kind,
    modality: "asserted", negated: false, cardinality: "single",
    occurredOrStarted: null, ended: null, endConfirmed: false,
    evidence: {entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},
  });
  const firstId = await stageTemporalCandidate(bridge,make("a","А"));
  const secondId = await stageTemporalCandidate(bridge,make("b","Б"));
  const proposal = await stageTemporalReviewProposal(bridge,firstId,secondId);
  expect(proposal).toBeTruthy();
  expect(await stageTemporalReviewProposal(bridge,firstId,secondId)).toBe(proposal);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_claims").get().n).toBe(2);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_evidence").get().n).toBe(2);
  expect(db.prepare("SELECT review_kind,status FROM memory_temporal_proposals").get())
    .toMatchObject({review_kind:"possible_change",status:"pending"});
  // T1b must never close an older state or mark a proposed transition approved.
  expect(db.prepare("SELECT end_confirmed,ended_json FROM memory_temporal_claims WHERE id=?").get(firstId))
    .toMatchObject({end_confirmed:0,ended_json:null});
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_decisions").get().n).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // Old events coexist regardless of arrival order.
  const event1=await stageTemporalCandidate(bridge,make("a","А","event"));
  const event2=await stageTemporalCandidate(bridge,make("b","Б","event"));
  expect(await stageTemporalReviewProposal(bridge,event1,event2)).toBeNull();
  // No stale source revision can be trusted for a new suggestion.
  db.prepare("UPDATE memory_entities SET record_version=2 WHERE id='a'").run();
  expect(await stageTemporalReviewProposal(bridge,firstId,secondId)).toBeNull();
  await expect(stageTemporalCandidate(bridge,make("a","А")))
    .rejects.toThrow("temporal_source_stale");
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_claims").get().n).toBe(4);
});

test("v10 temporal schema disk-full failure rolls back and preserves every old byte", async () => {
  const { SCHEMA_SQL } = require("../storage");
  const identity = await localMemoryIdentity("guest");
  const legacy = new DatabaseSync(path.join(mockDirectory, identity.databaseName));
  const oldSchema = SCHEMA_SQL.replace(
    /-- Temporal claim candidates[\s\S]*?CREATE TABLE IF NOT EXISTS memory_cleanup_preferences \(/,
    "CREATE TABLE IF NOT EXISTS memory_cleanup_preferences (");
  legacy.exec(oldSchema);
  legacy.exec("PRAGMA user_version=10");
  legacy.exec("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('c','Old','old','standard','now')");
  legacy.exec("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES ('e','c','notes','{\"body\":\"Never erase\"}','now','now')");
  legacy.close();
  mockVault.set(identity.keyName,"6".repeat(64));
  mockVault.set(identity.keyName+".initialized","yes");
  mockTemporalMigrationFailure = true;
  await expect(openLocalMemory("guest")).rejects.toThrow("simulated_temporal_disk_full");
  const check = new DatabaseSync(path.join(mockDirectory,identity.databaseName));
  expect(check.prepare("PRAGMA user_version").get().user_version).toBe(10);
  expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='memory_temporal_claims'").get().n).toBe(0);
  expect(check.prepare("SELECT payload_json FROM memory_entities WHERE id='e'").get().payload_json).toContain("Never erase");
  check.close();
  mockTemporalMigrationFailure = false;
  await openLocalMemory("guest");
  expect(mockConnections.at(-1).sqlite.prepare("PRAGMA user_version").get().user_version).toBe(14);
});


test("T2a user confirms a state ended with unknown date and undoes without erasing history", async () => {
  const { stageTemporalCandidate, stageTemporalReviewProposal } = require("../temporal-store");
  const { decideTemporalReview, undoTemporalReview } = require("../temporal-decisions");
  await openLocalMemory("guest");
  const bridge = mockConnections[0], db = bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('people','Люди','people','standard','now')").run();
  for (const id of ["a","b"]) {
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'people','notes','{}','now','now')").run(id);
  }
  const make = (entityId: string, value: string): import("../temporal-claims").TemporalClaimCandidate => ({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"employment",context:"primary",value,kind:"state",modality:"asserted",
    negated:false,cardinality:"single",occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},
  });
  const firstId=await stageTemporalCandidate(bridge,make("a","А"));
  const secondId=await stageTemporalCandidate(bridge,make("b","Б"));
  const proposalId=await stageTemporalReviewProposal(bridge,firstId,secondId);
  expect(proposalId).not.toBeNull();
  const requested = {proposalId:proposalId!,expectedProposalVersion:1,
    expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1};
  const unknown={normalized:null,precision:"unknown" as const,
    raw:"Пользователь подтвердил: больше не работаю в А",anchorDate:null,sourceTimeZone:null};
  await expect(decideTemporalReview(bridge,{...requested,choice:"accept"}))
    .rejects.toThrow("temporal_user_end_required");
  const applied=await decideTemporalReview(bridge,{...requested,choice:"accept",confirmedEnd:unknown});
  expect(applied.nextProposalVersion).toBe(2);
  expect(db.prepare("SELECT status,proposal_version FROM memory_temporal_proposals WHERE id=?").get(proposalId))
    .toMatchObject({status:"applied",proposal_version:2});
  const ended=db.prepare("SELECT end_confirmed,ended_json,claim_version FROM memory_temporal_claims WHERE id=?").get(firstId);
  expect(ended.end_confirmed).toBe(1);
  expect(ended.claim_version).toBe(2);
  expect(JSON.parse(ended.ended_json)).toEqual(unknown);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_decisions").get().n).toBe(1);
  // Stale UI cannot overwrite an already reviewed proposal.
  await expect(decideTemporalReview(bridge,{...requested,choice:"defer"}))
    .rejects.toThrow("temporal_proposal_stale");
  const undone=await undoTemporalReview(bridge,{
    proposalId:proposalId!,decisionId:applied.decisionId,
    expectedProposalVersion:2,expectedPreviousClaimVersion:2,expectedIncomingClaimVersion:1,
  });
  expect(undone.nextProposalVersion).toBe(3);
  expect(db.prepare("SELECT end_confirmed,ended_json,claim_version FROM memory_temporal_claims WHERE id=?").get(firstId))
    .toMatchObject({end_confirmed:0,ended_json:null,claim_version:3});
  expect(db.prepare("SELECT status,previous_version FROM memory_temporal_proposals WHERE id=?").get(proposalId))
    .toMatchObject({status:"pending",previous_version:3});
  expect(db.prepare("SELECT action FROM memory_temporal_decisions ORDER BY rowid").all())
    .toEqual([{action:"accept"},{action:"undo"}]);
  await expect(undoTemporalReview(bridge,{
    proposalId:proposalId!,decisionId:applied.decisionId,
    expectedProposalVersion:3,expectedPreviousClaimVersion:3,expectedIncomingClaimVersion:1,
  })).rejects.toThrow("temporal_undo_stale");
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("T2a keep both/dismissal does not close a state or repeatedly reopen the proposal", async () => {
  const { stageTemporalCandidate, stageTemporalReviewProposal } = require("../temporal-store");
  const { decideTemporalReview, undoTemporalReview } = require("../temporal-decisions");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('c','Работа','work','standard','now')").run();
  for (const id of ["a","b"]) db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'c','notes','{}','now','now')").run(id);
  const make=(entityId:string,value:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"employment",context:"primary",value,kind:"state",modality:"asserted",
    negated:false,cardinality:"single",occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Текст "+value,origin:"direct"},
  });
  const a=await stageTemporalCandidate(bridge,make("a","А"));
  const b=await stageTemporalCandidate(bridge,make("b","Б"));
  const id=(await stageTemporalReviewProposal(bridge,a,b))!;
  const expected={proposalId:id,expectedProposalVersion:1,expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1};
  const result=await decideTemporalReview(bridge,{...expected,choice:"keep_both"});
  expect(db.prepare("SELECT status FROM memory_temporal_proposals WHERE id=?").get(id).status).toBe("dismissed");
  expect(db.prepare("SELECT end_confirmed FROM memory_temporal_claims WHERE id=?").get(a).end_confirmed).toBe(0);
  expect(await stageTemporalReviewProposal(bridge,a,b)).toBe(id);
  expect(db.prepare("SELECT status FROM memory_temporal_proposals WHERE id=?").get(id).status).toBe("dismissed");
  await undoTemporalReview(bridge,{proposalId:id,decisionId:result.decisionId,
    expectedProposalVersion:2,expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1});
  expect(db.prepare("SELECT status FROM memory_temporal_proposals WHERE id=?").get(id).status).toBe("pending");
});

test("T2a rollback on decision journal disk-full and reject stale/invalid source dates", async () => {
  const { stageTemporalCandidate, stageTemporalReviewProposal } = require("../temporal-store");
  const { decideTemporalReview } = require("../temporal-decisions");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('c','Работа','work','standard','now')").run();
  for (const id of ["a","b"]) db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'c','notes','{}','now','now')").run(id);
  const date={normalized:"2022-01-01",precision:"day" as const,raw:"1 января 2022",
    anchorDate:null,sourceTimeZone:null};
  const make=(entityId:string,value:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"employment",context:"primary",value,kind:"state",modality:"asserted",
    negated:false,cardinality:"single",occurredOrStarted:date,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Текст "+value,origin:"direct"},
  });
  const a=await stageTemporalCandidate(bridge,make("a","А"));
  const b=await stageTemporalCandidate(bridge,make("b","Б"));
  const id=(await stageTemporalReviewProposal(bridge,a,b))!;
  const expected={proposalId:id,expectedProposalVersion:1,expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1};
  const end={normalized:"2021-01-01",precision:"day" as const,
    raw:"1 января 2021",anchorDate:null,sourceTimeZone:null};
  await expect(decideTemporalReview(bridge,{...expected,choice:"accept",confirmedEnd:end}))
    .rejects.toThrow("temporal_end_before_start");
  await expect(decideTemporalReview(bridge,{...expected,choice:"accept",
    confirmedEnd:{normalized:"2021",precision:"year",raw:"В 2021 году",
      anchorDate:null,sourceTimeZone:null}}))
    .rejects.toThrow("temporal_end_before_start");
  const before=bridge.runAsync;
  bridge.runAsync=async (sql:string, params:unknown[]=[])=>{
    if (sql.startsWith("INSERT INTO memory_temporal_decisions")) throw new Error("disk_full_journal");
    return before(sql,params);
  };
  await expect(decideTemporalReview(bridge,{...expected,choice:"accept",
    confirmedEnd:{...end,normalized:"2024-01-01",raw:"1 января 2024"}}))
    .rejects.toThrow("disk_full_journal");
  bridge.runAsync=before;
  expect(db.prepare("SELECT claim_version,end_confirmed FROM memory_temporal_claims WHERE id=?").get(a))
    .toMatchObject({claim_version:1,end_confirmed:0});
  expect(db.prepare("SELECT status,proposal_version FROM memory_temporal_proposals WHERE id=?").get(id))
    .toMatchObject({status:"pending",proposal_version:1});
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_decisions").get().n).toBe(0);
  db.prepare("UPDATE memory_entities SET record_version=2 WHERE id='a'").run();
  await expect(decideTemporalReview(bridge,{...expected,choice:"defer"}))
    .rejects.toThrow("temporal_review_not_available");
});


test("T2b atomically stages typed state and bounded same-scope review, never closes old state", async () => {
  const { stageTemporalCandidate, stageTemporalCandidateWithReview } = require("../temporal-store");
  await openLocalMemory("guest");
  const bridge=mockConnections[0], db=bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('people','Люди','people','standard','now')").run();
  for (const id of ["old","new","event"]) {
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'people','notes','{}','now','now')").run(id);
  }
  const make=(entityId:string,value:string,kind:"state"|"event"="state"):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",predicate:"employment",
    context:"primary",value,kind,modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Я работаю в "+value,origin:"direct"},
  });
  const a=await stageTemporalCandidate(bridge,make("old","А"));
  const event=await stageTemporalCandidate(bridge,make("event","Техническая проверка","event"));
  const staged=await stageTemporalCandidateWithReview(bridge,make("new","Б"));
  expect(staged.reviewScope).toBe("standard");
  expect(staged.truncated).toBe(false);
  expect(staged.proposalIds).toHaveLength(1);
  expect(db.prepare("SELECT previous_claim_id,incoming_claim_id,review_kind,status FROM memory_temporal_proposals").get())
    .toMatchObject({previous_claim_id:a,incoming_claim_id:staged.claimId,
      review_kind:"possible_change",status:"pending"});
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_evidence").get().n).toBe(3);
  expect(db.prepare("SELECT end_confirmed,ended_json FROM memory_temporal_claims WHERE id=?").get(a))
    .toMatchObject({end_confirmed:0,ended_json:null});
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_proposals WHERE previous_claim_id=?").get(event).n).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_decisions").get().n).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("T2b never scans unclassified or cross-collection evidence; event input has no state review", async () => {
  const { stageTemporalCandidate, stageTemporalCandidateWithReview } = require("../temporal-store");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  for (const [id,sensitivity] of [["standard","standard"],["other","standard"],["private","private"],["unknown","unclassified"]]) {
    db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?, 'now')").run(id,id,id,sensitivity);
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (? ,?,'notes','{}','now','now')").run(id,id);
  }
  const make=(entityId:string,value:string,kind:"state"|"event"="state"):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",predicate:"employment",
    context:"primary",value,kind,modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},
  });
  await stageTemporalCandidate(bridge,make("other","А"));
  await stageTemporalCandidate(bridge,make("private","Секрет"));
  await stageTemporalCandidate(bridge,make("unknown","Неизвестно"));
  const result=await stageTemporalCandidateWithReview(bridge,make("standard","Б"));
  expect(result).toMatchObject({proposalIds:[],reviewScope:"standard",truncated:false});
  const hidden=await stageTemporalCandidateWithReview(bridge,make("private","В"));
  expect(hidden).toMatchObject({proposalIds:[],reviewScope:"skipped_privacy"});
  const unclassified=await stageTemporalCandidateWithReview(bridge,make("unknown","Г"));
  expect(unclassified).toMatchObject({proposalIds:[],reviewScope:"skipped_privacy"});
  const event=await stageTemporalCandidateWithReview(bridge,make("standard","Замена свечей","event"));
  expect(event).toMatchObject({proposalIds:[],reviewScope:"not_eligible"});
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_proposals").get().n).toBe(0);
});

test("T2b rolls back claim+evidence when proposal write fails or source revision changes", async () => {
  const { stageTemporalCandidate, stageTemporalCandidateWithReview } = require("../temporal-store");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('p','Люди','p','standard','now')").run();
  for (const id of ["old","new"]) db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'p','notes','{}','now','now')").run(id);
  const make=(entityId:string,value:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",predicate:"employment",
    context:"primary",value,kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},
  });
  await stageTemporalCandidate(bridge,make("old","А"));
  const previous=bridge.runAsync;
  bridge.runAsync=async(sql:string,params:unknown[]=[])=>{
    if (sql.startsWith("INSERT INTO memory_temporal_proposals")) throw new Error("simulated_proposal_disk_full");
    return previous(sql,params);
  };
  await expect(stageTemporalCandidateWithReview(bridge,make("new","Б")))
    .rejects.toThrow("simulated_proposal_disk_full");
  bridge.runAsync=previous;
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_claims").get().n).toBe(1);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_evidence").get().n).toBe(1);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_proposals").get().n).toBe(0);
  db.prepare("UPDATE memory_entities SET record_version=2 WHERE id='new'").run();
  await expect(stageTemporalCandidateWithReview(bridge,make("new","Б")))
    .rejects.toThrow("temporal_source_stale");
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_claims").get().n).toBe(1);
});

test("T2b review scan is capped at 32 and reports incomplete history", async () => {
  const { stageTemporalCandidate, stageTemporalCandidateWithReview } = require("../temporal-store");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('p','Люди','p','standard','now')").run();
  for (const id of ["old","new"]) db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'p','notes','{}','now','now')").run(id);
  const make=(entityId:string,value:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",predicate:"employment",
    context:"primary",value,kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},
  });
  for(let i=0;i<33;i++) await stageTemporalCandidate(bridge,make("old","Предыдущая "+i));
  const staged=await stageTemporalCandidateWithReview(bridge,make("new","Следующая"));
  expect(staged).toMatchObject({reviewScope:"standard",truncated:true});
  expect(staged.proposalIds).toHaveLength(32);
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_proposals").get().n).toBe(32);
});


test("T3a knowledge history paginates source-current claims, retaining original occurrence dates", async () => {
  const { stageTemporalCandidate, listTemporalKnowledgeHistory } = require("../temporal-store");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('people','Люди','people','standard','now')").run();
  for (const id of ["a","b","c","d"]) {
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'people','notes','{}','now','now')").run(id);
  }
  const bound={normalized:"2024",precision:"year" as const,raw:"в 2024 году",
    anchorDate:null,sourceTimeZone:null};
  const make=(entityId:string,kind:"state"|"event",day:number):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-"+String(day).padStart(2,"0")+"T12:00:00.000Z",
    subjectId:"person-1",predicate:kind==="state"?"employment":"repair",
    context:kind==="state"?"primary":"spark-plugs",
    value:entityId,kind,modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:bound,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Источник "+entityId,origin:"direct"},
  });
  const a=await stageTemporalCandidate(bridge,make("a","event",20));
  const b=await stageTemporalCandidate(bridge,make("b","state",21));
  const c=await stageTemporalCandidate(bridge,make("c","event",22));
  const d=await stageTemporalCandidate(bridge,make("d","state",23));
  const input={subjectId:"person-1",collectionId:"people",mode:"all" as const,limit:2};
  const first=await listTemporalKnowledgeHistory(bridge,input);
  expect(first.items.map((x:{claimId:string})=>x.claimId)).toEqual([d,c]);
  expect(first.items.map((x:{verification:string})=>x.verification)).toEqual([
    "candidate_unconfirmed","candidate_unconfirmed",
  ]);
  expect(first.items[0].claim.occurredOrStarted).toEqual(bound);
  expect(first.items[0].claim.evidence).toMatchObject({
    entityId:"d",recordVersion:1,quote:"Источник d",origin:"direct",
  });
  const second=await listTemporalKnowledgeHistory(bridge,{...input,before:first.nextCursor!});
  expect(second.items.map((x:{claimId:string})=>x.claimId)).toEqual([b,a]);
  expect(second.nextCursor).toBeNull();
  const events=await listTemporalKnowledgeHistory(bridge,{...input,mode:"events"});
  expect(events.items.map((x:{claimId:string})=>x.claimId)).toEqual([c,a]);
  const states=await listTemporalKnowledgeHistory(bridge,{...input,mode:"states"});
  expect(states.items.map((x:{claimId:string})=>x.claimId)).toEqual([d,b]);
  // A newly edited source can no longer testify to the old text.
  db.prepare("UPDATE memory_entities SET record_version=2 WHERE id='d'").run();
  const current=await listTemporalKnowledgeHistory(bridge,input);
  expect(current.items.map((x:{claimId:string})=>x.claimId)).toEqual([c,b]);
});

test("T3a history never leaks through collection/record sensitivity or metadata-only count", async () => {
  const { stageTemporalCandidate, listTemporalKnowledgeHistory } = require("../temporal-store");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  for(const [id,sensitivity] of [["visible","standard"],["hidden","private"],["unknown","unclassified"]]) {
    db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?, 'now')").run(id,id,id,sensitivity);
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,?,'notes','{}','now','now')").run(id,id);
  }
  db.prepare("INSERT INTO memory_entities(id,collection_id,domain,sensitivity,payload_json,created_at,updated_at) VALUES ('secret-record','visible','notes','secret','{}','now','now')").run();
  const make=(entityId:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"residence",context:"actual",value:"Private residence",
    kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Do not leak "+entityId,origin:"direct"},
  });
  const visibleId=await stageTemporalCandidate(bridge,make("visible"));
  await stageTemporalCandidate(bridge,make("hidden"));
  await stageTemporalCandidate(bridge,make("unknown"));
  await stageTemporalCandidate(bridge,make("secret-record"));
  const visible=await listTemporalKnowledgeHistory(bridge,{
    subjectId:"person-1",collectionId:"visible",mode:"all",
  });
  expect(visible.items.map((x:{claimId:string})=>x.claimId)).toEqual([visibleId]);
  expect(visible.nextCursor).toBeNull();
  for(const collectionId of ["hidden","unknown"]) {
    const result=await listTemporalKnowledgeHistory(bridge,{
      subjectId:"person-1",collectionId,mode:"all",
    });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  }
  await expect(listTemporalKnowledgeHistory(bridge,{
    subjectId:"person-1",collectionId:"visible",mode:"all",limit:0,
  })).rejects.toThrow("temporal_history_limit_invalid");
  await expect(listTemporalKnowledgeHistory(bridge,{
    subjectId:"person-1",collectionId:"visible",mode:"all",
    before:{recordedAt:"2026-02-30T00:00:00.000Z",claimId:"bad"},
  })).rejects.toThrow("temporal_history_cursor_invalid");
  db.prepare("UPDATE memory_entities SET record_status='trashed' WHERE id='visible'").run();
  expect((await listTemporalKnowledgeHistory(bridge,{
    subjectId:"person-1",collectionId:"visible",mode:"all",
  })).items).toEqual([]);
});


test("T2c review inbox lists source-backed standard proposals with cursor, CAS and undo via leased repository", async () => {
  const { stageTemporalCandidate } = require("../temporal-store");
  await openLocalMemory("guest");
  const db=mockConnections[0].sqlite,bridge=mockConnections[0];
  const repo=await localMemoryRepository("guest");
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('work','Работа','work','standard','now')").run();
  for (const id of ["a","b","c"]) {
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'work','notes','{}','now','now')").run(id);
  }
  const make=(entityId:string,value:string,day:number):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-"+String(day).padStart(2,"0")+"T12:00:00.000Z",
    subjectId:"person-1",predicate:"employment",context:"primary",value,
    kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},
  });
  const firstId=await stageTemporalCandidate(bridge,make("a","А",20));
  const b=await repo.stageTypedTemporalFact(make("b","Б",21));
  const c=await repo.stageTypedTemporalFact(make("c","В",22));
  expect(b).toMatchObject({reviewScope:"standard",truncated:false});
  expect(b.proposalIds).toHaveLength(1);
  expect(c.proposalIds).toHaveLength(2);
  const page1=await repo.temporalReviewInbox({collectionId:"work",limit:2});
  expect(page1.items).toHaveLength(2);
  expect(page1.nextCursor).not.toBeNull();
  expect(page1.items[0]).toMatchObject({
    reviewKind:"possible_change",status:"pending",expectedProposalVersion:1,
  });
  expect(page1.items[0].incoming.evidence.quote).toBe("Работаю в В");
  const page2=await repo.temporalReviewInbox({
    collectionId:"work",limit:2,before:page1.nextCursor!,
  });
  expect(page2.items).toHaveLength(1);
  expect(page2.nextCursor).toBeNull();
  expect(new Set([...page1.items,...page2.items].map(x=>x.proposalId)).size).toBe(3);
  const target=page2.items[0];
  expect(target.previous.value).toBe("А");
  expect(target.incoming.value).toBe("Б");
  const accepted=await repo.decideTemporalChange({
    proposalId:target.proposalId,
    expectedProposalVersion:target.expectedProposalVersion,
    expectedPreviousClaimVersion:target.expectedPreviousClaimVersion,
    expectedIncomingClaimVersion:target.expectedIncomingClaimVersion,
    choice:"accept",
    confirmedEnd:{normalized:null,precision:"unknown",raw:"Пользователь подтвердил завершение без даты",
      anchorDate:null,sourceTimeZone:null},
  });
  expect(db.prepare("SELECT end_confirmed FROM memory_temporal_claims WHERE id=?").get(firstId).end_confirmed).toBe(1);
  const undone=await repo.undoTemporalChange({
    proposalId:target.proposalId,decisionId:accepted.decisionId,
    expectedProposalVersion:accepted.nextProposalVersion,
    expectedPreviousClaimVersion:target.expectedPreviousClaimVersion+1,
    expectedIncomingClaimVersion:target.expectedIncomingClaimVersion,
  });
  expect(undone.nextProposalVersion).toBe(3);
  expect(db.prepare("SELECT end_confirmed FROM memory_temporal_claims WHERE id=?").get(firstId).end_confirmed).toBe(0);
  const after=await repo.temporalReviewInbox({collectionId:"work",limit:10});
  expect(after.items.map(x=>x.proposalId)).toContain(target.proposalId);
  await expect(repo.temporalReviewInbox({collectionId:"work",limit:0}))
    .rejects.toThrow("temporal_review_limit_invalid");
  await expect(repo.temporalReviewInbox({collectionId:"work",before:{
    createdAt:"2026-10-99T00:00:00.000Z",proposalId:"bad",
  }})).rejects.toThrow("temporal_review_cursor_invalid");
});

test("T2c inbox excludes stale, protected, and cross-collection proposals before pagination", async () => {
  const { stageTemporalCandidate, stageTemporalReviewProposal } = require("../temporal-store");
  await openLocalMemory("guest");
  const db=mockConnections[0].sqlite,bridge=mockConnections[0];
  const repo=await localMemoryRepository("guest");
  for (const [id,level] of [["visible","standard"],["hidden","private"],["unknown","unclassified"],["other","standard"]]) {
    db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?, 'now')").run(id,id,id,level);
    for (const i of ["a","b"]) {
      db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,?,'notes','{}','now','now')").run(id+"-"+i,id);
    }
  }
  const make=(entityId:string,value:string,day:number):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-"+String(day).padStart(2,"0")+"T12:00:00.000Z",
    subjectId:"person-1",predicate:"residence",context:"actual",value,
    kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Живу в "+value,origin:"direct"},
  });
  for (const prefix of ["visible","hidden","unknown","other"]) {
    const a=await stageTemporalCandidate(bridge,make(prefix+"-a","А",20));
    const b=await stageTemporalCandidate(bridge,make(prefix+"-b","Б",21));
    const staged=await stageTemporalReviewProposal(bridge,a,b);
    expect(staged === null).toBe(prefix === "hidden" || prefix === "unknown");
  }
  expect((await repo.temporalReviewInbox({collectionId:"visible"})).items).toHaveLength(1);
  expect((await repo.temporalReviewInbox({collectionId:"hidden"})).items).toHaveLength(0);
  expect((await repo.temporalReviewInbox({collectionId:"unknown"})).items).toHaveLength(0);
  expect((await repo.temporalReviewInbox({collectionId:"other"})).items).toHaveLength(1);
  db.prepare("UPDATE memory_entities SET record_version=2 WHERE id='visible-b'").run();
  const stale=await repo.temporalReviewInbox({collectionId:"visible",limit:1});
  expect(stale.items).toHaveLength(0);
  expect(stale.nextCursor).toBeNull();
});


test("TM05 SQLCipher v11: a late-imported older employer document never closes the newer role",async()=>{
  await openLocalMemory("guest");
  const bridge=mockConnections[0], db=bridge.sqlite;
  const repo=await localMemoryRepository("guest");
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('jobs','Работа','jobs','standard','now')").run();
  for(const id of ["latest","archival","future"]){
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'jobs','notes','{}','now','now')").run(id);
  }
  const make=(entityId:string,value:string,year:string,recordedAt:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt,subjectId:"person-1",predicate:"employment",context:"primary",value,
    kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:{
      normalized:year,precision:"year",raw:"С "+year+" года",
      anchorDate:null,sourceTimeZone:null,
    },
    ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работа в "+value,origin:"direct"},
  });
  const current=await repo.stageTypedTemporalFact(make(
    "latest","Работодатель Б","2024","2026-10-20T10:00:00.000Z"));
  expect(current.proposalIds).toEqual([]);
  const archival=await repo.stageTypedTemporalFact(make(
    "archival","Работодатель А","2019","2026-10-27T10:00:00.000Z"));
  expect(archival.proposalIds).toEqual([]);
  // The historical record still survives as a distinct typed claim.
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_temporal_claims").get().n).toBe(2);
  expect((await repo.temporalKnowledgeHistory({
    subjectId:"person-1",collectionId:"jobs",mode:"states",
  })).items.map(x=>x.claim.value)).toEqual(["Работодатель А","Работодатель Б"]);
  const future=await repo.stageTypedTemporalFact(make(
    "future","Работодатель В","2025","2026-10-28T10:00:00.000Z"));
  expect(future.proposalIds).toHaveLength(2);
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_temporal_proposals").get().n).toBe(2);
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_temporal_decisions").get().n).toBe(0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_temporal_claims WHERE end_confirmed=1").get().n).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});


test("T3b1 valid-date candidates keep historical and current possibilities separate without claiming truth",async()=>{
  await openLocalMemory("guest");
  const db=mockConnections[0].sqlite,repo=await localMemoryRepository("guest");
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('jobs','Работа','jobs','standard','now')").run();
  for(const id of ["a","b","event","plan","wrong-person"]){
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'jobs','notes','{}','now','now')").run(id);
  }
  const bound=(date:string,precision:"day"|"year"|"month"|"unknown"="day"):import("../temporal-claims").TemporalBound=>({
    normalized:precision==="unknown"?null:date,precision,raw:date||"неизвестно",
    anchorDate:null,sourceTimeZone:null,
  });
  const make=(entityId:string,value:string,started:import("../temporal-claims").TemporalBound|null,
    changes:Partial<import("../temporal-claims").TemporalClaimCandidate>={}
  ):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"employment",context:"primary",value,kind:"state",
    modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:started,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Работаю в "+value,origin:"direct"},...changes,
  });
  const a=await repo.stageTypedTemporalFact(make("a","А",bound("2022-01-01"),{
    ended:bound("2024-08-31"),endConfirmed:true,
  }));
  const b=await repo.stageTypedTemporalFact(make("b","Б",bound("2024-09-01")));
  await repo.stageTypedTemporalFact(make("event","Ремонт",bound("2023-01-01"),{kind:"event"}));
  await repo.stageTypedTemporalFact(make("plan","В",bound("2026-11-01"),{modality:"planned"}));
  await repo.stageTypedTemporalFact(make("wrong-person","Другая компания",bound("2024-09-01"),{
    subjectId:"person-2",
  }));
  const query={subjectId:"person-1",collectionId:"jobs",
    predicate:"employment",context:"primary",validDate:"2023-07-01"};
  const old=await repo.temporalCandidatesAtDate(query);
  expect(old.items).toHaveLength(2);
  const byValue=Object.fromEntries(old.items.map(x=>[x.claim.value,x]));
  expect(byValue["А"]).toMatchObject({
    claimId:a.claimId,timeFit:"potentially_applicable",verification:"candidate_unconfirmed",
  });
  expect(byValue["Б"]).toMatchObject({
    claimId:b.claimId,timeFit:"outside_date",verification:"candidate_unconfirmed",
  });
  expect(byValue["А"].claim.evidence).toMatchObject({entityId:"a",recordVersion:1,
    quote:"Работаю в А",origin:"direct"});
  const newDate=await repo.temporalCandidatesAtDate({...query,validDate:"2025-06-01"});
  expect(Object.fromEntries(newDate.items.map(x=>[x.claim.value,x.timeFit])))
    .toMatchObject({"А":"outside_date","Б":"potentially_applicable"});
  expect(newDate.partial).toBe(false);
  expect(newDate.nextCursor).toBeNull();
  expect((await repo.temporalCandidatesAtDate({...query,validDate:"2024-08-31"}))
    .items.find(x=>x.claim.value==="А")?.timeFit).toBe("potentially_applicable");
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_temporal_decisions").get().n).toBe(0);
});

test("T3b1 unknown/approximate dates and broad boundaries are never promoted to a precise current fact",async()=>{
  const {temporalFitAtDate}=require("../temporal-store");
  const bound=(normalized:string|null,precision:"day"|"year"|"month"|"unknown"|"approximate"
  ):import("../temporal-claims").TemporalBound=>({
    normalized,precision,raw:normalized??"около прошлого лета",
    anchorDate:null,sourceTimeZone:null,
  });
  const base:import("../temporal-claims").TemporalClaimCandidate={
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"residence",context:"actual",value:"Город Б",kind:"state",
    modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:bound("2024","year"),
    ended:null,endConfirmed:false,
    evidence:{entityId:"source",recordVersion:1,quote:"Переехал в 2024",origin:"direct"},
  };
  expect(temporalFitAtDate(base,"2023-12-31")).toBe("outside_date");
  expect(temporalFitAtDate(base,"2024-02-15")).toBe("boundary_uncertain");
  expect(temporalFitAtDate(base,"2025-06-01")).toBe("potentially_applicable");
  expect(temporalFitAtDate({...base,occurredOrStarted:bound(null,"approximate")},"2025-06-01"))
    .toBe("boundary_uncertain");
  expect(temporalFitAtDate({...base,occurredOrStarted:null},"2025-06-01"))
    .toBe("boundary_uncertain");
  expect(temporalFitAtDate({...base,occurredOrStarted:bound("2022-01-01","day"),
    ended:bound("2024","year"),endConfirmed:true},"2024-04-01")).toBe("boundary_uncertain");
  expect(temporalFitAtDate({...base,occurredOrStarted:bound("2022-01-01","day"),
    ended:bound(null,"unknown"),endConfirmed:true},"2027-01-01")).toBe("boundary_uncertain");
  expect(temporalFitAtDate({...base,modality:"planned"},"2025-06-01")).toBe("outside_date");
  expect(temporalFitAtDate({...base,negated:true},"2025-06-01")).toBe("outside_date");
  await expect(Promise.resolve().then(()=>temporalFitAtDate(base,"2025-02-30")))
    .rejects.toThrow("temporal_query_date_invalid");
});

test("T3b1 SQL read excludes protected/stale records before a stable bounded keyset",async()=>{
  await openLocalMemory("guest");
  const db=mockConnections[0].sqlite,repo=await localMemoryRepository("guest");
  for(const [collection,level] of [["visible","standard"],["private","private"],
      ["unknown","unclassified"]] as const){
    db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?, 'now')")
      .run(collection,collection,collection,level);
  }
  const make=(entityId:string,i:number):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-27T12:00:00.000Z",subjectId:"person-1",
    predicate:"residence",context:"actual",value:"Address "+i,
    kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Source "+i,origin:"direct"},
  });
  const makeRow=(id:string,c:string,sensitivity:string)=>{
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,sensitivity,payload_json,created_at,updated_at) VALUES (?,?, 'notes',?,'{}','now','now')").run(id,c,sensitivity);
  };
  for(let i=0;i<5;i++){
    makeRow("v"+i,"visible","standard");
    await repo.stageTypedTemporalFact(make("v"+i,i));
  }
  makeRow("secret","visible","secret");
  makeRow("hidden","private","standard");
  makeRow("unclassified","unknown","standard");
  for(const [id,i] of [["secret",90],["hidden",91],["unclassified",92]] as const){
    await repo.stageTypedTemporalFact(make(id,i));
  }
  const q={subjectId:"person-1",collectionId:"visible",
    predicate:"residence",context:"actual",validDate:"2024-06-01",limit:2};
  const p1=await repo.temporalCandidatesAtDate(q);
  expect(p1.items).toHaveLength(2);expect(p1.partial).toBe(true);
  const p2=await repo.temporalCandidatesAtDate({...q,before:p1.nextCursor!});
  expect(p2.items).toHaveLength(2);expect(p2.partial).toBe(true);
  const p3=await repo.temporalCandidatesAtDate({...q,before:p2.nextCursor!});
  expect(p3.items).toHaveLength(1);expect(p3.partial).toBe(false);
  expect(p3.nextCursor).toBeNull();
  const all=[...p1.items,...p2.items,...p3.items];
  expect(new Set(all.map(x=>x.claimId)).size).toBe(5);
  expect(all.every(x=>x.claim.evidence.entityId.startsWith("v"))).toBe(true);
  const hidden=await repo.temporalCandidatesAtDate({...q,collectionId:"private"});
  expect(hidden.items).toEqual([]);expect(hidden.partial).toBe(false);
  db.prepare("UPDATE memory_entities SET record_version=2 WHERE id='v1'").run();
  const after=await repo.temporalCandidatesAtDate({...q,limit:20});
  expect(after.items).toHaveLength(4);
  await expect(repo.temporalCandidatesAtDate({...q,limit:51}))
    .rejects.toThrow("temporal_query_limit_invalid");
  await expect(repo.temporalCandidatesAtDate({...q,before:{
    recordedAt:"2026-02-31T00:00:00.000Z",claimId:"bogus",
  }})).rejects.toThrow("temporal_query_cursor_invalid");
});


test("R1 review guard: manual low-level proposal cannot bridge two standard collections or protected evidence",async()=>{
  const {stageTemporalCandidate,stageTemporalReviewProposal,isStandardTemporalReviewPair}=require("../temporal-store");
  const {decideTemporalReview,undoTemporalReview}=require("../temporal-decisions");
  await openLocalMemory("guest");
  const bridge=mockConnections[0],db=bridge.sqlite;
  for(const [id,level] of [["work","standard"],["home","standard"],["restricted","private"]] as const){
    db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?, 'now')").run(id,id,id,level);
  }
  for(const [id,col,level] of [
    ["work-a","work","standard"],["work-b","work","standard"],
    ["home-a","home","standard"],["restricted-a","restricted","standard"],
    ["secret-work","work","secret"],
  ] as const){
    db.prepare("INSERT INTO memory_entities(id,collection_id,domain,sensitivity,payload_json,created_at,updated_at) VALUES (?,?, 'notes',?, '{}','now','now')").run(id,col,level);
  }
  const make=(entityId:string,value:string):import("../temporal-claims").TemporalClaimCandidate=>({
    recordedAt:"2026-10-28T10:00:00.000Z",subjectId:"person-1",
    predicate:"residence",context:"actual",value,
    kind:"state",modality:"asserted",negated:false,cardinality:"single",
    occurredOrStarted:null,ended:null,endConfirmed:false,
    evidence:{entityId,recordVersion:1,quote:"Живу в "+value,origin:"direct"},
  });
  const workA=await stageTemporalCandidate(bridge,make("work-a","A"));
  const workB=await stageTemporalCandidate(bridge,make("work-b","B"));
  const homeA=await stageTemporalCandidate(bridge,make("home-a","C"));
  const restricted=await stageTemporalCandidate(bridge,make("restricted-a","D"));
  const secret=await stageTemporalCandidate(bridge,make("secret-work","E"));
  for(const invalid of [homeA,restricted,secret]){
    expect(await isStandardTemporalReviewPair(bridge,workA,invalid)).toBe(false);
    expect(await stageTemporalReviewProposal(bridge,workA,invalid)).toBeNull();
  }
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_proposals").get().n).toBe(0);
  const p=(await stageTemporalReviewProposal(bridge,workA,workB))!;
  expect(await isStandardTemporalReviewPair(bridge,workA,workB)).toBe(true);
  const versions={
    proposalId:p,expectedProposalVersion:1,
    expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1,
  };
  // The source is no longer eligible even though the pending proposal row exists.
  db.prepare("UPDATE memory_entities SET sensitivity='secret' WHERE id='work-b'").run();
  expect(await isStandardTemporalReviewPair(bridge,workA,workB)).toBe(false);
  await expect(decideTemporalReview(bridge,{...versions,choice:"keep_both"}))
    .rejects.toThrow("temporal_review_not_available");
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_decisions").get().n).toBe(0);
  db.prepare("UPDATE memory_entities SET sensitivity='standard' WHERE id='work-b'").run();
  const result=await decideTemporalReview(bridge,{...versions,choice:"keep_both"});
  db.prepare("UPDATE memory_entities SET sensitivity='secret' WHERE id='work-a'").run();
  await expect(undoTemporalReview(bridge,{
    ...versions,decisionId:result.decisionId,expectedProposalVersion:2,
  })).rejects.toThrow("temporal_review_not_available");
  expect(db.prepare("SELECT status FROM memory_temporal_proposals WHERE id=?").get(p).status).toBe("dismissed");
  expect(db.prepare("SELECT count(*) AS n FROM memory_temporal_decisions").get().n).toBe(1);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});


test("v11→v12 retains the canonical relation and adds independent user proof witnesses without promoting legacy edges",async()=>{
  const {SCHEMA_SQL}=require("../storage");
  const identity=await localMemoryIdentity("guest");
  const pathToDb=path.join(mockDirectory,identity.databaseName);
  const sqlite=new DatabaseSync(pathToDb);
  const schemaV11=SCHEMA_SQL.replace(
    /-- v12: source-backed user-confirmed evidence[\s\S]*?CREATE TABLE IF NOT EXISTS memory_revisions \(/,
    "CREATE TABLE IF NOT EXISTS memory_revisions (",
  );
  expect(schemaV11).not.toContain("CREATE TABLE IF NOT EXISTS memory_relation_evidence");
  sqlite.exec(schemaV11);
  sqlite.exec("PRAGMA user_version=11");
  sqlite.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('people','Люди','people','standard','now')").run();
  for(const id of ["person-1","person-2","note-1","note-2"]) {
    sqlite.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'people','notes','{}','now','now')").run(id);
  }
  sqlite.prepare("INSERT INTO memory_relations(id,source_entity_id,target_entity_id,kind,source_kind,source_ref,created_at) VALUES ('old','person-1','person-2','has_sister',null,null,'now')").run();
  sqlite.close();
  mockVault.set(identity.keyName,"8".repeat(64));
  mockVault.set(identity.keyName+".initialized","yes");
  await openLocalMemory("guest");
  const db=mockConnections[0].sqlite;
  expect(db.prepare("PRAGMA user_version").get().user_version).toBe(14);
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_relations").get().n).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_relation_evidence").get().n).toBe(0);
  // No legacy edge is silently reclassified as a proven relation.
  db.prepare("INSERT INTO memory_relation_evidence(id,relation_id,evidence_entity_id,evidence_record_version,source_record_version,target_record_version,quote,origin,actor_kind,created_at) VALUES (?,'old',?,1,1,1,?,'explicit_user','user','now')").run("proof-1","note-1","Моя сестра — Марина");
  db.prepare("INSERT INTO memory_relation_evidence(id,relation_id,evidence_entity_id,evidence_record_version,source_record_version,target_record_version,quote,origin,actor_kind,created_at) VALUES (?,'old',?,1,1,1,?,'explicit_user','user','now')").run("proof-2","note-2","Марина — моя сестра");
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_relation_evidence WHERE relation_id='old'").get().n).toBe(2);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(mockVault.get(identity.keyName)).toBe("8".repeat(64));
});

test("v12 rejects invalid untrusted relation witnesses at SQLCipher constraint boundary",async()=>{
  await openLocalMemory("guest");
  const db=mockConnections[0].sqlite;
  db.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('c','Люди','people','standard','now')").run();
  for(const id of ["a","b","w"])db.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'c','notes','{}','now','now')").run(id);
  db.prepare("INSERT INTO memory_relations(id,source_entity_id,target_entity_id,kind,created_at) VALUES ('r','a','b','has_sister','now')").run();
  const insert=(state:string,actor:string,quote:string)=>db.prepare("INSERT INTO memory_relation_evidence(id,relation_id,evidence_entity_id,evidence_record_version,source_record_version,target_record_version,quote,origin,actor_kind,state,created_at) VALUES ('e','r','w',1,1,1,?,'direct',?,?,'now')").run(quote,actor,state);
  expect(()=>insert("confirmed","model","Моя сестра")).toThrow();
  expect(()=>insert("approved","user","Моя сестра")).toThrow();
  expect(()=>insert("confirmed","user","")).toThrow();
  expect(()=>insert("confirmed","user","Моя сестра")).not.toThrow();
  expect(db.prepare("SELECT COUNT(*) AS n FROM memory_relation_evidence").get().n).toBe(1);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});


test("installed v12 upgrades to v13 preserving old relation witnesses with CAS review version",async()=>{
  const {SCHEMA_SQL}=require("../storage");
  const identity=await localMemoryIdentity("guest");
  const dbPath=path.join(mockDirectory,identity.databaseName);
  const sqlite=new DatabaseSync(dbPath);
  const v12=SCHEMA_SQL
    .replace("  decision_version INTEGER NOT NULL DEFAULT 1 CHECK(decision_version>0),\n","")
    .replace(/-- One domain-neutral review action journal[\s\S]*?CREATE INDEX IF NOT EXISTS ix_memory_review_actions_relation[\s\S]*?;\n/,"");
  expect(v12).not.toContain("CREATE TABLE IF NOT EXISTS memory_review_actions");
  sqlite.exec(v12);
  sqlite.exec("PRAGMA user_version=12;");
  sqlite.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES ('c','Люди','people','standard','now')").run();
  for(const id of ["a","b","w"]){
    sqlite.prepare("INSERT INTO memory_entities(id,collection_id,domain,payload_json,created_at,updated_at) VALUES (?,'c','notes','{}','now','now')").run(id);
  }
  sqlite.prepare("INSERT INTO memory_relations(id,source_entity_id,target_entity_id,kind,created_at) VALUES ('r','a','b','has_sister','now')").run();
  sqlite.prepare("INSERT INTO memory_relation_evidence(id,relation_id,evidence_entity_id,evidence_record_version,source_record_version,target_record_version,quote,origin,actor_kind,state,created_at) VALUES ('ev','r','w',1,1,1,'Моя сестра','explicit_user','user','confirmed','now')").run();
  sqlite.close();
  mockVault.set(identity.keyName,"7".repeat(64));
  mockVault.set(identity.keyName+".initialized","yes");
  await openLocalMemory("guest");
  const upgraded=mockConnections[0].sqlite;
  expect(upgraded.prepare("PRAGMA user_version").get().user_version).toBe(14);
  expect(upgraded.prepare("SELECT state,decision_version FROM memory_relation_evidence WHERE id='ev'").get())
    .toMatchObject({state:"confirmed",decision_version:1});
  expect(upgraded.prepare("SELECT count(*) AS n FROM memory_review_actions").get().n).toBe(0);
  expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(mockVault.get(identity.keyName)).toBe("7".repeat(64));
});
