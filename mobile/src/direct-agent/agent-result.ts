/** ARCH-6a: pure interpretation of one completed model result.
 * This function does not create IDs, persist dialogue state or grant memory
 * access: the controller remains the only owner of the serialized write.
 */
import type { DirectResult } from "./engine";
import type { ChatRow, SavedConversation } from "./conversations";
import type { MemorySection } from "./fact-tool";
import { applyContextCandidate, type ContextChange, type ConversationContext } from "./conversation-context";

export type AssistantRowResult = {
  row: Omit<ChatRow, "id">;
  notices: string[];
  context?: ConversationContext;
  change?: ContextChange;
};

export function assistantRowFromResult(
  result: DirectResult, conversation: SavedConversation, sections: MemorySection[], now: string,
): AssistantRowResult {
  const proposed = result.contextCandidate
    ? applyContextCandidate(conversation.context, result.contextCandidate, sections, now) : undefined;
  const applied = proposed && "context" in proposed ? proposed : undefined;
  return {
    notices: [
      ...(result.proposalIds?.some(id => conversation.drafts.some(d => d.id === id))
        ? ["Запись подготовлена, но ещё не сохранена. Подтвердите её в карточке предложения."] : []),
      ...(result.notice ? [result.notice] : []),
    ],
    row: {
      role: "assistant", text: result.text, sources: result.sources,
      ...(result.memory?.length ? { memory: result.memory } : {}),
      ...(result.photoAction ? { photoAction: result.photoAction } : {}),
      ...(result.moveProposal ? { moveProposal: result.moveProposal } : {}),
      ...(result.sectionProposal ? { sectionProposal: result.sectionProposal } : {}),
      ...(result.inboxApproval ? { inboxApproval: result.inboxApproval } : {}),
      ...(result.articlePage ? { articlePage: result.articlePage } : {}),
      ...(result.articleReadReport ? { articleReadReport: result.articleReadReport } : {}),
      ...(applied?.change ? { contextChange: applied.change } : {}),
    },
    ...(applied ? { context: applied.context } : {}),
    ...(applied?.change ? { change: applied.change } : {}),
  };
}


/** Pure failure-row description; the store owns publication and persistence.
 * ID creation is injected to preserve the original ordering and to make
 * cancellation/partial-output behavior deterministic in tests. */
export function interruptedAssistantPatch(input: {
  conversation: import("./chat-store").LiveConversation;
  taskState: NonNullable<import("./engine").DirectAgentOptions["taskState"]>;
  privatePhoto?: import("./chat-attachments").ChatAttachment;
  internetPhotoId: boolean;
  intentPreserveDraft: boolean;
  inboxTriageResult?: boolean;
  modelStarted: boolean;
  beforeModelError: string;
  prompt: string;
  draftFiles: import("./chat-attachments").ChatAttachment[];
  signalAborted: boolean;
  latest: string;
  error: unknown;
  newId: () => string;
}): Partial<import("./chat-store").LiveConversation> {
  const {
    conversation: c, taskState, privatePhoto, internetPhotoId, intentPreserveDraft,
    modelStarted, beforeModelError, prompt, draftFiles, signalAborted, inboxTriageResult,
    latest, error: e, newId,
  } = input;
        const aborted = signalAborted;
        const partial = aborted ? latest.trim() : "";
        const errorRowId=newId();
        return {
          retryPhoto:privatePhoto?{rowId:errorRowId,image:privatePhoto}:undefined,
          taskState: { ...(c.taskState || taskState), turnStatus: "interrupted" },
          ...(!internetPhotoId && !intentPreserveDraft && !modelStarted && !aborted
            ? { question: c.question || prompt, attachments:draftFiles } : {}),
          rows: [...c.rows,
            ...(partial ? [{ id: newId(), role: "assistant" as const, text: partial,
              ...(inboxTriageResult ? { inboxTriageResult:true } : {}) }] : []),
            { id: errorRowId, role: "info", ...(aborted ? {} : { error: true as const }),
              text: aborted ? (partial ? "Ответ остановлен" : "Запрос остановлен") : !modelStarted ? beforeModelError : String((e as Error).message) }],
        };

}
