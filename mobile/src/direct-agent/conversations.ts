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

const ROLES = new Set(["user", "assistant", "info"]);

/** Reads one stored conversation, keeping every intact message. A damaged
 * message or proposal is dropped; a conversation without its identity is
 * unreadable and returns null. One bad record never hides the others. */
export function parseConversation(json: string): SavedConversation | null {
  let value: any;
  try { value = JSON.parse(json); } catch { return null; }
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  const rows: ChatRow[] = (Array.isArray(value.rows) ? value.rows : []).flatMap((r: any): ChatRow[] => {
    if (!r || typeof r.id !== "string" || typeof r.text !== "string" || !ROLES.has(r.role)) return [];
    const sources = Array.isArray(r.sources) ? r.sources.filter((url: unknown) => typeof url === "string" && url.startsWith("https://")) : undefined;
    return [{ id: r.id, role: r.role, text: r.text, ...(sources?.length ? { sources } : {}) }];
  });
  const drafts: ChatDraft[] = (Array.isArray(value.drafts) ? value.drafts : []).filter((d: any) =>
    d && typeof d.id === "string" && typeof d.title === "string" && typeof d.body === "string")
    .map((d: any) => ({ id: d.id, title: d.title, body: d.body }));
  return {
    id: value.id, title: typeof value.title === "string" && value.title ? value.title : "Диалог",
    createdAt: value.createdAt, updatedAt: value.updatedAt, rows, drafts,
    question: typeof value.question === "string" ? value.question : "",
    ...(value.interrupted === true ? { interrupted: true } : {}),
  };
}

/** No plaintext files or SecureStore-sized chat blobs: full messages, sources
 * and pending note proposals use the existing per-profile SQLCipher database.
 * Unreadable records stay in the database untouched and are only reported. */
export function conversationRepository(profile: string, onSkipped?: (count: number) => void): ConversationRepository {
  return {
    load: () => withLocalMemoryDatabase(profile, async db => {
      const rows = await db.getAllAsync<{ snapshot_json: string }>(
        "SELECT snapshot_json FROM direct_conversations ORDER BY updated_at DESC, id",
      );
      const parsed = rows.map(row => parseConversation(row.snapshot_json));
      const conversations = parsed.filter((c): c is SavedConversation => c !== null);
      onSkipped?.(parsed.length - conversations.length);
      return conversations;
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
