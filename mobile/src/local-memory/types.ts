/** Device-local mirror of the server MemoryRepository contract.
 * No network/account/session dependency and no automatic sync or export. */
export type MemorySensitivity = "unclassified" | "standard" | "sensitive" | "secret";
export type RecordSensitivity = "inherit" | "standard" | "sensitive" | "secret";
export type RecordStatus = "active" | "archived" | "superseded";

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
};
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
  entities(options?: { collection_id?: string; domain?: string; limit?: number; offset?: number }): Promise<MemoryPage<EntityRecord>>;
  createEntity(item: NewEntity): Promise<EntityRecord>;
  reviseEntity(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<EntityRecord>;
  observation(id: string): Promise<ObservationRecord | null>;
  observations(entityId: string): Promise<ObservationRecord[]>;
  createObservation(item: NewObservation): Promise<ObservationRecord>;
  reviseObservation(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<ObservationRecord>;
  linkEntities(sourceId: string, targetId: string, kind: string): Promise<RelationRecord>;
  relationsForEntity(id: string): Promise<RelationRecord[]>;
  revisions(type: "entity" | "observation", id: string): Promise<RevisionRecord[]>;
  searchNotes(query: string, limit?: number, offset?: number): Promise<EntityRecord[]>;
}
export class MemoryConflictError extends Error {}
export class MemoryAccessError extends Error {}
