import type { ConversationRepository, SavedConversation } from "../src/direct-agent/conversations";
export function conversationRepository(profile: string): ConversationRepository {
  const key = "qa.chats." + profile;
  const all = (): SavedConversation[] => JSON.parse(localStorage.getItem(key) || "[]");
  return {
    load: async () => all().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    save: async c => { localStorage.setItem(key, JSON.stringify([c, ...all().filter(x => x.id !== c.id)])); },
    remove: async id => { localStorage.setItem(key, JSON.stringify(all().filter(c => c.id !== id))); },
  };
}
