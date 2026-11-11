import * as Crypto from "expo-crypto";
import {Directory,File,Paths} from "expo-file-system";
import type {ImportFile} from "../media/kinds";
import {mediaKind} from "../media/kinds";
import {getTelegramBotFile,TELEGRAM_BOT_MAX_FILE_BYTES,type BotMessage} from "./bot-api";

type TelegramAsset={file_id:string;file_size?:number;file_name?:string;mime_type?:string};
export type PreparedBotOriginal={file:ImportFile;remove:()=>void};
const fileFields=["photo","document","video","audio","voice","animation","video_note"] as const;
const asAsset=(value:unknown):TelegramAsset|null=>{
  if(!value||typeof value!=="object")return null;
  const v=value as Partial<TelegramAsset>;
  return typeof v.file_id==="string"?v as TelegramAsset:null;
};
const safeName=(value:string):string=>value
  .replace(/[\\/:*?"<>|\x00-\x1f]/g,"_").trim().slice(0,180);
function classify(message:BotMessage,allowAlbum:boolean):{asset:TelegramAsset;name:string;mime:string}|null{
  if(message.media_group_id&&!allowAlbum)
    throw new Error("Telegram-альбом пока нельзя подтвердить без всех файлов. Импорт остановлен без потери сообщения.");
  const kinds=fileFields.filter(kind=>Boolean(message[kind]));
  if(!kinds.length)return null;
  if(kinds.length!==1)throw new Error("Неоднозначный тип вложения Telegram. Импорт остановлен.");
  const kind=kinds[0];
  let asset:TelegramAsset|null;
  if(kind==="photo"){
    if(!Array.isArray(message.photo)||!message.photo.length)
      throw new Error("Telegram прислал фотографию без файла. Импорт остановлен.");
    const variants=message.photo.map(asAsset).filter((v):v is TelegramAsset=>v!==null);
    if(!variants.length)throw new Error("Telegram прислал фотографию без ID. Импорт остановлен.");
    asset=[...variants].sort((a,b)=>(b.file_size||0)-(a.file_size||0))[0];
  }else asset=asAsset(message[kind]);
  if(!asset)throw new Error("У медиа Telegram нет подтверждённого ID файла.");
  const defaults:Record<typeof kind,{name:string;mime:string}>={
    photo:{name:"photo.jpg",mime:"image/jpeg"},
    document:{name:"document.pdf",mime:"application/pdf"},
    video:{name:"video.mp4",mime:"video/mp4"},
    audio:{name:"audio.mp3",mime:"audio/mpeg"},
    voice:{name:"voice.ogg",mime:"audio/ogg"},
    animation:{name:"animation.mp4",mime:"video/mp4"},
    video_note:{name:"video_note.mp4",mime:"video/mp4"},
  };
  const defaultFile=defaults[kind];
  // A missing original document filename must not be invented as a PDF.
  if(kind==="document"&&!(asset.file_name||asset.mime_type))
    throw new Error("Telegram не сообщил формат документа. Импорт остановлен без потери оригинала.");
  let name=safeName(asset.file_name||defaultFile.name);
  const mime=typeof asset.mime_type==="string"&&/^[\w.+-]+\/[\w.+-]+$/.test(asset.mime_type)
    ? asset.mime_type:defaultFile.mime;
  if(kind==="document"&&!asset.file_name) {
    const ext=mime==="application/pdf"?"pdf":mime==="text/plain"?"txt":null;
    if(!ext)throw new Error("Этот формат документа пока не поддерживается.");
    name="document."+ext;
  }
  const selected={uri:"file:///placeholder",name,mimeType:mime};
  mediaKind(selected);
  if(asset.file_size!==undefined&&(!Number.isSafeInteger(asset.file_size)||
    asset.file_size<=0||asset.file_size>TELEGRAM_BOT_MAX_FILE_BYTES))
    throw new Error("Telegram-файл превышает доступный лимит 20 МБ или имеет неверный размер.");
  return {asset,name,mime};
}

/** Download one real original into the app-private cache, never store the Bot
 * API URL or token in notes. The caller MUST remove() after saveMediaNote.
 * No ACK/cursor advance on download, validation or SQLCipher failure.
 */
export async function prepareBotOriginal(token:string,message:BotMessage,
  external?:AbortSignal,allowAlbum=false):Promise<PreparedBotOriginal|null>{
  const chosen=classify(message,allowAlbum);
  if(!chosen)return null;
  if(external?.aborted)throw new Error("Импорт Telegram отменён.");
  const remote=await getTelegramBotFile(token,chosen.asset.file_id,external);
  if(external?.aborted)throw new Error("Импорт Telegram отменён.");
  // Reuse the already AppLock-cleared private incoming cache, not a second staging store.
  const directory=new Directory(Paths.cache,"persai-incoming");
  directory.create({idempotent:true,intermediates:true});
  const suffix=chosen.name.split(".").pop()?.toLowerCase()||"bin";
  const file=new File(directory,Crypto.randomUUID()+"."+suffix);
  const controller=new AbortController();
  const abort=()=>controller.abort();
  external?.addEventListener("abort",abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  let oversized=false;
  const remove=()=>{try{if(file.exists)file.delete();}catch{/* app-private cache cleanup */}};
  try{
    if(external?.aborted)throw new Error("Импорт Telegram отменён.");
    timer=setTimeout(()=>controller.abort(),60_000);
    const url="https://api.telegram.org/file/bot"+token+"/"+remote.path;
    const fileResult=await File.downloadFileAsync(url,file,{
      signal:controller.signal,
      onProgress:p=>{
        if(p.bytesWritten>TELEGRAM_BOT_MAX_FILE_BYTES||
          (p.totalBytes>0&&p.totalBytes>TELEGRAM_BOT_MAX_FILE_BYTES)){
          oversized=true;
          controller.abort();
        }
      },
    });
    if(external?.aborted)throw new Error("Импорт Telegram отменён.");
    if(oversized)throw new Error("Файл Telegram превышает лимит 20 МБ.");
    const size=fileResult.size;
    if(!fileResult.exists||size<=0||size>TELEGRAM_BOT_MAX_FILE_BYTES||
      (remote.size!==null&&size!==remote.size))
      throw new Error("Размер скачанного оригинала Telegram не совпал с проверенным.");
    return {file:{uri:fileResult.uri,name:chosen.name,mimeType:chosen.mime,size},remove};
  }catch(e){
    remove();
    if(external?.aborted)throw new Error("Импорт Telegram отменён.");
    if(oversized)throw new Error("Файл Telegram превышает лимит 20 МБ.");
    if(e instanceof Error&&/^(Telegram|Этот формат|Импорт Telegram|Размер скачанного)/.test(e.message))
      throw e;
    // Never leak the token-bearing URL in a native download exception.
    throw new Error("Не удалось скачать оригинал Telegram. Проверьте сеть/VPN и повторите.");
  }finally{
    if(timer!==undefined)clearTimeout(timer);
    external?.removeEventListener("abort",abort);
  }
}
