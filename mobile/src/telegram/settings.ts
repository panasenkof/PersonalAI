import * as SecureStore from "expo-secure-store";

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
