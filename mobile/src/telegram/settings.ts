import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import {fromByteArray, toByteArray} from "base64-js";

/** Only preferences and TDLib app credentials; this does not authorize a Telegram user. */
export type TelegramSyncMode = "manual" | "on_open";
const checked = (profile: string) => {
  if (!/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(profile)) throw new Error("invalid_local_profile");
  return profile;
};
const modeKey = (p: string) => "pia.telegram.sync.v1." + checked(p);
const apiKey = (p: string) => "pia.telegram.tdlib.api.v1." + checked(p);

export function validateTelegramSyncMode(value: unknown): TelegramSyncMode {
  if (value !== "manual" && value !== "on_open") throw new Error("invalid_telegram_sync_mode");
  return value;
}
/** Corrupted/unset settings NEVER enable automatic network requests. */
export async function loadTelegramSyncMode(profile: string): Promise<TelegramSyncMode> {
  return await SecureStore.getItemAsync(modeKey(profile)) === "on_open" ? "on_open" : "manual";
}
export async function saveTelegramSyncMode(profile: string, mode: TelegramSyncMode): Promise<void> {
  await SecureStore.setItemAsync(modeKey(profile), validateTelegramSyncMode(mode), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export type TelegramApiCredentials = { apiId: number; apiHash: string };
export function validateTelegramApiCredentials(idInput: string, hashInput: string): TelegramApiCredentials {
  const id = idInput.trim(), hash = hashInput.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(id) || Number(id) > 2147483647)
    throw new Error("Укажите корректный Telegram API ID.");
  if (!/^[0-9a-fA-F]{32}$/.test(hash))
    throw new Error("Telegram API hash должен содержать 32 шестнадцатеричных символа.");
  return {apiId: Number(id), apiHash: hash.toLowerCase()};
}
export async function saveTelegramApiCredentials(profile: string, idInput: string, hashInput: string): Promise<void> {
  const parsed = validateTelegramApiCredentials(idInput, hashInput);
  await SecureStore.setItemAsync(apiKey(profile), JSON.stringify(parsed), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
/** UI can display non-secret metadata only. */
export async function inspectTelegramApiCredentials(profile: string): Promise<{apiId: number | null; configured: boolean}> {
  const credentials = await loadTelegramApiCredentials(profile);
  return {apiId: credentials?.apiId ?? null, configured: !!credentials};
}
/** Native TDLib boundary will consume this; never render or log apiHash. */
export async function loadTelegramApiCredentials(profile: string): Promise<TelegramApiCredentials | null> {
  const raw = await SecureStore.getItemAsync(apiKey(profile));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TelegramApiCredentials>;
    return validateTelegramApiCredentials(String(value.apiId ?? ""), String(value.apiHash ?? ""));
  } catch { return null; }
}
export async function clearTelegramApiCredentials(profile: string): Promise<void> {
  await SecureStore.deleteItemAsync(apiKey(profile));
}


/**
 * A distinct device-bound 256-bit key for TDLib's encrypted database.
 * NEVER exported in the portable PersAI backup or coupled to its SQLCipher key.
 * Corruption must stop initialization rather than silently destroy a session.
 */
const tdlibDbKey=(p:string)=>"pia.telegram.tdlib.dbkey.v1."+checked(p);
const pendingTdlibKeys=new Map<string,Promise<string>>();
export function tdlibKeyIsValid(value:string):boolean {
  try{return /^[A-Za-z0-9+/]{43}=$/.test(value) && toByteArray(value).length===32;}
  catch{return false;}
}
export function loadOrCreateTdlibDbKey(profile:string):Promise<string>{
  checked(profile);
  const pending=pendingTdlibKeys.get(profile);
  if(pending)return pending;
  const next=(async()=>{
    const existing=await SecureStore.getItemAsync(tdlibDbKey(profile));
    if(existing!==null){
      if(!tdlibKeyIsValid(existing))throw new Error("tdlib_device_key_corrupted");
      return existing;
    }
    const created=fromByteArray(Crypto.getRandomBytes(32));
    if(!tdlibKeyIsValid(created))throw new Error("tdlib_device_key_invalid");
    await SecureStore.setItemAsync(tdlibDbKey(profile),created,{
      keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return created;
  })();
  pendingTdlibKeys.set(profile,next);
  void next.finally(()=>{if(pendingTdlibKeys.get(profile)===next)pendingTdlibKeys.delete(profile);}).catch(()=>{});
  return next;
}


/** Automatic resumption is allowed only for a previously started local TDLib session.
 * This checks device-only metadata, never reveals the encryption key to callers.
 */
export async function hasExistingTdlibDbKey(profile:string):Promise<boolean>{
  const stored=await SecureStore.getItemAsync(tdlibDbKey(profile));
  if(stored===null)return false;
  if(!tdlibKeyIsValid(stored))throw new Error("tdlib_device_key_corrupted");
  return true;
}


/** An explicit successful login marker; unlike a leftover database key, this is
 * removed on logout and is never part of a portable backup. */
const authorizedKey=(p:string)=>"pia.telegram.tdlib.authorized.v1."+checked(p);
export async function markTelegramAuthorized(profile:string):Promise<void>{
  await SecureStore.setItemAsync(authorizedKey(profile),"1",{
    keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
export async function clearTelegramAuthorized(profile:string):Promise<void>{
  await SecureStore.deleteItemAsync(authorizedKey(profile));
}
export async function wasTelegramAuthorized(profile:string):Promise<boolean>{
  return await SecureStore.getItemAsync(authorizedKey(profile))==="1";
}


// Telegram automatic sync cursors/results are device-local and never backed up.
const savedWatermarkKey=(p:string)=>"pia.telegram.saved.watermark.v1."+checked(p);
const lastAutoSyncKey=(p:string)=>"pia.telegram.autosync.last.v1."+checked(p);
export type SavedWatermark={selfChatId:string;maxMessageId:string};
export type TelegramAutoSyncResult={
  at:string;saved:number;duplicates:number;unsupported:number;gap:boolean;
  botImported:number;botSkipped:number;error:""|"telegram_app_locked"|"network"|"other";
};
const validTelegramMessageId=(v:unknown):v is string=>
  typeof v==="string"&&/^[1-9][0-9]{0,15}$/.test(v)&&Number.isSafeInteger(Number(v));
const validCounter=(v:unknown):v is number=>typeof v==="number"&&
  Number.isSafeInteger(v)&&v>=0&&v<=1000000;
export async function loadSavedWatermark(profile:string):Promise<SavedWatermark|null>{
  const raw=await SecureStore.getItemAsync(savedWatermarkKey(profile));
  if(!raw)return null;
  try{
    const v=JSON.parse(raw) as SavedWatermark;
    return validTelegramMessageId(v.selfChatId)&&validTelegramMessageId(v.maxMessageId)?v:null;
  }catch{return null;}
}
export async function saveSavedWatermark(profile:string,value:SavedWatermark):Promise<void>{
  if(!validTelegramMessageId(value.selfChatId)||!validTelegramMessageId(value.maxMessageId))
    throw new Error("telegram_saved_watermark_invalid");
  await SecureStore.setItemAsync(savedWatermarkKey(profile),JSON.stringify(value),{
    keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
export async function loadLastTelegramAutoSync(profile:string):Promise<TelegramAutoSyncResult|null>{
  const raw=await SecureStore.getItemAsync(lastAutoSyncKey(profile));
  if(!raw)return null;
  try{
    const v=JSON.parse(raw) as TelegramAutoSyncResult;
    if(!v||typeof v.at!=="string"||!Number.isFinite(Date.parse(v.at))||
      !validCounter(v.saved)||!validCounter(v.duplicates)||!validCounter(v.unsupported)||
      !validCounter(v.botImported)||!validCounter(v.botSkipped)||typeof v.gap!=="boolean"||
      !["","telegram_app_locked","network","other"].includes(v.error))return null;
    return v;
  }catch{return null;}
}
export async function saveLastTelegramAutoSync(profile:string,value:TelegramAutoSyncResult):Promise<void>{
  await SecureStore.setItemAsync(lastAutoSyncKey(profile),JSON.stringify(value),{
    keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
