import type { LiveConversation } from "../../direct-agent/chat-store";

export interface IndexedHistoryConversation {
  conversation: LiveConversation;
  searchableText: string;
  sectionSlugs: string[];
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
    const changes = conversation.rows.flatMap(row => row.contextChange ? [row.contextChange] : []);
    const sectionSlugs = [...new Set([conversation.context?.sectionSlug, ...changes.map(change => change.sectionSlug)].filter((x): x is string => Boolean(x)))];
    return {
      conversation,
      sectionSlugs,
      searchableText: normalizeHistoryQuery([conversation.title, conversation.context?.topic || "", conversation.context?.sectionSlug || "",
        ...changes.flatMap(change => [change.topic,change.sectionName || "",change.sectionSlug || ""]),
        ...conversation.rows.map(row => row.text)].join(" ")),
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
  entries: readonly IndexedHistoryConversation[], query: string, sectionSlug?: string,
): IndexedHistoryConversation[] {
  const terms = normalizeHistoryQuery(query).split(" ").filter(Boolean);
  return entries.filter(entry => (!sectionSlug || entry.sectionSlugs.includes(sectionSlug)) &&
    terms.every(term => entry.searchableText.includes(term)));
}
