import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
import Constants from "expo-constants";
import {localMemorySessionUnlocked} from "../local-memory/storage";
import {loadTelegramApiCredentials,loadOrCreateTdlibDbKey,clearTelegramAuthorized} from "./settings";

/** Narrow allowlist. Never expose TDLib's arbitrary request/sending API to JS. */
type NativeTdlib = {
  addListener?(event:string,listener:(value:{state?:unknown})=>void):{remove():void};
  isAvailable(): boolean;
  authorizationState(): string;
  initialize(profile:string,id:number,hash:string,key:string,appVersion:string):Promise<string>;
  cancelAuthorization():Promise<string>;
  submitPhone(value:string):Promise<string>;
  submitCode(value:string):Promise<string>;
  submitPassword(value:string):Promise<string>;
  submitEmail(value:string):Promise<string>;
  submitEmailCode(value:string):Promise<string>;
  logOut():Promise<string>;
  close():Promise<string>;
};
const getNative=():NativeTdlib|null =>
  Platform.OS==="android" ? requireOptionalNativeModule<NativeTdlib>("PersaiTelegramTdlib") : null;

export type TelegramAccountState =
  | "offline"|"starting"
  | "authorizationStateWaitTdlibParameters"
  | "authorizationStateWaitPhoneNumber"|"authorizationStateWaitCode"
  | "authorizationStateWaitPassword"|"authorizationStateWaitEmailAddress"
  | "authorizationStateWaitEmailCode"|"authorizationStateWaitRegistration"
  | "authorizationStateWaitPremiumPurchase"|"authorizationStateWaitOtherDeviceConfirmation"
  | "authorizationStateReady"|"authorizationStateLoggingOut"
  | "authorizationStateClosing"|"authorizationStateClosed"
  | "tdlib_runtime_error"|"unsupported_state";
const states:readonly string[]=[
  "offline","starting","authorizationStateWaitTdlibParameters",
  "authorizationStateWaitPhoneNumber","authorizationStateWaitCode",
  "authorizationStateWaitPassword","authorizationStateWaitEmailAddress",
  "authorizationStateWaitEmailCode","authorizationStateWaitRegistration",
  "authorizationStateWaitPremiumPurchase","authorizationStateWaitOtherDeviceConfirmation",
  "authorizationStateReady","authorizationStateLoggingOut",
  "authorizationStateClosing","authorizationStateClosed","tdlib_runtime_error",
];
export function safeTelegramAccountState(value:unknown):TelegramAccountState{
  return typeof value==="string" && states.includes(value)
    ? value as TelegramAccountState : "unsupported_state";
}
function unlocked():void{
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
}
export function tdlibAvailable():boolean{
  try{return getNative()?.isAvailable()===true;}
  catch{return false;}
}
export function tdlibAccountState():TelegramAccountState{
  if(!tdlibAvailable())return "offline";
  try{return safeTelegramAccountState(getNative()?.authorizationState());}
  catch{return "offline";}
}
/** Only explicit user action may trigger initialization/network. */
export async function initializeTelegramAccount(profile:string):Promise<TelegramAccountState>{
  unlocked();
  const native=getNative();
  if(!native?.isAvailable())throw new Error("telegram_tdlib_binary_missing");
  const credentials=await loadTelegramApiCredentials(profile);
  if(!credentials)throw new Error("telegram_tdlib_api_credentials_missing");
  const dbKey=await loadOrCreateTdlibDbKey(profile);
  unlocked();
  const version=Constants.expoConfig?.version ?? "0";
  const appVersion=/^[0-9A-Za-z.-]{1,32}$/.test(version)?version:"0";
  return safeTelegramAccountState(await native.initialize(profile,credentials.apiId,credentials.apiHash,dbKey,appVersion));
}
/** Accept common phone formatting; the native boundary still validates E.164. */
export function normalizeTelegramPhone(input:string):string{
  const digits=input.replace(/[\s().-]/g,"");
  if(/^8\d{10}$/.test(digits))return "+7"+digits.slice(1);
  if(/^\d{7,15}$/.test(digits))return "+"+digits;
  return digits;
}
type Step="phone"|"code"|"password"|"email"|"emailCode";
export async function completeTelegramAuthorization(step:Step,value:string):Promise<TelegramAccountState>{
  unlocked();
  const native=getNative();
  if(!native?.isAvailable())throw new Error("telegram_tdlib_binary_missing");
  let state:string;
  switch(step){
    case "phone":state=await native.submitPhone(normalizeTelegramPhone(value));break;
    case "code":state=await native.submitCode(value.trim());break;
    case "password":state=await native.submitPassword(value);break;
    case "email":state=await native.submitEmail(value.trim());break;
    case "emailCode":state=await native.submitEmailCode(value.trim());break;
    default:throw new Error("telegram_invalid_auth_step");
  }
  return safeTelegramAccountState(state);
}
export async function cancelTelegramAuthorization(profile:string):Promise<TelegramAccountState>{
  unlocked();
  const native=getNative();
  if(!native?.isAvailable())throw new Error("telegram_tdlib_binary_missing");
  const next=await native.cancelAuthorization();
  await clearTelegramAuthorized(profile);
  // Native logOut may acknowledge before the asynchronous auth-state event.
  return next==="authorizationStateReady" ? "authorizationStateLoggingOut" : safeTelegramAccountState(next);
}
export async function logOutTelegramAccount(profile:string):Promise<TelegramAccountState>{
  unlocked();
  const native=getNative();
  if(!native?.isAvailable())throw new Error("telegram_tdlib_binary_missing");
  const next=await native.logOut();
  await clearTelegramAuthorized(profile);
  return next==="authorizationStateReady" ? "authorizationStateLoggingOut" : safeTelegramAccountState(next);
}
export async function closeTelegramAccount():Promise<TelegramAccountState>{
  const native=getNative();
  if(!native?.isAvailable())return "offline";
  return safeTelegramAccountState(await native.close());
}


/** Observe state-only native events; no phone/code/password crosses this event. */
export function observeTelegramAccountState(onChange:(value:TelegramAccountState)=>void):()=>void{
  const native=getNative();
  if(!native?.addListener)return ()=>{};
  const subscription=native.addListener("onTelegramAuthorizationState",event=>{
    onChange(safeTelegramAccountState(event.state));
  });
  return ()=>subscription.remove();
}
