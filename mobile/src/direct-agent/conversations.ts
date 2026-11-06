import { checkedChatAttachments, type ChatAttachment } from "./chat-attachments";
import { withLocalMemoryDatabase } from "../local-memory/storage";
import type { NoteProposal } from "./memory";
import { parseTaskState } from "./task-state";
import type { TaskState } from "./task-state";
import { restoredProposal } from "./fact-tool";

/** `memory`: records the answer used, with how each was found («Из памяти»). */
export type ChatMemoryRef = { id: string; title: string; section?: string; via: "search" | "rewrite" | "assistant"; photo?: boolean; photoAttachmentId?: string };
export type DialogueSummaryOrigin = {
  scope: "last10" | "all"; includedRows: number; totalRows: number;
  omittedAttachments: number; sourceChars: number; parts: number;
  firstRowId: string; lastRowId: string; model: string; provider: string; createdAt: string;
};
/** Lightweight saved-link shortlist continuation; content stays in existing SQLCipher notes. */
export type ChatArticlePage = {
  kind: "saved_ai_links" | "saved_topic_links"; topic?: string; queryTerms?: string[]; savedFrom: string; savedBefore: string;
  startLocal: string; endLocal: string;
  nextCursor?: {beforeCreatedAt:string;beforeId:string};
};
export type ChatRow = { id: string; role: "user" | "assistant" | "info"; text: string; error?: boolean; photoAction?: "model" | "import" | "prepare"; sources?: string[]; memory?: ChatMemoryRef[]; attachments?: ChatAttachment[]; dialogueSummary?: DialogueSummaryOrigin; articlePage?: ChatArticlePage };
const VIA = new Set(["search", "rewrite", "assistant"]);
export type ChatDraft = NoteProposal & { id: string };
export type SavedConversation = {
  id: string; title: string; createdAt: string; updatedAt: string;
  attachments?: ChatAttachment[]; rows: ChatRow[]; drafts: ChatDraft[]; question: string; interrupted?: boolean; taskState?: TaskState;
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
  try {
    checkedChatAttachments(value.attachments);
    for (const row of value.rows || []) checkedChatAttachments(row?.attachments);
  } catch { return null; } // Keep the unreadable snapshot in SQLCipher for recovery.
  const rows: ChatRow[] = (Array.isArray(value.rows) ? value.rows : []).flatMap((r: any): ChatRow[] => {
    if (!r || typeof r.id !== "string" || typeof r.text !== "string" || !ROLES.has(r.role)) return [];
    const sources = Array.isArray(r.sources) ? r.sources.filter((url: unknown) => typeof url === "string" && url.startsWith("https://")) : undefined;
    const memory = Array.isArray(r.memory) ? r.memory.filter((m: any) => m && typeof m.id === "string" && typeof m.title === "string" && VIA.has(m.via))
      .slice(0, r.memory.some((m: any) => m?.photo === true) ? 40 : 8).map((m: any) => ({ id: m.id, title: m.title.slice(0, 160), via: m.via, ...(m.photo === true ? { photo: true } : {}), ...(typeof m.photoAttachmentId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(m.photoAttachmentId) ? { photoAttachmentId: m.photoAttachmentId } : {}), ...(typeof m.section === "string" ? { section: m.section.slice(0, 60) } : {}) })) : undefined;
    const ap = r.articlePage;
    const iso = (v:unknown) => typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
      Number.isFinite(Date.parse(v));
    const day = (v:unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const cur = ap?.nextCursor;
    const validCursor = cur === undefined || (cur && iso(cur.beforeCreatedAt) &&
      typeof cur.beforeId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(cur.beforeId));
    const topicOk = ap?.kind === "saved_ai_links" || (ap?.kind === "saved_topic_links" &&
      typeof ap.topic === "string" && ap.topic.length >= 2 && ap.topic.length <= 70 &&
      /^[а-яёa-z0-9][а-яёa-z0-9\s+.#-]*$/iu.test(ap.topic) &&
      Array.isArray(ap.queryTerms) && ap.queryTerms.length === 1 && ap.queryTerms[0] === ap.topic);
    const articlePage: ChatArticlePage | undefined = r.role === "assistant" && topicOk &&
      (ap?.kind === "saved_ai_links" || ap?.kind === "saved_topic_links") && iso(ap.savedFrom) && iso(ap.savedBefore) &&
      ap.savedFrom < ap.savedBefore && day(ap.startLocal) && day(ap.endLocal) &&
      validCursor ? {kind:ap.kind,savedFrom:ap.savedFrom,savedBefore:ap.savedBefore,
        startLocal:ap.startLocal,endLocal:ap.endLocal,
        ...(ap.kind === "saved_topic_links" ? {topic:ap.topic,queryTerms:[ap.topic]} : {}),
        ...(cur ? {nextCursor:{beforeCreatedAt:cur.beforeCreatedAt,beforeId:cur.beforeId}} : {})} : undefined;
    const d = r.dialogueSummary;
    const dialogueSummary: DialogueSummaryOrigin | undefined = r.role === "assistant" && d &&
      (d.scope === "all" || d.scope === "last10") &&
      [d.includedRows,d.totalRows,d.omittedAttachments,d.sourceChars,d.parts]
        .every(n => Number.isSafeInteger(n) && n >= 0 && n <= 240_000) &&
      typeof d.firstRowId === "string" && d.firstRowId.length <= 128 &&
      typeof d.lastRowId === "string" && d.lastRowId.length <= 128 &&
      typeof d.model === "string" && d.model.length <= 200 &&
      typeof d.provider === "string" && d.provider.length <= 100 &&
      typeof d.createdAt === "string" && d.createdAt.length <= 40 ? {
        scope:d.scope,includedRows:d.includedRows,totalRows:d.totalRows,
        omittedAttachments:d.omittedAttachments,sourceChars:d.sourceChars,parts:d.parts,
        firstRowId:d.firstRowId,lastRowId:d.lastRowId,
        model:d.model,provider:d.provider,createdAt:d.createdAt,
      } : undefined;
    return [{ id: r.id, role: r.role, text: r.text, ...(r.error === true && r.role === "info" ? { error: true } : {}), ...(["model","import","prepare"].includes(r.photoAction) ? {photoAction:r.photoAction} : {}), ...(r.attachments?.length ? {attachments:checkedChatAttachments(r.attachments)} : {}), ...(sources?.length ? { sources } : {}), ...(memory?.length ? { memory } : {}), ...(articlePage ? {articlePage} : {}), ...(dialogueSummary ? {dialogueSummary} : {}) }];
  });
  const drafts: ChatDraft[] = (Array.isArray(value.drafts) ? value.drafts : []).filter((d: any) =>
    d && typeof d.id === "string" && typeof d.title === "string" && typeof d.body === "string")
    .map((d: any) => {
      // Re-validate the stored proposal exactly like a fresh one from the model.
      // Re-validated, not looked up again: the section was resolved when proposed.
      return { id: d.id, title: d.title, body: d.body, ...restoredProposal(d) };
    });
  return {
    id: value.id, title: typeof value.title === "string" && value.title ? value.title : "Диалог",
    createdAt: value.createdAt, updatedAt: value.updatedAt, rows, drafts, ...(value.attachments?.length ? {attachments:checkedChatAttachments(value.attachments)} : {}),
    question: typeof value.question === "string" ? value.question : "",
    ...(parseTaskState(value.taskState) ? { taskState: parseTaskState(value.taskState) } : {}),
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
