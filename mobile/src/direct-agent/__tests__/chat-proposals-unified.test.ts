import { DirectChatStore } from "../chat-store";
import { parseConversation, type ChatRow, type ConversationRepository, type SavedConversation } from "../conversations";
import { confirmMove, undoMove, type ChatMoveProposal, type ChatMoveReceipt } from "../move-proposal";
import { confirmSectionAction, type ChatSectionProposal, type ChatSectionReceipt } from "../section-actions";
import { waitForApplicationSession } from "../../local-memory/storage";

jest.mock("../../local-memory/storage", () => ({
  waitForApplicationSession: jest.fn(async () => {}),
  withLocalMemoryDatabase: jest.fn(),
  localMemorySessionUnlocked: jest.fn(() => true),
  onLocalMemorySessionChange: jest.fn(() => () => {}),
}));
jest.mock("../move-proposal", () => ({
  ...jest.requireActual("../move-proposal"),
  previewMove: jest.fn(), confirmMove: jest.fn(), undoMove: jest.fn(),
}));
jest.mock("../section-actions", () => ({
  ...jest.requireActual("../section-actions"),
  previewSectionAction: jest.fn(), confirmSectionAction: jest.fn(),
}));
jest.mock("../memory", () => ({
  searchApprovedNotes: jest.fn(async () => []), saveApprovedNote: jest.fn(),
  proposableMemorySections: jest.fn(async () => []),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "info-" + Math.random().toString(36).slice(2) }));

const move: ChatMoveProposal = {
  noteId: "note-one", expectedVersion: 1, title: "Перемещаемая запись",
  fromCollectionId: "col-old", fromName: "Заметки",
  toCollectionId: "col-new", toName: "Рецепты",
  reason: "Пользователь попросил перенести",
  attachmentCount: 1, hasSource: false,
};
const moveReceipt: ChatMoveReceipt = {
  noteId: move.noteId, title: move.title,
  fromCollectionId: move.fromCollectionId, fromName: move.fromName,
  toCollectionId: move.toCollectionId, toName: move.toName,
  batch: "notes:move:abcdef1234", verified: true,
};
const section: ChatSectionProposal = {
  kind: "delete", id: "section-id", slug: "section-test", name: "Тестовый",
  parentId: "parent", parentName: "Обучение",
  createdAt: "2026-11-13T12:00:00.000Z",
  recordCount: 0, childCount: 0, reason: "Убрать пустой раздел",
};
const sectionReceipt: ChatSectionReceipt = {
  kind: "delete", id: "section-id", slug: "section-test", name: "Тестовый",
  parentName: "Обучение", verified: true,
};

function fixture() {
  const initial: SavedConversation = {
    id: "c1", title: "Тест", createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z", question: "", drafts: [],
    context: { topic: "Тест", sectionSlug: "section-test", pinned: true },
    rows: [
      { id: "m1", role: "assistant", text: "Перенести?", moveProposal: move },
      { id: "s1", role: "assistant", text: "Удалить?", sectionProposal: section },
    ],
  };
  const records = new Map<string, SavedConversation>([[initial.id, initial]]);
  const repo: ConversationRepository = {
    load: jest.fn(async () => [...records.values()].map(r => JSON.parse(JSON.stringify(r)))),
    save: jest.fn(async r => { records.set(r.id, JSON.parse(JSON.stringify(r))); }),
    remove: jest.fn(async id => { records.delete(id); }),
  };
  return { repo, records };
}
async function setup() {
  const { repo, records } = fixture();
  const store = new DirectChatStore("guest", repo, jest.fn());
  await store.initialize();
  return { store, records, repo };
}
const find = (store: DirectChatStore, id: string): ChatRow | undefined =>
  store.getSnapshot().conversations[0].rows.find(x => x.id === id);
beforeEach(() => {
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  (confirmMove as jest.Mock).mockResolvedValue(moveReceipt);
  (undoMove as jest.Mock).mockResolvedValue(undefined);
  (confirmSectionAction as jest.Mock).mockResolvedValue(sectionReceipt);
});

test("ARCH-4b: unified confirm/undo preserves move receipt, immutable history and old wrappers", async () => {
  const { store, records } = await setup();
  await store.confirmProposal("m1");
  expect(confirmMove).toHaveBeenCalledTimes(1);
  expect(confirmMove).toHaveBeenCalledWith("guest", move);
  expect(find(store, "m1")?.moveProposal).toBeUndefined();
  expect(find(store, "m1")?.moveReceipt).toEqual(moveReceipt);
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toContain("Доступна отмена");
  await store.undoConfirmedMove("m1");
  expect(undoMove).toHaveBeenCalledWith("guest", moveReceipt);
  expect(find(store, "m1")?.moveReceipt?.undone).toBe(true);
  await store.undoProposal("m1");
  expect(undoMove).toHaveBeenCalledTimes(1);
  await store.checkpoint();
  expect(parseConversation(JSON.stringify(records.get("c1")))?.rows.find(x => x.id === "m1")?.moveReceipt?.undone)
    .toBe(true);
  store.dispose();
});

test("ARCH-4b: section confirmation uses the same handler, clears pinned deleted context", async () => {
  const { store, records } = await setup();
  await store.confirmSectionProposal("s1");
  expect(confirmSectionAction).toHaveBeenCalledWith("guest", section);
  expect(find(store, "s1")?.sectionProposal).toBeUndefined();
  expect(find(store, "s1")?.sectionReceipt).toEqual(sectionReceipt);
  expect(store.getSnapshot().conversations[0].context).toMatchObject({
    topic: "Тест", sectionSlug: null, pinned: false,
  });
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toContain("удалён");
  await store.undoProposal("s1");
  expect(undoMove).not.toHaveBeenCalled();
  await store.checkpoint();
  expect(parseConversation(JSON.stringify(records.get("c1")))?.rows.find(x => x.id === "s1")?.sectionReceipt)
    .toEqual(sectionReceipt);
  store.dispose();
});

test("ARCH-4b: dismiss routes both types without writing the actual note or section", async () => {
  const { store, records } = await setup();
  store.dismissProposal("m1");
  store.cancelSectionProposal("s1");
  await store.checkpoint();
  expect(find(store, "m1")?.moveProposal).toBeUndefined();
  expect(find(store, "s1")?.sectionProposal).toBeUndefined();
  expect(confirmMove).not.toHaveBeenCalled();
  expect(confirmSectionAction).not.toHaveBeenCalled();
  const rows = records.get("c1")!.rows;
  expect(rows.map(r => r.text)).toContain("Предложение переноса отменено. Запись не изменена.");
  expect(rows.map(r => r.text)).toContain("Изменение раздела отменено. Память не изменена.");
  store.dispose();
});

test("ARCH-4b: rejection from the canonical writer leaves pending proposal, reports stale version", async () => {
  const { store } = await setup();
  (confirmMove as jest.Mock).mockRejectedValueOnce(new Error("stale_memory_version"));
  await store.confirmProposal("m1");
  expect(find(store, "m1")?.moveProposal).toEqual(move);
  expect(find(store, "m1")?.moveReceipt).toBeUndefined();
  expect(store.getSnapshot().error).toContain("верс");
  expect(store.getSnapshot().conversations[0].movingRowId).toBeUndefined();
  store.dispose();
});

test("ARCH-4b: failed undo keeps the receipt actionable and does not fabricate completion", async () => {
  const { store } = await setup();
  await store.confirmMoveProposal("m1");
  (undoMove as jest.Mock).mockRejectedValueOnce(new Error("stale_memory_version"));
  await store.undoProposal("m1");
  expect(find(store, "m1")?.moveReceipt?.undone).toBeUndefined();
  expect(store.getSnapshot().error).toContain("Отмена не выполнена");
  store.dispose();
});

test("ARCH-4b: busy, moving and disposed store refuse all confirmation paths", async () => {
  const { store } = await setup();
  const current = store.getSnapshot().conversations[0];
  current.busy = true;
  await store.confirmProposal("m1");
  store.dismissProposal("s1");
  expect(confirmMove).not.toHaveBeenCalled();
  expect(find(store, "s1")?.sectionProposal).toEqual(section);
  current.busy = false;
  current.movingRowId = "another";
  await store.confirmProposal("s1");
  expect(confirmSectionAction).not.toHaveBeenCalled();
  current.movingRowId = undefined;
  store.dispose();
  await store.confirmProposal("m1");
  await store.undoProposal("m1");
  expect(confirmMove).not.toHaveBeenCalled();
});
