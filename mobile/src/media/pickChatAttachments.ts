import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { withNativeInteraction } from '../security/native-interaction';
import { checkedChatAttachments, MAX_CHAT_FILE_BYTES, MAX_CHAT_FILES, type ChatAttachment } from '../direct-agent/chat-attachments';

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
      if (!size || size > MAX_CHAT_FILE_BYTES) throw new Error('Размер файла должен быть от 1 байта до 2 МБ.');
      const {kind,mime} = chatFileFormat(asset);
      // Bound text reads as well as image reads before bringing bytes into JS.
      if (kind === 'text' && size > 96000) throw new Error('Текстовый файл слишком большой: до 24 000 символов.');
      const data = await FileSystem.readAsStringAsync(asset.uri, {encoding:kind === 'image' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8});
      check();
      files.push({id:Crypto.randomUUID(), name:asset.name.slice(0,240), kind, mime:kind === 'text' ? 'text/plain' : mime, data, size});
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
