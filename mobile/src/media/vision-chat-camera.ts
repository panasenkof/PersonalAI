/** Chat camera → ephemeral local photo retrieval, no note creation.
 * Downsample large camera originals to the existing bounded chat image
 * attachment format; only the normalized bytes enter native inference.
 */
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { File, Paths } from "expo-file-system";
import { localMemorySessionUnlocked } from "../local-memory/storage";
import { checkedChatAttachments, MAX_CHAT_FILE_BYTES, type ChatAttachment } from "../direct-agent/chat-attachments";
import { withNativeInteraction } from "../security/native-interaction";

function guard(signal?:AbortSignal) {
  if(signal?.aborted)throw new Error("vision_query_cancelled");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
}
function discard(uri:string) {
  const cache=Paths.cache.uri.replace(/\/$/,"")+"/";
  if(!uri.startsWith(cache) || uri.includes("/../"))return;
  try { const file=new File(uri); if(file.exists)file.delete(); } catch {}
}

/** Returns one temporary in-memory JPEG. The source and resized cache copies
 * are deleted even on cancel, lock expiry, decode or native failure.
 */
export async function capturePhotoForSearch83(signal?:AbortSignal):Promise<ChatAttachment|null>{
  guard(signal);
  const permission=await withNativeInteraction(
    ()=>ImagePicker.requestCameraPermissionsAsync(),{permissionPrompt:true});
  guard(signal);
  if(!permission.granted)throw new Error("vision_camera_permission_denied");
  const shot=await withNativeInteraction(()=>ImagePicker.launchCameraAsync({
    mediaTypes:["images"],allowsEditing:false,quality:0.75,
  }));
  guard(signal);
  if(shot.canceled || !shot.assets.length)return null;
  const source=shot.assets[0].uri;
  let output="";
  try {
    for(const width of [1280,960,720]) {
      guard(signal);
      const resized=await manipulateAsync(source,[{resize:{width}}],{
        compress:0.65,format:SaveFormat.JPEG,
      });
      if(output && output!==source)discard(output);
      output=resized.uri;
      guard(signal);
      const file=new File(output);
      if(!file.exists || file.size<1)throw new Error("vision_query_image_size");
      if(file.size>MAX_CHAT_FILE_BYTES)continue;
      const data=await file.base64();
      guard(signal);
      return checkedChatAttachments([{id:Crypto.randomUUID(),name:"Снимок для поиска.jpg",
        kind:"image",mime:"image/jpeg",data,size:file.size}])[0];
    }
    throw new Error("vision_query_image_size");
  } finally {
    if(output && output!==source)discard(output);
    discard(source);
  }
}
