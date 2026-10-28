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


/** R2a: explicit, durable user decision on an existing confirmed witness.
 * This does not add a second relation or a competing proposal queue:
 * memory_relation_evidence stays the single witness, memory_review_actions
 * is the shared user-action journal (temporal review will migrate to it).
 */
export type RelationReviewExpected = {
  evidenceId: string; expectedVersion: number; userConfirmed: true;
};
export type RelationReviewDecision = {
  actionId: string; nextVersion: number; state: "confirmed"|"retracted";
};
type ReviewWitness = {
  id:string;state:"confirmed"|"retracted";decision_version:number;
  evidence_entity_id:string;evidence_record_version:number;
  source_record_version:number;target_record_version:number;quote:string;
  source_entity_id:string;target_entity_id:string;
};
async function loadReviewWitness(db:SQL,id:string):Promise<ReviewWitness>{
  const witness=await db.getFirstAsync<ReviewWitness>(
    "SELECT w.id,w.state,w.decision_version,w.evidence_entity_id,"+
    "w.evidence_record_version,w.source_record_version,w.target_record_version,w.quote,"+
    "r.source_entity_id,r.target_entity_id FROM memory_relation_evidence w "+
    "JOIN memory_relations r ON r.id=w.relation_id WHERE w.id=?", [id]);
  if(!witness)throw new Error("relational_witness_missing");
  const source=await allowedEntity(db,witness.source_entity_id,witness.source_record_version);
  const target=await allowedEntity(db,witness.target_entity_id,witness.target_record_version);
  const evidence=await allowedEntity(db,witness.evidence_entity_id,witness.evidence_record_version);
  if(!source||!target||evidence.domain!=="notes"||
     !memoryText(JSON.parse(evidence.payload_json)).includes(witness.quote)){
    throw new Error("relational_witness_stale");
  }
  return witness;
}
function validateReviewExpected(req:RelationReviewExpected){
  if(!validId(req?.evidenceId)||!validVersion(req?.expectedVersion)||req?.userConfirmed!==true)
    throw new Error("relational_review_invalid");
}
export async function retractUserRelationEvidence(
  db:SQL,req:RelationReviewExpected,
):Promise<RelationReviewDecision>{
  validateReviewExpected(req);
  const id=uid();let result:RelationReviewDecision|null=null;
  await withUnlockedTransaction(db,async tx=>{
    const witness=await loadReviewWitness(tx,req.evidenceId);
    if(witness.decision_version!==req.expectedVersion||witness.state!=="confirmed")
      throw new Error("relational_review_stale");
    const changed=await tx.runAsync(
      "UPDATE memory_relation_evidence SET state='retracted',decision_version=decision_version+1 "+
      "WHERE id=? AND state='confirmed' AND decision_version=?",
      [req.evidenceId,req.expectedVersion]);
    if(changed.changes!==1)throw new Error("relational_review_stale");
    await tx.runAsync(
      "INSERT INTO memory_review_actions "+
      "(id,target_kind,relation_evidence_id,action,expected_version,before_state,after_state,actor_kind,created_at) "+
      "VALUES (?,'relation',?,'retract',?,'confirmed','retracted','user',?)",
      [id,req.evidenceId,req.expectedVersion,new Date().toISOString()]);
    result={actionId:id,nextVersion:req.expectedVersion+1,state:"retracted"};
  });
  if(!result)throw new Error("relational_review_not_committed");
  return result;
}
export async function undoUserRelationRetraction(
  db:SQL,req:RelationReviewExpected&{actionId:string},
):Promise<RelationReviewDecision>{
  validateReviewExpected(req);
  if(!validId(req.actionId))throw new Error("relational_review_invalid");
  const id=uid();let result:RelationReviewDecision|null=null;
  await withUnlockedTransaction(db,async tx=>{
    const witness=await loadReviewWitness(tx,req.evidenceId);
    const previous=await tx.getFirstAsync<{
      id:string;action:string;expected_version:number;
    }>(
      "SELECT id,action,expected_version FROM memory_review_actions "+
      "WHERE id=? AND target_kind='relation' AND relation_evidence_id=?",
      [req.actionId,req.evidenceId]);
    if(!previous||previous.action!=="retract"||
       witness.state!=="retracted"||
       witness.decision_version!==req.expectedVersion||
       previous.expected_version+1!==req.expectedVersion)
      throw new Error("relational_undo_stale");
    const newer=await tx.getFirstAsync<{id:string}>(
      "SELECT id FROM memory_review_actions WHERE relation_evidence_id=? "+
      "AND (expected_version>? OR undoes_id=?) LIMIT 1",
      [req.evidenceId,previous.expected_version,previous.id]);
    if(newer)throw new Error("relational_undo_stale");
    const changed=await tx.runAsync(
      "UPDATE memory_relation_evidence SET state='confirmed',decision_version=decision_version+1 "+
      "WHERE id=? AND state='retracted' AND decision_version=?",
      [req.evidenceId,req.expectedVersion]);
    if(changed.changes!==1)throw new Error("relational_undo_stale");
    await tx.runAsync(
      "INSERT INTO memory_review_actions "+
      "(id,target_kind,relation_evidence_id,action,expected_version,before_state,after_state,undoes_id,actor_kind,created_at) "+
      "VALUES (?,'relation',?,'undo',?,'retracted','confirmed',?,'user',?)",
      [id,req.evidenceId,req.expectedVersion,req.actionId,new Date().toISOString()]);
    result={actionId:id,nextVersion:req.expectedVersion+1,state:"confirmed"};
  });
  if(!result)throw new Error("relational_review_not_committed");
  return result;
}


export type RelationReviewActionItem = {
  actionId:string;action:"retract"|"undo";expectedVersion:number;
  beforeState:string;afterState:string;undoesId:string|null;createdAt:string;
};
export async function listUserRelationReviewHistory(
  db:SQL,query:{evidenceId:string;limit?:number},
):Promise<{items:RelationReviewActionItem[];hasMore:boolean;currentState:"confirmed"|"retracted";decisionVersion:number}>{
  if(!validId(query.evidenceId))throw new Error("relational_review_invalid");
  const limit=query.limit??20;
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)
    throw new Error("relational_review_limit_invalid");
  // The same SQLCipher source/endpoint/citation eligibility gate is used
  // when displaying history; known IDs don't bypass private/secret scope.
  let outcome:{items:RelationReviewActionItem[];hasMore:boolean;currentState:"confirmed"|"retracted";decisionVersion:number}|null=null;
  await withUnlockedTransaction(db,async tx=>{
  const witness=await loadReviewWitness(tx,query.evidenceId);
  const rows=await tx.getAllAsync<{
    id:string;action:"retract"|"undo";expected_version:number;
    before_state:string;after_state:string;undoes_id:string|null;created_at:string;
  }>(
    "SELECT id,action,expected_version,before_state,after_state,undoes_id,created_at "+
    "FROM memory_review_actions WHERE target_kind='relation' AND relation_evidence_id=? "+
    "ORDER BY expected_version DESC,id DESC LIMIT ?",[query.evidenceId,limit+1],
  );
  outcome={
    items:rows.slice(0,limit).map(r=>({
      actionId:r.id,action:r.action,expectedVersion:r.expected_version,
      beforeState:r.before_state,afterState:r.after_state,
      undoesId:r.undoes_id,createdAt:r.created_at,
    })),
    hasMore:rows.length>limit,
    currentState:witness.state,decisionVersion:witness.decision_version,
  };
  });
  if(!outcome)throw new Error("relational_review_read_not_committed");
  return outcome;
}


/** R2b1: only a non-confirmed, source-backed proposal in the ONE review inbox.
 * It never inserts a canonical edge or confirmed relation witness.
 */
export type StageRelationReviewInput=Omit<ConfirmRelationInput,"userConfirmed">;
export type RelationReviewCandidate={
  targetKind:"relation";proposalId:string;status:"pending"|"deferred";
  proposalVersion:number;sourceId:string;sourceVersion:number;
  targetId:string;targetVersion:number;kind:DirectPersonRelation|"participant_of";
  evidenceId:string;evidenceVersion:number;evidenceQuote:string;
  sourceTitle:string|null;targetTitle:string|null;evidenceTitle:string|null;
  createdAt:string;
};
export type RelationInboxCursor={createdAt:string;proposalId:string};
export type RelationInboxPage={items:RelationReviewCandidate[];
  nextCursor:RelationInboxCursor|null};
const candidateValid=(v:StageRelationReviewInput)=>
  !!v&&validId(v.sourceId)&&validId(v.targetId)&&validId(v.evidenceId)&&
  v.sourceId!==v.targetId&&
  [v.sourceVersion,v.targetVersion,v.evidenceVersion].every(validVersion)&&
  ROLES.includes(v.kind)&&typeof v.evidenceQuote==="string"&&
  v.evidenceQuote.trim().length>0&&v.evidenceQuote.length<=6000;
async function validatedCandidate(db:SQL,req:StageRelationReviewInput){
  if(!candidateValid(req))throw new Error("relational_candidate_invalid");
  const source=await allowedEntity(db,req.sourceId,req.sourceVersion);
  const target=await allowedEntity(db,req.targetId,req.targetVersion);
  const evidence=await allowedEntity(db,req.evidenceId,req.evidenceVersion);
  if(req.kind==="participant_of"){
    if(source.kind!=="note"||target.kind!=="person")
      throw new Error("relational_role_endpoints_invalid");
  }else if(source.kind!=="person"||target.kind!=="person"){
    throw new Error("relational_role_endpoints_invalid");
  }
  const quote=req.evidenceQuote.trim();
  if(evidence.domain!=="notes"||
     !memoryText(JSON.parse(evidence.payload_json)).includes(quote))
    throw new Error("relational_evidence_quote_not_found");
  return quote;
}
export async function stageRelationReviewCandidate(
  db:SQL,req:StageRelationReviewInput,
):Promise<{proposalId:string;added:boolean;status:"pending"|"deferred"|"rejected"|"accepted"}>{
  if(!candidateValid(req))throw new Error("relational_candidate_invalid");
  const id=uid();let result:{
    proposalId:string;added:boolean;status:"pending"|"deferred"|"rejected"|"accepted";
  }|null=null;
  await withUnlockedTransaction(db,async tx=>{
    const quote=await validatedCandidate(tx,req);
    // A current confirmed witness must not cause a second question.
    const approved=await tx.getFirstAsync<{id:string}>(
      "SELECT w.id FROM memory_relation_evidence w JOIN memory_relations r ON r.id=w.relation_id "+
      "WHERE r.source_entity_id=? AND r.target_entity_id=? AND r.kind=? "+
      "AND w.evidence_entity_id=? AND w.evidence_record_version=? "+
      "AND w.source_record_version=? AND w.target_record_version=? "+
      "AND w.quote=? AND w.state='confirmed' LIMIT 1",
      [req.sourceId,req.targetId,req.kind,req.evidenceId,req.evidenceVersion,
       req.sourceVersion,req.targetVersion,quote],
    );
    if(approved)throw new Error("relational_candidate_already_confirmed");
    const now=new Date().toISOString();
    const inserted=await tx.runAsync(
      "INSERT INTO memory_review_proposals "+
      "(id,target_kind,source_entity_id,target_entity_id,relation_kind,"+
      "source_record_version,target_record_version,evidence_entity_id,evidence_record_version,"+
      "quote,status,proposal_version,created_at,updated_at) "+
      "VALUES (?,'relation',?,?,?,?,?,?,?,?,'pending',1,?,?) "+
      "ON CONFLICT(source_entity_id,target_entity_id,relation_kind,evidence_entity_id,"+
      "evidence_record_version,quote) DO NOTHING",
      [id,req.sourceId,req.targetId,req.kind,req.sourceVersion,req.targetVersion,
       req.evidenceId,req.evidenceVersion,quote,now,now],
    );
    const row=await tx.getFirstAsync<{id:string;status:"pending"|"deferred"|"rejected"|"accepted"}>(
      "SELECT id,status FROM memory_review_proposals WHERE "+
      "source_entity_id=? AND target_entity_id=? AND relation_kind=? "+
      "AND evidence_entity_id=? AND evidence_record_version=? AND quote=?",
      [req.sourceId,req.targetId,req.kind,req.evidenceId,req.evidenceVersion,quote],
    );
    if(!row)throw new Error("relational_candidate_not_committed");
    result={proposalId:row.id,added:inserted.changes===1,status:row.status};
  });
  if(!result)throw new Error("relational_candidate_not_committed");
  return result;
}
export async function listRelationReviewCandidates(
  db:SQL,query:{collectionId:string;limit?:number;before?:RelationInboxCursor},
):Promise<RelationInboxPage>{
  if(!validId(query?.collectionId))throw new Error("relational_review_scope_invalid");
  const limit=query.limit??20;
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)
    throw new Error("relational_review_limit_invalid");
  const before=query.before;
  if(before&&(!validId(before.proposalId)||!Number.isFinite(Date.parse(before.createdAt))||
       new Date(before.createdAt).toISOString()!==before.createdAt))
    throw new Error("relational_review_cursor_invalid");
  let page:RelationInboxPage|null=null;
  await withUnlockedTransaction(db,async tx=>{
    const args:(string|number)[]=[query.collectionId];
    const cursor=before?
      " AND (p.created_at<? OR (p.created_at=? AND p.id<?))":"";
    if(before)args.push(before.createdAt,before.createdAt,before.proposalId);
    args.push(limit+1);
    const rows=await tx.getAllAsync<{
      id:string;created_at:string;status:"pending"|"deferred";proposal_version:number;
      source_entity_id:string;target_entity_id:string;relation_kind:DirectPersonRelation|"participant_of";
      source_record_version:number;target_record_version:number;
      evidence_entity_id:string;evidence_record_version:number;quote:string;
      source_title:string|null;target_title:string|null;evidence_title:string|null;
      evidence_json:string;
    }>(
      "SELECT p.id,p.created_at,p.status,p.proposal_version,p.source_entity_id,p.target_entity_id,"+
      "p.relation_kind,p.source_record_version,p.target_record_version,p.evidence_entity_id,"+
      "p.evidence_record_version,p.quote,src.title AS source_title,tgt.title AS target_title,"+
      "ev.title AS evidence_title,ev.payload_json AS evidence_json FROM memory_review_proposals p "+
      "JOIN memory_entities src ON src.id=p.source_entity_id AND "+
      "src.record_version=p.source_record_version AND src.record_status='active' "+
      "JOIN memory_entities tgt ON tgt.id=p.target_entity_id AND "+
      "tgt.record_version=p.target_record_version AND tgt.record_status='active' "+
      "JOIN memory_entities ev ON ev.id=p.evidence_entity_id AND "+
      "ev.record_version=p.evidence_record_version AND ev.record_status='active' "+
      "JOIN memory_collections cs ON cs.id=src.collection_id AND cs.sensitivity='standard' "+
      "JOIN memory_collections ct ON ct.id=tgt.collection_id AND ct.sensitivity='standard' "+
      "JOIN memory_collections ce ON ce.id=ev.collection_id AND ce.sensitivity='standard' "+
      "WHERE p.target_kind='relation' AND p.status IN ('pending','deferred') "+
      "AND ev.collection_id=? AND ev.domain='notes' "+
      "AND src.sensitivity IN ('standard','inherit') "+
      "AND tgt.sensitivity IN ('standard','inherit') "+
      "AND ev.sensitivity IN ('standard','inherit')"+cursor+
      " ORDER BY p.created_at DESC,p.id DESC LIMIT ?",args,
    );
    const shown=rows.slice(0,limit);
    const items:RelationReviewCandidate[]=[];
    for(const r of shown){
      // Exactly the originally quoted saved text, not a model paraphrase.
      if(!memoryText(JSON.parse(r.evidence_json)).includes(r.quote))
        throw new Error("relational_candidate_source_stale");
      items.push({targetKind:"relation",proposalId:r.id,status:r.status,
        proposalVersion:r.proposal_version,sourceId:r.source_entity_id,
        sourceVersion:r.source_record_version,targetId:r.target_entity_id,
        targetVersion:r.target_record_version,kind:r.relation_kind,
        evidenceId:r.evidence_entity_id,evidenceVersion:r.evidence_record_version,
        evidenceQuote:r.quote,sourceTitle:r.source_title,targetTitle:r.target_title,
        evidenceTitle:r.evidence_title,createdAt:r.created_at});
    }
    const last=shown.at(-1);
    page={items,nextCursor:rows.length>limit&&last?
      {createdAt:last.created_at,proposalId:last.id}:null};
  });
  if(!page)throw new Error("relational_review_not_committed");
  return page;
}
