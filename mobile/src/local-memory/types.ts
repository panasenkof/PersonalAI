import type { MemoryKind } from "./search-index";
import type { EnrichmentSnapshot } from "./enrichment-policy";
import type { TemporalClaimCandidate } from "./temporal-claims";
import type { TemporalHistoryQuery, TemporalHistoryPage, TemporalStagedReview, TemporalAtDateQuery, TemporalAtDatePage } from "./temporal-store";
import type { ConfirmRelationInput, ConfirmRelationResult } from "./relation-evidence";
import type { DirectPersonRelation, RelationProof, RelativeConversationResult } from "./relational-proof";
import type { TemporalInboxQuery, TemporalInboxPage } from "./temporal-review-inbox";
import type { TemporalDecisionRequest, TemporalDecisionExpected, TemporalDecisionResult } from "./temporal-decisions";
export type { MemoryKind } from "./search-index";

/** Device-local mirror of the server MemoryRepository contract.
 * No network/account/session dependency and no automatic sync or export. */
export type MemorySensitivity = "unclassified" | "standard" | "sensitive" | "secret";
export type RecordSensitivity = "inherit" | "standard" | "sensitive" | "secret";
export type RecordStatus = "active" | "archived" | "superseded" | "trashed";

export type CollectionRecord = {
  id: string; name: string; slug: string; description: string | null;
  sensitivity: MemorySensitivity; created_at: string;
};
export type EntityRecord = {
  id: string; collection_id: string; domain: string; schema_version: string;
  payload: Record<string, unknown>; title: string | null; record_status: RecordStatus;
  sensitivity: RecordSensitivity; source_kind: string | null; source_ref: string | null;
  valid_from: string | null; valid_until: string | null;
  created_at: string; updated_at: string; record_version: number;
  /** fact, person, event, preference, document or note. */
  kind: MemoryKind;
};
/** A search result: the record and its chunk that matched best. */
export type MemoryHit = { entity: EntityRecord; chunk: string; score: number };
export type ObservationRecord = {
  id: string; entity_id: string; kind: string; payload: Record<string, unknown>;
  occurred_at: string; created_at: string; sensitivity: RecordSensitivity;
  valid_from: string | null; valid_until: string | null;
  source_kind: string | null; source_ref: string | null; confidence: number | null;
  record_version: number;
};
export type RelationRecord = {
  id: string; source_entity_id: string; target_entity_id: string; kind: string;
  source_kind: string | null; source_ref: string | null; created_at: string;
};
export type RevisionRecord = {
  id: string; record_type: "entity" | "observation"; record_id: string;
  version: number; reason: string; actor_kind: string;
  before_state: Record<string, unknown>; after_state: Record<string, unknown>;
  created_at: string;
};
export type MemoryPage<T> = { items: T[]; next_offset: number | null };
export type NewEntity = {
  collection_id: string; domain: string; payload: Record<string, unknown>;
  schema_version?: string; title?: string | null; sensitivity?: RecordSensitivity;
  source_kind?: string | null; source_ref?: string | null;
  /** Default: from the section («Люди» → person, «Важные даты» → event…). */
  kind?: MemoryKind;
  /** When the fact starts to hold, e.g. the date of an event (ISO). */
  valid_from?: string | null;
};
export type NewObservation = {
  entity_id: string; kind: string; payload: Record<string, unknown>;
  occurred_at: string; sensitivity?: RecordSensitivity;
  source_kind?: string | null; source_ref?: string | null;
};
export interface MemoryRepository {
  listCollections(): Promise<CollectionRecord[]>;
  createCollection(item: { name: string; slug: string; sensitivity?: MemorySensitivity }): Promise<CollectionRecord>;
  entity(id: string): Promise<EntityRecord | null>;
  entities(options?: { collection_id?: string; domain?: string; kind?: MemoryKind; limit?: number; offset?: number }): Promise<MemoryPage<EntityRecord>>;
  createEntity(item: NewEntity): Promise<EntityRecord>;
  reviseEntity(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string, collectionId?: string): Promise<EntityRecord>;
  setEntityStatus(id: string, expectedVersion: number, status: "active" | "archived"): Promise<EntityRecord>;
  observation(id: string): Promise<ObservationRecord | null>;
  observations(entityId: string): Promise<ObservationRecord[]>;
  createObservation(item: NewObservation): Promise<ObservationRecord>;
  reviseObservation(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<ObservationRecord>;
  /** User-facing typed memory workflow, never a blind LLM approval path. */
  stageTypedTemporalFact(candidate: TemporalClaimCandidate): Promise<TemporalStagedReview>;
  temporalReviewInbox(query: TemporalInboxQuery): Promise<TemporalInboxPage>;
  decideTemporalChange(request: TemporalDecisionRequest): Promise<TemporalDecisionResult>;
  undoTemporalChange(request: TemporalDecisionExpected & { decisionId: string }): Promise<TemporalDecisionResult>;
  temporalKnowledgeHistory(query: TemporalHistoryQuery): Promise<TemporalHistoryPage>;
  temporalCandidatesAtDate(query: TemporalAtDateQuery): Promise<TemporalAtDatePage>;
  confirmUserRelationProof(request: ConfirmRelationInput): Promise<ConfirmRelationResult>;
  currentConfirmedRelationProofs(query: {
    sourceId: string; kind?: DirectPersonRelation | "participant_of"; limit?: number;
  }): Promise<{items: RelationProof[];partial: boolean}>;
  confirmedRelativeConversationPaths(query: {
    ownerPersonId: string; relationKind: DirectPersonRelation;
  }): Promise<RelativeConversationResult>;
  linkEntities(sourceId: string, targetId: string, kind: string): Promise<RelationRecord>;
  relationsForEntity(id: string): Promise<RelationRecord[]>;
  revisions(type: "entity" | "observation", id: string): Promise<RevisionRecord[]>;
  setEntityKind(id: string, expectedVersion: number, kind: MemoryKind): Promise<EntityRecord>;
  aliases(entityId: string): Promise<string[]>;
  setAliases(entityId: string, aliases: string[]): Promise<string[]>;
  entitiesByAlias(name: string, kind?: MemoryKind): Promise<EntityRecord[]>;
  indexTerms(entityId: string): Promise<Array<{ source: string; terms: string[] }>>;
  setIndexTerms(entityId: string, terms: string[], source: string): Promise<string[]>;
  applyIndexEnrichment(snapshot: EnrichmentSnapshot, terms: string[], people: string[], signal?: AbortSignal): Promise<boolean>;
  staleIndexTerms(source: string, limit?: number): Promise<string[]>;
  indexTermsStatus(source: string): Promise<{ done: number; pending: number }>;
  searchMemory(query: string, options?: { collectionIds?: string[]; sensitivities?: string[]; limit?: number; vector?: { model: string; values: Float32Array } }): Promise<MemoryHit[]>;
  pendingVectorChunks(model: string, limit?: number): Promise<Array<{ chunkId: string; text: string; hash: string }>>;
  saveVectors(model: string, items: Array<{ chunkId: string; vector: Float32Array; hash: string }>): Promise<number>;
  vectorStatus(model: string): Promise<{ done: number; total: number }>;
  searchNotes(query: string, limit?: number, offset?: number, filters?: { collectionId?: string; status?: "active" | "archived"; prefix?: boolean }): Promise<EntityRecord[]>;
}
export class MemoryConflictError extends Error {}
export class MemoryAccessError extends Error {}
