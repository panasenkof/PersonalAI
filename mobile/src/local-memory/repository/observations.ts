/** ARCH-6c: canonical observation and basic relation operations.
 * Entity existence checks delegate back to the original repository facade:
 * no alternate reader, writer, queue or SQLCipher connection.
 */
import { indexEntity } from "../search-index";
import { CURRENT_MODEL_TERMS } from "../enrichment-policy";
import { withUnlockedTransaction } from "../transaction";
import type { EntityRecord, ObservationRecord, NewObservation, RelationRecord, RecordSensitivity } from "../types";
import { MemoryAccessError, MemoryConflictError } from "../types";
import { now, uid, TEXT, type SQL, type Row } from "./shared";
import { clone, safeReason, kindAllowed, validPayload } from "./record-core";

type EntityLookup = (id: string) => Promise<EntityRecord | null>;
const obsFrom = (row: Row): ObservationRecord => ({
  id: String(row.id), entity_id: String(row.entity_id), kind: String(row.kind),
  payload: JSON.parse(String(row.payload_json)), occurred_at: String(row.occurred_at),
  created_at: String(row.created_at), sensitivity: row.sensitivity as RecordSensitivity,
  valid_from: TEXT(row.valid_from), valid_until: TEXT(row.valid_until),
  source_kind: TEXT(row.source_kind), source_ref: TEXT(row.source_ref),
  confidence: row.confidence === null ? null : Number(row.confidence),
  record_version: Number(row.record_version),
});

export async function observation(db: SQL, id: string): Promise<ObservationRecord | null> {
    const row = await db.getFirstAsync<Row>("SELECT * FROM memory_observations WHERE id=?", [id]);
    return row ? obsFrom(row) : null;
  }

export async function observations(db: SQL, entityId: string, lookupEntity: EntityLookup): Promise<ObservationRecord[]> {
    const owner = await lookupEntity(entityId);
    if (!owner) return [];
    const rows = await db.getAllAsync<Row>(
      "SELECT * FROM memory_observations WHERE entity_id=? ORDER BY occurred_at DESC, id",
      [entityId],
    );
    return rows.map(obsFrom);
  }

export async function createObservation(db: SQL, item: NewObservation, lookupEntity: EntityLookup): Promise<ObservationRecord> {
    if (!await lookupEntity(item.entity_id)) throw new MemoryAccessError("entity_not_found");
    if (!Number.isFinite(Date.parse(item.occurred_at))) throw new Error("invalid_occurred_at");
    const id = uid(), timestamp = now();
    const record: ObservationRecord = {
      id, entity_id: item.entity_id, kind: item.kind,
      payload: clone(item.payload), occurred_at: item.occurred_at, created_at: timestamp,
      sensitivity: item.sensitivity ?? "inherit",
      valid_from: null, valid_until: null, source_kind: item.source_kind ?? null,
      source_ref: item.source_ref ?? null, confidence: null, record_version: 1,
    };
    await withUnlockedTransaction(db, async tx => {
      await tx.runAsync(
        `INSERT INTO memory_observations(
        id,entity_id,kind,payload_json,occurred_at,created_at,sensitivity,valid_from,valid_until,
        source_kind,source_ref,confidence,record_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, item.entity_id, item.kind, validPayload(record.payload), item.occurred_at, timestamp,
          record.sensitivity, null, null, record.source_kind, record.source_ref, null, 1],
      );
      if(record.sensitivity==="inherit" || record.sensitivity==="standard")
        await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source='model:auto'",[item.entity_id]);
      await indexEntity(tx, item.entity_id, timestamp);
    });
    return record;
  }

export async function reviseObservation(db: SQL, id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<ObservationRecord> {
    safeReason(reason);
    if (expectedVersion < 1) throw new Error("invalid_expected_version");
    const data = validPayload(payload);
    let updated: ObservationRecord | null = null;
    await withUnlockedTransaction(db, async tx => {
      const row = await tx.getFirstAsync<Row>("SELECT * FROM memory_observations WHERE id=?", [id]);
      if (!row) throw new MemoryAccessError("observation_not_found");
      const before = obsFrom(row);
      if (before.record_version !== expectedVersion) throw new MemoryConflictError("stale_memory_version");
      const result = await tx.runAsync(
        "UPDATE memory_observations SET payload_json=?, record_version=record_version+1 WHERE id=? AND record_version=?",
        [data, id, expectedVersion],
      );
      if (result.changes !== 1) throw new MemoryConflictError("stale_memory_version");
      const after = { ...before, payload: clone(payload), record_version: expectedVersion + 1 };
      await tx.runAsync(
        `INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,
          reason,actor_kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), "observation", null, id, after.record_version, reason.trim(), "user",
          JSON.stringify(before), JSON.stringify(after), now()],
      );
      if(before.sensitivity==="inherit" || before.sensitivity==="standard")
        await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source='model:auto'",[before.entity_id]);
      await indexEntity(tx, before.entity_id);
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }


export async function linkEntities(db: SQL, sourceId: string, targetId: string, kind: string, lookupEntity: EntityLookup): Promise<RelationRecord> {
    if (sourceId === targetId) throw new Error("self_relation_not_allowed");
    kindAllowed(kind);
    if (!(await lookupEntity(sourceId)) || !(await lookupEntity(targetId))) {
      throw new MemoryAccessError("entity_not_found");
    }
    const existing = await db.getFirstAsync<Row>(
      "SELECT id FROM memory_relations WHERE source_entity_id=? AND target_entity_id=? AND kind=?",
      [sourceId, targetId, kind],
    );
    if (existing) throw new MemoryConflictError("relation_exists");
    const record = {
      id: uid(), source_entity_id: sourceId, target_entity_id: targetId,
      kind, source_kind: null, source_ref: null, created_at: now(),
    };
    await db.runAsync(
      `INSERT INTO memory_relations
      (id,source_entity_id,target_entity_id,kind,source_kind,source_ref,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      [record.id, sourceId, targetId, kind, null, null, record.created_at],
    );
    return record;
  }

export async function relationsForEntity(db: SQL, id: string, lookupEntity: EntityLookup): Promise<RelationRecord[]> {
    if (!await lookupEntity(id)) return [];
    const rows = await db.getAllAsync<Row>(
      `SELECT r.* FROM memory_relations r JOIN memory_entities e ON e.id=r.source_entity_id
       JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source='model:auto'
       WHERE (r.source_entity_id=? OR r.target_entity_id=?)
         AND (r.source_kind IS NULL OR r.source_kind<>'model:auto' OR
           (r.source_ref=CAST(e.record_version AS TEXT) AND ${CURRENT_MODEL_TERMS}))
       ORDER BY r.created_at, r.id`, [id, id],
    );
    return rows.map(r => ({
      id: String(r.id), source_entity_id: String(r.source_entity_id),
      target_entity_id: String(r.target_entity_id), kind: String(r.kind),
      source_kind: TEXT(r.source_kind), source_ref: TEXT(r.source_ref),
      created_at: String(r.created_at),
    }));
  }

