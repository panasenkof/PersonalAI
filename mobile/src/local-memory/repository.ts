import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";

import { openLocalMemory, withLocalMemoryDatabase } from "./storage";
import { withUnlockedTransaction } from "./transaction";
import { defaultKind, indexEntity, isMemoryKind, normalizeAlias } from "./search-index";
import type { MemoryKind } from "./search-index";
import { ftsPhrase, searchSteps } from "./query";
import type {
  CollectionRecord, EntityRecord, MemoryHit, MemoryPage, MemoryRepository, NewEntity, NewObservation,
  ObservationRecord, RelationRecord, RevisionRecord, RecordSensitivity,
} from "./types";
import { MemoryAccessError, MemoryConflictError } from "./types";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
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
  kind: isMemoryKind(row.kind) ? row.kind : "note",
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
function checkedKind(kind: unknown): MemoryKind {
  if (!isMemoryKind(kind)) throw new Error("invalid_memory_kind");
  return kind;
}
/** Index words: each 2–40 letters, up to 40 of them, from the user or a model. */
function checkedTerms(terms: string[]): string {
  const words = [...new Set(terms.flatMap(t => String(t).toLowerCase().split(/[^\p{L}\p{N}-]+/u))
    .filter(w => w.length >= 2 && w.length <= 40))].slice(0, 40);
  return words.join(" ");
}
// bm25 column weights: entity_id, chunk_id, title, body, terms, aliases.
const RANK = "bm25(memory_search_fts, 0, 0, 4, 1, 2, 4)";
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

  async entities(options: { collection_id?: string; domain?: string; kind?: MemoryKind; limit?: number; offset?: number } = {}): Promise<MemoryPage<EntityRecord>> {
    const [limit, offset] = bounds(options.limit, options.offset);
    const filters: string[] = [];
    const params: string[] = [];
    if (options.collection_id) { filters.push("collection_id = ?"); params.push(options.collection_id); }
    if (options.domain) { filters.push("domain = ?"); params.push(options.domain); }
    if (options.kind) { filters.push("kind = ?"); params.push(checkedKind(options.kind)); }
    const sql = `SELECT * FROM memory_entities${filters.length ? " WHERE " + filters.join(" AND ") : ""}
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`;
    const rows = await this.db.getAllAsync<Row>(sql, [...params, limit + 1, offset]);
    return page(rows.map(entityFrom), limit, offset);
  }

  async createEntity(item: NewEntity): Promise<EntityRecord> {
    const collection = await this.db.getFirstAsync<Row>(
      "SELECT id, slug FROM memory_collections WHERE id = ?", [item.collection_id],
    );
    if (!collection) throw new MemoryAccessError("collection_not_found");
    const kind = item.kind === undefined ? defaultKind(TEXT(collection.slug)) : checkedKind(item.kind);
    const timestamp = now();
    const id = uid(), payload = clone(item.payload);
    const record: EntityRecord = {
      id, collection_id: item.collection_id, domain: item.domain,
      schema_version: item.schema_version ?? "1", payload,
      title: item.title ?? (typeof payload.title === "string" ? payload.title : null),
      record_status: "active", sensitivity: item.sensitivity ?? "inherit",
      source_kind: item.source_kind ?? null, source_ref: item.source_ref ?? null,
      valid_from: item.valid_from && Number.isFinite(Date.parse(item.valid_from)) ? item.valid_from : null, valid_until: null,
      created_at: timestamp, updated_at: timestamp, record_version: 1, kind,
    };
    await withUnlockedTransaction(this.db, async tx => {
      await tx.runAsync(
        `INSERT INTO memory_entities(id, collection_id, domain, schema_version, title, payload_json,
          record_status, sensitivity, source_kind, source_ref, valid_from, valid_until,
          created_at, updated_at, record_version, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, record.collection_id, record.domain, record.schema_version, record.title,
          validPayload(payload), record.record_status, record.sensitivity,
          record.source_kind, record.source_ref, record.valid_from, null, timestamp, timestamp, 1, kind],
      );
      await indexEntity(tx, id, timestamp);
    });
    return record;
  }

  async reviseEntity(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string, collectionId?: string): Promise<EntityRecord> {
    safeReason(reason);
    if (expectedVersion < 1) throw new Error("invalid_expected_version");
    const data = validPayload(payload);
    let updated: EntityRecord | null = null;
    await withUnlockedTransaction(this.db, async tx => {
      const row = await tx.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id=?", [id]);
      if (!row) throw new MemoryAccessError("entity_not_found");
      const before = entityFrom(row);
      if (before.record_version !== expectedVersion) throw new MemoryConflictError("stale_memory_version");
      const collection = collectionId || before.collection_id;
      if (!await tx.getFirstAsync<Row>("SELECT id FROM memory_collections WHERE id=?", [collection])) throw new MemoryAccessError("collection_not_found");
      let sensitivity = before.sensitivity;
      if (collection !== before.collection_id) {
        const previousCollection = await tx.getFirstAsync<Row>("SELECT sensitivity FROM memory_collections WHERE id=?", [before.collection_id]);
        // Moving a record must preserve its previous effective classification.
        // In particular, inherit must not promote private content to ordinary.
        const previousLevel = previousCollection?.sensitivity;
        if (previousLevel === "secret" || previousLevel === "unclassified") sensitivity = "secret";
        else if (previousLevel === "sensitive" && sensitivity !== "secret") sensitivity = "sensitive";
      }
      const title = typeof payload.title === "string" ? payload.title : before.title;
      const timestamp = now();
      const result = await tx.runAsync(
        `UPDATE memory_entities SET payload_json=?, title=?, collection_id=?, sensitivity=?, record_version=record_version+1,
          updated_at=? WHERE id=? AND record_version=?`,
        [data, title, collection, sensitivity, timestamp, id, expectedVersion],
      );
      if (result.changes !== 1) throw new MemoryConflictError("stale_memory_version");
      const after = { ...before, payload: clone(payload), title, collection_id: collection, sensitivity, record_version: expectedVersion + 1, updated_at: timestamp };
      await tx.runAsync(
        `INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,
          reason,actor_kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), "entity", id, null, after.record_version, reason.trim(), "user",
          JSON.stringify(before), JSON.stringify(after), timestamp],
      );
      await indexEntity(tx, id, timestamp);
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }

  async setEntityStatus(id: string, expectedVersion: number, status: "active" | "archived"): Promise<EntityRecord> {
    if (status !== "active" && status !== "archived") throw new Error("invalid_record_status");
    let updated: EntityRecord | null = null;
    await withUnlockedTransaction(this.db, async tx => {
      const row = await tx.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id=?", [id]);
      if (!row) throw new MemoryAccessError("entity_not_found");
      const before = entityFrom(row);
      if (before.record_version !== expectedVersion) throw new MemoryConflictError("stale_memory_version");
      const timestamp = now();
      const result = await tx.runAsync(
        "UPDATE memory_entities SET record_status=?,record_version=record_version+1,updated_at=? WHERE id=? AND record_version=?",
        [status, timestamp, id, expectedVersion],
      );
      if (result.changes !== 1) throw new MemoryConflictError("stale_memory_version");
      const after = { ...before, record_status: status, record_version: before.record_version + 1, updated_at: timestamp };
      await tx.runAsync(
        `INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,reason,actor_kind,before_json,after_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), "entity", id, null, after.record_version, status === "archived" ? "Перенос в архив" : "Возврат из архива", "user", JSON.stringify(before), JSON.stringify(after), timestamp],
      );
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
    await withUnlockedTransaction(this.db, async tx => {
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

  /** Changes the record's type (fact, person, event…) with a revision. */
  async setEntityKind(id: string, expectedVersion: number, kind: MemoryKind): Promise<EntityRecord> {
    const next = checkedKind(kind);
    let updated: EntityRecord | null = null;
    await withUnlockedTransaction(this.db, async tx => {
      const row = await tx.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id=?", [id]);
      if (!row) throw new MemoryAccessError("entity_not_found");
      const before = entityFrom(row);
      if (before.record_version !== expectedVersion) throw new MemoryConflictError("stale_memory_version");
      const timestamp = now();
      const result = await tx.runAsync(
        "UPDATE memory_entities SET kind=?,record_version=record_version+1,updated_at=? WHERE id=? AND record_version=?",
        [next, timestamp, id, expectedVersion],
      );
      if (result.changes !== 1) throw new MemoryConflictError("stale_memory_version");
      const after = { ...before, kind: next, record_version: before.record_version + 1, updated_at: timestamp };
      await tx.runAsync(
        `INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,reason,actor_kind,before_json,after_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), "entity", id, null, after.record_version, "Смена типа записи", "user", JSON.stringify(before), JSON.stringify(after), timestamp],
      );
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }

  /** Names and nicknames a record is also found by («Маша», «Мария Петровна»). */
  async aliases(entityId: string): Promise<string[]> {
    const rows = await this.db.getAllAsync<Row>("SELECT alias FROM memory_aliases WHERE entity_id=? ORDER BY normalized", [entityId]);
    return rows.map(r => String(r.alias));
  }

  /** Replaces the record's names; up to 20, each up to 80 characters. */
  async setAliases(entityId: string, aliases: string[]): Promise<string[]> {
    const unique = new Map<string, string>();
    for (const raw of aliases) {
      const alias = String(raw).replace(/\s+/g, " ").trim();
      if (!alias) continue;
      if (alias.length > 80) throw new Error("invalid_memory_alias");
      if (!unique.has(normalizeAlias(alias))) unique.set(normalizeAlias(alias), alias);
    }
    if (unique.size > 20) throw new Error("too_many_memory_aliases");
    await withUnlockedTransaction(this.db, async tx => {
      if (!await tx.getFirstAsync<Row>("SELECT id FROM memory_entities WHERE id=?", [entityId])) throw new MemoryAccessError("entity_not_found");
      await tx.runAsync("DELETE FROM memory_aliases WHERE entity_id=?", [entityId]);
      for (const [normalized, alias] of unique) {
        await tx.runAsync("INSERT INTO memory_aliases(entity_id,alias,normalized) VALUES (?,?,?)", [entityId, alias, normalized]);
      }
      await indexEntity(tx, entityId);
    });
    return [...unique.values()];
  }

  /** Records with exactly this name or title, e.g. the person a fact is about.
   * SQLite lower() is ASCII-only, so titles are matched through the index and
   * compared here. */
  async entitiesByAlias(name: string, kind?: MemoryKind): Promise<EntityRecord[]> {
    const normalized = normalizeAlias(name);
    if (!normalized) return [];
    const rows = await this.db.getAllAsync<Row>(
      `SELECT e.* FROM memory_entities e WHERE e.record_status='active' ${kind ? "AND e.kind=?" : ""}
       AND (e.id IN (SELECT entity_id FROM memory_aliases WHERE normalized=?)
         OR e.id IN (SELECT entity_id FROM memory_search_fts WHERE memory_search_fts MATCH ?))
       ORDER BY e.updated_at DESC, e.id LIMIT 50`,
      [...(kind ? [checkedKind(kind)] : []), normalized, "title : " + ftsPhrase(normalized)],
    );
    const named = new Set((await this.db.getAllAsync<Row>("SELECT entity_id FROM memory_aliases WHERE normalized=?", [normalized])).map(r => String(r.entity_id)));
    return rows.filter(r => named.has(String(r.id)) || normalizeAlias(String(r.title ?? "")) === normalized).slice(0, 20).map(entityFrom);
  }

  /** Index words by source: `user` or `model:<name>`. */
  async indexTerms(entityId: string): Promise<Array<{ source: string; terms: string[] }>> {
    const rows = await this.db.getAllAsync<Row>("SELECT source, terms FROM memory_index_terms WHERE entity_id=? ORDER BY source", [entityId]);
    return rows.map(r => ({ source: String(r.source), terms: String(r.terms).split(" ").filter(Boolean) }));
  }

  /** Replaces the index words from one source; an empty list removes them. */
  async setIndexTerms(entityId: string, terms: string[], source: string): Promise<string[]> {
    if (!/^(user|model:[a-z0-9._-]{1,60})$/i.test(source)) throw new Error("invalid_index_terms_source");
    const words = checkedTerms(terms);
    await withUnlockedTransaction(this.db, async tx => {
      if (!await tx.getFirstAsync<Row>("SELECT id FROM memory_entities WHERE id=?", [entityId])) throw new MemoryAccessError("entity_not_found");
      await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source=?", [entityId, source]);
      // A model's empty answer is kept too: it marks the record as done.
      if (words || source.startsWith("model:")) await tx.runAsync("INSERT INTO memory_index_terms(entity_id,terms,source,created_at) VALUES (?,?,?,?)", [entityId, words, source, now()]);
      await indexEntity(tx, entityId);
    });
    return words.split(" ").filter(Boolean);
  }

  /** How many enrichable records have current index words from `source`, and how many wait. */
  async indexTermsStatus(source: string): Promise<{ done: number; pending: number }> {
    const row = await this.db.getFirstAsync<Row>(
      `SELECT sum(CASE WHEN t.entity_id IS NOT NULL AND t.created_at >= e.updated_at THEN 1 ELSE 0 END) AS done,
              sum(CASE WHEN t.entity_id IS NULL OR t.created_at < e.updated_at THEN 1 ELSE 0 END) AS pending
       FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source=?
       WHERE e.record_status='active' AND e.domain='notes' AND c.sensitivity='standard' AND c.slug<>'documents'
         AND e.sensitivity IN ('standard','inherit')`, [source]);
    return { done: Number(row?.done ?? 0), pending: Number(row?.pending ?? 0) };
  }

  /** Active records of ordinary sections whose index words from `source` are
   * missing or older than their last edit, oldest first. */
  async staleIndexTerms(source: string, limit = 20): Promise<string[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT e.id FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source=?
       WHERE e.record_status='active' AND e.domain='notes' AND c.sensitivity='standard' AND c.slug<>'documents'
         AND e.sensitivity IN ('standard','inherit') AND (t.entity_id IS NULL OR t.created_at < e.updated_at)
       ORDER BY e.updated_at, e.id LIMIT ?`, [source, Math.min(200, Math.max(1, Math.trunc(limit)))]);
    return rows.map(r => String(r.id));
  }

  /** `prefix` matches words that start with the query (a word stem without its
   * ending), so «машин» finds «машина», «машину» and «машиной». Results with a
   * query are ranked by relevance (bm25 over title, text, index words and
   * names), then by date. */
  async searchNotes(query: string, limit = 50, offset = 0, filters: { collectionId?: string; status?: "active" | "archived"; prefix?: boolean } = {}): Promise<EntityRecord[]> {
    const count = Math.min(100, Math.max(1, Math.trunc(limit)));
    const start = Math.max(0, Math.trunc(offset));
    const term = query.trim();
    const status = filters.status || "active";
    if (status !== "active" && status !== "archived") throw new Error("invalid_record_status");
    const rows = await this.matches(term, filters.prefix ?? false, {
      status, collectionIds: filters.collectionId ? [filters.collectionId] : undefined, limit: count, offset: start,
    });
    return rows.map(r => entityFrom(r));
  }

  /** One FTS search grouped by record: the best chunk of each record. */
  private async matches(term: string, prefix: boolean | { prefix: boolean; column?: "terms" }, options: {
    status: "active" | "archived"; collectionIds?: string[]; sensitivities?: string[]; limit: number; offset: number;
  }): Promise<Row[]> {
    const filters = ["e.domain='notes'", "e.record_status=?"];
    const params: SQLite.SQLiteBindValue[] = [options.status];
    if (options.collectionIds) {
      if (!options.collectionIds.length) return [];
      filters.push(`e.collection_id IN (${options.collectionIds.map(() => "?").join(",")})`); params.push(...options.collectionIds);
    }
    if (options.sensitivities) {
      filters.push(`e.sensitivity IN (${options.sensitivities.map(() => "?").join(",")})`); params.push(...options.sensitivities);
    }
    if (!term) return this.db.getAllAsync<Row>(
      `SELECT e.*, NULL AS match_chunk FROM memory_entities e WHERE ${filters.join(" AND ")}
       ORDER BY e.updated_at DESC, e.id LIMIT ? OFFSET ?`, [...params, options.limit, options.offset]);
    // FTS5 ranking functions cannot run in a flattened subquery, hence MATERIALIZED.
    return this.db.getAllAsync<Row>(
      `WITH hits AS MATERIALIZED (
         SELECT entity_id, chunk_id, ${RANK} AS score FROM memory_search_fts WHERE memory_search_fts MATCH ?
       ), best AS (SELECT entity_id, chunk_id, min(score) AS score FROM hits GROUP BY entity_id)
       SELECT e.*, best.chunk_id AS match_chunk FROM best JOIN memory_entities e ON e.id=best.entity_id
       WHERE ${filters.join(" AND ")}
       ORDER BY best.score, e.updated_at DESC, e.id LIMIT ? OFFSET ?`,
      [typeof prefix === "boolean" ? ftsPhrase(term, prefix) : ftsPhrase(term, prefix.prefix, prefix.column), ...params, options.limit, options.offset]);
  }

  /** Active records linked to a person as «about», within the same filters. */
  private async linkedFacts(personId: string, options: { collectionIds?: string[]; sensitivities?: string[] }): Promise<Row[]> {
    const filters = ["e.domain='notes'", "e.record_status='active'"];
    const params: SQLite.SQLiteBindValue[] = [personId];
    if (options.collectionIds) {
      if (!options.collectionIds.length) return [];
      filters.push(`e.collection_id IN (${options.collectionIds.map(() => "?").join(",")})`); params.push(...options.collectionIds);
    }
    if (options.sensitivities) { filters.push(`e.sensitivity IN (${options.sensitivities.map(() => "?").join(",")})`); params.push(...options.sensitivities); }
    return this.db.getAllAsync<Row>(
      `SELECT e.*, NULL AS match_chunk FROM memory_relations r JOIN memory_entities e ON e.id=r.source_entity_id
       WHERE r.kind='about' AND r.target_entity_id=? AND ${filters.join(" AND ")}
       ORDER BY e.updated_at DESC LIMIT 8`, params);
  }

  /** The assistant's memory search: the whole phrase, each word, each stem and
   * names, every search over title, text, index words and names. A record
   * found by more of them ranks higher. Each hit carries its best chunk.
   * Only the given sections and sensitivities are searched. */
  async searchMemory(query: string, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number } = {}): Promise<MemoryHit[]> {
    const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 5)));
    const scored = new Map<string, { row: Row; score: number; order: number; chunk: string | null; weight: number }>();
    for (const step of searchSteps(query)) {
      const rows = await this.matches(step.term, { prefix: step.prefix, column: step.column }, {
        status: "active", collectionIds: options.collectionIds, sensitivities: options.sensitivities, limit: 8, offset: 0,
      });
      for (const row of rows) {
        const id = String(row.id);
        const found = scored.get(id) || { row, score: 0, order: scored.size, chunk: null, weight: 0 };
        found.score += step.weight;
        // The chunk of the most specific search that found the record.
        if (step.weight > found.weight && row.match_chunk) { found.chunk = String(row.match_chunk); found.weight = step.weight; }
        scored.set(id, found);
      }
    }
    // Through people (п. 12): a found person brings the facts about them —
    // «что любит сестра» finds Аня by «сестра», then her «любит капучино».
    const people = [...scored.values()].filter(v => v.row.kind === "person").sort((a, b) => b.score - a.score).slice(0, 3);
    for (const person of people) {
      for (const row of await this.linkedFacts(String(person.row.id), options)) {
        const id = String(row.id);
        const found = scored.get(id) || { row, score: 0, order: scored.size, chunk: null, weight: 0 };
        found.score += Math.max(1, person.score * 0.75);
        scored.set(id, found);
      }
    }
    const top = [...scored.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit);
    const hits: MemoryHit[] = [];
    for (const item of top) {
      const chunk = await this.db.getFirstAsync<Row>(
        item.chunk ? "SELECT text FROM memory_chunks WHERE id=?" : "SELECT text FROM memory_chunks WHERE entity_id=? ORDER BY ord LIMIT 1",
        [item.chunk ?? String(item.row.id)]);
      hits.push({ entity: entityFrom(item.row), score: item.score, chunk: TEXT(chunk?.text) ?? "" });
    }
    return hits;
  }
}

/** Explicitly device-scoped; no server user tokens or remote calls. */
export async function localMemoryRepository(profileId: string): Promise<SqliteMemoryRepository> {
  await openLocalMemory(profileId);
  // Lease the database for each COMPLETE repository operation. A mounted screen
  // can survive backgrounding; it must not retain a closed native SQLite handle.
  return new Proxy({} as SqliteMemoryRepository, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then" ||
          typeof (SqliteMemoryRepository.prototype as any)[property] !== "function") return undefined;
      return (...args: unknown[]) => withLocalMemoryDatabase(profileId, db =>
        (new SqliteMemoryRepository(db) as any)[property](...args));
    },
  });
}
