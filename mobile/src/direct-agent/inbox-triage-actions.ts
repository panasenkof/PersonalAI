/** S9-1c: review/undo adapter for the canonical note-actions SQLCipher writer.
 * The model cannot call these functions: only the chat confirmation UI can.
 */
import { withLocalMemoryDatabase, localMemorySessionUnlocked } from "../local-memory/storage";
import { applyInboxTriageNotes, undoNotes } from "../local-memory/note-actions";
import { selectInboxTriageItems, type InboxTriageProposal } from "./inbox-triage-proposal";

export type InboxTriageReceipt = {
  batch: string;
  applied: string[];
  skipped: string[];
  undone?: true;
};

const ID=/^[A-Za-z0-9:_-]{1,128}$/;
const BATCH=/^notes:inbox_triage:[A-Za-z0-9-]{6,80}$/;

export function validInboxTriageReceipt(value: unknown): value is InboxTriageReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r=value as Record<string, unknown>;
  return typeof r.batch === "string" && BATCH.test(r.batch) &&
    Array.isArray(r.applied) && Array.isArray(r.skipped) &&
    r.applied.length + r.skipped.length <= 10 &&
    r.applied.every(x=>typeof x==="string"&&ID.test(x)) &&
    r.skipped.every(x=>typeof x==="string"&&ID.test(x)) &&
    new Set([...r.applied,...r.skipped]).size===r.applied.length+r.skipped.length &&
    (r.undone===undefined || r.undone===true);
}

export async function confirmInboxTriage(
  profile:string, proposal:InboxTriageProposal, selectedIds?:readonly string[],
):Promise<InboxTriageReceipt> {
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  // Always reject missing selection; no implicit "apply all" path.
  const selected=selectInboxTriageItems(proposal,selectedIds || []);
  const receipt=await withLocalMemoryDatabase(profile,db=>applyInboxTriageNotes(db,
    selected.map(item=>({noteId:item.noteId,expectedVersion:item.expectedVersion,
      targetSectionSlug:item.targetSectionSlug,tags:item.tags}))));
  if(!validInboxTriageReceipt(receipt))
    throw new Error("inbox_triage_invalid_receipt");
  return receipt;
}

export async function undoInboxTriage(
  profile:string, receipt:InboxTriageReceipt,
):Promise<InboxTriageReceipt> {
  if(!validInboxTriageReceipt(receipt)||receipt.undone||!receipt.applied.length)
    throw new Error("inbox_triage_undo_not_available");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  await withLocalMemoryDatabase(profile,db=>undoNotes(db,receipt.batch));
  return {...receipt,undone:true};
}
