import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
import {localMemorySessionUnlocked} from "../local-memory/storage";
import {tdlibAvailable,tdlibAccountState} from "./account";

/** Safe read-only projection; never arbitrary chat-read tools or raw TDLib JSON. */
export type SavedMessagePreview = {
  id:string; date:number; kind:string; text:string; hasMedia:boolean; hasAlbum?:boolean; albumId?:string;
};
export type SavedMessagesPage = {
  selfChatId:string; messages:SavedMessagePreview[]; nextCursor:string;
};
type NativeSavedMessages = {
  getSavedMessagesPage(profile:string,cursor:string,limit:number):Promise<string>;
};
const getNative=():NativeSavedMessages|null =>
  Platform.OS==="android"
    ? requireOptionalNativeModule<NativeSavedMessages>("PersaiTelegramTdlib") : null;
const positiveId=(v:unknown):v is string =>
  typeof v==="string" && /^[1-9][0-9]{0,15}$/.test(v) &&
    Number.isSafeInteger(Number(v)) && Number(v)>0;
const cursorId=(v:unknown):v is string=>v==="0"||positiveId(v);

export function parseSavedMessagesPage(raw:string,cursor:string,limit:number):SavedMessagesPage{
  if(!Number.isSafeInteger(limit)||limit<1||limit>20||!cursorId(cursor))
    throw new Error("telegram_saved_request_invalid");
  if(typeof raw!=="string"||raw.length>2_000_000)
    throw new Error("telegram_saved_page_invalid");
  let payload:unknown;
  try{payload=JSON.parse(raw);}catch{throw new Error("telegram_saved_page_invalid");}
  if(!payload||typeof payload!=="object")throw new Error("telegram_saved_page_invalid");
  const page=payload as Partial<SavedMessagesPage>;
  if(!positiveId(page.selfChatId)||!Array.isArray(page.messages)||page.messages.length>limit||
     (page.nextCursor!==""&&!positiveId(page.nextCursor)))
    throw new Error("telegram_saved_page_invalid");
  let previous=cursor==="0"?Number.MAX_SAFE_INTEGER:Number(cursor);
  const messages:SavedMessagePreview[]=[];
  for(const item of page.messages){
    if(!item||!positiveId(item.id)||!Number.isSafeInteger(item.date)||item.date<0||
       typeof item.kind!=="string"||item.kind.length>80||
       typeof item.text!=="string"||item.text.length>60000||
       typeof item.hasMedia!=="boolean"||
       (item.hasAlbum!==undefined&&typeof item.hasAlbum!=="boolean")||
       (item.albumId!==undefined&&(!item.hasAlbum||typeof item.albumId!=="string"||
          !/^-?[1-9][0-9]{0,18}$/.test(item.albumId))))
      throw new Error("telegram_saved_item_invalid");
    const id=Number(item.id);
    if(id>previous)throw new Error("telegram_saved_order_invalid");
    if(id===previous && cursor==="0")throw new Error("telegram_saved_order_invalid");
    // TDLib can repeat the page anchor when from_message_id is specified.
    if(id===previous && cursor!=="0")continue;
    previous=id;
    messages.push({id:item.id,date:item.date,kind:item.kind,
      text:item.text,hasMedia:item.hasMedia,
      ...(item.hasAlbum!==undefined?{hasAlbum:item.hasAlbum}:{}),
      ...(item.albumId!==undefined?{albumId:item.albumId}:{}),});
  }
  // Native last raw ID may be the existing anchor; zero-progress pages are terminal,
  // never cause infinite loops or turn read-only pagination into a write cursor.
  if(page.messages.length && page.nextCursor!==page.messages[page.messages.length-1].id)
    throw new Error("telegram_saved_cursor_mismatch");
  return {selfChatId:page.selfChatId,messages,
    nextCursor:messages.length?messages[messages.length-1].id:""};
}

/** Explicitly requested user read; no automatic save and no LLM/external upload. */
export async function readSavedMessagesPage(profile:string,cursor="0",limit=20):Promise<SavedMessagesPage>{
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
  if(!/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(profile))
    throw new Error("telegram_saved_profile_invalid");
  if(!cursorId(cursor)||!Number.isSafeInteger(limit)||limit<1||limit>20)
    throw new Error("telegram_saved_request_invalid");
  if(!tdlibAvailable()||tdlibAccountState()!=="authorizationStateReady")
    throw new Error("telegram_account_not_authorized");
  const native=getNative();
  if(!native?.getSavedMessagesPage)throw new Error("telegram_saved_reader_missing");
  const raw=await native.getSavedMessagesPage(profile,cursor,limit);
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
  return parseSavedMessagesPage(raw,cursor,limit);
}
