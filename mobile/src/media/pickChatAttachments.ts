import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { withNativeInteraction } from '../security/native-interaction';
import { checkedChatAttachments, MAX_CHAT_FILE_BYTES, MAX_CHAT_IMAGE_SOURCE_BYTES, MAX_CHAT_FILES, type ChatAttachment } from '../direct-agent/chat-attachments';

export async function pickChatAttachments(signal: AbortSignal): Promise<ChatAttachment[]> {
  let assets: DocumentPicker.DocumentPickerAsset[] = [];
  const check = () => { if (signal.aborted || !localMemorySessionUnlocked()) throw new Error('Выбор файлов прерван.'); };
  try {
    check();
    await withNativeInteraction(async () => {
      const result = await DocumentPicker.getDocumentAsync({ type:['image/jpeg','image/png','image/webp','text/*','application/json'], multiple:true, copyToCacheDirectory:true });
      if (!result.canceled) assets = result.assets;
    });
    check();
    return await readChatAttachments(assets, signal);
  } finally {
    for (const asset of assets) if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) {
      try { const file = new File(asset.uri); if (file.exists) file.delete(); } catch { /* Picker copy only. */ }
    }
  }
}

/** Downsample only oversized chat images on-device. The source file is never
 * overwritten: an original saved as a note is kept byte-exact. Bounded JPEG
 * copies are disposable and are never sent to a provider without the user's
 * normal explicit send action.
 */
async function prepareChatPhoto(uri:string, size:number, signal:AbortSignal):Promise<{uri:string;mime:string;temporary:boolean}>{
  if(size<=MAX_CHAT_FILE_BYTES)return {uri,mime:"",temporary:false};
  if(size>MAX_CHAT_IMAGE_SOURCE_BYTES)throw new Error("Для чата выберите фото до 80 МБ. Большие оригиналы сохраните как заметку.");
  const check=()=>{if(signal.aborted || !localMemorySessionUnlocked())throw new Error("Выбор файлов прерван.");};
  let previous="";
  try{
    // Never shrink an already suitable original. Quality is intentionally high;
    // only if needed, reduce dimensions to fit the bounded chat payload.
    for(const width of [2560, 2048, 1600, 1280]){
      check();
      const resized=await manipulateAsync(uri,[{resize:{width}}],{compress:0.88,format:SaveFormat.JPEG});
      if(previous) {try {const old=new File(previous);if(old.exists)old.delete();}catch {}}
      previous=resized.uri;
      check();
      const bytes=new File(previous).size;
      if(bytes>0 && bytes<=MAX_CHAT_FILE_BYTES){
        const ready=previous;
        previous="";
        return {uri:ready,mime:"image/jpeg",temporary:true};
      }
    }
    throw new Error("Не удалось подготовить фото для чата. Попробуйте сохранить оригинал в заметку.");
  }catch(e){
    if(e instanceof Error && e.message.startsWith("Не удалось подготовить фото"))throw e;
    if(signal.aborted || !localMemorySessionUnlocked())throw new Error("Выбор файлов прерван.");
    throw new Error("Не удалось уменьшить фотографию для чата. Оригинал не изменён.");
  }finally{
    if(previous) {try {const f=new File(previous);if(f.exists)f.delete();}catch {}}
  }
}

/** Read already-owned local files; the caller owns their cleanup. Shared by picker and Android Share. */
export async function readChatAttachments(assets: Array<{uri:string; name:string; mimeType?:string|null}>, signal: AbortSignal): Promise<ChatAttachment[]> {
  const check = () => { if (signal.aborted || !localMemorySessionUnlocked()) throw new Error('Выбор файлов прерван.'); };
  check();
    if (assets.length > MAX_CHAT_FILES) throw new Error('К сообщению можно прикрепить до 3 файлов.');
    const files: ChatAttachment[] = [];
    for (const asset of assets) {
      check();
      if (!/^(file|content):\/\//.test(asset.uri)) throw new Error('Выберите локальный файл.');
      const size = new File(asset.uri).size;
      const {kind,mime} = chatFileFormat(asset);
      if (!size || (kind === 'image' && size > MAX_CHAT_IMAGE_SOURCE_BYTES))
        throw new Error('Фото для чата должно быть непустым и не больше 80 МБ.');
      // Bound text reads as well as image reads before bringing bytes into JS.
      if (kind === 'text' && size > 96000) throw new Error('Текстовый файл слишком большой: до 24 000 символов.');
      const prepared = kind === 'image'
        ? await prepareChatPhoto(asset.uri,size,signal)
        : {uri:asset.uri,mime:"",temporary:false};
      try {
        check();
        const data = await FileSystem.readAsStringAsync(prepared.uri, {encoding:kind === 'image' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8});
        check();
        files.push({id:Crypto.randomUUID(), name:asset.name.slice(0,240), kind,
          mime:kind === 'text' ? 'text/plain' : prepared.mime || mime, data,
          size:kind === 'image' ? new File(prepared.uri).size : size});
      } finally {
        if(prepared.temporary)try {const f=new File(prepared.uri);if(f.exists)f.delete();}catch {}
      }
    }
    return checkedChatAttachments(files);
}

export function chatFileFormat(asset: {name:string; mimeType?:string|null}): {kind:'image'|'text';mime:string} {
  const ext=asset.name.split('.').pop()?.toLowerCase();
  const declared=asset.mimeType || '';
  const mime=(!declared || declared==='application/octet-stream') ? ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'} as Record<string,string>)[ext || ''] || declared : declared;
  if (['image/jpeg','image/png','image/webp'].includes(mime)) return {kind:'image',mime};
  if (mime.startsWith('text/') || mime==='application/json' || ['txt','md','csv','json','log','srt','vtt'].includes(ext || '')) return {kind:'text',mime:'text/plain'};
  throw new Error('В чат можно прикрепить JPEG, PNG, WebP или текст UTF-8. PDF, аудио и видео пока доступны в памяти.');
}
