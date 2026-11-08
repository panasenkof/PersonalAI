/** LLM section-management proposals. Only the UI's explicit confirmation may
 * call the existing SQLCipher collection writer. No second tree or queue.
 * Delete is intentionally EMPTY-CUSTOM-STANDARD ONLY (all record statuses).
 */
import * as Crypto from "expo-crypto";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { SqliteMemoryRepository } from "../local-memory/repository";
import { collectionPath } from "../local-memory/sections";
import type { CollectionRecord } from "../local-memory/types";

export type SectionActionRequest =
  | {kind:"create";name:string;parentSlug:string|null;reason:string}
  | {kind:"delete";sectionSlug:string;reason:string};
export type ChatSectionProposal =
  | {kind:"create";name:string;parentId:string|null;parentName:string|null;reason:string}
  | {kind:"delete";id:string;slug:string;name:string;parentId:string|null;
     parentName:string|null;createdAt:string;reason:string;recordCount:0;childCount:0};
export type ChatSectionReceipt = {
  kind:"create"|"delete";id:string;slug:string;name:string;
  parentName:string|null;verified:boolean;
};
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
const BUILTIN = new Set(["about","people","projects","preferences","dates","documents","notes","inbox"]);
const own = (c:CollectionRecord) => c.sensitivity==="standard" && !BUILTIN.has(c.slug);
const label = (name:unknown):name is string =>
  typeof name==="string" && name.length<=80 && name.trim().length>0 &&
  ![...name].some(ch => ch==="/" || ch==="\\" || ch.charCodeAt(0)<32);
const pathOk = (value:unknown):value is string =>
  typeof value==="string" && value.trim().length>0 && value.length<=16384 &&
  ![...value].some(ch=>ch.charCodeAt(0)<32);
const reasonOk = (r:unknown):r is string =>
  typeof r==="string" && r.trim().length>=5 && r.length<=240;
const root = (c:CollectionRecord) => c.parent_id ?? null;

export function validSectionProposal(value:unknown):value is ChatSectionProposal {
  if (!value || typeof value!=="object" || Array.isArray(value)) return false;
  const p=value as ChatSectionProposal;
  if (!reasonOk(p.reason) || !label(p.name) ||
      !(p.parentId===null || (typeof p.parentId==="string" && ID.test(p.parentId))) ||
      !(p.parentName===null || pathOk(p.parentName)) ||
      (p.parentId===null)!==(p.parentName===null)) return false;
  if(p.kind==="create")return true;
  return p.kind==="delete" && typeof p.id==="string" && ID.test(p.id) &&
    typeof p.slug==="string" && SLUG.test(p.slug) && !BUILTIN.has(p.slug) &&
    typeof p.createdAt==="string" && p.createdAt.length>0 && p.createdAt.length<=80 &&
    p.recordCount===0 && p.childCount===0;
}
export function validSectionReceipt(value:unknown):value is ChatSectionReceipt {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const r=value as ChatSectionReceipt;
  return (r.kind==="create"||r.kind==="delete") &&
    typeof r.id==="string"&&ID.test(r.id)&&typeof r.slug==="string"&&SLUG.test(r.slug)&&
    label(r.name) && (r.parentName===null||pathOk(r.parentName)) && typeof r.verified==="boolean";
}
export function validateSectionRequest(value:unknown):value is SectionActionRequest {
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const v=value as SectionActionRequest;
  if(!reasonOk(v.reason))return false;
  if(v.kind==="create")
    return Object.keys(v).sort().join(",")==="kind,name,parentSlug,reason" &&
      label(v.name) && (v.parentSlug===null ||
        (typeof v.parentSlug==="string" && SLUG.test(v.parentSlug)));
  return v.kind==="delete" &&
    Object.keys(v).sort().join(",")==="kind,reason,sectionSlug" &&
    typeof v.sectionSlug==="string"&&SLUG.test(v.sectionSlug);
}
export async function previewSectionAction(profile:string, request:SectionActionRequest):
  Promise<ChatSectionProposal> {
  if(!validateSectionRequest(request))throw new Error("invalid_section_action_args");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  return withLocalMemoryDatabase(profile,async db=>{
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    const collections=await new SqliteMemoryRepository(db).listCollections();
    if(request.kind==="create"){
      const parent=request.parentSlug===null ? undefined :
        collections.find(c=>c.slug===request.parentSlug);
      if(request.parentSlug!==null && (!parent || parent.sensitivity!=="standard"))
        throw new Error("section_parent_unavailable");
      if(collections.some(c=>root(c)===(parent?.id??null) &&
          c.name.trim().toLocaleLowerCase()===request.name.trim().toLocaleLowerCase()))
        throw new Error("section_sibling_name_exists");
      const proposal:ChatSectionProposal={kind:"create",name:request.name.trim(),
        parentId:parent?.id??null,parentName:parent?collectionPath(parent,collections):null,
        reason:request.reason.trim()};
      if(!validSectionProposal(proposal))throw new Error("invalid_section_preview");
      return proposal;
    }
    const section=collections.find(c=>c.slug===request.sectionSlug);
    if(!section || !own(section))throw new Error("section_delete_protected_or_missing");
    if(collections.some(c=>root(c)===section.id))
      throw new Error("section_has_children");
    // Query includes archived, superseded and trashed records; not just active notes.
    const row=await db.getFirstAsync<{n:number}>(
      "SELECT count(*) AS n FROM memory_entities WHERE collection_id=?",[section.id]);
    if(!row || row.n!==0)throw new Error("section_not_empty");
    const parent=collections.find(c=>c.id===root(section));
    const proposal:ChatSectionProposal={kind:"delete",id:section.id,slug:section.slug,
      name:section.name,parentId:root(section),
      parentName:parent?collectionPath(parent,collections):null,
      createdAt:section.created_at,reason:request.reason.trim(),recordCount:0,childCount:0};
    if(!validSectionProposal(proposal))throw new Error("invalid_section_preview");
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    return proposal;
  });
}
export async function confirmSectionAction(profile:string, proposal:ChatSectionProposal):
  Promise<ChatSectionReceipt> {
  if(!validSectionProposal(proposal))throw new Error("invalid_section_confirmation");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  return withLocalMemoryDatabase(profile,async db=>{
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    const repository=new SqliteMemoryRepository(db);
    let id:string,slug:string;
    if(proposal.kind==="create"){
      // Read-only preview was NOT an authorization. Parent and sibling must still
      // be valid when the actual canonical writer opens its own transaction.
      const sections=await repository.listCollections();
      const parent=proposal.parentId===null?undefined:sections.find(c=>c.id===proposal.parentId);
      if(proposal.parentId!==null &&
         (!parent||parent.sensitivity!=="standard"||
          collectionPath(parent,sections)!==proposal.parentName))
        throw new Error("section_parent_changed");
      if(sections.some(c=>root(c)===proposal.parentId &&
          c.name.trim().toLocaleLowerCase()===proposal.name.toLocaleLowerCase()))
        throw new Error("section_sibling_name_exists");
      const created=await repository.createCollection({name:proposal.name,
        slug:"section-"+Crypto.randomUUID(),sensitivity:"standard",parentId:proposal.parentId});
      id=created.id;slug=created.slug;
    }else{
      // RESTRICT FK and revalidated presence of ANY descendant or record are
      // enforced atomically by the only collection-delete repository writer.
      await repository.deleteEmptyCollection(proposal.id,proposal.createdAt,proposal.parentId);
      id=proposal.id;slug=proposal.slug;
    }
    let verified=false;
    try {
      const current=await repository.listCollections();
      verified=proposal.kind==="create"
        ?current.some(c=>c.id===id&&c.slug===slug&&root(c)===proposal.parentId)
        :!current.some(c=>c.id===id);
    }catch {/* writer succeeded, but verification unavailable; never claim verified */ }
    return {kind:proposal.kind,id,slug,name:proposal.name,
      parentName:proposal.parentName,verified};
  });
}
