import type { SavedConversation } from "./conversations";
import { MAX_NOTE_BODY_CHARS } from "./fact-tool";
import { TRUNCATED_NOTE } from "./limits";

/** Only stable IDs cross navigation. Text stays in the existing encrypted
 * conversation store and is resolved again at Save time. */
export type ChatReplyLocator = { conversationId: string; rowId: string };

export type PreparedReplyNote = {
  title: string; body: string;
  provenance: { kind: "assistant_reply" | "dialogue_summary"; conversationId: string; rowId: string;
    scope?: "all" | "last10"; includedRows?: number; totalRows?: number; omittedAttachments?: number;
    firstRowId?: string; lastRowId?: string; model?: string; provider?: string; createdAt?: string };
};

/** H-SAVE1a: a finished assistant row, not the ephemeral stream footer,
 * becomes an editable user-owned draft. Never summarize or crop Markdown.
 * No LLM, filesystem, or database access occurs here. */
export function prepareAssistantReplyNote(
  conversations: readonly SavedConversation[], locator: ChatReplyLocator,
): PreparedReplyNote {
  if (!locator || typeof locator.conversationId !== "string" ||
      typeof locator.rowId !== "string" || !locator.conversationId ||
      !locator.rowId || locator.conversationId.length > 128 || locator.rowId.length > 128)
    throw new Error("Некорректная ссылка на ответ ИИ.");
  const conversation = conversations.find(c => c.id === locator.conversationId);
  const answer = conversation?.rows.find(row => row.id === locator.rowId && row.role === "assistant");
  if (!conversation || !answer || !answer.text.trim())
    throw new Error("Завершённый ответ не найден в этом диалоге. Заметка не создана.");
  if (answer.text.includes(TRUNCATED_NOTE))
    throw new Error("Ответ ИИ обрезан лимитом модели. Сначала запросите продолжение, чтобы не сохранять его как полный.");
  if (answer.text.length > MAX_NOTE_BODY_CHARS)
    throw new Error("Ответ длиннее 60 000 символов. Сохранение без обрезания пока недоступно.");
  const conversationTitle = conversation.title.replace(/[\r\n\t]+/g, " ").trim();
  return {
    title: ((answer.dialogueSummary ? "Итог диалога · " : "Ответ ИИ · ") + (conversationTitle || "Диалог")).slice(0, 160),
    body: answer.text,
    provenance: answer.dialogueSummary
      ? {kind:"dialogue_summary", conversationId:locator.conversationId, rowId:locator.rowId,
        scope:answer.dialogueSummary.scope, includedRows:answer.dialogueSummary.includedRows,
        totalRows:answer.dialogueSummary.totalRows, omittedAttachments:answer.dialogueSummary.omittedAttachments,
        firstRowId:answer.dialogueSummary.firstRowId,lastRowId:answer.dialogueSummary.lastRowId,
        model:answer.dialogueSummary.model,provider:answer.dialogueSummary.provider,
        createdAt:answer.dialogueSummary.createdAt}
      : {kind:"assistant_reply", conversationId:locator.conversationId, rowId:locator.rowId},
  };
}
