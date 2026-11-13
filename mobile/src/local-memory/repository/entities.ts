/** ARCH-6c: canonical entity, metadata and revision operations.
 * Original SQL/CAS/ACL checks and transaction boundaries; SQLCipher connection
 * provided by the same localMemoryRepository facade. No new writer or reader.
 */
import { withUnlockedTransaction } from "../transaction";
import { defaultKind, indexEntity, isMemoryKind, normalizeAlias } from "../search-index";
import type { MemoryKind } from "../search-index";
import { ftsPhrase } from "../query";
import { changeNotes } from "../note-actions";
import { observation } from "./observations";
import { clone, safeReason, validPayload } from "./record-core";
import { checkedTerms, replaceIndexTerms } from "./index-terms";
import { now, uid, TEXT, type SQL, type Row } from "./shared";
import { MemoryAccessError, MemoryConflictError, type CollectionRecord, type EntityRecord, type MemoryPage, type NewEntity, type RevisionRecord, type RecordSensitivity } from "../types";

export const entityFrom = (row: Row): EntityRecord => ({
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
const page = <T>(items: T[], limit: number, offset: number): MemoryPage<T> => ({
  items: items.slice(0, limit), next_offset: items.length > limit ? offset + limit : null,
});
const bounds = (limit = 50, offset = 0): [number, number] => [
  Math.min(100, Math.max(1, Math.trunc(limit))), Math.max(0, Math.trunc(offset)),
];
function checkedKind(kind: unknown): MemoryKind {
  if (!isMemoryKind(kind)) throw new Error("invalid_memory_kind");
  return kind;
}
/** User-authored names and search words are durable card data, NOT a derived index.
 * Save them in the same SQLCipher transaction and revision as the edited record. */
export type NoteCardFields = { kind: MemoryKind; aliases: string[]; userTerms: string[] };
/** One validation contract for the card editor and standalone name writer. */
function prepareAliases(aliases: string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const raw of aliases) {
    const alias = String(raw).replace(/\s+/g, " ").trim();
    if (!alias) continue;
    if (alias.length > 80) throw new Error("invalid_memory_alias");
    const normalized = normalizeAlias(alias);
    if (!names.has(normalized)) names.set(normalized, alias);
  }
  if (names.size > 20) throw new Error("too_many_memory_aliases");
  return names;
}
/** These are user-owned rows, never a disposable FTS or vector projection.
 * Call only from an unlocked transaction and rebuild FTS before committing. */
async function replaceAliases(tx: SQL, entityId: string, names: ReadonlyMap<string, string>): Promise<void> {
  await tx.runAsync("DELETE FROM memory_aliases WHERE entity_id=?", [entityId]);
  for (const [normalized, alias] of names) {
    await tx.runAsync("INSERT INTO memory_aliases(entity_id,alias,normalized) VALUES (?,?,?)", [entityId, alias, normalized]);
  }
}
function prepareNoteCard(fields: NoteCardFields) {
  return { kind: checkedKind(fields.kind), names: prepareAliases(fields.aliases), words: checkedTerms(fields.userTerms) };
}
async function writeNoteCardFields(db: SQL, entityId: string, fields: ReturnType<typeof prepareNoteCard>, timestamp: string) {
  await replaceAliases(db, entityId, fields.names);
  await replaceIndexTerms(db, entityId, fields.words, "user", timestamp);
}
export async function entity(db: SQL, id: string): Promise<EntityRecord | null> {
    const row = await db.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id = ?", [id]);
    return row ? entityFrom(row) : null;
  }

export async function entities(db: SQL, options: { collection_id?: string; domain?: string; kind?: MemoryKind; limit?: number; offset?: number } = {}): Promise<MemoryPage<EntityRecord>> {
    const [limit, offset] = bounds(options.limit, options.offset);
    const filters: string[] = [];
    const params: string[] = [];
    if (options.collection_id) { filters.push("collection_id = ?"); params.push(options.collection_id); }
    if (options.domain) { filters.push("domain = ?"); params.push(options.domain); }
    if (options.kind) { filters.push("kind = ?"); params.push(checkedKind(options.kind)); }
    const sql = `SELECT * FROM memory_entities${filters.length ? " WHERE " + filters.join(" AND ") : ""}
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`;
    const rows = await db.getAllAsync<Row>(sql, [...params, limit + 1, offset]);
    return page(rows.map(entityFrom), limit, offset);
  }

export async function createEntity(db: SQL, item: NewEntity, writeAttachment?: (tx: SQL, entityId: string) => Promise<void>, cardFields?: NoteCardFields): Promise<EntityRecord> {
    const card = cardFields ? prepareNoteCard(cardFields) : null;
    const collection = await db.getFirstAsync<Row>(
      "SELECT id, slug FROM memory_collections WHERE id = ?", [item.collection_id],
    );
    if (!collection) throw new MemoryAccessError("collection_not_found");
    const kind = card?.kind ?? (item.kind === undefined ? defaultKind(TEXT(collection.slug)) : checkedKind(item.kind));
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
    await withUnlockedTransaction(db, async tx => {
      await tx.runAsync(
        `INSERT INTO memory_entities(id, collection_id, domain, schema_version, title, payload_json,
          record_status, sensitivity, source_kind, source_ref, valid_from, valid_until,
          created_at, updated_at, record_version, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, record.collection_id, record.domain, record.schema_version, record.title,
          validPayload(payload), record.record_status, record.sensitivity,
          record.source_kind, record.source_ref, record.valid_from, null, timestamp, timestamp, 1, kind],
      );
      if (writeAttachment) await writeAttachment(tx, id);
      if (card) await writeNoteCardFields(tx, id, card, timestamp);
      await indexEntity(tx, id, timestamp);
    });
    return record;
  }

export async function reviseEntity(db: SQL, id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string, collectionId?: string, allowAgent = false, writeAttachment?: (tx: SQL, entityId: string) => Promise<void>, cardFields?: NoteCardFields): Promise<EntityRecord> {
    safeReason(reason);
    const card = cardFields ? prepareNoteCard(cardFields) : null;
    if (expectedVersion < 1) throw new Error("invalid_expected_version");
    const data = validPayload(payload);
    let updated: EntityRecord | null = null;
    await withUnlockedTransaction(db, async tx => {
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
      if (allowAgent) {
        const target = await tx.getFirstAsync<Row>("SELECT sensitivity FROM memory_collections WHERE id=?", [collection]);
        if (target?.sensitivity !== "standard") throw new MemoryAccessError("collection_not_standard");
        sensitivity = "standard";
      }
      const title = typeof payload.title === "string" ? payload.title : before.title;
      const kind = card?.kind ?? before.kind;
      const timestamp = now();
      const result = await tx.runAsync(
        `UPDATE memory_entities SET payload_json=?, title=?, kind=?, collection_id=?, sensitivity=?, record_version=record_version+1,
          updated_at=? WHERE id=? AND record_version=?`,
        [data, title, kind, collection, sensitivity, timestamp, id, expectedVersion],
      );
      if (result.changes !== 1) throw new MemoryConflictError("stale_memory_version");
      const after = { ...before, payload: clone(payload), title, kind, collection_id: collection, sensitivity, record_version: expectedVersion + 1, updated_at: timestamp };
      await tx.runAsync(
        `INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,
          reason,actor_kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [uid(), "entity", id, null, after.record_version, reason.trim(), "user",
          JSON.stringify(before), JSON.stringify(after), timestamp],
      );
      if (writeAttachment) await writeAttachment(tx, id);
      if (card) await writeNoteCardFields(tx, id, card, timestamp);
      await indexEntity(tx, id, timestamp);
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }

  /** Compatibility entry used by card/other clients; the only archive writer
   * is changeNotes, which also records a durable, CAS-protected undo token. */
export async function setEntityStatus(db: SQL, id: string, expectedVersion: number, status: "active" | "archived"): Promise<EntityRecord> {
    if (status !== "active" && status !== "archived") throw new Error("invalid_record_status");
    await changeNotes(db,status === "archived" ? "archive" : "unarchive", [{ id, record_version: expectedVersion }]);
    const updated = await entity(db,id);
    if (!updated) throw new MemoryAccessError("entity_not_found");
    return updated;
  }

export async function revisions(db: SQL, type: "entity" | "observation", id: string): Promise<RevisionRecord[]> {
    const parent = type === "entity" ? await entity(db,id) : await observation(db,id);
    if (!parent) return [];
    const column = type === "entity" ? "entity_id" : "observation_id";
    const rows = await db.getAllAsync<Row>(
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
export async function setEntityKind(db: SQL, id: string, expectedVersion: number, kind: MemoryKind): Promise<EntityRecord> {
    const next = checkedKind(kind);
    let updated: EntityRecord | null = null;
    await withUnlockedTransaction(db, async tx => {
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
export async function aliases(db: SQL, entityId: string): Promise<string[]> {
    const rows = await db.getAllAsync<Row>("SELECT alias FROM memory_aliases WHERE entity_id=? ORDER BY normalized", [entityId]);
    return rows.map(r => String(r.alias));
  }

  /** Replaces the record's names; up to 20, each up to 80 characters. */
export async function setAliases(db: SQL, entityId: string, aliases: string[]): Promise<string[]> {
    const names = prepareAliases(aliases);
    await withUnlockedTransaction(db, async tx => {
      if (!await tx.getFirstAsync<Row>("SELECT id FROM memory_entities WHERE id=?", [entityId])) throw new MemoryAccessError("entity_not_found");
      await replaceAliases(tx, entityId, names);
      await indexEntity(tx, entityId);
    });
    return [...names.values()];
  }

  /** Records with exactly this name or title, e.g. the person a fact is about.
   * SQLite lower() is ASCII-only, so titles are matched through the index and
   * compared here. */
export async function entitiesByAlias(db: SQL, name: string, kind?: MemoryKind): Promise<EntityRecord[]> {
    const normalized = normalizeAlias(name);
    if (!normalized) return [];
    const rows = await db.getAllAsync<Row>(
      `SELECT e.* FROM memory_entities e WHERE e.record_status='active' ${kind ? "AND e.kind=?" : ""}
       AND (e.id IN (SELECT entity_id FROM memory_aliases WHERE normalized=?)
         OR e.id IN (SELECT entity_id FROM memory_search_fts WHERE memory_search_fts MATCH ?))
       ORDER BY e.updated_at DESC, e.id LIMIT 50`,
      [...(kind ? [checkedKind(kind)] : []), normalized, "title : " + ftsPhrase(normalized)],
    );
    const named = new Set((await db.getAllAsync<Row>("SELECT entity_id FROM memory_aliases WHERE normalized=?", [normalized])).map(r => String(r.entity_id)));
    return rows.filter(r => named.has(String(r.id)) || normalizeAlias(String(r.title ?? "")) === normalized).slice(0, 20).map(entityFrom);
  }

