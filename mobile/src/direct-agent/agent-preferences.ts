import * as SecureStore from "expo-secure-store";
import { DEFAULT_MODEL_CALL_LIMIT, validateModelCallLimit } from "./limits";

/** A device-profile preference, shared by all of its model connections. */
const key = (profile: string) => {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(profile)) throw new Error("invalid_local_profile");
  return "pia.agent.call-limit.v1." + profile;
};
export async function loadModelCallLimit(profile: string): Promise<number> {
  const raw = await SecureStore.getItemAsync(key(profile));
  if (!raw) return DEFAULT_MODEL_CALL_LIMIT;
  try { return validateModelCallLimit(JSON.parse(raw)); }
  catch { throw new Error("Не удалось прочитать лимит обращений к LLM. Сохраните его заново в настройках."); }
}
export async function saveModelCallLimit(profile: string, limit: number): Promise<void> {
  await SecureStore.setItemAsync(key(profile), JSON.stringify(validateModelCallLimit(limit)));
}
