/** #83.3 One ephemeral local image-query vector from an existing chat image.
 * The image is already byte-validated by checkedChatAttachments. No upload,
 * new storage, permanent vector, new downloader or second search provider.
 */
import { toByteArray } from "base64-js";
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { localMemorySessionUnlocked } from "../local-memory/storage";
import { checkedChatAttachments, type ChatAttachment } from "../direct-agent/chat-attachments";
import { readyNativeVisionModel83 } from "./vision-native-model";
import { embedVisionImage83 } from "./vision-native-vectors";

export type PhotoMatchVector83 = { model:string; values:Float32Array };
const formats:Record<string,string> = {
  "image/jpeg":".jpg", "image/png":".png", "image/webp":".webp",
};
function guard(signal?:AbortSignal) {
  if (signal?.aborted) throw new Error("vision_query_cancelled");
  if (!localMemorySessionUnlocked()) throw new Error("application_locked");
}

/** Create only one private temporary file; nothing is added to Memory.
 * Chat attachment data never goes to the remote LLM on local search turns.
 */
export async function preparePhotoMatchChatAttachment83(
  attachment:ChatAttachment, signal?:AbortSignal,
):Promise<PhotoMatchVector83> {
  guard(signal);
  const item=checkedChatAttachments([attachment])[0];
  if(item.kind!=="image" || !formats[item.mime])
    throw new Error("vision_invalid_query_image");
  const model=await readyNativeVisionModel83();
  guard(signal);
  if(!model) throw new Error("vision_model_not_installed");
  const directory=new Directory(Paths.cache,"persai-vision-probe");
  let staged:File|null=null;
  try {
    directory.create({idempotent:true,intermediates:true});
    staged=new File(directory,Crypto.randomUUID()+formats[item.mime]);
    staged.write(toByteArray(item.data));
    guard(signal);
    const values=await embedVisionImage83({
      modelName:model.modelName,modelSha256:model.modelSha256,
      imageName:staged.name,
    });
    guard(signal);
    const selected=await readyNativeVisionModel83();
    guard(signal);
    if(selected?.modelSpace!==model.modelSpace)
      throw new Error("vision_model_changed");
    return {model:model.modelSpace,values};
  } finally {
    try { if(staged?.exists) staged.delete(); } catch { /* disposable cache */ }
  }
}
