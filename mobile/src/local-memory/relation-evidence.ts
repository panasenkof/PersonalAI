/**
 * №66.4 R1b: one canonical SQLCipher relation edge, many user-confirmed
 * source-versioned witnesses. No model/agent tool may call this mutation.
 * Legacy memory_relations alone are NOT verified relationship proofs.
 */
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import { memoryText } from "./search-index";
import {
  resolveDirectRelationConversationPaths,
  type DirectPersonRelation, type RelationProof,
  type RelationProofKind, type RelativeConversationResult, type ProofAccess,
} from "./relational-proof";

type SQL = Pick<SQLite.SQLiteDatabase,"getFirstAsync"|"getAllAsync"|"runAsync"|"execAsync">;
export type ConfirmRelationInput = {
  sourceId:string; sourceVersion:number;
  targetId:string; targetVersion:number;
  kind:DirectPersonRelation|"participant_of";
  evidenceId:string; evidenceVersion:number;
  /** This exact quote must be present in the currently saved original note. */
  evidenceQuote:string;
  /** Caller is a deliberate, explicit USER confirmation, never inference. */
  userConfirmed:true;
};
export type ConfirmRelationResult = {relationId:string;evidenceId:string;added:boolean};
const uid=()=>Crypto.randomUUID();
const validId=(id:unknown)=>typeof id==="string"&&id.trim().length>0&&id.length<=256&&!/[\u0000-\u001f]/.test(id);
const validVersion=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const ROLES:readonly string[]=[
  "has_sister","has_brother","has_mother","has_father","has_spouse",
  "has_child","has_friend","has_colleague","has_doctor","has_teacher",
  "participant_of",
];
type EntityScope={id:string;kind:string;domain:string;record_version:number;payload_json:string};
async function allowedEntity(db:SQL,id:string,version:number):Promise<EntityScope>{
  const row=await db.getFirstAsync<EntityScope>(
    "SELECT e.id,e.kind,e.domain,e.record_version,e.payload_json FROM memory_entities e " +
    "JOIN memory_collections c ON c.id=e.collection_id " +
    "WHERE e.id=? AND e.record_version=? AND e.record_status='active' " +
    "AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'",
    [id,version],
  );
  if(!row)throw new Error("relational_source_not_available_or_stale");
  return row;
}

export async function confirmUserRelationEvidence(
  db:SQL,req:ConfirmRelationInput,
):Promise<ConfirmRelationResult>{
  if(!validId(req.sourceId)||!validId(req.targetId)||!validId(req.evidenceId)||
     req.sourceId===req.targetId||![req.sourceVersion,req.targetVersion,req.evidenceVersion].every(validVersion)||
     !ROLES.includes(req.kind)||req.userConfirmed!==true||
     typeof req.evidenceQuote!=="string"||!req.evidenceQuote.trim()||
     req.evidenceQuote.length>6000){
    throw new Error("relational_confirmation_invalid");
  }
  let result:ConfirmRelationResult|null=null;
  await withUnlockedTransaction(db,async tx=>{
    const source=await allowedEntity(tx,req.sourceId,req.sourceVersion);
    const target=await allowedEntity(tx,req.targetId,req.targetVersion);
    const evidence=await allowedEntity(tx,req.evidenceId,req.evidenceVersion);
    if(req.kind==="participant_of"){
      if(source.kind!=="note"||target.kind!=="person"){
        throw new Error("relational_role_endpoints_invalid");
      }
    }else if(source.kind!=="person"||target.kind!=="person"){
      throw new Error("relational_role_endpoints_invalid");
    }
    // The witness is anchored to a real saved text; no invented citation from
    // a model draft, filename, mere mention or unavailable ASR segment.
    if(evidence.domain!=="notes"||
       !memoryText(JSON.parse(evidence.payload_json)).includes(req.evidenceQuote.trim())){
      throw new Error("relational_evidence_quote_not_found");
    }
    let relation=await tx.getFirstAsync<{id:string;source_kind:string|null}>(
      "SELECT id,source_kind FROM memory_relations "+
      "WHERE source_entity_id=? AND target_entity_id=? AND kind=?",
      [req.sourceId,req.targetId,req.kind],
    );
    if(relation?.source_kind==="model:auto"){
      // An explicit user-confirmed witness takes ownership of an existing
      // canonical edge so the enrichment re-index cannot delete it.
      await tx.runAsync(
        "UPDATE memory_relations SET source_kind='user:confirmed',source_ref=NULL WHERE id=?",
        [relation.id],
      );
    }
    if(!relation){
      const id=uid();
      await tx.runAsync(
        "INSERT INTO memory_relations "+
        "(id,source_entity_id,target_entity_id,kind,source_kind,source_ref,created_at) "+
        "VALUES (?,?,?,?,'user:confirmed',NULL,?)",
        [id,req.sourceId,req.targetId,req.kind,new Date().toISOString()],
      );
      relation={id,source_kind:"user:confirmed"};
    }
    const existing=await tx.getFirstAsync<{id:string;state:string}>(
      "SELECT id,state FROM memory_relation_evidence "+
      "WHERE relation_id=? AND evidence_entity_id=? AND evidence_record_version=? AND quote=?",
      [relation.id,req.evidenceId,req.evidenceVersion,req.evidenceQuote.trim()],
    );
    if(existing){
      if(existing.state!=="confirmed")throw new Error("relational_evidence_retracted");
      result={relationId:relation.id,evidenceId:existing.id,added:false};
      return;
    }
    const id=uid();
    await tx.runAsync(
      "INSERT INTO memory_relation_evidence "+
      "(id,relation_id,evidence_entity_id,evidence_record_version,source_record_version,"+
      "target_record_version,quote,origin,actor_kind,state,created_at) "+
      "VALUES (?,?,?,?,?,?,?,'explicit_user','user','confirmed',?)",
      [id,relation.id,req.evidenceId,req.evidenceVersion,req.sourceVersion,
       req.targetVersion,req.evidenceQuote.trim(),new Date().toISOString()],
    );
    result={relationId:relation.id,evidenceId:id,added:true};
  });
  if(!result)throw new Error("relational_confirm_not_committed");
  return result;
}

type ProofRow={
  relation_id:string; kind:RelationProofKind;source_entity_id:string;target_entity_id:string;
  source_record_version:number;target_record_version:number;
  evidence_id:string;evidence_entity_id:string;evidence_record_version:number;
  quote:string;
};


/** Same ACL and source-revision SELECT for both direct proof reads and the
 * bounded relation→participant traversal. A projection, not a second graph. */
const CURRENT_PROOF_SQL=
  "SELECT r.id AS relation_id,r.kind,r.source_entity_id,r.target_entity_id, " +
  "se.record_version AS source_record_version,te.record_version AS target_record_version, " +
  "w.id AS evidence_id,w.evidence_entity_id,w.evidence_record_version,w.quote " +
  "FROM memory_relations r " +
  "JOIN memory_relation_evidence w ON w.relation_id=r.id AND w.state='confirmed' " +
  "JOIN memory_entities se ON se.id=r.source_entity_id AND se.record_version=w.source_record_version AND se.record_status='active' " +
  "JOIN memory_entities te ON te.id=r.target_entity_id AND te.record_version=w.target_record_version AND te.record_status='active' " +
  "JOIN memory_entities ev ON ev.id=w.evidence_entity_id AND ev.record_version=w.evidence_record_version AND ev.record_status='active' " +
  "JOIN memory_collections sc ON sc.id=se.collection_id AND sc.sensitivity='standard' " +
  "JOIN memory_collections tc ON tc.id=te.collection_id AND tc.sensitivity='standard' " +
  "JOIN memory_collections ec ON ec.id=ev.collection_id AND ec.sensitivity='standard' " +
  "WHERE se.sensitivity IN ('standard','inherit') AND te.sensitivity IN ('standard','inherit') " +
  "AND ev.sensitivity IN ('standard','inherit') ";

function toProof(row:ProofRow):RelationProof {
  return {
    id:row.evidence_id,kind:row.kind,sourceEntityId:row.source_entity_id,
    targetEntityId:row.target_entity_id,
    sourceRecordVersion:row.source_record_version,targetRecordVersion:row.target_record_version,
    evidenceEntityId:row.evidence_entity_id,evidenceRecordVersion:row.evidence_record_version,
    evidenceQuote:row.quote,status:"confirmed",evidenceState:"current",
    identityState:"resolved",
  };
}
/** Only current readable source-backed proofs, never legacy or model:auto links. */
export async function listCurrentConfirmedRelationProofs(
  db:SQL,query:{sourceId:string;kind?:DirectPersonRelation|"participant_of";limit?:number},
):Promise<{items:RelationProof[];partial:boolean}>{
  if(!validId(query.sourceId)|| (query.kind!==undefined&&!ROLES.includes(query.kind))){
    throw new Error("relational_query_invalid");
  }
  const limit=query.limit??30;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error("relational_limit_invalid");
  const rows=await db.getAllAsync<ProofRow>(
    CURRENT_PROOF_SQL+
    "AND r.source_entity_id=? AND (r.kind=? OR ? IS NULL) "+
    "ORDER BY w.created_at,w.id LIMIT ?",
    [query.sourceId,query.kind??null,query.kind??null,limit+1],
  );
  return {items:rows.slice(0,limit).map(toProof),partial:rows.length>limit};
}

/**
 * A source-verified graph path in the existing SQLCipher memory engine:
 * owner --confirmed social role--> person <--confirmed participant-- note.
 * Returns note entity IDs + proof IDs only; caller MUST re-check/open the
 * original via the existing source-read route. No audio timestamp is invented.
 */
export async function findCurrentRelativeConversationPaths(
  db:SQL,query:{ownerPersonId:string;relationKind:DirectPersonRelation},
):Promise<RelativeConversationResult>{
  if(!validId(query.ownerPersonId)||!ROLES.includes(query.relationKind)){
    throw new Error("relational_query_invalid");
  }
  const first=await listCurrentConfirmedRelationProofs(db,{
    sourceId:query.ownerPersonId,kind:query.relationKind,limit:100,
  });
  const ids=[...new Set(first.items.map(v=>v.targetEntityId))];
  if(ids.length===0)return {paths:[],truncated:first.partial};
  const placeholders=ids.map(()=>"?").join(",");
  // Use target ID selection BEFORE the LIMIT. Otherwise unrelated recordings
  // could starve a true participant, or a partial list could look exhaustive.
  const rows=await db.getAllAsync<ProofRow>(
    CURRENT_PROOF_SQL+
    "AND r.kind='participant_of' AND se.kind='note' AND te.kind='person' "+
    "AND r.target_entity_id IN ("+placeholders+") "+
    "ORDER BY w.created_at,w.id LIMIT 257",
    ids,
  );
  const participants=rows.slice(0,256).map(toProof);
  const edges=[...first.items,...participants];
  const versions=new Map<string,number>();
  const readable=new Set<string>();
  for(const e of edges){
    versions.set(e.sourceEntityId,e.sourceRecordVersion);
    versions.set(e.targetEntityId,e.targetRecordVersion);
    versions.set(e.evidenceEntityId,e.evidenceRecordVersion);
    readable.add(e.evidenceEntityId);
  }
  const access:ProofAccess={recordVersions:versions,readableEvidence:readable};
  const proof=resolveDirectRelationConversationPaths(
    query.ownerPersonId,query.relationKind,edges,access);
  return {paths:proof.paths,
    truncated:proof.truncated||first.partial||rows.length>256};
}
