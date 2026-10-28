import { changeNotes, undoNotes, purgeNotes, type NoteAction, type NoteSelection } from "./note-actions";
import { MemoryHygieneService } from "./hygiene";
import { DurableVectorJobs, markEntityVectorsDirty, type ClaimedVectorJob, type CompletedVectorJob } from "./vector-jobs";
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";

import { openLocalMemory, withLocalMemoryDatabase } from "./storage";
import { withUnlockedTransaction } from "./transaction";
import { stageTemporalCandidateWithReview, listTemporalKnowledgeHistory, listTemporalStateCandidatesAtDate } from "./temporal-store";
import { listTemporalReviewInbox as readTemporalReviewInbox } from "./temporal-review-inbox";
import { decideTemporalReview, undoTemporalReview } from "./temporal-decisions";
import { confirmUserRelationEvidence, listCurrentConfirmedRelationProofs, findCurrentRelativeConversationPaths, retractUserRelationEvidence, undoUserRelationRetraction, listUserRelationReviewHistory, stageRelationReviewCandidate, listRelationReviewCandidates, decideRelationCandidate, undoRelationCandidateDecision, relationCandidateDecisionHistory } from "./relation-evidence";
import type { ConfirmRelationInput, RelationReviewExpected, StageRelationReviewInput, RelationInboxCursor, RelationCandidateExpected, RelationCandidateReviewChoice } from "./relation-evidence";
import type { DirectPersonRelation } from "./relational-proof";
import type { TemporalClaimCandidate } from "./temporal-claims";
import type { TemporalHistoryQuery, TemporalAtDateQuery } from "./temporal-store";
import type { TemporalInboxQuery } from "./temporal-review-inbox";
import type { TemporalDecisionRequest, TemporalDecisionExpected } from "./temporal-decisions";
import { defaultKind, indexEntity, isMemoryKind, normalizeAlias } from "./search-index";
import type { MemoryKind } from "./search-index";
import { ftsPhrase, requiredSearchEvidence, searchSteps } from "./query";
import { MIN_SIMILARITY, VECTOR_DIM, cosine, embeddingHash, embeddingText, fromBlob, fuseRanks, isCurrentVectorSpace, toBlob } from "./vectors";
import type {
  CollectionRecord, EntityRecord, MemoryHit, MemoryPage, MemoryRepository, NewEntity, NewObservation,
  ObservationRecord, RelationRecord, RevisionRecord, RecordSensitivity,
} from "./types";
import { MemoryAccessError, MemoryConflictError } from "./types";
import { CURRENT_MODEL_TERMS, enrichable, type EnrichmentSnapshot } from "./enrichment-policy";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const uid = (): string => Crypto.randomUUID();
const clone = (value: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const TEXT = (value: unknown) => typeof value === "string" ? value : null;
// Corrupted dimensions and old model-space revisions are missing work, not
// completed results; old vectors remain derived data but are never compared.
const validVectorJoin = (model: string) =>
  "LEFT JOIN memory_vectors v ON v.chunk_id=c.id AND v.model=? " +
  "AND v.dim>0 AND length(v.vector)=4*v.dim" +
  (isCurrentVectorSpace(model) ? " AND v.dim=" + VECTOR_DIM : "");
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

  /** Explicit typed user workflow. Not exposed as an automatic agent tool. */
  stageTypedTemporalFact(candidate: TemporalClaimCandidate) {
    return stageTemporalCandidateWithReview(this.db, candidate);
  }
  /** Review items include source-version snapshots for the CAS action. */
  temporalReviewInbox(query: TemporalInboxQuery) {
    return readTemporalReviewInbox(this.db, query);
  }
  /** Decisions require an actual UI/user action and an explicit end bound. */
  decideTemporalChange(request: TemporalDecisionRequest) {
    return decideTemporalReview(this.db, request);
  }
  undoTemporalChange(request: TemporalDecisionExpected & { decisionId: string }) {
    return undoTemporalReview(this.db, request);
  }
  /** As-of VALID date is candidate-only; knowledge snapshot reconstruction is separate. */
  temporalCandidatesAtDate(query: TemporalAtDateQuery) {
    return listTemporalStateCandidatesAtDate(this.db, query);
  }
  /** History is explicitly labeled candidate/unconfirmed, not "current". */
  temporalKnowledgeHistory(query: TemporalHistoryQuery) {
    return listTemporalKnowledgeHistory(this.db, query);
  }

  /** M1/№79а: read-only review and persistent user exceptions; no automatic deletes. */
  hygiene() { return new MemoryHygieneService(this.db); }
  changeNotes(action: NoteAction, selection: NoteSelection[], collectionId?: string) { return changeNotes(this.db, action, selection, collectionId); }
  purgeNotes(selection: NoteSelection[]) { return purgeNotes(this.db, selection); }
  async lastNoteOperation(): Promise<string> {
    const row = await this.db.getFirstAsync<{ reason: string }>("SELECT reason FROM memory_revisions WHERE reason LIKE 'notes:%' OR reason LIKE 'Отмена notes:%' ORDER BY created_at DESC,rowid DESC LIMIT 1");
    return row?.reason.startsWith("notes:") ? row.reason : "";
  }
  undoNotes(batch: string) { return undoNotes(this.db, batch); }


  async collectionNoteCounts(): Promise<Record<string, number>> {
    const rows = await this.db.getAllAsync<{ collection_id: string; total: number }>("SELECT collection_id, COUNT(*) AS total FROM memory_entities WHERE record_status='active' GROUP BY collection_id");
    return Object.fromEntries(rows.map(row => [row.collection_id, row.total]));
  }
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

  async createEntity(item: NewEntity, writeAttachment?: (tx: SQL, entityId: string) => Promise<void>): Promise<EntityRecord> {
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
      if (writeAttachment) await writeAttachment(tx, id);
      await indexEntity(tx, id, timestamp);
    });
    return record;
  }

  async reviseEntity(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string, collectionId?: string, allowAgent = false, writeAttachment?: (tx: SQL, entityId: string) => Promise<void>): Promise<EntityRecord> {
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
      if (allowAgent) {
        const target = await tx.getFirstAsync<Row>("SELECT sensitivity FROM memory_collections WHERE id=?", [collection]);
        if (target?.sensitivity !== "standard") throw new MemoryAccessError("collection_not_standard");
        sensitivity = "standard";
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
      if (writeAttachment) await writeAttachment(tx, id);
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
      if (status === 'active') await markEntityVectorsDirty(tx, id, timestamp);
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
    await withUnlockedTransaction(this.db, async tx => {
      await tx.runAsync(
        `INSERT INTO memory_observations(
        id,entity_id,kind,payload_json,occurred_at,created_at,sensitivity,valid_from,valid_until,
        source_kind,source_ref,confidence,record_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, item.entity_id, item.kind, validPayload(record.payload), item.occurred_at, timestamp,
          record.sensitivity, null, null, record.source_kind, record.source_ref, null, 1],
      );
      await indexEntity(tx, item.entity_id, timestamp);
    });
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
      await indexEntity(tx, before.entity_id);
      updated = after;
    });
    if (!updated) throw new Error("revision_not_committed");
    return updated;
  }

  /** Explicit user-only proof; existing canonical relation ID. */
  confirmUserRelationProof(request: ConfirmRelationInput) {
    return confirmUserRelationEvidence(this.db,request);
  }
  currentConfirmedRelationProofs(query: {
    sourceId: string;kind?: DirectPersonRelation | "participant_of";limit?: number;
  }) {
    return listCurrentConfirmedRelationProofs(this.db,query);
  }

  /** R2a one user-only review journal; never a model tool. */
  /** R2b1: one reviewed relationship queue; never a confirmed edge. */
  stageRelationCandidate(request:StageRelationReviewInput){
    return stageRelationReviewCandidate(this.db,request);
  }
  relationCandidateInbox(query:{collectionId:string;limit?:number;before?:RelationInboxCursor}){
    return listRelationReviewCandidates(this.db,query);
  }
  /** User-only decisions on pending relation candidates; no agent tool. */
  decideRelationCandidate(request:RelationCandidateExpected&{choice:RelationCandidateReviewChoice}){
    return decideRelationCandidate(this.db,request);
  }
  undoRelationCandidateDecision(request:RelationCandidateExpected&{actionId:string}){
    return undoRelationCandidateDecision(this.db,request);
  }
  relationCandidateHistory(query:{proposalId:string;limit?:number}){
    return relationCandidateDecisionHistory(this.db,query);
  }
  relationReviewHistory(query:{evidenceId:string;limit?:number}){
    return listUserRelationReviewHistory(this.db,query);
  }
  retractRelationWitness(expected: RelationReviewExpected) {
    return retractUserRelationEvidence(this.db,expected);
  }
  undoRelationRetraction(expected: RelationReviewExpected & { actionId:string }) {
    return undoUserRelationRetraction(this.db,expected);
  }
  confirmedRelativeConversationPaths(query: {
    ownerPersonId: string; relationKind: DirectPersonRelation;
  }) {
    return findCurrentRelativeConversationPaths(this.db,query);
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
      const input = await tx.getFirstAsync<Row>("SELECT e.record_version,c.name FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id WHERE e.id=?", [entityId]);
      if (!input) throw new MemoryAccessError("entity_not_found");
      await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source=?", [entityId, source]);
      // A model's empty answer is kept too: it marks the record as done.
      if (words || source.startsWith("model:")) await tx.runAsync(
        "INSERT INTO memory_index_terms(entity_id,terms,source,created_at,source_record_version,source_collection_name) VALUES (?,?,?,?,?,?)",
        [entityId, words, source, now(), Number(input.record_version), String(input.name)]);
      await indexEntity(tx, entityId);
    });
    return words.split(" ").filter(Boolean);
  }

  /** Compare the request snapshot and commit words + inferred links together.
   * The database lease pins the profile. Abort is checked inside the transaction,
   * including after async indexing, so a lock/disable cannot leave half an answer. */
  async applyIndexEnrichment(snapshot: EnrichmentSnapshot, terms: string[], people: string[], signal?: AbortSignal): Promise<boolean> {
    const checkCancelled = () => { if (signal?.aborted) throw new Error("Подбор слов остановлен"); };
    let applied = false;
    await withUnlockedTransaction(this.db, async tx => {
      checkCancelled();
      const entity = await this.entity(snapshot.entityId);
      const collections = await this.listCollections();
      const collection = collections.find(c => c.id === entity?.collection_id);
      if (!entity || !enrichable(entity, collection) || entity.record_version !== snapshot.recordVersion ||
          entity.sensitivity !== snapshot.sensitivity || entity.collection_id !== snapshot.collectionId ||
          collection!.name !== snapshot.collectionName || collection!.slug !== snapshot.collectionSlug) return;
      const source = "model:auto", timestamp = now();
      await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source=?", [entity.id, source]);
      await tx.runAsync(
        "INSERT INTO memory_index_terms(entity_id,terms,source,created_at,source_record_version,source_collection_name) VALUES (?,?,?,?,?,?)",
        [entity.id, checkedTerms(terms), source, timestamp, entity.record_version, collection!.name]);
      // Only replace links we can attribute to this automatic operation. Legacy
      // source_kind=NULL links may be manual and must not be guessed away.
      await tx.runAsync("DELETE FROM memory_relations WHERE source_entity_id=? AND source_kind=?", [entity.id, source]);
      for (const name of [...new Set(people)].slice(0, 8)) {
        checkCancelled();
        const candidates = (await this.entitiesByAlias(name, "person")).filter(p =>
          p.id !== entity.id && enrichable(p, collections.find(c => c.id === p.collection_id)));
        // Never choose an arbitrary namesake or a protected target.
        if (candidates.length !== 1) continue;
        const person = candidates[0];
        const existing = await tx.getFirstAsync<Row>(
          `SELECT id FROM memory_relations WHERE
           (source_entity_id=? AND target_entity_id=?) OR (source_entity_id=? AND target_entity_id=?)`,
          [entity.id, person.id, person.id, entity.id]);
        if (existing) continue;
        await tx.runAsync(
          "INSERT INTO memory_relations(id,source_entity_id,target_entity_id,kind,source_kind,source_ref,created_at) VALUES (?,?,?,?,?,?,?)",
          [uid(), entity.id, person.id, "about", source, String(entity.record_version), timestamp]);
      }
      await indexEntity(tx, entity.id, timestamp);
      checkCancelled();
      applied = true;
    });
    return applied;
  }

  /** All methods remain inside localMemoryRepository's encrypted profile lease. */
  claimVectorJobs(model: string, limit = 4): Promise<ClaimedVectorJob[]> {
    return new DurableVectorJobs(this.db).claim(model, limit);
  }
  completeVectorJobs(model: string, items: CompletedVectorJob[]): Promise<number> {
    return new DurableVectorJobs(this.db).complete(model, items);
  }
  failVectorJobs(model: string, jobs: ClaimedVectorJob[]): Promise<void> {
    return new DurableVectorJobs(this.db).fail(model, jobs);
  }
  releaseVectorJobs(model: string, jobs: ClaimedVectorJob[]): Promise<void> {
    return new DurableVectorJobs(this.db).release(model, jobs);
  }
  nextVectorWakeMs(model: string): Promise<number | null> {
    return new DurableVectorJobs(this.db).nextWakeMs(model);
  }

  /** Chunks whose vector for `model` is missing or older than the text and
   * title, with the text to embed. Every section is included: vectors never
   * leave the phone, and what reaches the model is filtered at search time. */
  async pendingVectorChunks(model: string, limit = 32): Promise<Array<{ chunkId: string; text: string; hash: string }>> {
    const cap = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 32));
    const batchSize = Math.max(64, Math.min(256, cap * 4));
    const out: Array<{ chunkId: string; text: string; hash: string }> = [];
    let cursor: { date: string; id: string; ord: number } | null = null;
    for (;;) {
      // Keyset cursor is stable within the read; avoids quadratic deep OFFSET
      // paging. The durable dirty queue is a later, separate SQLCipher stage.
      const rows: Row[] = await this.db.getAllAsync<Row>(
        `SELECT c.id,c.ord,c.text,e.id AS eid,e.updated_at,e.title,
                v.content_hash AS vhash FROM memory_chunks c
         JOIN memory_entities e ON e.id=c.entity_id
         ${validVectorJoin(model)}
         WHERE e.record_status='active' AND e.domain='notes'
           ${cursor ? "AND (e.updated_at < ? OR (e.updated_at=? AND (e.id > ? OR (e.id=? AND c.ord > ?))))" : ""}
         ORDER BY e.updated_at DESC,e.id,c.ord LIMIT ?`,
        cursor ? [model, cursor.date, cursor.date, cursor.id, cursor.id, cursor.ord, batchSize]
               : [model, batchSize]);
      for (const r of rows) {
        const text = embeddingText(TEXT(r.title), String(r.text));
        if (!text) continue;
        const hash = embeddingHash(TEXT(r.title), String(r.text));
        if (r.vhash !== hash) out.push({ chunkId: String(r.id), text, hash });
        if (out.length >= cap) return out;
      }
      if (rows.length < batchSize) return out;
      const last: Row = rows[rows.length - 1];
      cursor = { date: String(last.updated_at), id: String(last.eid), ord: Number(last.ord) };
    }
  }

  /** Accept results only for the current text/title: edits may race inference. */
  async saveVectors(model: string, items: Array<{ chunkId: string; vector: Float32Array; hash: string }>): Promise<number> {
    let saved = 0;
    await withUnlockedTransaction(this.db, async tx => {
      for (const item of items) {
        const current = await tx.getFirstAsync<Row>(
          "SELECT c.text,e.title,e.record_status FROM memory_chunks c JOIN memory_entities e ON e.id=c.entity_id WHERE c.id=?", [item.chunkId]);
        if (!current || current.record_status !== "active" || item.hash !== embeddingHash(TEXT(current.title), String(current.text))) continue;
        if (!item.vector.length || !item.vector.every(Number.isFinite) ||
            (isCurrentVectorSpace(model) && item.vector.length !== VECTOR_DIM)) continue;
        await tx.runAsync("INSERT OR REPLACE INTO memory_vectors(chunk_id,model,dim,vector,content_hash) VALUES (?,?,?,?,?)",
          [item.chunkId, model, item.vector.length, toBlob(item.vector), item.hash]);
        saved++;
      }
    });
    return saved;
  }

  /** Chunks of active records with a current vector, and all such chunks. */
  async vectorStatus(model: string): Promise<{ done: number; total: number }> {
    let done = 0, total = 0;
    let cursor: { id: string; ord: number } | null = null;
    const pageSize = 256;
    for (;;) {
      const rows: Row[] = await this.db.getAllAsync<Row>(
        `SELECT c.text,c.ord,e.id AS eid,e.title,v.content_hash AS vhash
         FROM memory_chunks c JOIN memory_entities e ON e.id=c.entity_id
         ${validVectorJoin(model)}
         WHERE e.record_status='active' AND e.domain='notes'
           ${cursor ? "AND (e.id > ? OR (e.id=? AND c.ord > ?))" : ""}
         ORDER BY e.id,c.ord LIMIT ?`,
        cursor ? [model, cursor.id, cursor.id, cursor.ord, pageSize] : [model, pageSize]);
      for (const r of rows) {
        if (!embeddingText(TEXT(r.title), String(r.text))) continue;
        total++;
        if (r.vhash === embeddingHash(TEXT(r.title), String(r.text))) done++;
      }
      if (rows.length < pageSize) return { done, total };
      const last: Row = rows[rows.length - 1];
      cursor = { id: String(last.eid), ord: Number(last.ord) };
    }
  }

  /** Records whose chunks are closest in meaning to the question vector, best
   * chunk per record, above MIN_SIMILARITY, within the same filters. */
  async vectorMatches(model: string, query: Float32Array, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number } = {}):
    Promise<Array<{ row: Row; chunkId: string; similarity: number }>> {
    if (!query.length || !query.every(Number.isFinite) ||
        (isCurrentVectorSpace(model) && query.length !== VECTOR_DIM)) return [];
    const filters = ["e.domain='notes'", "e.record_status='active'"];
    const params: SQLite.SQLiteBindValue[] = [model, query.length];
    if (options.collectionIds) {
      if (!options.collectionIds.length) return [];
      filters.push(`e.collection_id IN (${options.collectionIds.map(() => "?").join(",")})`); params.push(...options.collectionIds);
    }
    if (options.sensitivities) { filters.push(`e.sensitivity IN (${options.sensitivities.map(() => "?").join(",")})`); params.push(...options.sensitivities); }
    const rows = await this.db.getAllAsync<Row>(
      `SELECT v.chunk_id, v.vector, v.content_hash, c.entity_id, c.text, e.title FROM memory_vectors v JOIN memory_chunks c ON c.id=v.chunk_id
       JOIN memory_entities e ON e.id=c.entity_id WHERE v.model=? AND v.dim=? AND length(v.vector)=4*v.dim AND ${filters.join(" AND ")}`, params);
    const best = new Map<string, { chunkId: string; similarity: number }>();
    for (const r of rows) {
      if (r.content_hash !== embeddingHash(TEXT(r.title), String(r.text))) continue;
      const vector = fromBlob(r.vector);
      if (!vector || !vector.length || !vector.every(Number.isFinite)) continue;
      const similarity = cosine(query, vector);
      if (similarity < MIN_SIMILARITY) continue;
      const id = String(r.entity_id);
      if ((best.get(id)?.similarity ?? -1) < similarity) best.set(id, { chunkId: String(r.chunk_id), similarity });
    }
    const top = [...best.entries()].sort((a, b) => b[1].similarity - a[1].similarity).slice(0, options.limit ?? 8);
    const out: Array<{ row: Row; chunkId: string; similarity: number }> = [];
    for (const [id, hit] of top) {
      const row = await this.db.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id=?", [id]);
      if (row) out.push({ row, ...hit });
    }
    return out;
  }

  /** How many enrichable records have current index words from `source`, and how many wait. */
  async indexTermsStatus(source: string): Promise<{ done: number; pending: number }> {
    const row = await this.db.getFirstAsync<Row>(
      `SELECT sum(CASE WHEN ${CURRENT_MODEL_TERMS} THEN 1 ELSE 0 END) AS done,
              sum(CASE WHEN ${CURRENT_MODEL_TERMS} THEN 0 ELSE 1 END) AS pending
       FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source=?
       WHERE e.record_status='active' AND e.domain='notes' AND c.sensitivity='standard' AND c.slug<>'documents'
         AND e.sensitivity IN ('standard','inherit')`, [source]);
    return { done: Number(row?.done ?? 0), pending: Number(row?.pending ?? 0) };
  }

  /** Active records of ordinary sections whose index words from `source` are
   * missing or computed for another source version/section, oldest first. */
  async staleIndexTerms(source: string, limit = 20): Promise<string[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT e.id FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source=?
       WHERE e.record_status='active' AND e.domain='notes' AND c.sensitivity='standard' AND c.slug<>'documents'
         AND e.sensitivity IN ('standard','inherit') AND COALESCE(${CURRENT_MODEL_TERMS},0)=0
       ORDER BY e.updated_at, e.id LIMIT ?`, [source, Math.min(200, Math.max(1, Math.trunc(limit)))]);
    return rows.map(r => String(r.id));
  }

  /** `prefix` matches words that start with the query (a word stem without its
   * ending), so «машин» finds «машина», «машину» and «машиной». Results with a
   * query are ranked by relevance (bm25 over title, text, index words and
   * names), then by date. */
  async searchNotes(query: string, limit = 50, offset = 0, filters: { collectionId?: string; status?: "active" | "archived" | "trashed"; prefix?: boolean } = {}): Promise<EntityRecord[]> {
    const count = Math.min(100, Math.max(1, Math.trunc(limit)));
    const start = Math.max(0, Math.trunc(offset));
    const term = query.trim();
    const status = filters.status || "active";
    if (status !== "active" && status !== "archived" && status !== "trashed") throw new Error("invalid_record_status");
    const rows = await this.matches(term, filters.prefix ?? false, {
      status, collectionIds: filters.collectionId ? [filters.collectionId] : undefined, limit: count, offset: start,
    });
    return rows.map(r => entityFrom(r));
  }

  /** One FTS search grouped by record: the best chunk of each record. */
  private async matches(term: string, prefix: boolean | { prefix: boolean; column?: "terms" }, options: {
    status: "active" | "archived" | "trashed"; collectionIds?: string[]; sensitivities?: string[]; limit: number; offset: number;
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
       JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source='model:auto'
       WHERE r.kind='about' AND r.target_entity_id=? AND ${filters.join(" AND ")}
         AND (r.source_kind IS NULL OR r.source_kind<>'model:auto' OR
           (r.source_ref=CAST(e.record_version AS TEXT) AND ${CURRENT_MODEL_TERMS}))
       ORDER BY e.updated_at DESC LIMIT 8`, params);
  }

  /** The assistant's memory search: the whole phrase, each word, each stem and
   * names, every search over title, text, index words and names. A record
   * found by more of them ranks higher. Each hit carries its best chunk.
   * Only the given sections and sensitivities are searched. */
  async searchMemory(query: string, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number;
    /** The question's vector from the on-device model (п. 13), if it is downloaded. */
    vector?: { model: string; values: Float32Array };
    /** Stable owner ID and exact confirmed role, never a name heuristic. */
    verifiedRelative?: { ownerPersonId: string; relationKind: DirectPersonRelation };
  } = {}): Promise<MemoryHit[]> {
    const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 5)));
    const verifiedRelative=options.verifiedRelative;
    if (verifiedRelative) {
      // The relation evidence, all source/endpoint ACL checks and the final
      // conversation row/chunk must share ONE SQLCipher snapshot. Otherwise a
      // concurrent source edit or privacy change could invalidate a proof
      // after graph traversal but before returning the old result.
      let verifiedHits:MemoryHit[]=[];
      await withUnlockedTransaction(this.db,async tx=>{
      // One search entrypoint; the graph projection already validates all
      // evidence/endpoint current versions, ACL and user confirmations.
      // This is a STRICT proven-relation filter, not a loose name fallback.
      const paths = await findCurrentRelativeConversationPaths(tx,verifiedRelative);
      const hits: MemoryHit[] = [];
      for (const proof of paths.paths) {
        if (hits.length >= limit) break;
        const values: SQLite.SQLiteBindValue[] = [proof.conversationId];
        let scope = "";
        if (options.collectionIds) {
          if (!options.collectionIds.length) return;
          scope += " AND e.collection_id IN (" + options.collectionIds.map(() => "?").join(",") + ")";
          values.push(...options.collectionIds);
        }
        if (options.sensitivities) {
          if (!options.sensitivities.length) return;
          scope += " AND e.sensitivity IN (" + options.sensitivities.map(() => "?").join(",") + ")";
          values.push(...options.sensitivities);
        }
        const row = await tx.getFirstAsync<Row>(
          "SELECT e.* FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id " +
          "WHERE e.id=? AND e.record_status='active' AND e.kind='note' " +
          "AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'" + scope,
          values,
        );
        if (!row) continue;
        const chunk = await tx.getFirstAsync<Row>(
          "SELECT text FROM memory_chunks WHERE entity_id=? ORDER BY ord LIMIT 1",
          [proof.conversationId],
        );
        // Local original locators belong to the SAME SQLCipher snapshot as
        // the confirmed relation, participant witness and readable note.
        // No guessed ASR timestamps, filenames posing as proof or decrypted
        // bytes; actual file opening must reauthorize in the media UI.
        const originals=await tx.getAllAsync<{
          id:string;name:string;mime:string;size:number;
        }>(
          "SELECT a.id,a.name,a.mime,a.size FROM memory_attachments a "+
          "WHERE a.entity_id=? AND "+
          "(SELECT count(*) FROM memory_attachment_parts p WHERE p.attachment_id=a.id)>0 AND "+
          "(SELECT min(p.ord) FROM memory_attachment_parts p WHERE p.attachment_id=a.id)=0 AND "+
          "(SELECT max(p.ord)+1 FROM memory_attachment_parts p WHERE p.attachment_id=a.id)="+
          "(SELECT count(*) FROM memory_attachment_parts p WHERE p.attachment_id=a.id) AND "+
          "a.size=(SELECT sum(length(p.bytes)) FROM memory_attachment_parts p WHERE p.attachment_id=a.id) "+
          "ORDER BY a.created_at,a.id LIMIT 10",
          [proof.conversationId],
        );
        const locators=originals.map(item=>({
          attachmentId:item.id,recordId:proof.conversationId,
          recordVersion:Number(row.record_version),name:item.name,mime:item.mime,size:item.size,
          kind:(item.mime.startsWith("audio/")?"audio":
            item.mime.startsWith("video/")?"video":
            item.mime==="application/pdf"?"document":
            item.mime.startsWith("image/")?"image":"other") as
              "audio"|"video"|"document"|"image"|"other",
          metadataOnly:true as const,originalTime:null,originalPage:null,
        }));
        hits.push({entity:entityFrom(row),chunk:TEXT(chunk?.text) ?? "",score:100,
          originals:locators,
          proof:{relativeId:proof.relativeId,
            relationEvidenceId:proof.relationEvidenceId,
            participantEvidenceId:proof.participantEvidenceId,
            truncated:paths.truncated || paths.paths.length>limit},
        });
      }
      verifiedHits=hits;
      });
      return verifiedHits;
    }
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
    let top = [...scored.values()].sort((a, b) => b.score - a.score || a.order - b.order);
    // Meaning (п. 13): the closest chunks join through rank fusion. Without the
    // model, or when nothing is close enough, the word search stands as it is.
    if (options.vector) {
      const near = await this.vectorMatches(options.vector.model, options.vector.values, { ...options, limit: 8 });
      if (near.length) {
        for (const n of near) {
          const id = String(n.row.id);
          const found = scored.get(id) || { row: n.row, score: 0, order: scored.size, chunk: null, weight: 0 };
          if (!found.chunk) found.chunk = n.chunkId;
          scored.set(id, found);
        }
        const fused = fuseRanks([top.map(t => String(t.row.id)), near.map(n => String(n.row.id))]);
        top = [...scored.values()].sort((a, b) => (fused.get(String(b.row.id)) || 0) - (fused.get(String(a.row.id)) || 0) || a.order - b.order);
      }
    }
    const required = requiredSearchEvidence(query);
    if (required.length) {
      const verified: typeof top = [];
      // Do not infer a negative statement or an exact year from a positive
      // keyword/embedding hit. The original encrypted FTS is the evidence.
      for (const candidate of top) {
        let complete = true;
        for (const phrase of required) {
          const witness = await this.db.getFirstAsync<Row>(
            "SELECT 1 AS ok FROM memory_search_fts WHERE memory_search_fts MATCH ? AND entity_id=? LIMIT 1",
            [ftsPhrase(phrase), String(candidate.row.id)],
          );
          if (!witness) { complete = false; break; }
        }
        if (complete) verified.push(candidate);
        if (verified.length >= limit) break;
      }
      top = verified;
    }
    top = top.slice(0, limit);
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
