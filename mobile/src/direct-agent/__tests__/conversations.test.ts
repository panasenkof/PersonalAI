import { beginTask } from "../task-state";
import { conversationRepository } from "../conversations";
import { SCHEMA_SQL, withLocalMemoryDatabase } from "../../local-memory/storage";
jest.mock("../../local-memory/storage", () => ({ ...jest.requireActual("../../local-memory/storage"), withLocalMemoryDatabase: jest.fn() }));
const { DatabaseSync } = require("node:sqlite");

test("actual SQL preserves attachments, sources and proposals across reopen, keeps profiles separate, and deletes only the chosen chat", async () => {
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
  const file = {id:"file",name:"note.txt",kind:"text" as const,mime:"text/plain",data:"Text",size:12};
  const conversation = { attachments:[file], id: "first", title: "Рецепт", createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z", question: "",
    rows: [{ id: "u", role: "user" as const, text: "Что приготовить?", attachments:[file] }, { id: "a", role: "assistant" as const, text: "Пасту", sources: ["https://example.org"] }],
    drafts: [{ id: "d", title: "Рецепт", body: "Паста" }], taskState: { ...beginTask(undefined, "Ужин"), selection: "Паста", webPreference: "deny" as const } };
  await guest.save(conversation);
  await guest.save({ ...conversation, title: "Любимый рецепт", updatedAt: "2026-10-13T10:00:00Z" });
  await guest.save({ ...conversation, id: "second", title: "Другой диалог" });
  const reopened = conversationRepository("guest");
  expect((await reopened.load())[0]).toMatchObject({ id: "first", title: "Любимый рецепт", attachments:[file], rows: conversation.rows, drafts: conversation.drafts, taskState: conversation.taskState });
  expect(await conversationRepository("account").load()).toEqual([]);
  await reopened.remove("first"); expect((await reopened.load()).map(c => c.id)).toEqual(["second"]);
  for (const db of databases.values()) db.close();
});

test("one damaged chat does not hide the others and intact messages are kept", async () => {
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA_SQL);
  (withLocalMemoryDatabase as jest.Mock).mockImplementation(async (_profile, work) => work({
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
  }));
  const insert = db.prepare("INSERT INTO direct_conversations(id,title,snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?)");
  insert.run("broken", "x", "{not json", "2026-10-14", "2026-10-14T12:00:00Z");
  insert.run("partly", "Частично", JSON.stringify({ id: "partly", title: "Частично", createdAt: "2026-10-14", updatedAt: "2026-10-14T11:00:00Z",
    rows: [{ id: "ok", role: "user", text: "Целое сообщение", sources: ["https://example.org", "http://bad.test"] }, { id: 5, role: "user" }, null],
    drafts: [{ id: "d", title: "Заметка", body: "Текст" }, { id: "bad" }], question: 3 }), "2026-10-14", "2026-10-14T11:00:00Z");
  insert.run("fine", "Целый", JSON.stringify({ id: "fine", title: "Целый", createdAt: "2026-10-13", updatedAt: "2026-10-13T10:00:00Z", rows: [], drafts: [], question: "" }), "2026-10-13", "2026-10-13T10:00:00Z");
  const skipped = jest.fn();
  const loaded = await conversationRepository("guest", skipped).load();
  expect(loaded.map(c => c.id)).toEqual(["partly", "fine"]);
  expect(loaded[0].rows).toEqual([{ id: "ok", role: "user", text: "Целое сообщение", sources: ["https://example.org"] }]);
  expect(loaded[0].drafts).toEqual([{ id: "d", title: "Заметка", body: "Текст" }]);
  expect(loaded[0].question).toBe("");
  expect(skipped).toHaveBeenCalledWith(1);
  // The unreadable record is left in place for a future repair, never deleted.
  expect(db.prepare("SELECT count(*) AS n FROM direct_conversations").get().n).toBe(3);
  db.close();
});
