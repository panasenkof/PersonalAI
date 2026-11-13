/** S9-1b: ephemeral Inbox permission coordinator belonging to DirectChatStore.
 * Not persistent state, an agent runtime, a database writer, or another reader.
 * All content is retrieved through the SAME per-profile SQLCipher lease.
 */
import { withLocalMemoryDatabase, localMemorySessionUnlocked } from "../local-memory/storage";
import { SqliteMemoryRepository } from "../local-memory/repository";
import { createInboxTriageAccess, type InboxTriageApproval, type InboxTriagePage } from "./inbox-triage";
import { validateInboxTriageProposal, type InboxTriageProposal } from "./inbox-triage-proposal";

type Grant = {
  access: ReturnType<typeof createInboxTriageAccess>;
  approval: InboxTriageApproval;
  rowId?: string;
  approved: boolean;
  activeTurn?: string;
  titles: Map<string, string>;
};

export class InboxTriageChatAccess {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly profile: string,
    private readonly available: () => boolean,
  ) {}

  private ensureAvailable() {
    if (!this.available() || !localMemorySessionUnlocked())
      throw new Error("application_locked");
  }

  /** LLM request tool; content is NOT read. Replaces any stale older card. */
  request(conversationId: string, limit: number): InboxTriageApproval {
    this.ensureAvailable();
    this.revoke(conversationId);
    const access = createInboxTriageAccess(conversationId);
    const approval = access.requestApproval(limit);
    this.grants.set(conversationId, { access, approval, approved: false, titles: new Map() });
    return approval;
  }

  /** The completed assistant row becomes the unique clickable grant target. */
  markRow(conversationId: string, rowId: string, approval: InboxTriageApproval): boolean {
    const grant = this.grants.get(conversationId);
    if (!grant || grant.approval !== approval || grant.approved || grant.rowId ||
        !rowId) return false;
    grant.rowId = rowId;
    return true;
  }

  /** Only a REAL user click may call this; no method in the LLM catalog does. */
  confirm(conversationId: string, rowId: string, approval: InboxTriageApproval): boolean {
    this.ensureAvailable();
    const grant = this.grants.get(conversationId);
    if (!grant || grant.rowId !== rowId || grant.approval !== approval || grant.approved)
      return false;
    if (!grant.access.approveFromUserTap(conversationId)) return false;
    grant.approved = true;
    return true;
  }

  /** Exactly the follow-up chat turn triggered by a confirmed row. */
  beginTurn(conversationId: string, rowId: string, turnId: string): boolean {
    this.ensureAvailable();
    const grant = this.grants.get(conversationId);
    if (!grant || !grant.approved || grant.activeTurn || grant.rowId !== rowId ||
        !grant.access.beginTurn(turnId)) return false;
    grant.activeTurn = turnId;
    return true;
  }

  async listForTurn(conversationId: string, turnId: string,
    options: {limit:number;cursor?:number}, signal?: AbortSignal): Promise<InboxTriagePage> {
    this.ensureAvailable();
    const grant = this.grants.get(conversationId);
    if (!grant || !grant.approved || grant.activeTurn !== turnId || signal?.aborted)
      throw new Error("inbox_triage_not_authorized");
    const result = await withLocalMemoryDatabase(this.profile, db =>
      grant.access.listForTurn(turnId, new SqliteMemoryRepository(db), options));
    if (signal?.aborted || !this.available() || !localMemorySessionUnlocked() ||
        this.grants.get(conversationId) !== grant)
      throw new Error("inbox_triage_not_authorized");
    for (const item of result.items) grant.titles.set(item.noteId, item.title);
    return result;
  }

  /** Model may propose only note handles returned in this EXACT authorized turn.
   * No writes, no new reader and no capability surviving a revoked grant. */
  async proposeForTurn(conversationId: string, turnId: string, raw: unknown,
    signal?: AbortSignal): Promise<InboxTriageProposal> {
    this.ensureAvailable();
    const grant = this.grants.get(conversationId);
    if (!grant || !grant.approved || grant.activeTurn !== turnId || signal?.aborted)
      throw new Error("inbox_triage_not_authorized");
    const proposal = await withLocalMemoryDatabase(this.profile, async db => {
      const sections = await new SqliteMemoryRepository(db).listCollections();
      if (signal?.aborted || this.grants.get(conversationId) !== grant ||
          !localMemorySessionUnlocked()) throw new Error("inbox_triage_not_authorized");
      const validated = validateInboxTriageProposal(raw, {
        sections,
        wasReadThisTurn: (noteId, expectedVersion) =>
          grant.access.wasReadThisTurn(turnId, noteId, expectedVersion),
      });
      return {items:validated.items.map(item => ({...item,
        displayTitle: grant.titles.get(item.noteId) || "Без названия",
        targetSectionName:sections.find(c=>c.slug===item.targetSectionSlug)?.name || item.targetSectionSlug,
      }))};
    });
    if (signal?.aborted || !this.available() || !localMemorySessionUnlocked() ||
        this.grants.get(conversationId) !== grant)
      throw new Error("inbox_triage_not_authorized");
    return proposal;
  }

  dismiss(conversationId: string, rowId: string): boolean {
    const grant = this.grants.get(conversationId);
    if (!grant || grant.rowId !== rowId || grant.approved) return false;
    this.revoke(conversationId);
    return true;
  }

  endTurn(conversationId: string, turnId: string) {
    const grant = this.grants.get(conversationId);
    if (grant?.activeTurn === turnId) this.revoke(conversationId);
  }
  revoke(conversationId: string) {
    this.grants.get(conversationId)?.access.revoke();
    this.grants.delete(conversationId);
  }
  revokeAll() {
    for (const key of this.grants.keys()) this.revoke(key);
  }
}
