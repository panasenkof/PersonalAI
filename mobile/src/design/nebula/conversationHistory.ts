import type { LiveConversation } from "../../direct-agent/chat-store";

export interface IndexedHistoryConversation {
  conversation: LiveConversation;
  searchableText: string;
  preview: string;
}

/** Search and sort are pure: no persistence, LLM request or navigation side effects. */
export const normalizeHistoryQuery = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();

export function indexConversationHistory(conversations: readonly LiveConversation[]): IndexedHistoryConversation[] {
  return conversations.map(conversation => {
    const lastMessage = [...conversation.rows].reverse().find(row =>
      (row.role === "user" || row.role === "assistant") && row.text.trim()
    );
    return {
      conversation,
      searchableText: normalizeHistoryQuery([conversation.title, ...conversation.rows.map(row => row.text)].join(" ")),
      preview: lastMessage?.text.replace(/\s+/g, " ").trim() || "Пока нет сообщений",
    };
  }).sort((a, b) => {
    const aTime = Date.parse(a.conversation.updatedAt) || 0;
    const bTime = Date.parse(b.conversation.updatedAt) || 0;
    return bTime - aTime;
  });
}

/** All words may occur in different messages; do not require exact phrase order. */
export function searchConversationHistory(
  entries: readonly IndexedHistoryConversation[], query: string,
): IndexedHistoryConversation[] {
  const terms = normalizeHistoryQuery(query).split(" ").filter(Boolean);
  if (!terms.length) return [...entries];
  return entries.filter(entry => terms.every(term => entry.searchableText.includes(term)));
}
