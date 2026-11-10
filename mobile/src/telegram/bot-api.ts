import {validateBotToken,validatePrivateChatId} from "./bot-settings";

/** Explicit client-only Bot API adapter. No webhook, relay, cookies or arbitrary URLs. */
const HOST = "https://api.telegram.org/bot";
export type BotIdentity = {id:number;username:string};
export type BotPairCandidate = {chatId:string;label:string};
export type BotMessage = {
  message_id: number;
  chat: {id: number;type: string};
  from?: {id?: number;is_bot?: boolean;first_name?: string;username?: string};
  text?: string;
  caption?: string;
  photo?: unknown;
  document?: unknown;
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  animation?: unknown;
  video_note?: unknown;
  media_group_id?: string;
};
export type BotUpdate = {update_id:number;message?:BotMessage;edited_message?:BotMessage};

async function api(token: string, method: "getMe" | "getWebhookInfo" | "getUpdates",
  args: Record<string,unknown> = {}, signal?:AbortSignal): Promise<unknown> {
  const secret = validateBotToken(token);
  let response:Response;
  try {
    response = await fetch(HOST+secret+"/"+method,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(args),signal,
    });
  } catch {
    throw new Error("Telegram недоступен. Проверьте интернет и повторите.");
  }
  // Avoid parsing unbounded/HTML responses or including URLs/tokens in errors.
  if (!response.ok) throw new Error("Telegram отклонил запрос. Проверьте токен и доступность бота.");
  let raw:string;
  try {raw=await response.text();}catch{throw new Error("Не удалось прочитать ответ Telegram.");}
  if (!raw || raw.length > 256_000) throw new Error("Слишком большой ответ Telegram.");
  let body:unknown;
  try {body=JSON.parse(raw);}catch{throw new Error("Telegram вернул некорректные данные.");}
  if (!body || typeof body!=="object" || !(body as {ok?:boolean}).ok ||
      !("result" in body))
    throw new Error("Telegram отказал в операции. Проверьте настройки бота.");
  return (body as {result:unknown}).result;
}

export async function verifyTelegramBot(token:string,signal?:AbortSignal):Promise<BotIdentity> {
  const result=await api(token,"getMe",{},signal);
  if (!result || typeof result!=="object") throw new Error("Не удалось проверить Telegram-бота.");
  const v=result as {id?:unknown;username?:unknown;is_bot?:unknown};
  if (!Number.isSafeInteger(v.id) || Number(v.id)<=0 || v.is_bot!==true ||
      typeof v.username!=="string" || !/^[a-zA-Z0-9_]{5,32}$/.test(v.username))
    throw new Error("Ответ Telegram не подтверждает бота.");
  return {id:v.id as number,username:v.username};
}
async function assertNoWebhook(token:string,signal?:AbortSignal):Promise<void> {
  const result=await api(token,"getWebhookInfo",{},signal);
  if (!result || typeof result!=="object" ||
      typeof (result as {url?:unknown}).url !== "string")
    throw new Error("Не удалось проверить способ доставки бота.");
  if ((result as {url:string}).url)
    throw new Error("У бота уже настроен webhook. Используйте отдельного бота для PersAI.");
}

async function updates(token:string,offset:number|null,signal?:AbortSignal):Promise<BotUpdate[]> {
  await assertNoWebhook(token,signal);
  const result=await api(token,"getUpdates",{
    ...(offset!==null?{offset}:{}),limit:100,timeout:0,
    allowed_updates:["message","edited_message"],
  },signal);
  if (!Array.isArray(result) || result.length>100)
    throw new Error("Telegram вернул некорректную очередь.");
  for(const item of result) {
    if (!item || typeof item!=="object" ||
        !Number.isSafeInteger((item as BotUpdate).update_id) ||
        (item as BotUpdate).update_id<0)
      throw new Error("Некорректный идентификатор сообщения Telegram.");
  }
  return result as BotUpdate[];
}
/** Read candidates without offset: Telegram does NOT ACK queue in pairing preview. */
export async function listBotPairCandidates(token:string,signal?:AbortSignal):Promise<BotPairCandidate[]> {
  const result=await updates(token,null,signal);
  const found=new Map<string,string>();
  for(const item of result){
    const msg=item.message;
    if(!msg || msg.chat?.type!=="private" || msg.from?.is_bot===true)continue;
    let chatId:string;
    try{chatId=validatePrivateChatId(String(msg.chat.id));}catch{continue;}
    const raw=[msg.from?.first_name,msg.from?.username?"@"+msg.from.username:""].filter(Boolean).join(" · ");
    // Display only short Telegram account label; never show the incoming message text.
    if(!found.has(chatId))found.set(chatId,raw.slice(0,100)||"Личный чат");
  }
  return [...found].slice(0,10).map(([chatId,label])=>({chatId,label}));
}
/** offset is LAST fully persisted update + 1. No ACK for incomplete local writes. */
export async function fetchBotUpdates(token:string,cursor:number,signal?:AbortSignal):Promise<BotUpdate[]> {
  if(!Number.isSafeInteger(cursor)||cursor<0)throw new Error("invalid_telegram_bot_cursor");
  return updates(token,cursor?cursor+1:null,signal);
}
