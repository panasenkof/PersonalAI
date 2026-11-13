/** S9-1c foundation: a *proposal*, never a memory mutation.
 * One-time read handles are checked by the SAME InboxTriageAccess that made
 * the approved tool call. No new reader, store, writer or permission grant.
 */
import { checkedNoteTags } from "../local-memory/note-tags";
import type { MemorySection } from "./fact-tool";

export const MAX_INBOX_TRIAGE_PROPOSALS=10;
export const MAX_INBOX_TRIAGE_PROPOSAL_TAGS=5;
export type InboxTriageSuggestion={
  noteId:string;expectedVersion:number;targetSectionSlug:string;
  tags:string[];reason:string;
};
export type InboxTriageProposal={
  kind:"inbox_triage";items:InboxTriageSuggestion[];
  requiresUserTap:true;saved:false;
};

/** Caller MUST supply a same-turn read-handle check, not a generic ID lookup. */
export function checkedInboxTriageProposal(
  input:unknown,
  sections:readonly MemorySection[],
  wasReadThisTurn:(noteId:string,expectedVersion:number)=>boolean,
):InboxTriageProposal {
  if(!Array.isArray(input)||input.length<1||input.length>MAX_INBOX_TRIAGE_PROPOSALS)
    throw new Error("invalid_inbox_triage_items");
  const allowed=new Set(sections
    .map(s=>s.slug).filter(s=>/^[a-z0-9_-]{1,80}$/.test(s)&&
      !["inbox","documents","document"].includes(s)));
  const used=new Set<string>();
  const items:InboxTriageSuggestion[]=input.map(raw=>{
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new Error("invalid_inbox_triage_item");
    const v=raw as Record<string,unknown>;
    if(Object.keys(v).sort().join(",")!=="expectedVersion,noteId,reason,tags,targetSectionSlug" ||
      typeof v.noteId!=="string"||!/^[A-Za-z0-9:_-]{1,128}$/.test(v.noteId)||
      !Number.isSafeInteger(v.expectedVersion)||(v.expectedVersion as number)<1||
      typeof v.targetSectionSlug!=="string"||!allowed.has(v.targetSectionSlug)||
      typeof v.reason!=="string"||v.reason.trim().length<5||v.reason.length>240||
      !Array.isArray(v.tags)||v.tags.length>MAX_INBOX_TRIAGE_PROPOSAL_TAGS)
      throw new Error("invalid_inbox_triage_item");
    const id=v.noteId as string,version=v.expectedVersion as number;
    if(used.has(id))throw new Error("duplicate_inbox_triage_note");
    used.add(id);
    if(!wasReadThisTurn(id,version))throw new Error("inbox_triage_note_not_read_this_turn");
    const tags=checkedNoteTags(v.tags);
    if(tags.length>MAX_INBOX_TRIAGE_PROPOSAL_TAGS)
      throw new Error("invalid_inbox_triage_tags");
    return {noteId:id,expectedVersion:version,
      targetSectionSlug:v.targetSectionSlug as string,tags,
      reason:(v.reason as string).trim()};
  });
  return {kind:"inbox_triage",items,requiresUserTap:true,saved:false};
}
