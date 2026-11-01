/** Automatically prepare newly saved accessible note photos, using the existing
 * SQLCipher manifest, ACL, fingerprint CAS and vision index writer.
 * Invoked only after the note transaction commits while the app is unlocked.
 * Nothing is uploaded, and no second store or background queue is created.
 */
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { fingerprintExtractionSource } from "../local-memory/extractions";
import { readyNativeVisionModel83 } from "./vision-native-model";
import { indexSavedPhoto83 } from "./vision-index-attachment";

type Candidate = { attachmentId:string; indexedVersion:string|null };
export type AutoPhotoIndexResult = { indexed:number; current:number; pending:number; failed:number };

export async function autoIndexNotePhotos83(
  profile:string, entityId:string, signal?:AbortSignal,
):Promise<AutoPhotoIndexResult> {
  const guard=()=>{
    if(signal?.aborted)throw new Error("vision_index_cancelled");
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
  };
  guard();
  // Only ordinary, currently accessible, active notes; sensitive originals must
  // never be staged into the model's cache.
  const model=await readyNativeVisionModel83();
  guard();
  const rows=await withLocalMemoryDatabase(profile, async db => {
    const candidates=await db.getAllAsync<Candidate>(
      `SELECT a.id AS attachmentId, v.source_version AS indexedVersion
         FROM memory_attachments a
         JOIN memory_entities e ON e.id=a.entity_id
         JOIN memory_collections c ON c.id=e.collection_id
         LEFT JOIN memory_attachment_vectors v
           ON v.attachment_id=a.id AND v.model=?
        WHERE e.id=? AND e.record_status='active' AND e.domain='notes'
          AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'
          AND a.mime IN ('image/jpeg','image/png','image/webp')
        ORDER BY a.id LIMIT 10`,
      [model?.modelSpace || "", entityId],
    );
    if(!model)return candidates.map(c=>({...c, current:false}));
    const result:{attachmentId:string;current:boolean}[]=[];
    for(const row of candidates) {
      guard();
      const current=Boolean(row.indexedVersion &&
        row.indexedVersion===await fingerprintExtractionSource(db,row.attachmentId));
      result.push({attachmentId:row.attachmentId,current});
    }
    return result;
  });
  guard();
  const status:AutoPhotoIndexResult={indexed:0,current:0,pending:0,failed:0};
  for(const row of rows) {
    guard();
    if(row.current) {status.current++;continue;}
    if(!model) {status.pending++;continue;}
    try {
      const result=await indexSavedPhoto83(profile,row.attachmentId,signal);
      if(result.indexed && result.modelSpace===model.modelSpace)status.indexed++;
      else status.pending++;
    }catch(error){
      guard(); // Lock/cancel is not a recoverable per-file failure.
      status.failed++;
    }
  }
  return status;
}
