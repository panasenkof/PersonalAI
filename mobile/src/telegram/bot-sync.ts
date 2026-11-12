import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../local-memory/storage";
import {saveMediaNote,MAX_TOTAL_ORIGINAL_BYTES} from "../media/attachments";
import {scheduleVectors} from "../media/vector-runner";
import {fetchBotUpdates, type BotMessage} from "./bot-api";
import {prepareBotOriginal, type PreparedBotOriginal} from "./bot-media";
import {planBotAlbum} from "./bot-albums";
import {advanceTelegramBotCursor, loadTelegramBotConfig} from "./bot-settings";
import {requireTelegramTarget,type TelegramImportTarget} from "./import-target";
import {telegramBotLinks,telegramLinkedText} from "./links";

export type TelegramBotSyncResult = {
  imported:number;skipped:number;duplicates:number;lastUpdate:number;pendingAlbum?:number;
};
export class TelegramBotBlocked extends Error {
  constructor(public readonly reason:"unsupported"|"edited",public readonly updateId:number){
    super(reason==="edited"
      ?"В очереди бота есть отредактированное сообщение. Изменения не переносятся в заметку."
      :"В очереди бота есть сообщение, которое PersAI не умеет сохранять (опрос, история и т. п.).");
    this.name="TelegramBotBlocked";
  }
}
function blockedReason(message:BotMessage|undefined,edited:BotMessage|undefined,
  chatId:string):"unsupported"|"edited"|null{
  const fromAllowed=(m:BotMessage|undefined)=>
    m?.chat?.type==="private"&&String(m.chat.id)===chatId;
  if(fromAllowed(edited))return "edited";
  if(fromAllowed(message)&&(message?.sticker||message?.contact||message?.location||
    message?.venue||message?.poll||message?.dice||message?.story||message?.paid_media))
    return "unsupported";
  return null;
}
const running = new Map<string,Promise<TelegramBotSyncResult>>();

function mustBeUnlocked(signal?:AbortSignal) {
  if (signal?.aborted || !localMemorySessionUnlocked())
    throw new Error("Разблокируйте PersAI для синхронизации Telegram.");
}
function hasMedia(message:BotMessage):boolean {
  return Boolean(message.photo || message.document || message.video || message.audio ||
    message.voice || message.animation || message.video_note || message.media_group_id);
}
function textOf(message:BotMessage):string {
  return typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
}
function linkedMessage(message:BotMessage){
  const text=textOf(message);
  const entities=typeof message.text==="string"?message.entities:message.caption_entities;
  return telegramLinkedText(text,telegramBotLinks(text,entities));
}
async function perform(profile:string,signal?:AbortSignal,target?:TelegramImportTarget):Promise<TelegramBotSyncResult> {
  mustBeUnlocked(signal);
  const config=await loadTelegramBotConfig(profile);
  if(!config || !config.allowedChatId)throw new Error("Сначала подключите личного бота и подтвердите свой чат.");
  const updates=await fetchBotUpdates(config.token,config.cursor,signal);
  mustBeUnlocked(signal);
  let last=config.cursor,imported=0,skipped=0,duplicates=0;
  let pendingAlbum=0;
  for(let index=0;index<updates.length;) {
    const item=updates[index];
    mustBeUnlocked(signal);
    if(item.update_id<=last){index++;continue;}
    const message=item.message;
    const edited=item.edited_message;
    const fromAllowed = (m:BotMessage|undefined) =>
      m?.chat?.type==="private" && String(m.chat.id)===config.allowedChatId;
    if(message&&fromAllowed(message)&&message.media_group_id){
      const plan=planBotAlbum(updates,index,config.allowedChatId);
      if(plan.state==="pending"){
        pendingAlbum=plan.received;
        break; // no ACK; later updates (or user's /done) establish a boundary
      }
      const staged:PreparedBotOriginal[]=[];
      let stagedBytes=0;
      try{
        for(const part of plan.messages){
          mustBeUnlocked(signal);
          const original=await prepareBotOriginal(config.token,part,signal,true);
          if(!original)throw new Error("В Telegram-альбоме нет оригинала. Импорт остановлен.");
          staged.push(original);
          stagedBytes+=original.file.size||0;
          if(stagedBytes>MAX_TOTAL_ORIGINAL_BYTES)
            throw new Error("Альбом Telegram превышает лимит 80 МБ. Исходные сообщения не подтверждены.");
        }
        mustBeUnlocked(signal);
        const ids=plan.messages.map(part=>part.message_id);
        const captions=plan.messages.map((part,partIndex)=>{
          const caption=linkedMessage(part).body;
          return caption?{position:partIndex+1,caption}:null;
        }).filter((v):v is {position:number;caption:string}=>v!==null);
        const rawBody=captions.length<2?captions[0]?.caption||"":
          captions.map(v=>"Файл "+v.position+": "+v.caption).join("\n\n");
        const groupUrls=[...new Set(plan.messages.flatMap(part=>{
          const text=textOf(part);
          return telegramBotLinks(text,typeof part.text==="string"?part.entities:part.caption_entities);
        }))];
        const linked=telegramLinkedText(rawBody,groupUrls);
        const body=linked.body;
        if(body.length>60_000)throw new Error("Подписи альбома Telegram превышают 60 000 символов.");
        const title=body.split(/\r?\n/)[0].slice(0,160)||
          "Альбом Telegram ("+staged.length+" файлов)";
        let replayed=false;
        const targetFields=await requireTelegramTarget(profile,target);
        await saveMediaNote(profile,{
          title,body,...targetFields,
          ...(linked.sourceUrl?{sourceUrl:linked.sourceUrl,sourceCoverage:"url_only" as const}:{}),
          files:staged.map(v=>v.file),
          receipt:"telegram-bot:"+config.botId+":"+config.allowedChatId+":"+
            ids[0]+":album:"+plan.groupId+":"+ids.join(","),
          botMessage:{botId:config.botId,chatId:config.allowedChatId!,
            messageId:ids[0],mediaGroupId:plan.groupId,messageIds:ids},
          onReplay:()=>{replayed=true;},
        },signal);
        if(replayed)duplicates++;else imported++;
      }finally{for(const original of staged)original.remove();}
      mustBeUnlocked(signal);
      // One cursor commit AFTER all originals and the canonical receipt
      // have been committed. Never ACK just the first album photo.
      await advanceTelegramBotCursor(profile,config.botId,config.allowedChatId,plan.lastUpdateId);
      last=plan.lastUpdateId;
      skipped+=plan.nextIndex-index-plan.messages.length; // other chats only
      index=plan.nextIndex;
      continue;
    }
    const reason=blockedReason(message,edited,config.allowedChatId);
    if(reason)throw new TelegramBotBlocked(reason,item.update_id);
    if(message && fromAllowed(message)) {
      if(!Number.isSafeInteger(message.message_id)||message.message_id<=0)
        throw new Error("Telegram вернул сообщение без корректного ID.");
      // Do not acknowledge a Telegram object that has no lossless writer yet.
      // Unsupported objects are handled as a deliberate blocked update above.
      const linked=linkedMessage(message);
      const body=linked.body;
      if(body.length>60_000)throw new Error("Сообщение Telegram длиннее 60 000 символов. Импорт остановлен.");
      const isCommand=/^\/(?:start|help|done)(?:\s|$)/i.test(body)&&!hasMedia(message);
      const staged=!isCommand&&hasMedia(message)
        ? await prepareBotOriginal(config.token,message,signal):null;
      try{
        mustBeUnlocked(signal);
        if((body||staged)&&!isCommand){
          const title=body.split(/\r?\n/)[0].trim().slice(0,160)||
            staged?.file.name||"Сообщение Telegram";
          let replayed=false;
          const targetFields=await requireTelegramTarget(profile,target);
          await saveMediaNote(profile,{
            title,body,...targetFields,
            ...(staged?{file:staged.file}:{}),
            ...(linked.sourceUrl?{sourceUrl:linked.sourceUrl,sourceCoverage:"url_only" as const}:{}),
            receipt:"telegram-bot:"+config.botId+":"+config.allowedChatId+":"+message.message_id,
            onReplay:()=>{replayed=true;},
            botMessage:{botId:config.botId,chatId:config.allowedChatId!,messageId:message.message_id},
          },signal);
          if(replayed)duplicates++;else imported++;
        }else skipped++;
      }finally{staged?.remove();}
    } else {
      // Other users' chat events must never become notes in the owner's memory.
      skipped++;
    }
    mustBeUnlocked(signal);
    // Telegram ACK happens on the NEXT getUpdates with offset=last+1.
    // Local cursor is committed only after canonical note commit/replay succeeds.
    await advanceTelegramBotCursor(profile,config.botId,config.allowedChatId,item.update_id);
    last=item.update_id;
    index++;
  }
  if(imported) scheduleVectors(profile);
  return pendingAlbum?{imported,skipped,duplicates,lastUpdate:last,pendingAlbum}:
    {imported,skipped,duplicates,lastUpdate:last};
}
/** Serializes per-profile manual/auto starts; no parallel cursor or writes. */
export function syncTelegramBotText(profile:string,signal?:AbortSignal,target?:TelegramImportTarget):Promise<TelegramBotSyncResult> {
  const pending=running.get(profile);
  if(pending)return pending;
  // A lock transition cancels in-flight Bot API requests and native media
  // downloads, not just the following SQLCipher write.
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.addEventListener("abort",abort,{once:true});
  const unsubscribe=onLocalMemorySessionChange(unlocked=>{
    if(!unlocked)controller.abort();
  });
  if(signal?.aborted||!localMemorySessionUnlocked())controller.abort();
  const next=perform(profile,controller.signal,target);
  running.set(profile,next);
  void next.finally(()=>{
    unsubscribe();
    signal?.removeEventListener("abort",abort);
    if(running.get(profile)===next)running.delete(profile);
  }).catch(()=>{});
  return next;
}


/** Explicit user consent only. Re-read the live queue and confirm the blocker
 * is still the first unprocessed event from the paired private chat. */
export async function skipBlockedBotUpdate(profile:string,updateId:number,
  signal?:AbortSignal):Promise<void>{
  mustBeUnlocked(signal);
  if(!Number.isSafeInteger(updateId)||updateId<=0)throw new Error("telegram_bot_queue_changed");
  if(running.has(profile))throw new Error("telegram_bot_import_running");
  const config=await loadTelegramBotConfig(profile);
  if(!config?.allowedChatId)throw new Error("telegram_bot_queue_changed");
  const events=await fetchBotUpdates(config.token,config.cursor,signal);
  mustBeUnlocked(signal);
  const allowed=(m:BotMessage|undefined)=>
    m?.chat?.type==="private"&&String(m.chat.id)===config.allowedChatId;
  const first=events.find(x=>x.update_id>config.cursor&&
    (allowed(x.message)||allowed(x.edited_message)));
  if(!first||first.update_id!==updateId||
    !blockedReason(first.message,first.edited_message,config.allowedChatId))
    throw new Error("telegram_bot_queue_changed");
  await advanceTelegramBotCursor(profile,config.botId,config.allowedChatId,updateId);
}
