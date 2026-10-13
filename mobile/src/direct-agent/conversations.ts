import { withLocalMemoryDatabase } from "../local-memory/storage";
import type { NoteProposal } from "./memory";

export type ChatRow = { id: string; role: "user" | "assistant" | "info"; text: string; sources?: string[] };
export type ChatDraft = NoteProposal & { id: string };
export type SavedConversation = {
  id: string; title: string; createdAt: string; updatedAt: string;
  rows: ChatRow[]; drafts: ChatDraft[]; question: string; interrupted?: boolean;
};
export interface ConversationRepository {
  load(): Promise<SavedConversation[]>;
  save(conversation: SavedConversation): Promise<void>;
  remove(id: string): Promise<void>;
}

/** No plaintext files or SecureStore-sized chat blobs: full messages, sources
 * and pending note proposals use the existing per-profile SQLCipher database. */
export function conversationRepository(profile: string): ConversationRepository {
  return {
    load: () => withLocalMemoryDatabase(profile, async db => {
      const rows = await db.getAllAsync<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM direct_conversations ORDER BY updated_at DESC, id",
      );
      return rows.map(row => {
        const value = JSON.parse(row.snapshot_json) as SavedConversation;
        if (typeof value.id !== "string" || typeof value.title !== "string" ||
            typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
            !Array.isArray(value.rows) || !Array.isArray(value.drafts) ||
            value.rows.some(r => !r || typeof r.id !== "string" || typeof r.text !== "string" || !["user", "assistant", "info"].includes(r.role) ||
              (r.sources !== undefined && (!Array.isArray(r.sources) || r.sources.some(url => typeof url !== "string" || !url.startsWith("https://"))))) ||
            value.drafts.some(d => !d || typeof d.id !== "string" || typeof d.title !== "string" || typeof d.body !== "string") ||
            (value.question !== undefined && typeof value.question !== "string")) throw new Error("invalid_chat_history");
        return value;
      });
    }),
    save: conversation => withLocalMemoryDatabase(profile, async db => {
      await db.runAsync(
        `INSERT INTO direct_conversations(id,title,snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`,
        [conversation.id, conversation.title, JSON.stringify(conversation), conversation.createdAt, conversation.updatedAt],
      );
    }),
    remove: id => withLocalMemoryDatabase(profile, async db => {
      await db.runAsync("DELETE FROM direct_conversations WHERE id=?", [id]);
    }),
  };
}
