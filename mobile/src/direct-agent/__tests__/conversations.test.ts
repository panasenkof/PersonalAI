import { conversationRepository } from "../conversations";
import { SCHEMA_SQL, withLocalMemoryDatabase } from "../../local-memory/storage";
jest.mock("../../local-memory/storage", () => ({ ...jest.requireActual("../../local-memory/storage"), withLocalMemoryDatabase: jest.fn() }));
const { DatabaseSync } = require("node:sqlite");

test("actual SQL preserves sources and proposals across reopen, keeps profiles separate, and deletes only the chosen chat", async () => {
  const databases = new Map<string, any>();
  (withLocalMemoryDatabase as jest.Mock).mockImplementation(async (profile, work) => {
    if (!databases.has(profile)) { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA_SQL); databases.set(profile, db); }
    const db = databases.get(profile);
    return work({
      getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    });
  });
  const guest = conversationRepository("guest");
  const conversation = { id: "first", title: "Рецепт", createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z", question: "",
    rows: [{ id: "u", role: "user" as const, text: "Что приготовить?" }, { id: "a", role: "assistant" as const, text: "Пасту", sources: ["https://example.org"] }],
    drafts: [{ id: "d", title: "Рецепт", body: "Паста" }] };
  await guest.save(conversation);
  await guest.save({ ...conversation, title: "Любимый рецепт", updatedAt: "2026-10-13T10:00:00Z" });
  await guest.save({ ...conversation, id: "second", title: "Другой диалог" });
  const reopened = conversationRepository("guest");
  expect((await reopened.load())[0]).toMatchObject({ id: "first", title: "Любимый рецепт", rows: conversation.rows, drafts: conversation.drafts });
  expect(await conversationRepository("account").load()).toEqual([]);
  await reopened.remove("first"); expect((await reopened.load()).map(c => c.id)).toEqual(["second"]);
  for (const db of databases.values()) db.close();
});
