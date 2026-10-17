import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { savedMemoryProfile } from "../security/active-profile";

export type DirectProvider = "openai" | "openai-compatible" | "anthropic";
export type DirectAgentPreferences = {
  provider: DirectProvider;
  baseUrl: string;
  model: string;
  allowWeb: boolean;
  transcriptionModel?: string;
  searchProvider?: SearchProvider;
  /** Yandex Cloud folder ID for Yandex Search API; not a secret. */
  searchFolderId?: string;
};
export type SearchProvider = "tavily" | "yandex" | "deepseek" | "builtin";
export const SEARCH_PROVIDERS: SearchProvider[] = ["tavily", "yandex", "deepseek", "builtin"];
/** Bing ("public") and Brave were removed: a saved choice becomes Tavily, and a
 * Brave key is never sent to another service. */
export function migrateSearchProvider(value: unknown): { provider: SearchProvider; dropKey: boolean } {
  if (value === "tavily" || value === "yandex" || value === "deepseek" || value === "builtin") return { provider: value, dropKey: false };
  return { provider: "tavily", dropKey: value === "brave" || value === undefined };
}
const validFolder = (value: unknown) => typeof value === "string" && /^[a-z0-9]{1,50}$/i.test(value.trim()) ? value.trim() : "";
export type DirectAgentSettings = DirectAgentPreferences & {
  apiKey: string;
  /** Key of the selected search service (kept in step with `searchKeys`). */
  webSearchKey: string;
  /** One key per search service; switching services keeps each key. */
  searchKeys?: SearchKeys;
};
export type KeyedSearch = "tavily" | "yandex" | "deepseek";
export type SearchKeys = Partial<Record<KeyedSearch, string>>;
/** The stored search secret: JSON with one key per service, or (before October
 * 2026) a bare key that belonged to the connection's selected service. */
export function parseSearchKeys(raw: string | null, provider: SearchProvider): SearchKeys {
  if (!raw) return {};
  if (raw.startsWith("{")) try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const keys: SearchKeys = {};
    for (const id of ["tavily", "yandex", "deepseek"] as const) if (typeof data[id] === "string" && data[id]) keys[id] = data[id] as string;
    return keys;
  } catch { return {}; }
  return provider === "tavily" || provider === "yandex" ? { [provider]: raw } : {};
}
/** The key for the selected search service, never another service's key.
 * DeepSeek search may use the connection's own key when the connection is
 * DeepSeek itself: the same account pays for both. */
export function searchKeyOf(settings: Pick<DirectAgentSettings, "searchKeys" | "webSearchKey"> & Partial<Pick<DirectAgentSettings, "apiKey" | "baseUrl">>, provider: SearchProvider): string {
  if (provider === "builtin") return "";
  const own = settings.searchKeys ? settings.searchKeys[provider] || "" : settings.webSearchKey;
  return own || (provider === "deepseek" && settings.apiKey && isDeepSeekApi(settings.baseUrl || "") ? settings.apiKey : "");
}
export const isDeepSeekApi = (baseUrl: string): boolean => {
  try { const host = new URL(baseUrl).host.toLowerCase(); return host === "api.deepseek.com" || host.endsWith(".deepseek.com"); } catch { return false; }
};

/** The user picks one of two API types; an OpenAI-compatible connection to
 * api.openai.com uses OpenAI's own Responses protocol (and its built-in search). */
export type ApiType = "openai" | "anthropic";
export const apiTypeOf = (provider: DirectProvider): ApiType => provider === "anthropic" ? "anthropic" : "openai";
export function providerFor(type: ApiType, baseUrl: string): DirectProvider {
  if (type === "anthropic") return "anthropic";
  try { return new URL(baseUrl.trim()).hostname.toLowerCase() === "api.openai.com" ? "openai" : "openai-compatible"; }
  catch { return "openai-compatible"; }
}
const LEGACY_KEY = "pia.direct.openai.key.v1";
const CREDENTIAL_PREFIX = "pia.direct.credentials.v2.";
const SEARCH_KEY_PREFIX = "pia.direct.web-search.v1.";
const PREF_PREFIX = "pia.direct.prefs.v1.";
export const DEFAULT_DIRECT_MODEL = "gpt-4.1-mini";
export const defaultDirectPreferences: DirectAgentPreferences = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: DEFAULT_DIRECT_MODEL,
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
/** Local OpenAI-compatible servers often require no bearer token (Ollama, LM Studio). */
export function anonymousLocalAllowed(settings: Pick<DirectAgentPreferences, "provider" | "baseUrl">): boolean {
  if (settings.provider !== "openai-compatible") return false;
  try { return validateBaseUrl(settings.baseUrl, settings.provider).startsWith("http://"); }
  catch { return false; }
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

async function loadLegacySettings(profile: string): Promise<DirectAgentSettings> {
  const [raw, credentialRaw, webSearchKey] = await Promise.all([
    SecureStore.getItemAsync(preferenceKey(profile)),
    SecureStore.getItemAsync(credentialKey(profile)),
    SecureStore.getItemAsync(searchKey(profile)),
  ]);
  let saved: Partial<DirectAgentPreferences> = {};
  try { saved = raw ? JSON.parse(raw) as Partial<DirectAgentPreferences> : {}; }
  catch { /* Never grant web-search permission when preferences are corrupt. */ }
  const provider = validateProvider(saved.provider ?? "openai");
  const baseUrl = validateBaseUrl(saved.baseUrl ?? defaultBaseUrl(provider), provider);
  const preferences = {
    provider, baseUrl,
    model: typeof saved.model === "string" ? validateModel(saved.model) : DEFAULT_DIRECT_MODEL,
    allowWeb: saved.allowWeb === true,
  };
  let apiKey = "";
  try {
    const credential = credentialRaw ? JSON.parse(credentialRaw) as { identity?: string; apiKey?: string } : {};
    if (credential.identity === identityOf(preferences) && typeof credential.apiKey === "string") {
      apiKey = credential.apiKey;
    }
  } catch { /* old/invalid credentials never get sent to another endpoint */ }
  if (!credentialRaw && provider === "openai" && baseUrl === defaultBaseUrl("openai") && profile === await savedMemoryProfile()) {
    apiKey = (await SecureStore.getItemAsync(LEGACY_KEY)) || "";
    if (apiKey) {
      // Claim the old unscoped key for the current profile exactly once. A later
      // account switch must not inherit it; interrupted cleanup is harmless.
      await saveDirectApiKey(profile, apiKey, preferences);
      await SecureStore.deleteItemAsync(LEGACY_KEY);
    }
  }
  return { ...preferences, apiKey, webSearchKey: webSearchKey || "" };
}
export async function saveDirectPreferences(profile: string, prefs: DirectAgentPreferences): Promise<void> {
  const provider = validateProvider(prefs.provider);
  await SecureStore.setItemAsync(preferenceKey(profile), JSON.stringify({
    provider, baseUrl: validateBaseUrl(prefs.baseUrl, provider),
    model: validateModel(prefs.model),
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

export type DirectConnection = DirectAgentSettings & { id: string; name: string };
export type DirectConnections = { activeId: string; connections: DirectConnection[] };
const CONNECTIONS_PREFIX = "pia.direct.connections.v3.";
const manifestKey = (profile: string) => CONNECTIONS_PREFIX + keyForProfile(profile);
const connectionKey = (profile: string, generation: string, id: string) =>
  manifestKey(profile) + "." + generation + "." + id;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

export function newDirectConnection(provider: DirectProvider, id = Crypto.randomUUID()): DirectConnection {
  return {
    ...defaultDirectPreferences, id, name: provider === "anthropic" ? "Anthropic" :
      provider === "openai-compatible" ? "Совместимая модель" : "OpenAI",
    provider, baseUrl: defaultBaseUrl(provider),
    model: provider === "anthropic" ? "claude-sonnet-4-5" : DEFAULT_DIRECT_MODEL,
    apiKey: "", webSearchKey: "", searchProvider: "tavily",
  };
}

export async function loadDirectConnections(profile: string): Promise<DirectConnections> {
  const raw = await SecureStore.getItemAsync(manifestKey(profile));
  if (!raw) {
    const legacy = await loadLegacySettings(profile);
    const connections = (["openai", "openai-compatible", "anthropic"] as const)
      .map(provider => newDirectConnection(provider, "default-" + provider));
    const active = connections.find(c => c.provider === legacy.provider)!;
    // The only legacy search key was a Brave key; it is not reused for Tavily.
    Object.assign(active, legacy, { searchProvider: "tavily", webSearchKey: "" });
    return { activeId: active.id, connections };
  }
  try {
    const index = JSON.parse(raw) as { activeId: string; ids: string[]; generation: string };
    if (!validId(index.generation) || !Array.isArray(index.ids) || index.ids.length < 1 || index.ids.length > 20 ||
        index.ids.some(id => !validId(id)) || new Set(index.ids).size !== index.ids.length ||
        !index.ids.includes(index.activeId)) throw new Error("invalid_connections");
    const connections: DirectConnection[] = [];
    for (const id of index.ids) {
      const stored = await SecureStore.getItemAsync(connectionKey(profile, index.generation, id));
      if (!stored) throw new Error("connection_missing");
      const item = JSON.parse(stored) as DirectConnection & { credentialIdentity?: string };
      const [savedApiKey, savedSearch] = await Promise.all([
        SecureStore.getItemAsync(connectionKey(profile, index.generation, id) + ".api"),
        SecureStore.getItemAsync(connectionKey(profile, index.generation, id) + ".search"),
      ]);
      const provider = validateProvider(item.provider);
      const baseUrl = validateBaseUrl(item.baseUrl, provider);
      const search = migrateSearchProvider(item.searchProvider);
      connections.push({
        id, name: String(item.name || "Модель").slice(0, 60), provider, baseUrl,
        model: validateModel(item.model), transcriptionModel: validateModel(item.transcriptionModel || "whisper-1"), allowWeb: item.allowWeb === true,
        searchProvider: search.provider, searchFolderId: validFolder(item.searchFolderId),
        apiKey: item.credentialIdentity === identityOf({ provider, baseUrl }) ? savedApiKey || "" : "",
        ...(() => {
          const searchKeys = search.dropKey ? {} : parseSearchKeys(savedSearch, search.provider);
          return { searchKeys, webSearchKey: searchKeyOf({ searchKeys, webSearchKey: "" }, search.provider) };
        })(),
      });
    }
    // Placeholders the app created by itself (never given a key, not active, default
    // address) are hidden; the next save removes them.
    const useful = connections.filter(c => !(c.id.startsWith("default-") && !c.apiKey && c.id !== index.activeId && c.baseUrl === defaultBaseUrl(c.provider)));
    return { activeId: index.activeId, connections: useful };
  } catch {
    // Do not silently fall back to another credential/endpoint after corruption.
    throw new Error("Не удалось прочитать подключения. Повторите открытие настроек.");
  }
}

export async function saveDirectConnections(profile: string, value: DirectConnections): Promise<void> {
  if (value.connections.length < 1 || value.connections.length > 20 ||
      new Set(value.connections.map(c => c.id)).size !== value.connections.length ||
      !value.connections.some(c => c.id === value.activeId)) throw new Error("Выберите активное подключение");
  // Validate ALL drafts before touching storage. Stage a new generation, then
  // publish its manifest atomically so an interrupted save preserves the old set.
  const validated = value.connections.map(item => {
    if (!validId(item.id) || !item.name.trim()) throw new Error("Введите название подключения");
    if (!item.baseUrl.trim()) throw new Error("Укажите адрес API в подключении «" + item.name.trim() + "»");
    if (!item.model.trim()) throw new Error("Укажите модель в подключении «" + item.name.trim() + "»");
    if (/[<>]/.test(item.model)) throw new Error("В названии модели «" + item.name.trim() + "» замените часть в угловых скобках на свои данные");
    const provider = validateProvider(item.provider);
    const baseUrl = validateBaseUrl(item.baseUrl, provider);
    const searchProvider = item.searchProvider || "tavily";
    if (!SEARCH_PROVIDERS.includes(searchProvider)) throw new Error("Выберите способ поиска");
    // Older callers pass only webSearchKey: it belongs to the selected service.
    const rawKeys: SearchKeys = item.searchKeys ? { ...item.searchKeys } :
      searchProvider !== "builtin" && item.webSearchKey ? { [searchProvider]: item.webSearchKey } : {};
    const searchKeys: SearchKeys = {};
    for (const id of ["tavily", "yandex", "deepseek"] as const) if (rawKeys[id]?.trim()) searchKeys[id] = validateSecret(rawKeys[id]!);
    const activeSearchKey = searchKeyOf({ searchKeys, webSearchKey: "", apiKey: item.apiKey, baseUrl: item.baseUrl }, searchProvider);
    if (item.allowWeb && searchProvider === "deepseek" && !activeSearchKey) throw new Error("Введите ключ DeepSeek для поиска или выберите подключение DeepSeek");
    if (item.allowWeb && searchProvider === "tavily" && !activeSearchKey) throw new Error("Введите ключ Tavily");
    if (item.allowWeb && searchProvider === "yandex" && !activeSearchKey) throw new Error("Введите API-ключ Yandex Cloud для поиска");
    const searchFolderId = (item.searchFolderId || "").trim();
    if (searchFolderId && !validFolder(searchFolderId)) throw new Error("Идентификатор каталога Yandex Cloud — латинские буквы и цифры, например b1g…");
    if (item.allowWeb && searchProvider === "yandex" && !searchFolderId) throw new Error("Введите идентификатор каталога Yandex Cloud (folder ID)");
    if (item.allowWeb && searchProvider === "builtin" && provider !== "openai") throw new Error("Встроенный поиск доступен через OpenAI Responses");
    const { allowMemory: _legacyMemoryFlag, ...current } = item as DirectConnection & { allowMemory?: boolean };
    return { ...current, name: item.name.trim().slice(0, 60), provider, baseUrl,
      model: validateModel(item.model), transcriptionModel: validateModel(item.transcriptionModel || "whisper-1"), searchProvider, searchFolderId,
      apiKey: item.apiKey.trim() ? validateSecret(item.apiKey) : "",
      webSearchKey: "", searchKeys, searchSecret: JSON.stringify(searchKeys),
      credentialIdentity: identityOf({ provider, baseUrl }),
    };
  });
  const previous = await SecureStore.getItemAsync(manifestKey(profile));
  const generation = Crypto.randomUUID();
  const staged: string[] = [];
  let published = false;
  try {
    for (const connection of validated) {
      const key = connectionKey(profile, generation, connection.id);
      const { apiKey, webSearchKey: _active, searchKeys: _keys, searchSecret, ...metadata } = connection;
      for (const [storageKey, contents] of [[key, JSON.stringify(metadata)], [key + ".api", apiKey], [key + ".search", searchSecret]]) {
        staged.push(storageKey);
        await SecureStore.setItemAsync(storageKey, contents, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      }
    }
    await SecureStore.setItemAsync(manifestKey(profile), JSON.stringify({
      generation, activeId: value.activeId, ids: validated.map(c => c.id),
    }), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    published = true;
  } finally {
    if (!published) for (const key of staged) {
      try { await SecureStore.deleteItemAsync(key); } catch { /* no active reference */ }
    }
  }
  // Cleanup must not turn a successful save into a reported failure.
  if (previous) try {
    const old = JSON.parse(previous) as { generation: string; ids: string[] };
    if (validId(old.generation) && Array.isArray(old.ids)) for (const id of old.ids.filter(validId)) {
      for (const suffix of ["", ".api", ".search"]) try { await SecureStore.deleteItemAsync(connectionKey(profile, old.generation, id) + suffix); } catch { /* no active reference */ }
    }
  } catch { /* a corrupt old manifest cannot be trusted for deletion */ }
}

export async function loadDirectSettings(profile: string): Promise<DirectAgentSettings> {
  const value = await loadDirectConnections(profile);
  const active = value.connections.find(c => c.id === value.activeId);
  if (!active) throw new Error("Выберите подключение в настройках");
  return active;
}

export type ProviderPreset = {
  id: string; name: string; provider: DirectProvider; baseUrl: string; model: string;
  /** Shown under the form: where to get a key and what to replace. */
  hint: string;
};
/** Ready-made connections. Users still paste their own key; model names can be edited. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "yandex", name: "YandexGPT", provider: "openai-compatible", baseUrl: "https://ai.api.cloud.yandex.net/v1",
    model: "gpt://<ID-каталога>/yandexgpt/latest",
    hint: "Ключ API и ID каталога — в Yandex AI Studio. Замените <ID-каталога> в названии модели на свой." },
  { id: "deepseek", name: "DeepSeek", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    hint: "Ключ — в личном кабинете platform.deepseek.com." },
  { id: "openrouter", name: "OpenRouter", provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini",
    hint: "Один ключ openrouter.ai даёт доступ к моделям разных компаний; название модели — как в каталоге OpenRouter." },
  { id: "local", name: "Локальная модель (Ollama, LM Studio)", provider: "openai-compatible", baseUrl: "http://192.168.1.10:11434/v1", model: "qwen2.5:7b",
    hint: "Укажите адрес компьютера в вашей сети. Ключ не нужен; модель работает на компьютере, а не на телефоне." },
  { id: "openai", name: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", model: DEFAULT_DIRECT_MODEL,
    hint: "Ключ — на platform.openai.com. Из России сервис может быть недоступен." },
  { id: "anthropic", name: "Anthropic (Claude)", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5",
    hint: "Ключ — в console.anthropic.com. Из России сервис может быть недоступен." },
];
export function connectionFromPreset(preset: ProviderPreset, id = Crypto.randomUUID()): DirectConnection {
  return { ...newDirectConnection(preset.provider, id), name: preset.name, baseUrl: preset.baseUrl, model: preset.model };
}
/** A placeholder left in a preset model name, e.g. "<ID-каталога>". */
export const hasModelPlaceholder = (model: string) => /[<>]/.test(model);
