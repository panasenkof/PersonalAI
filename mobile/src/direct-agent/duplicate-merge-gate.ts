/** S9-2b: same-turn, read-only gate for a single exact duplicate group.
 * The model cannot authorize its own IDs, change a merge target after
 * discovery, or silently omit part of a candidate group. The host still
 * rechecks every record/version/ACL in SQLCipher on the explicit user tap.
 */
import type { DuplicateCandidate, DuplicateCandidateGroup } from "../local-memory/agent-catalog";

export type DuplicateMergeRequest = {
  noteIds: string[];
  expectedVersions: number[];
  keepNoteId: string;
  reason: string;
};
export type VerifiedDuplicateMergeRequest = DuplicateMergeRequest & {
  fingerprint: string;
  records: DuplicateCandidate[];
  attachmentCount: number;
  proposedTagCount: number;
};
const NOTE_ID=/^[A-Za-z0-9:_-]{1,128}$/;
function plainRecord(raw:unknown):raw is Record<string,unknown>{
  return Boolean(raw) && typeof raw==="object" && !Array.isArray(raw);
}
/** Pass ONLY groups admitted by find_duplicate_candidates THIS turn.
 * A fresh request after lock, Stop or next turn must discover candidates anew. */
export function verifyDuplicateMergeRequest(
  raw:unknown, groups:readonly DuplicateCandidateGroup[],
):VerifiedDuplicateMergeRequest {
  if(!plainRecord(raw) ||
     Object.keys(raw).sort().join(",")!=="expectedVersions,keepNoteId,noteIds,reason" ||
     !Array.isArray(raw.noteIds) || !Array.isArray(raw.expectedVersions) ||
     raw.noteIds.length<2 || raw.noteIds.length>5 ||
     raw.expectedVersions.length!==raw.noteIds.length ||
     raw.noteIds.some(id=>typeof id!=="string" || !NOTE_ID.test(id)) ||
     new Set(raw.noteIds).size!==raw.noteIds.length ||
     raw.expectedVersions.some(v=>!Number.isSafeInteger(v)||v<1) ||
     typeof raw.keepNoteId!=="string" || !raw.noteIds.includes(raw.keepNoteId) ||
     typeof raw.reason!=="string" ||
     raw.reason.trim().length<5 || raw.reason.length>240)
    throw new Error("invalid_duplicate_merge_request");
  const requested=new Map<string,number>();
  raw.noteIds.forEach((id:string,i:number)=>requested.set(id,raw.expectedVersions[i]));
  const matching=groups.filter(group=>group.complete===true &&
    Number.isSafeInteger(group.totalCount) &&
    group.records.length===group.totalCount &&
    group.records.length===requested.size &&
    group.records.every(record=>requested.get(record.id)===record.version) &&
    new Set(group.records.map(record=>record.id)).size===group.records.length);
  if(matching.length!==1)
    throw new Error("duplicate_merge_group_not_verified_this_turn");
  const group=matching[0];
  if(typeof group.fingerprint!=="string" || !/^[a-f0-9]{64}$/.test(group.fingerprint))
    throw new Error("invalid_duplicate_group_fingerprint");
  // Keep is first: changeNotes('merge') preserves row #0 and supersedes all
  // following rows. Other participants retain the canonical reader ordering.
  const records=[
    group.records.find(record=>record.id===raw.keepNoteId)!,
    ...group.records.filter(record=>record.id!==raw.keepNoteId),
  ];
  return {
    noteIds:records.map(item=>item.id),
    expectedVersions:records.map(item=>item.version),
    keepNoteId:raw.keepNoteId,reason:raw.reason.trim(),
    fingerprint:group.fingerprint,records,
    attachmentCount:records.reduce((sum,item)=>sum+item.attachmentCount,0),
    proposedTagCount:records.reduce((sum,item)=>sum+item.tagCount,0),
  };
}
