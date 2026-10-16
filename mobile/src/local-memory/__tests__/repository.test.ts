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

test("memory finds other Russian word forms and ranks the best match first", async () => {
  const { searchApprovedNotes, wordStem } = require("../../direct-agent/memory");
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const people = await repo.createCollection({ name: "Люди", slug: "people", sensitivity: "standard" });
  const docs = await repo.createCollection({ name: "Документы", slug: "documents", sensitivity: "sensitive" });
  const add = (collection_id: string, title: string, body: string) => repo.createEntity({ collection_id, domain: "notes", title, payload: { type: "note", title, body }, sensitivity: "standard" });
  await add(people.id, "Машина", "Сестра Аня продала машину в мае");
  await add(people.id, "Аня", "Сестра, любит кофе и машины");
  await add(people.id, "Отпуск", "Поездка в Казань");
  await add(docs.id, "ОСАГО", "Полис на машину до мая");
  expect(wordStem("машину")).toBe("машин");
  expect(wordStem("сестры")).toBe("сестр");
  const found = await searchApprovedNotes("guest", "Где машина сестры?", repo);
  expect(found.map((n: any) => n.title)).toEqual(["Машина", "Аня"]);
  expect(found[0].section).toBe("Люди");
  expect(found.some((n: any) => n.title === "ОСАГО")).toBe(false);
  expect(await searchApprovedNotes("guest", "Что с самолётом?", repo)).toEqual([]);
});

test("records get a type from their section, can change it with a revision, and unknown types are refused", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const people = await repo.createCollection({ name: "Люди", slug: "people", sensitivity: "standard" });
  const notes = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  const masha = await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Маша", payload: { title: "Маша", body: "Племянница" } });
  const idea = await repo.createEntity({ collection_id: notes.id, domain: "notes", title: "Идея", payload: { body: "Кормушка" } });
  expect(masha.kind).toBe("person");
  expect((await repo.entity(idea.id))!.kind).toBe("note");
  const fact = await repo.setEntityKind(idea.id, 1, "fact");
  expect(fact).toMatchObject({ kind: "fact", record_version: 2 });
  expect((await repo.revisions("entity", idea.id))[0].before_state).toMatchObject({ kind: "note" });
  expect((await repo.entities({ kind: "person" })).items.map(e => e.id)).toEqual([masha.id]);
  await expect(repo.createEntity({ collection_id: notes.id, domain: "notes", payload: {}, kind: "secret" as never })).rejects.toThrow("invalid_memory_kind");
  await expect(repo.setEntityKind(idea.id, 1, "event")).rejects.toThrow("stale_memory_version");
});

test("names and index words are searched with the record and rebuilt on every change", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const people = await repo.createCollection({ name: "Люди", slug: "people", sensitivity: "standard" });
  const lena = await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Елена Сергеевна", payload: { body: "Руководитель отдела" } });
  expect(await repo.searchNotes("шеф")).toHaveLength(0);
  expect(await repo.setAliases(lena.id, ["Лена", " лена ", "Шеф", "Алёна"])).toEqual(["Лена", "Шеф", "Алёна"]);
  expect(await repo.aliases(lena.id)).toEqual(["Алёна", "Лена", "Шеф"]);
  expect((await repo.searchNotes("Лену", 5, 0, { prefix: false }))).toHaveLength(0);
  expect((await repo.searchNotes("Лен", 5, 0, { prefix: true }))[0].id).toBe(lena.id);
  expect((await repo.searchNotes("алена"))[0].id).toBe(lena.id);
  expect((await repo.entitiesByAlias("шеф", "person")).map(e => e.id)).toEqual([lena.id]);
  expect((await repo.entitiesByAlias("Елена Сергеевна")).map(e => e.id)).toEqual([lena.id]);
  await repo.setIndexTerms(lena.id, ["начальница", "босс", "x"], "model:deepseek-chat");
  expect(await repo.indexTerms(lena.id)).toEqual([{ source: "model:deepseek-chat", terms: ["начальница", "босс"] }]);
  expect((await repo.searchNotes("начальница"))[0].id).toBe(lena.id);
  // A text edit keeps names and index words in the index.
  await repo.reviseEntity(lena.id, 1, { title: "Елена Сергеевна", body: "Директор по продажам" }, "Повышение");
  expect((await repo.searchNotes("босс"))[0].id).toBe(lena.id);
  expect((await repo.searchNotes("директор"))[0].id).toBe(lena.id);
  expect(await repo.searchNotes("руководитель")).toHaveLength(0);
  await repo.setIndexTerms(lena.id, [], "model:deepseek-chat");
  expect(await repo.searchNotes("босс")).toHaveLength(0);
  await expect(repo.setIndexTerms(lena.id, ["a"], "anyone")).rejects.toThrow("invalid_index_terms_source");
  await expect(repo.setAliases("missing", ["Кто-то"])).rejects.toThrow("entity_not_found");
});

test("a long record is split into chunks; search returns each record once with the chunk that matched", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  const notes = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  const filler = "Обычный день без событий. ".repeat(30);
  const diary = await repo.createEntity({ collection_id: notes.id, domain: "notes", title: "Дневник",
    payload: { body: [filler, "Паспорт продлила в МФЦ на Ленина.", filler + "Ещё раз про паспорт."].join("\n\n") } });
  const chunks = await fake.getAllAsync<{ ord: number; text: string }>("SELECT ord, text FROM memory_chunks WHERE entity_id=? ORDER BY ord", [diary.id]);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(c => c.text.length <= 700)).toBe(true);
  expect(await repo.searchNotes("паспорт")).toHaveLength(1);
  const [hit] = await repo.searchMemory("Где я продлила паспорт?");
  expect(hit.entity.id).toBe(diary.id);
  expect(hit.chunk).toContain("МФЦ");
  // Editing to a short text removes the extra chunks.
  await repo.reviseEntity(diary.id, 1, { title: "Дневник", body: "Коротко." }, "Сократила");
  expect((await fake.getAllAsync("SELECT id FROM memory_chunks WHERE entity_id=?", [diary.id]))).toHaveLength(1);
  expect(await repo.searchNotes("паспорт")).toHaveLength(0);
});

test("searchMemory searches only the given sections and sensitivities", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const open = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  const docs = await repo.createCollection({ name: "Документы", slug: "documents", sensitivity: "sensitive" });
  const visible = await repo.createEntity({ collection_id: open.id, domain: "notes", title: "Полис ОСАГО", payload: { body: "Продлить в мае" }, sensitivity: "standard" });
  await repo.createEntity({ collection_id: docs.id, domain: "notes", title: "Полис ОСАГО номер", payload: { body: "ХХХ 0123456789" }, sensitivity: "sensitive" });
  await repo.createEntity({ collection_id: open.id, domain: "notes", title: "Полис личный", payload: { body: "Номер полиса" }, sensitivity: "secret" });
  const hits = await repo.searchMemory("полис ОСАГО", { collectionIds: [open.id], sensitivities: ["standard", "inherit"] });
  expect(hits.map(h => h.entity.id)).toEqual([visible.id]);
  expect(await repo.searchMemory("полис", { collectionIds: [] })).toEqual([]);
});

test("an approved fact about someone is typed, dated and linked to that person; a new person gets a record in «Люди»", async () => {
  const { saveApprovedNote, searchApprovedNotes } = require("../../direct-agent/memory");
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const coffee = await saveApprovedNote("guest", { title: "Аня любит кофе", body: "Сестра Аня пьёт капучино", section: "preferences", kind: "preference", person: "Аня" }, repo);
  expect(await repo.entity(coffee)).toMatchObject({ kind: "preference" });
  const [anya] = await repo.entitiesByAlias("аня", "person");
  expect(anya).toMatchObject({ title: "Аня", kind: "person" });
  expect((await repo.relationsForEntity(coffee))).toMatchObject([{ source_entity_id: coffee, target_entity_id: anya.id, kind: "about" }]);
  // The second fact about her links to the same record.
  const birthday = await saveApprovedNote("guest", { title: "День рождения Ани", body: "3 мая", section: "dates", kind: "event", person: "аня", date: "2027-05-03" }, repo);
  expect((await repo.entity(birthday))!.payload.date).toBe("2027-05-03");
  expect((await repo.entity(birthday))!.valid_from).toBe("2027-05-03");
  expect((await repo.relationsForEntity(anya.id)).map(r => r.source_entity_id).sort()).toEqual([coffee, birthday].sort());
  expect((await repo.entities({ kind: "person" })).items).toHaveLength(1);
  // A person record keeps the name it was proposed with as a name to search by.
  const boss = await saveApprovedNote("guest", { title: "Руководитель", body: "Елена Сергеевна, директор", section: "people", kind: "person", person: "Елена Сергеевна" }, repo);
  expect(await repo.aliases(boss)).toEqual(["Елена Сергеевна"]);
  expect((await searchApprovedNotes("guest", "Что знаешь про Елену?", repo)).map((n: any) => n.id)).toContain(boss);
});
