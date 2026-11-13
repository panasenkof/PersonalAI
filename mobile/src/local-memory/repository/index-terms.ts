/** ARCH-6c: authoritative index-term operations moved from the SQLCipher facade.
 * The existing transaction writer and its cancellation/CAS guards remain intact.
 * Readers are injected by the facade to avoid a second entity/collection reader.
 */
import { indexEntity } from "../search-index";
import { noteTagsFromPayload, checkedNoteTags } from "../note-tags";
import { enrichable, CURRENT_MODEL_TERMS, AUTO_SEARCH_VERSION, type EnrichmentSnapshot, type SearchMetadataSuggestion } from "../enrichment-policy";
import { MemoryAccessError, MemoryConflictError, type CollectionRecord, type EntityRecord } from "../types";
import type { MemoryKind } from "../search-index";
import { withUnlockedTransaction } from "../transaction";
import { validPayload } from "./record-core";
import { now, uid, type SQL, type Row } from "./shared";

export type IndexEnrichmentReads = {
  lookupEntity: (id:string)=>Promise<EntityRecord|null>;
  listCollections: ()=>Promise<CollectionRecord[]>;
  entitiesByAlias:(name:string,kind?:MemoryKind)=>Promise<EntityRecord[]>;
};

/** Index words: each 2–40 letters, up to 40 of them, from the user or a model. */
export function checkedTerms(terms: string[]): string {
  const words = [...new Set(terms.flatMap(t => String(t).toLowerCase().split(/[^\p{L}\p{N}-]+/u))
    .filter(w => w.length >= 2 && w.length <= 40))].slice(0, 40);
  return words.join(" ");
}
/** One source-specific terms writer for both card metadata and standalone edits.
 * Never replace model enrichment while changing the user's own search words. */
export async function replaceIndexTerms(tx: SQL, entityId: string, words: string, source: string, timestamp: string): Promise<void> {
  const current = await tx.getFirstAsync<Row>(
    "SELECT e.record_version,c.name FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id WHERE e.id=?", [entityId]);
  if (!current) throw new MemoryAccessError("entity_not_found");
  await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source=?", [entityId, source]);
  // An empty model response is also durable proof that enrichment ran.
  if (words || source.startsWith("model:")) await tx.runAsync(
    "INSERT INTO memory_index_terms(entity_id,terms,source,created_at,source_record_version,source_collection_name) VALUES (?,?,?,?,?,?)",
    [entityId, words, source, timestamp, Number(current.record_version), String(current.name)]);
}
  /** Index words by source: `user` or `model:<name>`. */
export async function indexTerms(db:SQL, entityId: string): Promise<Array<{ source: string; terms: string[] }>> {
    const rows = await db.getAllAsync<Row>("SELECT source, terms FROM memory_index_terms WHERE entity_id=? ORDER BY source", [entityId]);
    return rows.map(r => ({ source: String(r.source), terms: String(r.terms).split(" ").filter(Boolean) }));
  }

  /** Replaces the index words from one source; an empty list removes them. */
export async function setIndexTerms(db:SQL, entityId: string, terms: string[], source: string): Promise<string[]> {
    if (!/^(user|model:[a-z0-9._-]{1,60})$/i.test(source)) throw new Error("invalid_index_terms_source");
    const words = checkedTerms(terms);
    await withUnlockedTransaction(db, async tx => {
      await replaceIndexTerms(tx, entityId, words, source, now());
      await indexEntity(tx, entityId);
    });
    return words.split(" ").filter(Boolean);
  }

  /** Compare the request snapshot and commit words + inferred links together.
   * The database lease pins the profile. Abort is checked inside the transaction,
   * including after async indexing, so a lock/disable cannot leave half an answer. */
export async function applyIndexEnrichment(db:SQL, snapshot: EnrichmentSnapshot, terms: string[], people: string[], signal?: AbortSignal, metadata?: SearchMetadataSuggestion, reads: IndexEnrichmentReads): Promise<boolean> {
    const { lookupEntity, listCollections, entitiesByAlias } = reads;
    const checkCancelled = () => { if (signal?.aborted) throw new Error("Подбор слов остановлен"); };
    let applied = false;
    await withUnlockedTransaction(db, async tx => {
      checkCancelled();
      const entity = await lookupEntity(snapshot.entityId);
      const collections = await listCollections();
      const collection = collections.find(c => c.id === entity?.collection_id);
      if (!entity || !enrichable(entity, collection) || entity.record_version !== snapshot.recordVersion ||
          entity.sensitivity !== snapshot.sensitivity || entity.collection_id !== snapshot.collectionId ||
          collection!.name !== snapshot.collectionName || collection!.slug !== snapshot.collectionSlug) return;
      const source = "model:auto", timestamp = now();
      let storedVersion=entity.record_version;
      if (metadata) {
        // User-entered tags are authoritative; remove only this model's former
        // contribution when replacing its own stale inference.
        const previous=entity.payload.model_search as Record<string,unknown>|undefined;
        const oldAuto=noteTagsFromPayload(previous?.tags);
        const userTags=noteTagsFromPayload(entity.payload.tags).filter(tag=>!oldAuto.includes(tag));
        const manuallyOverridden=previous?.tagOverride===true;
        const inferred=checkedNoteTags(metadata.tags).slice(0,5);
        const tags=manuallyOverridden?noteTagsFromPayload(entity.payload.tags):
          [...new Set([...userTags,...inferred])].slice(0,12).sort();
        const nextHints={
          schema:AUTO_SEARCH_VERSION,origin:"model:auto",tags:manuallyOverridden?[]:inferred,
          tagOverride:manuallyOverridden,
          topic:metadata.topic,summary:metadata.summary,
          titleHint:metadata.titleHint,places:metadata.places,dates:metadata.dates,
          people:metadata.people,
        };
        const payload={...entity.payload,tags,model_search:nextHints};
        const changed=await tx.runAsync(
          "UPDATE memory_entities SET payload_json=?,updated_at=?,record_version=record_version+1 WHERE id=? AND record_version=?",
          [validPayload(payload),timestamp,entity.id,entity.record_version]);
        if(changed.changes!==1)throw new MemoryConflictError("stale_memory_version");
        storedVersion++;
        const after={...entity,payload,record_version:storedVersion,updated_at:timestamp};
        await tx.runAsync(
          "INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,reason,actor_kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [uid(),"entity",entity.id,null,storedVersion,"Поисковые подсказки ИИ","model",
            JSON.stringify(entity),JSON.stringify(after),timestamp]);
      }
      await tx.runAsync("DELETE FROM memory_index_terms WHERE entity_id=? AND source=?", [entity.id, source]);
      await tx.runAsync(
        "INSERT INTO memory_index_terms(entity_id,terms,source,created_at,source_record_version,source_collection_name) VALUES (?,?,?,?,?,?)",
        [entity.id, checkedTerms(terms), source, timestamp, storedVersion, collection!.name]);
      // Only replace links we can attribute to this automatic operation. Legacy
      // source_kind=NULL links may be manual and must not be guessed away.
      await tx.runAsync("DELETE FROM memory_relations WHERE source_entity_id=? AND source_kind=?", [entity.id, source]);
      for (const name of [...new Set(people)].slice(0, 8)) {
        checkCancelled();
        const candidates = (await entitiesByAlias(name, "person")).filter(p =>
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
          [uid(), entity.id, person.id, "about", source, String(storedVersion), timestamp]);
      }
      await indexEntity(tx, entity.id, timestamp);
      checkCancelled();
      applied = true;
    });
    return applied;
  }

  /** How many enrichable records have current index words from `source`, and how many wait. */
export async function indexTermsStatus(db:SQL, source: string): Promise<{ done: number; pending: number }> {
    const freshness = source === "model:auto" ?
      "(" + CURRENT_MODEL_TERMS + " AND COALESCE(json_extract(e.payload_json,'$.model_search.schema'),0)=" + AUTO_SEARCH_VERSION + ")" :
      CURRENT_MODEL_TERMS;
    const row = await db.getFirstAsync<Row>(
      `SELECT sum(CASE WHEN ${freshness} THEN 1 ELSE 0 END) AS done,
              sum(CASE WHEN ${freshness} THEN 0 ELSE 1 END) AS pending
       FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source=?
       WHERE e.record_status='active' AND e.domain='notes' AND c.sensitivity='standard' AND c.slug<>'documents'
         AND e.sensitivity IN ('standard','inherit') AND COALESCE(json_extract(e.payload_json,'$.index_enrichment_opt_out'),0)=0`, [source]);
    return { done: Number(row?.done ?? 0), pending: Number(row?.pending ?? 0) };
  }

  /** Active records of ordinary sections whose index words from `source` are
   * missing or computed for another source version/section, oldest first. */
export async function staleIndexTerms(db:SQL, source: string, limit = 20): Promise<string[]> {
    const freshness = source === "model:auto" ?
      "(" + CURRENT_MODEL_TERMS + " AND COALESCE(json_extract(e.payload_json,'$.model_search.schema'),0)=" + AUTO_SEARCH_VERSION + ")" :
      CURRENT_MODEL_TERMS;
    const rows = await db.getAllAsync<Row>(
      `SELECT e.id FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
       LEFT JOIN memory_index_terms t ON t.entity_id=e.id AND t.source=?
       WHERE e.record_status='active' AND e.domain='notes' AND c.sensitivity='standard' AND c.slug<>'documents'
         AND e.sensitivity IN ('standard','inherit') AND COALESCE(json_extract(e.payload_json,'$.index_enrichment_opt_out'),0)=0 AND COALESCE(${freshness},0)=0
       ORDER BY e.updated_at, e.id LIMIT ?`, [source, Math.min(200, Math.max(1, Math.trunc(limit)))]);
    return rows.map(r => String(r.id));
  }

