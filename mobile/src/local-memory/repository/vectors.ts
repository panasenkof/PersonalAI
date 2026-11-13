/** ARCH-6c: canonical vector readers and derived-data writers.
 * Run on the same unlocked SQLCipher connection as the repository facade.
 * No new vector index, queue, search backend or DB instance.
 */
import type * as SQLite from "expo-sqlite";
import { withUnlockedTransaction } from "../transaction";
import { MIN_SIMILARITY, VECTOR_DIM, cosine, embeddingHash, embeddingText, fromBlob, isCurrentVectorSpace, toBlob } from "../vectors";
import { saveAttachmentImageVector } from "../attachment-vectors";
import { TEXT, type Row, type SQL } from "./shared";

// Corrupted dimensions and old model-space revisions are missing work, not
// completed results; old vectors remain derived data but are never compared.
const validVectorJoin = (model: string) =>
  "LEFT JOIN memory_vectors v ON v.chunk_id=c.id AND v.model=? " +
  "AND v.dim>0 AND length(v.vector)=4*v.dim" +
  (isCurrentVectorSpace(model) ? " AND v.dim=" + VECTOR_DIM : "");
  /** Chunks whose vector for `model` is missing or older than the text and
   * title, with the text to embed. Every section is included: vectors never
   * leave the phone, and what reaches the model is filtered at search time. */
export async function pendingVectorChunks(db:SQL, model: string, limit = 32): Promise<Array<{ chunkId: string; text: string; hash: string }>> {
    const cap = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 32));
    const batchSize = Math.max(64, Math.min(256, cap * 4));
    const out: Array<{ chunkId: string; text: string; hash: string }> = [];
    let cursor: { date: string; id: string; ord: number } | null = null;
    for (;;) {
      // Keyset cursor is stable within the read; avoids quadratic deep OFFSET
      // paging. The durable dirty queue is a later, separate SQLCipher stage.
      const rows: Row[] = await db.getAllAsync<Row>(
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
export async function saveVectors(db:SQL, model: string, items: Array<{ chunkId: string; vector: Float32Array; hash: string }>): Promise<number> {
    let saved = 0;
    await withUnlockedTransaction(db, async tx => {
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
export async function vectorStatus(db:SQL, model: string): Promise<{ done: number; total: number }> {
    let done = 0, total = 0;
    let cursor: { id: string; ord: number } | null = null;
    const pageSize = 256;
    for (;;) {
      const rows: Row[] = await db.getAllAsync<Row>(
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
export async function vectorMatches(db:SQL, model: string, query: Float32Array, options: { collectionIds?: string[]; sensitivities?: string[]; limit?: number } = {}):
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
    // The previous full-table materialization loaded every Float32 blob into JS
    // at once. Scan the same authorized rows in keyset pages instead, retaining
    // only the best (small) metadata per record, never the source vectors.
    const best = new Map<string, { chunkId: string; similarity: number }>();
    const PAGE_SIZE = 256;
    let afterChunk = "";
    while (true) {
      const rows = await db.getAllAsync<Row>(
        `SELECT v.chunk_id, v.vector, v.content_hash, c.entity_id, c.text, e.title FROM memory_vectors v JOIN memory_chunks c ON c.id=v.chunk_id
         JOIN memory_entities e ON e.id=c.entity_id WHERE v.model=? AND v.dim=? AND length(v.vector)=4*v.dim AND ${filters.join(" AND ")}
         AND v.chunk_id>? ORDER BY v.chunk_id LIMIT ?`, [...params,afterChunk,PAGE_SIZE]);
      if (!rows.length) break;
      for (const r of rows) {
        if (r.content_hash !== embeddingHash(TEXT(r.title), String(r.text))) continue;
        const vector = fromBlob(r.vector);
        if (!vector || !vector.length || !vector.every(Number.isFinite)) continue;
        const similarity = cosine(query, vector);
        if (similarity < MIN_SIMILARITY) continue;
        const id = String(r.entity_id);
        if ((best.get(id)?.similarity ?? -1) < similarity) best.set(id, { chunkId: String(r.chunk_id), similarity });
      }
      afterChunk=String(rows[rows.length-1].chunk_id);
      if (rows.length<PAGE_SIZE) break;
    }
    const top = [...best.entries()].sort((a, b) => b[1].similarity - a[1].similarity).slice(0, Math.min(100,Math.max(1,Math.trunc(options.limit??8))));
    const out: Array<{ row: Row; chunkId: string; similarity: number }> = [];
    for (const [id, hit] of top) {
      const row = await db.getFirstAsync<Row>("SELECT * FROM memory_entities WHERE id=?", [id]);
      if (row) out.push({ row, ...hit });
    }
    return out;
  }

  /** One repository writer shared by the visual indexing scheduler.
   * Untrusted/stale original rows never receive derived vectors. */
export async function saveImageVector(db:SQL, attachmentId: string, model: string, values: Float32Array, sourceVersion: string): Promise<boolean> {
    return saveAttachmentImageVector(db,{attachmentId,model,values,sourceVersion});
  }

