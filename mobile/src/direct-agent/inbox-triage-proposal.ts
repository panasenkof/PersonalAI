/** S9-1c1: validate model-proposed Inbox classification before a UI card exists.
 * This is a pure boundary. It neither grants Inbox access nor writes SQLCipher.
 * The caller MUST supply the approved turn's wasReadThisTurn handle checker.
 */
import { checkedNoteTags } from "../local-memory/note-tags";
import type { CollectionRecord } from "../local-memory/types";

export type InboxTriageItem = {
  noteId: string;
  expectedVersion: number;
  targetSectionSlug: string;
  tags: string[];
  reason: string;
};
export type InboxTriageProposal = { items: InboxTriageItem[] };
export type InboxTriageValidationContext = {
  sections: CollectionRecord[];
  wasReadThisTurn: (noteId: string, expectedVersion: number) => boolean;
};

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
const own = (value: unknown): value is Record<string,unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function standardDestination(slug: string, sections: CollectionRecord[]): boolean {
  const byId = new Map(sections.map(section => [section.id,section]));
  let section = sections.find(section => section.slug === slug);
  const seen = new Set<string>();
  if (!section || section.slug === "inbox" || section.slug === "documents") return false;
  while (section) {
    if (seen.has(section.id) || section.sensitivity !== "standard" ||
        section.slug === "inbox" || section.slug === "documents") return false;
    seen.add(section.id);
    if (section.parent_id && !byId.has(section.parent_id)) return false;
    section = section.parent_id ? byId.get(section.parent_id) : undefined;
  }
  return true;
}

/** Fail closed: no partial proposal when any row is forged or malformed. */
export function validateInboxTriageProposal(
  raw: unknown, context: InboxTriageValidationContext,
): InboxTriageProposal {
  if (!own(raw) || Object.keys(raw).join(",") !== "items" ||
      !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 10)
    throw new Error("invalid_inbox_triage_proposal");
  const seen = new Set<string>();
  const items: InboxTriageItem[] = [];
  for (const value of raw.items) {
    if (!own(value) ||
        Object.keys(value).sort().join(",") !==
          "expectedVersion,noteId,reason,tags,targetSectionSlug" ||
        typeof value.noteId !== "string" || !ID.test(value.noteId) ||
        !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1 ||
        typeof value.targetSectionSlug !== "string" || !SLUG.test(value.targetSectionSlug) ||
        typeof value.reason !== "string" || value.reason.trim().length < 5 ||
        value.reason.length > 240 ||
        !Array.isArray(value.tags) || value.tags.length > 5 ||
        seen.has(value.noteId))
      throw new Error("invalid_inbox_triage_item");
    if (!context.wasReadThisTurn(value.noteId, value.expectedVersion as number))
      throw new Error("inbox_triage_note_not_read_this_turn");
    if (!standardDestination(value.targetSectionSlug, context.sections))
      throw new Error("inbox_triage_target_not_standard");
    let tags: string[];
    try { tags = checkedNoteTags(value.tags); }
    catch { throw new Error("invalid_inbox_triage_tags"); }
    seen.add(value.noteId);
    items.push({
      noteId:value.noteId,
      expectedVersion:value.expectedVersion as number,
      targetSectionSlug:value.targetSectionSlug,
      tags,
      reason:value.reason.trim(),
    });
  }
  return {items};
}

/** UI selection is a strict subset of this validated proposal, never model-supplied SQL IDs. */
export function selectInboxTriageItems(proposal: InboxTriageProposal, ids: readonly string[]): InboxTriageItem[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 ||
      new Set(ids).size !== ids.length)
    throw new Error("invalid_inbox_triage_selection");
  const selected = new Set(ids);
  if (ids.some(id => !proposal.items.some(item => item.noteId === id)))
    throw new Error("inbox_triage_selection_not_proposed");
  return proposal.items.filter(item => selected.has(item.noteId));
}
