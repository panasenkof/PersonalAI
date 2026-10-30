/** #83.2 Derived *visual* embeddings share the EXISTING SQLCipher memory.
 * This is a storage adapter for the existing repository.searchMemory entrypoint,
 * not a parallel search engine, model runner or a second user-data database.
 * Actual source bytes are only opened by the existing attachments materializer.
 */
import type * as SQLite from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import { fingerprintExtractionSource } from "./extractions";
import { cosine, fromBlob, toBlob } from "./vectors";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
export const IMAGE_VECTOR_DIM = 768;
const MODEL = /^eg2\|vision\|768\|sha256:[a-f0-9]{64}$/;
type ModelSpace = { model: string; values: Float32Array };
export type ImageVectorHit = {
  entityId: string; attachmentId: string; name: string; mime: string;
  size: number; recordVersion: number; similarity: number;
};
function validateSpace(input: ModelSpace): void {
  if (!MODEL.test(input.model) ||
      !(input.values instanceof Float32Array) ||
      input.values.length !== IMAGE_VECTOR_DIM ||
      !input.values.every(Number.isFinite)) throw new Error("invalid_vision_vector_space");
}
const legalImage = (mime: string) => /^image\/(jpeg|png|webp|heic|heif)$/.test(mime);

/** Called ONLY after native inference, with the unmodified model digest.
 * Write is compare-and-set against original's source-part manifest while
 * holding an encrypted transaction. Edits/deletes cannot race the write.
 */
export async function saveAttachmentImageVector(db: SQL, input: ModelSpace & {
  attachmentId: string;
}): Promise<boolean> {
  validateSpace(input);
  let stored = false;
  await withUnlockedTransaction(db, async tx => {
    const row = await tx.getFirstAsync<{ mime: string; status: string; domain: string }>(
      `SELECT a.mime,e.record_status AS status,e.domain FROM memory_attachments a
       JOIN memory_entities e ON e.id=a.entity_id WHERE a.id=?`, [input.attachmentId]);
    if (!row || !legalImage(row.mime) || row.status !== "active" || row.domain !== "notes") return;
    const source = await fingerprintExtractionSource(tx, input.attachmentId);
    await tx.runAsync(
      `INSERT OR REPLACE INTO memory_attachment_vectors
       (attachment_id,model,dim,vector,source_version,created_at) VALUES (?,?,?,?,?,?)`,
      [input.attachmentId,input.model,IMAGE_VECTOR_DIM,toBlob(input.values),source,new Date().toISOString()]);
    stored = true;
  });
  return stored;
}

/** Bounded candidate retrieval. No fixed similarity threshold: user device
 * trials did not establish one. Filters are the SAME scope as searchMemory.
 * A stale image fingerprint or damaged byte/part manifest is never returned.
 * No image bytes or original path leave this adapter.
 */
export async function attachmentImageMatches(db: SQL, input: ModelSpace & {
  collectionIds?: string[]; sensitivities?: string[]; limit?: number;
}): Promise<ImageVectorHit[]> {
  validateSpace(input);
  if (input.collectionIds?.length === 0 || input.sensitivities?.length === 0) return [];
  const filters = ["e.domain='notes'", "e.record_status='active'",
    "a.mime IN ('image/jpeg','image/png','image/webp','image/heic','image/heif')",
    "v.model=?", "v.dim=?", "length(v.vector)=?"];
  const params: SQLite.SQLiteBindValue[] = [input.model,IMAGE_VECTOR_DIM,IMAGE_VECTOR_DIM*4];
  if (input.collectionIds) {
    filters.push("e.collection_id IN ("+input.collectionIds.map(()=>"?").join(",")+")");
    params.push(...input.collectionIds);
  }
  if (input.sensitivities) {
    filters.push("e.sensitivity IN ("+input.sensitivities.map(()=>"?").join(",")+")");
    params.push(...input.sensitivities);
  }
  // Preliminary bounded scan, with stable ID order. This is deliberately
  // not advertised as exhaustive for collections larger than 5,000 images.
  const rows = await db.getAllAsync<{
    entityId:string;attachmentId:string;name:string;mime:string;size:number;
    recordVersion:number;vector:Uint8Array;sourceVersion:string;
  }>(`SELECT e.id AS entityId,a.id AS attachmentId,a.name,a.mime,a.size,
         e.record_version AS recordVersion,v.vector,v.source_version AS sourceVersion
      FROM memory_attachment_vectors v JOIN memory_attachments a ON a.id=v.attachment_id
      JOIN memory_entities e ON e.id=a.entity_id
      WHERE ${filters.join(" AND ")}
      ORDER BY a.id LIMIT 5000`, params);
  const candidates = rows.flatMap(row => {
    const vector = fromBlob(row.vector);
    if (!vector || vector.length!==IMAGE_VECTOR_DIM || !vector.every(Number.isFinite)) return [];
    return [{row,similarity:cosine(input.values,vector)}];
  }).filter(x=>Number.isFinite(x.similarity))
    .sort((a,b)=>b.similarity-a.similarity||a.row.attachmentId.localeCompare(b.row.attachmentId));
  const limit = Math.min(20,Math.max(1,Math.trunc(input.limit??8)));
  const out:ImageVectorHit[] = [];
  const seen = new Set<string>();
  for (const {row,similarity} of candidates) {
    if (out.length>=limit) break;
    if (seen.has(row.entityId)) continue;
    try {
      if (row.sourceVersion!==await fingerprintExtractionSource(db,row.attachmentId)) continue;
    } catch { continue; }
    seen.add(row.entityId);
    out.push({entityId:row.entityId,attachmentId:row.attachmentId,name:row.name,
      mime:row.mime,size:row.size,recordVersion:Number(row.recordVersion),similarity});
  }
  return out;
}
