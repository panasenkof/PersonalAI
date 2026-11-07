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


/** Pick the actual persisted row to show when the user opens a search result.
 * This is only a navigation hint over already-loaded SQLCipher rows: no extra
 * index, LLM request, persisted pointer or inferred memory permissions.
 * A mixed-topic chat can be found via an older section without jumping to an
 * unrelated later topic. User turns inherit their immediately following
 * assistant answer's section transition, when one exists. */
export function findHistoryMessageMatch(
  conversation: LiveConversation, query: string, sectionSlug?: string,
): { rowId: string; excerpt: string } | null {
  const terms = normalizeHistoryQuery(query).split(" ").filter(Boolean);
  if (!terms.length && !sectionSlug) return null; // Plain history opens at latest.
  const rows = conversation.rows;
  const hasTransitions = rows.some(row => Boolean(row.contextChange));
  let section: string | null = hasTransitions
    ? rows.find(row => row.contextChange)?.contextChange?.previousSectionSlug ?? null
    : conversation.context?.sectionSlug ?? null;
  let best: { rowId: string; excerpt: string; score: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.role === "user") {
      const next = rows.slice(i + 1).find(r => r.role === "assistant" || r.role === "user");
      if (next?.role === "assistant" && next.contextChange)
        section = next.contextChange.sectionSlug;
    }
    if (row.contextChange) section = row.contextChange.sectionSlug;
    if (sectionSlug && section !== sectionSlug) continue;
    const text = [row.text, row.contextChange?.topic || "",
      row.contextChange?.sectionName || ""].join(" ");
    const normalized = normalizeHistoryQuery(text);
    const matched = terms.filter(term => normalized.includes(term)).length;
    if (terms.length && !matched) continue;
    const score = matched * 10 + (terms.length && normalized.includes(terms.join(" ")) ? 3 : 0) +
      (row.contextChange?.sectionSlug === sectionSlug && sectionSlug ? 2 : 0);
    // Ties prefer the later matching message, never the last message merely
    // because it belongs to the same conversation.
    if (!best || score >= best.score) {
      const excerpt = (row.text || row.contextChange?.topic || "").replace(/\s+/g, " ").trim();
      best = { rowId: row.id, excerpt: excerpt.slice(0, 180), score };
    }
  }
  return best ? { rowId: best.rowId, excerpt: best.excerpt } : null;
}
