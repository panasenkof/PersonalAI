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
    createEntity: jest.fn().mockResolvedValue({ id: "new-note" }),
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
  const long = "Начало. ".repeat(200);
  repo.searchMemory.mockResolvedValueOnce([{ entity: { id: "long", collection_id: "standard", sensitivity: "standard", record_status: "active",
    title: "Дневник", payload: { body: long + "Ключи у соседа." } }, chunk: "Ключи у соседа.", score: 3 }] as never);
  expect(await searchApprovedNotes("guest", "где ключи", repo as unknown as MemoryRepository))
    .toEqual([{ id: "long", title: "Дневник", body: "Ключи у соседа.", section: "Заметки" }]);
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
