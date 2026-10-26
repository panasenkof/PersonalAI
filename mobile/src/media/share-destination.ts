import type { SharePayload } from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { MAX_CHAT_FILES, MAX_CHAT_TEXT_CHARS, MAX_CHAT_FILE_BYTES, type ChatAttachment } from '../direct-agent/chat-attachments';
import { readChatAttachments, chatFileFormat } from './pickChatAttachments';
import { mediaKind, type ImportFile } from './kinds';

export type SharedMaterial = {text:string; names:string[]; files:ImportFile[]; memoryError:string; chatError:string};
export type PreparedShare = SharedMaterial & {attachments:ChatAttachment[]};
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
    try { mediaKind(file); } catch { memoryError='Этот формат пока нельзя импортировать в новую заметку. PDF можно добавить к существующей заметке.'; }
    try { chatFileFormat(file); } catch { chatError='В чат доступны JPEG, PNG, WebP и текст UTF-8. Этот формат не поддерживается.'; }
    // ContentResolver metadata can be unavailable; actual bytes are checked after a private copy.
    try { const size=source.size; if(size>MAX_CHAT_FILE_BYTES)chatError='Для чата каждый файл должен быть не больше 2 МБ.'; if(size>80*1024*1024)memoryError='Оригинал для памяти должен быть не больше 80 МБ.'; } catch { /* Copy/read gives a recoverable access error. */ }
  }
  const text=texts.join('\n\n');
  if (files.length>MAX_CHAT_FILES)chatError='В чат можно прикрепить до 3 файлов за один раз.';
  if (text.length>MAX_CHAT_TEXT_CHARS)chatError='Для чата входящий текст должен быть не длиннее 24 000 символов.';
  return {text,names,files,memoryError,chatError};
}

/** Own only our temporary copies. Original provider URIs are never deleted. */
export async function prepareSharedMaterial(payloads:SharePayload[], signal:AbortSignal):Promise<PreparedShare> {
  const check=()=>{if(signal.aborted || !localMemorySessionUnlocked())throw new Error('Приём прерван. Поделитесь материалом ещё раз после разблокировки.');};
  check();const material=inspectSharedMaterial(payloads);
  if(material.chatError)return {...material,attachments:[]};
  const copies:File[]=[];
  try {
    const files:ImportFile[]=[];
    for(const file of material.files){
      check();const dir=new Directory(Paths.cache,'persai-incoming');dir.create({intermediates:true,idempotent:true});
      const target=new File(dir,Crypto.randomUUID());copies.push(target);
      await copyAsync({from:file.uri,to:target.uri});check();
      if (target.size > 80*1024*1024) material.memoryError="Оригинал для памяти должен быть не больше 80 МБ.";
      files.push({...file,uri:target.uri});
    }
    const attachments=await readChatAttachments(files,signal);check();
    return {...material,attachments};
  } catch(e) {
    check();
    // Native error text may contain a private provider URI; do not display it.
    return {...material,attachments:[],chatError:'Не удалось подготовить файлы для чата. Проверьте доступ, формат и лимиты: до 3 файлов по 2 МБ; текст UTF-8 до 24 000 символов.'};
  } finally {
    for(const copy of copies)try{if(copy.exists)copy.delete();}catch{/* App lock may already have removed it. */}
  }
}
