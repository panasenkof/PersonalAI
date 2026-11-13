/** S9-2a: read-only, on-device exact duplicate candidates.
 * Reuses the same SQLCipher lease and standard-active notes scope as
 * agent-catalog. Never returns bodies, URLs, hashes, private notes or a
 * capability to merge. Candidate handles are NOT write authorizations.
 */
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";
import { STANDARD_ACTIVE_NOTES_SCOPE } from "./agent-catalog";
import { noteTagsFromPayload } from "./note-tags";
import { localMemorySessionUnlocked } from "./storage";

type DB=Pick<SQLite.SQLiteDatabase,"getAllAsync">;
export type DuplicateKind="same_url"|"same_text";
export type DuplicateCandidate={
  noteId:string;expectedVersion:number;title:string;section:string;
  attachmentCount:number;tagCount:number;
};
export type DuplicateCandidateGroup={
  notes:DuplicateCandidate[];
  /** 2–5 displayed records; counts over five are not hidden from the user. */
  totalMatches:number;
};
export type DuplicateCandidateResult={
  kind:DuplicateKind;groups:DuplicateCandidateGroup[];
  scope:"standard_active_notes";contentIncluded:false;
  scanned:number;scanTruncated:boolean;moreGroups:boolean;
};

type Section={id:string;parent_id:string|null;sensitivity:string};
type Row={id:string;record_version:number;title:string|null;collection_id:string;
  collection_name:string;payload_json:string;attachment_count:number};
const PAGE=200;
/** Deliberate work-budget, not a claim that the entire memory was searched.
 * If reached, return scanTruncated=true; never present partial as exhaustive. */
const MAX_SCAN=10000;
const MAX_GROUP_SIZE=5;
const ALLOWED_URL=/^https?:\/\/\S+$/i;

function allowedPath(id:string,sections:Map<string,Section>):boolean {
  const seen=new Set<string>();
  let current=sections.get(id);
  if(!current)return false;
  while(current){
    if(current.sensitivity!=="standard"||seen.has(current.id))return false;
    seen.add(current.id);
    if(current.parent_id&&!sections.has(current.parent_id))return false;
    current=current.parent_id?sections.get(current.parent_id):undefined;
  }
  return true;
}

/** Match whitespace and letter case only, not semantics, punctuation or URLs. */
export function normalizeDuplicateText(body:string):string {
  return body.normalize("NFC").replace(/\s+/gu," ").trim().toLocaleLowerCase("ru-RU");
}

export async function findDuplicateCandidates(
  db:DB,kind:DuplicateKind,limit:number,signal?:AbortSignal,
):Promise<DuplicateCandidateResult>{
  if(kind!=="same_url"&&kind!=="same_text")throw new Error("invalid_duplicate_kind");
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)
    throw new Error("invalid_duplicate_limit");
  const guard=()=>{
    if(signal?.aborted||!localMemorySessionUnlocked())
      throw new Error("application_locked");
  };
  guard();
  const sections=new Map((await db.getAllAsync<Section>(
    "SELECT id,parent_id,sensitivity FROM memory_collections")).map(s=>[s.id,s]));
  guard();
  const buckets=new Map<string,{totalMatches:number;notes:DuplicateCandidate[]}>();
  let scanned=0;
  let cursor="";
  let scanTruncated=false;
  while(true){
    guard();
    const rows=await db.getAllAsync<Row>(
      `SELECT e.id,e.record_version,e.title,e.collection_id,
       c.name AS collection_name,e.payload_json,
       (SELECT count(*) FROM memory_attachments a WHERE a.entity_id=e.id) AS attachment_count
       FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       WHERE ${STANDARD_ACTIVE_NOTES_SCOPE} AND e.id>?
       ${kind==="same_url" ? "AND json_type(e.payload_json,'$.source_url')='text' AND (json_extract(e.payload_json,'$.source_url') LIKE 'https://%' OR json_extract(e.payload_json,'$.source_url') LIKE 'http://%')" : ""}
       ORDER BY e.id LIMIT ?`,
      [cursor,Math.min(PAGE,MAX_SCAN-scanned)+1],
    );
    guard();
    if(!rows.length)break;
    const remaining=MAX_SCAN-scanned;
    const batch=rows.slice(0,remaining);
    for(const row of batch){
      guard();
      cursor=row.id;
      scanned++;
      if(!Number.isSafeInteger(row.record_version)||row.record_version<1||
         !allowedPath(row.collection_id,sections))continue;
      let payload:Record<string,unknown>;
      try {
        const parsed=JSON.parse(row.payload_json);
        if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))continue;
        payload=parsed;
      } catch {continue;}
      let key:string;
      if(kind==="same_url"){
        const url=payload.source_url;
        if(typeof url!=="string"||!ALLOWED_URL.test(url))continue;
        key=url; // exact URL equality, no URL rewriting or fuzzy matching
      }else{
        const raw=[payload.body,payload.extracted_text]
          .filter((v):v is string=>typeof v==="string"&&Boolean(v.trim()))
          .join("\n\n");
        const normalized=normalizeDuplicateText(raw);
        if(!normalized)continue;
        key=await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,normalized);
        guard();
      }
      const candidate:DuplicateCandidate={
        noteId:row.id,expectedVersion:row.record_version,
        title:(row.title||"Без названия").slice(0,160),
        section:row.collection_name.slice(0,100),
        attachmentCount:Math.max(0,Number(row.attachment_count)||0),
        tagCount:noteTagsFromPayload(payload.tags).length,
      };
      const bucket=buckets.get(key)||{totalMatches:0,notes:[]};
      bucket.totalMatches++;
      if(bucket.notes.length<MAX_GROUP_SIZE)bucket.notes.push(candidate);
      buckets.set(key,bucket);
    }
    if(rows.length>remaining){scanTruncated=true;break;}
    if(rows.length<=PAGE)break;
  }
  guard();
  const matching=[...buckets.values()].filter(group=>group.totalMatches>=2);
  matching.sort((a,b)=>b.totalMatches-a.totalMatches||
    a.notes[0].noteId.localeCompare(b.notes[0].noteId));
  return {
    kind,groups:matching.slice(0,limit).map(group=>({
      notes:group.notes,totalMatches:group.totalMatches,
    })),
    scope:"standard_active_notes",contentIncluded:false,
    scanned,scanTruncated,moreGroups:matching.length>limit,
  };
}
