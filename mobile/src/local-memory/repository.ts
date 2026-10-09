import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";

import { openLocalMemory } from "./storage";
import type {
  CollectionRecord, EntityRecord, MemoryPage, MemoryRepository, NewEntity, NewObservation,
  ObservationRecord, RelationRecord, RevisionRecord, RecordSensitivity,
} from "./types";
import { MemoryAccessError, MemoryConflictError } from "./types";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "withExclusiveTransactionAsync">;
type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const uid = (): string => Crypto.randomUUID();
const clone = (value: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const TEXT = (value: unknown) => typeof value === "string" ? value : null;
const entityFrom = (row: Row): EntityRecord => ({
  id: String(row.id), collection_id: String(row.collection_id),
  domain: String(row.domain), schema_version: String(row.schema_version),
  payload: JSON.parse(String(row.payload_json)), title: TEXT(row.title),
  record_status: row.record_status as EntityRecord["record_status"],
  sensitivity: row.sensitivity as RecordSensitivity, source_kind: TEXT(row.source_kind),
  source_ref: TEXT(row.source_ref), valid_from: TEXT(row.valid_from),
  valid_until: TEXT(row.valid_until), created_at: String(row.created_at),
  updated_at: String(row.updated_at), record_version: Number(row.record_version),
});
const obsFrom = (row: Row): ObservationRecord => ({
  id: String(row.id), entity_id: String(row.entity_id), kind: String(row.kind),
  payload: JSON.parse(String(row.payload_json)), occurred_at: String(row.occurred_at),
  created_at: String(row.created_at), sensitivity: row.sensitivity as RecordSensitivity,
  valid_from: TEXT(row.valid_from), valid_until: TEXT(row.valid_until),
  source_kind: TEXT(row.source_kind), source_ref: TEXT(row.source_ref),
  confidence: row.confidence === null ? null : Number(row.confidence),
  record_version: Number(row.record_version),
});
const page = <T>(items: T[], limit: number, offset: number): MemoryPage<T> => ({
  items: items.slice(0, limit), next_offset: items.length > limit ? offset + limit : null,
});
const bounds = (limit = 50, offset = 0): [number, number] => [
  Math.min(100, Math.max(1, Math.trunc(limit))), Math.max(0, Math.trunc(offset)),
];
function safeReason(reason: string) {
  if (!reason.trim() || reason.length > 512) throw new Error("invalid_revision_reason");
}
function kindAllowed(kind: string) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(kind)) throw new Error("invalid_relation_kind");
}
function validPayload(payload: Record<string, unknown>) {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("invalid_memory_payload");
  }
  return JSON.stringify(payload);
}

export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly db: SQL) {}

  async listCollections(): Promise<CollectionRecord[]> {
    const rows = await this.db.getAllAsync<Row>(
      "SELECT * FROM memory_collections ORDER BY created_at, id",
    );
    return rows.map(r => ({
      id: String(r.id), name: String(r.name), slug: String(r.slug),
      description: TEXT(r.description),
      sensitivity: r.sensitivity as CollectionRecord["sensitivity"],
      created_at: String(r.created_at),
    }));
  }

  async createCollection(item: { name: string; slug: string; sensitivity?: CollectionRecord["sensitivity"] }): Promise<CollectionRecord> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(item.slug)) throw new Error("invalid_collection_slug");
    if (!item.name.trim()) throw new Error("invalid_collection_name");
    const found = await this.db.getFirstAsync<Row>(
      "SELECT id FROM memory_collections WHERE slug = ?", [item.slug],
    );
    if (found) throw new MemoryConflictError("collection_exists");
    const record = {
      id: uid(), name: item.name.trim(), slug: item.slug, description: null,
      sensitivity: item.sensitivity ?? "unclassified", created_at: now(),
    };
    await this.db.runAsync(
      "INSERT INTO memory_collections(id,name,slug,description,sensitivity,created_at) VALUES (?,?,?,?,?,?)",
      [record.id, record.name, record.slug, null, record.sensitivity, record.created_at],
    );
    return record;
  }

  async entity(id: string): Promise<EntityRecord | null> {
    const row = await this.db.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id = ?", [id]);
    return row ? entityFrom(row) : null;
  }

  async entities(options: { collection_id?: string; domain?: string; limit?: number; offset?: number } = {}): Promise<MemoryPage<EntityRecord>> {
    const [limit, offset] = bounds(options.limit, options.offset);
    const filters: string[] = [];
    const params: string[] = [];
    if (options.collection_id) { filters.push("collection_id = ?"); params.push(options.collection_id); }
    if (options.domain) { filters.push("domain = ?"); params.push(options.domain); }
    const sql = `SELECT * FROM memory_entities${filters.length ? " WHERE " + filters.join(" AND ") : ""}
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`;
    const rows = await this.db.getAllAsync<Row>(sql, [...params, limit + 1, offset]);
    return page(rows.map(entityFrom), limit, offset);
  }

  async createEntity(item: NewEntity): Promise<EntityRecord> {
    const collection = await this.db.getFirstAsync<Row>(
      "SELECT id FROM memory_collections WHERE id = ?", [item.collection_id],
    );
    if (!collection) throw new MemoryAccessError("collection_not_found");
    const timestamp = now();
    const id = uid(), payload = clone(item.payload);
    const record: EntityRecord = {
      id, collection_id: item.collection_id, domain: item.domain,
      schema_version: item.schema_version ?? "1", payload,
      title: item.title ?? (typeof payload.title === "string" ? payload.title : null),
      record_status: "active", sensitivity: item.sensitivity ?? "inherit",
      source_kind: item.source_kind ?? null, source_ref: item.source_ref ?? null,
      valid_from: null, valid_until: null,
      created_at: timestamp, updated_at: timestamp, record_version: 1,
    };
    await this.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync(
        `INSERT INTO memory_entities(id, collection_id, domain, schema_version, title, payload_json,
          record_status, sensitivity, source_kind, source_ref, valid_from, valid_until,
          created_at, updated_at, record_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, record.collection_id, record.domain, record.schema_version, record.title,
          validPayload(payload), record.record_status, record.sensitivity,
          record.source_kind, record.source_ref, null, null, timestamp, timestamp, 1],
      );
      if (record.domain === "notes") {
        await tx.runAsync(
          "INSERT INTO memory_notes_fts(entity_id,title,body) VALUES (?,?,?)",
          [id, record.title ?? "", String(record.payload.body ?? "")],
        );
      }
    });
    return record;
  }

  async reviseEntity(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<EntityRecord> {
    safeReason(reason);
    if (expectedVersion < 1) throw new Error("invalid_expected_version");
    const data = validPayload(payload);
    let updated: EntityRecord | null = null;
    await this.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id=?", [id]);
      if (!row) throw new MemoryAccessError("entity_not_found");
      const before = entityFrom(row);
      if (before.record_version !== expectedVersion) throw new MemoryConflictError("stale_memory_version");
      const title = typeof payload.title === "string" ? payload.title : before.title;
      const timestamp = now();
      const result = await tx.runAsync(
        `UPDATE memory_entities SET payload_json=?, title=?, record_version=record_version+1,
          updated_at=? WHERE id=? AND record_version=?`,
        [data, title, timestamp, id, expectedVersion],
      );
      if (result.changes !== 1) throw new MemoryConflictError("stale_memory_version");
      const after = { ...before, payload: clone(payload), title, record_version: expectedVersion + 1, updated_at: timestamp };
      await tx.runAsync(
        `INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,
          reason,actor_kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), "entity", id, null, after.record_version, reason.trim(), "user",
          JSON.stringify(before), JSON.stringify(after), timestamp],
      );
      if (before.domain === "notes") {
        await tx.runAsync("DELETE FROM memory_notes_fts WHERE entity_id=?", [id]);
        await tx.runAsync(
          "INSERT INTO memory_notes_fts(entity_id,title,body) VALUES (?,?,?)",
          [id, title ?? "", String(payload.body ?? "")],
        );
      }
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }

  async observation(id: string): Promise<ObservationRecord | null> {
    const row = await this.db.getFirstAsync<Row>("SELECT * FROM memory_observations WHERE id=?", [id]);
    return row ? obsFrom(row) : null;
  }

  async observations(entityId: string): Promise<ObservationRecord[]> {
    const owner = await this.entity(entityId);
    if (!owner) return [];
    const rows = await this.db.getAllAsync<Row>(
      "SELECT * FROM memory_observations WHERE entity_id=? ORDER BY occurred_at DESC, id",
      [entityId],
    );
    return rows.map(obsFrom);
  }

  async createObservation(item: NewObservation): Promise<ObservationRecord> {
    if (!await this.entity(item.entity_id)) throw new MemoryAccessError("entity_not_found");
    if (!Number.isFinite(Date.parse(item.occurred_at))) throw new Error("invalid_occurred_at");
    const id = uid(), timestamp = now();
    const record: ObservationRecord = {
      id, entity_id: item.entity_id, kind: item.kind,
      payload: clone(item.payload), occurred_at: item.occurred_at, created_at: timestamp,
      sensitivity: item.sensitivity ?? "inherit",
      valid_from: null, valid_until: null, source_kind: item.source_kind ?? null,
      source_ref: item.source_ref ?? null, confidence: null, record_version: 1,
    };
    await this.db.runAsync(
      `INSERT INTO memory_observations(
      id,entity_id,kind,payload_json,occurred_at,created_at,sensitivity,valid_from,valid_until,
      source_kind,source_ref,confidence,record_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, item.entity_id, item.kind, validPayload(record.payload), item.occurred_at, timestamp,
        record.sensitivity, null, null, record.source_kind, record.source_ref, null, 1],
    );
    return record;
  }

  async reviseObservation(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<ObservationRecord> {
    safeReason(reason);
    if (expectedVersion < 1) throw new Error("invalid_expected_version");
    const data = validPayload(payload);
    let updated: ObservationRecord | null = null;
    await this.db.withExclusiveTransactionAsync(async tx => {
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
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }

  async linkEntities(sourceId: string, targetId: string, kind: string): Promise<RelationRecord> {
    if (sourceId === targetId) throw new Error("self_relation_not_allowed");
    kindAllowed(kind);
    if (!(await this.entity(sourceId)) || !(await this.entity(targetId))) {
      throw new MemoryAccessError("entity_not_found");
    }
    const existing = await this.db.getFirstAsync<Row>(
      "SELECT id FROM memory_relations WHERE source_entity_id=? AND target_entity_id=? AND kind=?",
      [sourceId, targetId, kind],
    );
    if (existing) throw new MemoryConflictError("relation_exists");
    const record = {
      id: uid(), source_entity_id: sourceId, target_entity_id: targetId,
      kind, source_kind: null, source_ref: null, created_at: now(),
    };
    await this.db.runAsync(
      `INSERT INTO memory_relations
      (id,source_entity_id,target_entity_id,kind,source_kind,source_ref,created_at)
      VALUES (?,?,?,?,?,?,?)`,
      [record.id, sourceId, targetId, kind, null, null, record.created_at],
    );
    return record;
  }

  async relationsForEntity(id: string): Promise<RelationRecord[]> {
    if (!await this.entity(id)) return [];
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM memory_relations
       WHERE source_entity_id=? OR target_entity_id=?
       ORDER BY created_at, id`, [id, id],
    );
    return rows.map(r => ({
      id: String(r.id), source_entity_id: String(r.source_entity_id),
      target_entity_id: String(r.target_entity_id), kind: String(r.kind),
      source_kind: TEXT(r.source_kind), source_ref: TEXT(r.source_ref),
      created_at: String(r.created_at),
    }));
  }

  async revisions(type: "entity" | "observation", id: string): Promise<RevisionRecord[]> {
    const parent = type === "entity" ? await this.entity(id) : await this.observation(id);
    if (!parent) return [];
    const column = type === "entity" ? "entity_id" : "observation_id";
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM memory_revisions WHERE record_type=? AND ${column}=? ORDER BY version`,
      [type, id],
    );
    return rows.map(r => ({
      id: String(r.id), record_type: type, record_id: id,
      version: Number(r.version), reason: String(r.reason), actor_kind: String(r.actor_kind),
      before_state: JSON.parse(String(r.before_json)), after_state: JSON.parse(String(r.after_json)),
      created_at: String(r.created_at),
    }));
  }

  async searchNotes(query: string, limit = 50): Promise<EntityRecord[]> {
    const count = Math.min(100, Math.max(1, Math.trunc(limit)));
    const term = query.trim();
    if (!term) {
      return (await this.entities({ domain: "notes", limit: count })).items;
    }
    // FTS5 MATCH accepts an entire quoted phrase: escape embedded quotes to
    // avoid treating user input as operators or exposing query syntax errors.
    const phrase = '"' + term.replace(/"/g, '""') + '"';
    const rows = await this.db.getAllAsync<Row>(
      `SELECT e.* FROM memory_entities e
       JOIN memory_notes_fts f ON f.entity_id=e.id
       WHERE memory_notes_fts MATCH ? AND e.domain='notes'
       ORDER BY e.updated_at DESC, e.id LIMIT ?`,
      [phrase, count],
    );
    return rows.map(entityFrom);
  }
}

/** Explicitly device-scoped; no server user tokens or remote calls. */
export async function localMemoryRepository(profileId: string): Promise<SqliteMemoryRepository> {
  return new SqliteMemoryRepository(await openLocalMemory(profileId));
}
