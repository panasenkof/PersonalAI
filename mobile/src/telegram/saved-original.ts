import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
import {localMemorySessionUnlocked} from "../local-memory/storage";
import {MAX_ORIGINAL_BYTES} from "../media/attachments";
import {mediaKind,type ImportFile} from "../media/kinds";
import {tdlibAvailable,tdlibAccountState} from "./account";
import type {SavedMessagePreview} from "./saved-messages";
import {safeSavedAlbumId} from "./saved-album-plan";

const supported=new Set([
  "messagePhoto","messageDocument","messageVideo","messageAudio",
  "messageVoiceNote","messageAnimation","messageVideoNote",
]);
const id=(value:unknown):value is string=>typeof value==="string" &&
  /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const validProfile=(value:string)=>/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(value);
type NativeSavedOriginal={
  downloadSavedMessageOriginal(profile:string,chatId:string,messageId:string):Promise<string>;
  releaseSavedMessageOriginal(profile:string,chatId:string,messageId:string,uri:string):Promise<string>;
  downloadSavedAlbumOriginal(profile:string,chatId:string,messageId:string,albumId:string):Promise<string>;
  releaseSavedAlbumOriginal(profile:string,chatId:string,messageId:string,albumId:string,uri:string):Promise<string>;
};
const native=():NativeSavedOriginal|null=>Platform.OS==="android"
  ? requireOptionalNativeModule<NativeSavedOriginal>("PersaiTelegramTdlib"):null;

export type SavedOriginal={file:ImportFile;messageId:string;chatId:string;kind:string;date:number;text:string;albumId?:string};
export const supportsSavedOriginal=(kind:string):boolean=>supported.has(kind);

/** Treat native JSON as untrusted. The path must be inside this profile's
 * private TDLib download directory; never accept arbitrary content URIs.
 */
export function parseSavedOriginal(raw:string,profile:string,chatId:string,
  preview:SavedMessagePreview,allowAlbum=false):SavedOriginal {
  if(!validProfile(profile)||!id(chatId)||!id(preview.id)||!supportsSavedOriginal(preview.kind)||
    (allowAlbum?preview.hasAlbum!==true||!safeSavedAlbumId(preview.albumId):preview.hasAlbum===true)||
    typeof raw!=="string"||raw.length>5000)
    throw new Error("telegram_saved_original_invalid");
  let data:unknown;
  try{data=JSON.parse(raw);}catch{throw new Error("telegram_saved_original_invalid");}
  if(!data||typeof data!=="object")throw new Error("telegram_saved_original_invalid");
  const value=data as Partial<SavedOriginal>&{uri?:unknown;name?:unknown;mimeType?:unknown;size?:unknown};
  if(value.chatId!==chatId||value.messageId!==preview.id||value.kind!==preview.kind||
    value.date!==preview.date||value.text!==preview.text||
    (allowAlbum?value.albumId!==preview.albumId:value.albumId!==undefined)||
    typeof value.uri!=="string"||!value.uri.startsWith("file:///")||
    !value.uri.includes("/persai-tdlib-"+profile+"/files/")||
    /[?#\r\n\0]/.test(value.uri)||value.uri.includes("/../")||
    value.uri.includes("/./")||typeof value.name!=="string"||
    !value.name||value.name.length>240||value.name==="."||value.name===".."||
    /[\\/\x00-\x1f]/.test(value.name)||
    typeof value.mimeType!=="string"||
    !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(value.mimeType)||
    !Number.isSafeInteger(value.size)||!(Number(value.size)>0)||
    Number(value.size)>MAX_ORIGINAL_BYTES)
    throw new Error("telegram_saved_original_invalid");
  const file:ImportFile={uri:value.uri,name:value.name,mimeType:value.mimeType,size:value.size as number};
  mediaKind(file); // Only formats supported by the canonical writer are allowed.
  return {file,chatId,messageId:preview.id,kind:preview.kind,date:preview.date,
    text:preview.text,...(allowAlbum?{albumId:preview.albumId}:{}),};
}

/** Restricted self-chat media download. No generic TDLib file API in JS/LLM. */
export async function downloadSavedOriginal(profile:string,chatId:string,
  preview:SavedMessagePreview,signal?:AbortSignal):Promise<SavedOriginal> {
  if(signal?.aborted||!localMemorySessionUnlocked())
    throw new Error("telegram_saved_original_cancelled");
  if(!validProfile(profile)||!id(chatId)||!id(preview.id)||!preview.hasMedia||
    !supportsSavedOriginal(preview.kind)||preview.hasAlbum===true)
    throw new Error("telegram_saved_original_request_invalid");
  if(!tdlibAvailable()||tdlibAccountState()!=="authorizationStateReady")
    throw new Error("telegram_account_not_authorized");
  const module=native();
  if(!module?.downloadSavedMessageOriginal)
    throw new Error("telegram_saved_original_reader_missing");
  const raw=await module.downloadSavedMessageOriginal(profile,chatId,preview.id);
  if(signal?.aborted||!localMemorySessionUnlocked()||
    tdlibAccountState()!=="authorizationStateReady")
    throw new Error("telegram_saved_original_cancelled");
  return parseSavedOriginal(raw,profile,chatId,preview);
}

/** Best-effort cleanup of a specific TDLib cache file, after canonical
 * SQLCipher copy or failed write. Never delete arbitrary filesystem paths.
 * The native gate independently rechecks self-chat, message and file path.
 */
export async function releaseSavedOriginal(profile:string,original:SavedOriginal):Promise<void>{
  if(!validProfile(profile)||!id(original.chatId)||!id(original.messageId)||
    !localMemorySessionUnlocked()||tdlibAccountState()!=="authorizationStateReady")
    return;
  const module=native();
  if(!module)return;
  try{
    if(original.albumId && safeSavedAlbumId(original.albumId) && module.releaseSavedAlbumOriginal)
      await module.releaseSavedAlbumOriginal(profile,original.chatId,
        original.messageId,original.albumId,original.file.uri);
    else if(!original.albumId && module.releaseSavedMessageOriginal)
      await module.releaseSavedMessageOriginal(profile,original.chatId,
        original.messageId,original.file.uri);
  }catch{
    // Do not mask a successfully stored original or a prior DB error.
    // On failed cleanup TDLib's private encrypted-app sandbox still protects
    // files; a later explicit cleanup/retention policy can retry.
  }
}

/** Only original members belonging to a native-projected self Saved album.
 * Neither LLM nor callers can select arbitrary chats, file IDs or URLs.
 */
export async function downloadSavedAlbumOriginal(profile:string,chatId:string,
  preview:SavedMessagePreview,signal?:AbortSignal):Promise<SavedOriginal>{
  if(signal?.aborted||!localMemorySessionUnlocked())
    throw new Error("telegram_saved_original_cancelled");
  if(!validProfile(profile)||!id(chatId)||!id(preview.id)||
    preview.hasAlbum!==true||!safeSavedAlbumId(preview.albumId)||
    !preview.hasMedia||!supportsSavedOriginal(preview.kind))
    throw new Error("telegram_saved_album_original_request_invalid");
  if(!tdlibAvailable()||tdlibAccountState()!=="authorizationStateReady")
    throw new Error("telegram_account_not_authorized");
  const module=native();
  if(!module?.downloadSavedAlbumOriginal)
    throw new Error("telegram_saved_album_native_missing");
  const raw=await module.downloadSavedAlbumOriginal(profile,chatId,preview.id,
    preview.albumId);
  if(signal?.aborted||!localMemorySessionUnlocked()||
    tdlibAccountState()!=="authorizationStateReady")
    throw new Error("telegram_saved_original_cancelled");
  return parseSavedOriginal(raw,profile,chatId,preview,true);
}
