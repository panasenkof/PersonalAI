import type { CollectionRecord, EntityRecord, MemoryRepository } from "../../local-memory/types";
import { createInboxTriageAccess, MAX_INBOX_TRIAGE_ITEMS, MAX_INBOX_TRIAGE_EXCERPT } from "../inbox-triage";

jest.mock("../../local-memory/storage", () => ({
  localMemorySessionUnlocked: jest.fn(() => true),
}));

const inbox: CollectionRecord = {
  id: "collection-inbox", name: "Входящие", slug: "inbox", description: null,
  sensitivity: "sensitive", created_at: "2026-11-13T10:00:00.000Z",
};
const note = (id: string, options: Partial<EntityRecord> = {}): EntityRecord => ({
  id, collection_id: inbox.id, domain: "notes", schema_version: "1",
  title: "Запись " + id, payload: { body: "Конфиденциальный текст " + id, tags: ["AI", "встреча"] },
  record_status: "active", sensitivity: "inherit", source_kind: null, source_ref: null,
  valid_from: null, valid_until: null, created_at: "2026-11-13T10:00:00.000Z",
  updated_at: "2026-11-13T10:00:00.000Z", record_version: 3, kind: "note",
  ...options,
});
type ReadRepo = Pick<MemoryRepository, "listCollections" | "entities">;
function repo(rows: EntityRecord[], sections = [inbox]): ReadRepo {
  return {
    listCollections: jest.fn(async () => sections),
    entities: jest.fn(async options => {
      const offset = options?.offset || 0, limit = options?.limit || 20;
      const filtered = rows.filter(r =>
        (!options?.collection_id || r.collection_id === options.collection_id) &&
        (!options?.domain || r.domain === options.domain));
      return {
        items: filtered.slice(offset, offset + limit),
        next_offset: filtered.length > offset + limit ? offset + limit : null,
      };
    }),
  };
}

test("S9-1a: no content reading before an exact explicit user tap", async () => {
  const reader = repo([note("a")]);
  const access = createInboxTriageAccess("chat-1", () => true);
  expect(access.beginTurn("t1")).toBe(false);
  await expect(access.listForTurn("t1", reader, {limit:1})).rejects.toThrow("inbox_triage_not_authorized");
  expect(reader.listCollections).not.toHaveBeenCalled();
  expect(reader.entities).not.toHaveBeenCalled();
  expect(access.approveFromUserTap("chat-1")).toBe(false);

  const card = access.requestApproval(2);
  expect(card).toEqual({conversationId:"chat-1",limit:2,label:"Разрешить разбор 2 записей из «Входящих»"});
  expect(reader.listCollections).not.toHaveBeenCalled();
  expect(access.approveFromUserTap("chat-other")).toBe(false);
  expect(access.beginTurn("t1")).toBe(false);
  expect(access.approveFromUserTap("chat-1")).toBe(true);
  expect(access.approveFromUserTap("chat-1")).toBe(false);
  expect(access.beginTurn("t1")).toBe(true);
  expect(access.beginTurn("t2")).toBe(false);
  await expect(access.listForTurn("t2", reader, {limit:1})).rejects.toThrow("inbox_triage_not_authorized");
  expect((await access.listForTurn("t1", reader, {limit:1})).items).toHaveLength(1);
  access.endTurn("t1");
  expect(access.beginTurn("t2")).toBe(false);
  await expect(access.listForTurn("t1", reader, {limit:1})).rejects.toThrow("inbox_triage_not_authorized");
});

test("S9-1a: return only active Inbox note metadata and first 600 text characters", async () => {
  const rows = [
    note("archived", {record_status: "archived"}),
    note("one", {payload:{body:"Т".repeat(900),tags:["AI","встреча"]}}),
    note("trashed", {record_status: "trashed"}),
    note("two", {record_version:8, payload:{body:"Второй текст",tags:["новое"]}}),
  ];
  const access = createInboxTriageAccess("c", () => true);
  const reader = repo(rows);
  access.requestApproval(2);
  expect(access.approveFromUserTap("c")).toBe(true);
  expect(access.beginTurn("turn")).toBe(true);
  const page = await access.listForTurn("turn", reader, {limit:2});
  expect(page.items.map(item => item.noteId)).toEqual(["one","two"]);
  expect(page.items[0]).toMatchObject({expectedVersion:3,title:"Запись one",tags:["ai","встреча"]});
  expect(page.items[0].excerpt).toHaveLength(MAX_INBOX_TRIAGE_EXCERPT);
  expect(page.items[0].excerpt).toBe("Т".repeat(MAX_INBOX_TRIAGE_EXCERPT));
  expect(access.wasReadThisTurn("turn","one",3)).toBe(true);
  expect(access.wasReadThisTurn("turn","two",8)).toBe(true);
  expect(access.wasReadThisTurn("turn","one",4)).toBe(false);
  expect(access.wasReadThisTurn("turn","forged",3)).toBe(false);
  expect((await access.listForTurn("turn", reader, {limit:1})).items).toEqual([]);
  access.endTurn("turn");
  await expect(async () => access.wasReadThisTurn("turn","one",3)).rejects.toThrow("inbox_triage_not_authorized");
});

test("S9-1a: pagination respects the remaining consent budget even within one repository page", async () => {
  const rows = Array.from({length:8},(_,i)=>note("n"+i));
  const access = createInboxTriageAccess("c", () => true);
  const reader = repo(rows);
  access.requestApproval(5);
  access.approveFromUserTap("c");
  access.beginTurn("turn");
  const first = await access.listForTurn("turn",reader,{limit:3});
  expect(first.items.map(x=>x.noteId)).toEqual(["n0","n1","n2"]);
  expect(first.nextCursor).toBe(3);
  const second = await access.listForTurn("turn",reader,{limit:2,cursor:first.nextCursor});
  expect(second.items.map(x=>x.noteId)).toEqual(["n3","n4"]);
  expect(second.nextCursor).toBeUndefined();
  expect(access.wasReadThisTurn("turn","n4",3)).toBe(true);
  expect(access.wasReadThisTurn("turn","n5",3)).toBe(false);
  expect((await access.listForTurn("turn",reader,{limit:1,cursor:5})).items).toEqual([]);
});

test("S9-1a: reject over-budget limits and malformed cursors before any database scan", async () => {
  const access = createInboxTriageAccess("c", () => true);
  expect(MAX_INBOX_TRIAGE_ITEMS).toBe(10);
  expect(() => access.requestApproval(11)).toThrow("invalid_inbox_triage_limit");
  expect(() => access.requestApproval(0)).toThrow("invalid_inbox_triage_limit");
  const reader = repo([note("a")]);
  access.requestApproval(1);
  access.approveFromUserTap("c");
  access.beginTurn("t");
  await expect(access.listForTurn("t",reader,{limit:999})).rejects.toThrow("invalid_inbox_triage_limit");
  await expect(access.listForTurn("t",reader,{limit:1,cursor:-1})).rejects.toThrow("invalid_inbox_triage_cursor");
  expect(reader.entities).not.toHaveBeenCalled();
});

test("S9-1a: locking app mid-read revokes approval and leaks no private notes", async () => {
  let unlocked = true;
  const access = createInboxTriageAccess("c", () => unlocked);
  const reader: ReadRepo = {
    listCollections: jest.fn(async () => [inbox]),
    entities: jest.fn(async () => {
      unlocked = false;
      return {items:[note("private")],next_offset:null};
    }),
  };
  access.requestApproval(1);
  access.approveFromUserTap("c");
  access.beginTurn("t");
  await expect(access.listForTurn("t",reader,{limit:1})).rejects.toThrow("application_locked");
  unlocked = true;
  expect(access.beginTurn("t-next")).toBe(false);
  await expect(access.listForTurn("t",reader,{limit:1})).rejects.toThrow("inbox_triage_not_authorized");
});

test("S9-1a: no Inbox collection means no notes and no forged handles", async () => {
  const access = createInboxTriageAccess("c", () => true);
  access.requestApproval(1);
  access.approveFromUserTap("c");
  access.beginTurn("t");
  const page = await access.listForTurn("t",repo([note("a")],[]),{limit:1});
  expect(page.items).toEqual([]);
  expect(access.wasReadThisTurn("t","a",3)).toBe(false);
});


test("S9-1a: secret notes remain outside model-visible Inbox even after batch consent", async () => {
  const access = createInboxTriageAccess("c",()=>true);
  const reader = repo([
    note("secret", {sensitivity:"secret"}),
    note("sensitive", {sensitivity:"sensitive"}),
  ]);
  access.requestApproval(2);
  access.approveFromUserTap("c");
  access.beginTurn("t");
  const result = await access.listForTurn("t",reader,{limit:2});
  expect(result.items.map(x=>x.noteId)).toEqual(["sensitive"]);
  expect(access.wasReadThisTurn("t","secret",3)).toBe(false);
  expect(access.wasReadThisTurn("t","sensitive",3)).toBe(true);
});

test("S9-1a: concurrent reads cannot each consume the same one-turn budget", async () => {
  let complete: ((value: {items: EntityRecord[];next_offset:null}) => void) | undefined;
  const readPromise = new Promise<{items:EntityRecord[];next_offset:null}>(resolve => {
    complete = resolve;
  });
  const reader: ReadRepo = {
    listCollections: jest.fn(async () => [inbox]),
    entities: jest.fn(() => readPromise),
  };
  const access = createInboxTriageAccess("c",()=>true);
  access.requestApproval(1);
  access.approveFromUserTap("c");
  access.beginTurn("t");
  const first = access.listForTurn("t",reader,{limit:1});
  // A second read cannot race ahead of the first while it awaits SQLite.
  await Promise.resolve();
  await Promise.resolve();
  await expect(access.listForTurn("t",reader,{limit:1})).rejects.toThrow("inbox_triage_read_in_progress");
  complete!({items:[note("first")],next_offset:null});
  expect((await first).items.map(x=>x.noteId)).toEqual(["first"]);
  expect((await access.listForTurn("t",reader,{limit:1})).items).toEqual([]);
});
