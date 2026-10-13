import { SqliteMemoryRepository } from "../repository";
import { MemoryAccessError, MemoryConflictError } from "../types";

jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "fixed-" + Math.random().toString(36).slice(2)),
}));

// Exercise actual SQL, full-text search and rollback semantics rather than a
// query-shaped fake. This adapter replaces ONLY the Expo native bridge.
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("../storage");
class FakeSqlite {
  private sqlite = new DatabaseSync(":memory:");
  updates = 0;
  transactionStatements: string[] = [];
  constructor() { this.sqlite.exec(SCHEMA_SQL); }
  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.sqlite.prepare(sql).get(...params) as T) ?? null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = this.sqlite.prepare(sql).run(...params);
    if (sql.startsWith("UPDATE memory_entities")) this.updates += Number(result.changes);
    return { changes: Number(result.changes) };
  }
  async execAsync(sql: string): Promise<void> {
    this.transactionStatements.push(sql); this.sqlite.exec(sql);
  }
}

test("creates offline note, edits with CAS, stores immutable history and updates full-text search", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  const collection = await repo.createCollection({ name: "Notes", slug: "notes", sensitivity: "standard" });
  const initial = await repo.createEntity({
    collection_id: collection.id, domain: "notes", title: "Car",
    payload: { type: "note", title: "Car", body: "old oil" },
  });
  expect(initial.record_version).toBe(1);
  expect((await repo.searchNotes("old oil"))[0].id).toBe(initial.id);
  const updated = await repo.reviseEntity(
    initial.id, 1, { type: "note", title: "Service", body: "new filter" }, "fix typo",
  );
  expect(updated.record_version).toBe(2);
  expect(fake.updates).toBe(1);
  // Never open a second connection: SQLCipher keys are connection-local.
  expect(fake.transactionStatements).toEqual([
    "BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "COMMIT",
  ]);
  expect(await repo.searchNotes("old oil")).toHaveLength(0);
  expect((await repo.searchNotes("new filter"))[0].id).toBe(initial.id);
  const history = await repo.revisions("entity", initial.id);
  expect(history).toHaveLength(1);
  expect((history[0].before_state.payload as Record<string, unknown>).body).toBe("old oil");
  expect((history[0].after_state.payload as Record<string, unknown>).body).toBe("new filter");
  history[0].before_state.payload = { body: "tampered" };
  expect((await repo.revisions("entity", initial.id))[0].before_state).toMatchObject({
    payload: { body: "old oil" },
  });
  await expect(repo.reviseEntity(initial.id, 1, { body: "stale" }, "stale"))
    .rejects.toBeInstanceOf(MemoryConflictError);
  expect(fake.updates).toBe(1);
  await expect(repo.createEntity({ collection_id: "not-present", domain: "notes", payload: {} }))
    .rejects.toBeInstanceOf(MemoryAccessError);
});

test("rejects malformed local input before any database mutation", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  await expect(repo.createCollection({ name: "Note", slug: "bad slug" })).rejects.toThrow("invalid_collection_slug");
  await expect(repo.createCollection({ name: "Note", slug: "notes" })).resolves.toMatchObject({ slug: "notes" });
  await expect(repo.createCollection({ name: "Note", slug: "notes" })).rejects.toBeInstanceOf(MemoryConflictError);
  await expect(repo.reviseEntity("missing", 1, {}, "")).rejects.toThrow("invalid_revision_reason");
  await expect(repo.linkEntities("same", "same", "related_to")).rejects.toThrow("self_relation_not_allowed");
  await expect(repo.linkEntities("x", "y", "bad type")).rejects.toThrow("invalid_relation_kind");
  expect(fake.updates).toBe(0);
});


test("offline creation uses the already-unlocked SQLCipher connection", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  const col = await repo.createCollection({ name: "Notes", slug: "notes" });
  await repo.createEntity({ collection_id: col.id, domain: "notes", payload: { title: "A" } });
  expect(fake.transactionStatements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
});

test("section filters, moves, archive and restore preserve payload and immutable revisions", async () => {
  const fake = new FakeSqlite(); const repo = new SqliteMemoryRepository(fake as never);
  const first = await repo.createCollection({ name: "Идеи", slug: "ideas", sensitivity: "standard" });
  const second = await repo.createCollection({ name: "Рецепты", slug: "recipes", sensitivity: "standard" });
  const note = await repo.createEntity({ collection_id: first.id, domain: "notes", title: "Рецепт", payload: { title: "Рецепт", body: "индейка", source_file: "original.txt" } });
  expect(await repo.searchNotes("", 50, 0, { collectionId: second.id })).toHaveLength(0);
  const moved = await repo.reviseEntity(note.id, 1, note.payload, "Смена раздела", second.id);
  expect(moved.collection_id).toBe(second.id);
  expect(await repo.searchNotes("индейка", 50, 0, { collectionId: first.id })).toHaveLength(0);
  expect((await repo.searchNotes("индейка", 50, 0, { collectionId: second.id }))[0].id).toBe(note.id);
  const archived = await repo.setEntityStatus(note.id, 2, "archived");
  expect(await repo.searchNotes("индейка")).toHaveLength(0);
  expect((await repo.searchNotes("индейка", 50, 0, { status: "archived" }))[0].id).toBe(note.id);
  await expect(repo.setEntityStatus(note.id, 2, "active")).rejects.toBeInstanceOf(MemoryConflictError);
  await repo.setEntityStatus(note.id, archived.record_version, "active");
  expect((await repo.searchNotes("индейка"))[0].payload.source_file).toBe("original.txt");
  const revisions = await repo.revisions("entity", note.id);
  expect(revisions.map(r => r.version)).toEqual([2, 3, 4]);
  expect(revisions[0].before_state.collection_id).toBe(first.id);
  expect(revisions[0].after_state.collection_id).toBe(second.id);
});

test("invalid section changes roll back the whole edit", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const section = await repo.createCollection({ name: "Заметки", slug: "notes" });
  const note = await repo.createEntity({ collection_id: section.id, domain: "notes", payload: { body: "original" } });
  await expect(repo.reviseEntity(note.id, 1, { body: "lost" }, "move", "missing"))
    .rejects.toBeInstanceOf(MemoryAccessError);
  expect((await repo.entity(note.id))?.payload.body).toBe("original");
  expect(await repo.revisions("entity", note.id)).toEqual([]);
});

test("moving private inherited records to an ordinary section does not change their effective classification", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const privateSection = await repo.createCollection({ name: "Личное", slug: "private", sensitivity: "secret" });
  const ordinary = await repo.createCollection({ name: "Идеи", slug: "ideas", sensitivity: "standard" });
  const note = await repo.createEntity({ collection_id: privateSection.id, domain: "notes", payload: { body: "личная запись" }, sensitivity: "inherit" });
  const moved = await repo.reviseEntity(note.id, 1, note.payload, "Перенос", ordinary.id);
  expect(moved.collection_id).toBe(ordinary.id); expect(moved.sensitivity).toBe("secret");
  expect((await repo.entity(note.id))?.sensitivity).toBe("secret");
});
