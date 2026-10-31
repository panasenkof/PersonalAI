/** Chat camera → ephemeral in-memory JPEG for an explicit search or chat attachment.
 * Downsample large camera originals to the existing bounded chat image
 * attachment format; only the normalized bytes enter native inference.
 */
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { Directory, File, Paths } from "expo-file-system";
import { toByteArray } from "base64-js";
import { localMemorySessionUnlocked } from "../local-memory/storage";
import { checkedChatAttachments, MAX_CHAT_FILE_BYTES, type ChatAttachment } from "../direct-agent/chat-attachments";
import { withNativeInteraction } from "../security/native-interaction";
import { readyNativeVisionModel83 } from "./vision-native-model";

function guard(signal?:AbortSignal) {
  if(signal?.aborted)throw new Error("vision_query_cancelled");
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
}
function discard(uri:string) {
  const cache=Paths.cache.uri.replace(/\/$/,"")+"/";
  if(!uri.startsWith(cache) || uri.includes("/../"))return;
  try { const file=new File(uri); if(file.exists)file.delete(); } catch {}
}

/** Original photo is never placed in persistent chat history or uploaded in the background. */
export type CameraPhotoDraft83 = { attachment:ChatAttachment; originalUri:string };
const originalFolder=()=>Paths.cache.uri.replace(/\/$/,"")+"/persai-camera-drafts/";
export function discardCameraPhotoDraft83(uri:string) {
  const folder=originalFolder();
  if(!uri.startsWith(folder) || uri.slice(folder.length).includes("/"))return;
  try { const f=new File(uri);if(f.exists)f.delete(); }catch {}
}
export async function stageChatImageForNote83(attachment:ChatAttachment):Promise<string>{
  const image=checkedChatAttachments([attachment])[0];
  if(image.kind!=="image")throw new Error("Выберите фотографию.");
  const dir=new Directory(Paths.cache,"persai-camera-drafts");
  dir.create({intermediates:true,idempotent:true});
  const ext=image.mime==="image/png"?".png":image.mime==="image/webp"?".webp":".jpg";
  const target=new File(dir,Crypto.randomUUID()+ext);
  try{
    await target.write(toByteArray(image.data));
    guard();
    return target.uri;
  }catch(e){discardCameraPhotoDraft83(target.uri);throw e;}
}
/** Source and resized copies are always cleaned; a note action can explicitly
 * retain its original in a bounded temporary folder until MemoryImport copies it. */
async function capturePhoto83(signal?:AbortSignal,forSearch=false,preserveOriginal=false):
  Promise<{attachment:ChatAttachment;originalUri?:string}|null>{
  guard(signal);
  // Opening the camera for a chat message must not require an embedding model.
  if(forSearch){
    const model=await readyNativeVisionModel83();
    guard(signal);
    if(!model)throw new Error("vision_model_not_installed");
  }
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
  let originalUri="";
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
      const attachment=checkedChatAttachments([{id:Crypto.randomUUID(),name:forSearch ? "Снимок для поиска.jpg" : "Снимок.jpg",
        kind:"image",mime:"image/jpeg",data,size:file.size}])[0];
      if(preserveOriginal){
        const dir=new Directory(Paths.cache,"persai-camera-drafts");
        dir.create({intermediates:true,idempotent:true});
        const target=new File(dir,Crypto.randomUUID()+".jpg");
        originalUri=target.uri;
        await new File(source).copy(target);
        guard(signal);
      }
      return {attachment,...(originalUri?{originalUri}:{})};
    }
    throw new Error("vision_query_image_size");
  }catch(e){
    if(originalUri)discardCameraPhotoDraft83(originalUri);
    throw e;
  }finally{
    if(output && output!==source)discard(output);
    discard(source);
  }
}
export async function capturePhotoDraft83(signal?:AbortSignal):Promise<CameraPhotoDraft83|null>{
  const result=await capturePhoto83(signal,false,true);
  return result?{attachment:result.attachment,originalUri:result.originalUri!}:null;
}
export async function capturePhotoForChat83(signal?:AbortSignal,forSearch=false):Promise<ChatAttachment|null>{
  return (await capturePhoto83(signal,forSearch))?.attachment || null;
}
/** Preserve the explicit search contract for callers that chose photo search. */
export function capturePhotoForSearch83(signal?:AbortSignal):Promise<ChatAttachment|null>{
  return capturePhotoForChat83(signal,true);
}
