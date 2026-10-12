import * as SecureStore from "expo-secure-store";

export type DirectAgentPreferences = {
  model: string;
  allowMemory: boolean;
  allowWeb: boolean;
};
export type DirectAgentSettings = DirectAgentPreferences & { apiKey: string };
const KEY = "pia.direct.openai.key.v1";
const PREF_PREFIX = "pia.direct.prefs.v1.";
export const DEFAULT_DIRECT_MODEL = "gpt-4.1-mini";
export const defaultDirectPreferences: DirectAgentPreferences = {
  model: DEFAULT_DIRECT_MODEL, allowMemory: false, allowWeb: false,
};

const preferenceKey = (profile: string) => {
  if (!/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(profile)) throw new Error("invalid_local_profile");
  return PREF_PREFIX + profile;
};

export function validateModel(model: string): string {
  const value = model.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,99}$/.test(value)) {
    throw new Error("Некорректное имя модели");
  }
  return value;
}

export async function loadDirectSettings(profile: string): Promise<DirectAgentSettings> {
  const [apiKey, raw] = await Promise.all([
    SecureStore.getItemAsync(KEY), SecureStore.getItemAsync(preferenceKey(profile)),
  ]);
  let saved: Partial<DirectAgentPreferences> = {};
  try { saved = raw ? JSON.parse(raw) as Partial<DirectAgentPreferences> : {}; }
  catch { /* safe defaults, never silently grant memory access */ }
  return {
    apiKey: apiKey || "",
    model: typeof saved.model === "string" ? validateModel(saved.model) : DEFAULT_DIRECT_MODEL,
    allowMemory: saved.allowMemory === true,
    allowWeb: saved.allowWeb === true,
  };
}

export async function saveDirectPreferences(profile: string, prefs: DirectAgentPreferences): Promise<void> {
  await SecureStore.setItemAsync(preferenceKey(profile), JSON.stringify({
    model: validateModel(prefs.model),
    allowMemory: prefs.allowMemory === true,
    allowWeb: prefs.allowWeb === true,
  }));
}

export async function saveDirectApiKey(key: string): Promise<void> {
  const value = key.trim();
  if (!value || value.length > 1024 || /\s/.test(value)) throw new Error("Некорректный API-ключ");
  await SecureStore.setItemAsync(KEY, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearDirectApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
