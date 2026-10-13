import { saveApprovedNote, searchApprovedNotes } from "../memory";
import type { MemoryRepository } from "../../local-memory/types";

function fake() {
  const repo = {
    listCollections: jest.fn().mockResolvedValue([
      { id: "standard", slug: "notes", name: "Заметки", sensitivity: "standard" },
      { id: "secret", slug: "private", name: "Личное", sensitivity: "secret" },
      { id: "unclassified", slug: "unknown", sensitivity: "unclassified" },
    ]),
    searchNotes: jest.fn().mockResolvedValue([
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
    ]),
    createEntity: jest.fn().mockResolvedValue({ id: "new-note" }),
    createCollection: jest.fn(),
  };
  return repo;
}

test("memory is available without a separate permission flag", async () => {
  const repo = fake();
  await expect(searchApprovedNotes("guest", "кухня", repo as unknown as MemoryRepository))
    .resolves.toEqual([{ id: "ok", title: "Любимое", body: "Паста" }]);
  expect(repo.listCollections).toHaveBeenCalled();
});

test("only standard active notes can leave the device", async () => {
  const repo = fake();
  const found = await searchApprovedNotes("guest", "паста", repo as unknown as MemoryRepository);
  expect(found).toEqual([{ id: "ok", title: "Любимое", body: "Паста" }]);
  expect(repo.searchNotes).toHaveBeenCalled();
});

test("short queries never bulk-export the database", async () => {
  const repo = fake();
  const found = await searchApprovedNotes("guest", "a", repo as unknown as MemoryRepository);
  expect(found).toEqual([]);
  expect(repo.searchNotes).not.toHaveBeenCalled();
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
    .rejects.toThrow("ограничена");
  expect(repo.createEntity).not.toHaveBeenCalled();
});
