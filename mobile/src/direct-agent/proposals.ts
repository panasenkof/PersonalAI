/** ARCH-4: one typed presentation/confirmation adapter for existing user-approved
 * actions. These handlers DO NOT write storage themselves: they reuse the
 * canonical SQLCipher move/section writers with their existing ACL/CAS guards.
 *
 * ChatRow fields and parseConversation's persisted format are unchanged.
 */
import type { ChatRow } from "./conversations";
import { confirmMove, undoMove, type ChatMoveProposal, type ChatMoveReceipt } from "./move-proposal";
import { confirmSectionAction, type ChatSectionProposal, type ChatSectionReceipt } from "./section-actions";

export type ProposalKind = "move_note" | "section";
export type ProposalCardView = {
  heading: string;
  lines: string[];
  note?: string;
  confirmLabel: string;
  confirmIcon: string;
  danger: boolean;
  openNoteId?: string;
};
export type ReceiptView = { text: string; undoable: boolean; undone: boolean };

export interface ProposalHandler<P, R> {
  kind: ProposalKind;
  fromRow(row: ChatRow): P | undefined;
  receiptFromRow(row: ChatRow): R | undefined;
  present(proposal: P): ProposalCardView;
  presentReceipt(receipt: R): ReceiptView;
  confirm(profile: string, proposal: P): Promise<R>;
  undo?(profile: string, receipt: R): Promise<R>;
  withReceipt(row: ChatRow, receipt: R): ChatRow;
  withoutProposal(row: ChatRow): ChatRow;
  /** The existing exact chat notice/error messages are owned by the handler. */
  confirmNotice(receipt: R): string;
  dismissNotice: string;
  confirmErrorSuffix: string;
  undoNotice?(receipt: R): string;
  undoErrorSuffix?: string;
  refreshSectionsAfterConfirm?: boolean;
  clearedContextSection?(receipt: R): string | undefined;
}

const sectionPath = (value: { name: string; parentName: string | null }) =>
  value.parentName ? value.parentName + " / " + value.name : value.name;

/** The only note move still happens in confirmMove / undoMove. */
export const moveNoteHandler: ProposalHandler<ChatMoveProposal, ChatMoveReceipt> = {
  kind: "move_note",
  fromRow: row => row.role === "assistant" ? row.moveProposal : undefined,
  receiptFromRow: row => row.role === "assistant" ? row.moveReceipt : undefined,
  present: proposal => ({
    heading: "Предложение переноса — требуется подтверждение",
    lines: [
      proposal.title,
      "Из «" + proposal.fromName + "» → в «" + proposal.toName + "»",
      "Обоснование: " + proposal.reason,
    ],
    note: "Изменится только раздел и версия записи. Содержимое, " +
      proposal.attachmentCount + " вложений, комментарии, связи и история сохранятся." +
      (proposal.hasSource ? " Источник сохранится." : "") +
      " Предыдущие ограничения доступа сохраняются — перенос допустим только между обычными разделами.",
    confirmLabel: "Подтвердить перенос",
    confirmIcon: "check",
    danger: false,
    openNoteId: proposal.noteId,
  }),
  presentReceipt: receipt => ({
    text: (receipt.undone ? "Перенос отменён" :
      receipt.verified ? "Перенос выполнен" : "Перенос записан — проверьте результат") +
      "\n«" + receipt.title + "»: «" + receipt.fromName + "» → «" + receipt.toName + "»",
    undoable: !receipt.undone,
    undone: Boolean(receipt.undone),
  }),
  confirm: confirmMove,
  confirmNotice: receipt => receipt.verified
    ? "Перенос подтверждён: «" + receipt.title + "» → «" + receipt.toName + "». Доступна отмена."
    : "Перенос записан, но проверка результата не удалась. Доступна отмена; проверьте запись.",
  dismissNotice: "Предложение переноса отменено. Запись не изменена.",
  confirmErrorSuffix: " Проверьте запись и повторите поиск, если её версия или права изменились.",
  undoNotice: receipt => "Перенос отменён. «" + receipt.title + "» возвращена в раздел «" + receipt.fromName + "».",
  undoErrorSuffix: " Отмена не выполнена; проверьте актуальную версию и доступность разделов.",
  undo: async (profile, receipt) => {
    await undoMove(profile, receipt);
    return { ...receipt, undone: true };
  },
  withReceipt: (row, receipt) => {
    const { moveProposal: _discard, ...rest } = row;
    return { ...rest, moveReceipt: receipt };
  },
  withoutProposal: row => {
    const { moveProposal: _discard, ...rest } = row;
    return rest;
  },
};

/** Section creation and deletion still go through confirmSectionAction. */
export const sectionHandler: ProposalHandler<ChatSectionProposal, ChatSectionReceipt> = {
  kind: "section",
  fromRow: row => row.role === "assistant" ? row.sectionProposal : undefined,
  receiptFromRow: row => row.role === "assistant" ? row.sectionReceipt : undefined,
  present: proposal => ({
    heading: proposal.kind === "create" ? "Создать раздел?" : "Удалить пустой раздел?",
    lines: [sectionPath(proposal), "Причина: " + proposal.reason],
    note: proposal.kind === "delete"
      ? "Только пользовательский пустой раздел. Ни одна запись (включая архив и корзину) " +
        "и ни один вложенный раздел не будут удалены. Состояние перепроверяется при подтверждении."
      : "Создаётся только новый раздел в существующей памяти. Записи не изменятся.",
    confirmLabel: proposal.kind === "create" ? "Создать раздел" : "Удалить пустой раздел",
    confirmIcon: proposal.kind === "create" ? "check" : "trash-2",
    danger: proposal.kind === "delete",
  }),
  presentReceipt: receipt => ({
    text: (receipt.kind === "create" ? "Создание раздела" : "Удаление раздела") +
      (receipt.verified ? " выполнено" : " — результат не проверен") +
      "\n" + sectionPath(receipt),
    undoable: false,
    undone: false,
  }),
  confirm: confirmSectionAction,
  confirmNotice: receipt => receipt.kind === "create"
    ? receipt.verified ? "Раздел «" + receipt.name + "» создан." : "Создание записано, но проверка результата не удалась."
    : receipt.verified ? "Пустой раздел «" + receipt.name + "» удалён." : "Удаление записано, но проверка результата не удалась.",
  dismissNotice: "Изменение раздела отменено. Память не изменена.",
  confirmErrorSuffix: " Действие не подтверждено. Проверьте разделы; при изменении содержимого предложите операцию заново.",
  refreshSectionsAfterConfirm: true,
  clearedContextSection: receipt => receipt.kind === "delete" ? receipt.slug : undefined,
  withReceipt: (row, receipt) => {
    const { sectionProposal: _discard, ...rest } = row;
    return { ...rest, sectionReceipt: receipt };
  },
  withoutProposal: row => {
    const { sectionProposal: _discard, ...rest } = row;
    return rest;
  },
};

/** One ordered registry. A malformed historic row that has both proposals
 * renders at most one card, matching the pre-refactor UI's section-first order.
 */
export const proposalHandlers: ProposalHandler<any, any>[] = [
  sectionHandler, moveNoteHandler,
];

export function rowProposal(row: ChatRow):
  { handler: ProposalHandler<any, any>; proposal: unknown } | undefined {
  for (const handler of proposalHandlers) {
    const proposal = handler.fromRow(row);
    if (proposal !== undefined) return { handler, proposal };
  }
  return undefined;
}

export function rowReceipt(row: ChatRow):
  { handler: ProposalHandler<any, any>; receipt: unknown } | undefined {
  for (const handler of proposalHandlers) {
    const receipt = handler.receiptFromRow(row);
    if (receipt !== undefined) return { handler, receipt };
  }
  return undefined;
}
