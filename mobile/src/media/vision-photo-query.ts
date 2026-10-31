/** #83.3 — ephemeral photo→photo query using the EXISTING visual model.
 * One in-memory query vector, one SqliteMemoryRepository.searchMemory caller.
 * Never stores, uploads, attaches or indexes the selected query photograph.
 */
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { localMemorySessionUnlocked } from "../local-memory/storage";
import { readyNativeVisionModel83 } from "./vision-native-model";
import { embedVisionImage83 } from "./vision-native-vectors";

type PickedImage = { uri:string; name:string; mimeType?:string|null; size?:number|null };
export type PhotoMatchVector83 = { model:string; values:Float32Array };
const MAX_QUERY_BYTES = 80 * 1024 * 1024;
const formats:Record<string,string> = {
  "image/jpeg":".jpg", "image/png":".png", "image/webp":".webp",
};
function guard(signal?:AbortSignal) {
  if (signal?.aborted) throw new Error("vision_query_cancelled");
  if (!localMemorySessionUnlocked()) throw new Error("application_locked");
}

/** The caller chooses ONE image using DocumentPicker(copyToCacheDirectory).
 * The native ABI accepts an app-private basename, never a content URI.
 * The picker copy and this staging copy are both removed by their owners.
 */
export async function preparePhotoMatchQuery83(
  asset:PickedImage, signal?:AbortSignal,
):Promise<PhotoMatchVector83> {
  guard(signal);
  const mime=asset.mimeType?.toLowerCase() ?? "";
  const suffix=formats[mime];
  // Restrict to a copied app-cache file, not arbitrary device/gallery paths.
  const cacheRoot=Paths.cache.uri.replace(/\/$/,"")+"/";
  if (!suffix || !asset.uri.startsWith(cacheRoot) ||
      /(?:^|\/)\.\.(?:\/|$)/.test(asset.uri) ||
      !/\.(?:jpe?g|png|webp)$/i.test(asset.name)) {
    throw new Error("vision_invalid_query_image");
  }
  const source=new File(asset.uri);
  if (!source.exists || source.size < 1 || source.size > MAX_QUERY_BYTES)
    throw new Error("vision_query_image_size");
  const model=await readyNativeVisionModel83();
  guard(signal);
  if (!model) throw new Error("vision_model_not_installed");
  const directory=new Directory(Paths.cache,"persai-vision-probe");
  let staged:File|null=null;
  try {
    directory.create({idempotent:true,intermediates:true});
    staged=new File(directory,Crypto.randomUUID()+suffix);
    source.copy(staged);
    guard(signal);
    const values=await embedVisionImage83({
      modelName:model.modelName,
      modelSha256:model.modelSha256,
      imageName:staged.name,
    });
    guard(signal);
    return {model:model.modelSpace,values};
  } finally {
    try { if (staged?.exists) staged.delete(); } catch { /* disposable cache */ }
  }
}
