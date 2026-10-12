import * as SecureStore from "expo-secure-store";

export type DirectProvider = "openai" | "openai-compatible" | "anthropic";
export type DirectAgentPreferences = {
  provider: DirectProvider;
  baseUrl: string;
  model: string;
  allowMemory: boolean;
  allowWeb: boolean;
};
export type DirectAgentSettings = DirectAgentPreferences & {
  apiKey: string;
  webSearchKey: string;
};
const LEGACY_KEY = "pia.direct.openai.key.v1";
const CREDENTIAL_PREFIX = "pia.direct.credentials.v2.";
const SEARCH_KEY_PREFIX = "pia.direct.web-search.v1.";
const PREF_PREFIX = "pia.direct.prefs.v1.";
export const DEFAULT_DIRECT_MODEL = "gpt-4.1-mini";
export const defaultDirectPreferences: DirectAgentPreferences = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: DEFAULT_DIRECT_MODEL,
  allowMemory: false,
  allowWeb: false,
};
const keyForProfile = (profile: string) => {
  if (!/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(profile)) throw new Error("invalid_local_profile");
  return profile;
};
const preferenceKey = (profile: string) => PREF_PREFIX + keyForProfile(profile);
const credentialKey = (profile: string) => CREDENTIAL_PREFIX + keyForProfile(profile);
const searchKey = (profile: string) => SEARCH_KEY_PREFIX + keyForProfile(profile);
export const defaultBaseUrl = (provider: DirectProvider): string =>
  provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";

export function validateProvider(value: unknown): DirectProvider {
  if (value !== "openai" && value !== "openai-compatible" && value !== "anthropic") {
    throw new Error("Выберите протокол подключения LLM");
  }
  return value;
}
export function validateBaseUrl(raw: string, provider: DirectProvider): string {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(value || defaultBaseUrl(provider)); }
  catch { throw new Error("Укажите корректный адрес API модели"); }
  const host = url.hostname.toLowerCase();
  const ip = host.split(".").map(Number);
  const privateIP = ip.length === 4 && ip.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (ip[0] === 10 || ip[0] === 127 || (ip[0] === 192 && ip[1] === 168)
      || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31));
  const local = host === "localhost" || host === "[::1]" || privateIP;
  if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !local)
      || url.username || url.password || url.search || url.hash || !url.hostname
      || /\s/.test(value) || value.length > 400) {
    throw new Error("API должен использовать HTTPS (HTTP разрешён только в локальной сети), без пароля и параметров");
  }
  return url.toString().replace(/\/$/, "");
}
export function validateModel(model: string): string {
  const value = model.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:\/-]{0,199}$/.test(value)) {
    throw new Error("Некорректное имя модели");
  }
  return value;
}
function validateSecret(key: string): string {
  const value = key.trim();
  if (!value || value.length > 1024 || /\s/.test(value)) throw new Error("Некорректный API-ключ");
  return value;
}
const identityOf = (settings: Pick<DirectAgentPreferences, "provider" | "baseUrl">) =>
  settings.provider + "|" + validateBaseUrl(settings.baseUrl, settings.provider);

export async function loadDirectSettings(profile: string): Promise<DirectAgentSettings> {
  const [raw, credentialRaw, webSearchKey] = await Promise.all([
    SecureStore.getItemAsync(preferenceKey(profile)),
    SecureStore.getItemAsync(credentialKey(profile)),
    SecureStore.getItemAsync(searchKey(profile)),
  ]);
  let saved: Partial<DirectAgentPreferences> = {};
  try { saved = raw ? JSON.parse(raw) as Partial<DirectAgentPreferences> : {}; }
  catch { /* Never grant memory/search permission when preferences are corrupt. */ }
  const provider = validateProvider(saved.provider ?? "openai");
  const baseUrl = validateBaseUrl(saved.baseUrl ?? defaultBaseUrl(provider), provider);
  const preferences = {
    provider, baseUrl,
    model: typeof saved.model === "string" ? validateModel(saved.model) : DEFAULT_DIRECT_MODEL,
    allowMemory: saved.allowMemory === true, allowWeb: saved.allowWeb === true,
  };
  let apiKey = "";
  try {
    const credential = credentialRaw ? JSON.parse(credentialRaw) as { identity?: string; apiKey?: string } : {};
    if (credential.identity === identityOf(preferences) && typeof credential.apiKey === "string") {
      apiKey = credential.apiKey;
    }
  } catch { /* old/invalid credentials never get sent to another endpoint */ }
  if (!credentialRaw && provider === "openai" && baseUrl === defaultBaseUrl("openai")) {
    apiKey = (await SecureStore.getItemAsync(LEGACY_KEY)) || "";
  }
  return { ...preferences, apiKey, webSearchKey: webSearchKey || "" };
}
export async function saveDirectPreferences(profile: string, prefs: DirectAgentPreferences): Promise<void> {
  const provider = validateProvider(prefs.provider);
  await SecureStore.setItemAsync(preferenceKey(profile), JSON.stringify({
    provider, baseUrl: validateBaseUrl(prefs.baseUrl, provider),
    model: validateModel(prefs.model), allowMemory: prefs.allowMemory === true,
    allowWeb: prefs.allowWeb === true,
  }));
}
export async function saveDirectApiKey(profile: string, key: string, settings: DirectAgentPreferences): Promise<void> {
  await SecureStore.setItemAsync(credentialKey(profile),
    JSON.stringify({ identity: identityOf(settings), apiKey: validateSecret(key) }),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
export async function clearDirectApiKey(profile: string): Promise<void> {
  await SecureStore.deleteItemAsync(credentialKey(profile));
  // The former unscoped OpenAI key must not silently return after removal.
  await SecureStore.deleteItemAsync(LEGACY_KEY);
}
export async function saveWebSearchKey(profile: string, key: string): Promise<void> {
  await SecureStore.setItemAsync(searchKey(profile), validateSecret(key),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
export async function clearWebSearchKey(profile: string): Promise<void> {
  await SecureStore.deleteItemAsync(searchKey(profile));
}
