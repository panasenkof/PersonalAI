import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
import {localMemorySessionUnlocked} from "../local-memory/storage";
import {loadTelegramApiCredentials,loadOrCreateTdlibDbKey} from "./settings";

/** Narrow allowlist. Never expose TDLib's arbitrary request/sending API to JS. */
type NativeTdlib = {
  isAvailable(): boolean;
  authorizationState(): string;
  initialize(profile:string,id:number,hash:string,key:string):Promise<string>;
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
  return safeTelegramAccountState(await native.initialize(profile,credentials.apiId,credentials.apiHash,dbKey));
}
type Step="phone"|"code"|"password"|"email"|"emailCode";
export async function completeTelegramAuthorization(step:Step,value:string):Promise<TelegramAccountState>{
  unlocked();
  const native=getNative();
  if(!native?.isAvailable())throw new Error("telegram_tdlib_binary_missing");
  let state:string;
  switch(step){
    case "phone":state=await native.submitPhone(value);break;
    case "code":state=await native.submitCode(value);break;
    case "password":state=await native.submitPassword(value);break;
    case "email":state=await native.submitEmail(value);break;
    case "emailCode":state=await native.submitEmailCode(value);break;
    default:throw new Error("telegram_invalid_auth_step");
  }
  return safeTelegramAccountState(state);
}
export async function logOutTelegramAccount():Promise<TelegramAccountState>{
  unlocked();
  const native=getNative();
  if(!native?.isAvailable())throw new Error("telegram_tdlib_binary_missing");
  return safeTelegramAccountState(await native.logOut());
}
export async function closeTelegramAccount():Promise<TelegramAccountState>{
  const native=getNative();
  if(!native?.isAvailable())return "offline";
  return safeTelegramAccountState(await native.close());
}
