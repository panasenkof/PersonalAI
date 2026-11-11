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

/** The React Native fetch implementation is not guaranteed to honor AbortSignal.
 * Race the whole request (including response.text) against a deadline. Never
 * expose a bot token or the token-bearing URL in an error. */
export const TELEGRAM_BOT_REQUEST_TIMEOUT_MS = 15_000;
async function boundedTelegramRequest<T>(operation:(signal:AbortSignal)=>Promise<T>,
  external?:AbortSignal):Promise<T> {
  if(external?.aborted)throw new Error("Запрос Telegram отменён.");
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let onExternal:(()=>void)|undefined;
  const interrupted=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{
      controller.abort();
      reject(new Error("Telegram не ответил за 15 секунд. Проверьте сеть/VPN и повторите."));
    },TELEGRAM_BOT_REQUEST_TIMEOUT_MS);
    if(external){
      onExternal=()=>{
        controller.abort();
        reject(new Error("Запрос Telegram отменён."));
      };
      external.addEventListener("abort",onExternal,{once:true});
      if(external.aborted)onExternal();
    }
  });
  try{return await Promise.race([operation(controller.signal),interrupted]);}
  finally{
    if(timer!==undefined)clearTimeout(timer);
    if(external&&onExternal)external.removeEventListener("abort",onExternal);
  }
}

async function api(token: string, method: "getMe" | "getWebhookInfo" | "getUpdates" | "getFile",
  args: Record<string,unknown> = {}, signal?:AbortSignal): Promise<unknown> {
  const secret = validateBotToken(token);
  const raw=await boundedTelegramRequest(async requestSignal=>{
    let response:Response;
    try {
      response=await fetch(HOST+secret+"/"+method,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(args),signal:requestSignal,
      });
    } catch {
      if(requestSignal.aborted)throw new Error("Запрос Telegram прерван.");
      throw new Error("Telegram недоступен. Проверьте интернет/VPN и повторите.");
    }
    if (!response.ok) {
      if(response.status===429)throw new Error("Telegram ограничил частоту запросов. Повторите позже.");
      if(response.status===401||response.status===404)
        throw new Error("Telegram отклонил токен бота. Проверьте токен.");
      throw new Error("Telegram отклонил запрос. Проверьте доступность сервиса.");
    }
    try{return await response.text();}
    catch{throw new Error("Не удалось прочитать ответ Telegram.");}
  },signal);
  if (!raw || raw.length > 2_000_000) throw new Error("Слишком большой ответ Telegram.");
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

/** Telegram's hosted Bot API currently caps getFile downloads at 20 MB.
 * Never treat a user-supplied caption, URL, or file path as an origin.
 */
export const TELEGRAM_BOT_MAX_FILE_BYTES = 20_000_000;
export type TelegramBotFile = {path:string;size:number|null};
export async function getTelegramBotFile(token:string,fileId:string,signal?:AbortSignal):Promise<TelegramBotFile>{
  if(typeof fileId!=="string"||fileId.length<8||fileId.length>512||
    !/^[A-Za-z0-9_-]+$/.test(fileId))
    throw new Error("Некорректный идентификатор Telegram-файла.");
  const data=await api(token,"getFile",{file_id:fileId},signal);
  if(!data||typeof data!=="object")throw new Error("Telegram не вернул сведения о файле.");
  const file=data as {file_path?:unknown;file_size?:unknown};
  // Must stay beneath the official Telegram file URL, never become a
  // caller-controlled host/path, traversal, query string or fragment.
  if(typeof file.file_path!=="string"||file.file_path.length>400||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.file_path)||
    file.file_path.split("/").some(part=>part==="."||part===".."||part.startsWith(".")))
    throw new Error("Telegram вернул небезопасный путь файла.");
  const size=file.file_size===undefined?null:file.file_size;
  if(size!==null && (!Number.isSafeInteger(size)||Number(size)<=0))
    throw new Error("Telegram вернул некорректный размер файла.");
  if(size!==null && Number(size)>TELEGRAM_BOT_MAX_FILE_BYTES)
    throw new Error("Файл превышает доступный для ботов Telegram лимит 20 МБ.");
  return {path:file.file_path,size:size as number|null};
}
