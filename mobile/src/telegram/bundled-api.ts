import Constants from "expo-constants";
import {validateTelegramApiCredentials,type TelegramApiCredentials} from "./settings";

/**
 * Application identity, not a per-user login token.
 *
 * Injected into the signed Expo bundle only from the trusted release job.
 * An APK recipient can inspect embedded bytes. Never treat api_hash as an
 * unextractable secret or log it, and never accept app credentials over HTTP.
 */
export function bundledTelegramApiCredentials():TelegramApiCredentials|null{
  const raw:unknown=Constants.expoConfig?.extra?.persaiTelegramApi;
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const value=raw as Record<string,unknown>;
  if(!Number.isSafeInteger(value.apiId)||typeof value.apiHash!=="string")return null;
  try{
    return validateTelegramApiCredentials(String(value.apiId),value.apiHash);
  }catch{return null;}
}
