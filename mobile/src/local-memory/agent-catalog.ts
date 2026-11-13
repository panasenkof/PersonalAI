import * as Crypto from "expo-crypto";
import { noteTagsFromPayload } from "./note-tags";
/** Cloud-visible *metadata* catalogue. The native SQLCipher lease is owned by
 * the caller; standard active notes only. FTS query is an exact phrase, not
 * an unbounded semantic claim about every matching record. */
import type * as SQLite from "expo-sqlite";
import { ftsPhrase } from "./query";

export type AllowedListOptions = {
  collectionId?: string; query?: string; limit?: number;
  /** Explicit full subtree count, only with a selected collection. */
  includeDescendants?: boolean;
  beforeUpdatedAt?: string; beforeId?: string;
  /** Keyset for saved-time order. Must be supplied as a pair. */
  beforeCreatedAt?: string;
  /** Stage 9A: bounded OR of literal FTS phrases, not a second search index. */
  queryTerms?: string[];
  /** UTC instants calculated from the DEVICE-local requested calendar window. */
  savedFrom?: string; savedBefore?: string;
  /** Publication dates come only from source-claimed HTML meta, never saved_at. */
  publicationFrom?: string; publicationBefore?: string;
  /** Unknown publication date among otherwise matching authorized saved links. */
  unknownPublicationOnly?: boolean;
  /** Limit the article shortlist to notes with a saved source URL. */
  linkedOnly?: boolean;
  /** Article selection sorts by when it was saved, not when later edited. */
  sortBySaved?: boolean;
};
type Db = Pick<SQLite.SQLiteDatabase, "getAllAsync" | "getFirstAsync">;
type Row = { id: string; record_version: number; title: string | null;
  updated_at: string; created_at: string; collection_name: string; duplicate_count?: number; publication_day?: string | null };
type Filter = { where: string; params: (string | number)[] };
const MATCH_SQL = "EXISTS (SELECT 1 FROM memory_search_fts WHERE " +
  "memory_search_fts.entity_id=e.id AND memory_search_fts MATCH ?)";

function filters(options: AllowedListOptions, cursor: boolean): Filter {
  if (options.collectionId !== undefined &&
      (!/^[a-z0-9-]{1,128}$/i.test(options.collectionId))) throw new Error("invalid_catalog_collection");
  if (options.includeDescendants !== undefined && typeof options.includeDescendants !== "boolean")
    throw new Error("invalid_catalog_scope");
  if (options.includeDescendants && !options.collectionId)
    throw new Error("invalid_catalog_scope");
  const term = (options.query || "").trim();
  if (term.length > 200) throw new Error("invalid_catalog_query");
  const terms = options.queryTerms;
  if (terms !== undefined && (!Array.isArray(terms) || !terms.length || terms.length > 12 ||
      terms.some(t => typeof t !== "string" || t.trim().length < 2 || t.length > 100) || term))
    throw new Error("invalid_catalog_query_terms");
  const iso = (v: string | undefined) => v === undefined || (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)));
  if (!iso(options.savedFrom) || !iso(options.savedBefore) ||
      (options.savedFrom && options.savedBefore && options.savedFrom >= options.savedBefore))
    throw new Error("invalid_catalog_date_window");
  const dateOnly=(v:string|undefined) => v===undefined || (/^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v+"T00:00:00Z")) &&
    new Date(v+"T00:00:00Z").toISOString().startsWith(v));
  if(!dateOnly(options.publicationFrom) || !dateOnly(options.publicationBefore) ||
     (options.publicationFrom !== undefined) !== (options.publicationBefore !== undefined) ||
     (options.publicationFrom && options.publicationBefore && options.publicationFrom>=options.publicationBefore) ||
     ((options.publicationFrom || options.publicationBefore) && (options.savedFrom || options.savedBefore)) ||
     (options.unknownPublicationOnly && (!options.linkedOnly || options.publicationFrom || options.publicationBefore)))
    throw new Error("invalid_catalog_publication_window");
  const where = ["e.record_status='active'", "e.domain='notes'", "c.sensitivity='standard'",
    "e.sensitivity IN ('standard','inherit')"];
  const params: (string | number)[] = [];
  if (options.collectionId) {
    if (options.includeDescendants) {
      where.push("e.collection_id IN (WITH RECURSIVE section_ids(id) AS (" +
        "SELECT id FROM memory_collections WHERE id=? UNION " +
        "SELECT c.id FROM memory_collections c JOIN section_ids s ON c.parent_id=s.id" +
        ") SELECT id FROM section_ids)");
    } else {
      where.push("e.collection_id=?");
    }
    params.push(options.collectionId);
  }
  if (term) { where.push(MATCH_SQL); params.push(ftsPhrase(term)); }
  if (terms) {
    where.push(MATCH_SQL);
    params.push(terms.map(t => ftsPhrase(t.trim())).join(" OR "));
  }
  if (options.savedFrom) { where.push("e.created_at>=?"); params.push(options.savedFrom); }
  if (options.savedBefore) { where.push("e.created_at<?"); params.push(options.savedBefore); }
  // No fallback to e.created_at. This is only a source assertion stored by
  // confirmed HTML import, not independent verification of a publication day.
  const hasClaim="json_type(e.payload_json,'$.source_publication_date')='text' AND " +
    "json_extract(e.payload_json,'$.source_publication_evidence')='html_meta' AND " +
    "length(json_extract(e.payload_json,'$.source_publication_date'))=10 AND " +
    "json_extract(e.payload_json,'$.source_publication_attribute') IN ('article:published_time','datePublished')";
  if(options.publicationFrom && options.publicationBefore) {
    where.push(hasClaim);
    where.push("json_extract(e.payload_json,'$.source_publication_date')>=?");
    where.push("json_extract(e.payload_json,'$.source_publication_date')<?");
    params.push(options.publicationFrom,options.publicationBefore);
  }
  if(options.unknownPublicationOnly)where.push("COALESCE(("+hasClaim+"),0)=0");

  if (options.linkedOnly) {
    where.push("json_type(e.payload_json,'$.source_url')='text' AND " +
      "(json_extract(e.payload_json,'$.source_url') LIKE 'https://%' OR " +
      "json_extract(e.payload_json,'$.source_url') LIKE 'http://%')");
  }
  if (cursor && options.sortBySaved) {
    if (options.beforeUpdatedAt !== undefined) throw new Error("invalid_catalog_saved_cursor");
    if (options.beforeCreatedAt !== undefined || options.beforeId !== undefined) {
      if (!options.beforeCreatedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(options.beforeCreatedAt) ||
          !Number.isFinite(Date.parse(options.beforeCreatedAt)) || !options.beforeId ||
          !/^[a-zA-Z0-9:_-]{1,128}$/.test(options.beforeId))
        throw new Error("invalid_catalog_saved_cursor");
      where.push("(e.created_at < ? OR (e.created_at = ? AND e.id < ?))");
      params.push(options.beforeCreatedAt, options.beforeCreatedAt, options.beforeId);
    }
  }
  if (cursor && !options.sortBySaved && options.beforeCreatedAt !== undefined)
    throw new Error("invalid_catalog_cursor");
  if (cursor && !options.sortBySaved && (options.beforeUpdatedAt !== undefined || options.beforeId !== undefined)) {
    if (!options.beforeUpdatedAt || !/^\d{4}-\d{2}-\d{2}T/.test(options.beforeUpdatedAt) ||
        options.beforeUpdatedAt.length > 40 || !options.beforeId ||
        options.beforeId.length > 128) throw new Error("invalid_catalog_cursor");
    where.push("(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))");
    params.push(options.beforeUpdatedAt, options.beforeUpdatedAt, options.beforeId);
  }
  return { where: where.join(" AND "), params };
}
const FROM = "FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id";

/** This count is *exact FTS phrase* and only the permitted scope, never all
 * private or semantically related notes. User-facing metadata says so. */
export async function countAllowedNotes(db: Db, options: Omit<AllowedListOptions, "limit" | "beforeUpdatedAt" | "beforeCreatedAt" | "beforeId"> = {}) {
  const q = filters(options, false);
  if (options.collectionId) {
    // A nonexistent/private scope must not be reported as zero. This was the
    // DEF-4a ambiguity observed in the Android chat/UI comparison.
    const section = await db.getFirstAsync<{sensitivity:string}>(
      "SELECT sensitivity FROM memory_collections WHERE id=?", [options.collectionId]);
    if (!section || section.sensitivity !== "standard")
      throw new Error("catalog_scope_unavailable");
  }
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT count(*) AS n " + FROM + " WHERE " + q.where, q.params);
  if (!row || !Number.isSafeInteger(row.n) || row.n < 0) throw new Error("invalid_catalog_count");
  return {
    count: row.n, scope: "standard_active_notes",
    ...(options.collectionId ? {collectionScope: options.includeDescendants ? "subtree" : "direct", collectionId: options.collectionId} : {}),
    matchMode: options.queryTerms ? "one_of_fts_phrases" : options.query ? "exact_fts_phrase" : "all_allowed",
  };
}

export async function listAllowedNotes(db: Db, options: AllowedListOptions = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid_catalog_limit");
  const q = filters(options, true);
  // Read-only exact URL candidate count; never treat another note as mergeable or expose its metadata.
  const rows = await db.getAllAsync<Row>(
    "SELECT e.id,e.record_version,e.title,e.created_at,e.updated_at,c.name AS collection_name " +
    (options.publicationFrom ? ", json_extract(e.payload_json,'$.source_publication_date') AS publication_day " : "") +
    (options.linkedOnly ? `, (SELECT count(*) FROM memory_entities d
      JOIN memory_collections dc ON dc.id=d.collection_id
      WHERE d.id<>e.id AND d.record_status='active' AND d.domain='notes'
        AND dc.sensitivity='standard' AND d.sensitivity IN ('standard','inherit')
        AND json_type(d.payload_json,'$.source_url')='text'
        AND json_extract(d.payload_json,'$.source_url')=json_extract(e.payload_json,'$.source_url')
      ) AS duplicate_count ` : "") +
    FROM + " WHERE " + q.where +
    (options.sortBySaved ? " ORDER BY e.created_at DESC,e.id DESC LIMIT ?" : " ORDER BY e.updated_at DESC,e.id DESC LIMIT ?"),
    [...q.params, limit + 1],
  );
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    records: visible.map(row => ({ id: row.id, version: row.record_version,
      title: row.title || "", section: row.collection_name, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(options.linkedOnly ? {duplicateCount: row.duplicate_count ?? 0} : {}),
      ...(options.publicationFrom && typeof row.publication_day==="string" ? {publicationDay:row.publication_day} : {}) })),
    hasMore: rows.length > limit,
    ...(rows.length > limit && last ?
      { nextCursor: options.sortBySaved
        ? { beforeCreatedAt: last.created_at, beforeId: last.id }
        : { beforeUpdatedAt: last.updated_at, beforeId: last.id } } : {}),
    scope: "standard_active_notes",
    matchMode: options.queryTerms ? "one_of_fts_phrases" : options.query ? "exact_fts_phrase" : "all_allowed",
    // Never conflate a paged metadata list with a full content read.
    contentIncluded: false,
  };
}


/** S9-2a: a bounded read-only extension of the existing ACL-scoped catalogue.
 * No new index, plaintext cache, semantic matching or model-side write.
 * The UI/agent may only propose a merge after it sees fresh versioned handles;
 * the canonical changeNotes('merge') must validate everything again on click.
 */
export type DuplicateMatchKind = "same_url" | "same_text";
export type DuplicateCandidate = {
  id: string; version: number; title: string; section: string;
  collectionId: string; attachmentCount: number; tagCount: number;
};
export type DuplicateCandidateGroup = {
  fingerprint: string;
  /** A source-claimed URL for exact matches; never a copied note body. */
  sourceUrl?: string;
  totalCount: number;
  complete: boolean;
  records: DuplicateCandidate[];
};
export type DuplicateCandidatesPage = {
  scope: "standard_active_notes"; kind: DuplicateMatchKind;
  groups: DuplicateCandidateGroup[]; scanned: number;
  /** true means the results MUST NOT be described as exhaustive. */
  partial: boolean; hasMoreGroups: boolean; contentIncluded: false;
};
export const DUPLICATE_SCAN_LIMIT = 500;

/** All ancestors must be ordinary. Cycles and missing parents have no
 * rootward path and are therefore excluded, including a standard child
 * accidentally nested under a private section. */
const STANDARD_TREE_SQL = "e.collection_id IN (WITH RECURSIVE safe(id) AS (" +
  "SELECT id FROM memory_collections WHERE parent_id IS NULL AND sensitivity='standard' " +
  "UNION SELECT c.id FROM memory_collections c JOIN safe s ON c.parent_id=s.id " +
  "WHERE c.sensitivity='standard') SELECT id FROM safe)";
const SOURCE_URL_SQL = "CASE WHEN json_valid(e.payload_json) " +
  "THEN json_extract(e.payload_json,'$.source_url') ELSE NULL END";
const FINGERPRINT = (value: string) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);

/** Deterministic exact-text equivalence. Do not include title, tags, URL or
 * other metadata: their edits must not affect the content digest. */
export function normalizedDuplicateText(payload: Record<string,unknown>): string {
  const body = typeof payload.body === "string" ? payload.body : "";
  const extracted = typeof payload.extracted_text === "string" ? payload.extracted_text : "";
  return [body,extracted].filter(part=>part.trim()).join("\n")
    .normalize("NFC").replace(/\s+/gu," ").trim().toLocaleLowerCase("ru-RU");
}
type DuplicateSqlRow = {
  id: string; version: number; title: string | null;
  section: string; collection_id: string;
  attachment_count: number; payload_json: string;
};
function checkedDuplicateRow(row: DuplicateSqlRow): DuplicateCandidate | null {
  if(!row || typeof row.id!=="string" ||
     !/^[A-Za-z0-9:_-]{1,128}$/.test(row.id) ||
     !Number.isSafeInteger(row.version) || row.version<1 ||
     typeof row.section!=="string" || typeof row.collection_id!=="string" ||
     !Number.isSafeInteger(row.attachment_count) || row.attachment_count<0)
    return null;
  let payload:Record<string,unknown>;
  try {
    const parsed=JSON.parse(row.payload_json);
    if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))return null;
    payload=parsed;
  }catch{return null;}
  return {
    id:row.id,version:row.version,title:(row.title || "Без названия").slice(0,160),
    section:row.section.slice(0,80),collectionId:row.collection_id,
    attachmentCount:row.attachment_count,tagCount:noteTagsFromPayload(payload.tags).length,
  };
}
const DUPLICATE_ROW_SQL =
  "SELECT e.id,e.record_version AS version,e.title,c.name AS section,"+
  "e.collection_id,(SELECT COUNT(*) FROM memory_attachments a WHERE a.entity_id=e.id) "+
  "AS attachment_count,e.payload_json " + FROM;
const DUPLICATE_SCOPE = filters({},false).where + " AND " + STANDARD_TREE_SQL;

/** Returns only versioned permitted metadata. Same URL uses the already
 * indexed source_url in SQLCipher JSON; same text hashes on-device, never
 * sends note text to the model. A 500-note scan is explicitly partial. */
export async function findAllowedDuplicateCandidates(
  db:Db,kind:DuplicateMatchKind,limit=10,
):Promise<DuplicateCandidatesPage> {
  if((kind!=="same_url" && kind!=="same_text") ||
     !Number.isSafeInteger(limit) || limit<1 || limit>10)
    throw new Error("invalid_duplicate_candidate_query");
  if(kind==="same_url"){
    const urlWhere=" AND typeof("+SOURCE_URL_SQL+")='text' AND " +
      "length("+SOURCE_URL_SQL+") BETWEEN 8 AND 2048 AND ("+
      SOURCE_URL_SQL+" LIKE 'https://%' OR "+SOURCE_URL_SQL+" LIKE 'http://%')";
    const urlKeys=await db.getAllAsync<{
      match_value:string; match_count:number;
    }>("SELECT "+SOURCE_URL_SQL+" AS match_value,COUNT(*) AS match_count "+
      FROM+" WHERE "+DUPLICATE_SCOPE+urlWhere+
      " GROUP BY match_value HAVING COUNT(*)>=2 "+
      "ORDER BY MAX(e.updated_at) DESC,match_value ASC LIMIT ?",[limit+1]);
    const groups:DuplicateCandidateGroup[]=[];
    for(const key of urlKeys.slice(0,limit)){
      if(typeof key.match_value!=="string" ||
         !Number.isSafeInteger(key.match_count) || key.match_count<2)throw new Error("invalid_duplicate_catalog_result");
      const rows=await db.getAllAsync<DuplicateSqlRow>(
        DUPLICATE_ROW_SQL+" WHERE "+DUPLICATE_SCOPE+urlWhere+
        " AND "+SOURCE_URL_SQL+"=? "+
        "ORDER BY e.updated_at DESC,e.id DESC LIMIT 5",[key.match_value]);
      const records=rows.map(checkedDuplicateRow);
      if(records.some(r=>!r))throw new Error("invalid_duplicate_catalog_result");
      groups.push({
        fingerprint:await FINGERPRINT("url:"+key.match_value),
        sourceUrl:key.match_value,totalCount:key.match_count,
        complete:key.match_count<=5 && rows.length===key.match_count,
        records:records as DuplicateCandidate[],
      });
    }
    return {scope:"standard_active_notes",kind,groups,scanned:groups.reduce((n,g)=>n+g.records.length,0),
      partial:urlKeys.length>limit||groups.some(g=>!g.complete),
      hasMoreGroups:urlKeys.length>limit,contentIncluded:false};
  }
  const rows=await db.getAllAsync<DuplicateSqlRow>(
    DUPLICATE_ROW_SQL+" WHERE "+DUPLICATE_SCOPE+
    " ORDER BY e.updated_at DESC,e.id DESC LIMIT ?",[DUPLICATE_SCAN_LIMIT+1]);
  const found=new Map<string,DuplicateCandidate[]>();
  let skipped=0;
  const scan=rows.slice(0,DUPLICATE_SCAN_LIMIT);
  // Bound both SQLite materialization and bridge calls. Long notes are not
  // treated as equivalent solely because a digest was truncated.
  for(let offset=0;offset<scan.length;offset+=25){
    const batch=await Promise.all(scan.slice(offset,offset+25).map(async row=>{
      const metadata=checkedDuplicateRow(row);
      if(!metadata || typeof row.payload_json!=="string" || row.payload_json.length>65_536)
        return null;
      let normalized:string;
      try {normalized=normalizedDuplicateText(JSON.parse(row.payload_json));}
      catch {return null;}
      if(!normalized || normalized.length>60_000)return null;
      return {fingerprint:await FINGERPRINT("text:"+normalized),metadata};
    }));
    for(const item of batch){
      if(!item){skipped++;continue;}
      const list=found.get(item.fingerprint)||[];
      list.push(item.metadata);found.set(item.fingerprint,list);
    }
  }
  const candidates=[...found].filter(([,notes])=>notes.length>=2);
  const groups:DuplicateCandidateGroup[]=candidates.slice(0,limit).map(([fingerprint,notes])=>({
    fingerprint,totalCount:notes.length,
    complete:rows.length<=DUPLICATE_SCAN_LIMIT && notes.length<=5,
    records:notes.slice(0,5),
  }));
  return {scope:"standard_active_notes",kind,groups,scanned:scan.length,
    partial:rows.length>DUPLICATE_SCAN_LIMIT||skipped>0||
      candidates.length>limit||groups.some(g=>!g.complete),
    hasMoreGroups:candidates.length>limit,contentIncluded:false};
}
