import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { File, FileMode } from 'expo-file-system';
import { extractPdfPages, pdfCoverageMessage } from './pdf-pages';
import { getWhisperStatus, initWhisper, transcribeAudioFile } from './whisper';
import { localMemorySessionUnlocked } from '../local-memory/storage';
import { withNativeInteraction } from '../security/native-interaction';
import { chatAttachmentAdmissionIssue, checkedChatAttachments, MAX_CHAT_FILE_BYTES, MAX_CHAT_IMAGE_SOURCE_BYTES, MAX_CHAT_FILES, type ChatAttachment } from '../direct-agent/chat-attachments';

/** Per-file picker failures never become chat attachments. The user can
 * select only failed files again; already accepted ones remain in the draft.
 * Share uses the existing strict readChatAttachments path until its own UI
 * can display failures per material (H3).
 */
export type ChatFileFailure = {name:string; reason:string};
export type ChatFilePickResult = {files:ChatAttachment[]; failures:ChatFileFailure[]};

/** Stable, privacy-safe diagnostics for picker and Android Share. */
export function safeChatFileFailure(error:unknown):string {
  const message=error instanceof Error ? error.message : "";
  // Only fixed human-readable phrases reach the UI. Never leak a provider URI,
  // a local cache path or an arbitrary native exception.
  if (message.includes("Whisper") || message.includes("Модель распознавания")) return "Для аудио скачайте локальную модель Whisper в настройках голосового ввода.";
  if (message.includes("20 МБ")) return "Аудиофайл превышает 20 МБ.";
  if (message.includes("Нет распознанной речи")) return "В аудио не удалось распознать речь.";
  if (message.includes("Текст записи превышает")) return "Расшифровка превышает временный лимит чата 24 000 символов, а не предел выбранной ИИ-модели. Расшифровка не добавлена.";
  if (message.includes("Длительность записи")) return "Запись длиннее 20 минут или длительность неизвестна.";
  if (message.includes("не удалось прочитать аудиофайл")) return "Не удалось прочитать аудио или кодек не поддерживается.";
  if (message.includes("не является PDF")) return "Файл не является настоящим PDF.";
  if (message.includes("текстовый слой")) return "В PDF нет читаемого текстового слоя.";
  if (message.includes("защищён паролем")) return "PDF защищён паролем.";
  if (message.includes("6 МБ")) return "PDF превышает 6 МБ.";
  if (message.includes("24 000")) return "Временный лимит текущего режима чата — 24 000 символов; это не лимит ИИ-модели. Файл не прикреплён.";
  if (message.includes("80 МБ")) return "Фотография превышает 80 МБ.";
  // The unsupported-format diagnostic mentions UTF-8 as an allowed format;
  // classify the full error before looking for a true text decoding failure.
  if (message.includes("В чат можно прикрепить") || message.includes("не поддерживается"))
    return "Формат файла не поддерживается в чате.";
  if (message.includes("UTF-8")) return "Не удалось прочитать текстовый файл UTF-8.";
  if (message.includes("Чтение страниц PDF") || message.includes("системным средством") ||
      message.includes("системного извлечения текста PDF"))
    return "Чтение PDF недоступно на этом устройстве.";
  return "Не удалось подготовить файл. Проверьте формат и доступ.";
}

/** Strict legacy picker: unchanged contract for existing callers and tests. */
export async function pickChatAttachments(signal: AbortSignal): Promise<ChatAttachment[]> {
  return (await pickChatAttachmentsInternal(signal, false)).files;
}

/** H2: tolerate an invalid item without losing other selected files.
 * Nothing is sent to an LLM until the normal chat Send action.
 */
export async function pickChatAttachmentsWithResults(signal:AbortSignal, onAudioPreparing?:()=>void):Promise<ChatFilePickResult> {
  return pickChatAttachmentsInternal(signal,true,onAudioPreparing);
}

async function pickChatAttachmentsInternal(signal:AbortSignal, isolated:boolean,onAudioPreparing?:()=>void):Promise<ChatFilePickResult> {
  let assets: DocumentPicker.DocumentPickerAsset[] = [];
  const check = () => { if (signal.aborted || !localMemorySessionUnlocked()) throw new Error('Выбор файлов прерван.'); };
  try {
    check();
    await withNativeInteraction(async () => {
      const result = await DocumentPicker.getDocumentAsync({ type:['image/jpeg','image/png','image/webp','text/*','application/json','application/pdf','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/flac','audio/aac'], multiple:true, copyToCacheDirectory:true });
      if (!result.canceled) assets = result.assets;
    });
    check();
    if(!isolated) return {files:await readChatAttachments(assets,signal,true),failures:[]};
    if(assets.length>MAX_CHAT_FILES) throw new Error('К сообщению можно прикрепить до 3 файлов.');
    const files:ChatAttachment[] = [], failures:ChatFileFailure[] = [];
    for(const asset of assets){
      check();
      try {
        // Use the SAME validation, format reader, and transport budget as the
        // strict path. Checking the aggregate here prevents a later invalid
        // item from discarding earlier valid selections.
        if(chatFileFormat(asset).kind==='audio')onAudioPreparing?.();
        const [file]=await readChatAttachments([asset],signal,true);
        check();
        const reason=chatAttachmentAdmissionIssue(files,file);
        if(reason) { failures.push({name:asset.name.replace(/[\r\n\t]/g,' ').slice(0,90),reason}); continue; }
        files.push(file);
      } catch(error) {
        check(); // Lock/abort is global; never report it as an item error.
        failures.push({name:asset.name.replace(/[\r\n\t]/g,' ').slice(0,90),reason:safeChatFileFailure(error)});
      }
    }
    return {files,failures};
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
export async function readChatAttachments(assets: Array<{uri:string; name:string; mimeType?:string|null}>, signal: AbortSignal, allowLocalAudio=false): Promise<ChatAttachment[]> {
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
      if (kind === 'audio' && !allowLocalAudio)
        throw new Error('Аудио из Android Share нельзя распознавать автоматически. Выберите файл в чате после открытия PersAI.');
      if (kind === 'audio' && size > 20*1024*1024)
        throw new Error('Аудиофайл превышает 20 МБ. Оригинал можно сохранить в память.');
      if (kind === 'pdf' && size > MAX_CHAT_FILE_BYTES)
        throw new Error('Для чата выберите PDF до 6 МБ. Большой документ сохраните в память.');
      // Bound text reads as well as image reads before bringing bytes into JS.
      if (kind === 'text' && size > 96000) throw new Error('Текстовый файл слишком большой: до 24 000 символов.');
      const prepared = kind === 'image'
        ? await prepareChatPhoto(asset.uri,size,signal)
        : {uri:asset.uri,mime:"",temporary:false};
      try {
        check();
        const data = kind === 'pdf'
          ? await pdfChatText(asset.uri, asset.name, signal)
          : kind === 'audio' ? await localAudioChatText(asset.uri, signal)
          : await FileSystem.readAsStringAsync(prepared.uri, {encoding:kind === 'image' ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8});
        check();
        files.push({id:Crypto.randomUUID(), name:kind === 'pdf' ? ('Текст PDF: ' + asset.name).slice(0,240)
            : kind === 'audio' ? ('Транскрипт аудио: '+asset.name).slice(0,240) : asset.name.slice(0,240),
          kind:kind === 'pdf' || kind === 'audio' ? 'text' : kind,
          mime:kind === 'text' || kind === 'pdf' || kind === 'audio' ? 'text/plain' : prepared.mime || mime, data,
          size:kind === 'image' ? new File(prepared.uri).size : kind === 'pdf' || kind === 'audio' ? data.length * 3 : size});
      } finally {
        if(prepared.temporary)try {const f=new File(prepared.uri);if(f.exists)f.delete();}catch {}
      }
    }
    return checkedChatAttachments(files);
}

/** Audio is decoded and transcribed only on the phone after explicit file selection.
 * No network, no original file in a chat snapshot, no inferred timestamps.
 * Android Share does not call this path without its own opt-in flow.
 */
async function localAudioChatText(uri:string, signal:AbortSignal):Promise<string> {
  if (signal.aborted || !localMemorySessionUnlocked())throw new Error('Выбор файлов прерван.');
  await initWhisper();
  if (signal.aborted || !localMemorySessionUnlocked())throw new Error('Выбор файлов прерван.');
  if (getWhisperStatus().state!=='ready')throw new Error('Модель распознавания Whisper не скачана. Скачайте её в настройках.');
  const recognized=await transcribeAudioFile(uri,signal);
  if (signal.aborted || !localMemorySessionUnlocked())throw new Error('Выбор файлов прерван.');
  if (!recognized.trim())throw new Error('Нет распознанной речи.');
  const text='Локальная расшифровка Whisper. Возможны ошибки распознавания. Оригинальное аудио не отправляется модели.\n\n'+recognized;
  if (text.length>24_000)throw new Error('Текст записи превышает 24 000 символов для чата. Разделите аудио на части.');
  return text;
}

/** A PDF is sent only as explicit extracted text. The original file is NEVER
 * embedded in a chat block and the user must still press Send.
 */
async function pdfChatText(uri: string, name: string, signal: AbortSignal): Promise<string> {
  const file = new File(uri);
  const handle = file.open(FileMode.ReadOnly);
  try {
    const head = handle.readBytes(5);
    if (head.length !== 5 || String.fromCharCode(...head) !== '%PDF-')
      throw new Error('Выбранный файл не является PDF. Проверьте формат и повторите выбор.');
  } finally { handle.close(); }
  if (signal.aborted || !localMemorySessionUnlocked()) throw new Error('Выбор файлов прерван.');
  const pages = await extractPdfPages({uri,name,mimeType:'application/pdf'},signal);
  if (signal.aborted || !localMemorySessionUnlocked()) throw new Error('Выбор файлов прерван.');
  const text = 'Только извлечённый текст PDF. Исходный файл в модель не отправляется.\n' +
    pdfCoverageMessage(pages) + '\n\n' + pages.text;
  if (text.length > 24_000)
    throw new Error('Извлечённый текст PDF превышает общий лимит чата 24 000 символов. Разделите документ; текст не обрезан.');
  return text;
}

export function chatFileFormat(asset: {name:string; mimeType?:string|null}): {kind:'image'|'text'|'pdf'|'audio';mime:string} {
  const ext=asset.name.split('.').pop()?.toLowerCase();
  const declared=asset.mimeType || '';
  const mime=(!declared || declared==='application/octet-stream') ? ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',pdf:'application/pdf'} as Record<string,string>)[ext || ''] || declared : declared;
  // An extension or declared PDF MIME never passes through the UTF-8 reader:
  // the actual magic bytes and native parser must both accept the original.
  if (ext === 'pdf' || declared === 'application/pdf') return {kind:'pdf',mime:'application/pdf'};
  const audioExts=['mp3','m4a','wav','ogg','flac','aac'];
  const audioMime=['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/ogg','audio/flac','audio/aac','audio/x-aac'];
  if(audioExts.includes(ext || '') || audioMime.includes(declared))return {kind:'audio',mime:declared||'audio/mpeg'};
  if (['image/jpeg','image/png','image/webp'].includes(mime)) return {kind:'image',mime};
  if (mime.startsWith('text/') || mime==='application/json' || ['txt','md','csv','json','log','srt','vtt'].includes(ext || '')) return {kind:'text',mime:'text/plain'};
  throw new Error('В чат можно прикрепить фото JPEG/PNG/WebP, текст UTF-8, PDF с текстовым слоем или аудио через локальный Whisper. Видео пока доступно в памяти.');
}
