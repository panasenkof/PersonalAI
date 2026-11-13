/** S9-1a: ephemeral consent gate and bounded reader for private Inbox triage.
 * This module is NOT an alternate chat dispatcher, database or note writer.
 * The host must display the permission card and call approveFromUserTap ONLY
 * from the user's confirmed action, then beginTurn for the next LLM turn.
 * An LLM tool receives only listForTurn, never these approval methods.
 */
import { memoryText } from "../local-memory/search-index";
import { noteTagsFromPayload } from "../local-memory/note-tags";
import { localMemorySessionUnlocked } from "../local-memory/storage";
import type { MemoryRepository } from "../local-memory/types";

export const MAX_INBOX_TRIAGE_ITEMS = 10;
export const MAX_INBOX_TRIAGE_EXCERPT = 600;
type ReadRepository = Pick<MemoryRepository, "listCollections" | "entities">;

export type InboxTriageRecord = {
  noteId: string;
  expectedVersion: number;
  title: string;
  excerpt: string;
  tags: string[];
};
export type InboxTriagePage = {
  items: InboxTriageRecord[];
  nextCursor?: number;
};
export type InboxTriageApproval = {
  conversationId: string;
  limit: number;
  /** No note content is included before the explicit user tap. */
  label: string;
};

function boundedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INBOX_TRIAGE_ITEMS)
    throw new Error("invalid_inbox_triage_limit");
  return limit;
}
function validCursor(cursor: number | undefined): number {
  if (cursor === undefined) return 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 100_000)
    throw new Error("invalid_inbox_triage_cursor");
  return cursor;
}

/** One instance belongs to ONE active conversation. It does not persist
 * approval, fetched snippets or handles to a chat row, backup or SQL table. */
export function createInboxTriageAccess(
  conversationId: string,
  isUnlocked: () => boolean = localMemorySessionUnlocked,
) {
  if (!conversationId || conversationId.length > 128) throw new Error("invalid_conversation_id");
  let requested: number | null = null;
  let approved: number | null = null;
  let activeTurn: string | null = null;
  let remaining = 0;
  const handles = new Map<string, number>();

  function clear() {
    requested = null;
    approved = null;
    activeTurn = null;
    remaining = 0;
    handles.clear();
  }
  function requireUnlocked() {
    if (!isUnlocked()) { clear(); throw new Error("application_locked"); }
  }
  function requireTurn(turnId: string) {
    requireUnlocked();
    if (!turnId || turnId !== activeTurn) throw new Error("inbox_triage_not_authorized");
  }

  return {
    /** Host action that prepares a private confirmation card. NO CONTENT READ. */
    requestApproval(limit: number): InboxTriageApproval {
      requireUnlocked();
      clear();
      requested = boundedLimit(limit);
      return {
        conversationId, limit: requested,
        label: "Разрешить разбор " + requested + " записей из «Входящих»",
      };
    },

    /** Call this ONLY from the permission card's direct user click. */
    approveFromUserTap(approvedConversationId: string): boolean {
      requireUnlocked();
      if (approvedConversationId !== conversationId || requested === null) return false;
      approved = requested;
      requested = null;
      return true;
    },

    /** Consumes approval on the very next LLM turn, never in background work. */
    beginTurn(turnId: string): boolean {
      requireUnlocked();
      if (!turnId || activeTurn || approved === null) return false;
      remaining = approved;
      approved = null;
      activeTurn = turnId;
      handles.clear();
      return true;
    },

    /** The ONLY content-reading operation for this gate. Model-provided IDs,
     * off-turn calls and >10-item pagination cannot bypass its budget. */
    async listForTurn(
      turnId: string, repository: ReadRepository,
      options: { limit: number; cursor?: number },
    ): Promise<InboxTriagePage> {
      requireTurn(turnId);
      const desired = Math.min(boundedLimit(options.limit), remaining);
      if (desired === 0) return { items: [] };
      let offset = validCursor(options.cursor);
      const sections = await repository.listCollections();
      requireTurn(turnId);
      const inbox = sections.find(s => s.slug === "inbox");
      if (!inbox) return { items: [] };
      const items: InboxTriageRecord[] = [];
      let scanned = 0;
      let more = false;
      // Bounded scan skips archived/trashed records without exposing them,
      // while preserving the EXISTING repository's created_at/id ordering.
      while (items.length < desired && scanned < 100) {
        const page = await repository.entities({
          collection_id: inbox.id, domain: "notes", limit: 20, offset,
        });
        requireTurn(turnId);
        if (!page.items.length) { more = false; break; }
        for (const note of page.items) {
          offset++;
          scanned++;
          if (note.record_status !== "active" || note.domain !== "notes" ||
              note.collection_id !== inbox.id) continue;
          const title = typeof note.title === "string" && note.title.trim()
            ? note.title.trim().slice(0, 160) : "Без названия";
          items.push({
            noteId: note.id, expectedVersion: note.record_version,
            title, excerpt: memoryText(note.payload).slice(0, MAX_INBOX_TRIAGE_EXCERPT),
            tags: noteTagsFromPayload(note.payload.tags),
          });
          handles.set(note.id, note.record_version);
          if (items.length === desired || scanned >= 100) break;
        }
        more = page.next_offset !== null && scanned < 100;
        if (!more || items.length === desired) break;
      }
      remaining -= items.length;
      requireTurn(turnId);
      return { items, ...(more && remaining > 0 ? {nextCursor: offset} : {}) };
    },

    /** A proposal tool must validate BOTH the ID and the version obtained
     * from listForTurn during this SAME approved turn. */
    wasReadThisTurn(turnId: string, noteId: string, expectedVersion: number): boolean {
      requireTurn(turnId);
      return Number.isSafeInteger(expectedVersion) &&
        handles.get(noteId) === expectedVersion;
    },

    endTurn(turnId: string): void {
      if (activeTurn === turnId) clear();
    },
    revoke(): void { clear(); },
  };
}
