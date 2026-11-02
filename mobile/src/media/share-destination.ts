import type { SharePayload } from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES, MAX_CHAT_TEXT_CHARS, MAX_CHAT_IMAGE_SOURCE_BYTES, checkedChatAttachments, type ChatAttachment } from '../direct-agent/chat-attachments';
import { readChatAttachments, chatFileFormat, safeChatFileFailure } from './pickChatAttachments';
import { mediaKind, type ImportFile } from './kinds';

export type SharedMaterial = {text:string; names:string[]; files:ImportFile[]; memoryError:string; chatError:string};
export type SharedChatStatus = { name:string; state:'ready'|'error'; reason?:string };
export type PreparedShare = SharedMaterial & { attachments:ChatAttachment[]; chatStatuses:SharedChatStatus[] };
const isText = (p: SharePayload) => p.shareType === 'text' || p.shareType === 'url';

/** No URL resolution, networking, model invocation or note creation. */
export function inspectSharedMaterial(payloads: SharePayload[]): SharedMaterial {
  if (!payloads.length || payloads.length > 30) throw new Error('Передайте от 1 до 30 материалов за один раз.');
  const files: ImportFile[] = [], names: string[] = [], texts: string[] = [];
  let memoryError='', chatError='';
  for (const p of payloads) {
    if (!p?.value || typeof p.value !== 'string') throw new Error('Получен пустой материал.');
    if (isText(p)) {
      if (!p.value.trim()) throw new Error("Получен пустой текст.");
      texts.push(p.value);names.push(p.shareType === 'url' ? 'Ссылка' : 'Текст');
      if (p.value.length > 60000) memoryError='Входящий текст длиннее 60 000 символов.';
      continue;
    }
    if (!['file','image','audio','video'].includes(p.shareType) || !/^(content|file):\/\//.test(p.value)) throw new Error('Не удалось получить локальный файл. Поделитесь им ещё раз.');
    const source = new File(p.value);
    const file={uri:p.value, name:source.name || 'Входящий файл', mimeType:p.mimeType};
    files.push(file);names.push(file.name);
    try { mediaKind(file); } catch { memoryError='Этот формат пока нельзя импортировать в память. Выберите изображение, PDF, аудио, видео или текстовый файл.'; }
    let chatKind: "image" | "text" | "pdf" | undefined;
    try { chatKind = chatFileFormat(file).kind; }
    catch { chatError='В чат доступны JPEG, PNG, WebP, текст UTF-8 и PDF с текстовым слоем. Этот формат не поддерживается.'; }
    // Preflight mirrors the native picker: an oversized image is resized on
    // device before chat, whereas text must fit the bounded UTF-8 read.
    // ContentResolver metadata can be unavailable; readChatAttachments checks
    // the actual copied file size and validated payload again.
    try {
      const size=source.size;
      if (chatKind === "image" && size > MAX_CHAT_IMAGE_SOURCE_BYTES)
        chatError='Фото для чата должно быть не больше 80 МБ.';
      if (chatKind === "text" && size > 96_000)
        chatError='Текстовый файл для чата слишком большой: до 24 000 символов.';
      if (chatKind === "pdf" && size > MAX_CHAT_FILE_BYTES)
        chatError='Для чата выберите PDF до 6 МБ; в модель отправится только извлечённый текст.';
      if (size > 80*1024*1024)
        memoryError='Оригинал для памяти должен быть не больше 80 МБ.';
    } catch { /* Copy/read gives a recoverable access error. */ }
  }
  const text=texts.join('\n\n');
  if (files.length>MAX_CHAT_FILES)chatError='В чат можно прикрепить до 3 файлов за один раз.';
  if (text.length>MAX_CHAT_TEXT_CHARS)chatError='Для чата входящий текст должен быть не длиннее 24 000 символов.';
  return {text,names,files,memoryError,chatError};
}

/** The same actual chat reader as picker H2, but Share owns temporary copies
 * of foreign content URIs. A broken file is not permitted to erase valid ones.
 * Memory-import eligibility refers to the originals and remains independent.
 */
export async function prepareSharedMaterial(payloads:SharePayload[],signal:AbortSignal):Promise<PreparedShare>{
  const check=()=>{if(signal.aborted || !localMemorySessionUnlocked())throw new Error('Приём прерван. Поделитесь материалом ещё раз после разблокировки.');};
  check();
  const material=inspectSharedMaterial(payloads);
  // A Share may contain more items for the Memory path. The chat contract
  // still permits no more than three files and 24k of separately shared text.
  if(material.files.length>MAX_CHAT_FILES || material.text.length>MAX_CHAT_TEXT_CHARS)
    return {...material,attachments:[],chatStatuses:[]};
  // Global preflight used to reject all files if any one was unsupported.
  // Preserve its Memory result but compute chat availability per item below.
  material.chatError='';
  const copies:File[]=[];
  const attachments:ChatAttachment[]=[];
  const chatStatuses:SharedChatStatus[]=[];
  try{
    for(const file of material.files){
      check();
      const label=(file.name.includes('://') ? 'Входящий файл' : file.name)
        .replace(/[\r\n\t]/g,' ').slice(0,90);
      let error='';
      try{
        const {kind}=chatFileFormat(file);
        // Reject known unsupported sources before copying, without affecting
        // Memory Import or other attachments in this same Share.
        const size=new File(file.uri).size;
        if(kind==='image' && size>MAX_CHAT_IMAGE_SOURCE_BYTES)error='Фото превышает 80 МБ.';
        if(kind==='text' && size>96_000)error='Текстовый файл превышает 24 000 символов.';
        if(kind==='pdf' && size>MAX_CHAT_FILE_BYTES)error='PDF превышает 6 МБ.';
        if(error){
          chatStatuses.push({name:label,state:'error',reason:error});
          continue;
        }
      }catch(e){
        chatStatuses.push({name:label,state:'error',reason:safeChatFileFailure(e)});
        continue;
      }
      try{
        const dir=new Directory(Paths.cache,'persai-incoming');
        dir.create({intermediates:true,idempotent:true});
        const target=new File(dir,Crypto.randomUUID());
        copies.push(target);
        await copyAsync({from:file.uri,to:target.uri});
        check();
        // An Android provider can omit/underreport ContentResolver size. The
        // original-to-Memory limit must not be weakened by partial Chat mode.
        if(target.size>80*1024*1024)material.memoryError='Оригинал для памяти должен быть не больше 80 МБ.';
        const [ready]=await readChatAttachments([{...file,uri:target.uri}],signal);
        check();
        // This also rechecks cumulative text and all the actual media bytes,
        // not only the size reported by Android ContentResolver.
        checkedChatAttachments([...attachments,ready]);
        attachments.push(ready);
        chatStatuses.push({name:label,state:'ready'});
      }catch(e){
        check();
        chatStatuses.push({name:label,state:'error',reason:safeChatFileFailure(e)});
      }
    }
    check();
    if(!attachments.length && !material.text.trim() && material.files.length)
      material.chatError='Нет готовых файлов для чата. Можно сохранить оригинал в память.';
    return {...material,attachments,chatStatuses};
  }finally{
    for(const copy of copies)try{if(copy.exists)copy.delete();}catch{/* Private cache only; never delete external provider source. */}
  }
}
