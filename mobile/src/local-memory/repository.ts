import { changeNotes, undoNotes, purgeNotes, type NoteAction, type NoteSelection, type NoteHygieneGuard } from "./note-actions";
import { readTrashPurgeSnapshot } from "./trash-clear";
import { MemoryHygieneService } from "./hygiene";
import { chooseProfileSelfIdentity, readProfileSelfIdentity } from "./self-identity";
import type { ChooseProfileSelfIdentity } from "./self-identity";
import { DurableVectorJobs, markEntityVectorsDirty, type ClaimedVectorJob, type CompletedVectorJob } from "./vector-jobs";
import type * as SQLite from "expo-sqlite";

import { openLocalMemory, withLocalMemoryDatabase } from "./storage";
import { withUnlockedTransaction } from "./transaction";
import { temporalCandidatesAtDate, trashNoteCount, lastNoteOperation } from "./repository/misc";
import { collectionNoteCounts, listCollections, createCollection, moveCollection, deleteEmptyCollection } from "./repository/collections";
import { clone, safeReason, kindAllowed, validPayload } from "./repository/record-core";
import { checkedTerms, replaceIndexTerms, indexTerms, setIndexTerms, applyIndexEnrichment, indexTermsStatus, staleIndexTerms } from "./repository/index-terms";
import { pendingVectorChunks, saveVectors, vectorStatus, vectorMatches, saveImageVector } from "./repository/vectors";
import { entityFrom, entity, entities, createEntity, reviseEntity, setEntityStatus, revisions, setEntityKind, aliases, setAliases, entitiesByAlias, type NoteCardFields } from "./repository/entities";
import { listNoteTags, searchNotes, matches, linkedFacts, searchMemory } from "./repository/search";
export type { NoteCardFields } from "./repository/entities";
import { observation, observations, createObservation, reviseObservation, linkEntities, relationsForEntity } from "./repository/observations";
import { stageTemporalCandidateWithReview, listTemporalKnowledgeHistory } from "./temporal-store";
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
import { parseNoteTagsInput, noteTagsFromPayload, checkedNoteTags } from "./note-tags";
import type { MemoryKind } from "./search-index";
import { ftsPhrase, requiredSearchEvidence, searchSteps } from "./query";
import { MIN_SIMILARITY, VECTOR_DIM, cosine, embeddingHash, embeddingText, fromBlob, fuseRanks, isCurrentVectorSpace, toBlob } from "./vectors";
import { type ImageVectorHit, attachmentImageMatches, saveAttachmentImageVector } from "./attachment-vectors";
import type {
  CollectionRecord, EntityRecord, MemoryHit, MemoryPage, MemoryRepository, NewEntity, NewObservation,
  ObservationRecord, RelationRecord, RevisionRecord, RecordSensitivity,
} from "./types";
import { MemoryAccessError, MemoryConflictError } from "./types";
import { CURRENT_MODEL_TERMS, AUTO_SEARCH_VERSION, enrichable, type EnrichmentSnapshot, type SearchMetadataSuggestion } from "./enrichment-policy";

import { now, uid, TEXT, type SQL, type Row } from "./repository/shared";
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
  /** Temporal source, evidence and later user decisions must be read in ONE
   * unlocked SQLCipher snapshot. No ACL/source revision or undo may change
   * between the candidate page and the projected known-at state. */
  temporalCandidatesAtDate(query: TemporalAtDateQuery) { return temporalCandidatesAtDate(this.db, query); }
  /** History is explicitly labeled candidate/unconfirmed, not "current". */
  temporalKnowledgeHistory(query: TemporalHistoryQuery) {
    return listTemporalKnowledgeHistory(this.db, query);
  }

  /** R3c1: the only profile-owner pointer, explicitly chosen by the user. */
  profileSelfIdentity() { return readProfileSelfIdentity(this.db); }
  chooseProfileSelfIdentity(choice:ChooseProfileSelfIdentity) { return chooseProfileSelfIdentity(this.db,choice); }

  /** M1/№79а: read-only review and persistent user exceptions; no automatic deletes. */
  hygiene() { return new MemoryHygieneService(this.db); }
  changeNotes(action: NoteAction, selection: NoteSelection[], collectionId?: string, hygiene?: NoteHygieneGuard) { return changeNotes(this.db, action, selection, collectionId, hygiene); }
  purgeNotes(selection: NoteSelection[], options?: { protectReferences?: boolean }) { return purgeNotes(this.db, selection, options); }
  /** All trashed note identities/versions, from one unlocked SQLCipher snapshot. */
  trashPurgeSnapshot() { return readTrashPurgeSnapshot(this.db); }
  /** The toolbar count is independent of the currently loaded 50-note page. */
  trashNoteCount(): Promise<number> { return trashNoteCount(this.db); }
  lastNoteOperation(): Promise<string> { return lastNoteOperation(this.db); }
    undoNotes(batch: string) { return undoNotes(this.db, batch); }


  collectionNoteCounts(): Promise<Record<string, number>> { return collectionNoteCounts(this.db); }
  listCollections(): Promise<CollectionRecord[]> { return listCollections(this.db); }
  createCollection(item: { name: string; slug: string; sensitivity?: CollectionRecord["sensitivity"]; parentId?: string | null }): Promise<CollectionRecord> {
    return createCollection(this.db, item);
  }
  moveCollection(id: string, parentId: string | null): Promise<void> { return moveCollection(this.db, id, parentId); }
  /** Revalidate deletion in one existing SQLCipher transaction; never cascade. */
  deleteEmptyCollection(id: string, expectedCreatedAt: string, expectedParentId: string | null): Promise<void> {
    return deleteEmptyCollection(this.db, id, expectedCreatedAt, expectedParentId);
  }

  entity(id: string): Promise<EntityRecord|null> { return entity(this.db,id); }
  entities(options: { collection_id?: string; domain?: string; kind?: MemoryKind; limit?: number; offset?: number } = {}): Promise<MemoryPage<EntityRecord>> {
    return entities(this.db,options);
  }
  createEntity(item: NewEntity, writeAttachment?: (tx: SQL, entityId: string) => Promise<void>, cardFields?: NoteCardFields): Promise<EntityRecord> {
    return createEntity(this.db,item,writeAttachment,cardFields);
  }
  reviseEntity(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string, collectionId?: string, allowAgent = false, writeAttachment?: (tx: SQL, entityId: string) => Promise<void>, cardFields?: NoteCardFields): Promise<EntityRecord> {
    return reviseEntity(this.db,id,expectedVersion,payload,reason,collectionId,allowAgent,writeAttachment,cardFields);
  }
  setEntityStatus(id: string, expectedVersion: number, status: "active"|"archived"): Promise<EntityRecord> {
    return setEntityStatus(this.db,id,expectedVersion,status);
  }

  observation(id: string): Promise<ObservationRecord | null> { return observation(this.db, id); }
  observations(entityId: string): Promise<ObservationRecord[]> { return observations(this.db, entityId, key => this.entity(key)); }
  createObservation(item: NewObservation): Promise<ObservationRecord> { return createObservation(this.db, item, id => this.entity(id)); }
  reviseObservation(id: string, expectedVersion: number, payload: Record<string, unknown>, reason: string): Promise<ObservationRecord> {
    return reviseObservation(this.db, id, expectedVersion, payload, reason);
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
  linkEntities(sourceId: string, targetId: string, kind: string): Promise<RelationRecord> {
    return linkEntities(this.db, sourceId, targetId, kind, id => this.entity(id));
  }
  relationsForEntity(id: string): Promise<RelationRecord[]> { return relationsForEntity(this.db, id, key => this.entity(key)); }

  revisions(type: "entity"|"observation", id: string): Promise<RevisionRecord[]> { return revisions(this.db,type,id); }
  setEntityKind(id: string, expectedVersion: number, kind: MemoryKind): Promise<EntityRecord> {
    return setEntityKind(this.db,id,expectedVersion,kind);
  }
  aliases(entityId: string): Promise<string[]> { return aliases(this.db,entityId); }
  setAliases(entityId: string, names: string[]): Promise<string[]> { return setAliases(this.db,entityId,names); }
  entitiesByAlias(name: string,kind?: MemoryKind): Promise<EntityRecord[]> { return entitiesByAlias(this.db,name,kind); }

  /** Index words by source: `user` or `model:<name>`. */
  indexTerms(entityId: string): Promise<Array<{ source: string; terms: string[] }>> {
    return indexTerms(this.db,entityId);
  }
  /** One unchanged SQLCipher transaction per source-specific update. */
  setIndexTerms(entityId: string,terms: string[],source: string): Promise<string[]> {
    return setIndexTerms(this.db,entityId,terms,source);
  }
  /** One unchanged unlocked transaction for model index, hints and links. */
  applyIndexEnrichment(snapshot: EnrichmentSnapshot, terms: string[], people: string[], signal?: AbortSignal, metadata?: SearchMetadataSuggestion): Promise<boolean> {
    return applyIndexEnrichment(this.db,snapshot,terms,people,{
      lookupEntity: id=>this.entity(id),
      listCollections:()=>this.listCollections(),
      entitiesByAlias:(name,kind)=>this.entitiesByAlias(name,kind),
    },signal,metadata);
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

  pendingVectorChunks(model: string, limit = 32): Promise<Array<{ chunkId: string; text: string; hash: string }>> { return pendingVectorChunks(this.db,model,limit); }

  saveVectors(model: string, items: Array<{ chunkId: string; vector: Float32Array; hash: string }>): Promise<number> { return saveVectors(this.db,model,items); }

  vectorStatus(model: string): Promise<{ done: number; total: number }> { return vectorStatus(this.db,model); }

  vectorMatches(model: string, query: Float32Array, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number } = {}): Promise<Array<{ row: Row; chunkId: string; similarity: number }>> { return vectorMatches(this.db,model,query,options); }

  indexTermsStatus(source: string): Promise<{ done: number; pending: number }> {
    return indexTermsStatus(this.db,source);
  }
  staleIndexTerms(source: string,limit=20): Promise<string[]> {
    return staleIndexTerms(this.db,source,limit);
  }

  listNoteTags(filters: { collectionId?: string; status?: "active" | "archived" | "trashed" } = {}, limit = 50, offset = 0): Promise<string[]> {
    return listNoteTags(this.db,filters,limit,offset);
  }
  searchNotes(query: string,limit=50,offset=0,filters:{collectionId?:string;status?:"active"|"archived"|"trashed";prefix?:boolean;tag?:string}={}): Promise<EntityRecord[]> {
    return searchNotes(this.db,query,limit,offset,filters);
  }
  private matches(term:string,prefix:boolean|{prefix:boolean;column?:"terms"},options:{
    status:"active"|"archived"|"trashed";collectionIds?:string[];sensitivities?:string[];tag?:string;limit:number;offset:number;
  }):Promise<Row[]> { return matches(this.db,term,prefix,options); }
  private linkedFacts(personId:string,options:{collectionIds?:string[];sensitivities?:string[]}):Promise<Row[]> {
    return linkedFacts(this.db,personId,options);
  }

  saveImageVector(attachmentId: string, model: string, values: Float32Array, sourceVersion: string): Promise<boolean> { return saveImageVector(this.db,attachmentId,model,values,sourceVersion); }


  searchMemory(query: string, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number;
    /** The question's vector from the on-device model (п. 13), if it is downloaded. */
    vector?: { model: string; values: Float32Array };
    /** EmbeddingGemma visual vector; same search entrypoint, separate checked embedding space. */
    imageVector?: { model: string; values: Float32Array };
    /** Optional provisional calibrated floor for visual candidates only. */
    minImageSimilarity?: number;
    /** Stable owner ID and exact confirmed role, never a name heuristic. */
    verifiedRelative?: { ownerPersonId: string; relationKind: DirectPersonRelation };
  } = {}): Promise<MemoryHit[]> {
    return searchMemory(this.db,query,options);
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
