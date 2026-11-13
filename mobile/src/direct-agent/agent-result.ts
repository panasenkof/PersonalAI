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
      ...(result.articlePage ? { articlePage: result.articlePage } : {}),
      ...(result.articleReadReport ? { articleReadReport: result.articleReadReport } : {}),
      ...(applied?.change ? { contextChange: applied.change } : {}),
    },
    ...(applied ? { context: applied.context } : {}),
    ...(applied?.change ? { change: applied.change } : {}),
  };
}
