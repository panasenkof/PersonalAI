/** S9-2d: explicit chat-card approval adapter over the ONE canonical
 * SQLCipher changeNotes('merge') and undoNotes revision journal.
 * Never callable through the LLM tool registry.
 */
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { changeNotes, undoNotes, type ChatMergeGuard } from "../local-memory/note-actions";
import type { VerifiedDuplicateMergeRequest } from "./duplicate-merge-gate";

const ID=/^[A-Za-z0-9:_-]{1,128}$/;
const BATCH=/^notes:merge:[A-Za-z0-9-]{6,128}$/;
export type DuplicateMergeReceipt = {
  batch:string;keepNoteId:string;noteIds:string[];mergedCount:number;
  undone?:true;
};
export function validDuplicateMergeProposal(value:unknown):value is VerifiedDuplicateMergeRequest {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const p=value as VerifiedDuplicateMergeRequest;
  if(!Array.isArray(p.noteIds)||p.noteIds.length<2||p.noteIds.length>5||
     !Array.isArray(p.expectedVersions)||p.expectedVersions.length!==p.noteIds.length||
     !Array.isArray(p.records)||p.records.length!==p.noteIds.length||
     p.noteIds.some(id=>typeof id!=="string"||!ID.test(id))||
     new Set(p.noteIds).size!==p.noteIds.length||
     p.noteIds[0]!==p.keepNoteId ||
     p.expectedVersions.some(v=>!Number.isSafeInteger(v)||v<1)||
     typeof p.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(p.fingerprint)||
     typeof p.reason!=="string"||p.reason.trim().length<5||p.reason.length>240||
     !Number.isSafeInteger(p.attachmentCount)||p.attachmentCount<0||
     !Number.isSafeInteger(p.sourceTagEntries)||p.sourceTagEntries<0)return false;
  if(p.records.some((r,i)=>!r||r.id!==p.noteIds[i]||r.version!==p.expectedVersions[i]||
     typeof r.title!=="string"||r.title.length>160||
     typeof r.section!=="string"||r.section.length>80||
     typeof r.collectionId!=="string"||
     !Number.isSafeInteger(r.attachmentCount)||r.attachmentCount<0||
     !Number.isSafeInteger(r.tagCount)||r.tagCount<0))return false;
  return p.attachmentCount===p.records.reduce((a,r)=>a+r.attachmentCount,0) &&
    p.sourceTagEntries===p.records.reduce((a,r)=>a+r.tagCount,0);
}
export function validDuplicateMergeReceipt(value:unknown):value is DuplicateMergeReceipt {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const r=value as DuplicateMergeReceipt;
  return typeof r.batch==="string" && BATCH.test(r.batch) &&
    Array.isArray(r.noteIds)&&r.noteIds.length>=2&&r.noteIds.length<=5&&
    r.noteIds.every(id=>typeof id==="string"&&ID.test(id))&&
    new Set(r.noteIds).size===r.noteIds.length &&
    r.keepNoteId===r.noteIds[0] && r.mergedCount===r.noteIds.length-1 &&
    (r.undone===undefined||r.undone===true);
}
export async function confirmDuplicateMerge(
  profile:string,proposal:VerifiedDuplicateMergeRequest,
):Promise<DuplicateMergeReceipt>{
  if(!validDuplicateMergeProposal(proposal))throw new Error("invalid_duplicate_merge_confirmation");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  const selection=proposal.noteIds.map((id,i)=>({
    id,record_version:proposal.expectedVersions[i],
  }));
  const guard:ChatMergeGuard={noteIds:[...proposal.noteIds],keepNoteId:proposal.keepNoteId};
  const batch=await withLocalMemoryDatabase(profile,db=>
    changeNotes(db,"merge",selection,undefined,undefined,undefined,guard));
  const receipt:DuplicateMergeReceipt={
    batch,keepNoteId:proposal.keepNoteId,noteIds:[...proposal.noteIds],
    mergedCount:proposal.noteIds.length-1,
  };
  if(!validDuplicateMergeReceipt(receipt))throw new Error("invalid_duplicate_merge_receipt");
  return receipt;
}
export async function undoDuplicateMerge(
  profile:string,receipt:DuplicateMergeReceipt,
):Promise<DuplicateMergeReceipt>{
  if(!validDuplicateMergeReceipt(receipt)||receipt.undone)
    throw new Error("invalid_duplicate_merge_undo");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  await withLocalMemoryDatabase(profile,db=>undoNotes(db,receipt.batch,undefined,
    {noteIds:[...receipt.noteIds],keepNoteId:receipt.keepNoteId}));
  return {...receipt,undone:true};
}
