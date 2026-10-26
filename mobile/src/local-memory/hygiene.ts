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
export class MemoryHygieneService {
  constructor(private readonly db: SQL) {}

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
      }>(
        `SELECT e.record_version,e.record_status,p.guard,p.skip_until
         FROM memory_entities e LEFT JOIN memory_cleanup_preferences p ON p.entity_id=e.id
         WHERE e.id=?`, [target.id],
      );
      const reasons: string[] = [];
      if (!row) reasons.push("missing");
      else {
        if (row.record_version !== target.recordVersion) reasons.push("stale_record_version");
        if (row.record_status !== "active") reasons.push("not_active");
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
