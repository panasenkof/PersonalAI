/** 9T2: read-only, ACL/version-checked preview and one confirmed move.
 * This is an adapter over the SAME SQLCipher notes writer and its undo journal,
 * never a parallel memory store, index or LLM-driven write.
 */
import { withLocalMemoryDatabase, localMemorySessionUnlocked } from "../local-memory/storage";
import { withUnlockedTransaction } from "../local-memory/transaction";
import { SqliteMemoryRepository } from "../local-memory/repository";
import type { MemoryRepository } from "../local-memory/types";
import { MemoryConflictError } from "../local-memory/types";
import { changeNotes, undoNotes, type ChatMoveGuard } from "../local-memory/note-actions";
import { memoryDisplayTitle } from "../design/nebula/memoryNotePresentation";

export type ChatMoveProposal = {
  noteId:string; expectedVersion:number; title:string;
  fromCollectionId:string; fromName:string;
  toCollectionId:string; toName:string;
  reason:string; attachmentCount:number; hasSource:boolean;
};
export type ChatMoveReceipt = {
  noteId:string; title:string; fromCollectionId:string; fromName:string;
  toCollectionId:string; toName:string; batch:string;
  verified:boolean; undone?:boolean;
};
const idPattern=/^[A-Za-z0-9:_-]{1,128}$/;
const titlePattern=/^[\s\S]{1,160}$/;
const normal=(s:string)=>s.trim();
export function validMoveProposal(value:unknown):value is ChatMoveProposal {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const p=value as ChatMoveProposal;
  return [p.noteId,p.fromCollectionId,p.toCollectionId].every(x=>typeof x==="string"&&idPattern.test(x)) &&
    p.fromCollectionId!==p.toCollectionId &&
    [p.title,p.fromName,p.toName].every(x=>typeof x==="string"&&titlePattern.test(x)&&normal(x).length>0) &&
    typeof p.reason==="string"&&p.reason.length>=5&&p.reason.length<=240 &&
    Number.isSafeInteger(p.expectedVersion)&&p.expectedVersion>=1 &&
    Number.isSafeInteger(p.attachmentCount)&&p.attachmentCount>=0&&p.attachmentCount<=10000 &&
    typeof p.hasSource==="boolean";
}
export function validMoveReceipt(value:unknown):value is ChatMoveReceipt {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const r=value as ChatMoveReceipt;
  return [r.noteId,r.fromCollectionId,r.toCollectionId].every(x=>typeof x==="string"&&idPattern.test(x)) &&
    r.fromCollectionId!==r.toCollectionId &&
    [r.title,r.fromName,r.toName].every(x=>typeof x==="string"&&titlePattern.test(x)&&normal(x).length>0) &&
    typeof r.batch==="string"&&/^notes:move:[A-Za-z0-9-]{6,128}$/.test(r.batch) &&
    typeof r.verified==="boolean"&&(r.undone===undefined||typeof r.undone==="boolean");
}
export type MoveRequest={noteId:string;expectedVersion:number;targetSectionSlug:string;reason:string};
function validateMoveRequest(request:MoveRequest){
  if(!idPattern.test(request.noteId)||!Number.isSafeInteger(request.expectedVersion)||
     request.expectedVersion<1||typeof request.targetSectionSlug!=="string"||
     !/^[a-z0-9_-]{1,80}$/.test(request.targetSectionSlug)||
     typeof request.reason!=="string"||normal(request.reason).length<5||
     request.reason.length>240)throw new Error("invalid_move_proposal_arguments");
}
/** Both collections must be existing and STANDARD; never silently downgrade a
 * sensitive record. The model gets only an already authorized active note. */
export async function inspectMove(
  request:MoveRequest,repository:MemoryRepository,attachmentCount=0,
):Promise<ChatMoveProposal>{
  validateMoveRequest(request);
  const [entity,collections]=await Promise.all([
    repository.entity(request.noteId),repository.listCollections(),
  ]);
  if(!entity||entity.domain!=="notes"||entity.record_status!=="active"||
     !["standard","inherit"].includes(entity.sensitivity))
    throw new Error("move_note_not_available");
  const from=collections.find(c=>c.id===entity.collection_id);
  const to=collections.find(c=>c.slug===request.targetSectionSlug);
  if(!from||!to||from.sensitivity!=="standard"||to.sensitivity!=="standard"||
     ["documents","document"].includes(to.slug)||from.id===to.id)
    throw new Error("move_target_not_available");
  if(entity.record_version!==request.expectedVersion)
    throw new MemoryConflictError("stale_memory_version");
  const preview:ChatMoveProposal={
    noteId:entity.id,expectedVersion:entity.record_version,
    title:memoryDisplayTitle(entity).slice(0,160)||"Без названия",
    fromCollectionId:from.id,fromName:from.name.slice(0,160),
    toCollectionId:to.id,toName:to.name.slice(0,160),
    reason:normal(request.reason),attachmentCount,
    hasSource:Boolean(entity.source_ref),
  };
  if(!validMoveProposal(preview))throw new Error("invalid_move_preview");
  return preview;
}
export async function previewMove(profile:string,request:MoveRequest):Promise<ChatMoveProposal>{
  validateMoveRequest(request);
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  let preview!:ChatMoveProposal;
  await withLocalMemoryDatabase(profile,db=>withUnlockedTransaction(db,async tx=>{
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    const count=await tx.getFirstAsync<{n:number}>(
      "SELECT count(*) AS n FROM memory_attachments WHERE entity_id=?",[request.noteId]);
    preview=await inspectMove(request,new SqliteMemoryRepository(tx),count?.n??0);
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
  }));
  return preview;
}
function guard(p:ChatMoveProposal|ChatMoveReceipt):ChatMoveGuard {
  return {noteId:p.noteId,fromCollectionId:p.fromCollectionId,toCollectionId:p.toCollectionId};
}
/** The click is the user's explicit confirmation. CAS + source/target ACL are
 * checked INSIDE changeNotes' original transaction before any mutation.
 * The real revision batch is returned even if post-write verification fails. */
export async function confirmMove(profile:string,p:ChatMoveProposal):Promise<ChatMoveReceipt>{
  if(!validMoveProposal(p))throw new Error("invalid_move_confirmation");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  const batch=await withLocalMemoryDatabase(profile,db=>
    changeNotes(db,"move",[{id:p.noteId,record_version:p.expectedVersion}],
      p.toCollectionId,undefined,guard(p)));
  let verified=false;
  try{
    await withLocalMemoryDatabase(profile,async db=>{
      if(!localMemorySessionUnlocked())throw new Error("application_locked");
      const entity=await new SqliteMemoryRepository(db).entity(p.noteId);
      verified=Boolean(entity&&entity.collection_id===p.toCollectionId&&
        entity.record_version===p.expectedVersion+1&&entity.record_status==="active");
    });
  }catch{verified=false;}
  return {noteId:p.noteId,title:p.title,
    fromCollectionId:p.fromCollectionId,fromName:p.fromName,
    toCollectionId:p.toCollectionId,toName:p.toName,
    batch,verified};
}
export async function undoMove(profile:string,r:ChatMoveReceipt):Promise<void>{
  if(!validMoveReceipt(r)||r.undone)throw new Error("invalid_move_undo");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  await withLocalMemoryDatabase(profile,db=>undoNotes(db,r.batch,guard(r)));
}
