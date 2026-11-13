import type { ChatMoveProposal, ChatMoveReceipt } from "../move-proposal";
import type { ChatSectionProposal, ChatSectionReceipt } from "../section-actions";
import type { ChatRow } from "../conversations";
import {
  moveNoteHandler, sectionHandler, proposalHandlers, rowProposal, rowReceipt,
} from "../proposals";
import { confirmMove, undoMove } from "../move-proposal";
import { confirmSectionAction } from "../section-actions";

jest.mock("../move-proposal", () => ({
  confirmMove: jest.fn(), undoMove: jest.fn(),
}));
jest.mock("../section-actions", () => ({
  confirmSectionAction: jest.fn(),
}));

const move: ChatMoveProposal = {
  noteId: "note-a", expectedVersion: 3, title: "Тестовая заметка",
  fromCollectionId: "col-a", fromName: "Старый раздел",
  toCollectionId: "col-b", toName: "Новый раздел",
  reason: "Пользователь попросил перенос", attachmentCount: 2, hasSource: true,
};
const moveReceipt: ChatMoveReceipt = {
  noteId: move.noteId, title: move.title,
  fromCollectionId: move.fromCollectionId, fromName: move.fromName,
  toCollectionId: move.toCollectionId, toName: move.toName,
  batch: "notes:move:abcdef", verified: true,
};
const sectionCreate: ChatSectionProposal = {
  kind: "create", name: "Обучение", parentId: "col-ai",
  parentName: "ИИ", reason: "Пользователь попросил добавить подраздел",
};
const sectionDelete: ChatSectionProposal = {
  kind: "delete", id: "col-child", slug: "section-child",
  name: "Обучение", parentId: "col-ai", parentName: "ИИ",
  createdAt: "2026-11-13T12:00:00.000Z", reason: "Удалить пустой подраздел",
  recordCount: 0, childCount: 0,
};
const sectionReceipt: ChatSectionReceipt = {
  kind: "create", id: "col-created", slug: "section-created",
  name: "Обучение", parentName: "ИИ", verified: true,
};
const assistant = (part: Partial<ChatRow> = {}): ChatRow =>
  ({ id: "row-a", role: "assistant", text: "Ответ модели", ...part });

beforeEach(() => jest.clearAllMocks());

test("ARCH-4a: one registry and section-first proposal detection; no authorization for user rows", () => {
  expect(proposalHandlers.map(x => x.kind)).toEqual(["section", "inbox_triage", "move_note"]);
  const row = assistant({ moveProposal: move, sectionProposal: sectionCreate });
  const selected = rowProposal(row);
  expect(selected).toEqual({ handler: sectionHandler, proposal: sectionCreate });
  expect(rowProposal(assistant({ moveProposal: move }))).toEqual({
    handler: moveNoteHandler, proposal: move,
  });
  expect(rowProposal({ ...row, role: "user" })).toBeUndefined();
  expect(rowProposal({ ...row, role: "info" })).toBeUndefined();
  expect(rowProposal(assistant())).toBeUndefined();
  expect(rowReceipt(assistant({ moveReceipt, sectionReceipt }))).toEqual({
    handler: sectionHandler, receipt: sectionReceipt,
  });
  expect(rowReceipt({ ...assistant({ moveReceipt }), role: "user" })).toBeUndefined();
});

test("ARCH-4a: move proposal is rendered verbatim and remains an immutable pending action", () => {
  expect(moveNoteHandler.present(move)).toEqual({
    heading: "Предложение переноса — требуется подтверждение",
    lines: [
      "Тестовая заметка",
      "Из «Старый раздел» → в «Новый раздел»",
      "Обоснование: Пользователь попросил перенос",
    ],
    note: "Изменится только раздел и версия записи. Содержимое, 2 вложений, комментарии, связи и история сохранятся. Источник сохранится. Предыдущие ограничения доступа сохраняются — перенос допустим только между обычными разделами.",
    confirmLabel: "Подтвердить перенос", confirmIcon: "check",
    danger: false, openNoteId: "note-a",
  });
  const previous = assistant({ moveProposal: move, sources: ["https://example.org"], error: false });
  const confirmed = moveNoteHandler.withReceipt(previous, moveReceipt);
  expect(previous.moveProposal).toEqual(move);
  expect(confirmed).toMatchObject({ text: previous.text, sources: previous.sources,
    moveReceipt });
  expect(confirmed.moveProposal).toBeUndefined();
  expect(moveNoteHandler.withoutProposal(previous)).toEqual({
    id: previous.id, role: "assistant", text: previous.text, sources: previous.sources,
    error: false,
  });
  expect(rowReceipt(confirmed)?.handler).toBe(moveNoteHandler);
  expect(moveNoteHandler.presentReceipt(moveReceipt)).toEqual({
    text: "Перенос выполнен\n«Тестовая заметка»: «Старый раздел» → «Новый раздел»",
    undoable: true, undone: false,
  });
  expect(moveNoteHandler.presentReceipt({ ...moveReceipt, undone: true })).toMatchObject({
    undoable: false, undone: true,
  });
});

test("ARCH-4a: section create/delete uses one handler without any secondary writer", async () => {
  const createView = sectionHandler.present(sectionCreate);
  expect(createView).toEqual({
    heading: "Создать раздел?",
    lines: ["ИИ / Обучение", "Причина: Пользователь попросил добавить подраздел"],
    note: "Создаётся только новый раздел в существующей памяти. Записи не изменятся.",
    confirmLabel: "Создать раздел", confirmIcon: "check", danger: false,
  });
  const deleteView = sectionHandler.present(sectionDelete);
  expect(deleteView.heading).toBe("Удалить пустой раздел?");
  expect(deleteView.confirmLabel).toBe("Удалить пустой раздел");
  expect(deleteView.confirmIcon).toBe("trash-2");
  expect(deleteView.danger).toBe(true);
  expect(deleteView.note).toContain("Состояние перепроверяется при подтверждении");
  expect(sectionHandler.undo).toBeUndefined();

  const row = assistant({ sectionProposal: sectionCreate });
  expect(sectionHandler.withReceipt(row, sectionReceipt)).toMatchObject({
    sectionReceipt, text: row.text,
  });
  expect(sectionHandler.withReceipt(row, sectionReceipt).sectionProposal).toBeUndefined();
  expect(sectionHandler.withoutProposal(row).sectionProposal).toBeUndefined();
  expect(row.sectionProposal).toEqual(sectionCreate);
  expect(sectionHandler.presentReceipt(sectionReceipt)).toEqual({
    text: "Создание раздела выполнено\nИИ / Обучение",
    undoable: false, undone: false,
  });
  (confirmSectionAction as jest.Mock).mockResolvedValue(sectionReceipt);
  await expect(sectionHandler.confirm("guest", sectionCreate)).resolves.toBe(sectionReceipt);
  expect(confirmSectionAction).toHaveBeenCalledWith("guest", sectionCreate);
});

test("ARCH-4a: move delegates CAS/ACL to existing writer; undo never invents a receipt on failure", async () => {
  (confirmMove as jest.Mock).mockResolvedValue(moveReceipt);
  await expect(moveNoteHandler.confirm("guest", move)).resolves.toBe(moveReceipt);
  expect(confirmMove).toHaveBeenCalledWith("guest", move);

  (undoMove as jest.Mock).mockRejectedValueOnce(new Error("stale_memory_version"));
  await expect(moveNoteHandler.undo!("guest", moveReceipt)).rejects.toThrow("stale_memory_version");
  expect(undoMove).toHaveBeenCalledWith("guest", moveReceipt);
  expect(moveReceipt.undone).toBeUndefined();

  (undoMove as jest.Mock).mockResolvedValue(undefined);
  await expect(moveNoteHandler.undo!("guest", moveReceipt)).resolves.toEqual({
    ...moveReceipt, undone: true,
  });
  expect(moveReceipt.undone).toBeUndefined();
});
