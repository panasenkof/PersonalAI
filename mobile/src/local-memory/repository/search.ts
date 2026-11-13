/** ARCH-6c: canonical memory search on the SAME SQLCipher connection.
 * Retains every scope/ACL filter, exact evidence check, ranking formula,
 * verified relationship/attachment transaction and vector fusion.
 * No separate search engine, cache, index or import route.
 */
import type * as SQLite from "expo-sqlite";
import type { DirectPersonRelation } from "../relational-proof";
import { withUnlockedTransaction } from "../transaction";
import { findCurrentRelativeConversationPaths } from "../relation-evidence";
import { type ImageVectorHit, attachmentImageMatches } from "../attachment-vectors";
import { CURRENT_MODEL_TERMS } from "../enrichment-policy";
import { parseNoteTagsInput } from "../note-tags";
import { ftsPhrase, searchSteps, requiredSearchEvidence } from "../query";
import { fuseRanks } from "../vectors";
import { entityFrom } from "./entities";
import { vectorMatches } from "./vectors";
import type { EntityRecord, MemoryHit } from "../types";
import { TEXT, type SQL, type Row } from "./shared";

// bm25 column weights: entity_id, chunk_id, title, body, terms, aliases.
const RANK = "bm25(memory_search_fts, 0, 0, 4, 1, 2, 4)";
  /** Read-only facet inventory from the SAME encrypted notes table.
   * No tag table/index, LLM classification or payload mutation. Paginated and
   * restricted to the current collection + status (same scope as searchNotes).
   * The caller can also type an exact tag not yet present on the first page.
   */
export async function listNoteTags(db:SQL, filters: { collectionId?: string; status?: "active" | "archived" | "trashed" } = {}, limit = 50, offset = 0): Promise<string[]> {
    const status = filters.status ?? "active";
    if (!["active", "archived", "trashed"].includes(status)) throw new Error("invalid_record_status");
    const n = Math.min(100, Math.max(1, Math.trunc(limit)));
    const start = Math.max(0, Math.trunc(offset));
    const rows = await db.getAllAsync<{tag: string}>(
      `SELECT DISTINCT j.value AS tag FROM memory_entities e
       JOIN json_each(e.payload_json,'$.tags') j
       WHERE e.domain='notes' AND e.record_status=?
         AND json_type(e.payload_json,'$.tags')='array'
         AND json_array_length(e.payload_json,'$.tags') BETWEEN 1 AND 12
         AND j.type='text' ${filters.collectionId ? "AND e.collection_id=?" : ""}
       ORDER BY tag LIMIT ? OFFSET ?`,
      [status, ...(filters.collectionId ? [filters.collectionId] : []), n, start],
    );
    return rows.map(row => row.tag).filter(tag => {
      try { return parseNoteTagsInput(tag).length === 1 && parseNoteTagsInput(tag)[0] === tag; }
      catch { return false; }
    });
  }

  /** `prefix` matches words that start with the query (a word stem without its
   * ending), so «машин» finds «машина», «машину» and «машиной». Results with a
   * query are ranked by relevance (bm25 over title, text, index words and
   * names), then by date. */
export async function searchNotes(db:SQL, query: string, limit = 50, offset = 0, filters: { collectionId?: string; status?: "active" | "archived" | "trashed"; prefix?: boolean; tag?: string } = {}): Promise<EntityRecord[]> {
    const count = Math.min(100, Math.max(1, Math.trunc(limit)));
    const start = Math.max(0, Math.trunc(offset));
    const term = query.trim();
    const status = filters.status || "active";
    if (status !== "active" && status !== "archived" && status !== "trashed") throw new Error("invalid_record_status");
    // Reject multiple/malformed tags; never treat a full-text hit as proof of
    // membership. Exact tag equality is checked against canonical payload.
    const selectedTags = filters.tag === undefined ? [] : parseNoteTagsInput(filters.tag);
    if (filters.tag !== undefined && selectedTags.length !== 1)
      throw new Error("invalid_note_tag_filter");
    const rows = await matches(db,term, filters.prefix ?? false, {
      status, collectionIds: filters.collectionId ? [filters.collectionId] : undefined,
      tag: selectedTags[0], limit: count, offset: start,
    });
    return rows.map(r => entityFrom(r));
  }

  /** One FTS search grouped by record: the best chunk of each record. */
export async function matches(db:SQL, term: string, prefix: boolean | { prefix: boolean; column?: "terms" }, options: {
    status: "active" | "archived" | "trashed"; collectionIds?: string[]; sensitivities?: string[]; tag?: string; limit: number; offset: number;
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
    if (options.tag) {
      filters.push("json_type(e.payload_json,'$.tags')='array'");
      filters.push("json_array_length(e.payload_json,'$.tags') BETWEEN 1 AND 12");
      filters.push("EXISTS (SELECT 1 FROM json_each(e.payload_json,'$.tags') j WHERE j.type='text' AND j.value=?)");
      params.push(options.tag);
    }
    if (!term) return db.getAllAsync<Row>(
      `SELECT e.*, NULL AS match_chunk FROM memory_entities e WHERE ${filters.join(" AND ")}
       ORDER BY e.updated_at DESC, e.id LIMIT ? OFFSET ?`, [...params, options.limit, options.offset]);
    // FTS5 ranking functions cannot run in a flattened subquery, hence MATERIALIZED.
    return db.getAllAsync<Row>(
      `WITH hits AS MATERIALIZED (
         SELECT entity_id, chunk_id, ${RANK} AS score FROM memory_search_fts WHERE memory_search_fts MATCH ?
       ), best AS (SELECT entity_id, chunk_id, min(score) AS score FROM hits GROUP BY entity_id)
       SELECT e.*, best.chunk_id AS match_chunk FROM best JOIN memory_entities e ON e.id=best.entity_id
       WHERE ${filters.join(" AND ")}
       ORDER BY best.score, e.updated_at DESC, e.id LIMIT ? OFFSET ?`,
      [typeof prefix === "boolean" ? ftsPhrase(term, prefix) : ftsPhrase(term, prefix.prefix, prefix.column), ...params, options.limit, options.offset]);
  }

  /** Active records linked to a person as «about», within the same filters. */
export async function linkedFacts(db:SQL, personId: string, options: { collectionIds?: string[]; sensitivities?: string[] }): Promise<Row[]> {
    const filters = ["e.domain='notes'", "e.record_status='active'"];
    const params: SQLite.SQLiteBindValue[] = [personId];
    if (options.collectionIds) {
      if (!options.collectionIds.length) return [];
      filters.push(`e.collection_id IN (${options.collectionIds.map(() => "?").join(",")})`); params.push(...options.collectionIds);
    }
    if (options.sensitivities) { filters.push(`e.sensitivity IN (${options.sensitivities.map(() => "?").join(",")})`); params.push(...options.sensitivities); }
    return db.getAllAsync<Row>(
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
export async function searchMemory(db:SQL, query: string, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number;
    /** The question's vector from the on-device model (п. 13), if it is downloaded. */
    vector?: { model: string; values: Float32Array };
    /** EmbeddingGemma visual vector; same search entrypoint, separate checked embedding space. */
    imageVector?: { model: string; values: Float32Array };
    /** Optional provisional calibrated floor for visual candidates only. */
    minImageSimilarity?: number;
    /** Stable owner ID and exact confirmed role, never a name heuristic. */
    verifiedRelative?: { ownerPersonId: string; relationKind: DirectPersonRelation };
  } = {}): Promise<MemoryHit[]> {
    // A ranked shortlist is not a completeness limit. Callers choosing a
    // broader synthesis may ask for more candidates while keeping each query bounded.
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 5)));
    const verifiedRelative=options.verifiedRelative;
    if (verifiedRelative) {
      // The relation evidence, all source/endpoint ACL checks and the final
      // conversation row/chunk must share ONE SQLCipher snapshot. Otherwise a
      // concurrent source edit or privacy change could invalidate a proof
      // after graph traversal but before returning the old result.
      let verifiedHits:MemoryHit[]=[];
      await withUnlockedTransaction(db,async tx=>{
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
    // 8 FTS hits for each word prematurely pruned records that became relevant
    // after evidence was fused across multiple query terms. Keep recall depth
    // proportional to the requested result set, with a fixed per-step ceiling.
    const lexicalCandidates = Math.min(300,Math.max(32,limit * 3));
    for (const step of searchSteps(query)) {
      const rows = await matches(db,step.term, { prefix: step.prefix, column: step.column }, {
        status: "active", collectionIds: options.collectionIds, sensitivities: options.sensitivities,
        limit: lexicalCandidates, offset: 0,
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
      for (const row of await linkedFacts(db,String(person.row.id), options)) {
        const id = String(row.id);
        const found = scored.get(id) || { row, score: 0, order: scored.size, chunk: null, weight: 0 };
        found.score += Math.max(1, person.score * 0.75);
        scored.set(id, found);
      }
    }
    let top = [...scored.values()].sort((a, b) => b.score - a.score || a.order - b.order);
    // One note can contain many independently indexed photos. Preserve every
    // matching attachment locator in similarity order, not just the last one.
    const imageLocators = new Map<string, ImageVectorHit[]>();
    // Meaning (п. 13): the closest chunks join through rank fusion. Without the
    // model, or when nothing is close enough, the word search stands as it is.
    if (options.vector) {
      const near = await vectorMatches(db,options.vector.model, options.vector.values, {
        ...options, limit: Math.min(100,Math.max(24,limit * 2)),
      });
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
    if (options.imageVector) {
      // A photo hit goes through the same searchMemory fusion and final
      // evidence/ACL path, never a separate unscoped image search endpoint.
      const similarImages = await attachmentImageMatches(db, {
        ...options.imageVector, collectionIds: options.collectionIds,
        sensitivities: options.sensitivities, limit: 20,
        minSimilarity: options.minImageSimilarity,
      });
      const photoRank: string[] = [];
      for (const image of similarImages) {
        const row = await db.getFirstAsync<Row>(
          "SELECT * FROM memory_entities WHERE id=? AND record_status='active' AND domain='notes'",
          [image.entityId]);
        if (!row || Number(row.record_version) !== image.recordVersion) continue;
        const found = scored.get(image.entityId) ||
          { row, score: 0, order: scored.size, chunk: null, weight: 0 };
        scored.set(image.entityId,found);
        if(!imageLocators.has(image.entityId)) {
          photoRank.push(image.entityId);
          imageLocators.set(image.entityId,[]);
        }
        imageLocators.get(image.entityId)!.push(image);
      }
      if (photoRank.length) {
        const fused = fuseRanks([top.map(x=>String(x.row.id)),photoRank]);
        top = [...scored.values()].sort((a,b)=>
          (fused.get(String(b.row.id))||0)-(fused.get(String(a.row.id))||0) || a.order-b.order);
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
          const witness = await db.getFirstAsync<Row>(
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
      const chunk = await db.getFirstAsync<Row>(
        item.chunk ? "SELECT text FROM memory_chunks WHERE id=?" : "SELECT text FROM memory_chunks WHERE entity_id=? ORDER BY ord LIMIT 1",
        [item.chunk ?? String(item.row.id)]);
      const photos = imageLocators.get(String(item.row.id));
      const originals = photos?.map(photo=>({
        imageSimilarity:photo.similarity,attachmentId:photo.attachmentId,recordId:String(item.row.id),
        recordVersion:photo.recordVersion,name:photo.name,
        mime:photo.mime,size:photo.size,kind:"image" as const,
        metadataOnly:true as const,originalTime:null,originalPage:null,
      }));
      hits.push({ entity: entityFrom(item.row), score: item.score,
        chunk: TEXT(chunk?.text) || photos?.[0]?.name || "", ...(originals?.length ? {originals} : {}) });
    }
    return hits;
  }