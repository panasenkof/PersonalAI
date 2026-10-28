import { saveApprovedNote, searchApprovedNotes } from "../memory";
import type { MemoryRepository } from "../../local-memory/types";

function fake() {
  const repo = {
    listCollections: jest.fn().mockResolvedValue([
      { id: "standard", slug: "notes", name: "Заметки", sensitivity: "standard" },
      { id: "secret", slug: "private", name: "Личное", sensitivity: "secret" },
      { id: "unclassified", slug: "unknown", sensitivity: "unclassified" },
    ]),
    // The repository already filters; the caller checks again, so a fake that
    // returns everything proves no private record can slip through.
    searchMemory: jest.fn(async () => [
      { id: "ok", collection_id: "standard", sensitivity: "standard", record_status: "active",
        title: "Любимое", payload: { body: "Паста" } },
      { id: "hidden", collection_id: "secret", sensitivity: "standard", record_status: "active",
        title: "Секрет", payload: { body: "Нельзя отправлять" } },
      { id: "unknown", collection_id: "unclassified", sensitivity: "inherit", record_status: "active",
        title: "Без категории", payload: { body: "Нельзя отправлять" } },
      { id: "protected", collection_id: "standard", sensitivity: "sensitive", record_status: "active",
        title: "Данные", payload: { body: "Нельзя отправлять" } },
      { id: "archived", collection_id: "standard", sensitivity: "standard", record_status: "archived",
        title: "Архив", payload: { body: "Нельзя отправлять" } },
    ].map(entity => ({ entity, chunk: "", score: 1 }))),
    entity: jest.fn().mockResolvedValue(null),
    createEntity: jest.fn().mockResolvedValue({ id: "new-note" }),
    entitiesByAlias: jest.fn().mockResolvedValue([]),
    linkEntities: jest.fn().mockResolvedValue({ id: "relation-1" }),
    createCollection: jest.fn(async (c: any) => ({ id: c.slug, description: null, created_at: "2026-10-14", ...c })),
  };
  return repo;
}

test("memory is available without a separate permission flag", async () => {
  const repo = fake();
  await expect(searchApprovedNotes("guest", "кухня", repo as unknown as MemoryRepository))
    .resolves.toEqual([{ id: "ok", title: "Любимое", body: "Паста", section: "Заметки" }]);
  expect(repo.listCollections).toHaveBeenCalled();
});

test("only standard active notes can leave the device", async () => {
  const repo = fake();
  const found = await searchApprovedNotes("guest", "паста", repo as unknown as MemoryRepository);
  expect(found).toEqual([{ id: "ok", title: "Любимое", body: "Паста", section: "Заметки" }]);
  expect(repo.searchMemory).toHaveBeenCalledWith("паста", { collectionIds: ["standard"], sensitivities: ["standard", "inherit"], limit: 5 });
});

test("short queries never bulk-export the database", async () => {
  const repo = fake();
  const found = await searchApprovedNotes("guest", "a", repo as unknown as MemoryRepository);
  expect(found).toEqual([]);
  expect(repo.searchMemory).not.toHaveBeenCalled();
});

test("save creates a standard note only after caller explicitly approves", async () => {
  const repo = fake();
  const id = await saveApprovedNote("guest", { title: "Еда", body: "Люблю пасту" }, repo as unknown as MemoryRepository);
  expect(id).toBe("new-note");
  expect(repo.createEntity).toHaveBeenCalledWith(expect.objectContaining({
    collection_id: "standard", sensitivity: "standard", source_kind: "user",
    payload: { type: "note", title: "Еда", body: "Люблю пасту" },
  }));
});

test("refuses to write into a nonstandard notes collection", async () => {
  const repo = fake();
  repo.listCollections.mockResolvedValue([{ id: "closed", slug: "notes", sensitivity: "secret" }]);
  await expect(saveApprovedNote("guest", { title: "T", body: "B" }, repo as unknown as MemoryRepository))
    .rejects.toThrow("ограничен");
  expect(repo.createEntity).not.toHaveBeenCalled();
});

test("a proposal goes into its section; missing built-in sections are created once", async () => {
  const repo = fake();
  await saveApprovedNote("guest", { title: "Аня", body: "Сестра, любит кофе", section: "people" }, repo as unknown as MemoryRepository);
  expect(repo.createCollection).toHaveBeenCalledWith(expect.objectContaining({ slug: "people", name: "Люди", sensitivity: "standard" }));
  expect(repo.createCollection).toHaveBeenCalledWith(expect.objectContaining({ slug: "documents", sensitivity: "sensitive" }));
  expect(repo.createCollection).not.toHaveBeenCalledWith(expect.objectContaining({ slug: "notes" }));
  expect(repo.createEntity).toHaveBeenCalledWith(expect.objectContaining({ collection_id: "people", sensitivity: "standard" }));
});

test("documents stay personal and an unknown section falls back to notes", async () => {
  const repo = fake();
  await saveApprovedNote("guest", { title: "Полис", body: "ОСАГО до мая", section: "documents" }, repo as unknown as MemoryRepository);
  expect(repo.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ collection_id: "documents", sensitivity: "sensitive" }));
  await saveApprovedNote("guest", { title: "Идея", body: "Текст", section: "nonsense" as any }, repo as unknown as MemoryRepository);
  expect(repo.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ collection_id: "standard" }));
});

test("a long record sends the chunk that matched, not its beginning", async () => {
  const repo = fake();
  const long = "Начало. ".repeat(2000);
  repo.searchMemory.mockResolvedValueOnce([{ entity: { id: "long", collection_id: "standard", sensitivity: "standard", record_status: "active",
    title: "Дневник", payload: { body: long + "Ключи у соседа." } }, chunk: "Ключи у соседа.", score: 3 }] as never);
  expect(await searchApprovedNotes("guest", "где ключи", repo as unknown as MemoryRepository))
    .toEqual([{ id: "long", title: "Дневник", body: "Ключи у соседа.", excerptOnly: true,
      totalChars: (long + "Ключи у соседа.").length, section: "Заметки" }]);
});

test("a proposal goes to the user's own section, or creates the section the user asked for on save", async () => {
  const repo = fake();
  repo.listCollections.mockResolvedValue([
    { id: "standard", slug: "notes", name: "Заметки", sensitivity: "standard" },
    { id: "recipes", slug: "section-1", name: "Рецепты", sensitivity: "standard" },
  ]);
  await saveApprovedNote("guest", { title: "Борщ", body: "Свёкла", section: "section-1" }, repo as unknown as MemoryRepository);
  expect(repo.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ collection_id: "recipes" }));
  // A section that was proposed as new but already exists by name is reused.
  await saveApprovedNote("guest", { title: "Щи", body: "Капуста", newSection: "рецепты" }, repo as unknown as MemoryRepository);
  expect(repo.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ collection_id: "recipes" }));
  await saveApprovedNote("guest", { title: "Цепь", body: "Сменить", newSection: "Гараж" }, repo as unknown as MemoryRepository);
  expect(repo.createCollection).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Гараж", sensitivity: "standard" }));
  expect(repo.createEntity).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Цепь" }));
});

test("listing sections for the model never writes to memory", async () => {
  const { proposableMemorySections } = require("../memory");
  const repo = fake();
  repo.listCollections.mockResolvedValue([
    { id: "r", slug: "section-1", name: "Рецепты", sensitivity: "standard", created_at: "2026-10-16" },
    { id: "n", slug: "notes", name: "Заметки", sensitivity: "standard", created_at: "2026-10-15" },
  ]);
  const sections = await proposableMemorySections("guest", repo as unknown as MemoryRepository);
  expect(repo.createCollection).not.toHaveBeenCalled();
  expect(sections.map((s: any) => s.name)).toEqual(["Обо мне", "Люди", "Дела и проекты", "Предпочтения", "Важные даты", "Заметки", "Рецепты"]);
});

test("a saved recipe longer than 900 characters is returned in full, including its ending", async () => {
  const repo = fake();
  const recipe = "Красная рыба под шубой.\n" + "Описание и подготовка. ".repeat(70) +
    "\nИнгредиенты:\nрыба, картофель, яйца\nСлои:\nрыба, картофель, яйца\nЗаправка: майонез.";
  repo.searchMemory.mockResolvedValueOnce([{ entity: { id: "recipe", collection_id: "standard", sensitivity: "standard",
    record_status: "active", title: "Красная рыба под шубой", payload: { body: recipe } },
    chunk: "Красная рыба под шубой.", score: 3 }] as never);
  expect(recipe.length).toBeGreaterThan(900);
  const found = await searchApprovedNotes("guest", "рыба под шубой", repo as unknown as MemoryRepository);
  expect(found).toEqual([{ id: "recipe", title: "Красная рыба под шубой", body: recipe, section: "Заметки" }]);
  expect(found[0].body).toContain("Заправка: майонез");
});

test("full notes share a bounded model context and overflow notes are marked as excerpts", async () => {
  const repo = fake();
  const long = "Рецепт с ингредиентами и слоями. ".repeat(300);
  repo.searchMemory.mockResolvedValueOnce([1, 2, 3, 4, 5].map(i => ({
    entity: { id: String(i), collection_id: "standard", sensitivity: "standard", record_status: "active",
      title: "Рецепт " + i, payload: { body: long } },
    chunk: "Ингредиенты рецепта " + i, score: 3,
  })) as never);
  const found = await searchApprovedNotes("guest", "рецепт", repo as unknown as MemoryRepository);
  expect(found).toHaveLength(5);
  expect(found.map(n => n.body.length).reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(24_000);
  expect(found[0].body).toBe(long);
  expect(found.some(n => n.excerptOnly)).toBe(true);
  for (const note of found.filter(n => n.excerptOnly)) expect(note.totalChars).toBe(long.length);
});

test("approved and model-proposed notes over 4000 characters are never silently cut", async () => {
  const { factProposal, MAX_NOTE_BODY_CHARS } = require("../fact-tool");
  const repo = fake();
  const body = "Ингредиенты:\n" + "Помидоры, рыба, лук. ".repeat(300) + "\nПоследний слой: яйца.";
  expect(body.length).toBeGreaterThan(4000);
  expect(factProposal({ title: "Салат", body }).body).toBe(body);
  await saveApprovedNote("guest", { title: "Салат", body }, repo as unknown as MemoryRepository);
  expect(repo.createEntity).toHaveBeenCalledWith(expect.objectContaining({ payload: { type: "note", title: "Салат", body } }));
  expect(() => factProposal({ title: "Салат", body: "A".repeat(MAX_NOTE_BODY_CHARS + 1) })).toThrow("note_body_too_long");
  await expect(saveApprovedNote("guest", { title: "Салат", body: "A".repeat(MAX_NOTE_BODY_CHARS + 1) },
    repo as unknown as MemoryRepository)).rejects.toThrow("слишком длинная");
});

test("read evidence is version checked, paginated and never implies full coverage", async () => {
  const { readApprovedNote } = require("../memory");
  const repo = fake();
  const body = "Начало.".repeat(1300) + "КОНЕЦ";
  repo.entity = jest.fn().mockResolvedValue({
    id: "allow", collection_id: "standard", domain: "notes", sensitivity: "standard",
    record_status: "active", record_version: 7, title: "Длинная заметка",
    source_ref: "local-original", payload: { body },
  });
  const first = await readApprovedNote("guest", "allow", 7, 0, 500, repo as unknown as MemoryRepository);
  expect(first).toMatchObject({ id: "allow", revision: 7, offset: 0, hasMore: true,
    totalChars: body.length, nextOffset: 500, source: { recordId: "allow", sourceRef: "local-original", location: "unknown" } });
  expect(first.content).toBe(body.slice(0, 500));
  await expect(readApprovedNote("guest", "allow", 7, body.length + 1, 500, repo as unknown as MemoryRepository)).rejects.toThrow("invalid_memory_read_range");
  expect(first.evidence).toEqual({ recordId: "allow", recordVersion: 7, startChar: 0,
    endChar: 500, coverage: "excerpt", originalPage: null, originalTime: null });
  const last = await readApprovedNote("guest", "allow", 7, first.nextOffset, 500, repo as unknown as MemoryRepository);
  expect(last.offset).toBe(500);
  await expect(readApprovedNote("guest", "allow", 6, 0, 500, repo as unknown as MemoryRepository))
    .rejects.toThrow("stale_memory_version");
});

test("read evidence rechecks privacy, status and bound before exposing text", async () => {
  const { readApprovedNote } = require("../memory");
  const repo = fake();
  repo.entity = jest.fn().mockResolvedValue({
    id: "hidden", collection_id: "secret", domain: "notes", sensitivity: "standard",
    record_status: "active", record_version: 1, title: "Секрет", payload: { body: "закрытый текст" },
  });
  await expect(readApprovedNote("guest", "hidden", 1, 0, 900, repo as unknown as MemoryRepository))
    .rejects.toThrow("memory_read_not_available");
  repo.entity.mockResolvedValueOnce({
    id: "deleted", collection_id: "standard", domain: "notes", sensitivity: "standard",
    record_status: "trashed", record_version: 1, payload: { body: "архив" },
  });
  await expect(readApprovedNote("guest", "deleted", 1, 0, 900, repo as unknown as MemoryRepository))
    .rejects.toThrow("memory_read_not_available");
  await expect(readApprovedNote("guest", "hidden", 0, 0, 900, repo as unknown as MemoryRepository))
    .rejects.toThrow("invalid_memory_read_request");
});


test.each([
  ["Мария", "Мария", "мария"],["Елена", "Лена", "Лена"],
  ["Максим", "Максим", "Максим"],
])("R4: two namesakes (%s) must never choose a random identity before save", async (_label, first, second) => {
  const repo=fake();
  repo.entitiesByAlias.mockResolvedValue([
    {id:"person-1",collection_id:"standard",sensitivity:"standard",record_status:"active",title:first},
    {id:"person-2",collection_id:"standard",sensitivity:"standard",record_status:"active",title:second},
  ]);
  await expect(saveApprovedNote("guest",{
    title:"Обсуждение поездки",body:"Разговор о дороге",person:first,
  },repo as unknown as MemoryRepository)).rejects.toThrow("Личность неоднозначна");
  expect(repo.createEntity).not.toHaveBeenCalled();
  expect(repo.linkEntities).not.toHaveBeenCalled();
});

test("ambiguous identity never creates the user-requested custom section",async()=>{
  const repo=fake();
  repo.entitiesByAlias.mockResolvedValue([
    {id:"person-a",collection_id:"standard",sensitivity:"standard",record_status:"active"},
    {id:"person-b",collection_id:"standard",sensitivity:"standard",record_status:"active"},
  ]);
  await expect(saveApprovedNote("guest",{
    title:"Разговор",body:"Обсудили маршрут",person:"Мария",
    newSection:"Новый проект без источников",
  },repo as unknown as MemoryRepository)).rejects.toThrow("Личность неоднозначна");
  expect(repo.createCollection).not.toHaveBeenCalledWith(
    expect.objectContaining({name:"Новый проект без источников"}));
  expect(repo.createEntity).not.toHaveBeenCalled();
  expect(repo.linkEntities).not.toHaveBeenCalled();
});

test.each([
  ["secret","secret","standard"],
  ["standard","standard","secret"],
  ["unclassified","unclassified","inherit"],
])("R8: %s person cannot be silently linked into a public user-approved note",async (_name,collectionId,sensitivity)=>{
  const repo=fake();
  repo.entitiesByAlias.mockResolvedValue([
    {id:"person-private",collection_id:collectionId,sensitivity,record_status:"active",title:"Доктор Ирина"},
  ]);
  await expect(saveApprovedNote("guest",{
    title:"Визит",body:"Поговорил с врачом",person:"Доктор Ирина",
  },repo as unknown as MemoryRepository)).rejects.toThrow("Автоматическая связь");
  expect(repo.createEntity).not.toHaveBeenCalled();
  expect(repo.linkEntities).not.toHaveBeenCalled();
});

test("a unique standard person is linked by stable ID, not guessed name search",async()=>{
  const repo=fake();
  repo.entitiesByAlias.mockResolvedValue([
    {id:"person-1",collection_id:"standard",sensitivity:"standard",record_status:"active",title:"Коллега Мария"},
  ]);
  const saved=await saveApprovedNote("guest",{
    title:"Совещание",body:"Проект и сроки",person:"Мария",
  },repo as unknown as MemoryRepository);
  expect(saved).toBe("new-note");
  expect(repo.linkEntities).toHaveBeenCalledWith("new-note","person-1","about");
  expect(repo.createEntity).toHaveBeenCalledTimes(1);
});

test("person in a sensitive section requires explicit resolution; no half-saved note",async()=>{
  const repo=fake();
  await expect(saveApprovedNote("guest",{
    title:"Медицинский документ",body:"Обсуждение обследования",
    section:"documents",person:"Врач",
  },repo as unknown as MemoryRepository)).rejects.toThrow("закрытом разделе");
  expect(repo.createEntity).not.toHaveBeenCalled();
  expect(repo.entitiesByAlias).not.toHaveBeenCalled();
  expect(repo.linkEntities).not.toHaveBeenCalled();
});

test("new name with no candidates creates a separate person and links through legacy canonical relation",async()=>{
  const repo=fake();
  repo.createEntity.mockResolvedValueOnce({id:"fact-1"}).mockResolvedValueOnce({id:"new-person-1"});
  const id=await saveApprovedNote("guest",{
    title:"День рождения",body:"Пётр родился в апреле",person:"Пётр",
  },repo as unknown as MemoryRepository);
  expect(id).toBe("fact-1");
  expect(repo.entitiesByAlias).toHaveBeenCalledWith("Пётр","person");
  expect(repo.linkEntities).toHaveBeenCalledWith("fact-1","new-person-1","about");
});
