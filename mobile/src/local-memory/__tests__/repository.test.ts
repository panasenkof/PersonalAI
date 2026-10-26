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
  // A text edit keeps user names/words, but model words need the new version.
  await repo.reviseEntity(lena.id, 1, { title: "Елена Сергеевна", body: "Директор по продажам" }, "Повышение");
  expect(await repo.searchNotes("босс")).toHaveLength(0);
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

test("vectors: pending chunks, saved vectors, staleness on edit, and search by meaning fused with words", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  const people = await repo.createCollection({ name: "Люди", slug: "people", sensitivity: "standard" });
  const docs = await repo.createCollection({ name: "Документы", slug: "documents", sensitivity: "sensitive" });
  const coffee = await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Что любит Аня", payload: { body: "Обожает капучино" } });
  const roads = await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Дорога", payload: { body: "Пробки на мосту" } });
  const polis = await repo.createEntity({ collection_id: docs.id, domain: "notes", title: "ОСАГО", payload: { body: "Полис до мая" }, sensitivity: "sensitive" });
  // A toy model: «угощение/кофе» lies along x, «дорога» along y, «страховка» along z.
  const embed = (text: string) => /кофе|капучино|угост/i.test(text) ? Float32Array.from([1, 0.1, 0]) : /Дорога|Пробки/.test(text) ? Float32Array.from([0, 1, 0]) : Float32Array.from([0, 0, 1]);
  const pending = await repo.pendingVectorChunks("toy", 50);
  expect(pending.map(p => p.text).sort()).toEqual(["ОСАГО\nПолис до мая", "Дорога\nПробки на мосту", "Что любит Аня\nОбожает капучино"].sort());
  expect(await repo.saveVectors("toy", pending.map(p => ({ chunkId: p.chunkId, vector: embed(p.text), hash: p.hash })))).toBe(3);
  expect(await repo.vectorStatus("toy")).toEqual({ done: 3, total: 3 });
  expect(await repo.pendingVectorChunks("toy")).toEqual([]);
  // A title change makes that chunk's vector stale.
  await repo.reviseEntity(roads.id, 1, { title: "Дорога на работу", body: "Пробки на мосту" }, "Уточнение");
  expect((await repo.pendingVectorChunks("toy")).map(p => p.text)).toEqual(["Дорога на работу\nПробки на мосту"]);
  // «Чем угостить Аню?» shares no word with «Обожает капучино»; the vector finds it.
  const question = { model: "toy", values: Float32Array.from([1, 0, 0]) };
  const hits = await repo.searchMemory("Чем угостить гостью?", { vector: question });
  expect(hits[0].entity.id).toBe(coffee.id);
  expect(hits[0].chunk).toBe("Обожает капучино");
  // Unrelated records stay out (below the similarity threshold), and filters still apply.
  expect(hits.map(h => h.entity.id)).not.toContain(roads.id);
  expect((await repo.searchMemory("страховка", { vector: { model: "toy", values: Float32Array.from([0, 0, 1]) }, collectionIds: [people.id] })).map(h => h.entity.id)).not.toContain(polis.id);
  // Without a vector the word search is unchanged.
  expect(await repo.searchMemory("Чем угостить гостью?")).toEqual([]);
});


test("file text and annotation are both searchable and vectorized; edits invalidate only changed chunks", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const col = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  const note = await repo.createEntity({ collection_id: col.id, domain: "notes", title: "scan.png", payload: { body: "Куплено для поездки", extracted_text: "Гарантия на холодильник до 2030 года" }, sensitivity: "standard" });
  expect((await repo.searchMemory("холодильник"))[0].entity.id).toBe(note.id);
  expect((await repo.searchMemory("поездки"))[0].entity.id).toBe(note.id);
  const chunks = await repo.pendingVectorChunks("test");
  expect(chunks.map(c => c.text).join(" ")).toContain("Гарантия");
  expect(chunks.map(c => c.text).join(" ")).toContain("Куплено");
  await repo.saveVectors("test", chunks.map(c => ({ chunkId: c.chunkId, hash: c.hash, vector: new Float32Array([1, 0]) })));
  await repo.reviseEntity(note.id, 1, { body: "Куплено для поездки", extracted_text: "Новая квитанция" }, "Исправление");
  expect(await repo.searchMemory("холодильник")).toEqual([]);
  expect((await repo.pendingVectorChunks("test")).length).toBeGreaterThan(0);
});
test("explicit approval makes an old private imported note visible; ordinary move does not", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const inbox = await repo.createCollection({ name: "Входящие", slug: "inbox", sensitivity: "sensitive" });
  const notes = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  const note = await repo.createEntity({ collection_id: inbox.id, domain: "notes", payload: { body: "Рецепт супа" }, sensitivity: "sensitive" });
  const moved = await repo.reviseEntity(note.id, 1, note.payload, "Перенос", notes.id);
  expect(moved.sensitivity).toBe("sensitive");
  const approved = await repo.reviseEntity(note.id, 2, note.payload, "Разрешён доступ", notes.id, true);
  expect(approved.sensitivity).toBe("standard");
  await expect(repo.reviseEntity(note.id, 2, note.payload, "Устаревшее разрешение", notes.id, true)).rejects.toThrow();
});

test('bulk move and trash are atomic, private notes stay private, undo survives repository recreation', async () => {
  const sql = new FakeSqlite(); const repo = new SqliteMemoryRepository(sql as never);
  const a = await repo.createCollection({ name: 'Личное', slug: 'private', sensitivity: 'sensitive' });
  const b = await repo.createCollection({ name: 'Заметки', slug: 'notes', sensitivity: 'standard' });
  const first = await repo.createEntity({ collection_id: a.id, domain: 'notes', payload: { body: 'Гарантия' } });
  const second = await repo.createEntity({ collection_id: a.id, domain: 'notes', payload: { body: 'Квитанция' } });
  await expect(repo.changeNotes('move', [first, { ...second, record_version: 99 }], b.id)).rejects.toThrow();
  expect((await repo.entity(first.id))?.collection_id).toBe(a.id);
  const token = await repo.changeNotes('move', [first, second], b.id);
  expect((await repo.entity(first.id))?.sensitivity).toBe('sensitive');
  await new SqliteMemoryRepository(sql as never).undoNotes(token);
  expect((await repo.entity(first.id))?.collection_id).toBe(a.id);
  const updated = [await repo.entity(first.id), await repo.entity(second.id)] as any;
  const deleted = await repo.changeNotes('trash', updated);
  expect(await repo.searchMemory('Гарантия')).toEqual([]);
  expect((await repo.searchNotes('', 50, 0, { status: 'trashed' })).length).toBe(2);
  await repo.undoNotes(deleted);
  expect((await repo.searchMemory('Гарантия')).length).toBe(1);
});
test('merge preserves originals, sources and contradictory text; undo restores ownership and refuses later edits', async () => {
  const sql = new FakeSqlite(); const repo = new SqliteMemoryRepository(sql as never);
  const col = await repo.createCollection({ name: 'Заметки', slug: 'notes', sensitivity: 'standard' });
  const a = await repo.createEntity({ collection_id: col.id, domain: 'notes', title: 'Первый', payload: { body: 'Цена 100', extracted_text: 'Чек 2026' } });
  const b = await repo.createEntity({ collection_id: col.id, domain: 'notes', title: 'Второй', payload: { body: 'Цена 200', source_url: 'https://example.org' }, sensitivity: 'sensitive' });
  await sql.runAsync('INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)', ['photo-a', a.id, 'a.png', 'image/png', 10, 'now']);
  await sql.runAsync('INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)', ['photo', b.id, 'photo.png', 'image/png', 10, 'now']);
  const token = await repo.changeNotes('merge', [a, b]);
  const merged = (await repo.entity(a.id))!;
  expect(merged.payload.body).toContain('Цена 100'); expect(merged.payload.body).toContain('Цена 200'); expect(merged.payload.body).toContain('Чек 2026');
  expect(merged.sensitivity).toBe('sensitive');
  expect((await sql.getFirstAsync<any>('SELECT entity_id FROM memory_attachments WHERE id=?', ['photo'])).entity_id).toBe(a.id);
  expect((await repo.entity(b.id))?.record_status).toBe('superseded');
  await repo.undoNotes(token);
  expect((await sql.getFirstAsync<any>('SELECT entity_id FROM memory_attachments WHERE id=?', ['photo'])).entity_id).toBe(b.id);
  expect((await repo.entity(b.id))?.record_status).toBe('active');
  const again = await repo.changeNotes('merge', [(await repo.entity(a.id))!, (await repo.entity(b.id))!]);
  const latest = (await repo.entity(a.id))!;
  await repo.reviseEntity(latest.id, latest.record_version, { body: 'Новая правка' }, 'После объединения');
  await expect(repo.undoNotes(again)).rejects.toThrow();
  expect((await repo.entity(a.id))?.payload.body).toBe('Новая правка');
});


test("semantic search rejects stale title vectors and late inference after edits", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const col = await repo.createCollection({ name: "Notes", slug: "notes" });
  const note = await repo.createEntity({ collection_id: col.id, domain: "notes", title: "Coffee", payload: { body: "details" } });
  const [old] = await repo.pendingVectorChunks("toy");
  const vector = new Float32Array([1, 0]);
  await repo.saveVectors("toy", [{ ...old, vector }]);
  expect(await repo.vectorMatches("toy", vector)).toHaveLength(1);
  await repo.reviseEntity(note.id, 1, { title: "Road", body: "details" }, "rename");
  expect(await repo.vectorMatches("toy", vector)).toEqual([]);
  expect(await repo.saveVectors("toy", [{ ...old, vector }])).toBe(0);
  const [fresh] = await repo.pendingVectorChunks("toy");
  expect(await repo.saveVectors("toy", [{ ...fresh, vector: new Float32Array([NaN, 0]) }])).toBe(0);
  expect(await repo.saveVectors("toy", [{ ...fresh, vector }])).toBe(1);
  await repo.reviseEntity(note.id, 2, { title: "Road", body: "changed" }, "edit during inference");
  expect(await repo.saveVectors("toy", [{ ...fresh, vector }])).toBe(0);
  expect(await repo.vectorMatches("toy", vector)).toEqual([]);
});

test("semantic search follows move, trash, restore, merge, undo and permanent deletion", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const a = await repo.createCollection({ name: "A", slug: "a" });
  const b = await repo.createCollection({ name: "B", slug: "b" });
  const first = await repo.createEntity({ collection_id: a.id, domain: "notes", title: "First", payload: { body: "alpha" } });
  const second = await repo.createEntity({ collection_id: a.id, domain: "notes", title: "Second", payload: { body: "beta" } });
  const vector = new Float32Array([1, 0]);
  const index = async () => repo.saveVectors("toy", (await repo.pendingVectorChunks("toy")).map(c => ({ ...c, vector })));
  const ids = async (collectionIds?: string[]) => (await repo.vectorMatches("toy", vector, { collectionIds })).map(h => h.row.id);
  const selected = async (id: string) => (await repo.entity(id))!;
  await index();
  await repo.changeNotes("move", [await selected(first.id)], b.id);
  expect(await ids([a.id])).toEqual([second.id]);
  expect(await ids([b.id])).toEqual([first.id]);
  await repo.changeNotes("trash", [await selected(first.id)]);
  expect(await ids()).toEqual([second.id]);
  await repo.changeNotes("restore", [await selected(first.id)]);
  expect((await ids()).sort()).toEqual([first.id, second.id].sort());
  const merge = await repo.changeNotes("merge", [await selected(first.id), await selected(second.id)]);
  await index();
  expect(await ids()).toEqual([first.id]);
  await repo.undoNotes(merge);
  await index();
  expect((await ids()).sort()).toEqual([first.id, second.id].sort());
  await repo.changeNotes("trash", [await selected(first.id)]);
  await repo.purgeNotes([await selected(first.id)]);
  expect(await ids()).toEqual([second.id]);
});

test("collection counts exclude archived records", async () => {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const a = await repo.createCollection({ name: "Фото", slug: "photos" });
  const b = await repo.createCollection({ name: "Текст", slug: "text" });
  await repo.createEntity({ collection_id: a.id, domain: "notes", title: "Один", payload: { body: "A" } });
  const archived = await repo.createEntity({ collection_id: a.id, domain: "notes", title: "Архив", payload: { body: "B" } });
  await repo.setEntityStatus(archived.id, archived.record_version, "archived");
  await repo.createEntity({ collection_id: b.id, domain: "notes", title: "Два", payload: { body: "C" } });
  expect(await repo.collectionNoteCounts()).toEqual({ [a.id]: 1, [b.id]: 1 });
});

test('batch archive/unarchive preserve originals, rollback stale batches and support undo', async () => {
  const sql = new FakeSqlite(); const repo = new SqliteMemoryRepository(sql as never);
  const col = await repo.createCollection({ name: 'Заметки', slug: 'notes', sensitivity: 'standard' });
  const a = await repo.createEntity({ collection_id: col.id, domain: 'notes', title: 'Гарантия', payload: { body: 'Гарантия' } });
  const b = await repo.createEntity({ collection_id: col.id, domain: 'notes', title: 'Чек', payload: { body: 'Чек' } });
  await sql.runAsync('INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)', ['photo', a.id, 'photo.png', 'image/png', 10, 'now']);
  await expect(repo.changeNotes('archive', [a, { ...b, record_version: 99 }])).rejects.toThrow();
  expect((await repo.entity(a.id))?.record_status).toBe('active');
  const token = await repo.changeNotes('archive', [a, b]);
  expect(await repo.lastNoteOperation()).toBe(token);
  expect((await repo.searchNotes('', 50, 0, { status: 'archived' })).length).toBe(2);
  expect(await repo.searchMemory('Гарантия')).toEqual([]);
  expect((await repo.entity(a.id))?.payload).toEqual(a.payload);
  expect(await sql.getFirstAsync('SELECT entity_id FROM memory_attachments WHERE id=?', ['photo'])).toEqual({ entity_id: a.id });
  await repo.undoNotes(token);
  expect((await repo.entity(a.id))?.record_status).toBe('active');
  await repo.changeNotes('archive', [(await repo.entity(a.id))!, (await repo.entity(b.id))!]);
  const back = await repo.changeNotes('unarchive', [(await repo.entity(a.id))!, (await repo.entity(b.id))!]);
  expect((await repo.entity(a.id))?.record_status).toBe('active');
  await repo.undoNotes(back);
  expect((await repo.searchNotes('', 50, 0, { status: 'archived' })).length).toBe(2);
  await expect(repo.undoNotes(token)).rejects.toThrow();
});
