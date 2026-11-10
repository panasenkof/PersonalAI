import * as SecureStore from "expo-secure-store";

/** Reserve channel credentials: never shared with TDLib or LLM. */
export type TelegramBotConfig = {
  token: string;
  botId: number;
  username: string;
  allowedChatId: string | null;
  cursor: number;
};
const key = (p: string) => {
  if (!/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(p)) throw new Error("invalid_local_profile");
  return "pia.telegram.bot.v1." + p;
};
const secretOptions = {keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY};
export function validateBotToken(token: string): string {
  const clean = token.trim();
  if (!/^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,100}$/.test(clean))
    throw new Error("Некорректный токен Telegram-бота.");
  return clean;
}
function checkedBotId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid_telegram_bot_identity");
  return id;
}
export function validatePrivateChatId(value: string): string {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("invalid_telegram_private_chat_id");
  return value;
}
function checkedConfig(value: unknown): TelegramBotConfig | null {
  if (!value || typeof value !== "object") return null;
  try {
    const v = value as Partial<TelegramBotConfig>;
    const token = validateBotToken(String(v.token || ""));
    const botId = checkedBotId(Number(v.botId));
    if (typeof v.username !== "string" || !/^[a-zA-Z0-9_]{5,32}$/.test(v.username))
      return null;
    if (v.allowedChatId !== null && v.allowedChatId !== undefined)
      validatePrivateChatId(v.allowedChatId);
    if (!Number.isSafeInteger(v.cursor) || (v.cursor ?? -1) < 0) return null;
    return {token,botId,username:v.username,allowedChatId:v.allowedChatId || null,cursor:v.cursor!};
  } catch { return null; }
}
export async function loadTelegramBotConfig(profile: string): Promise<TelegramBotConfig | null> {
  const raw = await SecureStore.getItemAsync(key(profile));
  if (!raw) return null;
  try { return checkedConfig(JSON.parse(raw)); } catch { return null; }
}
export async function inspectTelegramBot(profile: string): Promise<{
  configured: boolean; username: string | null; paired: boolean; cursor: number;
}> {
  const c = await loadTelegramBotConfig(profile);
  return {configured:!!c,username:c?.username||null,paired:!!c?.allowedChatId,cursor:c?.cursor||0};
}
/** Only after getMe returned a verified Telegram bot identity. Always unpair on token rotation. */
export async function saveVerifiedBot(profile: string, token: string, identity: {id:number; username:string}): Promise<void> {
  const parsed: TelegramBotConfig = {
    token:validateBotToken(token),botId:checkedBotId(identity.id),
    username:identity.username,allowedChatId:null,cursor:0,
  };
  if (!checkedConfig(parsed)) throw new Error("invalid_telegram_bot_identity");
  await SecureStore.setItemAsync(key(profile),JSON.stringify(parsed),secretOptions);
}
export async function pairTelegramBot(profile: string, botId: number, chatId: string): Promise<void> {
  const c = await loadTelegramBotConfig(profile);
  if (!c || c.botId !== botId) throw new Error("telegram_bot_changed");
  await SecureStore.setItemAsync(key(profile),JSON.stringify({
    ...c,allowedChatId:validatePrivateChatId(chatId),cursor:0,
  }),secretOptions);
}
/** No cursor advance on failed save. Reject a stale run after token/pairing changed. */
export async function advanceTelegramBotCursor(profile: string, botId: number, chatId: string,
  cursor: number): Promise<void> {
  const c = await loadTelegramBotConfig(profile);
  if (!c || c.botId !== botId || c.allowedChatId !== chatId)
    throw new Error("telegram_bot_changed");
  if (!Number.isSafeInteger(cursor) || cursor <= c.cursor) throw new Error("telegram_bot_cursor_regression");
  await SecureStore.setItemAsync(key(profile),JSON.stringify({...c,cursor}),secretOptions);
}
export async function clearTelegramBot(profile:string):Promise<void> {
  await SecureStore.deleteItemAsync(key(profile));
}
