/**
 * №79а — first safe foundation for intelligent memory hygiene.
 *
 * Metadata and dry-run only: NEVER deletes, archives, trashes, indexes or
 * sends anything to a model. A future apply step must revalidate every
 * record/policy/dependency inside its own write transaction.
 */
import type * as SQLite from "expo-sqlite";
import { localMemorySessionUnlocked } from "./storage";
import { withUnlockedTransaction } from "./transaction";
import { MemoryAccessError, MemoryConflictError } from "./types";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
export type MemoryReviewGuard = "normal" | "pinned" | "never_suggest";
export type MemoryReviewAction = "archive" | "trash";
export type MemoryReviewTarget = { id: string; recordVersion: number };
export type MemoryReviewPreference = {
  entityId: string;
  guard: MemoryReviewGuard;
  skipUntil: string | null;
  preferenceVersion: number;
};
export type MemoryReviewImpact = {
  id: string;
  action: MemoryReviewAction;
  expectedRecordVersion: number;
  /** CAS snapshot for the SAME canonical note-action transaction. */
  expectedPreferenceVersion: number;
  currentRecordVersion: number | null;
  recordStatus: string | null;
  eligible: boolean;
  reasons: string[];
  dependencies: {
    attachments: number; attachmentBytes: number; observations: number;
    inboundRelations: number; outboundRelations: number;
    revisions: number; receivedShares: number; searchChunks: number;
  };
  /** Deleting the note could affect connections not represented in v6. */
  unverifiedDependencies: string[];
  immediateReclaimableBytes: 0;
  canPurgeOriginals: false;
};

/** Preview-only user selection. Never a background cleanup action or purge. */
export type MemoryReviewBatchPreview={
  action:MemoryReviewAction;
  selectedCount:number;
  excludedIds:string[];
  included:MemoryReviewImpact[];
  /** Only currently eligible source versions; caller MUST redo CAS before apply. */
  eligibleIds:string[];
  blockedIds:string[];
  /** Estimated attached original bytes AFFECTED, not reclaimable disk bytes. */
  originalBytesAtRisk:number;
  /** This method cannot authorize permanent deletion. */
  canPurgeOriginals:false;
};

const EMPTY_DEPENDENCIES = {
  attachments: 0, attachmentBytes: 0, observations: 0,
  inboundRelations: 0, outboundRelations: 0, revisions: 0,
  receivedShares: 0, searchChunks: 0,
};
const UNVERIFIED = [
  "cross_conversation_references", "future_claim_evidence", "exported_backups",
] as const;

function ensureUnlocked(): void {
  if (!localMemorySessionUnlocked()) throw new MemoryAccessError("application_locked");
}
function validDate(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error("invalid_review_skip_until");
  return new Date(value).toISOString();
}
function preferenceFrom(row: {
  entity_id: string; guard: MemoryReviewGuard; skip_until: string | null; version: number;
} | null, entityId: string): MemoryReviewPreference {
  return {
    entityId, guard: row?.guard ?? "normal", skipUntil: row?.skip_until ?? null,
    preferenceVersion: row?.version ?? 0,
  };
}

/** Use one already-unlocked SQLCipher connection. No new native handle. */
export type MemoryHygieneSuggestedGroup={
  reason:"same_saved_url"|"marked_read_later";
  title:string;
  /** Exact IDs and record versions; never a decision or authorization to apply. */
  targets:MemoryReviewTarget[];
  /** A reviewed action is still required; no automatic purge or source merge. */
  proposedAction:"archive";
};
export type MemoryHygieneSuggestions={
  groups:MemoryHygieneSuggestedGroup[];
  scanned:number;
  /** A later page may contain further matches; a missing group != no matches. */
  partial:boolean;
};

/** Bounded read-only discovery of two *explicit* metadata patterns.
 * This is NOT a semantic duplicate recognizer: sharing a URL doesn't make
 * note annotations equal, and read-later doesn't mean that a video is useless.
 */
export async function discoverHygieneGroups(
  db: SQL, limit=100,
):Promise<MemoryHygieneSuggestions>{
  ensureUnlocked();
  if(!Number.isSafeInteger(limit)||limit<2||limit>100)
    throw new Error("invalid_hygiene_discovery_limit");
  const rows=await db.getAllAsync<{
    id:string; record_version:number; payload_json:string;
  }>(`SELECT e.id,e.record_version,e.payload_json FROM memory_entities e
      JOIN memory_collections c ON c.id=e.collection_id
      WHERE e.record_status='active' AND c.sensitivity='standard'
        AND e.sensitivity IN ('standard','inherit')
      ORDER BY e.updated_at DESC,e.id DESC LIMIT ?`,[limit+1]);
  ensureUnlocked();
  // No FTS, model inference or global JSON indexing. This small bounded
  // scan only recognizes exact URL strings and explicit read-later metadata.
  const all=rows.slice(0,limit);
  const urlBuckets=new Map<string,MemoryReviewTarget[]>();
  const readLater:MemoryReviewTarget[]=[];
  for(const item of all){
    let payload:unknown;
    try{payload=JSON.parse(item.payload_json);}catch{continue;}
    if(!payload||typeof payload!=="object"||Array.isArray(payload))continue;
    const data=payload as Record<string,unknown>;
    const target={id:item.id,recordVersion:item.record_version};
    if(data.read_later===true)readLater.push(target);
    const raw=data.source_url;
    if(typeof raw!=="string"||raw.length<8||raw.length>2048||
       !/^https:\/\/[^\s]+$/i.test(raw))continue;
    // Exact-match only. Never strip URL query/fragment or pretend canonical
    // identity across variants/redirects; keep original provenance separate.
    const group=urlBuckets.get(raw)||[];
    group.push(target);urlBuckets.set(raw,group);
  }
  const groups:MemoryHygieneSuggestedGroup[]=[];
  for(const targets of urlBuckets.values()){
    if(targets.length<2)continue;
    groups.push({reason:"same_saved_url",title:"Одна сохранённая ссылка — разные записи",
      targets,proposedAction:"archive"});
  }
  if(readLater.length>=2)groups.push({
    reason:"marked_read_later",title:"Отмечено «Посмотреть/прочитать позже»",
    targets:readLater,proposedAction:"archive",
  });
  ensureUnlocked();
  return {groups:groups.slice(0,20),scanned:all.length,
    partial:rows.length>limit||groups.length>20};
}

export class MemoryHygieneService {
  constructor(private readonly db: SQL) {}

  /** Existing review service is the only place for bounded group suggestions. */
  discoverGroups(limit?:number){return discoverHygieneGroups(this.db,limit); }

  async preference(entityId: string): Promise<MemoryReviewPreference> {
    ensureUnlocked();
    const record = await this.db.getFirstAsync<{ id: string }>(
      "SELECT id FROM memory_entities WHERE id=?", [entityId],
    );
    if (!record) throw new MemoryAccessError("entity_not_found");
    const row = await this.db.getFirstAsync<{
      entity_id: string; guard: MemoryReviewGuard; skip_until: string | null; version: number;
    }>("SELECT entity_id,guard,skip_until,version FROM memory_cleanup_preferences WHERE entity_id=?", [entityId]);
    ensureUnlocked();
    return preferenceFrom(row, entityId);
  }

  /** CAS on *both* the source record and its hygiene rule, including first insert. */
  async setPreference(
    target: MemoryReviewTarget, expectedPreferenceVersion: number,
    guard: MemoryReviewGuard, skipUntil: string | null,
  ): Promise<MemoryReviewPreference> {
    ensureUnlocked();
    if (!["normal", "pinned", "never_suggest"].includes(guard)) throw new Error("invalid_review_guard");
    if (!Number.isSafeInteger(target.recordVersion) || target.recordVersion < 1 ||
        !Number.isSafeInteger(expectedPreferenceVersion) || expectedPreferenceVersion < 0) {
      throw new Error("invalid_review_version");
    }
    const checkedDate = validDate(skipUntil);
    let result: MemoryReviewPreference | null = null;
    await withUnlockedTransaction(this.db, async tx => {
      ensureUnlocked();
      const entity = await tx.getFirstAsync<{ record_version: number }>(
        "SELECT record_version FROM memory_entities WHERE id=?", [target.id],
      );
      if (!entity) throw new MemoryAccessError("entity_not_found");
      if (entity.record_version !== target.recordVersion) throw new MemoryConflictError("stale_memory_version");
      const previous = await tx.getFirstAsync<{ version: number }>(
        "SELECT version FROM memory_cleanup_preferences WHERE entity_id=?", [target.id],
      );
      if ((previous?.version ?? 0) !== expectedPreferenceVersion) {
        throw new MemoryConflictError("stale_review_preference");
      }
      const version = expectedPreferenceVersion + 1;
      const timestamp = new Date().toISOString();
      if (previous) {
        const updated = await tx.runAsync(
          `UPDATE memory_cleanup_preferences SET guard=?,skip_until=?,updated_at=?,version=?
           WHERE entity_id=? AND version=?`,
          [guard, checkedDate, timestamp, version, target.id, expectedPreferenceVersion],
        );
        if (updated.changes !== 1) throw new MemoryConflictError("stale_review_preference");
      } else {
        await tx.runAsync(
          `INSERT INTO memory_cleanup_preferences(entity_id,guard,skip_until,version,updated_at)
           VALUES (?,?,?,?,?)`,
          [target.id, guard, checkedDate, version, timestamp],
        );
      }
      ensureUnlocked();
      result = { entityId: target.id, guard, skipUntil: checkedDate, preferenceVersion: version };
    });
    if (!result) throw new Error("review_preference_not_committed");
    return result;
  }

  /**
   * CLEAN-07: one bounded preview with explicit per-item exclusions.
   * Reuses the one dryRun eligibility/impact reader, and does NOT introduce
   * another decision path, deletion engine or durable proposal table.
   * C1 is not an apply permission: record versions must be rechecked there.
   */
  async previewWithExclusions(
    targets: MemoryReviewTarget[], excludedIds:string[], action:MemoryReviewAction,
  ):Promise<MemoryReviewBatchPreview>{
    ensureUnlocked();
    if(!Array.isArray(targets)||!Array.isArray(excludedIds)||
       targets.length<1||targets.length>100||
       targets.some(t=>!t||typeof t.id!=="string"||!t.id.trim()||
         !Number.isSafeInteger(t.recordVersion)||t.recordVersion<1)||
       new Set(targets.map(t=>t.id)).size!==targets.length||
       excludedIds.some(id=>typeof id!=="string"||!id.trim())||
       new Set(excludedIds).size!==excludedIds.length)
      throw new Error("invalid_review_selection");
    if(action!=="archive"&&action!=="trash")throw new Error("invalid_review_action");
    const all=new Set(targets.map(x=>x.id));
    if(excludedIds.some(id=>!all.has(id)))throw new Error("invalid_review_exclusion");
    const excluded=new Set(excludedIds);
    const chosen=targets.filter(t=>!excluded.has(t.id));
    // All excluded is a legitimate preview: no reads/writes and no proposal.
    const included=chosen.length?await this.dryRun(chosen,action):[];
    ensureUnlocked();
    return {
      action,selectedCount:targets.length,
      excludedIds:targets.filter(t=>excluded.has(t.id)).map(t=>t.id),
      included,eligibleIds:included.filter(x=>x.eligible).map(x=>x.id),
      blockedIds:included.filter(x=>!x.eligible).map(x=>x.id),
      originalBytesAtRisk:included.reduce((n,x)=>n+x.dependencies.attachmentBytes,0),
      canPurgeOriginals:false,
    };
  }

  /** Bounded, read-only impact. Never used as permission to hard-delete. */
  async dryRun(
    targets: MemoryReviewTarget[], action: MemoryReviewAction,
  ): Promise<MemoryReviewImpact[]> {
    ensureUnlocked();
    if (action !== "archive" && action !== "trash") throw new Error("invalid_review_action");
    if (targets.length < 1 || targets.length > 100 ||
        targets.some(t => !t.id || !Number.isSafeInteger(t.recordVersion) || t.recordVersion < 1) ||
        new Set(targets.map(t => t.id)).size !== targets.length) {
      throw new Error("invalid_review_selection");
    }
    const results: MemoryReviewImpact[] = [];
    for (const target of targets) {
      ensureUnlocked();
      const row = await this.db.getFirstAsync<{
        record_version: number; record_status: string; guard: MemoryReviewGuard | null; skip_until: string | null;
        preference_version: number | null; record_sensitivity: string; collection_sensitivity: string;
      }>(
        `SELECT e.record_version,e.record_status,p.guard,p.skip_until,p.version AS preference_version,
                e.sensitivity AS record_sensitivity,c.sensitivity AS collection_sensitivity
         FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
         LEFT JOIN memory_cleanup_preferences p ON p.entity_id=e.id WHERE e.id=?`, [target.id],
      );
      const reasons: string[] = [];
      if (!row) reasons.push("missing");
      else {
        if (row.record_version !== target.recordVersion) reasons.push("stale_record_version");
        if (row.record_status !== "active") reasons.push("not_active");
        if (row.collection_sensitivity !== "standard" || !["standard","inherit"].includes(row.record_sensitivity)) reasons.push("private_or_unclassified");
        if (row.guard === "pinned" || row.guard === "never_suggest") reasons.push(row.guard);
        if (row.skip_until && Date.parse(row.skip_until) > Date.now()) reasons.push("deferred");
      }
      const dep = { ...EMPTY_DEPENDENCIES };
      if (row) {
        const counts = await this.db.getFirstAsync<{
          attachments: number; attachment_bytes: number; observations: number;
          inbound_relations: number; outbound_relations: number;
          revisions: number; received_shares: number; search_chunks: number;
        }>(`SELECT
           (SELECT count(*) FROM memory_attachments WHERE entity_id=?) AS attachments,
           (SELECT coalesce(sum(size),0) FROM memory_attachments WHERE entity_id=?) AS attachment_bytes,
           (SELECT count(*) FROM memory_observations WHERE entity_id=?) AS observations,
           (SELECT count(*) FROM memory_relations WHERE target_entity_id=?) AS inbound_relations,
           (SELECT count(*) FROM memory_relations WHERE source_entity_id=?) AS outbound_relations,
           (SELECT count(*) FROM memory_revisions WHERE entity_id=?) AS revisions,
           (SELECT count(*) FROM memory_received_shares WHERE entity_id=?) AS received_shares,
           (SELECT count(*) FROM memory_chunks WHERE entity_id=?) AS search_chunks`,
        Array(8).fill(target.id));
        if (counts) Object.assign(dep, {
          attachments: counts.attachments, attachmentBytes: counts.attachment_bytes,
          observations: counts.observations, inboundRelations: counts.inbound_relations,
          outboundRelations: counts.outbound_relations, revisions: counts.revisions,
          receivedShares: counts.received_shares, searchChunks: counts.search_chunks,
        });
      }
      results.push({
        id: target.id, action, expectedRecordVersion: target.recordVersion,
        expectedPreferenceVersion: row?.preference_version ?? 0,
        currentRecordVersion: row?.record_version ?? null,
        recordStatus: row?.record_status ?? null, eligible: reasons.length === 0, reasons,
        dependencies: dep, unverifiedDependencies: [...UNVERIFIED],
        immediateReclaimableBytes: 0, canPurgeOriginals: false,
      });
    }
    ensureUnlocked();
    return results;
  }
}
