/** #83.2 single-original ingestion into the existing encrypted visual index.
 * NO separate file writer, vector table, search route, remote upload or
 * background queue. Foreground opt-in only, until real Vivo runtime QA passes.
 *
 * The only plaintext photo is the bounded, app-private preview already
 * supported by materializeAttachment, briefly staged in the probe cache.
 */
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { SqliteMemoryRepository } from "../local-memory/repository";
import { fingerprintExtractionSource } from "../local-memory/extractions";
import { materializeAttachment, type Attachment } from "./attachments";
import { readyNativeVisionModel83 } from "./vision-native-model";
import { embedVisionImage83 } from "./vision-native-vectors";
import type { VerifiedOriginalLocator } from "../local-memory/types";

const fileSuffix = new Map([
  ["image/jpeg",".jpg"],["image/png",".png"],["image/webp",".webp"],
]);
const validId = /^[a-zA-Z0-9-]{1,128}$/;
function guard(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("vision_index_cancelled");
  if (!localMemorySessionUnlocked()) throw new Error("application_locked");
}

export type SinglePhotoIndexOutcome =
  { indexed:true; attachmentId:string; modelSpace:string } |
  { indexed:false; attachmentId:string; reason:"model_not_installed" | "source_changed" | "unsupported_format" };

export async function indexSavedPhoto83(
  profile:string, attachmentId:string, signal?:AbortSignal,
):Promise<SinglePhotoIndexOutcome>{
  if (!profile || profile.length>160 || !validId.test(attachmentId))
    throw new Error("vision_invalid_index_target");
  guard(signal);
  const model=await readyNativeVisionModel83();
  if (!model) return { indexed:false,attachmentId,reason:"model_not_installed" };
  guard(signal);
  const candidate=await withLocalMemoryDatabase(profile,async db=>{
    const row=await db.getFirstAsync<Attachment & { record_version:number }>(
      `SELECT a.id,a.entity_id,a.name,a.mime,a.size,e.record_version
         FROM memory_attachments a JOIN memory_entities e ON e.id=a.entity_id
         JOIN memory_collections c ON c.id=e.collection_id
        WHERE a.id=? AND e.record_status='active' AND e.domain='notes'
          AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'`,
      [attachmentId]);
    if(!row)throw new Error("memory_source_not_available_or_stale");
    const sourceVersion=await fingerprintExtractionSource(db,attachmentId);
    const locator:VerifiedOriginalLocator={
      attachmentId:row.id,recordId:row.entity_id,recordVersion:row.record_version,
      name:row.name,mime:row.mime,size:row.size,kind:"image",
      metadataOnly:true,originalTime:null,originalPage:null,
    };
    return {attachment:row,sourceVersion,locator};
  });
  const suffix=fileSuffix.get(candidate.attachment.mime);
  if(!suffix) return {indexed:false,attachmentId,reason:"unsupported_format"};
  guard(signal);
  let preview:string|null=null, staged:File|null=null;
  try{
    // materializeAttachment verifies every original part against its SHA-256
    // and repeats AppLock, record version and sensitivity checks after read.
    preview=await materializeAttachment(profile,candidate.attachment,signal,candidate.locator);
    guard(signal);
    const directory=new Directory(Paths.cache,"persai-vision-probe");
    directory.create({intermediates:true,idempotent:true});
    staged=new File(directory,Crypto.randomUUID()+suffix);
    // Native file-to-file copy: no base64 or decoded image passes through JS.
    new File(preview).copy(staged);
    guard(signal);
    const vector=await embedVisionImage83({
      modelName:model.modelName,modelSha256:model.modelSha256,imageName:staged.name,
    });
    guard(signal);
    const accepted=await withLocalMemoryDatabase(profile, async db => {
      // CAS against original manifest inside the existing repository's
      // encrypted transaction. Source changed during inference -> discard.
      return new SqliteMemoryRepository(db).saveImageVector(
        attachmentId,model.modelSpace,vector,candidate.sourceVersion);
    });
    guard(signal);
    return accepted ? {indexed:true,attachmentId,modelSpace:model.modelSpace} :
      {indexed:false,attachmentId,reason:"source_changed"};
  } finally {
    // All derived plaintext previews are disposable, including failures,
    // AppLock expiry and aborted inference. Never keep decrypted originals.
    try { if(staged?.exists)staged.delete(); } catch {}
    try { if(preview){const f=new File(preview);if(f.exists)f.delete();} } catch {}
  }
}
