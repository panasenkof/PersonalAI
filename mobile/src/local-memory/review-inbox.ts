/**
 * R2b0 / M2: one reusable SQLCipher inbox substrate.
 * Relation hypotheses live here, NOT in memory_relations and NOT as
 * confirmed evidence. Existing temporal proposals remain authoritative:
 * temporal items in this table will reference them, never copy a fact.
 */
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import { assertCurrentRelationCandidate, type ConfirmRelationInput } from "./relation-evidence";
import { memoryText } from "./search-index";

type SQL=Pick<SQLite.SQLiteDatabase,"getAllAsync"|"getFirstAsync"|"runAsync"|"execAsync">;
type RelationCandidate=Omit<ConfirmRelationInput,"userConfirmed">;
export type StageRelationReviewInput=RelationCandidate&{
  origin:"manual"|"model"|"rule"|"import";
};
export type RelationReviewInboxItem=RelationCandidate&{
  itemId:string;status:"pending"|"deferred";origin:StageRelationReviewInput["origin"];
  proposalVersion:number;createdAt:string;
};
export type RelationReviewInboxQuery={
  collectionId:string;limit?:number;
  before?:{createdAt:string;itemId:string};
};
type Row={
  id:string;origin:StageRelationReviewInput["origin"];
  status:"pending"|"deferred";proposal_version:number;created_at:string;
  source_entity_id:string;target_entity_id:string;relation_kind:RelationCandidate["kind"];
  evidence_entity_id:string;source_record_version:number;target_record_version:number;
  evidence_record_version:number;quote:string;payload_json:string;
};
const validId=(x:unknown):x is string=>
  typeof x==="string"&&x.trim().length>0&&x.length<=256&&!/[\u0000-\u001f]/.test(x);
const stamp=(x:unknown):x is string=>
  typeof x==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;

/** Idempotent staging, even when a candidate was dismissed or deferred.
 * New source revision/actual evidence is a new candidate; reindexing the
 * same input never reopens a dismissed hypothesis.
 */
export async function stageRelationReviewItem(
  db:SQL,input:StageRelationReviewInput,
):Promise<{itemId:string;created:boolean;status:string}>{
  if(!["manual","model","rule","import"].includes(input?.origin))
    throw new Error("review_origin_invalid");
  let result:{itemId:string;created:boolean;status:string}|null=null;
  await withUnlockedTransaction(db,async tx=>{
    await assertCurrentRelationCandidate(tx,input);
    const quote=input.evidenceQuote.trim();
    const key:[string,string,string,string,number,number,number,string]=[
      input.sourceId,input.targetId,input.kind,input.evidenceId,
      input.sourceVersion,input.targetVersion,input.evidenceVersion,quote,
    ];
    const existing=await tx.getFirstAsync<{id:string;status:string}>(
      "SELECT id,status FROM memory_review_items WHERE target_kind='relation' "+
      "AND source_entity_id=? AND target_entity_id=? AND relation_kind=? AND evidence_entity_id=? "+
      "AND source_record_version=? AND target_record_version=? AND evidence_record_version=? AND quote=?",
      key,
    );
    if(existing){result={itemId:existing.id,created:false,status:existing.status};return;}
    const id=Crypto.randomUUID(),now=new Date().toISOString();
    await tx.runAsync(
      "INSERT INTO memory_review_items "+
      "(id,target_kind,source_entity_id,target_entity_id,relation_kind,evidence_entity_id,"+
      "source_record_version,target_record_version,evidence_record_version,quote,origin,status,"+
      "proposal_version,created_at,updated_at) "+
      "VALUES (?,'relation',?,?,?,?,?,?,?,?,?,'pending',1,?,?)",
      [id,input.sourceId,input.targetId,input.kind,input.evidenceId,
       input.sourceVersion,input.targetVersion,input.evidenceVersion,quote,input.origin,now,now],
    );
    result={itemId:id,created:true,status:"pending"};
  });
  if(!result)throw new Error("review_stage_not_committed");
  return result;
}

/** Read a scoped inbox via a bounded database query; no hidden items, no
 * model-proposed relation graph mutation, no guessed identities.
 */
export async function listRelationReviewItems(
  db:SQL,query:RelationReviewInboxQuery,
):Promise<{items:RelationReviewInboxItem[];nextCursor:RelationReviewInboxQuery["before"]|null}>{
  if(!validId(query?.collectionId))throw new Error("review_scope_invalid");
  const limit=query.limit??20;
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new Error("review_limit_invalid");
  if(query.before&&(!validId(query.before.itemId)||!stamp(query.before.createdAt)))
    throw new Error("review_cursor_invalid");
  const cursor=query.before?
    " AND (p.created_at<? OR (p.created_at=? AND p.id<?))":"";
  const params:(string|number)[]=[query.collectionId];
  if(query.before)params.push(query.before.createdAt,query.before.createdAt,query.before.itemId);
  params.push(limit+1);
  const rows=await db.getAllAsync<Row>(
    "SELECT p.id,p.origin,p.status,p.proposal_version,p.created_at,p.source_entity_id,"+
    "p.target_entity_id,p.relation_kind,p.evidence_entity_id,p.source_record_version,"+
    "p.target_record_version,p.evidence_record_version,p.quote,ev.payload_json "+
    "FROM memory_review_items p "+
    "JOIN memory_entities src ON src.id=p.source_entity_id AND src.record_version=p.source_record_version "+
    "JOIN memory_entities tgt ON tgt.id=p.target_entity_id AND tgt.record_version=p.target_record_version "+
    "JOIN memory_entities ev ON ev.id=p.evidence_entity_id AND ev.record_version=p.evidence_record_version "+
    "JOIN memory_collections sc ON sc.id=src.collection_id "+
    "JOIN memory_collections tc ON tc.id=tgt.collection_id "+
    "JOIN memory_collections ec ON ec.id=ev.collection_id "+
    "WHERE p.target_kind='relation' AND p.status IN ('pending','deferred') "+
    "AND ev.collection_id=? AND ev.domain='notes' "+
    "AND src.record_status='active' AND tgt.record_status='active' AND ev.record_status='active' "+
    "AND sc.sensitivity='standard' AND tc.sensitivity='standard' AND ec.sensitivity='standard' "+
    "AND src.sensitivity IN ('inherit','standard') AND tgt.sensitivity IN ('inherit','standard') "+
    "AND ev.sensitivity IN ('inherit','standard')"+cursor+
    " ORDER BY p.created_at DESC,p.id DESC LIMIT ?",params,
  );
  const visible=rows.slice(0,limit);
  // An edited source would already fail record-version, but a damaged
  // evidence anchor must not be converted into an actionable card.
  const items:RelationReviewInboxItem[]=[];
  for(const row of visible){
    if(!memoryText(JSON.parse(row.payload_json)).includes(row.quote))continue;
    items.push({
      itemId:row.id,status:row.status,origin:row.origin,proposalVersion:row.proposal_version,
      createdAt:row.created_at,sourceId:row.source_entity_id,targetId:row.target_entity_id,
      kind:row.relation_kind,evidenceId:row.evidence_entity_id,
      sourceVersion:row.source_record_version,targetVersion:row.target_record_version,
      evidenceVersion:row.evidence_record_version,evidenceQuote:row.quote,
    });
  }
  const last=visible.at(-1);
  return {items,nextCursor:rows.length>limit&&last?
    {createdAt:last.created_at,itemId:last.id}:null};
}
